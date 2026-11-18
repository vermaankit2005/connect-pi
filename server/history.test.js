import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, readTranscript } from "./history.js";
import { historyJob } from "./history-client.js";

test("history replays only the active pi branch", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "connect-pi-history-"));
  const cwd = join(agentDir, "project");
  mkdirSync(cwd);
  const dir = join(agentDir, "sessions", "--project--");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.jsonl");
  const entry = (id, parentId, role, text) => ({
    type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z",
    message: { role, content: [{ type: "text", text }] },
  });
  writeFileSync(file, [
    { type: "session", version: 3, id: "session-1", cwd, timestamp: "2026-01-01T00:00:00Z" },
    entry("root", null, "user", "original"),
    entry("old", "root", "assistant", "abandoned answer"),
    entry("new", "root", "assistant", "active answer"),
    entry("last", "new", "user", "follow up"),
    { type: "session_info", id: "name", parentId: "last", name: "Phone work", timestamp: "2026-01-01T00:00:00Z" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  try {
    const events = readTranscript(file);
    assert.deepEqual(events.map((e) => e.blocks?.[0]?.text), ["original", "active answer", "follow up"]);
    const [session] = listSessions({ agentDir, roots: [agentDir] });
    assert.equal(session.userTurns, 2);
    assert.equal(session.replies, 1);
    assert.equal(session.id, "session-1");
    assert.equal(session.title, "Phone work");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("large chats remain listed and saved transcript search stays paginated", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "connect-pi-large-history-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const cwd = join(agentDir, "project");
  const privateCwd = join(agentDir, "private");
  mkdirSync(cwd);
  mkdirSync(privateCwd);
  const dir = join(agentDir, "sessions", "--project--");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.jsonl");
  const rows = [
    { type: "session", id: "large", cwd },
    { type: "message", message: { role: "user", content: "find this phrase" } },
    ...Array.from({ length: 80 }, (_, i) => ({ type: "message", message: { role: "assistant", content: `Reply ${i} ${"x".repeat(110_000)}` } })),
  ];
  writeFileSync(file, rows.map((entry) => JSON.stringify(entry)).join("\n"));
  writeFileSync(join(dir, "private.jsonl"), [{ type: "session", id: "private", cwd: privateCwd }, rows[1]].map((entry) => JSON.stringify(entry)).join("\n"));
  const options = { agentDir, roots: [cwd] };
  const list = await historyJob("list", options);
  assert.deepEqual(list.map((session) => session.id), ["large"]);
  assert(list[0].bytes > 8 * 1024 * 1024);
  const first = await historyJob("page", { ...options, file });
  assert(first.before > 0);
  assert(first.events.at(-1).blocks[0].text.startsWith("Reply 79 "));
  const search = await historyJob("page", { ...options, file, search: "find this phrase" });
  assert.deepEqual(search.events.map((event) => event.blocks[0].text), ["find this phrase"]);
});
