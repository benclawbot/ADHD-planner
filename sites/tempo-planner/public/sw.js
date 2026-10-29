const CACHE = 'tempo-shell-v6';
const CACHE_PREFIX = 'tempo-shell-';
const SHELL = [
  '/src/', '/src/index.html', '/src/app.js', '/src/model.js', '/src/subtasks.js', '/src/planning.js', '/src/recurrence.js', '/src/sync-client.js', '/src/manifest.webmanifest',
  '/src/templates/today.html', '/src/templates/focus.html', '/src/templates/brain-dump.html',
  '/src/templates/settings.html', '/src/templates/sync-settings.html', '/src/templates/desktop-today.html', '/src/templates/desktop-week.html',
  '/src/templates/mobile-plan.html',
  '/src/assets/fonts/atkinson-e15e89caea888e8d.woff2', '/src/assets/fonts/atkinson-a60206dd4793eb88.woff2',
  '/src/assets/fonts/atkinson-69b1029853229409.woff2', '/src/assets/fonts/atkinson-1cc7c0c5fbf16d1b.woff2',
  '/src/assets/icon-192.png', '/src/assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin || new URL(event.request.url).pathname.startsWith('/api/')) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
