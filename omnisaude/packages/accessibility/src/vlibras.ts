/**
 * Integração com o VLibras (tradutor de Português para Libras do Governo Federal).
 *
 * O widget oficial traduz o conteúdo da página: o usuário ativa o avatar e toca no texto. Não existe API
 * oficial para traduzir um texto arbitrário sem exibi-lo na tela; por isso presentTextForLibras() publica o
 * texto numa região visível da página, onde o avatar consegue lê-lo.
 */

export const VLIBRAS_SCRIPT_URL = 'https://vlibras.gov.br/app/vlibras-plugin.js';
export const VLIBRAS_APP_URL = 'https://vlibras.gov.br/app';

const ROOT_ID = 'omni-vlibras';
const SCRIPT_ID = 'omni-vlibras-script';

export type VLibrasPosition = 'R' | 'L' | 'TR' | 'TL' | 'BR' | 'BL';

export interface LoadVLibrasOptions {
  document?: Document;
  /** Posição do botão de acesso (aplicada por CSS sobre o elemento raiz do widget). */
  position?: VLibrasPosition;
  scriptUrl?: string;
  appUrl?: string;
}

interface VLibrasWindow {
  VLibras?: { Widget: new (rootPath: string) => unknown };
}

const loading = new WeakMap<Document, Promise<void>>();

const POSITION_STYLE: Record<VLibrasPosition, string> = {
  R: 'right:0;top:50%;transform:translateY(-50%)',
  L: 'left:0;top:50%;transform:translateY(-50%)',
  TR: 'right:0;top:0',
  TL: 'left:0;top:0',
  BR: 'right:0;bottom:0',
  BL: 'left:0;bottom:0',
};

/** Marcação oficial do widget: div[vw] > div[vw-access-button] + div[vw-plugin-wrapper]. */
export function createVLibrasMarkup(doc: Document, position?: VLibrasPosition): HTMLElement {
  const root = doc.createElement('div');
  root.id = ROOT_ID;
  root.setAttribute('vw', '');
  root.className = 'enabled';
  if (position) root.setAttribute('style', `position:fixed;z-index:2147483000;${POSITION_STYLE[position]}`);
  const button = doc.createElement('div');
  button.setAttribute('vw-access-button', '');
  button.className = 'active';
  const wrapper = doc.createElement('div');
  wrapper.setAttribute('vw-plugin-wrapper', '');
  const top = doc.createElement('div');
  top.className = 'vw-plugin-top-wrapper';
  wrapper.appendChild(top);
  root.append(button, wrapper);
  return root;
}

/** Injeta o widget uma única vez por documento; chamadas repetidas reaproveitam o mesmo carregamento. */
export function loadVLibrasWidget(opts: LoadVLibrasOptions = {}): Promise<void> {
  const doc = opts.document ?? globalThis.document;
  if (!doc) return Promise.reject(new Error('VLibras só pode ser carregado no navegador'));
  const existing = loading.get(doc);
  if (existing) return existing;

  const promise = new Promise<void>((resolve, reject) => {
    if (!doc.getElementById(ROOT_ID)) doc.body.appendChild(createVLibrasMarkup(doc, opts.position));
    const win = doc.defaultView as (Window & VLibrasWindow) | null;
    const init = () => {
      const VLibras = win?.VLibras;
      if (!VLibras) return reject(new Error('Script do VLibras carregado sem o objeto VLibras'));
      new VLibras.Widget(opts.appUrl ?? VLIBRAS_APP_URL);
      // O widget se inicializa no evento "load" da janela; em aplicações SPA a página já carregou,
      // então o evento é redisparado (contorno usual para o VLibras em React/Next).
      if (doc.readyState === 'complete' && win) win.dispatchEvent(new Event('load'));
      resolve();
    };
    if (win?.VLibras) return init();
    let script = doc.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = doc.createElement('script');
      script.id = SCRIPT_ID;
      script.src = opts.scriptUrl ?? VLIBRAS_SCRIPT_URL;
      script.async = true;
      doc.head.appendChild(script);
    }
    script.addEventListener('load', init, { once: true });
    script.addEventListener('error', () => reject(new Error('Não foi possível carregar o VLibras (sem conexão com vlibras.gov.br?)')), {
      once: true,
    });
  });
  // Se falhar, permite tentar de novo depois.
  promise.catch(() => loading.delete(doc));
  loading.set(doc, promise);
  return promise;
}

export interface LibrasContent {
  title?: string;
  /** Frases curtas traduzem melhor: uma ideia por item. */
  paragraphs: string[];
}

/**
 * Publica o texto numa região da tela do paciente para tradução pelo avatar. Devolve o elemento criado
 * (substitui o conteúdo anterior do container).
 */
export function presentTextForLibras(container: HTMLElement, content: LibrasContent | string): HTMLElement {
  const doc = container.ownerDocument;
  const data: LibrasContent = typeof content === 'string' ? { paragraphs: splitSentences(content) } : content;
  const region = doc.createElement('section');
  region.setAttribute('data-omni-libras', '');
  region.setAttribute('role', 'region');
  region.setAttribute('aria-label', data.title ?? 'Conteúdo para tradução em Libras');
  region.setAttribute('aria-live', 'polite');
  if (data.title) {
    const h = doc.createElement('h2');
    h.textContent = data.title;
    region.appendChild(h);
  }
  for (const text of data.paragraphs) {
    const p = doc.createElement('p');
    p.textContent = text; // textContent: nunca interpreta HTML vindo do prontuário
    region.appendChild(p);
  }
  container.replaceChildren(region);
  return region;
}

/** Quebra um texto em frases curtas (o tradutor automático lida melhor com uma ideia por frase). */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface PrescriptionItemForLibras {
  medication: string;
  dose?: string;
  route?: string;
  frequency?: string;
  duration?: string;
  notes?: string;
}

const ROUTE_WORDS: Record<string, string> = {
  ORAL: 'pela boca',
  SUBLINGUAL: 'embaixo da língua',
  IV: 'na veia',
  IM: 'injeção no músculo',
  SC: 'injeção embaixo da pele',
  TOPICA: 'passar na pele',
  INALATORIA: 'inalar',
  RETAL: 'pelo ânus',
  OFTALMICA: 'pingar no olho',
  NASAL: 'pingar no nariz',
};

/** Receita em frases curtas e linguagem simples, uma instrução por frase. */
export function prescriptionToLibrasContent(items: PrescriptionItemForLibras[], title = 'Sua receita'): LibrasContent {
  const paragraphs: string[] = [];
  for (const item of items) {
    paragraphs.push(`Remédio: ${item.medication}.`);
    if (item.dose) paragraphs.push(`Quantidade: ${item.dose}.`);
    if (item.route) paragraphs.push(`Como usar: ${ROUTE_WORDS[item.route.toUpperCase()] ?? item.route}.`);
    if (item.frequency) paragraphs.push(`Quando: ${item.frequency}.`);
    if (item.duration) paragraphs.push(`Por quanto tempo: ${item.duration}.`);
    if (item.notes) paragraphs.push(...splitSentences(item.notes));
  }
  return { title, paragraphs };
}
