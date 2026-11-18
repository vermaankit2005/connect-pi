// Installs and exercises the package in an isolated Pi profile. No model call,
// personal credentials, real project history, or Tailscale changes are involved.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { detectPi } from "../server/sessions.js";

const pi = detectPi();
assert(pi.ok, "Install pi before running the package smoke test.");
const sandbox = await mkdtemp(join(tmpdir(), "connect-pi-package-"));
const agentDir = join(sandbox, "agent");
const project = join(sandbox, "project");
await mkdir(agentDir); await mkdir(project);
const configFile = join(sandbox, "config.json");
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, CONNECT_PI_CONFIG: configFile, CONNECT_PI_TAILSCALE: "off" };
const source = process.env.CONNECT_PI_PACKAGE_SOURCE || resolve(".");
let child;
let stderr = "";
const pending = new Map();
const notices = [];
let answers = [project, "123456", "123456"];
let modelRuns = 0;
try {
	const manual = source === "manual";
	const installed = spawnSync(process.execPath, manual ? [resolve("scripts/install-extension.mjs")] : [pi.cli, "install", source], { env, cwd: project, encoding: "utf8", timeout: 120000, windowsHide: true });
	assert.equal(installed.status, 0, installed.stderr || installed.stdout);
	console.log("Package installed into an isolated pi profile.");
	const probe = net.createServer();
	await new Promise((done) => probe.listen(0, "127.0.0.1", done));
	const port = probe.address().port;
	await new Promise((done) => probe.close(done));
	child = spawn(process.execPath, [pi.cli, "--mode", "rpc", "--no-session"], { env, cwd: project, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	child.stderr.on("data", (buf) => { stderr += buf; });
	let buffer = "";
	child.stdout.on("data", (buf) => {
		buffer += buf;
		const lines = buffer.split("\n"); buffer = lines.pop();
		for (const line of lines) {
			let msg; try { msg = JSON.parse(line); } catch { continue; }
			if (msg.type === "agent_start") modelRuns++;
			if (msg.type === "response") pending.get(msg.id)?.(msg);
			if (msg.type !== "extension_ui_request") continue;
			if (msg.method === "notify") notices.push(msg);
			if (msg.method === "input") child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: msg.id, value: answers.shift() }) + "\n");
			if (msg.method === "confirm") child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: msg.id, confirmed: false }) + "\n");
		}
	});
	let seq = 0;
	const rpc = (type, extra = {}) => new Promise((resolveReply, reject) => {
		const id = `package-${seq++}`;
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${type}. ${stderr.slice(-500)}`)); }, 45000);
		pending.set(id, (msg) => { clearTimeout(timer); pending.delete(id); msg.success ? resolveReply(msg) : reject(new Error(msg.error)); });
		child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
	});
	const commands = (await rpc("get_commands")).data.commands;
	assert(commands.some((c) => c.name === "phone" && c.sourceInfo.origin === (manual ? "top-level" : "package")));
	assert(commands.some((c) => c.name === "connect-pi"));
	await rpc("prompt", { message: "/phone setup" });
	let cfg = JSON.parse(await readFile(configFile, "utf8"));
	assert.deepEqual(cfg.roots, [project]);
	assert(cfg.passcode.hash && !JSON.stringify(cfg).includes("123456"));
	assert(!notices.some((n) => n.notifyType === "error"), JSON.stringify(notices));
	cfg.port = port;
	await writeFile(configFile, JSON.stringify(cfg));
	await rpc("prompt", { message: "/phone start" });
	assert(notices.some((n) => n.message.includes("Phone connection running")));
	const page = await fetch(`http://127.0.0.1:${port}/`);
	assert.equal(page.status, 200);
	await rpc("prompt", { message: "/phone status" });
	await rpc("prompt", { message: "/phone url" });
	await rpc("prompt", { message: "/phone restart" });
	await rpc("prompt", { message: "/connect-pi help" });
	await rpc("prompt", { message: "/phone stop" });
	assert(!notices.some((n) => n.notifyType === "error"), JSON.stringify(notices));
	assert(!notices.some((n) => n.message.includes("123456")));
	assert.equal(modelRuns, 0, "A setup/control command unexpectedly started a model run");
	console.log("Manifest discovery, wizard, start, restart, status, URL, help and stop passed through real pi RPC; app page served. No model requests.");
} finally {
	if (child) { child.stdin.end(); const ended = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((done) => child.once("close", done)); child.kill(); await ended; }
	try {
		const cfg = JSON.parse(await readFile(configFile, "utf8"));
		await fetch(`http://127.0.0.1:${cfg.port}/api/local/stop`, { method: "POST", headers: { "x-connect-pi-token": cfg.agentToken }, signal: AbortSignal.timeout(1500) });
		await new Promise((done) => setTimeout(done, 500));
	} catch { /* bridge already stopped or setup never completed */ }
	await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
