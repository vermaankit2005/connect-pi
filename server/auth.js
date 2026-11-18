// Logging in.
//
// Two ways in:
//   - a passkey: your phone's fingerprint or face. The secret never leaves the
//     phone, so there is nothing to guess, phish or steal off the wire. This is
//     the everyday route.
//   - the passcode: the fallback, and the only way to enrol a new phone.
//
// Passkeys are a browser feature that only works on secure addresses (https, or
// localhost). Over a bare http://100.x.x.x address the phone will refuse, so we
// detect that and tell the app to fall back rather than failing mysteriously.

import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { addPasskey, getPasskey, hasPasscode, hasPasskey, issueToken, updatePasskeyCounter, verifyPasscode } from "./config.js";

const CHALLENGE_TTL_MS = 3 * 60_000;
const challenges = new Map(); // challenge -> expiry

function rememberChallenge(challenge) {
	challenges.set(challenge, Date.now() + CHALLENGE_TTL_MS);
	for (const [c, exp] of challenges) if (exp < Date.now()) challenges.delete(c);
}

function consumeChallenge(challenge) {
	const exp = challenges.get(challenge);
	challenges.delete(challenge);
	return Boolean(exp && exp > Date.now());
}

/**
 * Work out the web address the phone thinks it is talking to. Passkeys are tied
 * to it, so it has to come from the request rather than be guessed.
 */
export function originOf(req) {
	const host = req.headers.host || "localhost";
	const hostname = host.replace(/:\d+$/, "");
	// behind `tailscale serve` the request reaches us as plain http, so trust the
	// forwarded marker it sets
	const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
	const secure = forwarded === "https" || Boolean(req.socket.encrypted);
	const proto = secure ? "https" : "http";
	const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";
	return { origin: `${proto}://${host}`, rpID: hostname, canUsePasskey: secure || isLocalhost };
}

export function authState(cfg, req) {
	const { canUsePasskey } = originOf(req);
	return {
		hasPasscode: hasPasscode(cfg),
		hasPasskey: hasPasskey(cfg),
		canUsePasskey,
		lockAfterMinutes: cfg.lockAfterMinutes ?? 60,
	};
}

// ---------------------------------------------------------------- passcode

export function loginWithPasscode(cfg, passcode) {
	if (!hasPasscode(cfg)) throw new Error("No passcode has been set on the PC yet.");
	if (!verifyPasscode(cfg, passcode)) throw new Error("Wrong passcode.");
	return issueToken(cfg, "passcode");
}

// ------------------------------------------------------- passkey: enrolment

/** Enrolling a new phone requires you to already be logged in. */
export async function passkeyRegisterOptions(cfg, req) {
	const { rpID, canUsePasskey } = originOf(req);
	if (!canUsePasskey) throw new Error("Fingerprint login needs an https address. See the Tailscale HTTPS step in the README.");

	const options = await generateRegistrationOptions({
		rpName: "pi remote",
		rpID,
		userID: new TextEncoder().encode("connect-pi-owner"),
		userName: "pi remote",
		userDisplayName: "pi remote",
		attestationType: "none",
		excludeCredentials: (cfg.passkeys || []).map((p) => ({ id: p.id, type: "public-key" })),
		authenticatorSelection: {
			residentKey: "preferred",
			userVerification: "required", // forces fingerprint/face, not just presence
			authenticatorAttachment: "platform", // the phone itself, not a USB key
		},
	});
	rememberChallenge(options.challenge);
	return options;
}

export async function passkeyRegisterVerify(cfg, req, response, label) {
	const { origin, rpID } = originOf(req);
	const expected = response?.response?.clientDataJSON
		? JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString()).challenge
		: null;
	if (!expected || !consumeChallenge(expected)) throw new Error("That request expired. Try again.");

	const result = await verifyRegistrationResponse({
		response,
		expectedChallenge: expected,
		expectedOrigin: origin,
		expectedRPID: rpID,
		requireUserVerification: true,
	});
	if (!result.verified) throw new Error("Could not register this phone.");

	const cred = result.registrationInfo.credential;
	addPasskey(cfg, {
		id: cred.id,
		publicKey: Buffer.from(cred.publicKey).toString("base64url"),
		counter: cred.counter,
		transports: cred.transports || [],
		label: label || "phone",
	});
	return { ok: true };
}

// ---------------------------------------------------------- passkey: login

export async function passkeyLoginOptions(cfg, req) {
	const { rpID, canUsePasskey } = originOf(req);
	if (!canUsePasskey) throw new Error("Fingerprint login needs an https address.");
	if (!hasPasskey(cfg)) throw new Error("No phone has been set up for fingerprint login yet.");

	const options = await generateAuthenticationOptions({
		rpID,
		allowCredentials: (cfg.passkeys || []).map((p) => ({ id: p.id, type: "public-key", transports: p.transports })),
		userVerification: "required",
	});
	rememberChallenge(options.challenge);
	return options;
}

export async function passkeyLoginVerify(cfg, req, response) {
	const { origin, rpID } = originOf(req);
	const expected = response?.response?.clientDataJSON
		? JSON.parse(Buffer.from(response.response.clientDataJSON, "base64url").toString()).challenge
		: null;
	if (!expected || !consumeChallenge(expected)) throw new Error("That request expired. Try again.");

	const stored = getPasskey(cfg, response.id);
	if (!stored) throw new Error("This phone is not registered.");

	const result = await verifyAuthenticationResponse({
		response,
		expectedChallenge: expected,
		expectedOrigin: origin,
		expectedRPID: rpID,
		requireUserVerification: true,
		credential: {
			id: stored.id,
			publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")),
			counter: stored.counter || 0,
			transports: stored.transports,
		},
	});
	if (!result.verified) throw new Error("Fingerprint check failed.");

	// a counter that goes backwards means a cloned authenticator
	updatePasskeyCounter(cfg, stored.id, result.authenticationInfo.newCounter);
	return issueToken(cfg, stored.label || "passkey");
}
