import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// Match test files in Node rather than depending on the invoking shell's glob handling.
const files = ["server", "web"].flatMap((dir) => readdirSync(dir)
	.filter((file) => file.endsWith(".test.js")).map((file) => join(dir, file)));
const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], {
	encoding: "utf8",
	maxBuffer: 2 * 1024 * 1024,
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
if (result.error) console.error(result.error.message);
if (result.status !== 0 && process.env.GITHUB_ACTIONS === "true") {
	const report = ([result.stderr, result.stdout].filter(Boolean).join("\n") || result.error?.message || "Node test runner failed.").slice(-10000);
	const escaped = report.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
	console.log(`::error title=Node test failure::${escaped}`);
}
process.exitCode = result.status ?? 1;
