import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";

const sandbox = await mkdtemp(join(tmpdir(), "connect-pi-control-"));
process.env.CONNECT_PI_CONFIG = join(sandbox, "config.json");
process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
process.env.CONNECT_PI_TAILSCALE = "off";
const control = await import("./phone-control.js");
const config = await import("./config.js");
const folder = join(sandbox, "projects");
await mkdir(folder);

function uiContext(inputs = [], confirms = []) {
	const messages = [];
	return { hasUI: true, cwd: folder, messages, ui: {
		input: async () => inputs.shift(), confirm: async () => confirms.shift() || false,
		notify: (message) => messages.push(message), select: async () => undefined,
	} };
}

test("phone setup, settings and controlled bridge lifecycle", async (t) => {
	t.after(async () => {
		await control.stopBridge().catch(() => {});
		await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	});
	await t.test("cancelling setup writes no settings", async () => {
		await control.handlePhoneCommand("setup", uiContext([undefined]));
		assert.equal(config.loadConfig(), null);
	});
	await t.test("invalid or mismatching passcodes leave settings unchanged", async () => {
		await assert.rejects(control.handlePhoneCommand("setup", uiContext([folder, "bad"])), /6 digits/);
		await assert.rejects(control.handlePhoneCommand("setup", uiContext([folder, "123456", "654321"])), /did not match/);
		assert.equal(config.loadConfig(), null);
	});
	await t.test("wizard saves chosen folder and a hashed passcode without displaying it", async () => {
		const extensions = join(sandbox, "agent", "extensions");
		await mkdir(extensions, { recursive: true });
		await writeFile(join(extensions, "connect-pi.ts"), '// connect-pi — lets your phone drive this pi session.\npi.registerCommand("phone", {});\n');
		const ctx = uiContext([folder, "123456", "123456"], [false]);
		await control.handlePhoneCommand("setup", ctx);
		const cfg = config.loadConfig();
		assert.deepEqual(cfg.roots, [await control.validateFolder(folder)]);
		assert.equal(config.hasPasscode(cfg), true);
		assert.equal(cfg.allowLan, undefined);
		assert(!JSON.stringify(cfg).includes("123456"));
		assert(!ctx.messages.join().includes("123456"));
		assert((await readFile(join(sandbox, "agent", "extensions", "connect-pi.ts"), "utf8")).includes("export { default }"));
		assert((await readdir(extensions)).some((name) => name.endsWith(".disabled")), "Legacy extension must be backed up, not deleted");
	});
	await t.test("folder validation rejects files and relative paths", async () => {
		await assert.rejects(control.validateFolder("relative"), /full path/);
		await assert.rejects(control.validateFolder(config.CONFIG_PATH), /not a file/);
	});
	await t.test("start is idempotent; control endpoints reject unauthenticated requests", async () => {
		const probes = [net.createServer(), net.createServer()];
		for (const probe of probes) {
			probe.listen(0, "127.0.0.1");
			await once(probe, "listening");
		}
		const [port, controlPort] = probes.map((probe) => probe.address().port);
		await Promise.all(probes.map((probe) => new Promise((done) => probe.close(done))));
		const cfg = config.loadConfig();
		Object.assign(cfg, { port, controlPort });
		config.saveConfig(cfg);
		const first = await control.startBridge();
		assert.equal(first.service, "connect-pi");
		assert.equal((await control.startBridge()).pid, first.pid);
		const forbidden = await fetch(`http://127.0.0.1:${port}/api/local/stop`, { method: "POST" });
		assert.equal(forbidden.status, 403);
		assert.equal((await control.localStatus()).pid, first.pid);
		const page = await fetch(`http://127.0.0.1:${port}/`);
		assert.equal(page.status, 200);
	});
	await t.test("cancelled change keeps a running bridge and original settings", async () => {
		const before = await readFile(config.CONFIG_PATH, "utf8");
		const pid = (await control.localStatus()).pid;
		await control.handlePhoneCommand("passcode", uiContext(["654321", "654321"], [false]));
		assert.equal(await readFile(config.CONFIG_PATH, "utf8"), before);
		assert.equal((await control.localStatus()).pid, pid);
	});
	await t.test("passcode rotation immediately revokes old logins and keeps Pi running", async () => {
		const info = await control.localStatus();
		const base = `http://127.0.0.1:${info.port}`;
		const login = (passcode) => fetch(`${base}/api/auth/passcode`, {
			method: "POST", headers: { origin: base, "content-type": "application/json" },
			body: JSON.stringify({ passcode }),
		});
		const before = await login("123456");
		assert.equal(before.status, 200);
		const cookie = before.headers.get("set-cookie");
		assert.match(cookie, /; HttpOnly; SameSite=Strict/);
		const me = () => fetch(`${base}/api/me`, { headers: { cookie: cookie.split(";")[0] } });
		assert.equal((await me()).status, 200);
		await control.handlePhoneCommand("passcode", uiContext(["654321", "654321"], [true]));
		assert.equal(config.loadConfig().tokens.length, 0);
		assert(config.verifyPasscode(config.loadConfig(), "654321"));
		assert.equal((await control.localStatus()).pid, info.pid);
		assert.equal((await me()).status, 401);
		assert.equal((await login("123456")).status, 401);
		assert.equal((await login("654321")).status, 200);
	});
	await t.test("a phone can start, attach, and stop a real Pi session", async () => {
		const info = await control.localStatus();
		const base = `http://127.0.0.1:${info.port}`;
		const request = (path, { cookie, body } = {}) => fetch(base + path, {
			method: body === undefined ? "GET" : "POST",
			headers: { origin: base, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const loggedIn = await request("/api/auth/passcode", { body: { passcode: "654321" } });
		assert.equal(loggedIn.status, 200);
		const cookie = loggedIn.headers.get("set-cookie").split(";")[0];
		assert.equal((await request("/api/history")).status, 401);
		assert.equal((await fetch(base + "/api/local/status", { headers: { "x-connect-pi-token": config.loadConfig().agentToken } })).status, 403);
		const started = await request("/api/sessions", { cookie, body: { folder } });
		assert.equal(started.status, 200);
		const { id } = await started.json();
		const socket = new WebSocket(base.replace("http", "ws") + "/app", { origin: base, headers: { cookie } });
		try {
			await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Pi did not attach within 15 seconds.")), 15_000);
				socket.once("error", (error) => { clearTimeout(timer); reject(error); });
				socket.on("message", (message) => {
					const event = JSON.parse(message);
					if (event.t === "agents" && event.agents.some((agent) => agent.id === id)) socket.send(JSON.stringify({ t: "attach", agentId: id }));
					if (event.t === "snapshot" && event.agentId === id && event.online) {
						clearTimeout(timer);
						resolve();
					}
				});
			});
			const stop = await request("/api/sessions/stop", { cookie, body: { id } });
			assert.deepEqual(await stop.json(), { stopping: true });
			const closeEvent = once(socket, "close");
			assert.equal((await request("/api/auth/lock", { cookie, body: {} })).status, 200);
			await closeEvent;
			assert.equal((await request("/api/me", { cookie })).status, 401);
		} finally { socket.close(); }
	});
	await t.test("stop shuts down only the authenticated bridge and is idempotent", async () => {
		assert.equal(await control.stopBridge(), true);
		assert.equal(await control.localStatus(), null);
		assert.equal(await control.stopBridge(), false);
	});
	await t.test("interactive setup refuses headless invocation", async () => {
		const ctx = uiContext(); ctx.hasUI = false;
		await assert.rejects(control.handlePhoneCommand("setup", ctx), /interactive pi session/);
	});
});
