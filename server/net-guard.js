// Who is even allowed to open a socket to us.
//
// Two rings, and both are hard boundaries rather than polite requests:
//
//   always allowed  - this PC itself, and Tailscale (100.64.0.0/10)
//   optional        - your own home network, if you switch it on
//
// The home-network ring only ever covers private address ranges. Those cannot
// be routed across the internet at all, so switching it on exposes the bridge
// to your house and to nothing beyond it. Anything with a public address is
// refused whether the switch is on or off.

const TAILSCALE_V6_PREFIX = "fd7a:115c:a1e0"; // Tailscale's IPv6 block

function normalize(ip) {
	if (!ip) return "";
	// node reports IPv4 over IPv6 sockets as ::ffff:192.168.0.5
	return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

const octets = (ip) => {
	const m = normalize(ip).match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	return m ? m.slice(1).map(Number) : null;
};

export function isLoopback(ip) {
	const a = normalize(ip);
	if (a === "::1") return true;
	const o = octets(a);
	return Boolean(o && o[0] === 127);
}

export function isTailscale(ip) {
	const a = normalize(ip);
	if (a.toLowerCase().startsWith(TAILSCALE_V6_PREFIX)) return true;
	const o = octets(a);
	// 100.64.0.0/10 → second octet 64..127
	return Boolean(o && o[0] === 100 && o[1] >= 64 && o[1] <= 127);
}

/** RFC1918 plus IPv6 link-local: addresses the internet cannot reach. */
export function isPrivateLan(ip) {
	const a = normalize(ip);
	if (a.toLowerCase().startsWith("fe80:")) return true;
	const o = octets(a);
	if (!o) return false;
	if (o[0] === 10) return true;
	if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
	if (o[0] === 192 && o[1] === 168) return true;
	return false;
}

export function isAllowedRemote(ip, { allowLan = false } = {}) {
	if (isLoopback(ip) || isTailscale(ip)) return true;
	return Boolean(allowLan && isPrivateLan(ip));
}

export function describeRemote(ip) {
	const a = normalize(ip);
	if (isLoopback(a)) return "this PC";
	if (isTailscale(a)) return `Tailscale ${a}`;
	if (isPrivateLan(a)) return `home network ${a}`;
	return a;
}

/**
 * Hang this on an http.Server. Sockets from anywhere else are dropped before a
 * single byte of the app is served — a stranger does not even get a login page
 * to guess at.
 *
 * `isLanAllowed` is a function, not a value, so the home-network switch can be
 * flipped without restarting the bridge.
 */
export function guardServer(server, { isLanAllowed = () => false, onBlocked } = {}) {
	server.on("connection", (socket) => {
		const ip = socket.remoteAddress;
		if (!isAllowedRemote(ip, { allowLan: isLanAllowed() })) {
			onBlocked?.(normalize(ip));
			socket.destroy();
		}
	});
}
