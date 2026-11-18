import { parentPort } from "node:worker_threads";
import { listSessions, readTranscript, safeSessionFile } from "./history.js";

let cached = { key: "", expires: 0, entries: [] };
const PAGE_BYTES = 512 * 1024;
const PAGE_EVENTS = 60;
const MAX_QUERY_SCAN = 10_000;
let lastTranscript;

function history({ agentDir, roots, refresh = false }) {
	const key = JSON.stringify([agentDir, roots]);
	if (refresh || cached.key !== key || Date.now() > cached.expires) {
		cached = { key, expires: Date.now() + 3000, entries: listSessions({ agentDir, roots }) };
	}
	return cached.entries;
}

function page(events, before, search) {
	const end = Math.min(before ?? events.length, events.length);
	const startLimit = Math.max(0, end - (search ? MAX_QUERY_SCAN : PAGE_EVENTS));
	const value = [];
	let bytes = 0;
	let cursor = end;
	while (cursor > startLimit && value.length < PAGE_EVENTS) {
		const event = events[cursor - 1];
		const encoded = JSON.stringify(event);
		if (search && ![...(event.blocks || []).map((block) => block.text || ""), event.result, event.text, event.command]
			.filter(Boolean).join("\n").toLowerCase().includes(search)) {
			cursor -= 1;
			continue;
		}
		const size = Buffer.byteLength(encoded);
		if (value.length && bytes + size > PAGE_BYTES) break;
		bytes += size;
		value.unshift(event);
		cursor -= 1;
	}
	return { events: value, before: cursor > 0 ? cursor : null };
}

parentPort.on("message", ({ id, action, options }) => {
	try {
		let result;
		if (action === "list") result = history(options);
		if (action === "find") result = history(options).find((entry) => entry.id === options.sessionId);
		if (action === "page") {
			const file = safeSessionFile(options.file, options.agentDir);
			if (!file) result = page([], 0, options.search);
			else {
				if (file !== lastTranscript?.file || Date.now() > lastTranscript.expires) {
					lastTranscript = { file, expires: Date.now() + 3000, events: readTranscript(file) };
				}
				result = page(lastTranscript.events, options.before, options.search);
			}
		}
		parentPort.postMessage({ id, result });
	} catch (error) {
		parentPort.postMessage({ id, error: error.message });
	}
});
