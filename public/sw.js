/*
  Service worker minimo.

  Objetivo: que al abrir desde el icono la app aparezca al instante y que una
  mala señal no muestre la pantalla de error del navegador. Las llamadas a la IA
  nunca se cachean, obviamente: cada partida pide preguntas nuevas.
*/

const VERSION = 'mano-a-mano-v1';
const SHELL = self.registration.scope;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll([SHELL, `${SHELL}manifest.webmanifest`, `${SHELL}icon.svg`]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Todo lo que no sea nuestro propio origen (la IA, las tipografias) va derecho
  // a la red: cachearlo solo traeria respuestas viejas.
  if (url.origin !== self.location.origin) return;

  // La navegacion usa red primero para que un deploy nuevo se vea enseguida, y
  // cae al cache solo si no hay señal.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(VERSION).then((cache) => cache.put(SHELL, copy));
          return response;
        })
        .catch(() => caches.match(SHELL).then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // Los assets con hash en el nombre no cambian nunca: cache primero.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
