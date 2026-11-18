// One-shot setup: passcode, extension, icons, and a printout of what to do next.

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localStatus, validateFolder } from "../server/phone-control.js";
import { existsSync } from "node:fs";
import { CONFIG_PATH, ensureConfig, hasPasscode, setPasscode, saveConfig } from "../server/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const run = (file) => execFileSync(process.execPath, [join(here, file)], { stdio: "inherit" });

console.log("\n  connect-pi setup\n  ================\n");

if (await localStatus()) throw new Error("Stop Connect Pi with /phone stop before running manual setup.");
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

const folders = createInterface({ input: process.stdin, output: process.stdout });
const defaultFolder = cfg.roots?.find((path) => existsSync(path)) || process.cwd();
while (true) {
    const answer = await folders.question(`  Project folder your phone should browse [${defaultFolder}]: `);
    try { cfg.roots = [await validateFolder(answer.trim() || defaultFolder)]; break; }
    catch (error) { console.log(`  ${error.message}`); }
}
folders.close();
saveConfig(cfg);

run("make-icons.mjs");
run("install-extension.mjs");

console.log("\n  Start with npm start, then open the Tailscale HTTPS URL it prints.\n");
console.log("\n  Config lives at " + CONFIG_PATH + "\n");
