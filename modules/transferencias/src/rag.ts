import type { Achado, Analise, Trecho } from './tipos';

/*
 * Camada 3: recuperação no corpus normativo. Os trechos já vêm fatiados na hierarquia Norma > Capítulo > Artigo >
 * Parágrafo (etl/corpus.py). Cada achado traz os trechos que a regra cita (busca por id, exata) e a busca BM25
 * completa com o contexto vizinho. BM25 basta para um corpus deste tamanho e não depende de serviço externo.
 */

const PARADAS = new Set(
  ('de da do das dos e o a os as em no na nos nas um uma uns umas por para com sem ao aos à às que se ou como mais ' +
    'menos seu sua seus suas este esta estes estas esse essa isso nao sim ser sera serao sao foi pelo pela pelos pelas ' +
    'lei art artigo inciso paragrafo caput deste desta nesta neste').split(' '),
);

export function termos(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !PARADAS.has(t));
}

interface Doc {
  id: string;
  tf: Map<string, number>;
  tam: number;
}

export class Corpus {
  readonly trechos: Map<string, Trecho>;
  private readonly docs: Doc[];
  private readonly df = new Map<string, number>();
  private readonly tamMedio: number;

  constructor(lista: Trecho[], private readonly k1 = 1.2, private readonly b = 0.75) {
    this.trechos = new Map(lista.map((t) => [t.id, t]));
    this.docs = lista.map((t) => {
      const tf = new Map<string, number>();
      const ts = termos(`${t.rotulo} ${t.caminho.join(' ')} ${t.contexto ?? ''} ${t.texto}`);
      for (const w of ts) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      return { id: t.id, tf, tam: ts.length };
    });
    this.tamMedio = this.docs.reduce((s, d) => s + d.tam, 0) / Math.max(1, this.docs.length);
  }

  /** Os k trechos mais relevantes para a consulta (BM25), sem os de `excluir`. */
  busca(consulta: string, k = 3, excluir: Set<string> = new Set()): { trecho: Trecho; pontos: number }[] {
    const q = [...new Set(termos(consulta))];
    const n = this.docs.length;
    const res: { id: string; pontos: number }[] = [];
    for (const d of this.docs) {
      if (excluir.has(d.id)) continue;
      let s = 0;
      for (const w of q) {
        const f = d.tf.get(w);
        if (!f) continue;
        const df = this.df.get(w) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.tam) / this.tamMedio));
      }
      if (s > 0) res.push({ id: d.id, pontos: s });
    }
    return res
      .sort((a, b) => b.pontos - a.pontos)
      .slice(0, k)
      .map((r) => ({ trecho: this.trechos.get(r.id) as Trecho, pontos: r.pontos }));
  }
}

/** Trechos de um achado: os citados pela regra primeiro, depois os complementares da busca. */
export function trechosDoAchado(a: Achado, corpus: Corpus, complementares = 2): Trecho[] {
  const ids = new Set(a.base_legal);
  const saida = a.base_legal.map((id) => corpus.trechos.get(id)).filter((t): t is Trecho => !!t);
  for (const c of a.consultas) {
    for (const { trecho } of corpus.busca(`${c} ${a.titulo}`, complementares, ids)) {
      ids.add(trecho.id);
      saida.push(trecho);
    }
  }
  return saida;
}

/** [CONTEXTO_NORMATIVO_RAG] de uma análise: trechos sem repetição, na ordem dos achados. */
export function contextoNormativo(analise: Analise, corpus: Corpus, complementares = 2): Trecho[] {
  const vistos = new Map<string, Trecho>();
  for (const a of analise.achados) for (const t of trechosDoAchado(a, corpus, complementares)) vistos.set(t.id, t);
  return [...vistos.values()];
}
