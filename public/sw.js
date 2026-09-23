// Pass-through service worker. It exists only to make the app installable
// (Chrome on Android wants a worker with a fetch handler). It caches nothing,
// so the app never serves stale data.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Drop any caches left by an earlier worker, then take over open tabs.
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
