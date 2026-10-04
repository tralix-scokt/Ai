/* ==========================================================================
   sw.js — service worker
   Cache-first for the app shell so Jarvis opens instantly and works offline
   (the shell, not the AI — replies still need a connection).
   ========================================================================== */

const VERSION = 'jarvis-v1';
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
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => cache.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // never cache the AI APIs — always live
  if (/generativelanguage\.googleapis\.com|api\.openai\.com|api\.anthropic\.com/.test(url.host)) {
    return;
  }

  // same-origin shell: cache-first, then network
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(request).then(hit => {
        if (hit) {
          // refresh in the background
          fetch(request).then(res => {
            if (res && res.ok) caches.open(VERSION).then(c => c.put(request, res.clone()));
          }).catch(() => {});
          return hit;
        }
        return fetch(request).then(res => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(VERSION).then(c => c.put(request, copy));
          }
          return res;
        }).catch(() =>
          request.mode === 'navigate' ? caches.match('./index.html') : Response.error()
        );
      })
    );
  }
});
