/* OmniSaúde: service worker das telas de campo. Guarda os arquivos das telas para abrir sem internet;
   a API nunca passa por aqui (os dados ficam no IndexedDB da própria tela). */
const CACHE = 'omnisaude-telas-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/\/(api|socket\.io)(\/|$)/.test(url.pathname) || url.pathname.endsWith('/sw.js')) return;
  if (url.pathname.includes('/_next/static/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => guardar(req, res))));
    return;
  }
  event.respondWith(
    fetch(req)
      .then((res) => guardar(req, res))
      .catch(
        async () =>
          (await caches.match(req)) ||
          (await caches.match(req, { ignoreSearch: true })) ||
          new Response('Sem conexão e sem cópia desta tela. Abra-a uma vez com internet.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }),
      ),
  );
});
async function guardar(req, res) {
  if (res && res.ok && (res.type === 'basic' || res.type === 'default')) {
    const copia = res.clone();
    caches
      .open(CACHE)
      .then((c) => c.put(req, copia))
      .catch(() => {});
  }
  return res;
}
