// Minimal service worker: it exists so the app is installable and the shell
// loads instantly. Everything real happens over the websocket, so there is no
// offline data to cache.
const SHELL = "cpi-shell-v13";
const FILES = [
	"/",
	"/index.html",
	"/styles.css",
	"/app.js",
	"/projects.js",
	"/fonts/roboto-400.ttf",
	"/fonts/roboto-500.ttf",
	"/fonts/roboto-600.ttf",
	"/fonts/roboto-700.ttf",
	"/api.js",
	"/markdown.js",
	"/manifest.webmanifest",
	"/icons/icon-192.png",
];

self.addEventListener("install", (e) => {
	e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
	e.waitUntil(
		caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (e) => {
	const url = new URL(e.request.url);
	if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
	// network first, fall back to the cached shell when the desktop is asleep
	e.respondWith(
		fetch(e.request)
			.then((res) => {
				const copy = res.clone();
				caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
				return res;
			})
			.catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html"))),
	);
});
