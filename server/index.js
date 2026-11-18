#!/usr/bin/env node
// connect-pi bridge
//
//   phone (PWA)  <--websocket-->  THIS SERVER  <--websocket-->  pi extension
//                                      |                        (inside pi)
//                                      +-- starts pi sessions for you
//
// The server authenticates the phone, keeps a short replay buffer per pi
// session so a reconnecting phone sees history, relays messages both ways, and
// can launch new pi sessions in folders you allow.

import { randomUUID } from "node:crypto";
import { watchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
	authState,
	loginWithPasscode,
	passkeyLoginOptions,
	passkeyLoginVerify,
	passkeyRegisterOptions,
	passkeyRegisterVerify,
} from "./auth.js";
import { CONFIG_PATH, ensureConfig, hasPasscode, loadConfig, setPasscode, verifyToken } from "./config.js";
import { createFolder, listFolders, listRoots, resolveInsideRoots } from "./files.js";
import { findSession, listSessions, readTranscript } from "./history.js";
import { guardServer } from "./net-guard.js";
import { SessionLauncher, openInWarp } from "./sessions.js";
import { serveOff, serveOn } from "./tailscale.js";

const WEB_ROOT = resolve(fileURLToPath(new URL("../web", import.meta.url)));
const BUFFER_LIMIT = 800;

const cfg = ensureConfig();
const PORT = Number(process.env.CONNECT_PI_PORT || cfg.port || 4317);

const launcher = new SessionLauncher({ onLog: log });

// ---------------------------------------------------------------- state

const agents = new Map(); // pi sessions currently connected
const phones = new Set();

function agentList() {
	return [...agents.values()]
		.map((a) => ({
			id: a.id,
			name: a.state?.name || a.info?.name || a.info?.cwdName || "pi",
			cwd: a.info?.cwd || "",
			cwdName: a.info?.cwdName || "",
			model: a.state?.model || "",
			thinking: a.state?.thinking || "",
			isStreaming: Boolean(a.state?.isStreaming),
			startedByPhone: launcher.list().some((s) => s.id === a.id),
			// pi's own id for this conversation, which is what ties a live
			// session to its row in the history list
			piSessionId: a.info?.piSessionId || "",
			connectedAt: a.connectedAt,
		}))
		.sort((x, y) => y.connectedAt - x.connectedAt);
}

/** The history list, minus the conversations that are open right now. */
function historyList() {
	const live = new Set([...agents.values()].map((a) => a.info?.piSessionId).filter(Boolean));
	return listSessions({ agentDir: launcher.pi.agentDir, roots: cfg.roots }).filter((s) => !live.has(s.id));
}

function sendJson(ws, obj) {
	if (ws && ws.readyState === 1) {
		try {
			ws.send(JSON.stringify(obj));
		} catch {
			// socket died mid-write; the close handler cleans up
		}
	}
}

const watcherCount = (agentId) => [...phones].filter((p) => p.attachedTo === agentId).length;

function broadcastAgents() {
	const list = agentList();
	for (const ws of phones) sendJson(ws, { t: "agents", agents: list });
	for (const a of agents.values()) sendJson(a.ws, { t: "watchers", count: watcherCount(a.id) });
}

// Only on connect and disconnect. This walks the sessions folder, so it has no
// business running on every streaming state change.
function broadcastHistory() {
	let sessions;
	try {
		sessions = historyList();
	} catch {
		return; // history is a convenience; never let it break the live link
	}
	for (const ws of phones) sendJson(ws, { t: "history", sessions });
}

function toPhones(agentId, payload) {
	for (const ws of phones) if (ws.attachedTo === agentId) sendJson(ws, payload);
}

// Re-setting an existing key overwrites the value but keeps its position, which
// is what lets a streaming assistant message update in place.
function bufferEvent(agent, e) {
	agent.buffer.set(e.k + ":" + (e.id != null ? e.id : "n" + agent.seq++), e);
	while (agent.buffer.size > BUFFER_LIMIT) agent.buffer.delete(agent.buffer.keys().next().value);
}

/**
 * Fill an empty replay buffer from pi's own session file.
 *
 * The extension only ever streams what happens from now on, so without this a
 * resumed conversation — or one you started at the keyboard an hour ago —
 * arrives on the phone as a blank thread, while pi quietly remembers all of
 * it. Read synchronously: the agent may start streaming the moment it is
 * registered, and history has to already be in the buffer when it does.
 */
function seedFromDisk(agent) {
	const file = agent.info?.piSessionFile;
	if (!file || agent.buffer.size) return;
	const events = readTranscript(file);
	if (!events.length) return;
	for (const e of events) bufferEvent(agent, e);
	log(`replayed ${events.length} earlier messages for ${agent.info.cwdName || agent.id}`);
}

// ---------------------------------------------------------------- http

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};

function readBody(req, limit = 256 * 1024) {
	return new Promise((res, rej) => {
		let data = "";
		req.on("data", (c) => {
			data += c;
			if (data.length > limit) rej(new Error("body too large"));
		});
		req.on("end", () => res(data));
		req.on("error", rej);
	});
}

// brake on passcode guessing
const attempts = new Map();
const throttled = (ip) => {
	const rec = attempts.get(ip);
	return rec && rec.until > Date.now() ? Math.ceil((rec.until - Date.now()) / 1000) : 0;
};
function noteFailure(ip) {
	const rec = attempts.get(ip) || { n: 0, until: 0 };
	rec.n += 1;
	if (rec.n >= 5) rec.until = Date.now() + Math.min(15 * 60000, 30000 * 2 ** (rec.n - 5));
	attempts.set(ip, rec);
}

const bearer = (req) => {
	const h = req.headers.authorization || "";
	return h.startsWith("Bearer ") ? h.slice(7) : "";
};
const authed = (req) => verifyToken(cfg, bearer(req));

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	const send = (code, body, headers = {}) => {
		res.writeHead(code, { "cache-control": "no-store", ...headers });
		res.end(body);
	};
	const json = (code, obj) => send(code, JSON.stringify(obj), { "content-type": "application/json" });
	const ip = req.socket.remoteAddress || "?";

	try {
		// ---------------- open endpoints
		if (url.pathname === "/api/auth/state") return json(200, authState(cfg, req));

		if (url.pathname === "/api/auth/passcode" && req.method === "POST") {
			const wait = throttled(ip);
			if (wait) return json(429, { error: `Too many tries. Wait ${wait}s.` });
			try {
				const { passcode } = JSON.parse((await readBody(req)) || "{}");
				const token = loginWithPasscode(cfg, passcode);
				attempts.delete(ip);
				return json(200, { token });
			} catch (err) {
				noteFailure(ip);
				return json(401, { error: err.message });
			}
		}

		if (url.pathname === "/api/auth/passkey/login/options" && req.method === "POST") {
			try {
				return json(200, await passkeyLoginOptions(cfg, req));
			} catch (err) {
				return json(400, { error: err.message });
			}
		}

		if (url.pathname === "/api/auth/passkey/login/verify" && req.method === "POST") {
			const wait = throttled(ip);
			if (wait) return json(429, { error: `Too many tries. Wait ${wait}s.` });
			try {
				const body = JSON.parse((await readBody(req)) || "{}");
				const token = await passkeyLoginVerify(cfg, req, body.response);
				attempts.delete(ip);
				return json(200, { token });
			} catch (err) {
				noteFailure(ip);
				return json(401, { error: err.message });
			}
		}

		// ---------------- everything below needs a live login
		if (url.pathname.startsWith("/api/") && !authed(req)) return json(401, { error: "locked" });

		if (url.pathname === "/api/me") return json(200, { ok: true, ...authState(cfg, req) });

		if (url.pathname === "/api/auth/passkey/register/options" && req.method === "POST") {
			try {
				return json(200, await passkeyRegisterOptions(cfg, req));
			} catch (err) {
				return json(400, { error: err.message });
			}
		}

		if (url.pathname === "/api/auth/passkey/register/verify" && req.method === "POST") {
			try {
				const body = JSON.parse((await readBody(req)) || "{}");
				return json(200, await passkeyRegisterVerify(cfg, req, body.response, body.label));
			} catch (err) {
				return json(400, { error: err.message });
			}
		}

		// ---------------- folders
		if (url.pathname === "/api/folders") {
			const at = url.searchParams.get("path");
			try {
				if (!at) return json(200, { roots: await listRoots(cfg.roots), path: null, folders: [] });
				return json(200, await listFolders(at, cfg.roots));
			} catch (err) {
				return json(400, { error: err.message });
			}
		}

		if (url.pathname === "/api/folders/create" && req.method === "POST") {
			try {
				const { parent, name } = JSON.parse((await readBody(req)) || "{}");
				return json(200, { path: await createFolder(parent, name, cfg.roots) });
			} catch (err) {
				return json(400, { error: err.message });
			}
		}

		// ---------------- sessions
		if (url.pathname === "/api/history") {
			try {
				return json(200, { sessions: historyList() });
			} catch (err) {
				return json(400, { error: err.message });
			}
		}

		if (url.pathname === "/api/sessions" && req.method === "POST") {
			try {
				const { folder, resumeId } = JSON.parse((await readBody(req)) || "{}");

				// Resuming: the folder comes from the session itself, not the
				// phone, so a stale id cannot be used to point pi somewhere else.
				if (resumeId) {
					const past = findSession({ agentDir: launcher.pi.agentDir, roots: cfg.roots }, resumeId);
					if (!past) return json(400, { error: "That session is no longer on this PC." });
					if (!past.canResume) return json(400, { error: "That session ran outside your allowed folders." });
					const where = await resolveInsideRoots(past.cwd, cfg.roots);
					if (!where) return json(400, { error: "That session's folder is not on the allowed list." });
					return json(200, launcher.start(where, { resume: { id: past.id, path: past.path } }));
				}

				const real = await resolveInsideRoots(folder, cfg.roots);
				if (!real) return json(400, { error: "That folder is not on the allowed list." });
				return json(200, launcher.start(real));
			} catch (err) {
				return json(400, { error: err.message });
			}
		}

		if (url.pathname === "/api/sessions/stop" && req.method === "POST") {
			const { id } = JSON.parse((await readBody(req)) || "{}");
			return json(200, { stopped: launcher.stop(id) });
		}

		if (url.pathname === "/api/open-in-warp" && req.method === "POST") {
			const { folder } = JSON.parse((await readBody(req)) || "{}");
			const real = await resolveInsideRoots(folder, cfg.roots);
			if (!real) return json(400, { error: "That folder is not on the allowed list." });
			return json(200, { opened: openInWarp(real) });
		}

		// ---------------- static files
		const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
		const file = join(WEB_ROOT, rel);
		if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + sep)) return send(403, "Forbidden");
		const buf = await readFile(file);
		return send(200, buf, { "content-type": MIME[extname(file)] || "application/octet-stream" });
	} catch (err) {
		if (err?.code === "ENOENT") return send(404, "Not found");
		log(`request failed: ${err.message}`);
		return send(500, "Server error");
	}
});

// Only this PC and Tailscale may open a socket — plus your home network, if the
// switch is on. The flag is read live so `npm run wifi on` takes effect without
// restarting the bridge.
let allowLan = Boolean(cfg.allowLan);
watchFile(CONFIG_PATH, { interval: 2000 }, () => {
	const fresh = loadConfig();
	if (!fresh || Boolean(fresh.allowLan) === allowLan) return;
	allowLan = Boolean(fresh.allowLan);
	cfg.allowLan = allowLan;
	log(allowLan ? "home network access turned ON" : "home network access turned OFF");
});

guardServer(server, {
	isLanAllowed: () => allowLan,
	onBlocked: (ip) => log(`blocked connection from ${ip}`),
});

// ---------------------------------------------------------------- websockets

const wssAgent = new WebSocketServer({ noServer: true });
const wssApp = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url, "http://localhost");
	const token = url.searchParams.get("token") || "";

	if (url.pathname === "/agent") {
		if (token !== cfg.agentToken) return socket.destroy();
		return wssAgent.handleUpgrade(req, socket, head, (ws) => wssAgent.emit("connection", ws, req));
	}
	if (url.pathname === "/app") {
		if (!verifyToken(cfg, token)) return socket.destroy();
		return wssApp.handleUpgrade(req, socket, head, (ws) => wssApp.emit("connection", ws, req));
	}
	socket.destroy();
});

wssAgent.on("connection", (ws) => {
	let agent = null;

	ws.on("message", (data) => {
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}

		if (msg.t === "hello") {
			const id = String(msg.info?.id || randomUUID().slice(0, 12));
			const previous = agents.get(id);
			if (previous && previous.ws !== ws) {
				try {
					previous.ws.close();
				} catch {}
			}
			agent = {
				id,
				ws,
				info: msg.info || {},
				state: msg.state || {},
				buffer: previous?.buffer || new Map(),
				seq: previous?.seq || 0,
				connectedAt: Date.now(),
			};
			agents.set(id, agent);
			seedFromDisk(agent);
			log(`pi connected: ${agent.info.cwdName || id}`);
			sendJson(ws, { t: "welcome", id, watchers: watcherCount(id) });
			broadcastAgents();
			broadcastHistory();
			return;
		}
		if (!agent) return;

		if (msg.t === "event") {
			bufferEvent(agent, msg.e);
			toPhones(agent.id, { t: "event", agentId: agent.id, e: msg.e });
		} else if (msg.t === "state") {
			agent.state = { ...agent.state, ...msg.state };
			toPhones(agent.id, { t: "state", agentId: agent.id, state: agent.state });
			broadcastAgents();
		} else if (msg.t === "clear") {
			agent.buffer.clear();
			toPhones(agent.id, { t: "cleared", agentId: agent.id });
		}
	});

	ws.on("close", () => {
		if (agent && agents.get(agent.id) === agent) {
			agents.delete(agent.id);
			log(`pi disconnected: ${agent.info.cwdName || agent.id}`);
			toPhones(agent.id, { t: "agent_gone", agentId: agent.id });
			broadcastAgents();
			// it has just become a past session, so the phone's list changed
			broadcastHistory();
		}
	});
	ws.on("error", () => {});
});

wssApp.on("connection", (ws, req) => {
	ws.loginToken = new URL(req.url, "http://localhost").searchParams.get("token");
	phones.add(ws);
	ws.isAlive = true;
	ws.on("pong", () => {
		ws.isAlive = true;
	});
	sendJson(ws, { t: "agents", agents: agentList() });
	try {
		sendJson(ws, { t: "history", sessions: historyList() });
	} catch {}

	ws.on("message", (data) => {
		if (!verifyToken(cfg, ws.loginToken)) return ws.close(1008, "Login expired");
		let msg;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			return;
		}

		if (msg.t === "attach") {
			ws.attachedTo = msg.agentId;
			const agent = agents.get(msg.agentId);
			sendJson(ws, {
				t: "snapshot",
				agentId: msg.agentId,
				online: Boolean(agent),
				state: agent?.state || {},
				info: agent?.info || {},
				events: agent ? [...agent.buffer.values()] : [],
			});
			broadcastAgents();
			return;
		}

		const agent = agents.get(msg.agentId);
		if (!agent) return sendJson(ws, { t: "error", message: "That pi session is not connected." });

		if (msg.t === "prompt") {
			const text = String(msg.text || "").trim();
			if (text) sendJson(agent.ws, { t: "prompt", text, mode: msg.mode || "auto" });
		} else if (msg.t === "stop") {
			sendJson(agent.ws, { t: "stop" });
		} else if (msg.t === "thinking" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(msg.level)) {
			sendJson(agent.ws, { t: "thinking", level: msg.level });
		} else if (msg.t === "rename" && typeof msg.name === "string" && msg.name.trim() && msg.name.trim().length <= 100) {
			sendJson(agent.ws, { t: "rename", name: msg.name.trim() });
		}
	});

	ws.on("close", () => {
		phones.delete(ws);
		broadcastAgents();
	});
	ws.on("error", () => {});
});

setInterval(() => {
	for (const ws of [...phones]) {
		if (!verifyToken(cfg, ws.loginToken, { touch: false })) {
			ws.close(1008, "Login expired");
			continue;
		}
		if (ws.isAlive === false) {
			ws.terminate();
			phones.delete(ws);
			continue;
		}
		ws.isAlive = false;
		try {
			ws.ping();
		} catch {}
	}
}, 30000).unref();

// ---------------------------------------------------------------- boot

function log(msg) {
	console.log(`${new Date().toTimeString().slice(0, 8)}  ${msg}`);
}

if (process.env.CONNECT_PI_PASSCODE && !hasPasscode(cfg)) setPasscode(cfg, process.env.CONNECT_PI_PASSCODE);

// Closing the window is the off switch, so every way this process can end has
// to leave the same clean state: no pi sessions, no sleep hold, and the
// Tailscale door shut. Windows sends SIGHUP when its console window is closed
// and SIGBREAK on Ctrl+Break, so both are here alongside the usual two.
let shuttingDown = false;
function shutdown(why) {
	if (shuttingDown) return;
	shuttingDown = true;
	log(`shutting down (${why})`);
	try {
		launcher.stopAll();
		launcher.stopKeepAwake();
	} catch {}
	if (serveOff()) log("tailscale serve turned off - the https address answers nothing now");
	process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
	process.on(sig, () => shutdown(sig));
}
// last line of defence: an uncaught throw or a plain end of the event loop
process.on("exit", () => {
	if (!shuttingDown) {
		try {
			launcher.stopAll();
			launcher.stopKeepAwake();
		} catch {}
		serveOff();
	}
});

// bind to everything, then refuse anyone who is not this PC or Tailscale
server.listen(PORT, "0.0.0.0", () => {
	const pi = launcher.pi;
	// open the tailnet door only once we are actually listening behind it
	const url = serveOn(PORT);

	console.log("");
	console.log("   ================================================================");
	console.log("     pi on my phone   -   ON");
	console.log("   ================================================================");
	console.log("");
	if (url) {
		console.log("     On your phone, open:");
		console.log("");
		console.log(`         ${url}`);
		console.log("");
		console.log("     (Tailscale has to be switched on on the phone too.)");
	} else {
		console.log("     !!  Tailscale is not running on this PC, so your phone");
		console.log("         cannot reach this. Start Tailscale and run this again.");
	}
	console.log("");
	console.log("   ----------------------------------------------------------------");
	console.log(`     Reachable from    ${allowLan ? "this PC, Tailscale, AND your home WiFi" : "this PC and Tailscale only"}`);
	console.log(`     Folders allowed   ${cfg.roots.join("   ")}`);
	console.log(`     pi found          ${pi.ok ? pi.cli + "  (" + pi.source + ")" : "NO - is pi installed? set PI_CLI to override"}`);
	console.log(`     Config            ${CONFIG_PATH}`);
	if (!hasPasscode(cfg)) console.log("     !!  No passcode set yet. Run:  npm run passcode");
	console.log("   ----------------------------------------------------------------");
	console.log("");
	console.log("     CLOSE THIS WINDOW to turn it off. Nothing keeps running.");
	console.log("");
	console.log("   ================================================================");
	console.log("");
});
