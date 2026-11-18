import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, readTranscript } from "./history.js";

test("history replays only the active pi branch", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "connect-pi-history-"));
  const cwd = join(agentDir, "project");
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
