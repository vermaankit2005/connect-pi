// Every pi conversation this PC has ever had, so the phone can list them and
// pick one up again.
//
// pi keeps one .jsonl per session under <agent dir>/sessions/<encoded cwd>/.
// Each line is one entry; the first is a header carrying the session id and
// the folder it ran in. It does not matter whether the session was started at
// the keyboard or from the phone — they all land here, which is what lets one
// list cover both.
//
// We only ever READ these files. Resuming is done by handing pi the session id
// on the command line and letting pi open its own file.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";

const MAX_PARSE_BYTES = 8 * 1024 * 1024; // a session this big is a runaway, not a chat
const TITLE_CHARS = 90;
const MAX_TEXT = 4000; // same cap the extension uses when streaming live

// pi's own sentinel for the phone's Stop button. It is machinery, not
// something the user typed, so it never belongs in a title or a replay.
const STOP_TEXT =
	"STOP. Abandon the current task immediately. Do not run any more tools. Briefly say what you had done so far, then wait for my next instruction.";

export const sessionsRoot = (agentDir) => join(agentDir, "sessions");

// ---------------------------------------------------------------- shapes

// The phone renders exactly one event vocabulary. These two helpers mirror
// extension/connect-pi.ts on purpose: a replayed session has to arrive looking
// identical to a live one, or the same conversation would render two ways.

function summarize(args) {
	if (!args || typeof args !== "object") return "";
	const first = args.command ?? args.path ?? args.file_path ?? args.filePath ?? args.pattern ?? args.query ?? args.url ?? args.name;
	let s = typeof first === "string" ? first : "";
	if (!s) {
		try {
			s = JSON.stringify(args) ?? "";
		} catch {
			s = "";
		}
	}
	return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

function flatten(content) {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const out = [];
	for (const b of content) {
		if (!b || typeof b !== "object") continue;
		if (b.type === "text") out.push({ type: "text", text: String(b.text ?? "") });
		else if (b.type === "thinking") out.push({ type: "thinking", text: String(b.thinking ?? "") });
		else if (b.type === "toolCall") out.push({ type: "toolCall", id: b.id, name: b.name, summary: summarize(b.arguments) });
		else if (b.type === "image") out.push({ type: "image", mimeType: b.mimeType || "image/png" });
	}
	return out;
}

function textOf(content, limit = MAX_TEXT) {
	const s = flatten(content)
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
	return s.length > limit ? `${s.slice(0, limit)}\n… (truncated)` : s;
}

const isStopSentinel = (blocks) =>
	blocks.length === 1 && blocks[0].type === "text" && blocks[0].text.trim() === STOP_TEXT;

// ---------------------------------------------------------------- reading

function parseFile(path) {
	const text = readFileSync(path, "utf8");
	const out = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// a half-written last line is normal while pi is running; skip it
		}
	}
	return out;
}

// Modern pi stores alternate branches in the same file. Only the latest
// leaf's ancestry is the current conversation; replaying every line mixes
// abandoned branches into the phone transcript.
function activeEntries(entries) {
	const nodes = entries.filter((e) => e.type !== "session" && e.id && "parentId" in e);
	if (!nodes.length) return entries; // legacy linear sessions
	const byId = new Map(nodes.map((e) => [e.id, e]));
	const path = [];
	const seen = new Set();
	let node = nodes.at(-1);
	while (node && !seen.has(node.id)) {
		path.push(node);
		seen.add(node.id);
		node = node.parentId == null ? null : byId.get(node.parentId);
	}
	return [entries.find((e) => e.type === "session"), ...path.reverse()].filter(Boolean);
}

/**
 * Everything the drawer needs about one session, plus the entries so the caller
 * can build a transcript without reading the file twice.
 */
function readSession(path, stats) {
	const entries = activeEntries(parseFile(path));
	const header = entries.find((e) => e.type === "session");
	if (!header) return null;

	let title = "";
	let sessionName = "";
	let userTurns = 0;
	let replies = 0;

	for (const e of entries) {
		if (e.type === "session_info") sessionName = e.name || "";
		if (e.type !== "message") continue;
		const role = e.message?.role;
		if (role === "user") {
			const blocks = flatten(e.message.content);
			if (isStopSentinel(blocks)) continue;
			userTurns += 1;
			if (!title) {
				const t = textOf(e.message.content, TITLE_CHARS * 3).replace(/\s+/g, " ").trim();
				if (t) title = t.length > TITLE_CHARS ? `${t.slice(0, TITLE_CHARS)}…` : t;
			}
		} else if (role === "assistant") {
			replies += 1;
		}
	}

	return {
		entries,
		meta: {
			id: String(header.id || ""),
			path,
			cwd: String(header.cwd || ""),
			cwdName: basename(String(header.cwd || "")) || "pi",
			title: sessionName || title,
			userTurns,
			replies,
			bytes: stats.size,
			startedAt: Date.parse(header.timestamp) || stats.birthtimeMs || stats.mtimeMs,
			updatedAt: stats.mtimeMs,
		},
	};
}

// Parsing every session on every drawer open would be silly, and these files
// only ever grow, so a size+mtime stamp is a perfectly good cache key.
const cache = new Map(); // path -> { stamp, meta }

function metaFor(path) {
	let stats;
	try {
		stats = statSync(path);
	} catch {
		return null;
	}
	if (stats.size === 0 || stats.size > MAX_PARSE_BYTES) return null;

	const stamp = `${stats.mtimeMs}:${stats.size}`;
	const hit = cache.get(path);
	if (hit && hit.stamp === stamp) return hit.meta;

	let read;
	try {
		read = readSession(path, stats);
	} catch {
		return null; // unreadable or mid-write; it will be picked up next time
	}
	if (!read) return null;

	cache.set(path, { stamp, meta: read.meta });
	if (cache.size > 400) cache.delete(cache.keys().next().value);
	return read.meta;
}

const within = (child, parent) => {
	const c = child.toLowerCase();
	const p = parent.toLowerCase();
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
};

/**
 * Every session on this PC, newest activity first.
 *
 * `canResume` is false for sessions that ran outside the allowed roots — they
 * still show, because hiding them would make the list quietly incomplete, but
 * the phone will not start pi there.
 */
export function listSessions({ agentDir, roots = [] }) {
	const root = sessionsRoot(agentDir);
	let dirs;
	try {
		dirs = readdirSync(root, { withFileTypes: true });
	} catch {
		return []; // no sessions dir yet: pi has never run on this machine
	}

	const out = [];
	for (const d of dirs) {
		if (!d.isDirectory()) continue;
		let files;
		try {
			files = readdirSync(join(root, d.name));
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.endsWith(".jsonl")) continue;
			const meta = metaFor(join(root, d.name, f));
			// A session with nothing in it is an aborted launch, not history.
			if (!meta || !meta.cwd || !meta.userTurns) continue;
			out.push({ ...meta, canResume: roots.some((r) => within(meta.cwd, r)) });
		}
	}

	out.sort((a, b) => b.updatedAt - a.updatedAt);
	return out;
}

/** One session by its id, or null. Used to validate a resume request. */
export function findSession({ agentDir, roots = [] }, id) {
	if (!id) return null;
	return listSessions({ agentDir, roots }).find((s) => s.id === id) || null;
}

// ---------------------------------------------------------------- transcript

/**
 * Turn a session file back into the events the phone already knows how to
 * draw, so a resumed conversation shows its own history instead of an
 * unnerving blank thread with pi silently remembering everything.
 *
 * Ids are prefixed with "h" because the extension restarts its counter at zero
 * in the new process — without the prefix, the first live reply would land on
 * the same buffer key as a replayed one and overwrite it.
 */
export function readTranscript(path) {
	let entries;
	try {
		const stats = statSync(path);
		if (stats.size > MAX_PARSE_BYTES) return [];
		entries = activeEntries(parseFile(path));
	} catch {
		return [];
	}

	const events = [];
	const calls = new Map(); // toolCallId -> { name, args } from the assistant turn that asked
	let n = 0;

	for (const e of entries) {
		if (e.type === "compaction") {
			events.push({ k: "notice", id: `hk${n++}`, level: "info", text: "Conversation compacted to save space." });
			continue;
		}
		if (e.type !== "message") continue;

		const m = e.message;
		const ts = Date.parse(e.timestamp) || undefined;

		if (m.role === "user") {
			const blocks = flatten(m.content);
			if (!blocks.length || isStopSentinel(blocks)) continue;
			events.push({ k: "user", id: `hu${n++}`, blocks, ts });
		} else if (m.role === "assistant") {
			for (const b of m.content || []) {
				if (b?.type === "toolCall") calls.set(b.id, { name: b.name, args: b.arguments });
			}
			const blocks = flatten(m.content);
			if (!blocks.length) continue;
			events.push({
				k: "assistant",
				id: `ha${n++}`,
				blocks,
				streaming: false,
				ts,
				usage: m.usage ? { tokens: m.usage.totalTokens, cost: m.usage.cost?.total } : undefined,
				error: m.errorMessage,
			});
		} else if (m.role === "toolResult") {
			const asked = calls.get(m.toolCallId) || {};
			events.push({
				k: "tool",
				id: m.toolCallId || `ht${n++}`,
				name: m.toolName || asked.name || "tool",
				summary: summarize(asked.args),
				args: asked.args,
				status: m.isError ? "error" : "done",
				result: textOf(m.content),
				ts,
			});
		}
	}

	return events;
}
