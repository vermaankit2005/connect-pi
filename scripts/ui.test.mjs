import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { createServer } from "node:net";
import { chromium } from "playwright";

test("phone UI keeps the active project, draft and controls in view", async (t) => {
	const probe = createServer();
	probe.listen(0, "127.0.0.1");
	await once(probe, "listening");
	const { port } = probe.address();
	await new Promise((done) => probe.close(done));
	const fixture = spawn(process.execPath, ["scripts/ui-preview.mjs"], {
		env: { ...process.env, CONNECT_PI_PREVIEW_PORT: String(port) },
		stdio: ["ignore", "pipe", "inherit"],
	});
	t.after(async () => {
		if (fixture.exitCode !== null) return;
		const exit = once(fixture, "exit");
		fixture.kill();
		await exit;
	});
	await Promise.race([
		once(fixture.stdout, "data"),
		once(fixture, "exit").then(([code]) => { throw new Error(`UI fixture exited with code ${code}.`); }),
	]);
	const executablePath = process.env.CONNECT_PI_CHROMIUM;
	const browser = await chromium.launch(executablePath ? {
		executablePath, args: ["--no-sandbox", "--single-process", "--no-zygote"],
	} : {});
	t.after(() => browser.close());
	const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block" });
	page.setDefaultTimeout(8000);
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));

	await page.goto(`http://127.0.0.1:${port}`);
	await page.getByText("Hey! What can I help you with?").waitFor();
	assert.match(await page.locator("#topStatus").textContent(), /demo · Idle/);
	for (const [width, height] of [[320, 568], [844, 390], [1280, 800], [390, 844]]) {
		await page.setViewportSize({ width, height });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
		assert(await page.locator("#input").isVisible());
	}

	const input = page.getByRole("textbox", { name: "Message", exact: true });
	await input.fill("Draft for demo");
	await page.getByRole("button", { name: "Sessions" }).click();
	await page.getByRole("button", { name: "All chats" }).click();
	await page.getByRole("button", { name: "Other chat" }).click();
	assert.equal(await input.inputValue(), "");
	await input.fill("Draft for other");
	await page.getByRole("button", { name: "Sessions" }).click();
	await page.locator("#drawerList").getByRole("button", { name: "Hello" }).click();
	assert.equal(await input.inputValue(), "Draft for demo");

	await input.fill("Simulate a rejected draft");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await page.getByRole("button", { name: "Restore to draft" }).click();
	assert.equal(await input.inputValue(), "Simulate a rejected draft");
	await input.fill("Make a change");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await page.getByRole("button", { name: "Stop run" }).waitFor();
	await input.fill("Something to do afterwards");
	assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isEnabled(), true);
	await page.getByRole("button", { name: "Stop run" }).click();
	await page.getByText("Pi stopped.", { exact: true }).waitFor();

	await page.getByRole("button", { name: "Sessions" }).click();
	await page.getByRole("button", { name: "Getting started" }).click();
	await page.getByRole("button", { name: "View conversation" }).waitFor();
	assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest("#sheet"))), true);
	await page.keyboard.press("Tab");
	assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest("#sheet"))), true);
	await page.getByRole("button", { name: "View conversation" }).click();
	await page.getByText("Show me a saved message.").waitFor();
	await page.getByRole("searchbox", { name: "Search this conversation" }).fill("missing");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await page.getByText("No matching messages.").waitFor();
	assert.deepEqual(errors, []);
});
