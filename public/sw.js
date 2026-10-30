/*
 * Service worker — makes the app open offline and load instantly.
 *
 * Strategy:
 *  - Page loads (navigations): network first, falling back to the cached page
 *    when offline. New deployments show up on the next launch with signal.
 *  - The app's own files (JS, CSS, icons): stale-while-revalidate — served
 *    from cache immediately and refreshed in the background. Vite gives built
 *    files unique hashed names, so a stale copy is never mixed with new code.
 *  - Other sites (e.g. the market-data API) are NOT touched here; price
 *    caching lives in the app's own database, where rate limits are respected.
 *
 * Bump CACHE_VERSION to discard old caches after a breaking change.
 */
const CACHE_VERSION = 'v2';
const CACHE = `portfolio-tracker-${CACHE_VERSION}`;
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('portfolio-tracker-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The page sends the files it already loaded (see src/app/pwa.ts).
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'CACHE_URLS' || !Array.isArray(data.urls)) return;
  const urls = data.urls.filter((u) => typeof u === 'string' && new URL(u).origin === self.location.origin);
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(urls.map((u) => cache.match(u).then((hit) => hit || cache.add(u).catch(() => undefined)))),
    ),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html').then((cached) => cached || Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached || Response.error());
        return cached || network;
      }),
    ),
  );
});
