// Same-origin API and WebSocket. The browser holds the HttpOnly session cookie.

let onLocked = () => {};
export const setLockHandler = (fn) => {
	onLocked = fn;
};

class HttpError extends Error {
	constructor(message, status) {
		super(message);
		this.status = status;
	}
}

async function call(path, { method = "GET", body, auth = true } = {}) {
	const headers = body === undefined ? {} : { "content-type": "application/json" };

	let res;
	try {
		res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
	} catch {
		throw new HttpError("Cannot reach your PC. Is it awake, and is the bridge running?", 0);
	}

	const text = await res.text();
	let data = {};
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = {};
	}

	if (res.status === 401 && auth) {
		onLocked();
	}
	if (!res.ok) throw new HttpError(data.error || `Request failed (${res.status})`, res.status);
	return data;
}

export const api = {
	authState: () => call("/api/auth/state", { auth: false }),
	me: (auth = true) => call("/api/me", { auth }),
	lock: () => call("/api/auth/lock", { method: "POST", body: {}, auth: false }),
	devices: () => call("/api/devices"),
	removeDevice: (kind, id) => call("/api/devices/remove", { method: "POST", body: { kind, id } }),
	loginPasscode: (passcode) => call("/api/auth/passcode", { method: "POST", body: { passcode }, auth: false }),
	roots: () => call("/api/folders"),
	folders: (path) => call(`/api/folders?path=${encodeURIComponent(path)}`),
	createFolder: (parent, name) => call("/api/folders/create", { method: "POST", body: { parent, name } }),
	history: () => call("/api/history"),
	transcript: (id, before, search) => {
		const query = new URLSearchParams({ id, search });
		if (before != null) query.set("before", before);
		return call(`/api/history/transcript?${query}`);
	},
	startSession: (folder) => call("/api/sessions", { method: "POST", body: { folder } }),
	resumeSession: (resumeId) => call("/api/sessions", { method: "POST", body: { resumeId } }),
	stopSession: (id) => call("/api/sessions/stop", { method: "POST", body: { id } }),
	sessionStatus: (id) => call(`/api/sessions/status?id=${encodeURIComponent(id)}`),
	openInWarp: (selection) => call("/api/open-in-warp", { method: "POST", body: selection }),
	changes: (agentId) => call("/api/changes", { method: "POST", body: { agentId } }),
	passkeyRegisterOptions: () => call("/api/auth/passkey/register/options", { method: "POST", body: {} }),
	passkeyRegisterVerify: (response, label) =>
		call("/api/auth/passkey/register/verify", { method: "POST", body: { response, label } }),
	passkeyLoginOptions: () => call("/api/auth/passkey/login/options", { method: "POST", body: {}, auth: false }),
	passkeyLoginVerify: (response) =>
		call("/api/auth/passkey/login/verify", { method: "POST", body: { response }, auth: false }),
};

// ---------------------------------------------------------------- passkeys

// The server speaks base64url; the browser speaks ArrayBuffer. Newer Chrome has
// parseCreationOptionsFromJSON/toJSON which do this for us, so use those when
// they exist and hand-convert otherwise.

const b64uToBuf = (s) => {
	const pad = s.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
	return out.buffer;
};

const bufToB64u = (buf) => {
	const bytes = new Uint8Array(buf);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** True when this browser will even consider a fingerprint. Plain http fails. */
export function passkeySupported() {
	return Boolean(window.PublicKeyCredential && window.isSecureContext && navigator.credentials);
}

function serialize(cred) {
	if (typeof cred.toJSON === "function") return cred.toJSON();
	const r = cred.response;
	const out = {
		id: cred.id,
		rawId: bufToB64u(cred.rawId),
		type: cred.type,
		clientExtensionResults: cred.getClientExtensionResults?.() || {},
		response: { clientDataJSON: bufToB64u(r.clientDataJSON) },
	};
	if (r.attestationObject) {
		out.response.attestationObject = bufToB64u(r.attestationObject);
		out.response.transports = r.getTransports?.() || [];
	} else {
		out.response.authenticatorData = bufToB64u(r.authenticatorData);
		out.response.signature = bufToB64u(r.signature);
		out.response.userHandle = r.userHandle ? bufToB64u(r.userHandle) : null;
	}
	return out;
}

export async function enrolPasskey(label) {
	const options = await api.passkeyRegisterOptions();
	const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON
		? PublicKeyCredential.parseCreationOptionsFromJSON(options)
		: {
				...options,
				challenge: b64uToBuf(options.challenge),
				user: { ...options.user, id: b64uToBuf(options.user.id) },
				excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
			};
	const cred = await navigator.credentials.create({ publicKey });
	if (!cred) throw new Error("Fingerprint setup was cancelled.");
	return api.passkeyRegisterVerify(serialize(cred), label);
}

export async function loginWithPasskey() {
	const options = await api.passkeyLoginOptions();
	const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON
		? PublicKeyCredential.parseRequestOptionsFromJSON(options)
		: {
				...options,
				challenge: b64uToBuf(options.challenge),
				allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
			};
	const cred = await navigator.credentials.get({ publicKey });
	if (!cred) throw new Error("Fingerprint check was cancelled.");
	return api.passkeyLoginVerify(serialize(cred));
}

// ---------------------------------------------------------------- socket

/**
 * The live link. Reconnects on its own with a backing-off delay, because the
 * PC going to sleep or the phone changing network is normal, not an error.
 */
export class Bridge {
	constructor(handlers) {
		this.handlers = handlers;
		this.ws = null;
		this.tries = 0;
		this.timer = null;
		this.closed = false;
	}

	connect() {
		this.closed = false;
		clearTimeout(this.timer);
		const proto = location.protocol === "https:" ? "wss" : "ws";
		let ws;
		try {
			ws = new WebSocket(`${proto}://${location.host}/app`);
		} catch {
			return this.retry();
		}
		this.ws = ws;
		let opened = false;

		ws.onopen = () => {
			opened = true;
			this.tries = 0;
			this.handlers.onOpen?.();
		};
		ws.onmessage = (ev) => {
			let msg;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				return;
			}
			this.handlers.onMessage?.(msg);
		};
		ws.onclose = () => {
			if (this.ws !== ws || this.closed) return;
			this.ws = null;
			this.handlers.onClose?.();
			// A socket that never opened was turned away at the door, which almost
			// always means the login expired. One that opened and then died is just
			// the PC asleep or the phone changing network — that only needs a retry.
			if (!opened) this.handlers.onRejected?.();
			this.retry();
		};
		ws.onerror = () => {
			try {
				ws.close();
			} catch {}
		};
	}

	retry() {
		if (this.closed || this.timer) return;
		this.tries = Math.min(this.tries + 1, 6);
		this.timer = setTimeout(() => {
			this.timer = null;
			if (!this.closed) this.connect();
		}, Math.min(15000, 700 * 2 ** this.tries));
	}

	send(obj) {
		if (this.ws && this.ws.readyState === 1) {
			try {
				this.ws.send(JSON.stringify(obj));
				return true;
			} catch { return false; }
		}
		return false;
	}

	get live() {
		return Boolean(this.ws && this.ws.readyState === 1);
	}

	close() {
		this.closed = true;
		clearTimeout(this.timer);
		this.timer = null;
		try {
			this.ws?.close();
		} catch {}
		this.ws = null;
	}
}
