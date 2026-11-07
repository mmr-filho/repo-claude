/* OmniSaúde: service worker das telas de campo (ACE e ACS). Guarda as telas e os arquivos delas para abrir sem
   internet; a API nunca passa por aqui (os dados de campo ficam no IndexedDB da própria tela).

   - Na instalação, guarda o documento de cada tela de campo e os arquivos que ele referencia (precache).
   - A página manda o endereço dela e o que já carregou (arquivos baixados antes de o service worker assumir e os de
     navegação pelo menu, que não pedem o documento); o que faltar é baixado e guardado, e a tela de campo é guardada de
     novo (a cópia acompanha a versão publicada).
   - Navegação: rede primeiro (com espera curta quando há cópia); sem rede ou com o servidor fora, a cópia guardada.
   - Arquivos de /_next/static/ (nome com hash, imutáveis): cópia primeiro.
   Documentos ficam guardados pelo caminho sem barra final e sem parâmetros: o export estático usa /campo-ace/ e o
   servidor Next usa /campo-ace, e o basePath (ex.: /omnisaude) vem do escopo do registro. */
const VERSAO = 'v2';
const TELAS = `omnisaude-telas-${VERSAO}`;
const ESTATICOS = `omnisaude-estaticos-${VERSAO}`;
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const TELAS_DE_CAMPO = [
  { rota: '/campo-ace', nome: 'Campo do agente de endemias' },
  { rota: '/acs', nome: 'Campo do agente comunitário de saúde' },
];
/** Sem resposta da rede neste tempo, a navegação usa a cópia guardada (a rede continua e atualiza a cópia). */
const ESPERA_REDE_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(guardarTelasDeCampo().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('omnisaude-') && k !== TELAS && k !== ESTATICOS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const d = event.data;
  if (d && d.tipo === 'guardar') event.waitUntil(guardarDaPagina(d).catch(() => {}));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!podeGuardar(url)) return;
  // Dados da navegação pelo menu (RSC): sem rede, o Next recarrega a página, e a navegação é atendida pela cópia.
  if (url.searchParams.has('_rsc') || req.headers.get('RSC') === '1') return;
  if (req.mode === 'navigate') {
    let gravando = Promise.resolve();
    const daRede = fetch(req).then((res) => {
      gravando = guardarDocumento(url, res.clone());
      return res;
    });
    event.waitUntil(daRede.then(() => gravando).catch(() => {}));
    event.respondWith(navegar(url, daRede));
    return;
  }
  if (ehEstatico(url)) {
    event.respondWith(estatico(req));
    return;
  }
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (res.type === 'basic' || res.type === 'default')) {
          const copia = res.clone();
          const gravando = caches
            .open(TELAS)
            .then((c) => c.put(req, copia))
            .catch(() => {});
          try {
            event.waitUntil(gravando);
          } catch {
            // Evento já encerrado: a gravação segue sem prolongar o service worker.
          }
        }
        return res;
      })
      .catch(async () => (await caches.match(req, { ignoreVary: true })) || Response.error()),
  );
});

/** Mesma origem, dentro do escopo e fora da API, do Socket.IO e do próprio service worker. */
function podeGuardar(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return false;
  if (/\/(api|socket\.io)(\/|$)/.test(url.pathname)) return false;
  return !url.pathname.endsWith('/sw.js');
}

function ehEstatico(url) {
  return url.pathname.startsWith(`${BASE}/_next/static/`);
}

/** Chave do documento: caminho sem barra final e sem parâmetros (o HTML da tela é o mesmo). */
function chaveDocumento(url) {
  return new URL(url.pathname.replace(/\/+$/, '') || '/', self.location.origin).href;
}

/** Cópia sem o histórico de redirecionamento (navegação não aceita resposta redirecionada) e sem Vary. */
async function copiaLimpa(res) {
  const headers = new Headers(res.headers);
  headers.delete('vary');
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
}

async function guardarDocumento(url, res) {
  if (!res.ok || res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return;
  const c = await caches.open(TELAS);
  await c.put(chaveDocumento(url), await copiaLimpa(res));
}

async function documentoGuardado(url) {
  return (await caches.open(TELAS)).match(chaveDocumento(url), { ignoreVary: true });
}

function ehTelaDeCampo(url) {
  const chave = chaveDocumento(url);
  return TELAS_DE_CAMPO.some(({ rota }) => chaveDocumento(new URL(`${BASE}${rota}`, self.location.origin)) === chave);
}

async function navegar(url, daRede) {
  const guardado = await documentoGuardado(url);
  if (!guardado) return daRede.catch(() => paginaSemConexao());
  // Servidor fora (5xx, 404 durante uma publicação) também usa a cópia.
  const rede = daRede.then((res) => (res.ok ? res : guardado)).catch(() => guardado);
  // Só nas telas de campo a rede lenta cede à cópia: lá o agente trabalha sem internet ou com sinal fraco.
  if (!ehTelaDeCampo(url)) return rede;
  return Promise.race([rede, new Promise((resolve) => setTimeout(() => resolve(guardado), ESPERA_REDE_MS))]);
}

async function estatico(req) {
  const c = await caches.open(ESTATICOS);
  const hit = await c.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && (res.type === 'basic' || res.type === 'default')) await c.put(req, res.clone()).catch(() => {});
  return res;
}

/**
 * Arquivos que o documento usa: os das tags (src/href, já com o basePath) e os citados no payload do Next, que carrega
 * os chunks da tela ('static/chunks/...', relativos a BASE/_next/).
 */
function arquivosDoDocumento(html) {
  const dasTags = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"]*\/_next\/static\/[^"]+)"/g)) dasTags.add(new URL(m[1].replace(/&amp;/g, '&'), self.location.origin).href);
  const doPayload = new Set();
  for (const m of html.matchAll(/(?:^|[^\w/])static\/(?:chunks|css|media)\/[\w.~%-]+/g)) {
    const u = new URL(`${BASE}/_next/${m[0].replace(/^[^s]+/, '')}`, self.location.origin).href;
    if (!dasTags.has(u)) doPayload.add(u);
  }
  return { dasTags: [...dasTags], doPayload: [...doPayload] };
}

async function baixarDocumento(rota) {
  // O export estático publica /rota/ e o servidor Next /rota: tenta as duas (com os redirecionamentos do servidor).
  for (const caminho of [`${BASE}${rota}`, `${BASE}${rota}/`]) {
    const res = await fetch(new Request(new URL(caminho, self.location.origin).href, { credentials: 'same-origin', cache: 'no-store' })).catch(() => null);
    if (res && res.ok && (res.headers.get('content-type') || '').includes('text/html')) return res;
  }
  throw new Error(`Tela ${rota} não baixada`);
}

async function guardarEstatico(estaticos, u, obrigatorio) {
  if (await estaticos.match(u, { ignoreVary: true })) return;
  const a = await fetch(u, { credentials: 'same-origin' }).catch(() => null);
  if (a && a.ok) await estaticos.put(u, a);
  else if (obrigatorio) throw new Error(`Arquivo ${u} não baixado`);
}

/**
 * Guarda uma tela de campo: o documento e os arquivos das tags são obrigatórios (se faltar algum, a cópia anterior
 * continua); os citados só no payload são melhor esforço.
 */
async function guardarTela(rota, telas, estaticos) {
  const res = await baixarDocumento(rota);
  const html = await res.clone().text();
  const { dasTags, doPayload } = arquivosDoDocumento(html);
  // Página sem os arquivos do app (erro do servidor, proxy) não substitui a cópia boa.
  if (!dasTags.length) throw new Error(`Tela ${rota} sem os arquivos do app`);
  for (const u of dasTags) await guardarEstatico(estaticos, u, true);
  for (const u of doPayload) await guardarEstatico(estaticos, u, false);
  await telas.put(chaveDocumento(new URL(`${BASE}${rota}`, self.location.origin)), await copiaLimpa(res));
}

/** Precache das telas de campo; se faltar algo, a instalação falha e o service worker anterior continua. */
async function guardarTelasDeCampo() {
  const telas = await caches.open(TELAS);
  const estaticos = await caches.open(ESTATICOS);
  for (const { rota } of TELAS_DE_CAMPO) await guardarTela(rota, telas, estaticos);
}

/** Guarda o que a página informou e ainda não está guardado (melhor esforço: o que falhar fica para a próxima). */
async function guardarDaPagina(d) {
  const estaticos = await caches.open(ESTATICOS);
  const telas = await caches.open(TELAS);
  const recursos = Array.isArray(d.recursos) ? d.recursos.slice(0, 500) : [];
  for (const r of recursos) {
    let url;
    try {
      url = new URL(String(r), self.location.origin);
    } catch {
      continue;
    }
    if (!podeGuardar(url) || url.searchParams.has('_rsc')) continue;
    const cache = ehEstatico(url) ? estaticos : telas;
    if (await cache.match(url.href, { ignoreVary: true })) continue;
    const res = await fetch(url.href, { credentials: 'same-origin' }).catch(() => null);
    if (res && res.ok && (res.type === 'basic' || res.type === 'default')) await cache.put(url.href, res).catch(() => {});
  }
  if (typeof d.documento !== 'string') return;
  const doc = new URL(d.documento, self.location.origin);
  if (!podeGuardar(doc)) return;
  // Tela de campo aberta com rede: guardada de novo, com os arquivos. Uma publicação nova não muda este arquivo (o service
  // worker não é reinstalado), e a cópia da instalação rodaria sem rede o código da versão anterior.
  const campo = TELAS_DE_CAMPO.find(({ rota }) => chaveDocumento(new URL(`${BASE}${rota}`, self.location.origin)) === chaveDocumento(doc));
  if (campo) return guardarTela(campo.rota, telas, estaticos);
  if (await documentoGuardado(doc)) return;
  const res = await fetch(doc.href, { credentials: 'same-origin' }).catch(() => null);
  if (res) await guardarDocumento(doc, res);
}

async function paginaSemConexao() {
  const telas = await caches.open(TELAS);
  const links = [];
  for (const { rota, nome } of TELAS_DE_CAMPO) {
    if (await telas.match(chaveDocumento(new URL(`${BASE}${rota}`, self.location.origin)))) links.push(`<li><a href="${BASE}${rota}">${nome}</a></li>`);
  }
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sem conexão · OmniSaúde</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#0f172a;line-height:1.5}a{color:#1d4ed8}</style></head>
<body><h1>Sem conexão</h1><p>Esta tela precisa de internet: ela não fica guardada no aparelho.</p>
${
  links.length
    ? `<p>Estas telas funcionam sem internet neste aparelho:</p><ul>${links.join('')}</ul>`
    : '<p>As telas de campo do ACE e do ACS ficam guardadas no aparelho depois que o OmniSaúde é aberto com internet e com o login feito.</p>'
}
<p>Quando a conexão voltar, recarregue a página.</p></body></html>`;
  return new Response(html, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
