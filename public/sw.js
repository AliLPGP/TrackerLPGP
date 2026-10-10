const CACHE = 'lpgp-v74';
const STATIC = [
  '/',
  '/style.css',
  '/app.js',
  '/login.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Core app code/markup that must always reflect the latest deploy
function isCoreAsset(url) {
  return url.pathname === '/' ||
         url.pathname.endsWith('/app.js') ||
         url.pathname.endsWith('/style.css') ||
         url.pathname.endsWith('.html');
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept API calls — always go to network
  if (url.pathname.includes('/api/')) return;

  // Navigation requests: network-first so the app always loads fresh, fall back to cache offline
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }

  // Core app assets (app.js / style.css / HTML): network-first, refresh cache, fall back offline
  if (url.origin === self.location.origin && isCoreAsset(url)) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Everything else (fonts, icons, etc.): cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }))
  );
});
