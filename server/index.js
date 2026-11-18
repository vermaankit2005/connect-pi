#!/usr/bin/env node
import { appendFileSync, renameSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
	authState, cookieToken, loginWithPasscode, passkeyLoginOptions, passkeyLoginVerify,
	passkeyRegisterOptions, passkeyRegisterVerify, sessionCookie, siteFor,
} from "./auth.js";
import { CONFIG_PATH, controlPort, ensureConfig, hasPasscode, removePasskey, revokeToken, setPasscode, verifyToken } from "./config.js";
import { createFolder, listFolders, listRoots, resolveInsideRoots } from "./files.js";
import { safeSessionFile } from "./history.js";
import { historyJob } from "./history-client.js";
import { SessionLauncher, changedFiles, openInWarp } from "./sessions.js";
import { createServe } from "./tailscale.js";

const WEB_ROOT = resolve(fileURLToPath(new URL("../web", import.meta.url)));
const cfg = ensureConfig();
const PORT = Number(process.env.CONNECT_PI_PORT || cfg.port);
const CONTROL_PORT = controlPort({ ...cfg, port: PORT });
if (![PORT, CONTROL_PORT].every((port) => Number.isInteger(port) && port > 0 && port <= 65535) || PORT === CONTROL_PORT) {
	throw new Error("Choose two different, valid HTTP and local control ports.");
}
if (process.env.CONNECT_PI_PASSCODE && !hasPasscode(cfg)) setPasscode(cfg, process.env.CONNECT_PI_PASSCODE);

const launcher = new SessionLauncher({ onLog: log });
const serve = createServe();
let connection = { url: null, problem: "Checking Tailscale HTTPS…" };
const agents = new Map();
const phones = new Set();
const receipts = new Map();
const historyOptions = { agentDir: launcher.pi.agentDir, roots: cfg.roots };
const WS_MAX = 768 * 1024;
const REPLAY_BYTES = 3 * 1024 * 1024;
const REPLAY_EVENTS = 350;
const MAX_PHONES = 12;
const MAX_AGENTS = 32;
const MAX_RECEIPTS = 512;
const RECEIPT_AGE_MS = 15 * 60_000;
const TEXT_LIMIT = 110_000;
const IMAGE_LIMIT = 480_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const EVENTS = new Set(["user", "assistant", "tool", "bash", "notice", "done", "run_stopped"]);

const object = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const string = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
const routeId = (v) => string(v, 200);
const promptId = (v) => string(v, 64) && /^[\w-]+$/.test(v);
const textField = (v, max) => typeof v === "string" ? v.slice(0, max) : "";

function agentList() {
	return [...agents.values()].map((agent) => ({
		id: agent.id, name: agent.state.name || agent.info.name || agent.info.cwdName,
		cwd: agent.info.cwd, cwdName: agent.info.cwdName, piSessionId: agent.info.piSessionId,
		model: agent.state.model || "", thinking: agent.state.thinking || "",
		isStreaming: Boolean(agent.state.isStreaming), waiting: Boolean(agent.state.waiting),
		startedByPhone: launcher.status(agent.id).status === "starting", connectedAt: agent.connectedAt,
	})).sort((a, b) => b.connectedAt - a.connectedAt);
}

async function historyList(refresh = false) {
	const saved = await historyJob("list", { ...historyOptions, refresh });
	const live = new Set([...agents.values()].map((agent) => agent.info.piSessionId));
	return saved.filter((entry) => !live.has(entry.id)).slice(0, 1000)
		.map(({ path, ...summary }) => summary);
}

async function savedSession(id) {
	if (!routeId(id)) return null;
	const query = { ...historyOptions, sessionId: id };
	return await historyJob("find", query) || historyJob("find", { ...query, refresh: true });
}

function sendJson(ws, payload) {
	if (ws?.readyState !== 1) return false;
	try {
		const message = JSON.stringify(payload);
		if (ws.bufferedAmount + Buffer.byteLength(message) > 8 * 1024 * 1024) {
			ws.terminate();
			return false;
		}
		ws.send(message);
		return true;
	} catch { return false; }
}

function broadcastAgents() {
	const list = agentList();
	for (const ws of phones) sendJson(ws, { t: "agents", agents: list });
	for (const agent of agents.values()) {
		const count = [...phones].filter((ws) => ws.attachedTo === agent.id).length;
		sendJson(agent.ws, { t: "watchers", count });
	}
}

async function broadcastHistory() {
	try {
		const sessions = await historyList(true);
		for (const ws of phones) sendJson(ws, { t: "history", sessions });
	} catch { /* a later refresh will retry */ }
}

function toPhones(agentId, payload) {
	for (const ws of phones) if (ws.attachedTo === agentId) sendJson(ws, payload);
}

function bufferEvent(agent, event) {
	const key = event.k + ":" + event.id;
	const bytes = Buffer.byteLength(JSON.stringify(event));
	if (bytes > REPLAY_BYTES) return;
	agent.bytes += bytes - (agent.buffer.get(key)?.bytes || 0);
	agent.buffer.set(key, { event, bytes });
	while (agent.bytes > REPLAY_BYTES || agent.buffer.size > REPLAY_EVENTS) {
		const oldest = agent.buffer.keys().next().value;
		agent.bytes -= agent.buffer.get(oldest).bytes;
		agent.buffer.delete(oldest);
	}
}

async function snapshot(ws, id) {
	const agent = agents.get(id);
	if (agent?.seed) await agent.seed;
	if (ws.attachedTo !== id || agent !== agents.get(id)) return;
	const { piSessionFile, ...info } = agent?.info || {};
	sendJson(ws, {
		t: "snapshot", agentId: id, online: Boolean(agent), state: agent?.state || {}, info,
		events: agent ? [...agent.buffer.values()].map(({ event }) => event) : [],
	});
}

function seed(agent) {
	if (!agent.info.piSessionFile || agent.buffer.size) return;
	agent.seed = historyJob("page", { ...historyOptions, file: agent.info.piSessionFile })
		.then(({ events }) => {
			const live = [...agent.buffer.values()].map(({ event }) => event);
			agent.buffer.clear();
			agent.bytes = 0;
			for (const event of [...events, ...live]) bufferEvent(agent, event);
		})
		.catch(() => {})
		.finally(() => { agent.seed = null; });
}

const MIME = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".webmanifest": "application/manifest+json",
	".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".ttf": "font/ttf",
};
const SECURITY_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function respond(res, code, data, headers = {}) {
	res.writeHead(code, { ...SECURITY_HEADERS, "Content-Type": "application/json", ...headers });
	res.end(JSON.stringify(data));
}

function readBody(req, limit = 256 * 1024) {
	return new Promise((done, fail) => {
		const tooLarge = () => Object.assign(new Error("Request is too large."), { status: 413 });
		if (Number(req.headers["content-length"]) > limit) {
			req.resume();
			fail(tooLarge());
			return;
		}
		let bytes = 0;
		const chunks = [];
		const onData = (chunk) => {
			bytes += chunk.length;
			if (bytes <= limit) return chunks.push(chunk);
			chunks.length = 0;
			req.off("data", onData);
			req.resume();
			fail(tooLarge());
		};
		req.on("data", onData);
		req.once("error", fail);
		req.once("aborted", () => fail(new Error("Request interrupted.")));
		req.once("end", () => {
			try {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
				if (!object(body)) throw new Error();
				done(body);
			} catch { fail(Object.assign(new Error("Invalid JSON request."), { status: 400 })); }
		});
	});
}

const attempts = new Map();
const challengesByClient = new Map();
let pinChecks = 0;
function attemptKey(req, site) {
	return site.secure ? textField(req.headers["tailscale-user-login"], 160) || "tailnet" : "local";
}
function counter(map, key) {
	const now = Date.now();
	for (const [id, record] of map) if (record.expires <= now) map.delete(id);
	if (!map.has(key)) {
		if (map.size >= 128) map.delete(map.keys().next().value);
		map.set(key, { count: 0, until: 0, expires: now + 30 * 60_000 });
	}
	return map.get(key);
}
function throttle(res, wait) {
	return respond(res, 429, { error: `Too many tries. Wait ${wait}s.` }, { "Retry-After": String(wait) });
}
function invalidateSockets() {
	for (const ws of phones) {
		if (!verifyToken(cfg, ws.loginToken, { origin: ws.site.origin, touch: false })) ws.terminate();
	}
}

const server = http.createServer({ requestTimeout: 15_000, headersTimeout: 8000 }, async (req, res) => {
	const json = (code, data, headers) => respond(res, code, data, headers);
	try {
		const url = new URL(req.url, "http://localhost");
		const site = siteFor(req, connection.url, PORT);
		if (!site) return json(403, { error: "Use the Tailscale HTTPS address or the local PC preview." });
		if (url.pathname.startsWith("/api/local/")) return json(403, { error: "Local control uses a separate listener." });
		if (req.method !== "GET" && req.headers.origin !== site.origin) return json(403, { error: "Invalid request origin." });
		const route = `${req.method} ${url.pathname}`;
		const key = attemptKey(req, site);

		if (route === "GET /api/auth/state") return json(200, authState(cfg, site));

		if (route === "POST /api/auth/passkey/login/options") {
			const record = counter(challengesByClient, key);
			const now = Date.now();
			if (record.until <= now) Object.assign(record, { count: 0, until: now + 60_000 });
			if (++record.count > 12) return throttle(res, Math.ceil((record.until - now) / 1000));
			return json(200, await passkeyLoginOptions(cfg, site));
		}

		if (route === "POST /api/auth/passcode" || route === "POST /api/auth/passkey/login/verify") {
			const record = counter(attempts, key);
			if (record.until > Date.now()) return throttle(res, Math.ceil((record.until - Date.now()) / 1000));
			const body = await readBody(req);
			const pin = route === "POST /api/auth/passcode";
			if (record.until > Date.now()) return throttle(res, Math.ceil((record.until - Date.now()) / 1000));
			if (pin && pinChecks >= 2) return throttle(res, 2);
			if (pin) pinChecks += 1;
			try {
				const token = pin ? await loginWithPasscode(cfg, site, body.passcode) : await passkeyLoginVerify(cfg, site, body.response);
				attempts.delete(key);
				return json(200, { ok: true }, { "Set-Cookie": sessionCookie(site, token) });
			} catch (error) {
				record.count += 1;
				if (record.count >= 5) record.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (record.count - 5));
				return json(401, { error: pin ? error.message : "Could not sign in with that passkey." });
			} finally {
				if (pin) pinChecks -= 1;
			}
		}

		if (route === "POST /api/auth/lock") {
			const login = verifyToken(cfg, cookieToken(req, site), { origin: site.origin, touch: false });
			if (login) revokeToken(cfg, login);
			invalidateSockets();
			return json(200, { ok: true }, { "Set-Cookie": sessionCookie(site, "") });
		}

		const login = url.pathname.startsWith("/api/") && verifyToken(cfg, cookieToken(req, site), { origin: site.origin });
		if (url.pathname.startsWith("/api/") && !login) return json(401, { error: "Unlock to continue." });
		if (route === "GET /api/me") return json(200, { ok: true, ...authState(cfg, site) });
		if (route === "GET /api/devices") return json(200, {
			passkeys: cfg.passkeys.map(({ id, label, createdAt }) => ({ id, label, createdAt })),
			sessions: cfg.tokens.filter((entry) => entry !== login).map(({ hash, label, createdAt }) => ({ id: hash, label, createdAt })),
		});
		if (route === "POST /api/devices/remove") {
			const { id, kind } = await readBody(req);
			if (kind === "passkey") removePasskey(cfg, id);
			if (kind === "session") {
				const other = cfg.tokens.find((entry) => entry.hash === id && entry !== login);
				if (other) revokeToken(cfg, other);
			}
			invalidateSockets();
			return json(200, { ok: true });
		}
		if (route === "POST /api/auth/passkey/register/options") return json(200, await passkeyRegisterOptions(cfg, site, login));
		if (route === "POST /api/auth/passkey/register/verify") {
			const { response, label } = await readBody(req);
			return json(200, await passkeyRegisterVerify(cfg, site, login, response, label));
		}

		if (route === "GET /api/folders") {
			const path = url.searchParams.get("path");
			return json(200, path ? await listFolders(path, cfg.roots) : { roots: await listRoots(cfg.roots), path: null, folders: [] });
		}
		if (route === "POST /api/folders/create") {
			const { parent, name } = await readBody(req);
			return json(200, { path: await createFolder(parent, name, cfg.roots) });
		}
		if (route === "GET /api/history") return json(200, { sessions: await historyList() });
		if (route === "GET /api/history/transcript") {
			const saved = await savedSession(url.searchParams.get("id"));
			if (!saved || !await resolveInsideRoots(saved.cwd, cfg.roots)) return json(404, { error: "This conversation is unavailable on your phone." });
			const cursor = url.searchParams.get("before");
			const before = cursor == null ? null : Number(cursor);
			if (before !== null && (!Number.isSafeInteger(before) || before < 0)) return json(400, { error: "Invalid history cursor." });
			const search = (url.searchParams.get("search") || "").slice(0, 160).toLowerCase();
			return json(200, await historyJob("page", { ...historyOptions, file: saved.path, before, search }));
		}
		if (route === "POST /api/sessions") {
			const { folder, resumeId } = await readBody(req);
			if (resumeId) {
				const saved = await savedSession(resumeId);
				const path = saved && safeSessionFile(saved.path, launcher.pi.agentDir);
				const cwd = saved && await resolveInsideRoots(saved.cwd, cfg.roots);
				if (!cwd || !path) return json(404, { error: "This conversation is unavailable on your phone." });
				const live = [...agents.values()].find((agent) => agent.info.piSessionId === saved.id);
				return json(200, live ? { id: live.id, folder: live.info.cwd } : launcher.start(cwd, { resume: { id: saved.id, path } }));
			}
			const cwd = await resolveInsideRoots(folder, cfg.roots);
			return cwd ? json(200, launcher.start(cwd)) : json(400, { error: "Choose an available project folder." });
		}
		if (route === "GET /api/sessions/status") {
			const id = url.searchParams.get("id");
			const launchStatus = launcher.status(id);
			return json(200, agents.has(id) && launchStatus.status !== "stopping" ? { status: "connected" } : launchStatus);
		}
		if (route === "POST /api/sessions/stop") {
			const { id } = await readBody(req);
			return json(200, { stopping: launcher.stop(id) });
		}

		if (route === "POST /api/open-in-warp" || route === "POST /api/changes") {
			const { agentId, sessionId } = await readBody(req);
			const live = agents.get(agentId);
			const saved = !live && sessionId ? await savedSession(sessionId) : null;
			const cwd = await resolveInsideRoots(live?.info.cwd || saved?.cwd, cfg.roots);
			if (!cwd) return json(400, { error: "Choose an available project session." });
			if (route === "POST /api/changes") return json(200, await changedFiles(cwd));
			const file = safeSessionFile(live?.info.piSessionFile || saved?.path, launcher.pi.agentDir);
			if (live && launcher.status(live.id).status !== "starting") {
				return json(200, { alreadyOnPc: true, exact: true });
			}
			return json(200, { ...await openInWarp(cwd, file), live: Boolean(live) });
		}

		if (url.pathname.startsWith("/api/") || req.method !== "GET") return json(404, { error: "Unknown request." });
		const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
		const file = join(WEB_ROOT, rel);
		const type = MIME[extname(file)];
		if (!file.startsWith(WEB_ROOT + sep) || !type) return json(404, { error: "Not found." });
		const asset = url.pathname === "/vendor/markdown-it.js"
			? new URL("../node_modules/markdown-it/dist/markdown-it.min.js", import.meta.url) : file;
		const content = await readFile(asset);
		res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type });
		res.end(content);
	} catch (error) {
		if (res.headersSent || res.destroyed) return;
		if (error.code === "ENOENT") return json(404, { error: "Not found." });
		json(error.status || 400, { error: error.message });
	}
});

const control = http.createServer({ requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
	if (req.headers["x-connect-pi-token"] !== cfg.agentToken || req.headers.origin) return respond(res, 403, { error: "Local control only." });
	try {
		if (req.method === "GET" && req.url === "/api/local/status") {
			return respond(res, 200, { service: "connect-pi", pid: process.pid, port: PORT, controlPort: CONTROL_PORT, ...connection, roots: cfg.roots });
		}
		if (req.method === "POST" && req.url === "/api/local/stop") {
			respond(res, 200, { stopping: true });
			setTimeout(() => shutdown("phone command"), 150);
			return;
		}
		if (req.method === "POST" && req.url === "/api/local/passcode") {
			const { passcode } = await readBody(req, 1024);
			setPasscode(cfg, passcode);
			attempts.clear();
			invalidateSockets();
			return respond(res, 200, { rotated: true });
		}
		return respond(res, 404, { error: "Unknown local command." });
	} catch (error) { return respond(res, error.status || 400, { error: error.message }); }
});

function parseMessage(data) {
	try {
		const message = JSON.parse(data.toString());
		return object(message) && string(message.t, 24) ? message : null;
	} catch { return null; }
}

const wssAgent = new WebSocketServer({ noServer: true, maxPayload: WS_MAX });
const wssApp = new WebSocketServer({ noServer: true, maxPayload: WS_MAX });

control.on("upgrade", (req, socket, head) => {
	let url;
	try { url = new URL(req.url, "http://localhost"); } catch { return socket.destroy(); }
	if (req.headers.origin || url.pathname !== "/agent" || url.searchParams.get("token") !== cfg.agentToken ||
		wssAgent.clients.size >= MAX_AGENTS) return socket.destroy();
	wssAgent.handleUpgrade(req, socket, head, (ws) => wssAgent.emit("connection", ws));
});
server.on("upgrade", (req, socket, head) => {
	const site = siteFor(req, connection.url, PORT);
	if (!site || req.headers.origin !== site.origin || req.url !== "/app" || phones.size >= MAX_PHONES) return socket.destroy();
	const token = cookieToken(req, site);
	if (!verifyToken(cfg, token, { origin: site.origin })) return socket.destroy();
	wssApp.handleUpgrade(req, socket, head, (ws) => wssApp.emit("connection", ws, { site, token }));
});

function setAgentState(agent, msg) {
	const state = msg.state;
	if (!object(state)) return false;
	for (const key of ["name", "model", "thinking"]) if (typeof state[key] === "string") agent.state[key] = textField(state[key], 150);
	for (const key of ["isStreaming", "waiting"]) if (typeof state[key] === "boolean") agent.state[key] = state[key];
	if (typeof state.piSessionFile === "string") agent.info.piSessionFile = textField(state.piSessionFile, 4096);
	return true;
}

function receiptKey(agentId, id) { return `${agentId}:${id}`; }
function reportReceipt(agentId, id, status, message) {
	const key = receiptKey(agentId, id);
	const record = receipts.get(key);
	if (!record || record.status === "failed" || (record.status === "accepted" && status !== "failed")) return;
	Object.assign(record, { status, message });
	toPhones(agentId, { t: "receipt", agentId, id, status, message });
}

wssAgent.on("connection", (ws) => {
	let agent;
	let authenticating = false;
	ws.isAlive = true;
	ws.on("pong", () => { ws.isAlive = true; });
	ws.on("message", async (data) => {
		const msg = parseMessage(data);
		if (!msg) return ws.close(1008, "Invalid message");
		if (msg.t === "hello") {
			if (agent || authenticating || !object(msg.info) || !routeId(msg.info.id)) return ws.close(1008, "Invalid agent registration");
			authenticating = true;
			const cwd = await resolveInsideRoots(msg.info.cwd, cfg.roots);
			if (!cwd) return ws.close(1008, "Project not shared");
			if (ws.readyState !== 1) return;
			const id = msg.info.id;
			const piSessionId = textField(msg.info.piSessionId, 200);
			const previous = agents.get(id);
			if (previous?.ws !== ws) previous?.ws.terminate();
			const canReuse = previous && previous.info.piSessionId === piSessionId;
			agent = {
				id, ws, connectedAt: Date.now(), state: {}, seed: null,
				info: {
					id, cwd, cwdName: textField(msg.info.cwdName, 260) || cwd, piSessionId,
					piSessionFile: textField(msg.info.piSessionFile, 4096), name: textField(msg.info.name, 150),
				},
				buffer: canReuse ? previous.buffer : new Map(), bytes: canReuse ? previous.bytes : 0,
			};
			agents.set(id, agent);
			setAgentState(agent, msg);
			seed(agent);
			log(`pi connected: ${agent.info.cwdName}`);
			sendJson(ws, { t: "welcome", id });
			broadcastAgents();
			for (const phone of phones) if (phone.attachedTo === id) void snapshot(phone, id);
			void broadcastHistory();
			return;
		}
		if (!agent || agents.get(agent.id) !== agent) return;
		if (msg.t === "state" && setAgentState(agent, msg)) {
			toPhones(agent.id, { t: "state", agentId: agent.id, state: agent.state });
			broadcastAgents();
		}
		if (msg.t === "event" && object(msg.e) && EVENTS.has(msg.e.k) && routeId(msg.e.id)) {
			bufferEvent(agent, msg.e);
			toPhones(agent.id, { t: "event", agentId: agent.id, e: msg.e });
		}
		if (msg.t === "receipt" && promptId(msg.id) && ["queued", "accepted", "failed"].includes(msg.status)) {
			reportReceipt(agent.id, msg.id, msg.status, textField(msg.message, 300));
		}
	});
	ws.on("close", () => {
		if (!agent || agents.get(agent.id) !== agent) return;
		agents.delete(agent.id);
		log(`pi disconnected: ${agent.info.cwdName}`);
		toPhones(agent.id, { t: "agent_gone", agentId: agent.id });
		broadcastAgents();
		void broadcastHistory();
	});
	ws.on("error", () => {});
});

function promptImage(value) {
	if (value === undefined) return undefined;
	if (!object(value) || !IMAGE_TYPES.has(value.mimeType) || !string(value.data, IMAGE_LIMIT) ||
		!/^[\w+/]+={0,2}$/.test(value.data)) return null;
	return { mimeType: value.mimeType, data: value.data };
}

wssApp.on("connection", (ws, { site, token }) => {
	ws.site = site;
	ws.loginToken = token;
	phones.add(ws);
	ws.isAlive = true;
	ws.on("pong", () => { ws.isAlive = true; });
	sendJson(ws, { t: "agents", agents: agentList() });
	historyList().then((sessions) => sendJson(ws, { t: "history", sessions })).catch(() => {});

	ws.on("message", (data) => {
		if (!verifyToken(cfg, token, { origin: site.origin })) return ws.close(1008, "Login expired");
		const msg = parseMessage(data);
		if (!msg || !routeId(msg.agentId)) return ws.close(1008, "Invalid message");
		const id = msg.agentId;
		if (msg.t === "attach") {
			ws.attachedTo = id;
			void snapshot(ws, id);
			broadcastAgents();
			return;
		}
		if (msg.t === "receipt_status" && ws.attachedTo === id && promptId(msg.id)) {
			const record = receipts.get(receiptKey(id, msg.id));
			return sendJson(ws, { t: "receipt", agentId: id, id: msg.id, status: record?.status || "unknown", message: record?.message });
		}
		if (msg.t === "prompt" && promptId(msg.id)) {
			const prior = receipts.get(receiptKey(id, msg.id));
			const acknowledge = (status, message) => sendJson(ws, { t: "receipt", agentId: id, id: msg.id, status, message });
			if (prior) return acknowledge(prior.status, prior.message);
			const image = promptImage(msg.image);
			const agent = agents.get(id);
			if (!agent || ws.attachedTo !== id) return acknowledge("failed", "Pi is disconnected. Your draft is ready to retry.");
			if (typeof msg.text !== "string" || msg.text.length > TEXT_LIMIT || image === null || (!msg.text.trim() && !image)) {
				return acknowledge("failed", "Message or attachment exceeds the supported limit.");
			}
			for (const [key, record] of receipts) if (Date.now() - record.createdAt > RECEIPT_AGE_MS) receipts.delete(key);
			if (receipts.size >= MAX_RECEIPTS) return acknowledge("failed", "Too many recent messages. Try again in a moment.");
			if (!sendJson(agent.ws, { t: "prompt", id: msg.id, text: msg.text, image, mode: msg.mode === "followUp" ? "followUp" : "steer" })) {
				return acknowledge("failed", "Pi did not receive the message.");
			}
			receipts.set(receiptKey(id, msg.id), { status: "queued", createdAt: Date.now() });
			return acknowledge("queued");
		}
		const agent = agents.get(id);
		if (!agent || ws.attachedTo !== id) return sendJson(ws, { t: "error", message: "That Pi session is disconnected." });
		if (msg.t === "stop") sendJson(agent.ws, { t: "stop" });
		if (msg.t === "thinking" && THINKING.includes(msg.level)) sendJson(agent.ws, { t: "thinking", level: msg.level });
		if (msg.t === "rename" && typeof msg.name === "string" && string(msg.name.trim(), 100)) sendJson(agent.ws, { t: "rename", name: msg.name.trim() });
	});
	ws.on("close", () => { phones.delete(ws); broadcastAgents(); });
	ws.on("error", () => {});
});

setInterval(() => {
	invalidateSockets();
	for (const ws of [...phones, ...wssAgent.clients]) {
		if (ws.isAlive === false) ws.terminate();
		else if (ws.readyState === 1) { ws.isAlive = false; ws.ping(); }
	}
}, 20_000).unref();

function log(message) {
	const line = `${new Date().toISOString()}  ${message}\n`;
	const file = process.env.CONNECT_PI_LOG;
	if (!file) { console.log(line.trimEnd()); return; }
	try {
		if ((statSync(file, { throwIfNoEntry: false })?.size || 0) > 512 * 1024) {
			rmSync(file + ".previous", { force: true });
			renameSync(file, file + ".previous");
		}
		appendFileSync(file, line, { mode: 0o600 });
	} catch (error) { console.error(error.message); }
}
process.on("uncaughtExceptionMonitor", (error) => log(error.message));
let shuttingDown = false;
function shutdown(reason, code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	log(`shutting down (${reason})`);
	server.close();
	control.close();
	launcher.stopAll();
	launcher.stopKeepAwake();
	for (const ws of [...phones, ...wssAgent.clients]) ws.terminate();
	if (serve.stop()) log("removed Connect Pi’s private Tailscale rule");
	process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(signal, () => shutdown(signal));
process.on("exit", () => { if (!shuttingDown) { launcher.stopAll(); launcher.stopKeepAwake(); serve.stop(); } });
for (const listener of [server, control]) {
	listener.on("error", (error) => shutdown(error.code === "EADDRINUSE" ?
		`Port ${error.port} is already in use. No other process was stopped.` : error.message, 1));
}

server.listen(PORT, "127.0.0.1", () => control.listen(CONTROL_PORT, "127.0.0.1", () => {
	connection = process.env.CONNECT_PI_TAILSCALE === "off" ? { url: null, problem: "Tailscale integration is disabled for this run." } : serve.start(PORT);
	log(connection.url ? `Open on your phone: ${connection.url}` : connection.problem);
	log(`On this PC: http://localhost:${PORT} | settings: ${CONFIG_PATH}`);
	if (!hasPasscode(cfg)) log("Set a passcode on the PC with /phone setup.");
}));
