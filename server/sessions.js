// Starting and stopping pi sessions on behalf of the phone.
//
// We spawn `pi --mode rpc` in the chosen folder. Nothing appears on screen. The
// connect-pi extension loads inside that process exactly as it does in a normal
// desktop session, and registers itself with the bridge on its own — so we do
// not have to speak pi's protocol here at all, we just manage the process.
//
// pi is launched with its own agent directory, so it uses the login you
// already have on this PC. No keys are handled here.

import { randomUUID } from "node:crypto";
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_CHILDREN = 6;

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
		this.outcomes = new Map();
		this.onLog = onLog || (() => {});
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
		if (this.children.size >= MAX_CHILDREN) throw new Error("Close a phone-started session before starting another.");
		if (resume && this.list().some((session) => session.resumed?.id === resume.id)) throw new Error("This conversation is already opening or running.");
		if (!this.pi.ok) throw new Error("Could not find pi on this PC. Install it (npm i -g @earendil-works/pi-coding-agent) or set PI_CLI to its cli.js.");
		// without this, spawn fails half-silently and the phone waits for a
		// session that is never coming
		if (!existsSync(folder) || !statSync(folder).isDirectory()) {
			throw new Error(`That folder does not exist: ${folder}`);
		}

		const id = randomUUID();
		const env = { ...process.env, CONNECT_PI_LAUNCH_ID: id, PI_CODING_AGENT_DIR: this.pi.agentDir };
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

		const rec = { child, folder, startedAt: Date.now(), output: [], resumed: resume };
		this.children.set(id, rec);

		const keep = (buf) => {
			rec.output = [(rec.output.join("") + String(buf)).slice(-4096)];
		};
		child.stdout.on("data", () => {}); // Pi RPC writes protocol lines here.
		child.stderr.on("data", keep);
		const finished = (message) => {
			if (this.children.get(id) !== rec) return;
			this.children.delete(id);
			this.outcomes.set(id, { status: rec.stopping ? "stopped" : "exited", message });
			if (this.outcomes.size > 40) this.outcomes.delete(this.outcomes.keys().next().value);
			this.updateKeepAwake();
		};
		child.on("close", (code) => {
			this.onLog(`session ended: ${basename(folder)} (${code ?? "killed"})`);
			if (rec.output.length) this.onLog(`Pi diagnostics: ${rec.output.join("").slice(-4096)}`);
			finished(code === 0 ? "Pi closed the session." : `Pi exited ${code == null ? "unexpectedly" : `with code ${code}`}. Check /phone doctor on your PC.`);
		});
		child.on("error", (error) => {
			this.onLog(`Could not launch Pi: ${error.message}`);
			finished("Pi could not start. Check /phone doctor on your PC.");
		});

		this.onLog(`session ${resume ? "resumed" : "started"}: ${folder} (pid ${child.pid})`);
		this.updateKeepAwake();
		return { id, folder };
	}

	stop(id) {
		const rec = this.children.get(id);
		if (!rec) return false;
		if (rec.stopping) return true;
		rec.stopping = rec.child.kill();
		return rec.stopping;
	}

	stopAll() {
		for (const id of this.children.keys()) this.stop(id);
	}

	status(id) {
		const rec = this.children.get(id);
		if (rec) return { status: rec.stopping ? "stopping" : "starting" };
		return this.outcomes.get(id) || { status: "unknown" };
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
			const hold = this.keepAwake;
			const clear = () => { if (this.keepAwake === hold) this.keepAwake = null; };
			hold.once("exit", clear);
			hold.once("error", clear);
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

/** Invoke the Windows URI handler directly and put the exact handoff on the PC clipboard. */
export async function openInWarp(folder, file) {
	if (process.platform !== "win32") throw new Error("Opening Warp from your phone is available on Windows.");
	const url = new URL("warp://action/new_tab");
	url.searchParams.set("path", folder);
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"$start = New-Object System.Diagnostics.ProcessStartInfo",
		"$start.FileName = $env:CONNECT_PI_WARP_URI",
		"$start.UseShellExecute = $true",
		"[System.Diagnostics.Process]::Start($start) | Out-Null",
		"Set-Clipboard -Value $env:CONNECT_PI_WARP_COMMAND",
	].join("\n");
	const clipboard = file ? `pi --session '${file.replace(/'/g, "''")}'` : "pi";
	await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
		env: { ...process.env, CONNECT_PI_WARP_URI: url.href, CONNECT_PI_WARP_COMMAND: clipboard },
		timeout: 8000, windowsHide: true,
	}).catch(() => { throw new Error("Could not open Warp or copy the Pi command to the PC clipboard. Check that Warp is installed."); });
	return { opened: true, exact: Boolean(file) };
}

export async function changedFiles(folder) {
	const git = (args) => run("git", ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
		cwd: folder, timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
	});
	const [{ stdout: status }, { stdout: diff }] = await Promise.all([
		git(["status", "--short", "--untracked-files=normal", "--", "."]),
		git(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", "."]).catch((error) => {
			if (!/ambiguous argument 'HEAD'|bad revision 'HEAD'/.test(error.stderr || "")) throw error;
			return git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", "."]);
		}),
	]).catch((error) => {
		throw new Error(error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "This diff is too large to preview. Open it on your PC." : "Could not read Git changes. Check that Git and a repository are available on the PC.");
	});
	return { status, diff: diff.slice(0, 60_000), truncated: diff.length > 60_000 };
}
