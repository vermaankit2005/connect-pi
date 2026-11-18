// One-shot setup: passcode, extension, icons, and a printout of what to do next.

import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, ensureConfig, hasPasscode, setPasscode } from "../server/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const run = (file) => execFileSync(process.execPath, [join(here, file)], { stdio: "inherit" });

console.log("\n  connect-pi setup\n  ================\n");

const cfg = ensureConfig();

if (!hasPasscode(cfg)) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let pass = "";
	while (!/^\d{6}$/.test(pass)) {
		pass = (await rl.question("  Choose a 6-digit passcode for your phone: ")).trim();
		if (!/^\d{6}$/.test(pass)) console.log("  Exactly 6 digits, please.");
	}
	rl.close();
	setPasscode(cfg, pass);
	console.log("  Passcode saved.\n");
} else {
	console.log("  Passcode already set (run `npm run passcode` to change it).\n");
}

run("make-icons.mjs");
run("install-extension.mjs");

const tailscaleIp = Object.values(networkInterfaces())
	.flat()
	.find((ni) => ni && ni.family === "IPv4" && !ni.internal && ni.address.startsWith("100."))?.address;

console.log("\n  Done. Next:\n");
console.log("   1. Start the bridge:      npm start");
console.log("   2. Open pi in a project:  pi");
console.log("   3. On your phone, open:   " + (tailscaleIp ? `http://${tailscaleIp}:${cfg.port}` : "(see the address printed by npm start)"));
if (!tailscaleIp) {
	console.log("\n  Tailscale is not running yet. Install it on this PC and your phone,");
	console.log("  sign into both with the same account, then re-run this to get the address.");
}
console.log("\n  Config lives at " + CONFIG_PATH + "\n");
