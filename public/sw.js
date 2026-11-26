const CACHE_NAME = 'zju-ardf-nav-v5';

function scopeUrl(relPath) {
  return new URL(relPath, self.registration.scope).href;
}

self.addEventListener('install', (event) => {
  const shell = [
    scopeUrl('./'),
    scopeUrl('./index.html'),
    scopeUrl('./manifest.webmanifest'),
    scopeUrl('./icon.svg'),
  ];
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(shell))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never intercept Amap JS API / dynamic map tile / walking API requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // Navigation requests: network-first, fall back to cached index.html when offline
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(scopeUrl('./index.html'), clone));
          return res;
        })
        .catch(() => caches.match(scopeUrl('./index.html'))),
    );
    return;
  }

  // Built static JS/CSS/icon assets: stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    }),
  );
});
