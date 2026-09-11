const CACHE_NAME = 'spotify-v5';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Do NOT cache API calls or audio streaming
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Network First, Cache Fallback (Ensures user always sees latest code on reload)
  event.respondWith(
    fetch(event.request)
      .then(networkResponse => {
        if (event.request.method === 'GET' && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
