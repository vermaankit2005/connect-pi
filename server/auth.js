import {
	generateAuthenticationOptions, generateRegistrationOptions,
	verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { addPasskey, getPasskey, hasPasscode, issueToken, updatePasskeyCounter, verifyPasscodeAsync } from "./config.js";

const CHALLENGE_TTL_MS = 3 * 60_000;
const challenges = new Map();

function rememberChallenge(challenge, kind, site, session = "") {
	const now = Date.now();
	for (const [key, record] of challenges) if (record.expires <= now) challenges.delete(key);
	while (challenges.size >= 128) challenges.delete(challenges.keys().next().value);
	challenges.set(challenge, { kind, origin: site.origin, session, expires: now + CHALLENGE_TTL_MS });
}

function useChallenge(response, kind, site, session = "") {
	const encoded = response?.response?.clientDataJSON;
	if (typeof encoded !== "string") throw new Error("Invalid passkey response.");
	const challenge = JSON.parse(Buffer.from(encoded, "base64url").toString()).challenge;
	const record = challenges.get(challenge);
	if (!record || record.expires < Date.now() || record.kind !== kind || record.origin !== site.origin || record.session !== session) {
		throw new Error("That request expired. Try again.");
	}
	challenges.delete(challenge);
	return challenge;
}

export function siteFor(req, phoneUrl, port) {
	const host = req.headers.host?.toLowerCase();
	const localPort = port === 80 ? "" : `:${port}`;
	if (host === `localhost${localPort}` || host === `127.0.0.1${localPort}`) {
		return { origin: `http://${host}`, rpID: "localhost", canUsePasskey: host.startsWith("localhost"), secure: false };
	}
	if (phoneUrl && host === new URL(phoneUrl).host && req.headers["x-forwarded-proto"] === "https") {
		return { origin: phoneUrl, rpID: new URL(phoneUrl).hostname, canUsePasskey: true, secure: true };
	}
	return null;
}

const cookieName = (site) => site.secure ? "__Host-connect-pi" : "connect-pi-local";
export function sessionCookie(site, value) {
	return `${cookieName(site)}=${value}; Path=/; HttpOnly; SameSite=Strict${site.secure ? "; Secure" : ""}${value ? "" : "; Max-Age=0"}`;
}

export function cookieToken(req, site) {
	const key = `${cookieName(site)}=`;
	return (req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(key))?.slice(key.length) || "";
}

const passkeysFor = (cfg, site) => (cfg.passkeys || []).filter((key) => !key.rpID || key.rpID === site.rpID);
export const authState = (cfg, site) => ({
	hasPasscode: hasPasscode(cfg),
	hasPasskey: site.canUsePasskey && passkeysFor(cfg, site).length > 0,
	canUsePasskey: site.canUsePasskey,
	lockAfterMinutes: cfg.lockAfterMinutes ?? 60,
});

export async function loginWithPasscode(cfg, site, passcode) {
	if (!hasPasscode(cfg)) throw new Error("Set a passcode on the PC with /phone setup.");
	if (!await verifyPasscodeAsync(cfg, passcode)) throw new Error("Wrong passcode.");
	return issueToken(cfg, { origin: site.origin });
}

export async function passkeyRegisterOptions(cfg, site, login) {
	if (!site.canUsePasskey) throw new Error("Use the Tailscale HTTPS URL to add a passkey.");
	if (passkeysFor(cfg, site).length >= 20) throw new Error("Remove an old passkey before adding one.");
	const options = await generateRegistrationOptions({
		rpName: "Connect Pi", rpID: site.rpID,
		userID: new TextEncoder().encode("connect-pi-owner"),
		userName: "Connect Pi owner", attestationType: "none",
		excludeCredentials: passkeysFor(cfg, site).map((key) => ({ id: key.id })),
		authenticatorSelection: { residentKey: "preferred", userVerification: "required", authenticatorAttachment: "platform" },
	});
	rememberChallenge(options.challenge, "register", site, login.hash);
	return options;
}

export async function passkeyRegisterVerify(cfg, site, login, response, label) {
	if (!site.canUsePasskey) throw new Error("Use the Tailscale HTTPS URL to add a passkey.");
	const expectedChallenge = useChallenge(response, "register", site, login.hash);
	const result = await verifyRegistrationResponse({
		response, expectedChallenge, expectedOrigin: site.origin, expectedRPID: site.rpID, requireUserVerification: true,
	});
	if (!result.verified || !cfg.tokens.includes(login)) throw new Error("Could not register this passkey. Unlock and try again.");
	if (passkeysFor(cfg, site).length >= 20) throw new Error("Remove an old passkey before adding one.");
	const cred = result.registrationInfo.credential;
	const name = typeof label === "string" && label.trim() ? label.trim().slice(0, 60) : "Phone";
	addPasskey(cfg, {
		id: cred.id, rpID: site.rpID, publicKey: Buffer.from(cred.publicKey).toString("base64url"),
		counter: cred.counter, transports: cred.transports || [], label: name,
	});
	return { ok: true };
}

export async function passkeyLoginOptions(cfg, site) {
	if (!site.canUsePasskey || !passkeysFor(cfg, site).length) throw new Error("No passkeys have been added for this address.");
	const options = await generateAuthenticationOptions({
		rpID: site.rpID,
		allowCredentials: passkeysFor(cfg, site).map((key) => ({ id: key.id, transports: key.transports })),
		userVerification: "required",
	});
	rememberChallenge(options.challenge, "login", site);
	return options;
}

export async function passkeyLoginVerify(cfg, site, response) {
	if (!site.canUsePasskey) throw new Error("Use the Tailscale HTTPS URL to sign in with a passkey.");
	const expectedChallenge = useChallenge(response, "login", site);
	const stored = getPasskey(cfg, response.id);
	if (!stored || (stored.rpID && stored.rpID !== site.rpID)) throw new Error("This passkey is not registered.");
	const result = await verifyAuthenticationResponse({
		response, expectedChallenge, expectedOrigin: site.origin, expectedRPID: site.rpID, requireUserVerification: true,
		credential: { id: stored.id, publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")), counter: stored.counter || 0, transports: stored.transports },
	});
	if (!result.verified || getPasskey(cfg, stored.id) !== stored || result.authenticationInfo.newCounter < stored.counter) {
		throw new Error("Passkey verification failed.");
	}
	updatePasskeyCounter(cfg, stored.id, result.authenticationInfo.newCounter);
	return issueToken(cfg, { origin: site.origin, credentialId: stored.id, label: stored.label });
}
