/* ==========================================================================
   sw.js — service worker
   Cache-first for the app shell so Jarvis opens instantly and works offline
   (the shell, not the AI — replies still need a connection).
   ========================================================================== */

// Bump this whenever the app shell changes. Cache-first clients otherwise keep
// serving an old shell after GitHub Pages has deployed a newer release.
const VERSION = 'jarvis-v2';
const CACHE_PREFIX = 'jarvis-';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/app.css',
  './assets/js/app.js',
  './assets/js/util.js',
  './assets/js/store.js',
  './assets/js/markdown.js',
  './assets/js/providers.js',
  './assets/js/voice.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Bypass the browser's HTTP cache so the new worker cannot repopulate its
    // cache with the same stale files it is meant to replace.
    const requests = SHELL.map(path =>
      new Request(new URL(path, self.registration.scope), { cache: 'reload' })
    );
    await cache.addAll(requests);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);

  // Only handle this app's own files; leave external APIs and sibling sites alone.
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  event.respondWith(
    caches.open(VERSION).then(cache => cache.match(request).then(hit => {
      if (hit) {
        // Keep the instant/offline cache-first response, but revalidate without
        // the browser HTTP cache so the next load can pick up a fresh deploy.
        fetch(request, { cache: 'no-cache' }).then(res => {
          if (res?.ok && res.type === 'basic') {
            return cache.put(request, res.clone());
          }
        }).catch(() => {});
        return hit;
      }

      return fetch(request, { cache: 'no-cache' }).then(res => {
        if (res?.ok && res.type === 'basic') {
          cache.put(request, res.clone()).catch(() => {});
        }
        return res;
      }).catch(async () => {
        if (request.mode === 'navigate') {
          return await cache.match(new URL('./index.html', scope).href) || Response.error();
        }
        return Response.error();
      });
    }))
  );
});
