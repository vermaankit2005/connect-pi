import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

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
		const ctx = uiContext([folder, "123456", "123456"], [false]);
		await control.handlePhoneCommand("setup", ctx);
		const cfg = config.loadConfig();
		assert.deepEqual(cfg.roots, [await control.validateFolder(folder)]);
		assert.equal(config.hasPasscode(cfg), true);
		assert.equal(cfg.allowLan, false);
		assert(!JSON.stringify(cfg).includes("123456"));
		assert(!ctx.messages.join().includes("123456"));
		assert((await readFile(join(sandbox, "agent", "extensions", "connect-pi.ts"), "utf8")).includes("export { default }"));
	});
	await t.test("folder validation rejects files and relative paths", async () => {
		await assert.rejects(control.validateFolder("relative"), /full path/);
		await assert.rejects(control.validateFolder(config.CONFIG_PATH), /not a file/);
	});
	await t.test("start is idempotent; control endpoints reject unauthenticated requests", async () => {
		const probe = net.createServer();
		await new Promise((done) => probe.listen(0, "127.0.0.1", done));
		const port = probe.address().port;
		await new Promise((done) => probe.close(done));
		const cfg = config.loadConfig(); cfg.port = port; config.saveConfig(cfg);
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
	await t.test("passcode changes restart the bridge and revoke old phone logins", async () => {
		const cfg = config.loadConfig(); config.issueToken(cfg, "test phone");
		const pid = (await control.localStatus()).pid;
		await control.handlePhoneCommand("passcode", uiContext(["654321", "654321"], [true]));
		assert.equal(config.loadConfig().tokens.length, 0);
		assert(config.verifyPasscode(config.loadConfig(), "654321"));
		assert.notEqual((await control.localStatus()).pid, pid);
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
