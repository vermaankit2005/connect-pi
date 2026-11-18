// Project identity is the full working folder, never just its display name.
export function projectKey(path) {
	const raw = String(path || "");
	const normalized = raw.replace(/\\/g, "/").replace(/\/+$/, "") || raw;
	return /^(?:[a-z]:|[\\/]{2})/i.test(raw) ? normalized.toLowerCase() : normalized;
}

export function projectGroups(agents, history) {
	const groups = new Map();
	const liveIds = new Set(agents.map((a) => a.piSessionId).filter(Boolean));
	for (const [kind, sessions] of [["live", agents], ["past", history]]) {
		for (const session of sessions) {
			if (kind === "past" && liveIds.has(session.id)) continue;
			const key = projectKey(session.cwd);
			if (!groups.has(key)) groups.set(key, {
				key, path: session.cwd || "", name: session.cwdName || session.cwd || "Other chats", chats: [], updatedAt: 0,
			});
			const group = groups.get(key);
			const updatedAt = Number(session.updatedAt || session.connectedAt || 0);
			group.chats.push({ kind, session, updatedAt });
			group.updatedAt = Math.max(group.updatedAt, updatedAt);
		}
	}
	return [...groups.values()].map((g) => ({ ...g, chats: g.chats.sort((a, b) => b.updatedAt - a.updatedAt) }))
		.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}
