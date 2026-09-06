// Service worker del formulario de check-in.
//
// Su trabajo es simple: guardar una copia de la página y de todo lo que
// necesita (íconos, tipos de habitación, plataformas, preguntas
// personalizadas) para que la app abra y funcione aunque el celular no
// tenga conexión con el servidor. NUNCA intercepta el envío del check-in
// (POST /api/checkins) — eso siempre va directo a la red, y si falla, es la
// propia página (no este archivo) la que decide guardarlo en la cola
// pendiente del celular. Ver la lógica de esa cola en index.html.

const CACHE_SHELL = 'checkin-shell-v2';
const CACHE_RUNTIME = 'checkin-runtime-v2';

const APP_SHELL = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

// Si el celular tiene datos móviles ENCENDIDOS pero no puede alcanzar al
// servidor (porque vive en la red wifi del hotel, no en internet), un
// fetch() normal no falla rápido — se queda esperando una respuesta que
// nunca llega, a veces por minutos, dejando la app "cargando" para
// siempre. Este límite de tiempo evita eso: si la red no responde rápido,
// se da por fallida y se usa la copia guardada, exactamente igual que si
// no hubiera conexión en absoluto.
function fetchConTimeout(request, ms = 5000) {
  const controlador = new AbortController();
  const timeoutId = setTimeout(() => controlador.abort(), ms);
  return fetch(request, { signal: controlador.signal }).finally(() => clearTimeout(timeoutId));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_SHELL)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_SHELL && k !== CACHE_RUNTIME).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Cualquier cosa que no sea GET (el POST de un check-in, por ejemplo)
  // pasa de largo sin tocarla — debe ir directo a la red y fallar de forma
  // natural si no hay conexión, para que la página lo detecte y lo guarde
  // en la cola offline del celular.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // La página principal: se intenta la red primero (para tener siempre la
  // versión más reciente cuando sí hay conexión) y, si tarda demasiado o
  // falla, se usa la copia guardada — así la app abre rápido igual aunque
  // no haya red de verdad, o aunque haya datos móviles que no llegan a
  // ningún lado.
  if (request.mode === 'navigate' || url.pathname === '/') {
    event.respondWith(
      fetchConTimeout(request)
        .then((res) => {
          caches.open(CACHE_SHELL).then((cache) => cache.put('/', res.clone()));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  // Las opciones del formulario (tipos de habitación, plataformas y las
  // preguntas personalizadas que configuró el hotel): se responde al
  // instante con la copia guardada si existe — así el formulario no se
  // queda esperando sin red — y en paralelo se pide la versión más
  // reciente (con el mismo límite de tiempo) para dejarla lista para la
  // próxima vez.
  if (url.pathname === '/api/form-options' || url.pathname === '/api/fields') {
    event.respondWith(
      caches.open(CACHE_RUNTIME).then(async (cache) => {
        const cached = await cache.match(request);
        const enRed = fetchConTimeout(request).then((res) => {
          cache.put(request, res.clone());
          return res;
        }).catch(() => null);
        if (cached) return cached;
        const fresco = await enRed;
        return fresco || new Response('[]', { headers: { 'Content-Type': 'application/json' } });
      }),
    );
    return;
  }

  // Todo lo demás (íconos, fuentes de Google Fonts, etc.): copia guardada
  // primero si existe; si no, se pide a la red (con el mismo límite de
  // tiempo) y se guarda para la próxima vez que se necesite sin conexión.
  event.respondWith(
    caches.match(request).then((cached) => cached || fetchConTimeout(request).then((res) => {
      if (res && (res.status === 200 || res.type === 'opaque')) {
        const copia = res.clone();
        caches.open(CACHE_RUNTIME).then((cache) => cache.put(request, copia));
      }
      return res;
    }).catch(() => cached)),
  );
});
