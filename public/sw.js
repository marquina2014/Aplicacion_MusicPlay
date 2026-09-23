const CACHE_NAME = 'musicplay-shell-v14';

const APP_SHELL = [
  '/',
  '/index.html',
  '/css/spotify.css?v=14',
  '/js/supabase.js',
  '/js/supabase-config.js?v=14',
  '/js/audio-cache.js?v=14',
  '/js/player.js?v=14',
  '/js/app.js?v=14',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(APP_SHELL).catch(err => {
        console.warn('Pre-cache error (ignoring to prevent install failure):', err);
      });
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(k => {
          if (k !== CACHE_NAME) {
            return caches.delete(k);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Audio streams and search APIs are handled directly or via IndexedDB
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Network First with Cache Fallback for offline resilience
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then(response => {
        if (response && response.status === 200) {
          const resClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html') || caches.match('/');
          }
        });
      })
  );
});
