// Read-only compatibility check against the locally installed pi CLI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detectPi } from "../server/sessions.js";

const pi = detectPi();
assert(pi.ok, "pi CLI not found; set PI_CLI to its cli.js");
console.log(`pi CLI: ${pi.cli}`);
const folder = mkdtempSync(join(tmpdir(), "connect-pi-smoke-"));
const child = spawn(process.execPath, [pi.cli, "--mode", "rpc", "--no-session", "--no-extensions", "-e", resolve("extension/connect-pi.ts")], {
  cwd: folder,
  env: { ...process.env, PI_CODING_AGENT_DIR: pi.agentDir },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let stdout = "";
let stderr = "";
try {
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Pi RPC startup timed out: ${stderr.slice(-500)}`)); }, 45000);
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    child.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`Pi exited before get_state (${code}): ${stderr.slice(-500)}`)); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    child.stdout.on("data", (b) => {
      stdout += b.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop();
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === "smoke" && msg.type === "response") { clearTimeout(timeout); resolve(msg); }
        } catch { /* Pi may print startup diagnostics to stderr; ignore incomplete lines. */ }
      }
    });
    child.stdin.write(JSON.stringify({ id: "smoke", type: "get_state" }) + "\n");
  });
  assert.equal(result.success, true, `RPC get_state failed: ${JSON.stringify(result)}`);
  console.log(`RPC startup OK: ${result.data?.model?.id || "no model selected"}`);
} finally {
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((done) => child.once("close", done));
  child.stdin.end();
  child.kill();
  await exited;
  rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
if (stderr) console.log(`pi diagnostics: ${stderr.slice(-500)}`);
