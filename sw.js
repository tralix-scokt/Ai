/* ==========================================================================
   sw.js — TRALIX AI service worker.

   Cache-first for the app shell (so TRALIX opens instantly and shows its UI
   offline), revalidating quietly in the background. API calls are never cached:
   replies always come from the network.

   Bump VERSION whenever the shell changes, otherwise cache-first clients keep
   serving the previous build.
   ========================================================================== */

const VERSION = 'tralix-v6';
const CACHE_PREFIX = 'tralix-';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/app.css',
  './assets/js/app.js',
  './assets/js/config.js',
  './assets/js/errors.js',
  './assets/js/util.js',
  './assets/js/store.js',
  './assets/js/markdown.js',
  './assets/js/highlight.js',
  './assets/js/models.js',
  './assets/js/personality.js',
  './assets/js/tools.js',
  './assets/js/voice.js',
  './assets/js/scrolling.js',
  './assets/js/providers.js',
  './assets/js/api/client.js',
  './assets/js/api/backend.js',
  './assets/js/api/local.js',
  './assets/js/api/chat.js',
  './assets/js/ui/sheets.js',
  './assets/js/ui/feedback.js',
  './assets/js/ui/status.js',
  './assets/js/ui/messages.js',
  './assets/js/ui/composer.js',
  './assets/js/ui/chat.js',
  './assets/js/ui/sidebar.js',
  './assets/js/ui/search.js',
  './assets/js/ui/memory.js',
  './assets/js/ui/projects.js',
  './assets/js/ui/models.js',
  './assets/js/ui/settings.js',
  './assets/js/ui/doctor.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Bypass the HTTP cache so a new worker cannot repopulate its cache with
    // the same stale files it is meant to replace.
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

  // Never touch API traffic — replies and health checks must always be live.
  if (url.pathname.includes('/api/')) return;

  // The deployment pointer must never be served from cache: it is how a
  // deployed frontend finds its backend, and it changes with the deployment.
  if (url.pathname.endsWith('/backend.json')) return;

  // Only handle this app's own files; leave other origins alone.
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  event.respondWith(
    caches.open(VERSION).then(cache => cache.match(request).then(hit => {
      if (hit) {
        fetch(request, { cache: 'no-cache' }).then(res => {
          if (res?.ok && res.type === 'basic') return cache.put(request, res.clone());
        }).catch(() => {});
        return hit;
      }

      return fetch(request, { cache: 'no-cache' }).then(res => {
        if (res?.ok && res.type === 'basic') cache.put(request, res.clone()).catch(() => {});
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
