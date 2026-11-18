// Shared config for connect-pi.
//
// Lives at ~/.connect-pi.json — a fixed spot the pi extension can always find,
// regardless of which pi install or PI_CODING_AGENT_DIR is in play.

import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

export const CONFIG_PATH = process.env.CONNECT_PI_CONFIG ? resolve(process.env.CONNECT_PI_CONFIG) : join(homedir(), ".connect-pi.json");

const DEFAULT_PORT = 4317;
const DEFAULT_LOCK_MINUTES = 60;
const ABSOLUTE_SESSION_MS = 24 * 60 * 60_000;
const scryptAsync = promisify(scrypt);
export const validPasscode = (value) => typeof value === "string" && /^\d{6}$/.test(value);
export const controlPort = (cfg) => cfg.controlPort ?? (Number(cfg.port) === 65535 ? 65534 : Number(cfg.port) + 1);

const DEFAULT_ROOTS = [];

function blank() {
	return {
		port: DEFAULT_PORT,
		agentToken: randomBytes(24).toString("hex"),
		passcode: null, // { salt, hash }
		passkeys: [], // registered phones: { id, publicKey, counter, label, createdAt }
		tokens: [], // live logins: { hash, createdAt, lastUsed, label }
		roots: DEFAULT_ROOTS,
		lockAfterMinutes: DEFAULT_LOCK_MINUTES,
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
	const temp = `${CONFIG_PATH}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temp, CONFIG_PATH);
	} finally {
		rmSync(temp, { force: true });
	}
	return cfg;
}

export function ensureConfig() {
	const existing = loadConfig();
	if (!existing) {
		if (existsSync(CONFIG_PATH)) throw new Error(`Cannot read settings at ${CONFIG_PATH}. Restore or repair them before proceeding.`);
		return saveConfig(blank());
	}

	let dirty = false;
	for (const [k, v] of Object.entries(blank())) {
		if (existing[k] === undefined && k !== "createdAt") {
			existing[k] = v;
			dirty = true;
		}
	}
	// tokens used to be bare strings; those carry no last-used stamp, so drop them
	if (existing.tokens?.some((t) => !t || typeof t !== "object" || !t.origin)) {
		existing.tokens = existing.tokens.filter((t) => t && typeof t === "object" && t.origin);
		dirty = true;
	}
	if (dirty) saveConfig(existing);
	return existing;
}

// ---------------------------------------------------------------- passcode

export function setPasscode(cfg, passcode) {
	if (!validPasscode(passcode)) throw new Error("Use exactly 6 digits.");
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

export async function verifyPasscodeAsync(cfg, passcode) {
	if (!hasPasscode(cfg) || !validPasscode(passcode)) return false;
	const { salt, hash } = cfg.passcode;
	const actual = await scryptAsync(passcode, salt, 64);
	const expected = Buffer.from(hash, "hex");
	return cfg.passcode?.hash === hash && expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------- tokens

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Mint a login token. Returned once in the clear, stored only as a hash. */
export function issueToken(cfg, { origin, credentialId = null, label = "Passcode session" }) {
	const token = randomBytes(32).toString("hex");
	const now = Date.now();
	cfg.tokens.push({ hash: sha256(token), createdAt: now, lastUsed: now, label, origin, credentialId });
	cfg.tokens = cfg.tokens.slice(-20);
	saveConfig(cfg);
	return token;
}

export function verifyToken(cfg, token, { origin, touch = true } = {}) {
	if (!/^[a-f0-9]{64}$/.test(token || "")) return null;
	const hash = sha256(token);
	const rec = cfg.tokens.find((entry) => entry.hash === hash && entry.origin === origin);
	if (!rec) return null;

	const now = Date.now();
	if (now - rec.lastUsed > (cfg.lockAfterMinutes ?? DEFAULT_LOCK_MINUTES) * 60_000 ||
		now - rec.createdAt > ABSOLUTE_SESSION_MS) {
		revokeToken(cfg, rec);
		return null;
	}
	if (touch) rec.lastUsed = now;
	return rec;
}

export function revokeToken(cfg, rec) {
	cfg.tokens = cfg.tokens.filter((entry) => entry.hash !== rec.hash);
	return saveConfig(cfg);
}

// ---------------------------------------------------------------- passkeys

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
	cfg.tokens = cfg.tokens.filter((entry) => entry.credentialId !== id);
	return saveConfig(cfg);
}
