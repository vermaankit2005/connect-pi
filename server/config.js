// Shared config for connect-pi.
//
// Lives at ~/.connect-pi.json — a fixed spot the pi extension can always find,
// regardless of which pi install or PI_CODING_AGENT_DIR is in play.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CONFIG_PATH = process.env.CONNECT_PI_CONFIG ? resolve(process.env.CONNECT_PI_CONFIG) : join(homedir(), ".connect-pi.json");

const DEFAULT_PORT = 4317;
const DEFAULT_LOCK_MINUTES = 60;

// Where sessions started from the phone are allowed to live: the whole D drive.
// Note this is a guard against your own mistakes, not a security boundary: pi
// has no sandbox, so a session started anywhere can still reach the rest of the
// disk. Real safety comes from the network filter and the passkey.
const DEFAULT_ROOTS = ["D:\\"];

function blank() {
	return {
		port: DEFAULT_PORT,
		agentToken: randomBytes(24).toString("hex"),
		passcode: null, // { salt, hash }
		passkeys: [], // registered phones: { id, publicKey, counter, label, createdAt }
		tokens: [], // live logins: { hash, createdAt, lastUsed, label }
		roots: DEFAULT_ROOTS,
		lockAfterMinutes: DEFAULT_LOCK_MINUTES,
		// Off by default: out of the box only this PC and Tailscale can connect.
		// Turning it on also lets devices on your own home network reach the
		// bridge. Never lets the internet in — see net-guard.js.
		allowLan: false,
		createdAt: new Date().toISOString(),
	};
}

export function loadConfig() {
	if (!existsSync(CONFIG_PATH)) return null;
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		return null;
	}
}

export function saveConfig(cfg) {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
	return cfg;
}

export function ensureConfig() {
	const existing = loadConfig();
	if (!existing) return saveConfig(blank());

	let dirty = false;
	for (const [k, v] of Object.entries(blank())) {
		if (existing[k] === undefined && k !== "createdAt") {
			existing[k] = v;
			dirty = true;
		}
	}
	// tokens used to be bare strings; those carry no last-used stamp, so drop them
	if (existing.tokens?.some((t) => typeof t === "string")) {
		existing.tokens = existing.tokens.filter((t) => typeof t !== "string");
		dirty = true;
	}
	if (dirty) saveConfig(existing);
	return existing;
}

// ---------------------------------------------------------------- passcode

export function setPasscode(cfg, passcode) {
	const salt = randomBytes(16).toString("hex");
	cfg.passcode = { salt, hash: scryptSync(passcode, salt, 64).toString("hex") };
	cfg.tokens = []; // changing the passcode logs every phone out
	return saveConfig(cfg);
}

export const hasPasscode = (cfg) => Boolean(cfg.passcode?.hash);

export function verifyPasscode(cfg, passcode) {
	if (!hasPasscode(cfg)) return false;
	const expected = Buffer.from(cfg.passcode.hash, "hex");
	const actual = scryptSync(String(passcode ?? ""), cfg.passcode.salt, 64);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------- tokens

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Mint a login token. Returned once in the clear, stored only as a hash. */
export function issueToken(cfg, label = "phone") {
	const token = randomBytes(32).toString("hex");
	const now = Date.now();
	cfg.tokens.push({ hash: sha256(token), createdAt: now, lastUsed: now, label });
	if (cfg.tokens.length > 20) cfg.tokens = cfg.tokens.slice(-20);
	saveConfig(cfg);
	return token;
}

/**
 * Check a token and slide its expiry forward. Returns false once the phone has
 * been idle longer than lockAfterMinutes, which is what makes the app re-ask
 * for a fingerprint after you have been away.
 */
export function verifyToken(cfg, token, { touch = true } = {}) {
	if (!token) return false;
	const hash = sha256(String(token));
	const rec = cfg.tokens.find((t) => t.hash === hash);
	if (!rec) return false;

	const idleMs = Date.now() - (rec.lastUsed || 0);
	if (idleMs > (cfg.lockAfterMinutes ?? DEFAULT_LOCK_MINUTES) * 60_000) {
		cfg.tokens = cfg.tokens.filter((t) => t.hash !== hash);
		saveConfig(cfg);
		return false;
	}

	if (!touch) return true;
	// only write through occasionally; this runs on every request
	const now = Date.now();
	if (now - rec.lastUsed > 30_000) {
		rec.lastUsed = now;
		saveConfig(cfg);
	} else {
		rec.lastUsed = now;
	}
	return true;
}

export function revokeAllTokens(cfg) {
	cfg.tokens = [];
	return saveConfig(cfg);
}

// ---------------------------------------------------------------- passkeys

export const hasPasskey = (cfg) => (cfg.passkeys?.length ?? 0) > 0;

export function addPasskey(cfg, passkey) {
	cfg.passkeys = cfg.passkeys || [];
	cfg.passkeys = cfg.passkeys.filter((p) => p.id !== passkey.id);
	cfg.passkeys.push({ ...passkey, createdAt: Date.now() });
	return saveConfig(cfg);
}

export function getPasskey(cfg, id) {
	return (cfg.passkeys || []).find((p) => p.id === id) || null;
}

export function updatePasskeyCounter(cfg, id, counter) {
	const p = getPasskey(cfg, id);
	if (p) {
		p.counter = counter;
		saveConfig(cfg);
	}
}

export function removePasskey(cfg, id) {
	cfg.passkeys = (cfg.passkeys || []).filter((p) => p.id !== id);
	return saveConfig(cfg);
}
