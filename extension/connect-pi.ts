// connect-pi — lets your phone drive this pi session.
//
// This runs inside your normal desktop pi. It opens a websocket to the
// connect-pi bridge on localhost, forwards everything that happens here to
// your phone, and injects anything you type on the phone as a real user
// message — exactly as if you had typed it at the keyboard.
//
// If the bridge is not running, this sits quietly and retries forever. It
// never blocks pi from starting and never touches your session otherwise.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".connect-pi.json");
const STOP_TEXT =
	"STOP. Abandon the current task immediately. Do not run any more tools. Briefly say what you had done so far, then wait for my next instruction.";
const STATUS_KEY = "connect-pi";
const UPDATE_THROTTLE_MS = 90; // how often streaming text is pushed to the phone
const MAX_TEXT = 4000; // cap on any single blob we ship to the phone

type BridgeConfig = { port?: number; agentToken?: string };

function readBridgeConfig(): BridgeConfig | null {
	try {
		if (!existsSync(CONFIG_PATH)) return null;
		const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		return cfg?.agentToken ? cfg : null;
	} catch {
		return null;
	}
}

// Turn a tool's arguments into the one-liner shown on the phone's tool card.
function summarize(args: any): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, any>;
	const first = a.command ?? a.path ?? a.file_path ?? a.filePath ?? a.pattern ?? a.query ?? a.url ?? a.name;
	const s = typeof first === "string" ? first : safeJson(a);
	return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

function safeJson(v: any): string {
	try {
		return JSON.stringify(v) ?? "";
	} catch {
		return "";
	}
}

// Content blocks arrive in a few shapes; flatten to something the phone renders.
function flatten(content: any): any[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const out: any[] = [];
	for (const b of content) {
		if (!b || typeof b !== "object") continue;
		if (b.type === "text") out.push({ type: "text", text: String(b.text ?? "") });
		else if (b.type === "thinking") out.push({ type: "thinking", text: String(b.thinking ?? "") });
		else if (b.type === "toolCall") out.push({ type: "toolCall", id: b.id, name: b.name, summary: summarize(b.arguments) });
		else if (b.type === "image") out.push({ type: "image", mimeType: b.mimeType || "image/png" });
	}
	return out;
}

function textOf(content: any, limit = MAX_TEXT): string {
	const s = flatten(content)
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
	return s.length > limit ? `${s.slice(0, limit)}\n… (truncated)` : s;
}

export default function connectPi(pi: ExtensionAPI) {
	const cfg = readBridgeConfig();

	let ws: WebSocket | null = null;
	let connected = false;
	let watchers = 0;
	let retry = 0;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let shuttingDown = false;

	let isStreaming = false;
	let stopRequested = false;
	let cwd = process.cwd();
	let modelName = "";
	let thinking = "";
	let activeContext: any = null;
	let ui: any = null;
	let seq = 0;

	// Stable per-session id, so a phone reattaches to the same conversation
	// after either side reconnects.
	const agentId = `${basename(cwd) || "pi"}-${process.pid}`;

	// pi's own id for this conversation, and the file it is being written to.
	// The bridge uses these to tell which entry in the phone's history list is
	// the one running right now — including sessions you started at the
	// keyboard, which the bridge otherwise knows nothing about.
	let piSessionId = "";
	let piSessionFile = "";
	const throttle = new Map<string, number>();

	function raw(obj: any) {
		if (ws && ws.readyState === 1) {
			try {
				ws.send(JSON.stringify(obj));
			} catch {
				// broken pipe; the close handler reconnects
			}
		}
	}

	function emit(e: any, throttleKey?: string) {
		if (throttleKey) {
			const now = Date.now();
			if (now - (throttle.get(throttleKey) || 0) < UPDATE_THROTTLE_MS) return;
			throttle.set(throttleKey, now);
		}
		raw({ t: "event", e: { ...e, ts: e.ts ?? Date.now() } });
	}

	function pushState() {
		raw({ t: "state", state: { isStreaming, model: modelName, thinking, cwd } });
	}

	function setStatus() {
		if (!ui) return;
		try {
			if (!cfg) return;
			if (!connected) ui.setStatus(STATUS_KEY, "phone: offline");
			else if (watchers > 0) ui.setStatus(STATUS_KEY, `phone: connected (${watchers})`);
			else ui.setStatus(STATUS_KEY, "phone: ready");
		} catch {
			// the status bar is a nicety; never let it break the session
		}
	}

	// ---------------------------------------------------------- connection

	function connect() {
		if (shuttingDown || !cfg) return;
		let socket: WebSocket;
		try {
			socket = new WebSocket(`ws://127.0.0.1:${cfg.port || 4317}/agent?token=${cfg.agentToken}`);
		} catch {
			return scheduleRetry();
		}
		ws = socket;

		socket.addEventListener("open", () => {
			connected = true;
			retry = 0;
			raw({
				t: "hello",
				info: {
					id: agentId,
					cwd,
					cwdName: basename(cwd),
					sessionId: agentId,
					piSessionId,
					piSessionFile,
					name: (typeof pi.getSessionName === "function" && pi.getSessionName()) || basename(cwd),
					pid: process.pid,
				},
				state: { isStreaming, model: modelName, thinking, cwd },
			});
			setStatus();
		});

		socket.addEventListener("message", (ev: any) => {
			let msg: any;
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			if (msg.t === "watchers") {
				watchers = msg.count || 0;
				setStatus();
			} else if (msg.t === "prompt") {
				fromPhone(String(msg.text || ""), msg.mode);
			} else if (msg.t === "stop") {
				requestStop();
			} else if (msg.t === "thinking") {
				const allowed = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
				if (allowed.includes(msg.level)) {
					pi.setThinkingLevel(msg.level);
					thinking = pi.getThinkingLevel();
					pushState();
				}
			} else if (msg.t === "rename") {
				const name = String(msg.name || "").trim();
				if (name && name.length <= 100) pi.setSessionName(name);
			}
		});

		socket.addEventListener("close", () => {
			connected = false;
			ws = null;
			setStatus();
			scheduleRetry();
		});
		socket.addEventListener("error", () => {
			try {
				socket.close();
			} catch (err) {
				console.error("connect-pi: could not close socket", err);
			}
		});
	}

	function scheduleRetry() {
		if (shuttingDown || retryTimer) return;
		retry = Math.min(retry + 1, 8);
		retryTimer = setTimeout(() => {
			retryTimer = null;
			connect();
		}, Math.min(30000, 1000 * 2 ** retry));
		(retryTimer as any)?.unref?.();
	}

	// ---------------------------------------------------------- inbound

	function fromPhone(text: string, mode?: string) {
		if (!text.trim()) return;
		stopRequested = false;
		try {
			// expandPromptTemplates lets you fire /commands and skills from the phone
			if (isStreaming) {
				pi.sendUserMessage(text, { deliverAs: mode === "followUp" ? "followUp" : "steer", expandPromptTemplates: true });
				emit({ k: "notice", id: `n${seq++}`, level: "info", text: "Queued — pi will pick this up after the current step." });
			} else {
				pi.sendUserMessage(text, { expandPromptTemplates: true });
			}
		} catch (err: any) {
			emit({ k: "notice", id: `n${seq++}`, level: "error", text: `Could not send: ${err?.message || err}` });
		}
	}

	// Current pi aborts the active run (including queued work). Keep the tool
	// gate as a fallback for older installs where abort is not available.
	function requestStop() {
		if (!isStreaming) {
			emit({ k: "notice", id: `n${seq++}`, level: "info", text: "Nothing is running." });
			return;
		}
		stopRequested = true;
		if (typeof activeContext?.abort === "function") {
			activeContext.abort();
		} else {
			try { pi.sendUserMessage(STOP_TEXT, { deliverAs: "steer" }); }
			catch (err) { console.error("connect-pi: stop fallback failed", err); }
		}
		emit({ k: "notice", id: `n${seq++}`, level: "warn", text: "Stop requested from phone." });
	}

	// ---------------------------------------------------------- outbound

	pi.on("session_start", async (_event, ctx: any) => {
		ui = ctx.hasUI ? ctx.ui : null;
		cwd = ctx.cwd || cwd;
		modelName = ctx.model?.id || ctx.model?.name || "";
		thinking = pi.getThinkingLevel();
		activeContext = ctx;
		shuttingDown = false;
		// Best effort: older pi builds may not expose the session manager here,
		// and a missing id only costs the phone a "running now" badge.
		try {
			piSessionId = ctx.sessionManager?.getSessionId?.() || "";
			piSessionFile = ctx.sessionManager?.getSessionFile?.() || "";
		} catch (err) {
			console.error("connect-pi: session metadata unavailable", err);
		}
		if (!cfg) return; // bridge never set up on this machine — stay out of the way
		connect();
		setStatus();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		activeContext = null;
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = null;
		const old = ws;
		ws = null;
		connected = false;
		try { old?.close(); }
		catch (err) { console.error("connect-pi: shutdown socket failed", err); }
	});

	pi.on("session_info_changed", async () => {
		raw({ t: "state", state: { name: pi.getSessionName?.() } });
	});

	pi.on("model_select", async (event: any) => {
		modelName = event?.model?.id || event?.model?.name || modelName;
		pushState();
	});

	pi.on("thinking_level_select", async (event: any) => {
		thinking = event.level;
		pushState();
	});

	pi.on("session_compact", async () => {
		emit({ k: "notice", id: `k${seq++}`, level: "info", text: "Conversation compacted to save space." });
	});

	pi.on("agent_start", async (_event, ctx: any) => {
		activeContext = ctx;
		isStreaming = true;
		stopRequested = false;
		pushState();
	});

	// agent_end can be followed by auto-retry or auto-compaction, so only
	// agent_settled means "pi has really stopped".
	pi.on("agent_settled", async () => {
		isStreaming = false;
		stopRequested = false;
		pushState();
		emit({ k: "done", id: `end${seq++}` });
	});

	pi.on("message_start", async (event: any) => {
		const m = event?.message;
		if (!m) return;
		if (m.role === "user") {
			const blocks = flatten(m.content);
			// our own stop instruction is machinery, not something you typed
			if (blocks.length === 1 && blocks[0].type === "text" && blocks[0].text.trim() === STOP_TEXT) return;
			emit({ k: "user", id: `u${seq++}`, blocks, ts: m.timestamp });
		} else if (m.role === "custom" && m.display) {
			emit({ k: "notice", id: `c${seq++}`, level: "info", text: textOf(m.content, 600) });
		} else if (m.role === "compactionSummary") {
			emit({ k: "notice", id: `k${seq++}`, level: "info", text: "Conversation compacted to save space." });
		}
	});

	// One assistant message = one id. Updates overwrite it in place, here and in
	// the bridge's replay buffer, so the phone shows text growing rather than a
	// wall of fragments.
	let assistantId: string | null = null;

	pi.on("message_update", async (event: any) => {
		const m = event?.message;
		if (!m || m.role !== "assistant") return;
		if (!assistantId) assistantId = `a${seq++}`;
		emit({ k: "assistant", id: assistantId, blocks: flatten(m.content), streaming: true }, assistantId);
	});

	pi.on("message_end", async (event: any) => {
		const m = event?.message;
		if (!m) return;
		if (m.role === "assistant") {
			const id = assistantId || `a${seq++}`;
			assistantId = null;
			throttle.delete(id);
			emit({
				k: "assistant",
				id,
				blocks: flatten(m.content),
				streaming: false,
				usage: m.usage ? { tokens: m.usage.totalTokens, cost: m.usage.cost?.total } : undefined,
				error: m.errorMessage,
			});
		} else if (m.role === "bashExecution") {
			emit({
				k: "bash",
				id: `b${seq++}`,
				command: m.command,
				output: String(m.output || "").slice(0, MAX_TEXT),
				exitCode: m.exitCode,
			});
		}
	});

	// tool_execution_end carries no args, so hold on to them from the start
	// event or the phone's tool card would lose its subtitle mid-run.
	const pendingArgs = new Map<string, any>();

	pi.on("tool_execution_start", async (event: any) => {
		pendingArgs.set(event.toolCallId, event.args);
		emit({ k: "tool", id: event.toolCallId, name: event.toolName, summary: summarize(event.args), args: event.args, status: "running" });
	});

	pi.on("tool_execution_end", async (event: any) => {
		const args = pendingArgs.get(event.toolCallId);
		pendingArgs.delete(event.toolCallId);
		emit({
			k: "tool",
			id: event.toolCallId,
			name: event.toolName,
			summary: summarize(args),
			args,
			status: event.isError ? "error" : "done",
			result: textOf(event.result?.content ?? event.result),
		});
	});

	// The hard half of the Stop button.
	pi.on("tool_call", async () => {
		if (!stopRequested) return undefined;
		return { block: true, reason: "Stopped by the user from their phone. Do not run further tools.", terminate: true };
	});

	// ---------------------------------------------------------- command

	pi.registerCommand("phone", {
		description: "Show connect-pi status (control this session from your phone)",
		handler: async (_args: string, ctx: any) => {
			if (!cfg) {
				ctx.ui?.notify(`No bridge config at ${CONFIG_PATH}. Start the connect-pi server once to create it.`, "warn");
				return;
			}
			ctx.ui?.notify(
				[
					connected ? "Bridge: connected" : "Bridge: NOT connected — is `npm start` running?",
					`Phones watching: ${watchers}`,
					`Port: ${cfg.port || 4317}`,
					`Session id: ${agentId}`,
				].join("\n"),
				connected ? "success" : "warn",
			);
		},
	});
}
