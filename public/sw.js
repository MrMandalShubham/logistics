/*
 * The rider service worker.
 *
 * Deliberately dull: cache the shell so the app opens with no signal,
 * and let everything else fall through to the network.
 *
 * It does NOT queue writes. The outbox is in IndexedDB, driven by the
 * page, because a background sync that the page cannot see is a
 * delivery nobody can account for. Browser support for the `sync`
 * event is also uneven enough that relying on it would mean a rider
 * discovering, hours later, that their completion never left the phone.
 */

const SHELL = "logistics-shell-v1";

// The bare minimum to render something useful with no network. Task
// DATA is not cached here — it is personal, and it belongs to the
// outbox/IndexedDB side where it can be cleared on sign-out.
const SHELL_URLS = ["/me", "/offline"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never cache a write, and never cache the API. A rider acting on a
  // stale task is worse than a rider seeing an error.
  if (request.method !== "GET" || new URL(request.url).pathname.startsWith("/api/")) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((res) => {
        // Keep the shell fresh while there is signal.
        if (res.ok && SHELL_URLS.some((u) => request.url.endsWith(u))) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        return cached ?? caches.match("/offline");
      }),
  );
});
