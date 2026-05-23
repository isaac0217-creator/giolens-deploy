/**
 * GIOCORE Captura — Service Worker mínimo.
 *
 * Spec: BRIEF_CODE_FRENTE_D_CAPTURA_EXPEDIENTES.md §iPad-first.
 *
 * Scope MVP:
 *   - Cache-first del form HTML + manifest (modo offline básico).
 *   - Pasthrough para /api/* (no cachear POST con PII).
 *
 * NO incluido (post-MVP):
 *   - Background sync queue para POST offline.
 *   - Cache cleanup por versión.
 */
const CACHE = 'giocore-captura-v1';
const STATIC_ASSETS = [
  '/expediente-form.html',
  '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(STATIC_ASSETS)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Pasthrough API (POST con PII no se cachea).
  if (url.pathname.startsWith('/api/')) return;
  // Solo cachear GET de mismo origen.
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request)
        .then((resp) => {
          if (resp.ok && STATIC_ASSETS.some((p) => url.pathname.endsWith(p))) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => cached || new Response('offline', { status: 503 }));
    }),
  );
});
