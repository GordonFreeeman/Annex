// Annex service worker: keeps the app usable with no server running (installed app / offline).
// Only same-origin app files are cached; nothing else is ever fetched.
const VERSION = "__VERSION__";
const CACHE = "annex-" + VERSION;
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

self.addEventListener("install", (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k.startsWith("annex-") && k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener("fetch", (e) => {
    const url = new URL(e.request.url);
    if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
    // Network first (picks up updated files while the local server runs), cache when offline.
    e.respondWith(
        fetch(e.request)
            .then((res) => {
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(e.request.mode === "navigate" ? "./index.html" : e.request, copy));
                }
                return res;
            })
            .catch(() =>
                caches.match(e.request.mode === "navigate" ? "./index.html" : e.request, { ignoreSearch: true }).then((r) => r || caches.match("./index.html")),
            ),
    );
});
