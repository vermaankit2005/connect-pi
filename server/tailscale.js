// Manage only the private HTTPS root that this bridge adds.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const windowsCli = "C:\\Program Files\\Tailscale\\tailscale.exe";
const command = () => process.platform === "win32" && existsSync(windowsCli) ? windowsCli : "tailscale";
const run = (args) => execFileSync(command(), args, {
	encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
});

const errorText = (error) => String(error.stderr || error.message).trim().slice(0, 800);
const privateHttps = ["serve", "--bg", "--https=443", "--set-path=/"];

function identity(exec) {
	const status = JSON.parse(exec(["status", "--json"]));
	const name = status.Self?.DNSName?.replace(/\.$/, "").toLowerCase();
	if (status.BackendState !== "Running" || !name) {
		throw new Error("Tailscale is installed but disconnected. Sign in on this PC and switch it on.");
	}
	if (!/^[a-z0-9.-]+\.ts\.net$/.test(name)) throw new Error("This device has no Tailscale HTTPS name. Enable MagicDNS and HTTPS for your tailnet.");
	return { name, url: `https://${name}` };
}

export function tailscaleStatus(exec = run) {
	try { return { url: identity(exec).url, problem: null }; }
	catch (error) {
		return { url: null, problem: error.code === "ENOENT" ? "Tailscale was not found. Install it on this PC." : errorText(error) };
	}
}

// An injected runner keeps policy tests independent of the user's tailnet.
export function createServe(exec = run) {
	let owned = null;
	const config = () => JSON.parse(exec(["serve", "status", "--json"]));
	const current = (state, host) => state?.Web?.[host]?.Handlers?.["/"];
	const privateRule = (state, host, target) =>
		!state?.AllowFunnel?.[host] && current(state, host)?.Proxy === target && state?.TCP?.["443"]?.HTTPS;
	return {
		start(port) {
			const status = tailscaleStatus(exec);
			if (!status.url) return status;
			const host = `${new URL(status.url).hostname}:443`;
			const target = `http://127.0.0.1:${port}`;
			try {
				const state = config();
				if (privateRule(state, host, target)) return status; // borrowed, never cleaned up
				if (state?.AllowFunnel?.[host] || current(state, host) ||
					(state?.TCP?.["443"] && !state.TCP["443"].HTTPS)) {
					return { url: null, problem: "Tailscale port 443 already has a conflicting Serve or Funnel rule. It was left in place." };
				}
				exec([...privateHttps, target]);
				owned = { host, target };
				if (!privateRule(config(), host, target)) return { url: null, problem: "Could not verify the private HTTPS rule. Check Tailscale Serve status." };
				return status;
			} catch (error) {
				return { url: null, problem: errorText(error) };
			}
		},
		stop() {
			if (!owned) return false;
			const { host, target } = owned;
			owned = null;
			try {
				if (!privateRule(config(), host, target)) return false;
				exec([...privateHttps, "off"]);
				return true;
			} catch { return false; }
		},
	};
}
