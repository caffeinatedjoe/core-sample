// App shell only. Note text lives in IndexedDB and is never cached here.
const CACHE = 'core-sample-shell-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/main.js',
  './js/view.js',
  './js/db.js',
  './js/save.js',
  './js/notes.js',
  './js/markdown.js',
  './js/checklist.js',
  './icons/apple-touch-icon.png',
  './icons/apple-touch-icon-167.png',
  './icons/apple-touch-icon-152.png',
  './icons/apple-touch-icon-120.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/icon-192-maskable.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
  )));
  self.clients.claim();
});

function isShellPath(pathname) {
  const scopePath = new URL('./', self.registration.scope).pathname;
  if (!pathname.startsWith(scopePath)) return false;
  const relative = pathname.slice(scopePath.length);
  const name = relative === '' ? './' : `./${relative}`;
  return SHELL.includes(name) || name === './index.html';
}

async function fromCacheOrNetwork(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request).then((response) => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  if (cached) return cached;
  const fresh = await network;
  if (fresh) return fresh;
  if (request.mode === 'navigate') {
    const fallback = await cache.match('./index.html', { ignoreSearch: true });
    if (fallback) return fallback;
  }
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!isShellPath(url.pathname)) return;
  event.respondWith(fromCacheOrNetwork(request));
});
