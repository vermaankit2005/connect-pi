// Shared by the Pi slash command and the terminal CLI. Importing this module
// starts nothing and changes no settings.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONFIG_PATH, controlPort, ensureConfig, hasPasscode, loadConfig, saveConfig, setPasscode, validPasscode } from "./config.js";
import { detectPi } from "./sessions.js";
import { tailscaleStatus } from "./tailscale.js";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PHONE_COMMANDS = ["setup", "start", "stop", "restart", "status", "url", "doctor", "folders", "passcode", "desktop", "help"];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const LOG_PATH = join(dirname(CONFIG_PATH), "connect-pi-runtime", "bridge.log");

function controlRequest(cfg, command, options = {}) {
	return fetch(`http://127.0.0.1:${controlPort(cfg)}/api/local/${command}`, {
		...options, redirect: "error",
		headers: { "x-connect-pi-token": cfg.agentToken, ...options.headers },
		signal: AbortSignal.timeout(6500),
	});
}

export async function localStatus(cfg = loadConfig()) {
	if (!cfg) return null;
	let response;
	try {
		response = await controlRequest(cfg, "status");
	} catch (error) {
		if (error.cause?.code === "ECONNREFUSED") return null;
		throw new Error(`Cannot reach local control on port ${controlPort(cfg)}. ${error.cause?.code || error.message}`);
	}
	if (!response.ok) throw new Error("The local control port is occupied. Close an older Connect Pi instance or choose another port.");
	const data = await response.json();
	if (data.service !== "connect-pi") throw new Error("This port belongs to another service.");
	return data;
}

export async function startBridge() {
	const cfg = loadConfig();
	if (!cfg || !hasPasscode(cfg)) throw new Error("Run /phone setup first to choose a folder and passcode.");
	const existing = await localStatus(cfg);
	if (existing) return existing;
	if (!detectPi().ok) throw new Error("pi was not found. Install pi on this PC, or set PI_CLI to its cli.js path.");
	mkdirSync(dirname(LOG_PATH), { recursive: true });
	const child = spawn(process.execPath, [join(PACKAGE_ROOT, "server", "index.js")], {
		cwd: PACKAGE_ROOT,
		env: { ...process.env, CONNECT_PI_CONFIG: CONFIG_PATH, CONNECT_PI_PORT: String(cfg.port), CONNECT_PI_LOG: LOG_PATH },
		detached: true, windowsHide: true, stdio: "ignore",
	});
	let failed = null;
	child.on("error", (error) => { failed = error; });
	child.unref();
	for (let attempt = 0; attempt < 120; attempt++) {
		if (failed || child.exitCode !== null || child.signalCode !== null) {
			let detail = failed?.message || `exit ${child.exitCode ?? child.signalCode}`;
			try { detail += "\n" + readFileSync(LOG_PATH, "utf8").trim().split(/\r?\n/).slice(-4).join("\n"); }
			catch { /* the process may have exited before opening its log */ }
			throw new Error(`Bridge could not start (${detail}). See ${LOG_PATH}`);
		}
		await sleep(250);
		try { const status = await localStatus(cfg); if (status) return status; }
		catch { /* startup may be configuring Tailscale before serving HTTP */ }
	}
	throw new Error(`Startup is taking longer than expected. Run /phone status; diagnostics are in ${LOG_PATH}`);
}

export async function stopBridge() {
	const cfg = loadConfig();
	if (!await localStatus(cfg)) return false;
	const response = await controlRequest(cfg, "stop", { method: "POST" });
	if (!response.ok) throw new Error("The bridge refused the stop request.");
	for (let i = 0; i < 80; i++) {
		await sleep(250);
		try { if (!await localStatus(cfg)) return true; }
		catch { /* Tailscale cleanup can temporarily block the event loop. */ }
	}
	throw new Error("Shutdown is still in progress. Run /phone status again.");
}

export async function runForeground() {
	const cfg = loadConfig();
	if (!cfg || !hasPasscode(cfg)) throw new Error("Run /phone setup or npm run setup first.");
	const existing = await localStatus(cfg);
	if (existing) {
		console.log(connectionText(existing));
		return;
	}
	await import("./index.js");
}

export async function rotatePasscode(passcode) {
	if (!validPasscode(passcode)) throw new Error("Use exactly 6 digits.");
	const cfg = ensureConfig();
	if (!await localStatus(cfg)) {
		setPasscode(ensureConfig(), passcode);
		return;
	}
	const response = await controlRequest(cfg, "passcode", {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode }),
	});
	if (!(response.ok && (await response.json()).rotated)) throw new Error("The running bridge did not confirm the passcode change.");
}

export async function validateFolder(value) {
	if (!value || !isAbsolute(value)) throw new Error("Choose an existing folder using its full path.");
	const path = await realpath(value);
	if (!(await stat(path)).isDirectory()) throw new Error("Choose a folder, not a file.");
	return path;
}

const notify = (ctx, message, kind = "info") => ctx.ui.notify(message, kind);
function interactive(ctx) {
	if (!ctx.hasUI) throw new Error("This command needs an interactive pi session. Use /phone help for terminal alternatives.");
}
async function choosePasscode(ctx) {
	const first = await ctx.ui.input("Choose a 6-digit phone passcode (not sent to the model)");
	if (first === undefined) return null;
	if (!validPasscode(first)) throw new Error("Use exactly 6 digits. Passcode unchanged.");
	const second = await ctx.ui.input("Enter the same passcode again");
	if (second === undefined) return null;
	if (first !== second) throw new Error("The passcodes did not match. Passcode unchanged.");
	return first;
}

async function pauseForSettings(ctx) {
	const running = await localStatus();
	if (running && !await ctx.ui.confirm("Restart phone connection?", "Changing these settings stops phone-started pi sessions and disconnects phones. Saved history stays.")) return null;
	if (running) await stopBridge();
	return { wasRunning: Boolean(running) };
}

// Retire a legacy copied extension only when its identifying markers match.
// Keep the file as a backup rather than deleting possibly customized code.
export function isPackageRegistered(agentDir) {
	try {
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		return (settings.packages || []).some((entry) => {
			const source = typeof entry === "string" ? entry : entry.source;
			return source === PACKAGE_ROOT || source === pathToFileURL(PACKAGE_ROOT).href || /github\.com[/:]vermaankit2005\/connect-pi(?:\.git)?(?:@[^\s]+)?\/?$/.test(source || "");
		});
	} catch { return false; }
}

function retireLegacyCopy() {
	const file = join(detectPi().agentDir, "extensions", "connect-pi.ts");
	if (!existsSync(file)) return false;
	const body = readFileSync(file, "utf8");
	const legacy = (body.startsWith("// connect-pi — lets your phone drive this pi session.") && body.includes('pi.registerCommand("phone"')) ||
		(isPackageRegistered(detectPi().agentDir) && body.startsWith("// connect-pi launcher —") && body.includes('export { default } from'));
	if (!legacy) return false;
	renameSync(file, `${file}.${Date.now()}.disabled`);
	return true;
}

function ensureSessionExtension() {
	const agentDir = detectPi().agentDir;
	if (isPackageRegistered(agentDir)) return;
	const folder = join(agentDir, "extensions");
	mkdirSync(folder, { recursive: true });
	const target = join(folder, "connect-pi.ts");
	if (existsSync(target)) {
		const body = readFileSync(target, "utf8");
		if (!body.startsWith("// connect-pi launcher —")) throw new Error("An existing connect-pi.ts extension needs review before it can be replaced.");
	}
	writeFileSync(target, `// connect-pi launcher — keep the app folder in this location.\nexport { default } from ${JSON.stringify(pathToFileURL(join(PACKAGE_ROOT, "extension", "connect-pi.ts")).href)};\n`);
}

export async function handlePhoneCommand(args, ctx) {
	let command = String(args || "").trim().toLowerCase();
	if (!command && ctx.hasUI) command = await ctx.ui.select("connect-pi — your pi on your phone", PHONE_COMMANDS);
	if (!command) command = "status";
	if (!PHONE_COMMANDS.includes(command)) throw new Error("Unknown command. Use /phone help.");
	if (command === "help") {
		return notify(ctx, "Commands: " + PHONE_COMMANDS.map((c) => `/phone ${c}`).join(", ") + "\n/connect-pi is an alias.\nTerminal: npm run setup; npm run phone -- start|stop|restart|status|url|doctor.\nPackage install: pi install git:github.com/vermaankit2005/connect-pi\nUpdate/remove: use pi update --extensions / pi remove with the same package source.");
	}
	if (command === "setup") {
		interactive(ctx);
		const folderInput = await ctx.ui.input("Which existing project folder should your phone browse?", ctx.cwd);
		if (folderInput === undefined) return;
		const folder = await validateFolder(folderInput.trim() || ctx.cwd);
		const old = loadConfig();
		const pin = old && hasPasscode(old) ? null : await choosePasscode(ctx);
		if ((!old || !hasPasscode(old)) && pin === null) return;
		const startNow = await ctx.ui.confirm("Start phone connection now?", "Runs on this PC until /phone stop, even if you close this pi session. Keep your PC awake. Tailscale must be connected on both devices.");
		const paused = await pauseForSettings(ctx);
		if (!paused) return;
		const cfg = ensureConfig();
		cfg.roots = [folder];
		if (pin) setPasscode(cfg, pin); else saveConfig(cfg);
		// Direct/local installs need a forwarding extension for phone-launched
		// sessions too. Managed Pi package installs already load it globally.
		const migrated = retireLegacyCopy();
		ensureSessionExtension();
		notify(ctx, `Setup saved. Folder: ${folder}${migrated ? "\nOld copied extension backed up. Run /reload after setup." : ""}`);
		if (startNow) return notify(ctx, connectionText(await startBridge()));
		return notify(ctx, "Ready. Use /phone start when you want to connect your phone.");
	}
	if (command === "passcode") {
		interactive(ctx);
		if (!loadConfig()) throw new Error("Run /phone setup first.");
		const pin = await choosePasscode(ctx);
		if (pin === null) return;
		if (await localStatus() && !await ctx.ui.confirm("Change phone passcode?", "Phones will be signed out. Pi sessions will keep running.")) return;
		await rotatePasscode(pin);
		return notify(ctx, "Passcode changed. Phones must unlock again.");
	}
	if (command === "folders") {
		interactive(ctx);
		if (!loadConfig()) throw new Error("Run /phone setup first.");
		const value = await ctx.ui.input("Folders available on your phone", loadConfig().roots[0]);
		if (value === undefined) return;
		const folder = await validateFolder(value.trim());
		const paused = await pauseForSettings(ctx);
		if (!paused) return;
		const cfg = ensureConfig();
		cfg.roots = [folder];
		saveConfig(cfg);
		if (paused.wasRunning) await startBridge();
		return notify(ctx, `Folder saved: ${folder}`);
	}
	if (command === "desktop") {
		if (process.platform !== "win32") throw new Error("Desktop shortcuts are Windows-only. Use /phone start instead.");
		const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(PACKAGE_ROOT, "scripts", "install-desktop-shortcuts.ps1")], { encoding: "utf8", windowsHide: true });
		if (result.status !== 0) throw new Error(result.stderr || "Could not create the desktop shortcut.");
		return notify(ctx, "Desktop shortcut created: pi on my phone.");
	}
	if (command === "stop") return notify(ctx, await stopBridge() ? "Phone connection stopped. Saved conversations remain." : "Phone connection is already stopped.");
	if (command === "restart") { await stopBridge(); return notify(ctx, connectionText(await startBridge())); }
	if (command === "start") return notify(ctx, connectionText(await startBridge()));
	let status, statusError;
	try { status = await localStatus(); }
	catch (error) { if (command !== "doctor") throw error; statusError = error.message; }
	if (command === "doctor") {
		const pi = detectPi(), cfg = loadConfig();
		return notify(ctx, [
			`Node: ${process.version}`, `pi: ${pi.ok ? "found" : "NOT FOUND"}`, `Platform: ${process.platform} (Windows is the supported desktop setup)`,
			`Passcode: ${cfg && hasPasscode(cfg) ? "set" : "NOT SET — /phone setup"}`, `Folders: ${cfg?.roots?.join(", ") || "not set"}`,
			`Bridge: ${statusError || (status ? "running" : "stopped")}`, `Tailscale: ${status?.url || status?.problem || (() => { const result = tailscaleStatus(); return result.url || result.problem; })()}`,
			`Settings: ${CONFIG_PATH}`, `Logs: ${LOG_PATH}`,
		].join("\n"));
	}
	return notify(ctx, status ? connectionText(status) : "Phone connection is stopped. Use /phone setup, then /phone start.");
}

export function connectionText(status) {
	const remote = status.url ? `Open on your phone: ${status.url}` : `${status.problem || "No verified Tailscale HTTPS rule."} Use /phone doctor after checking Tailscale.`;
	return `Phone connection running on port ${status.port}.\n${remote}\nLocal PC preview: http://localhost:${status.port}\nStop with /phone stop.`;
}
