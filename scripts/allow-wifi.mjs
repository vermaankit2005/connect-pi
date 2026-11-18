// Turn home-network access on or off.
//
//   npm run wifi          show what it is set to
//   npm run wifi on       let devices on your home WiFi reach the bridge
//   npm run wifi off      back to this PC and Tailscale only
//
// This only ever opens the bridge to private addresses (192.168.x, 10.x,
// 172.16-31.x). Those cannot be routed from the internet, so this never exposes
// anything publicly. It does mean every device in your house can reach the
// login screen — they still need your passcode or fingerprint to get in.

import { networkInterfaces } from "node:os";
import { ensureConfig, saveConfig } from "../server/config.js";
import { isPrivateLan } from "../server/net-guard.js";

const cfg = ensureConfig();
const arg = (process.argv[2] || "").toLowerCase();

const lanAddresses = () =>
	Object.values(networkInterfaces())
		.flat()
		.filter((ni) => ni && ni.family === "IPv4" && !ni.internal && isPrivateLan(ni.address))
		.map((ni) => ni.address);

if (!arg) {
	console.log(`\n  Home network access is currently ${cfg.allowLan ? "ON" : "OFF"}.`);
	console.log(cfg.allowLan ? "  Devices on your home WiFi can reach the bridge." : "  Only this PC and Tailscale can reach the bridge.");
	console.log("\n  Change it with:  npm run wifi on   |   npm run wifi off\n");
	process.exit(0);
}

if (arg !== "on" && arg !== "off") {
	console.error('\n  Say "on" or "off".  e.g.  npm run wifi on\n');
	process.exit(1);
}

cfg.allowLan = arg === "on";
saveConfig(cfg);

console.log("");
if (cfg.allowLan) {
	console.log("  Home network access is now ON.");
	const addrs = lanAddresses();
	if (addrs.length) {
		console.log("\n  On your home WiFi, open this on your phone:");
		for (const a of addrs) console.log(`      http://${a}:${cfg.port}`);
	}
	console.log("\n  Only devices in your house can reach it. The internet still cannot.");
	console.log("  Everyone still needs your passcode or fingerprint to get in.");
} else {
	console.log("  Home network access is now OFF.");
	console.log("  Only this PC and Tailscale can reach the bridge.");
}
console.log("\n  The running bridge picks this up within a couple of seconds — no restart needed.\n");
