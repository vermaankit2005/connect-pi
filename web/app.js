// connect-pi phone app.
//
// Screens: lock -> chat, with a drawer of running pi sessions and a folder
// picker for starting new ones. Everything the PC says arrives on one
// websocket; everything else is a small REST call.

import { Bridge, api, enrolPasskey, loginWithPasskey, passkeySupported, setLockHandler } from "/api.js";
import { projectGroups } from "/projects.js";
import { esc, markdown } from "/markdown.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text != null) n.textContent = text;
	return n;
};
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;

// ---------------------------------------------------------------- state

const state = {
	auth: { hasPasscode: false, hasPasskey: false, canUsePasskey: false },
	agents: [],
	drawerMode: "projects",
	project: null,
	history: [], // conversations on the PC that are not open right now
	agentId: null,
	info: {},
	thinking: "",
	streaming: false,
	events: new Map(), // key -> event, in arrival order
	nodes: new Map(), // key -> rendered element
	open: new Set(), // which detail rows the user has expanded
	started: new Map(), // key -> when the assistant message first appeared
	drafts: new Map(),
	outbox: new Map(),
	attachment: null,
	waiting: false,
	stopping: false,
	pending: null, // a session we asked for but have not seen connect yet
	pick: { path: null, name: "", parent: null, folders: [], roots: [] },
	lastTouch: 0,
	screen: "lock",
};

let bridge = null;
let loggedIn = false;
const LOCAL_LOCK = "connect-pi.locked";

// ---------------------------------------------------------------- bits

let toastTimer = null;
function toast(message, ms = 2600) {
	const t = $("toast");
	t.textContent = message;
	t.classList.remove("hidden");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

function buzz(ms = 8) {
	try {
		navigator.vibrate?.(ms);
	} catch {}
}

// "3m ago" beats a timestamp on a phone: you are asking "is this the one I was
// just in", not "what o'clock was it".
function ago(ms) {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.round(h / 24);
	if (d < 7) return `${d}d ago`;
	return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const turnsLabel = (s) => `${s.userTurns} message${s.userTurns === 1 ? "" : "s"}`;

// Reopening a conversation re-sends the whole thing, so the ones that will
// cost real tokens say so before you tap. Bytes on disk, not message count: a
// four-message session full of file reads is far heavier than a chatty twenty.
const weight = (s) => (s.bytes > 250_000 ? "heavy" : s.bytes > 60_000 ? "big" : "");
const weightLabel = (s) => (s.bytes > 250_000 ? "very long" : s.bytes > 60_000 ? "long" : "");

// ------------------------------------------------------------------ theme

// Three choices, not two: "System" follows the phone's own light/dark switch,
// which is what most people expect and what Android changes at sunset. The
// stored value is read again by the inline script in index.html before the
// first paint, so launching never flashes the wrong colour.
const THEMES = [
	{ id: "system", label: "Follow my phone" },
	{ id: "light", label: "Light" },
	{ id: "dark", label: "Dark" },
];

function currentTheme() {
	try {
		const saved = localStorage.getItem("connect-pi.theme");
		if (THEMES.some((t) => t.id === saved)) return saved;
	} catch {}
	return "system";
}

function applyTheme(id) {
	const root = document.documentElement;
	if (id === "system") root.removeAttribute("data-theme");
	else root.setAttribute("data-theme", id);
	try {
		localStorage.setItem("connect-pi.theme", id);
	} catch {}
	paintThemeColor();
	paintBubble(); // the bubble carries a dark and a light hex; swap to the right one
}

// Android tints the browser chrome and the task-switcher card from this, so it
// has to follow the theme or the app looks like it has a black scar on top.
function paintThemeColor() {
	const meta = document.getElementById("themeColor");
	if (!meta) return;
	meta.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#000000");
}

// on System, the phone can flip underneath us
window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => {
	if (currentTheme() === "system") {
		paintThemeColor();
		paintBubble();
	}
});

// ------------------------------------------------------------ bubble colour

// The colour of your own messages, and nothing else — the send button and the
// links stay purple, so picking a loud one doesn't repaint the whole app.
// Every colour carries two sets: a deep one for the dark theme and a pale tint
// for light, because one hex can't be readable on both black and white. The
// pair is applied as inline custom properties on <html>, which is why the
// stylesheet only needs the three variables.
const BUBBLES = [
	{
		id: "purple",
		label: "Purple",
		sub: "Default",
		dark: { bg: "#2d074b", text: "#ffffff" },
		light: { bg: "#ebe4ff", text: "#34216b" },
	},
	{
		id: "teal",
		label: "Teal",
		dark: { bg: "#17564f", text: "#eafffb" },
		light: { bg: "#cdf2ec", text: "#0d3f39" },
	},
	{
		id: "ocean",
		label: "Ocean",
		dark: { bg: "#1e3a6b", text: "#eaf1ff" },
		light: { bg: "#dbe8ff", text: "#17325f" },
	},
	{
		id: "forest",
		label: "Forest",
		dark: { bg: "#24512f", text: "#eafff0" },
		light: { bg: "#d8f3de", text: "#14401f" },
	},
	{
		id: "rose",
		label: "Rose",
		dark: { bg: "#6b2a44", text: "#ffe9f1" },
		light: { bg: "#ffdfeb", text: "#5c1c34" },
	},
	{
		id: "ember",
		label: "Ember",
		dark: { bg: "#6b3a1c", text: "#fff0e4" },
		light: { bg: "#ffe6d1", text: "#57300f" },
	},
	{
		id: "highlighter",
		label: "Highlighter",
		sub: "Loud on purpose",
		dark: { bg: "#d7f04a", text: "#1b1e05" },
		light: { bg: "#e8ff5c", text: "#232a06" },
	},
	{
		id: "white",
		label: "White",
		// on a white page a white bubble needs an edge or it dissolves
		dark: { bg: "#f2f2f2", text: "#141414" },
		light: { bg: "#ffffff", text: "#1c1c1e", border: "#dcdce0" },
	},
	{
		id: "slate",
		label: "Slate",
		dark: { bg: "#2f343d", text: "#f0f2f5" },
		light: { bg: "#e4e7ec", text: "#232830" },
	},
];
const DEFAULT_BUBBLE = "purple";

function currentBubble() {
	try {
		const saved = localStorage.getItem("connect-pi.bubble");
		if (BUBBLES.some((b) => b.id === saved)) return saved;
	} catch {}
	return DEFAULT_BUBBLE;
}

// which half of the pair is on screen right now — the attribute wins, and on
// System we ask the phone
function isLightNow() {
	const t = currentTheme();
	if (t === "light") return true;
	if (t === "dark") return false;
	return !!window.matchMedia?.("(prefers-color-scheme: light)").matches;
}

// the swatch shown in the sheet: the colour as it will actually land
const bubbleSwatch = (b) => (isLightNow() ? b.light : b.dark).bg;

function paintBubble() {
	const b = BUBBLES.find((x) => x.id === currentBubble()) || BUBBLES[0];
	const tone = isLightNow() ? b.light : b.dark;
	const root = document.documentElement.style;
	root.setProperty("--user-bubble", tone.bg);
	root.setProperty("--user-text", tone.text);
	root.setProperty("--user-bubble-edge", tone.border || "transparent");
}

function applyBubble(id) {
	try {
		localStorage.setItem("connect-pi.bubble", id);
	} catch {}
	paintBubble();
}

// ---------------------------------------------------------------- text size

// Every size in styles.css is in rem, so the root font-size is the zoom of the
// whole app. 15.36 (96% of the original 16px) is the default and sits alongside the ChatGPT app; a phone
// with a bigger screen or older eyes can move it without anything reflowing
// oddly, because the entire layout scales together.
const TEXT_SIZES = [
	{ label: "Smallest", px: 13.44 },
	{ label: "Small", px: 14.4 },
	{ label: "Default", px: 15.36 },
	{ label: "Large", px: 16.32 },
	{ label: "Largest", px: 17.28 },
];
const DEFAULT_TEXT_SIZE = 15.36;

function textSize() {
	let saved = Number(localStorage.getItem("connect-pi.textSize"));
	const version = localStorage.getItem("connect-pi.scaleVersion");
	const previous = version === "3" ? [13.16, 14.1, 15.04, 15.98, 16.92] : version === "2" ? [12.5, 13.5, 14.5, 15.5, 16.5] : [14, 15, 16, 17, 18];
	const index = previous.indexOf(saved);
	if (version !== "4" && index !== -1) saved = TEXT_SIZES[index].px;
	return TEXT_SIZES.some((s) => s.px === saved) ? saved : DEFAULT_TEXT_SIZE;
}

function applyTextSize(px) {
	document.documentElement.style.fontSize = `${px}px`;
	try {
		localStorage.setItem("connect-pi.textSize", String(px));
		localStorage.setItem("connect-pi.scaleVersion", "4");
	} catch {}
}

/** Clipboard, including the http case where the real clipboard API is absent. */
async function copy(text) {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {}
	try {
		const ta = el("textarea");
		ta.value = text;
		ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	} catch {
		return false;
	}
}

// Overlays register with the back stack so the phone's back gesture closes the
// top one instead of leaving the app.
const backStack = [];
const overlayIds = ["dialogWrap", "sheetWrap", "actionsWrap", "drawer"];
function syncInert() {
	const top = overlayIds.find((id) => !$(id).classList.contains("hidden"));
	for (const id of overlayIds) $(id).inert = Boolean(top && id !== top);
	for (const id of ["offline", "lock", "chat", "picker", "transcript"]) $(id).inert = Boolean(top);
}
function pushBack(close) {
	const returnTo = document.activeElement;
	backStack.push(() => {
		close();
		syncInert();
		if (returnTo?.getClientRects().length && !returnTo.closest("[inert]")) returnTo.focus();
	});
	history.pushState({ depth: backStack.length }, "");
	syncInert();
}
window.addEventListener("popstate", () => { backStack.pop()?.(); });
function closeTop() {
	if (backStack.length) history.back();
}

// ---------------------------------------------------------------- sheets

function showSheet(items, { title, note } = {}) {
	const sheet = $("sheet");
	sheet.innerHTML = "";
	sheet.appendChild(el("div", "grab"));
	sheet.setAttribute("aria-label", title || "Options");
	if (title) sheet.appendChild(el("div", "sheet-title", title));
	if (note) sheet.appendChild(el("div", "sheet-note", note));

	for (const item of items) {
		if (!item) continue;
		const b = el("button", `sheet-item${item.danger ? " danger" : ""}`);
		const lead = item.swatch
			? `<span class="swatch${item.on ? " on" : ""}" style="background:${esc(item.swatch)}"></span>`
			: icon(item.icon);
		b.innerHTML = `${lead}<span>${esc(item.label)}${item.sub ? `<small>${esc(item.sub)}</small>` : ""}</span>${item.swatch && item.on ? icon("check", "ic trail") : ""}`;
		b.onclick = () => {
			closeTop();
			setTimeout(() => item.onClick?.(), 60);
		};
		sheet.appendChild(b);
	}

	$("sheetWrap").classList.remove("hidden");
	pushBack(() => $("sheetWrap").classList.add("hidden"));
	(sheet.querySelector("button") || sheet).focus();
}
$("sheetScrim").onclick = closeTop;

function showDialog({ title, body, detail, detailNote, placeholder, value = "", confirm = "OK", onConfirm }) {
	const d = $("dialog");
	d.innerHTML = "";
	d.setAttribute("aria-label", title);
	d.appendChild(el("h3", null, title));
	if (body) d.appendChild(el("p", detail !== undefined ? "diff-status" : null, body));
	if (detail) {
		const pre = el("pre", "diff", detail);
		pre.tabIndex = 0;
		pre.setAttribute("aria-label", "Git diff");
		d.appendChild(pre);
	}
	if (detailNote) d.appendChild(el("p", null, detailNote));

	let input = null;
	if (placeholder != null) {
		input = el("input");
		input.placeholder = placeholder;
		input.setAttribute("aria-label", placeholder);
		input.value = value;
		input.autocapitalize = "off";
		input.autocomplete = "off";
		d.appendChild(input);
	}
	const err = el("div", "err");
	err.setAttribute("role", "status");
	d.appendChild(err);

	const row = el("div", "row");
	const cancel = el("button", "plain", "Cancel");
	cancel.onclick = closeTop;
	const ok = el("button", null, confirm);
	ok.onclick = async () => {
		ok.disabled = true;
		try {
			await onConfirm?.(input ? input.value.trim() : undefined);
			closeTop();
		} catch (e) {
			err.textContent = e.message;
			ok.disabled = false;
		}
	};
	if (onConfirm) row.append(cancel, ok);
	else { ok.textContent = "Close"; row.append(ok); }
	d.appendChild(row);

	$("dialogWrap").classList.remove("hidden");
	pushBack(() => $("dialogWrap").classList.add("hidden"));
	(input || (onConfirm ? cancel : ok)).focus();
	if (input)
		input.onkeydown = (e) => {
			if (e.key === "Enter") ok.click();
		};
}

// ---------------------------------------------------------------- screens

function show(name) {
	state.screen = name;
	for (const id of ["offline", "lock", "chat", "picker", "transcript"]) $(id).classList.toggle("hidden", id !== name);
	// the composer can only be measured once it is actually on screen
	if (name === "chat") requestAnimationFrame(autoGrow);
}

// ---------------------------------------------------------------- offline

// status 0 is what api.js uses for "the fetch never got anywhere" — no server,
// no network, no Tailscale. Anything else means the PC answered, so it is a
// login problem, not a reach problem.
const isUnreachable = (err) => err?.status === 0;

let offlineTimer = null;
let offlineDelay = 0;

function stopOfflineRetries() {
	clearTimeout(offlineTimer);
	offlineTimer = null;
	offlineDelay = 0;
}

/** Shown when the bridge cannot be reached. Keeps quietly retrying by itself. */
function showOffline() {
	if (state.screen !== "offline") {
		show("offline");
		$("offlineHost").textContent = location.host;
		$("offlineSub").textContent = location.protocol === "https:"
			? "This app only works over Tailscale."
			: "This app only works over Tailscale, and this is not a Tailscale address.";
		offlineDelay = 0;
	}
	scheduleOfflineRetry();
}

function scheduleOfflineRetry() {
	clearTimeout(offlineTimer);
	// back off gently: 3s, 5s, 8s, 12s, then every 20s
	offlineDelay = Math.min(20, offlineDelay ? Math.round(offlineDelay * 1.6) : 3);
	let left = offlineDelay;
	const tick = () => {
		if (state.screen !== "offline") return;
		$("offlineStatus").textContent = left > 0 ? `Checking again in ${left}s` : "";
		if (left <= 0) return retryConnection({ auto: true });
		left -= 1;
		offlineTimer = setTimeout(tick, 1000);
	};
	tick();
}

/** One attempt to reach the PC. Lands on the right screen either way. */
async function retryConnection({ auto = false } = {}) {
	clearTimeout(offlineTimer);
	const btn = $("offlineRetry");
	if (!auto) btn.classList.add("busy");
	$("offlineStatus").textContent = "Checking…";
	try {
		state.auth = await api.authState();
	} catch (e) {
		btn.classList.remove("busy");
		if (isUnreachable(e)) return scheduleOfflineRetry();
		$("offlineStatus").textContent = e.message;
		return scheduleOfflineRetry();
	}
	btn.classList.remove("busy");
	stopOfflineRetries();
	return checkSession();

}

$("offlineRetry").onclick = () => retryConnection();

// ---------------------------------------------------------------- lock

let pin = "";

function paintPin() {
	const dots = $("pinDots");
	dots.innerHTML = "";
	for (let i = 0; i < 6; i += 1) {
		const d = el("i");
		if (i < pin.length) d.classList.add("on");
		dots.appendChild(d);
	}
}

function buildKeypad() {
	const pad = $("keypad");
	pad.innerHTML = "";
	const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];
	for (const k of keys) {
		const b = el("button");
		if (k === "") {
			b.className = "blank";
			b.tabIndex = -1;
			b.setAttribute("aria-hidden", "true");
		} else if (k === "back") {
			b.className = "flat";
			b.setAttribute("aria-label", "Delete digit");
			b.innerHTML = icon("backspace");
			b.onclick = () => {
				buzz();
				pin = pin.slice(0, -1);
				paintPin();
			};
		} else {
			b.textContent = k;
			b.onclick = () => {
				if (pin.length >= 6) return;
				buzz();
				pin += k;
				paintPin();
				if (pin.length === 6) submitPin();
			};
		}
		pad.appendChild(b);
	}
	paintPin();
}

async function submitPin() {
	const entered = pin;
	try {
		await api.loginPasscode(entered);
		localStorage.removeItem(LOCAL_LOCK);
		pin = "";
		paintPin();
		await enterApp();
	} catch (e) {
		if (isUnreachable(e)) return showOffline();
		buzz(50);
		$("lockError").textContent = e.message;
		const area = $("pinArea");
		area.classList.add("shake");
		setTimeout(() => area.classList.remove("shake"), 380);
		pin = "";
		paintPin();
	}
}

async function tryFingerprint() {
	$("lockError").textContent = "";
	try {
		await loginWithPasskey();
		localStorage.removeItem(LOCAL_LOCK);
		await enterApp();
	} catch (e) {
		// a cancelled prompt is not an error worth shouting about
		if (e.name !== "NotAllowedError" && e.name !== "AbortError") $("lockError").textContent = e.message;
		showPasscodeFallback();
	}
}

function showPasscodeFallback() {
	if (!state.auth.hasPasscode) {
		$("lockError").textContent = "No passcode is set on the PC. Run  npm run passcode  there.";
		return;
	}
	$("pinArea").classList.remove("hidden");
	$("usePasscode").classList.add("hidden");
	$("fingerBtn").classList.toggle("hidden", !state.auth.hasPasskey);
}

async function showLock() {
	// Ask first, draw second. Drawing the PIN pad before we know the PC is even
	// reachable is what used to produce "no passcode is set on the PC" when the
	// real problem was that Tailscale was off.
	let auth;
	try {
		auth = await api.authState();
	} catch (e) {
		if (isUnreachable(e)) return showOffline();
		show("lock");
		$("lockError").textContent = e.message;
		return;
	}

	stopOfflineRetries();
	state.auth = auth;
	show("lock");
	pin = "";
	$("lockError").textContent = "";
	paintPin();

	const canFinger = state.auth.canUsePasskey && state.auth.hasPasskey && passkeySupported();
	$("fingerBtn").classList.toggle("hidden", !canFinger);
	$("pinArea").classList.toggle("hidden", canFinger);
	$("usePasscode").classList.toggle("hidden", !canFinger || !state.auth.hasPasscode);
	$("lockSub").textContent = canFinger ? "Unlock to reach your PC" : "Enter your 6-digit passcode";

	if (!canFinger && !state.auth.hasPasscode) {
		$("lockError").textContent = "No passcode is set on the PC. Run  npm run passcode  there.";
	}
	(canFinger ? $("fingerBtn") : $("keypad").querySelector("button"))?.focus();
}

$("fingerBtn").onclick = tryFingerprint;
$("usePasscode").onclick = showPasscodeFallback;

async function lockNow(revoke = true) {
	loggedIn = false;
	bridge?.close();
	bridge = null;
	state.agentId = null;
	state.info = {};
	state.pending = null;
	state.agents = [];
	state.history = [];
	state.project = null;
	state.drawerMode = "projects";
	state.pick = { roots: [], folders: [], path: null };
	state.events.clear();
	state.nodes.clear();
	state.open.clear();
	state.started.clear();
	state.drafts.clear();
	state.outbox.clear();
	state.attachment = null;
	state.waiting = state.streaming = state.stopping = false;
	savedView = null;
	input.value = "";
	$("drawerSearch").value = "";
	$("pickPath").textContent = "";
	$("transcriptTitle").textContent = "";
	$("topTitle").textContent = "Pi";
	$("topStatus").textContent = "";
	$("toast").textContent = "";
	$("toast").classList.add("hidden");
	for (const id of ["messages", "pendingMessages", "transcriptMessages", "drawerList", "pickList", "sheet", "dialog", "actionsMenu"]) $(id).replaceChildren();
	recognition?.abort();
	for (const id of [...overlayIds, "scrim"]) $(id).classList.add("hidden");
	$("btnMenu").setAttribute("aria-expanded", "false");
	$("btnPlus").setAttribute("aria-expanded", "false");
	backStack.length = 0;
	history.replaceState({ depth: 0 }, "");
	syncInert();
	show("lock");
	if (revoke) {
		localStorage.setItem(LOCAL_LOCK, "1");
		try { await api.lock(); localStorage.removeItem(LOCAL_LOCK); }
		catch { return showOffline(); }
	}
	return showLock();
}
setLockHandler(() => { if (loggedIn) void lockNow(false); });

// ---------------------------------------------------------------- entering

async function enterApp() {
	loggedIn = true;
	stopOfflineRetries();
	show("chat");
	renderThread();
	connectBridge();

	// Offer the fingerprint the first time we are on an address that allows it.
	try {
		state.auth = await api.authState();
	} catch {}
	if (state.auth.canUsePasskey && !state.auth.hasPasskey && passkeySupported()) {
		setTimeout(() => { if (loggedIn && state.screen === "chat" && !overlayIds.some((id) => !$(id).classList.contains("hidden"))) offerPasskey(); }, 900);
	}
}

function offerPasskey() {
	showSheet(
		[
			{
				icon: "finger",
				label: "Add a passkey",
				onClick: async () => {
					try {
						await enrolPasskey(navigator.userAgentData?.platform || (navigator.platform || "Phone"));
						state.auth.hasPasskey = true;
						toast("Passkey added");
					} catch (e) {
						if (e.name !== "NotAllowedError") toast(e.message, 4000);
					}
				},
			},
			{ icon: "x", label: "Not now" },
		],
		{
			title: "Add a passkey?",
			note: "Use your phone’s fingerprint, face, or screen lock to unlock Connect Pi.",
		},
	);
}

// ---------------------------------------------------------------- bridge

// The socket is briefly down on every page load and after every sleep. Waiting a
// beat before saying so is the difference between "the app is alive" and a
// warning that flashes up for no reason.
let connBannerTimer = null;
function setConnBanner(on) {
	clearTimeout(connBannerTimer);
	if (!on) return $("connBanner").classList.add("hidden");
	connBannerTimer = setTimeout(() => {
		if (!bridge?.live) $("connBanner").classList.remove("hidden");
	}, 1800);
}

function connectBridge() {
	bridge?.close();
	bridge = new Bridge({
		onMessage: handleMessage,
		onOpen: () => {
			setConnBanner(false);
			if (state.agentId) bridge.send({ t: "attach", agentId: state.agentId });
			paintHeader();
			setSendButton();
		},
		// Losing the socket mid-conversation is normal — the PC sleeps, the phone
		// changes network. Say so in a slim line and heal; do not throw the thread
		// away and drop the user on a full-screen error.
		onClose: () => {
			setConnBanner(true);
			paintHeader();
			setSendButton();
		},
		// Turned away at the door: confirm with the server, which drops us to the
		// lock screen if the login really has expired.
		onRejected: () => {
			if (state.screen !== "lock") api.me().catch(() => {});
		},
	});
	bridge.connect();
}

function handleMessage(msg) {
	if (msg.t === "agents") {
		state.agents = msg.agents || [];
		renderDrawer();

		// a session we started has just come online
		if (state.pending && state.agents.some((a) => a.id === state.pending.id)) {
			const id = state.pending.id;
			state.pending = null;
			attach(id);
			return;
		}
		if (!state.pending && !state.agentId && state.agents.length) attach(state.agents[0].id);
		else syncFromAgent();
		return;
	}

	if (msg.t === "history") {
		state.history = msg.sessions || [];
		renderDrawer();
		if (!state.agentId && !state.pending) renderThread();
		return;
	}

	if (msg.t === "snapshot") {
		if (msg.agentId !== state.agentId) return;
		if (!msg.online) { paintHeader(); return; }
		const stick = !state.events.size || nearBottom();
		state.events.clear();
		state.info = msg.info || {};
		state.streaming = Boolean(msg.state?.isStreaming);
		state.waiting = Boolean(msg.state?.waiting);
		state.thinking = msg.state?.thinking || "";
		for (const event of msg.events || []) {
			state.events.set(keyOf(event), event);
			if (event.promptId) state.outbox.delete(event.promptId);
		}
		renderThread();
		syncFromAgent();
		renderOutbox();
		for (const entry of state.outbox.values()) {
			if (entry.agentId === state.agentId && ["sending", "queued"].includes(entry.status)) {
				bridge.send({ t: "receipt_status", agentId: state.agentId, id: entry.id });
			}
		}
		if (stick) scrollToEnd(true);
		return;
	}

	if (msg.t === "receipt") {
		const entry = state.outbox.get(msg.id);
		if (!entry || entry.agentId !== msg.agentId) return;
		Object.assign(entry, { status: msg.status, message: msg.message });
		renderOutbox();
		return;
	}
	if (msg.t === "event" && msg.agentId === state.agentId) {
		if (msg.e.promptId) state.outbox.delete(msg.e.promptId);
		if (msg.e.k === "run_stopped") {
			state.stopping = false;
			toast(msg.e.text || "Pi stopped.");
			setSendButton();
			return;
		}
		upsert(msg.e);
		renderOutbox();
		return;
	}
	if (msg.t === "state" && msg.agentId === state.agentId) {
		state.streaming = Boolean(msg.state?.isStreaming);
		state.waiting = Boolean(msg.state?.waiting);
		if (!state.streaming) state.stopping = false;
		state.thinking = msg.state?.thinking || state.thinking;
		if (msg.state?.name) state.info.name = msg.state.name;
		paintHeader();
		setSendButton();
		renderTypingDot();
		return;
	}
	if (msg.t === "agent_gone" && msg.agentId === state.agentId) {
		state.streaming = state.waiting = state.stopping = false;
		paintHeader();
		setSendButton();
		return;
	}

	if (msg.t === "error") toast(msg.message || "Something went wrong");
}

function saveDraft() {
	state.drafts.set(state.agentId || "", { text: input.value, image: state.attachment });
}
function restoreDraft() {
	const draft = state.drafts.get(state.agentId || "");
	input.value = draft?.text || "";
	state.attachment = draft?.image || null;
	autoGrow();
	setSendButton();
}

function attach(agentId) {
	saveDraft();
	state.agentId = agentId;
	state.info = {};
	state.streaming = state.waiting = state.stopping = false;
	state.events.clear();
	state.nodes.clear();
	state.started.clear();
	state.open.clear();
	restoreDraft();
	renderThread();
	renderOutbox();
	bridge?.send({ t: "attach", agentId });
	syncFromAgent();
}

function paintHeader() {
	const agent = state.agents.find((item) => item.id === state.agentId);
	$("topTitle").textContent = agent?.name || state.info.name || state.pending?.name || "Pi";
	let status = "";
	if (state.agentId) {
		const work = !bridge?.live || !agent ? "Disconnected" : state.waiting ? "Waiting for approval on PC" : state.stopping ? "Stopping…" : state.streaming ? "Working" : "Idle";
		status = [agent?.cwdName || state.info.cwdName, work].filter(Boolean).join(" · ");
	}
	if ($("topStatus").textContent !== status) $("topStatus").textContent = status;
}

function syncFromAgent() {
	const agent = state.agents.find((item) => item.id === state.agentId);
	if (agent) {
		state.info = { ...state.info, cwd: agent.cwd, cwdName: agent.cwdName, name: agent.name };
		state.streaming = agent.isStreaming;
		state.waiting = agent.waiting;
		state.thinking = agent.thinking || state.thinking;
	}
	paintHeader();
	setSendButton();
	renderTypingDot();
}

// ---------------------------------------------------------------- events

const keyOf = (e) => `${e.k}:${e.id != null ? e.id : `n${state.events.size}`}`;

function upsert(e) {
	const key = keyOf(e);


	const stick = nearBottom();
	state.events.set(key, e);
	$("messages").querySelector(".empty")?.remove(); // the first event replaces it
	setPlaceholder();

	const old = state.nodes.get(key);
	const fresh = renderEvent(key, e);

	if (old && fresh) old.replaceWith(fresh);
	else if (old) old.remove();
	else if (fresh) $("messages").appendChild(fresh);

	if (fresh) state.nodes.set(key, fresh);
	else state.nodes.delete(key);

	renderTypingDot();
	if (stick) scrollToEnd();
}

const textOfBlocks = (blocks) =>
	(blocks || [])
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");

// ---------------------------------------------------------------- rendering

function detailRow(key, { iconName, label, sub, status, body, prose }) {
	const wrap = el("div", "detail");
	const open = state.open.has(key);
	if (open) wrap.classList.add("open");

	const head = el("button", "detail-head");
	const mark =
		status === "running"
			? '<span class="spin"></span>'
			: status === "error"
				? `<span class="dot-err">${icon("x", "ic ic-16")}</span>`
				: status === "done"
					? `<span class="dot-ok">${icon("check", "ic ic-16")}</span>`
					: icon(iconName, "ic ic-18");
	head.innerHTML =
		`${mark}<span class="label"><b>${esc(label)}</b>${sub ? ` ${esc(sub)}` : ""}</span>` + icon("caret", "ic ic-16 caret");
	head.setAttribute("aria-expanded", String(open));
	head.onclick = () => {
		const nowOpen = !wrap.classList.contains("open");
		wrap.classList.toggle("open", nowOpen);
		bodyEl.classList.toggle("hidden", !nowOpen);
		head.setAttribute("aria-expanded", String(nowOpen));
		if (nowOpen) state.open.add(key);
		else state.open.delete(key);
	};

	const bodyEl = el("div", `detail-body${prose ? " prose" : ""}`);
	bodyEl.innerHTML = body;
	if (!open) bodyEl.classList.add("hidden");

	wrap.append(head, bodyEl);
	return wrap;
}

function renderEvent(key, e) {
	if (["done", "run_stopped"].includes(e.k)) return null;

	if (e.k === "user") {
		const n = el("div", "msg msg-user");
		const text = textOfBlocks(e.blocks) || (e.blocks?.some((b) => b.type === "image") ? "" : "(sent)");
		// Native Android text keeps short hyphenated words ("filled-in")
		// together; browser line breaking otherwise splits them at the dash.
		for (const part of text.split(/(\S{1,20}-\S{1,20})/g)) {
			if (/^\S+-\S+$/.test(part) && part.length <= 30) n.append(el("span", "keep-word", part));
			else n.append(document.createTextNode(part));
		}
		if (e.blocks?.some((b) => b.type === "image")) n.append(el("div", "attachment-label", "Image attached"));
		return n;
	}

	if (e.k === "notice") {
		return el("div", `notice ${e.level || "info"}`, e.text || "");
	}

	if (e.k === "tool") {
		const parts = [];
		if (e.args && Object.keys(e.args).length) {
			parts.push('<div class="sub">Input</div>' + esc(pretty(e.args)));
		}
		if (e.result) {
			const result = esc(e.result);
			parts.push('<div class="sub">Result</div>' + (e.result.length > 1200
				? `<details class="tool-output"><summary>Show output (${e.result.length.toLocaleString()} characters)</summary><pre>${result}</pre></details>` : result));
		}
		if (!parts.length) parts.push(esc(e.summary || ""));
		return detailRow(key, {
			iconName: "terminal",
			label: e.name || "tool",
			sub: e.summary,
			status: e.status,
			body: parts.join(""),
		});
	}

	if (e.k === "bash") {
		const tail = e.exitCode ? `<div class="sub">Exit code ${esc(e.exitCode)}</div>` : "";
		return detailRow(key, {
			iconName: "terminal",
			label: "$",
			sub: e.command,
			status: e.exitCode ? "error" : "done",
			body: esc(e.output || "(no output)") + tail,
		});
	}

	if (e.k === "assistant") {
		if (!state.started.has(key)) state.started.set(key, { at: Date.now(), secs: 0 });
		const clock = state.started.get(key);
		// freeze the duration the moment pi stops, so later re-renders keep it
		if (!e.streaming && !clock.secs) clock.secs = Math.max(1, Math.round((Date.now() - clock.at) / 1000));

		const wrap = el("div", "msg msg-ai");

		for (const b of e.blocks || []) {
			if (b.type !== "thinking" || !b.text?.trim()) continue;
			wrap.appendChild(
				detailRow(`${key}:think`, {
					iconName: "brain",
					label: e.streaming ? "Thinking" : `Thought for ${clock.secs}s`,
					body: markdown(b.text),
					prose: true,
				}),
			);
		}

		const text = textOfBlocks(e.blocks);
		if (text.trim()) {
			const body = el("div");
			body.innerHTML = markdown(text);
			wrap.appendChild(body);
		}

		for (const b of e.blocks || []) {
			if (b.type === "image") wrap.appendChild(el("div", "notice", `[${b.mimeType} image]`));
		}

		if (e.error) wrap.appendChild(el("div", "err", e.error));

		if (!e.streaming && text.trim()) wrap.appendChild(actionRow(text));
		if (!wrap.childNodes.length) return null;
		return wrap;
	}

	return null;
}

function pretty(v) {
	let s;
	try {
		s = JSON.stringify(v, null, 2);
	} catch {
		s = String(v);
	}
	return s.length > 4000 ? `${s.slice(0, 4000)}\n… (truncated)` : s;
}

function actionRow(text) {
	const row = el("div", "actions");

	const copyBtn = el("button");
	copyBtn.setAttribute("aria-label", "Copy response");
	copyBtn.innerHTML = icon("copy", "ic ic-20");
	copyBtn.onclick = async () => {
		if (await copy(text)) {
			copyBtn.classList.add("done");
			copyBtn.innerHTML = icon("check", "ic ic-20");
			setTimeout(() => {
				copyBtn.classList.remove("done");
				copyBtn.innerHTML = icon("copy", "ic ic-20");
			}, 1400);
		} else toast("Could not copy");
	};
	row.appendChild(copyBtn);

	if (window.speechSynthesis) {
		const say = el("button");
		say.setAttribute("aria-label", "Read response aloud");
		say.innerHTML = icon("speaker", "ic ic-20");
		say.onclick = () => {
			if (speechSynthesis.speaking) return speechSynthesis.cancel();
			speechSynthesis.speak(new SpeechSynthesisUtterance(text.slice(0, 3000)));
		};
		row.appendChild(say);
	}

	if (navigator.share) {
		const share = el("button");
		share.setAttribute("aria-label", "Share response");
		share.innerHTML = icon("share", "ic ic-20");
		share.onclick = () => navigator.share({ text }).catch(() => {});
		row.appendChild(share);
	}

	const more = el("button");
	more.setAttribute("aria-label", "Response actions");
	more.innerHTML = icon("kebab", "ic ic-20");
	more.onclick = () =>
		showSheet([
			{ icon: "copy", label: "Copy message", onClick: async () => toast((await copy(text)) ? "Copied" : "Could not copy") },
			{
				icon: "pc",
				label: "Open this folder on my PC",
				onClick: openOnPc,
			},
		]);
	row.appendChild(more);

	return row;
}

// The pulsing blob, shown while pi is working but not yet writing.
function renderTypingDot() {
	const existing = $("messages").querySelector(":scope > .thinking-dot");
	const last = [...state.events.values()].at(-1);
	const writing = last && last.k === "assistant" && last.streaming && textOfBlocks(last.blocks).trim();
	const want = state.streaming && !writing;

	if (want && !existing) {
		$("messages").appendChild(el("div", "thinking-dot"));
		if (nearBottom()) scrollToEnd();
	} else if (!want && existing) existing.remove();
}

function renderThread() {
	const box = $("messages");
	box.innerHTML = "";
	state.nodes.clear();
	setPlaceholder();

	const agent = state.agents.find((a) => a.id === state.agentId);

	if (state.pending) {
		const empty = el("div", "empty");
		empty.innerHTML =
			`<div class="medallion"><div class="thinking-dot"></div></div>` +
			(state.pending.resuming
				? `<h2>Reopening</h2><p>${esc(state.pending.name)}, with everything you said before.</p>`
				: `<h2>Starting pi</h2><p>in ${esc(state.pending.name)}. A brand-new folder can take half a minute.</p>`);
		box.appendChild(empty);
		return;
	}

	if (!state.agentId || (!agent && !state.events.size)) {
		const empty = el("div", "empty");
		empty.innerHTML =
			`<div class="medallion">${icon("folder", "ic")}</div>` +
			`<h2>What can I help with?</h2>` +
			`<p>Pick a folder and pi will start working there${state.history.length ? ", or reopen an earlier session from the menu" : ""}.</p>`;
		const b = el("button", "btn-primary");
		b.innerHTML = `${icon("plus", "ic ic-20")}<span>Choose a folder</span>`;
		b.onclick = openPicker;
		empty.appendChild(b);

		if (state.history.length) {
			const past = el("button", "btn-ghost");
			past.innerHTML = `${icon("refresh", "ic ic-20")}<span>Earlier sessions</span>`;
			past.onclick = openDrawer;
			empty.appendChild(past);
		}
		box.appendChild(empty);
		return;
	}

	if (!state.events.size) {
		const empty = el("div", "empty");
		empty.innerHTML =
			`<div class="medallion">${icon("terminal", "ic")}</div>` +
			`<h2>What can I help with?</h2><p>pi is running in ${esc(state.info.cwdName || "this folder")}. Ask it anything.</p>`;
		box.appendChild(empty);
		return;
	}

	for (const [key, e] of state.events) {
		const node = renderEvent(key, e);
		if (node) {
			box.appendChild(node);
			state.nodes.set(key, node);
		}
	}
	renderTypingDot();
}

// ---------------------------------------------------------------- scrolling

const nearBottom = () => {
	const t = $("thread");
	return t.scrollHeight - t.scrollTop - t.clientHeight < 130;
};

function scrollToEnd(instant = false) {
	const t = $("thread");
	requestAnimationFrame(() => {
		t.scrollTo({ top: t.scrollHeight, behavior: instant ? "auto" : "smooth" });
	});
}

$("thread").addEventListener("scroll", () => {
	$("btnJump").classList.toggle("hidden", nearBottom());
});
$("btnJump").onclick = () => scrollToEnd();

// tapping a code block's copy button, wherever it is in the thread
$("messages").addEventListener("click", async (ev) => {
	const btn = ev.target.closest(".code-copy");
	if (!btn) return;
	const code = btn.closest(".code")?.dataset.code || "";
	toast((await copy(code)) ? "Code copied" : "Could not copy");
});

// ---------------------------------------------------------------- composer

const input = $("input");

function autoGrow() {
	if (!input.getClientRects().length) return;
	input.style.height = "0px";
	const styles = getComputedStyle(input);
	const min = parseFloat(styles.minHeight);
	const max = parseFloat(styles.maxHeight);
	input.style.height = `${Math.min(Math.max(input.scrollHeight, min), max)}px`;
	input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
}

// Tapping anywhere in the rounded box puts the cursor in the field, so you do
// not have to hit the text line exactly.
document.querySelector(".composer-box").addEventListener("click", (e) => {
	if (e.target.closest("button")) return;
	input.focus();
});

function setPlaceholder() {
	input.placeholder = state.events.size ? "Reply to pi" : "Message pi";
}

function setSendButton() {
	const available = Boolean(bridge?.live && state.agents.some((agent) => agent.id === state.agentId));
	$("btnSend").disabled = !available || (!input.value.trim() && !state.attachment);
	$("btnStop").classList.toggle("hidden", !state.streaming);
	$("btnStop").disabled = !available || state.stopping;
	$("deliveryMode").classList.toggle("hidden", !state.streaming || (!input.value.trim() && !state.attachment));
	$("composeMeta").classList.toggle("hidden", $("deliveryMode").classList.contains("hidden") && !state.attachment);
	const chip = $("attachmentChip");
	chip.classList.toggle("hidden", !state.attachment);
	chip.textContent = state.attachment ? `${state.attachment.name} · Remove` : "";
	paintHeader();
}

window.addEventListener("resize", autoGrow);
input.addEventListener("input", () => { autoGrow(); setSendButton(); touch(); });
input.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
		e.preventDefault();
		if (!$("btnSend").disabled) sendPrompt();
	}
});

$("btnStop").onclick = () => {
	if (!bridge?.send({ t: "stop", agentId: state.agentId })) return toast("Pi is disconnected.");
	state.stopping = true;
	setSendButton();
};
$("attachmentChip").onclick = () => { state.attachment = null; setSendButton(); };

function renderOutbox() {
	const container = $("pendingMessages");
	container.replaceChildren();
	for (const entry of state.outbox.values()) {
		if (entry.agentId !== state.agentId) continue;
		const row = el("div", "msg msg-user", entry.text || entry.image?.name || "Message");
		const label = entry.message || ({ sending: "Sending…", queued: "Queued…", accepted: "Accepted by Pi", failed: "Could not send", unknown: "Delivery could not be confirmed" })[entry.status];
		row.append(el("div", "message-delivery", label));
		if (entry.status === "unknown") {
			const dismiss = el("button", "delivery-action", "Dismiss");
			dismiss.onclick = () => { state.outbox.delete(entry.id); renderOutbox(); };
			row.append(dismiss);
		}
		if (entry.status === "failed") {
			const edit = el("button", "delivery-action", "Restore to draft");
			edit.onclick = () => {
				input.value = [entry.text, input.value].filter(Boolean).join("\n\n");
				state.attachment ||= entry.image || null;
				state.outbox.delete(entry.id);
				autoGrow();
				setSendButton();
				renderOutbox();
				input.focus();
			};
			row.append(edit);
		}
		container.append(row);
	}
}

function sendPrompt() {
	const text = input.value.trim();
	if (!state.agentId || (!text && !state.attachment) || !bridge?.live) return;
	if (text.length > 110_000) return toast("Shorten the message before sending.");
	if (state.outbox.size >= 32) return toast("Wait for Pi to finish accepting the pending messages.");
	const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const image = state.attachment || undefined;
	const entry = { id, agentId: state.agentId, text, image, status: "sending" };
	const mode = $("delivery").value;
	if (!bridge.send({ t: "prompt", agentId: state.agentId, id, text, image, mode })) return toast("Could not send. Your draft is still here.");
	state.outbox.set(id, entry);
	input.value = "";
	state.attachment = null;
	saveDraft();
	renderOutbox();
	autoGrow();
	setSendButton();
	scrollToEnd();
	touch();
}
$("btnSend").onclick = sendPrompt;

function openActions() {
	const menu = $("actionsMenu");
	menu.replaceChildren();
	const harder = ["high", "xhigh", "max"].includes(state.thinking);
	const items = [
		{ icon: "folder", label: "New chat in a folder", action: openPicker },
		{ icon: "copy", label: "Attach text or screenshot", action: attachTextFile },
		{ icon: "pc", label: "Open on my PC", action: openOnPc },
		{ icon: "brain", label: "Think harder", selected: harder, action: () => {
			if (!state.agentId) return toast("Open a chat to change its thinking level");
			if (!bridge?.send({ t: "thinking", agentId: state.agentId, level: harder ? "medium" : "high" })) toast("Not connected to your PC");
		} },
	];
	for (const item of items) {
		const button = el("button", `action-option${item.selected ? " selected" : ""}`);
		button.innerHTML = `<span class="action-icon">${icon(item.icon)}</span><span>${item.label}</span>${item.selected ? icon("check", "ic action-check") : ""}`;
		button.onclick = () => { closeTop(); setTimeout(item.action, 80); };
		menu.append(button);
	}
	$("actionsWrap").classList.remove("hidden");
	$("btnPlus").setAttribute("aria-expanded", "true");
	pushBack(() => {
		$("actionsWrap").classList.add("hidden");
		$("btnPlus").setAttribute("aria-expanded", "false");
		$("btnPlus").focus();
	});
	menu.querySelector("button")?.focus();
}

// Text files become visible, editable prompt context. No silent uploads.
function attachTextFile() {
	const picker = document.createElement("input");
	picker.type = "file";
	picker.accept = ".txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.css,.html,.csv,.yaml,.yml,.xml,.log,.sql,image/png,image/jpeg,image/webp";
	const agentId = state.agentId;
	picker.onchange = async () => {
		const file = picker.files?.[0];
		if (!file || agentId !== state.agentId) return;
		if (["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
			try {
				const image = await resizeScreenshot(file);
				if (loggedIn && agentId === state.agentId) { state.attachment = image; setSendButton(); }
			} catch (error) { toast(error.message); }
			return;
		}
		if (file.size > 100000) return toast("Choose a text file smaller than 100 KB");
		try {
			const text = await file.text();
			if (!loggedIn || agentId !== state.agentId) return;
			if (text.includes("\0")) return toast("Choose a text or code file");
			input.value += `${input.value ? "\n\n" : ""}File: ${file.name}\n\n${text}`;
			autoGrow();
			setSendButton();
			input.focus();
		} catch { toast("Could not read that file"); }
	};
	picker.click();
}

async function resizeScreenshot(file) {
	if (file.size > 8 * 1024 * 1024) throw new Error("Choose a screenshot smaller than 8 MB.");
	const bitmap = await createImageBitmap(file);
	try {
		const canvas = document.createElement("canvas");
		const scale = Math.min(1, 1600 / Math.max(bitmap.height, bitmap.width));
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const drawing = canvas.getContext("2d", { alpha: false });
		drawing.fillStyle = "#fff";
		drawing.fillRect(0, 0, canvas.width, canvas.height);
		drawing.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		let data = canvas.toDataURL("image/jpeg", 0.82).split(",")[1];
		if (data.length > 480_000) data = canvas.toDataURL("image/jpeg", 0.60).split(",")[1];
		if (data.length > 480_000) throw new Error("That screenshot is too large. Crop it and try again.");
		return { name: file.name, data, mimeType: "image/jpeg" };
	} finally { bitmap.close(); }
}

$("btnPlus").onclick = openActions;
$("actionsScrim").onclick = closeTop;

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition;
if (SpeechRecognition) {
	const mic = $("btnMic");
	mic.classList.remove("hidden");
	recognition = new SpeechRecognition();
	let dictationAgent;
	recognition.lang = navigator.language;
	recognition.onresult = (event) => {
		if (!loggedIn || dictationAgent !== state.agentId) return;
		input.value += `${input.value ? " " : ""}${event.results[0][0].transcript}`;
		autoGrow();
		setSendButton();
	};
	recognition.onend = () => { mic.classList.remove("listening"); mic.setAttribute("aria-label", "Dictate message"); };
	recognition.onerror = () => toast("Dictation unavailable. Check microphone permission.");
	mic.onclick = () => {
		if (mic.classList.contains("listening")) return recognition.stop();
		try {
			dictationAgent = state.agentId;
			recognition.start();
			mic.classList.add("listening");
			mic.setAttribute("aria-label", "Stop dictation");
		} catch { toast("Dictation is already starting"); }
	};
}

// ---------------------------------------------------------------- drawer

function openDrawer() {
	renderDrawer();
	$("drawer").classList.remove("hidden");
	$("scrim").classList.remove("hidden");
	$("btnMenu").setAttribute("aria-expanded", "true");
	// the socket pushes history on every connect and disconnect, but a fresh
	// read here covers sessions that ended while this phone was asleep
	refreshHistory();
	pushBack(() => {
		$("drawer").classList.add("hidden");
		$("scrim").classList.add("hidden");
		$("btnMenu").setAttribute("aria-expanded", "false");
	});
	$("drawerSearchToggle").focus();
}

async function refreshHistory() {
	try {
		const { sessions } = await api.history();
		state.history = sessions || [];
		renderDrawer();
	} catch {
		// the list on screen is still the last good one; leave it alone
	}
}
$("btnMenu").onclick = openDrawer;
$("scrim").onclick = closeTop;
$("drawerSearch").addEventListener("input", renderDrawer);

function renderDrawer() {
	const list = $("drawerList");
	const q = $("drawerSearch").value.trim().toLowerCase();
	list.replaceChildren();
	const groups = projectGroups(state.agents, state.history);
	const project = groups.find((g) => g.key === state.project);
	$("drawerProjects").classList.toggle("nav-active", state.drawerMode === "projects" || Boolean(project));
	$("drawerLibrary").classList.toggle("nav-active", state.drawerMode === "all" && !project);
	$("drawerRunning").classList.toggle("nav-active", state.drawerMode === "running");
	const matches = (chat, group) => !q || `${chat.session.name || ""} ${chat.session.title || ""} ${group.name} ${group.path}`.toLowerCase().includes(q);

	if (state.drawerMode === "projects" && !project) {
		for (const group of groups) {
			if (!group.chats.some((chat) => matches(chat, group))) continue;
			const row = el("button", "project-row");
			row.innerHTML = `${icon("folder")}<span class="who"><span class="name">${esc(group.name)}</span><small>${esc(group.path)}</small></span><span class="project-count">${group.chats.length}</span>`;
			row.onclick = () => { state.project = group.key; renderDrawer(); };
			list.append(row);
		}
		if (!list.querySelector("button")) list.append(el("div", "drawer-empty", q ? "No projects found." : "Your chat folders will appear here."));

		return;
	}

	if (project) {
		const back = el("button", "drawer-row project-back");
		back.innerHTML = `${icon("back", "ic ic-20")}<span>Projects</span>`;
		back.onclick = () => { state.project = null; state.drawerMode = "projects"; renderDrawer(); };
		list.append(back, el("div", "project-title", project.name));
		const path = el("div", "project-path", project.path);
		path.title = project.path;
		list.append(path);
		const newChat = el("button", "drawer-row");
		newChat.innerHTML = `${icon("compose")}<span>New chat in project</span>`;
		newChat.onclick = () => { closeTop(); setTimeout(() => launch({ label: project.name, folder: project.path }), 80); };
		list.append(newChat);
	}

	const chats = (project ? project.chats : groups.flatMap((g) => g.chats))
		.filter((chat) => (state.drawerMode !== "running" || chat.kind === "live") && matches(chat, project || groups.find((g) => g.chats.includes(chat))))
		.sort((a, b) => b.updatedAt - a.updatedAt);
	const limited = !project && state.drawerMode === "recent" && !q;
	for (const chat of limited ? chats.slice(0, 5) : chats) {
		const s = chat.session;
		const live = chat.kind === "live";
		const active = live && s.id === state.agentId;
		const row = el("button", `sess${active ? " active" : ""}`);
		row.setAttribute("aria-current", active ? "page" : "false");
		row.title = `${s.cwd} · ${live ? s.isStreaming ? "Working now" : "Open and waiting" : ago(s.updatedAt)}`;
		row.append(el("span", "name", s.title || s.name || s.cwdName || "Untitled chat"));
		if (live) {
			const dot = el("span", `live${s.isStreaming ? "" : " idle"}`);
			dot.setAttribute("aria-label", s.isStreaming ? "Working now" : "Open and waiting");
			row.append(dot);
		}
		row.onclick = () => {
			if (!live) return openPastSession(s);
			closeTop();
			if (s.id !== state.agentId) attach(s.id);
		};
		list.append(row);
	}
	if (!chats.length) list.append(el("div", "drawer-empty", q ? "No matching chats." : state.drawerMode === "running" ? "No shared sessions are connected." : "Your conversations will appear here."));
	if (limited && chats.length > 5) {
		const more = el("button", "drawer-see-all", "See all…");
		more.onclick = () => { state.drawerMode = "all"; renderDrawer(); };
		list.append(more);
	}
}

$("drawerSearchToggle").onclick = () => {
	const box = $("drawerSearchBox");
	const visible = box.classList.toggle("hidden") === false;
	$("drawerSearchToggle").setAttribute("aria-expanded", String(visible));
	if (visible) $("drawerSearch").focus();
	else { $("drawerSearch").value = ""; renderDrawer(); }
};
$("drawerProjects").onclick = () => { state.project = null; state.drawerMode = "projects"; renderDrawer(); };
$("drawerLibrary").onclick = () => { state.project = null; state.drawerMode = "all"; renderDrawer(); };
$("drawerRunning").onclick = () => { state.project = null; state.drawerMode = "running"; renderDrawer(); };

let savedView = null;

function openTranscript(session) {
	closeTop();
	setTimeout(() => {
		if (!loggedIn) return;
		savedView = { session, before: null, busy: false, query: "" };
		$("transcriptTitle").textContent = session.title || session.cwdName;
		$("transcriptQuery").value = "";
		show("transcript");
		pushBack(() => { savedView = null; show("chat"); });
		$("transcriptBack").focus();
		void loadTranscript(true);
	}, 70);
}

async function loadTranscript(reset) {
	const view = savedView;
	if (!view || view.busy) return;
	view.busy = true;
	const messages = $("transcriptMessages");
	const status = $("transcriptStatus");
	const more = $("transcriptMore");
	if (reset) {
		view.query = $("transcriptQuery").value.trim().slice(0, 160);
		view.before = null;
		messages.replaceChildren();
	}
	status.textContent = "Loading…";
	more.classList.add("hidden");
	try {
		const { events, before } = await api.transcript(view.session.id, view.before, view.query);
		if (savedView !== view) return;
		for (const event of [...events].reverse()) {
			const node = renderEvent(`transcript:${view.session.id}:${event.k}:${event.id}`, event);
			if (node) messages.prepend(node);
		}
		view.before = before;
		status.textContent = messages.firstChild ? "" : view.query ? "No matching messages." : "This conversation has no saved messages.";
		more.classList.toggle("hidden", before == null);
	} catch (error) {
		if (savedView === view) status.textContent = error.message;
	} finally { view.busy = false; }
}

$("transcriptBack").onclick = closeTop;
$("transcriptMore").onclick = () => loadTranscript(false);
$("transcriptSearch").onsubmit = (event) => { event.preventDefault(); void loadTranscript(true); };

function openPastSession(session) {
	showSheet([
		{ icon: "text", label: "View conversation", sub: "Read and search saved messages", onClick: () => openTranscript(session) },
		{
			icon: "refresh", label: "Continue this session",
			sub: `Resume with ${turnsLabel(session)}${weightLabel(session) ? " of context" : ""}`,
			onClick: () => launch({ label: session.cwdName, resumeId: session.id }),
		},
		{ icon: "compose", label: "Start fresh in this folder", onClick: () => launch({ label: session.cwdName, folder: session.cwd }) },
		{ icon: "pc", label: "Open on my PC", onClick: () => openOnPc({ sessionId: session.id }) },
	], { title: session.title || session.cwdName, note: `${session.cwdName} · last used ${ago(session.updatedAt)}` });
}

$("drawerNew").onclick = () => {
	const project = projectGroups(state.agents, state.history).find((g) => g.key === state.project);
	closeTop();
	setTimeout(() => project ? launch({ label: project.name, folder: project.path }) : openPicker(), 80);
};

$("drawerSettings").onclick = () => {
	closeTop();
	setTimeout(openSettings, 80);
};

// ---------------------------------------------------------------- menus

function currentFolder() {
	const a = state.agents.find((x) => x.id === state.agentId);
	return a?.cwd || state.info.cwd || "";
}

async function openOnPc(selection = { agentId: state.agentId }) {
	if (!selection.agentId && !selection.sessionId) return toast("Choose a session first.");
	try {
		const { exact, live, alreadyOnPc } = await api.openInWarp(selection);
		if (alreadyOnPc) return toast("This Pi session is already open on your PC.");
		if (!exact) return toast("Warp opened. The Pi start command is on your PC clipboard.", 4400);
		toast(live ? "Warp opened. Close the phone session before pasting the resume command." : "Warp opened. Paste the exact resume command on your PC.", 5500);
	} catch (error) { toast(error.message, 4400); }
}

async function openChanges() {
	if (!state.agentId) return toast("Choose a session first.");
	try {
		const { status, diff, truncated } = await api.changes(state.agentId);
		showDialog({
			title: "Changed files",
			body: status || "Your working tree is clean.",
			detail: diff,
			detailNote: truncated ? "Preview is truncated. Open the repository on your PC for the full diff." : "",
		});
	} catch (error) { toast(error.message, 4400); }
}

$("btnTitle").onclick = $("btnMore").onclick = () => {
	const a = state.agents.find((x) => x.id === state.agentId);
	showSheet(
		[
			a ? { icon: "pc", label: "Open on my PC", sub: "Warp and the session command", onClick: () => openOnPc() } : null,
			a ? { icon: "newfolder", label: "Changed files", sub: "View Git status and diff", onClick: openChanges } : null,
			{
				icon: "copy",
				label: "Copy folder path",
				onClick: async () => toast((await copy(currentFolder())) ? "Path copied" : "Could not copy"),
			},
			{ icon: "compose", label: "New session in a folder", onClick: openPicker },
			a ? {
				icon: "brain", label: "Thinking level", sub: state.thinking || "default",
				onClick: () => showSheet(
					["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => ({
						icon: state.thinking === level ? "check" : "brain",
						label: level === "off" ? "Off" : level === "xhigh" ? "Extra high" : level[0].toUpperCase() + level.slice(1),
						onClick: () => {
							if (!bridge?.send({ t: "thinking", agentId: a.id, level })) toast("Not connected to your PC");
						},
					})), { title: "Thinking level", note: "Higher levels may take longer and cost more. Pi may limit the level for this model." }),
			} : null,
			a ? {
				icon: "text", label: "Name session", sub: "Show a useful title in pi",
				onClick: () => showDialog({
					title: "Name session", placeholder: "Session name", value: a.name,
					onConfirm: (name) => {
						if (!name || name.length > 100) throw new Error("Use a name of 1–100 characters.");
						if (!bridge?.send({ t: "rename", agentId: a.id, name })) throw new Error("Not connected to your PC.");
					},
				}),
			} : null,
			a?.startedByPhone
				? {
						icon: "delete",
						label: "Close this session",
						danger: true,
						onClick: () =>
							showDialog({
								title: "Close this session?",
								body: `pi will stop working in ${a.cwdName}. Anything it has already written to disk stays.`,
								confirm: "Close",
								onConfirm: async () => {
									const result = await api.stopSession(a.id);
									if (!result.stopping) throw new Error("Pi could not close this session.");
									for (let i = 0; i < 20; i += 1) {
										await new Promise((done) => setTimeout(done, 250));
										const { status } = await api.sessionStatus(a.id);
										if (["stopped", "exited", "unknown"].includes(status)) {
											toast("Session closed");
											return;
										}
									}
									throw new Error("Pi is still closing. Check the connection status.");
								},
							}),
					}
				: null,
		],
		{ title: a ? a.name || a.cwdName : "pi", note: a?.cwd || "No session attached" },
	);
};

function openTheme() {
	const chosen = currentTheme();
	showSheet(
		THEMES.map((t) => ({
			icon: t.id === chosen ? "check" : "theme",
			label: t.label,
			onClick: () => {
				applyTheme(t.id);
				buzz();
			},
		})),
		{ title: "Appearance" },
	);
}

function openTextSize() {
	const current = textSize();
	showSheet(
		TEXT_SIZES.map((size) => ({
			icon: size.px === current ? "check" : "text",
			label: size.label,
			onClick: () => {
				applyTextSize(size.px);
				buzz();
			},
		})),
		{ title: "Text size", note: "The whole app scales, not just the words." },
	);
}

function openBubble() {
	const chosen = currentBubble();
	showSheet(
		BUBBLES.map((b) => ({
			swatch: bubbleSwatch(b),
			on: b.id === chosen,
			label: b.label,
			sub: b.sub,
			onClick: () => {
				applyBubble(b.id);
				buzz();
			},
		})),
		{ title: "Bubble colour", note: "Your own messages. Each colour has a light and a dark version." },
	);
}

async function manageDevices() {
	try {
		const { passkeys, sessions } = await api.devices();
		const row = (kind, label, item) => ({
			icon: kind === "passkey" ? "finger" : "lock", label: `${label} · ${item.label || "Phone"}`,
			sub: `Added ${new Date(item.createdAt).toLocaleDateString()}`,
			onClick: () => showDialog({
				title: kind === "passkey" ? "Remove this passkey?" : "Revoke this login?",
				body: kind === "passkey" ? "Active logins that used this passkey will also be signed out." : "This device will need to unlock again.",
				confirm: "Remove",
				onConfirm: async () => { await api.removeDevice(kind, item.id); toast("Access removed"); },
			}),
		});
		showSheet([
			...passkeys.map((item) => row("passkey", "Passkey", item)),
			...sessions.map((item) => row("session", "Login", item)),
			{ icon: "x", label: "Close" },
		], { title: "Devices and passkeys", note: passkeys.length || sessions.length ? "Choose an entry to remove its access." : "No passkeys or other logins to manage." });
	} catch (error) { toast(error.message); }
}

function openSettings() {
	const secure = state.auth.canUsePasskey && passkeySupported();
	showSheet(
		[
			secure
				? {
						icon: "finger",
						label: state.auth.hasPasskey ? "Add another passkey" : "Add a passkey",
						onClick: async () => {
							try {
								await enrolPasskey(navigator.userAgentData?.platform || (navigator.platform || "Phone"));
								state.auth.hasPasskey = true;
								toast("Passkey added");
							} catch (e) {
								if (e.name !== "NotAllowedError") toast(e.message, 4000);
							}
						},
					}
				: {
						icon: "finger",
						label: "Passkeys",
						sub: "Needs the Tailscale https address",
						onClick: () =>
							showDialog({
								title: "Not on this address",
								body: "Open the Tailscale HTTPS address shown by /phone url on your PC to use passkeys.",
								confirm: "Got it",

							}),
					},
			{
				icon: "theme",
				label: "Appearance",
				sub: THEMES.find((t) => t.id === currentTheme())?.label,
				onClick: openTheme,
			},
			{
				// the row wears the colour it sets
				swatch: bubbleSwatch(BUBBLES.find((b) => b.id === currentBubble()) || BUBBLES[0]),
				label: "Bubble colour",
				sub: BUBBLES.find((b) => b.id === currentBubble())?.label,
				onClick: openBubble,
			},
			{
				icon: "text",
				label: "Text size",
				sub: TEXT_SIZES.find((t) => t.px === textSize())?.label,
				onClick: openTextSize,
			},
			{ icon: "pc", label: "Devices and passkeys", onClick: manageDevices },
		{ icon: "lock", label: "Lock now", onClick: () => lockNow() },
			{
				icon: "info",
				label: "About",
				onClick: () =>
					showDialog({
						title: "connect-pi",
						body: `Talking to ${location.host}. Sessions auto-lock after ${state.auth.lockAfterMinutes ?? 60} minutes idle.`,
						confirm: "Close",

					}),
			},
		],
		{ title: "Settings" },
	);
}

// ---------------------------------------------------------------- picker

async function openPicker() {
	show("picker");
	pushBack(() => show("chat"));
	$("pickBack").focus();
	await loadRoots();
}

$("pickBack").onclick = closeTop;

async function loadRoots() {
	try {
		const { roots } = await api.roots();
		state.pick = { path: null, name: "", parent: null, folders: [], roots };
		// With a single root — the whole D drive — a list of one is a wasted tap,
		// so open it straight away.
		if (roots.length === 1 && roots[0].exists) return loadFolder(roots[0].path);
		renderPicker();
	} catch (e) {
		toast(e.message, 4000);
	}
}

async function loadFolder(path) {
	try {
		const data = await api.folders(path);
		state.pick = { ...data, roots: state.pick.roots };
		renderPicker();
		$("pickList").scrollTop = 0;
	} catch (e) {
		toast(e.message, 4000);
	}
}

/** A deep path trimmed to its last few folders, so it fits a phone header.
 *  The header used to lean on CSS direction:rtl for this, which rendered a
 *  drive root backwards. */
function shortPath(full, keep = 3) {
	const parts = String(full || "").split(/[\\/]/).filter(Boolean);
	if (parts.length <= keep) return full;
	return `\u2026\\${parts.slice(-keep).join("\\")}`;
}

function renderPicker() {
	const list = $("pickList");
	list.innerHTML = "";
	const atTop = !state.pick.path;

	$("pickPath").textContent = atTop ? "Folders available on your phone" : shortPath(state.pick.path);
	$("pickStart").disabled = atTop;
	$("pickNewFolder").disabled = atTop;
	$("pickNewFolder").style.opacity = atTop ? "0.4" : "1";

	if (atTop) {
		if (!state.pick.roots.length) list.appendChild(el("div", "pick-empty", "Run /phone folders on your PC to share a project."));
		for (const r of state.pick.roots) {
			const row = el("button", "pick-row");
			row.innerHTML = `${icon("folder")}<div class="who"><div class="name">${esc(r.name)}</div><div class="where">${esc(r.path)}${r.exists ? "" : " — missing"}</div></div>${icon("chevron", "ic ic-20 chev")}`;
			row.disabled = !r.exists;
			row.onclick = () => loadFolder(r.path);
			list.appendChild(row);
		}
		return;
	}

	if (state.pick.parent) {
		const up = el("button", "pick-row up");
		up.innerHTML = `${icon("back")}<div class="who"><div class="name">Up one level</div></div>`;
		up.onclick = () => loadFolder(state.pick.parent);
		list.appendChild(up);
	} else if (state.pick.roots.length > 1) {
		// only worth offering when there is more than one root to go back to
		const up = el("button", "pick-row up");
		up.innerHTML = `${icon("back")}<div class="who"><div class="name">Back to all folders</div></div>`;
		up.onclick = loadRoots;
		list.appendChild(up);
	}

	if (!state.pick.folders.length) {
		list.appendChild(el("div", "pick-empty", "Nothing inside this folder. You can still start pi here."));
	}

	for (const f of state.pick.folders) {
		const row = el("button", "pick-row");
		row.innerHTML = `${icon("folder")}<div class="who"><div class="name">${esc(f.name)}</div></div>${icon("chevron", "ic ic-20 chev")}`;
		row.onclick = () => loadFolder(f.path);
		list.appendChild(row);
	}
}

$("pickNewFolder").onclick = () => {
	if (!state.pick.path) return;
	showDialog({
		title: "New folder",
		body: `Inside ${state.pick.name || state.pick.path}`,
		placeholder: "folder name",
		confirm: "Create",
		onConfirm: async (name) => {
			const { path } = await api.createFolder(state.pick.path, name);
			await loadFolder(path);
			toast("Folder created");
		},
	});
};

/**
 * Boot a pi session and hand the screen over to it. Either a fresh one in
 * `folder`, or `resumeId` to reopen a past conversation — the PC works out the
 * folder for a resume, so nothing here can point pi somewhere it should not go.
 */
let launching = false;
async function launch({ label, folder, resumeId }) {
	if (launching || state.pending || !loggedIn) return false;
	launching = true;
	try {
		const session = resumeId ? await api.resumeSession(resumeId) : await api.startSession(folder);
		if (!loggedIn) return false;
		closeTop();
		show("chat");
		if (state.agents.some((agent) => agent.id === session.id)) {
			attach(session.id);
			return true;
		}
		saveDraft();
		state.pending = { id: session.id, name: label || folder, resuming: Boolean(resumeId) };
		state.agentId = null;
		restoreDraft();
		state.events.clear();
		renderThread();
		renderOutbox();
		syncFromAgent();
		void watchPending(state.pending);
		return true;
	} catch (error) {
		toast(error.message, 4500);
		return false;
	} finally { launching = false; }
}

$("pickStart").onclick = async () => {
	const folder = state.pick.path;
	if (!folder) return;
	const button = $("pickStart");
	button.disabled = true;
	button.textContent = "Starting…";
	try { await launch({ label: state.pick.name || folder, folder }); }
	finally {
		button.disabled = !state.pick.path;
		button.textContent = "Start pi here";
	}
};

async function watchPending(pending) {
	let problem;
	for (let attempt = 0; attempt < 35 && state.pending === pending; attempt += 1) {
		await new Promise((done) => setTimeout(done, 1500));
		if (state.pending !== pending) return;
		try {
			const result = await api.sessionStatus(pending.id);
			if (state.pending !== pending) return;
			if (["exited", "stopped", "unknown"].includes(result.status)) {
				problem = result.message || "Pi closed before it connected.";
				break;
			}
		} catch { /* the live socket can still reconnect */ }
	}
	if (state.pending !== pending) return;
	state.pending = null;
	renderThread();
	syncFromAgent();
	toast(problem || "Pi has not connected. Check /phone doctor on your PC.", 5000);
}

// ---------------------------------------------------------------- session life

// Every API call slides the 60-minute idle timer forward, so touch the server
// when you actually do something. Doing it on a timer instead would mean the
// app never locks.
function touch() {
	if (state.screen === "lock") return;
	const now = Date.now();
	if (now - state.lastTouch < 60000) return;
	state.lastTouch = now;
	api.me().catch(() => {});
}
document.addEventListener("pointerdown", touch, { passive: true });

document.addEventListener("visibilitychange", () => {
	if (document.visibilityState !== "visible" || !loggedIn || state.screen === "lock") return;
	state.lastTouch = 0;
	api.me()
		.then(() => {
			if (!bridge?.live) connectBridge();
		})
		.catch((e) => {
			// only take over the screen when there is no conversation to protect
			if (isUnreachable(e) && !state.events.size) showOffline();
		});
});

// ---------------------------------------------------------------- boot

async function checkSession() {
	try {
		if (localStorage.getItem(LOCAL_LOCK)) {
			await api.lock();
			localStorage.removeItem(LOCAL_LOCK);
		}
		await api.me(false);
		await enterApp();
	} catch (error) {
		if (isUnreachable(error)) return showOffline();
		return showLock();
	}
}

async function boot() {
	localStorage.removeItem("connect-pi.token"); // invalidate the old PWA's browser-stored credential
	applyTextSize(textSize());
	paintThemeColor();
	paintBubble();
	buildKeypad();
	setSendButton();
	autoGrow();
	await checkSession();
}

boot();

if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// Keep keyboard navigation inside the current modal, and let Escape go back.
document.addEventListener("keydown", (event) => {
	if (state.screen === "lock" && !$("pinArea").classList.contains("hidden") && !event.altKey && !event.metaKey && !event.ctrlKey) {
		const key = /^\d$/.test(event.key) ? [...$("keypad").querySelectorAll("button")].find((button) => button.textContent === event.key)
			: event.key === "Backspace" ? $("keypad").querySelector(".flat") : null;
		if (key) { event.preventDefault(); key.click(); return; }
	}
	if (event.key === "Escape" && backStack.length) { event.preventDefault(); closeTop(); return; }
	if (event.key !== "Tab") return;
	const modal = [$("dialogWrap"), $("sheetWrap"), $("actionsWrap"), $("drawer")].find((node) => !node.classList.contains("hidden"));
	if (!modal) return;
	const controls = [...modal.querySelectorAll('button, input, textarea, select, summary, a[href], [tabindex="0"]')].filter((node) => !node.disabled && node.getClientRects().length);
	const first = controls[0], last = controls.at(-1);
	if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
	else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
