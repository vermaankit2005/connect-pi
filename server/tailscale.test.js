import assert from "node:assert/strict";
import test from "node:test";
import { createServe } from "./tailscale.js";

const host = "pc.test.ts.net:443";
const target = "http://127.0.0.1:4317";
function fake({ root, funnel = false } = {}) {
	const calls = [];
	const state = {
		TCP: { 443: { HTTPS: true } },
		Web: { [host]: { Handlers: { "/other": { Proxy: "http://127.0.0.1:8080" }, ...(root ? { "/": { Proxy: root } } : {}) } } },
		AllowFunnel: { [host]: funnel },
	};
	const handlers = state.Web[host].Handlers;
	const exec = (args) => {
		calls.push(args);
		if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: "pc.test.ts.net." } });
		if (args[1] === "status") return JSON.stringify(state);
		if (args.at(-1) === "off") delete handlers["/"];
		else handlers["/"] = { Proxy: args.at(-1) };
		return "";
	};
	return { exec, handlers, calls };
}

test("Serve adds and removes only its own root rule", () => {
	const { exec, handlers, calls } = fake();
	const serve = createServe(exec);
	assert.equal(serve.start(4317).url, "https://pc.test.ts.net");
	assert.equal(handlers["/"].Proxy, target);
	assert.equal(serve.stop(), true);
	assert.deepEqual(Object.keys(handlers), ["/other"]);
	assert.deepEqual(calls.at(-1), ["serve", "--bg", "--https=443", "--set-path=/", "off"]);
});

test("pre-existing, replaced and public rules are left alone", () => {
	for (const input of [{ root: target }, { root: "http://127.0.0.1:8080" }, { root: target, funnel: true }]) {
		const { exec, handlers } = fake(input);
		const serve = createServe(exec);
		assert.equal(Boolean(serve.start(4317).url), input.root === target && !input.funnel);
		assert.equal(serve.stop(), false);
		assert.equal(handlers["/"].Proxy, input.root);
	}
	const { exec, handlers } = fake();
	const serve = createServe(exec);
	serve.start(4317);
	handlers["/"].Proxy = "http://127.0.0.1:8080";
	assert.equal(serve.stop(), false);
});
