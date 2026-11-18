// Loopback-only UI fixture. It never uses desktop credentials or runs a model.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const root = fileURLToPath(new URL("../web/", import.meta.url));
const port = Number(process.env.CONNECT_PI_PREVIEW_PORT || 4318);
const now = Date.now();
const agents = [
	{ id: "preview", piSessionId: "hello", name: "Hello", cwd: "D:/Projects/demo", cwdName: "demo", connectedAt: now, thinking: "high", isStreaming: false },
	{ id: "other", piSessionId: "other", name: "Other chat", cwd: "D:/Projects/other", cwdName: "other", connectedAt: now - 100, thinking: "medium", isStreaming: false },
];
const sessions = [{ id: "demo", title: "Getting started", cwd: "D:/Projects/demo", cwdName: "demo", updatedAt: now, userTurns: 1, bytes: 100, canResume: true }];
const events = new Map([["preview", [
	{ k: "user", id: "question", blocks: [{ type: "text", text: "Hello" }] },
	{ k: "assistant", id: "reply", blocks: [{ type: "text", text: "Hey! What can I help you with?" }] },
]], ["other", []]]);
const saved = [
	{ k: "user", id: "saved", blocks: [{ type: "text", text: "Show me a saved message." }] },
];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".ttf": "font/ttf", ".webmanifest": "application/manifest+json" };
const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	const path = url.pathname;
	if (path.startsWith("/api/")) {
		let data = { ok: true };
		if (path === "/api/auth/state") data = { hasPasscode: true, canUsePasskey: false };
		if (path === "/api/history") data = { sessions };
		if (path === "/api/history/transcript") {
			const query = url.searchParams.get("search").toLowerCase();
			data = { events: saved.filter((event) => event.blocks[0].text.toLowerCase().includes(query)), before: null };
		}
		if (path === "/api/folders") data = { roots: [{ path: "D:/Projects", name: "Projects", exists: true }], path: "D:/Projects", name: "Projects", folders: [{ name: "demo", path: "D:/Projects/demo" }], parent: null };
		if (path === "/api/sessions") data = { id: "preview" };
		res.writeHead(200, { "Content-Type": "application/json" });
		return res.end(JSON.stringify(data));
	}
	const file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
	if (!file.startsWith(resolve(root) + sep)) { res.writeHead(403); return res.end(); }
	try {
		const asset = path === "/vendor/markdown-it.js" ? new URL("../node_modules/markdown-it/dist/markdown-it.min.js", import.meta.url) : file;
		res.writeHead(200, { "Content-Type": types[extname(file)] || "text/plain", "Cache-Control": "no-store" });
		res.end(await readFile(asset));
	} catch {
		if (!res.headersSent) res.writeHead(404);
		res.end();
	}
});
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
	const send = (data) => { if (ws.readyState === 1) ws.send(JSON.stringify(data)); };
	send({ t: "agents", agents });
	send({ t: "history", sessions });
	ws.on("message", (raw) => {
		const { t, id, agentId, text, level } = JSON.parse(raw);
		const agent = agents.find((item) => item.id === agentId);
		if (!agent) return;
		if (t === "attach") send({ t: "snapshot", agentId, online: true, info: agent, state: agent, events: events.get(agentId) });
		if (t === "thinking") {
			agent.thinking = level;
			send({ t: "state", agentId, state: agent });
		}
		if (t === "prompt") {
			send({ t: "receipt", id, agentId, status: "queued" });
			if (text === "Simulate a rejected draft") {
				send({ t: "receipt", id, agentId, status: "failed", message: "Pi did not accept this draft." });
				return;
			}
			const event = { k: "user", id: String(Date.now()), promptId: id, blocks: [{ type: "text", text }] };
			events.get(agentId).push(event);
			send({ t: "receipt", id, agentId, status: "accepted" });
			send({ t: "event", agentId, e: event });
			agent.isStreaming = true;
			send({ t: "state", agentId, state: agent });
		}
		if (t === "stop") {
			agent.isStreaming = false;
			send({ t: "state", agentId, state: agent });
			send({ t: "event", agentId, e: { k: "run_stopped", id: String(Date.now()), text: "Pi stopped." } });
		}
	});
});
server.listen(port, "127.0.0.1", () => console.log(`UI fixture: http://127.0.0.1:${port} (sample data only)`));
