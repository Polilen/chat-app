// Мінімальний service worker: кешує статичну оболонку сайту, щоб додаток
// можна було "встановити" як PWA і він швидше стартував.
// Всі запити до /api, /socket.io, /uploads тощо йдуть напряму в мережу —
// це не офлайн-режим чату.

const CACHE_NAME = 'rechi-shell-v2';

// Код (HTML/JS) — "мережа спочатку": якщо є інтернет, завжди береться свіжа
// версія. Це важливо, бо застаріла кешована app.js в одного співрозмовника
// і свіжа в іншого можуть по-різному "розмовляти" по WebRTC/сокетах —
// саме так одного разу пропав звук у дзвінках. Кеш тут лише як запасний
// варіант, якщо мережі немає взагалі.
const NETWORK_FIRST_FILES = ['/', '/index.html', '/app.js', '/install-prompt.js'];

// Іконки/маніфест/CSS майже не змінюються — їх можна віддавати з кешу одразу
// й оновлювати у фоні, без затримки на мережевий запит.
const CACHE_FIRST_FILES = [
  '/style.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/install-prompt.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll([...NETWORK_FIRST_FILES, ...CACHE_FIRST_FILES])
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/socket.io') ||
    url.pathname.startsWith('/uploads')
  ) {
    return;
  }

  const isNetworkFirst = NETWORK_FIRST_FILES.includes(url.pathname);

  if (isNetworkFirst) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
