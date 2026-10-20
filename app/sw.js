// App shell only. Note text lives in IndexedDB and is never cached here.
// CACHE must match APP_BUILD in ./js/version.js.
importScripts('./js/shell-cache.js');

const CACHE = 'core-sample-shell-v5';

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
  './js/preview-tap.js',
  './js/markdown.js',
  './js/checklist.js',
  './js/version.js',
  './js/shell-cache.js',
  './js/organize.js',
  './js/browser.js',
  './js/backup.js',
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
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (path) => {
      const response = await fetch(new Request(path, { cache: 'no-cache' }));
      if (!response.ok) throw new Error(path);
      await cache.put(path, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
    // A page that loaded under an older worker is still running that worker's
    // script. v1 has no controllerchange listener, so navigate it onto this
    // worker. The unload flushes the open note (pagehide). Do not await the
    // navigation here: its fetch cannot finish until this activate handler
    // settles. This does not run again until a newer worker activates.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) reloadClient(client);
  })());
});

async function reloadClient(client) {
  if (!client.navigate) return;
  try {
    await client.navigate(client.url);
    return;
  } catch {
    // Some browsers reject a navigate to the URL already displayed.
  }
  const url = new URL(client.url);
  if (url.searchParams.get('shell') === CACHE) return;
  url.searchParams.set('shell', CACHE);
  try {
    await client.navigate(url.href);
  } catch {
    // The page listener reloads once this build's script is running.
  }
}

function relativeName(pathname) {
  const scopePath = new URL('./', self.registration.scope).pathname;
  if (!pathname.startsWith(scopePath)) return null;
  const relative = pathname.slice(scopePath.length);
  return relative === '' ? './' : `./${relative}`;
}

function isShellPath(name) {
  return name === './sw.js' || name === './index.html' || SHELL.includes(name);
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' });
    if (fresh && fresh.ok) {
      try {
        await cache.put(request, fresh.clone());
      } catch {
        // A cache write must not hide a good network response.
      }
      return fresh;
    }
  } catch {
    // Offline, or the revalidation failed. Fall through to the cache.
  }
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  if (request.mode === 'navigate') {
    const fallback = await cache.match('./index.html', { ignoreSearch: true });
    if (fallback) return fallback;
  }
  return Response.error();
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const fresh = await fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' });
  if (fresh && fresh.ok) {
    try {
      await cache.put(request, fresh.clone());
    } catch {
      // Still return the network body.
    }
  }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const name = relativeName(url.pathname);
  if (!name || !isShellPath(name)) return;
  const network = request.mode === 'navigate' || shellRequestKind(name) === 'network-first';
  event.respondWith(network ? networkFirst(request) : cacheFirst(request));
});
