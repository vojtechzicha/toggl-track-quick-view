// Minimal pass-through service worker.
//
// Its sole purpose is to make the app installable as a PWA (some browsers,
// notably Chrome on Android, only surface the install prompt when a service
// worker with a fetch handler is registered). It deliberately does NOT cache
// anything — every request goes straight to the network, so the app remains
// strictly online and never serves stale data.

self.addEventListener('install', () => {
  // Activate this worker immediately instead of waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take control of open clients right away, and drop any caches that might
  // have been left behind by an earlier version of this worker.
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  // Pure pass-through: forward to the network, no caching, no offline fallback.
  event.respondWith(fetch(event.request));
});
