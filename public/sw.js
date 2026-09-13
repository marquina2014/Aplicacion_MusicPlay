const CACHE_NAME = 'spotify-v10';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(keys.map(k => caches.delete(k)));
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Do not intercept API calls
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Network First with no-cache to guarantee instantaneous updates
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' }).catch(() => caches.match(event.request))
  );
});

