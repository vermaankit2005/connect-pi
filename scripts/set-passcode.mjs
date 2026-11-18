// Set (or change) the passcode your phone uses to log in.
//   node scripts/set-passcode.mjs           -> asks you
//   node scripts/set-passcode.mjs 482103    -> sets it directly
//
// Six digits, because the phone app enters it on a lock-screen keypad.

import { createInterface } from "node:readline/promises";
import { ensureConfig, setPasscode } from "../server/config.js";

export const PASSCODE_RE = /^\d{6}$/;

const cfg = ensureConfig();
let passcode = process.argv[2];

if (!passcode) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	passcode = (await rl.question("Choose a 6-digit passcode for your phone: ")).trim();
	rl.close();
}

if (!PASSCODE_RE.test(passcode)) {
	console.error("\nThat needs to be exactly 6 digits, nothing else.\n");
	process.exit(1);
}

setPasscode(cfg, passcode);
console.log("\nPasscode set. Any phone that was already logged in will need to log in again.\n");
