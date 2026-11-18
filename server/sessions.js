// Starting and stopping pi sessions on behalf of the phone.
//
// We spawn `pi --mode rpc` in the chosen folder. Nothing appears on screen. The
// connect-pi extension loads inside that process exactly as it does in a normal
// desktop session, and registers itself with the bridge on its own — so we do
// not have to speak pi's protocol here at all, we just manage the process.
//
// pi is launched with its own agent directory, so it uses the login you
// already have on this PC. No keys are handled here.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const PKG = join("node_modules", "@earendil-works", "pi-coding-agent");
// 0.85 moved the real entry point under dist/bundle; older builds only have dist/cli.js.
const ENTRIES = [join("dist", "bundle", "cli.js"), join("dist", "cli.js")];

// The old pi-harness install, kept only so an untouched machine still works.
const HARNESS_DIR = join(homedir(), ".pi-harness");
const LAUNCHER = join(HARNESS_DIR, "pi-harness.cmd");

// pi ignores these when it has its own login, but a stray key in the
// environment would silently override it, so we always clear them.
const BLANK_ENV = ["OPENAI_API_KEY", "OPENAI_ORGANIZATION", "OPENAI_PROJECT"];

/** dist/bundle/cli.js (or dist/cli.js) inside a pi-coding-agent package dir. */
function entryIn(pkgDir) {
	for (const rel of ENTRIES) {
		const file = join(pkgDir, rel);
		if (existsSync(file)) return file;
	}
	return null;
}

/** Where `pi` lives on PATH. Returns the shim (pi.cmd on Windows), not the cli. */
function piOnPath() {
	try {
		const finder = process.platform === "win32" ? "where" : "which";
		const out = spawnSync(finder, ["pi"], { encoding: "utf8", windowsHide: true });
		return (out.stdout || "")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * Find the pi CLI. We look, in order, at an explicit override, the `pi` on your
 * PATH (this is the npm global install in practice), the usual npm global
 * prefixes, and finally the old pi-harness layout.
 */
function findCli() {
	if (process.env.PI_CLI && existsSync(process.env.PI_CLI)) return { cli: process.env.PI_CLI, source: "PI_CLI" };

	for (const shim of piOnPath()) {
		const dir = dirname(shim);
		// the npm shim names the entry outright; %dp0% is the shim's own folder
		try {
			const named = readFileSync(shim, "utf8").match(/"([^"\n]*pi-coding-agent[^"\n]*cli\.js)"/i);
			if (named) {
				const file = named[1].replace(/%~?dp0%[\\/]*/i, dir + "\\").replace(/\$basedir[\\/]*/i, dir + "/");
				if (existsSync(file)) return { cli: file, source: "PATH" };
			}
		} catch {
			// not a readable text shim (a real binary, say); fall through
		}
		const pkg = entryIn(join(dir, PKG));
		if (pkg) return { cli: pkg, source: "PATH" };
	}

	const prefixes = [
		process.env.npm_config_prefix,
		process.env.APPDATA ? join(process.env.APPDATA, "npm") : null,
		join(homedir(), "AppData", "Roaming", "npm"),
		join(homedir(), ".npm-global"),
		"/usr/local",
		"/usr",
	];
	for (const prefix of prefixes) {
		if (!prefix) continue;
		const file = entryIn(join(prefix, PKG)) || entryIn(join(prefix, "lib", PKG));
		if (file) return { cli: file, source: "npm global" };
	}

	const harness = entryIn(join(HARNESS_DIR, PKG));
	if (harness) return { cli: harness, source: "pi-harness" };

	return { cli: "", source: "none" };
}

/**
 * Which agent directory that CLI reads: credentials, settings, extensions and
 * the session history the phone lists. PI_CODING_AGENT_DIR wins, then whatever
 * the old harness launcher set, then pi's own default (~/.pi/agent).
 */
function findAgentDir(cli) {
	if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;

	if (existsSync(LAUNCHER) && cli.startsWith(HARNESS_DIR)) {
		try {
			const dir = readFileSync(LAUNCHER, "utf8").match(/set\s+"PI_CODING_AGENT_DIR=([^"]+)"/i);
			if (dir) return dir[1];
		} catch {
			// fall through to the default
		}
	}

	// pi's package.json declares its config dir (".pi" today), so read it rather
	// than hardcoding a name that could change under us again.
	let configDir = ".pi";
	try {
		// the path can come back with mixed separators, so match on either
		const slashed = cli.replace(/\\/g, "/");
		const marker = PKG.replace(/\\/g, "/");
		const pkgRoot = slashed.slice(0, slashed.indexOf(marker) + marker.length);
		const meta = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
		if (meta?.piConfig?.configDir) configDir = meta.piConfig.configDir;
	} catch {
		// default is right for every published build so far
	}
	return join(homedir(), configDir, "agent");
}

/** Work out how to start pi on this machine. */
export function detectPi() {
	const { cli, source } = findCli();
	const agentDir = findAgentDir(cli);
	return { cli, agentDir, blankEnv: BLANK_ENV, source, ok: Boolean(cli) && existsSync(cli) };
}

export class SessionLauncher {
	constructor({ onLog } = {}) {
		this.pi = detectPi();
		this.children = new Map(); // agentId -> { child, folder, startedAt, output }
		this.keepAwake = null;
		this.onLog = onLog || (() => {});
	}

	/**
	 * The id the connect-pi extension will register itself under. It builds this
	 * from the folder name and its own pid, so we can predict it here and let the
	 * phone attach to the session the moment it appears.
	 */
	static agentIdFor(folder, pid) {
		return `${basename(folder) || "pi"}-${pid}`;
	}

	list() {
		return [...this.children.entries()].map(([id, s]) => ({
			id,
			folder: s.folder,
			startedAt: s.startedAt,
			pid: s.child.pid,
			alive: s.child.exitCode === null,
			resumed: s.resumed || null,
		}));
	}

	/** What we asked pi to reopen, if this session was a resume. */
	resumedSession(agentId) {
		return this.children.get(agentId)?.resumed || null;
	}

	/**
	 * Start pi in a folder. Pass `resume` (a session id and its file path) to
	 * carry on an old conversation instead of opening a blank one.
	 *
	 * `--session <path>` reopens the exact validated file. `--resume` opens
	 * an interactive picker, which would simply hang in rpc mode.
	 */
	start(folder, { resume = null } = {}) {
		if (!this.pi.ok) throw new Error("Could not find pi on this PC. Install it (npm i -g @earendil-works/pi-coding-agent) or set PI_CLI to its cli.js.");
		// without this, spawn fails half-silently and the phone waits for a
		// session that is never coming
		if (!existsSync(folder) || !statSync(folder).isDirectory()) {
			throw new Error(`That folder does not exist: ${folder}`);
		}

		const env = { ...process.env, PI_CODING_AGENT_DIR: this.pi.agentDir };
		for (const key of this.pi.blankEnv) env[key] = "";

		const args = [this.pi.cli, "--mode", "rpc"];
		if (resume?.path) args.push("--session", resume.path);

		const child = spawn(process.execPath, args, {
			cwd: folder,
			env,
			// stdin stays open: pi in rpc mode exits the moment it closes
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		const id = SessionLauncher.agentIdFor(folder, child.pid);
		const rec = { child, folder, startedAt: Date.now(), output: [], resumed: resume };
		this.children.set(id, rec);

		const keep = (buf) => {
			rec.output.push(String(buf));
			if (rec.output.length > 40) rec.output.shift();
		};
		child.stdout.on("data", () => {}); // drain, we do not speak rpc here
		child.stderr.on("data", keep);

		child.on("exit", (code) => {
			this.onLog(`session ended: ${basename(folder)} (${code ?? "killed"})`);
			this.children.delete(id);
			this.updateKeepAwake();
		});
		child.on("error", (err) => {
			keep(err.message);
			this.children.delete(id);
			this.updateKeepAwake();
		});

		this.onLog(`session ${resume ? "resumed" : "started"}: ${folder} (pid ${child.pid})`);
		this.updateKeepAwake();
		return { id, pid: child.pid, folder, resumed: resume };
	}

	stop(id) {
		const rec = this.children.get(id);
		if (!rec) return false;
		try {
			rec.child.kill();
		} catch {}
		this.children.delete(id);
		this.updateKeepAwake();
		return true;
	}

	stopAll() {
		for (const id of [...this.children.keys()]) this.stop(id);
	}

	lastError(id) {
		return (this.children.get(id)?.output || []).join("").slice(-500);
	}

	// ------------------------------------------------------------ keep awake

	/**
	 * Hold sleep off only while sessions are running, then let go. Your normal
	 * battery behaviour is untouched when nothing is happening.
	 */
	updateKeepAwake() {
		const busy = this.children.size > 0;
		if (busy && !this.keepAwake) this.startKeepAwake();
		else if (!busy && this.keepAwake) this.stopKeepAwake();
	}

	startKeepAwake() {
		if (process.platform !== "win32") return;
		// ES_CONTINUOUS | ES_SYSTEM_REQUIRED — stay awake, but let the screen sleep
		const script = [
			"Add-Type -Name Power -Namespace Win32 -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
			"[Win32.Power]::SetThreadExecutionState(0x80000001) | Out-Null",
			"while ($true) { Start-Sleep -Seconds 60 }",
		].join("; ");
		try {
			this.keepAwake = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
				stdio: "ignore",
				windowsHide: true,
			});
			this.keepAwake.on("exit", () => {
				this.keepAwake = null;
			});
			this.onLog("holding sleep off while pi works");
		} catch {
			this.keepAwake = null;
		}
	}

	stopKeepAwake() {
		try {
			this.keepAwake?.kill();
		} catch {}
		this.keepAwake = null;
		this.onLog("released sleep hold");
	}
}

/**
 * Open a Warp tab at a folder, for taking over at the desk. Warp can be pointed
 * at a directory but cannot be told to run a command, so this drops you in the
 * right place and you run `pi --resume` yourself.
 */
export function openInWarp(folder) {
	if (process.platform !== "win32") return false;
	try {
		const url = `warp://action/new_tab?path=${folder}`;
		spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true, detached: true }).unref();
		return true;
	} catch {
		return false;
	}
}
