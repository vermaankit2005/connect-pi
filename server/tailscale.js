// Tailscale is the only way in, so the bridge owns the door.
//
// `tailscale serve` is what points the machine's https name at this process.
// Turning it on when the bridge starts and off again when it stops is what
// makes "no window means nothing is listening" literally true, rather than
// leaving an https address that answers with an error.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const CANDIDATES = ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"];

function cli() {
	for (const c of CANDIDATES) {
		if (c.includes("\\")) {
			if (existsSync(c)) return c;
			continue;
		}
		// bare name: only usable if it is really on PATH
		const probe = spawnSync(c, ["version"], { encoding: "utf8", windowsHide: true });
		if (!probe.error) return c;
	}
	return null;
}

const run = (exe, args) => execFileSync(exe, args, { encoding: "utf8", windowsHide: true, timeout: 15000 });

/** This machine's https name on the tailnet, or null if Tailscale is not up. */
export function tailscaleUrl() {
	const exe = cli();
	if (!exe) return null;
	try {
		const status = JSON.parse(run(exe, ["status", "--json"]));
		if (status.BackendState !== "Running") return null;
		const name = status.Self?.DNSName;
		return name ? `https://${name.replace(/\.$/, "")}` : null;
	} catch {
		return null;
	}
}

// Only the process that opened the door is allowed to close it. Without this, a
// second bridge that fails to bind the port still runs its exit handler on the
// way out and shuts off the serve belonging to the one that is actually
// running - which is exactly what happened the first time this was tested.
let weOpenedIt = false;

/** Point the tailnet https name at this port. Returns the url, or null. */
export function serveOn(port) {
	const exe = cli();
	if (!exe) return null;
	try {
		const current = run(exe, ["serve", "status"]);
		if (!current.includes(`127.0.0.1:${port}`)) run(exe, ["serve", "--bg", String(port)]);
		weOpenedIt = true;
		return tailscaleUrl();
	} catch {
		return null;
	}
}

/**
 * Close the door. Synchronous on purpose: this runs from process exit handlers,
 * where a promise would never be given the chance to settle.
 */
export function serveOff() {
	if (!weOpenedIt) return false;
	const exe = cli();
	if (!exe) return false;
	try {
		run(exe, ["serve", "--bg", "off"]);
		return true;
	} catch {
		try {
			run(exe, ["serve", "reset"]);
			return true;
		} catch {
			return false;
		}
	}
}
