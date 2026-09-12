/*
 * Rode service worker.
 *
 * Strategy:
 *   - hashed assets under /assets/: cache-first, forever (the hash changes when the content does)
 *   - the shell (/, /index.html, manifest, icons): network-first, cache fallback so the
 *     app opens from the home screen with no connection and shows the last-known state
 *   - /api and /ws: never touched; the store handles offline itself
 *
 * A new deploy changes the CACHE name below only when this file changes; assets are
 * addressed by hash so stale entries are harmless and pruned on activate.
 */
const CACHE = 'rode-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // Shell and everything else: network first, fall back to cache, then to the shell.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (req.mode === 'navigate' || SHELL.includes(url.pathname))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy));
        }
        return res;
      })
      .catch(async () => {
        const c = await caches.open(CACHE);
        return (await c.match(req)) ?? (await c.match('/')) ?? Response.error();
      }),
  );
});
