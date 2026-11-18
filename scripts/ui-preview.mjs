// Isolated UI fixture: no PC credentials, real sessions, or model requests.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const root = fileURLToPath(new URL("../web/", import.meta.url));
const now = Date.now();
const agents = [{ id: "preview", piSessionId: "hello", name: "Hello", cwd: "D:/Projects/demo", cwdName: "demo", connectedAt: now, thinking: "high", isStreaming: false }];
const sessions = [{ id: "demo", title: "Getting started", cwd: "D:/Projects/demo", cwdName: "demo", updatedAt: now, userTurns: 1, bytes: 100, canResume: true }];
const events = [
 { k: "user", id: "question", blocks: [{ type: "text", text: "Hello" }] },
 { k: "assistant", id: "reply", blocks: [{ type: "text", text: "Hey! What can I help you with?" }] },
];

const server = http.createServer(async (req, res) => {
	const path = new URL(req.url, "http://localhost").pathname;
	if (path.startsWith("/api/")) {
		let data = {};
		if (path === "/api/auth/state") data = { hasPasscode: true, canUsePasskey: false };
		if (path === "/api/history") data = { sessions };
		if (path === "/api/folders") data = { roots: [{ path: "D:/Projects", name: "Projects", exists: true }] , path: "D:/Projects", name: "Projects", folders: [{ name: "connect-pi", path: "D:/Projects/connect-pi" }], parent: null };
		if (path === "/api/sessions") data = { id: "preview" };
		res.writeHead(200, { "Content-Type": "application/json" });
		return res.end(JSON.stringify(data));
	}
	const file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
	if (!file.startsWith(resolve(root) + sep)) { res.writeHead(403); return res.end(); }
	try {
		let content = await readFile(file);
		if (path === "/" || path === "/index.html") content = content.toString().replace("<head>", '<head><script>localStorage.setItem("connect-pi.token","preview");localStorage.setItem("connect-pi.theme","dark");</script>');
		res.writeHead(200, { "Content-Type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" })[extname(file)] || "text/plain", "Cache-Control": "no-store" });
		res.end(content);
	} catch { res.writeHead(404); res.end(); }
});
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
	const send = (data) => ws.send(JSON.stringify(data));
	send({ t: "agents", agents });
	send({ t: "history", sessions });
	ws.on("message", (raw) => {
		const message = JSON.parse(raw);
		if (message.t === "attach") send({ t: "snapshot", agentId: "preview", info: agents[0], state: { thinking: agents[0].thinking }, events });
		if (message.t === "thinking") {
			agents[0].thinking = message.level;
			send({ t: "state", agentId: "preview", state: { thinking: message.level } });
		}
		if (message.t === "prompt") send({ t: "event", agentId: "preview", e: { k: "user", id: String(Date.now()), blocks: [{ type: "text", text: message.text }] } });
	});
});
server.listen(4318, "127.0.0.1", () => console.log("UI fixture: http://127.0.0.1:4318 (sample data only)"));
