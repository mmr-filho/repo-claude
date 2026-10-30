import { describe, expect, it } from 'vitest';
import { loadVLibrasWidget, prescriptionToLibrasContent, presentTextForLibras, splitSentences, VLIBRAS_SCRIPT_URL } from '@omnisaude/accessibility';

/** DOM mínimo para exercitar a injeção do widget sem jsdom. */
class FakeElement {
  id = '';
  className = '';
  textContent = '';
  src = '';
  async = false;
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  listeners = new Map<string, (() => void)[]>();
  constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) {}
  setAttribute(k: string, v: string) {
    this.attributes.set(k, v);
  }
  appendChild(c: FakeElement) {
    this.children.push(c);
    return c;
  }
  append(...c: FakeElement[]) {
    this.children.push(...c);
  }
  replaceChildren(...c: FakeElement[]) {
    this.children = c;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

class FakeDocument {
  readyState = 'complete';
  head = new FakeElement('head', this);
  body = new FakeElement('body', this);
  widgets: string[] = [];
  loadEvents = 0;
  defaultView: Record<string, unknown> = {
    dispatchEvent: (e: { type: string }) => {
      if (e.type === 'load') this.loadEvents++;
    },
  };
  createElement(tag: string) {
    return new FakeElement(tag, this);
  }
  getElementById(id: string): FakeElement | null {
    const find = (el: FakeElement): FakeElement | null => (el.id === id ? el : el.children.map(find).find(Boolean) ?? null);
    return find(this.head) ?? find(this.body);
  }
}

describe('VLibras', () => {
  it('injeta marcação e script uma única vez', async () => {
    const doc = new FakeDocument();
    const p1 = loadVLibrasWidget({ document: doc as unknown as Document, position: 'BR' });
    const p2 = loadVLibrasWidget({ document: doc as unknown as Document });
    expect(p1).toBe(p2);
    const script = doc.head.children[0]!;
    expect(script.src).toBe(VLIBRAS_SCRIPT_URL);
    const root = doc.body.children[0]!;
    expect(root.attributes.has('vw')).toBe(true);
    expect(root.children.map((c) => [...c.attributes.keys()][0])).toEqual(['vw-access-button', 'vw-plugin-wrapper']);

    const widgets: string[] = [];
    doc.defaultView.VLibras = {
      Widget: class {
        constructor(url: string) {
          widgets.push(url);
        }
      },
    };
    script.fire('load');
    await p1;
    expect(widgets).toEqual(['https://vlibras.gov.br/app']);
    expect(doc.loadEvents).toBe(1);
  });

  it('rejeita quando o script não carrega e permite nova tentativa', async () => {
    const doc = new FakeDocument();
    const p = loadVLibrasWidget({ document: doc as unknown as Document });
    doc.head.children[0]!.fire('error');
    await expect(p).rejects.toThrow(/VLibras/);
    expect(loadVLibrasWidget({ document: doc as unknown as Document })).not.toBe(p);
  });

  it('publica texto como parágrafos (sem interpretar HTML)', () => {
    const doc = new FakeDocument();
    const container = doc.createElement('div');
    const region = presentTextForLibras(container as unknown as HTMLElement, 'Tome o remédio. <b>Volte</b> em 7 dias!') as unknown as FakeElement;
    expect(region.children.map((c) => c.textContent)).toEqual(['Tome o remédio.', '<b>Volte</b> em 7 dias!']);
    expect(region.attributes.get('aria-live')).toBe('polite');
  });

  it('simplifica a receita em frases curtas', () => {
    expect(splitSentences('Uma frase.  Outra frase!\nTerceira')).toEqual(['Uma frase.', 'Outra frase!', 'Terceira']);
    const content = prescriptionToLibrasContent([{ medication: 'Dipirona 500 mg', dose: '1 comprimido', route: 'ORAL', frequency: 'de 6 em 6 horas', duration: '3 dias' }]);
    expect(content.paragraphs).toEqual([
      'Remédio: Dipirona 500 mg.',
      'Quantidade: 1 comprimido.',
      'Como usar: pela boca.',
      'Quando: de 6 em 6 horas.',
      'Por quanto tempo: 3 dias.',
    ]);
  });
});
