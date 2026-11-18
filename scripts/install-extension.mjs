// Copies the pi extension into every pi agent directory found on this machine,
// so any pi session picks it up automatically.
//
// pi reads extensions from <agent dir>/extensions. The agent dir is
// PI_CODING_AGENT_DIR if set, otherwise ~/.pi/agent. Some installs (the
// pi-harness launcher) point it at ~/.pi-harness/agent, so we check both.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "extension", "connect-pi.ts");

if (!existsSync(src)) {
	console.error("Cannot find extension/connect-pi.ts");
	process.exit(1);
}

export function agentDirs() {
	const candidates = [process.env.PI_CODING_AGENT_DIR, join(homedir(), ".pi-harness", "agent"), join(homedir(), ".pi", "agent")];
	const seen = new Set();
	const found = [];
	for (const dir of candidates) {
		if (!dir || seen.has(dir)) continue;
		seen.add(dir);
		if (existsSync(dir)) found.push(dir);
	}
	// nothing exists yet: fall back to the default so a fresh machine still works
	return found.length ? found : [join(homedir(), ".pi", "agent")];
}

const body = readFileSync(src, "utf8");
for (const agentDir of agentDirs()) {
	const dir = join(agentDir, "extensions");
	const dest = join(dir, "connect-pi.ts");
	mkdirSync(dir, { recursive: true });
	if (existsSync(dest) && readFileSync(dest, "utf8") === body) {
		console.log("  up to date   " + dest);
	} else {
		copyFileSync(src, dest);
		console.log("  installed    " + dest);
	}
}
console.log("\n  Restart any open pi session (or run /reload inside it) to activate it.");
