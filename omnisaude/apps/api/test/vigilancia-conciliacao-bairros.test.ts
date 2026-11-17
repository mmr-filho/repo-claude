import { normalizarNome } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import type { RequestContext } from '../src/core/context';
import { bairrosComparaveis, bairrosParecidos, ConciliacaoService, distanciaDeEdicao } from '../src/modules/vigilancia/conciliacao.service';

/**
 * Bairros parecidos da conciliação, quarta rodada da semana 27 (VIG-1c, conciliacao-1): num território grande, a página
 * de 50 nomes sem correspondência eram 50 nomes × bairros × apelidos com a distância de edição pela tabela inteira,
 * sem ceder o laço de eventos (3.000 bairros × 4 nomes: 2,4 s parados por página num núcleo cheio). Agora a conta pula
 * o que não muda o resultado, a distância sai por vetores de bits e o laço é cedido entre os nomes. Os candidatos e a
 * ordem têm de ser os mesmos da conta antiga: ela está copiada aqui como referência. Dados sorteados (semente fixa).
 */

// ── Referência: a conta antiga (conciliacao.service.ts da terceira rodada), sem mudar nada ──

const ORDEM = new Intl.Collator('pt-BR');

function semelhancaAntiga(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const pa = new Set(a.split(' '));
  const pb = new Set(b.split(' '));
  const comuns = [...pa].filter((p) => pb.has(p)).length;
  const jaccard = comuns / new Set([...pa, ...pb]).size;
  return Math.max(jaccard, 1 - levenshteinAntigo(a, b) / Math.max(a.length, b.length));
}

function levenshteinAntigo(a: string, b: string): number {
  const linha = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let anterior = linha[0]!;
    linha[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const atual = linha[j]!;
      linha[j] = Math.min(linha[j]! + 1, linha[j - 1]! + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
      anterior = atual;
    }
  }
  return linha[b.length]!;
}

type Bairro = { id: string; nome: string; localidade: string | null; nomes: string[] };

function parecidosAntigos(norm: string, bairros: Bairro[]): string[] {
  return bairros
    .map((b) => ({ b, nota: b.nomes.reduce((m, n) => Math.max(m, semelhancaAntiga(norm, n)), 0) }))
    .filter((x) => x.nota >= 0.5)
    .sort((x, y) => y.nota - x.nota || ORDEM.compare(x.b.nome, y.b.nome))
    .slice(0, 5)
    .map((x) => x.b.id);
}

// ── Sorteio com semente (mulberry32) ──

function sorteador(semente: number) {
  let s = semente >>> 0;
  const proximo = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const inteiro = (n: number) => Math.floor(proximo() * n);
  const um = <T>(xs: readonly T[]) => xs[inteiro(xs.length)]!;
  return { proximo, inteiro, um };
}

const PALAVRAS = ['JARDIM', 'JD', 'VILA', 'VL', 'PARQUE', 'PQ', 'CONJUNTO', 'RESIDENCIAL', 'RES', 'SAO', 'SANTA', 'NOVA', 'BELA', 'VISTA', 'ALTO', 'DO', 'DA', 'DOS', 'CENTRO', 'BOM', 'JESUS', 'AMERICA', 'ESPERANCA', 'PRIMAVERA', 'II', 'III', '1', '2', '10'];
const LETRAS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Nome de bairro sorteado (já normalizado: maiúsculas, dígitos e um espaço entre as palavras). */
function nomeSorteado(r: ReturnType<typeof sorteador>, maximo = 5): string {
  const n = 1 + r.inteiro(maximo);
  const palavras = Array.from({ length: n }, () => (r.proximo() < 0.7 ? r.um(PALAVRAS) : Array.from({ length: 2 + r.inteiro(9) }, () => r.um([...LETRAS])).join('')));
  return normalizarNome(palavras.join(' '));
}

/** Variação de um nome: troca, inclusão ou remoção de letras, palavra a mais ou a menos, abreviação. */
function variacao(r: ReturnType<typeof sorteador>, nome: string): string {
  let s = nome;
  const edicoes = 1 + r.inteiro(4);
  for (let k = 0; k < edicoes; k++) {
    const op = r.inteiro(6);
    const i = r.inteiro(Math.max(1, s.length));
    if (op === 0) s = s.slice(0, i) + r.um([...LETRAS]) + s.slice(i + 1);
    else if (op === 1) s = s.slice(0, i) + r.um([...LETRAS]) + s.slice(i);
    else if (op === 2) s = s.slice(0, i) + s.slice(i + 1);
    else if (op === 3) s = `${s} ${r.um(PALAVRAS)}`;
    else if (op === 4) s = s.split(' ').slice(1).join(' ') || s;
    else s = s.replace('JARDIM', 'JD').replace('VILA', 'VL').replace('PARQUE', 'PQ');
  }
  return normalizarNome(s);
}

function territorio(r: ReturnType<typeof sorteador>, quantos: number): Bairro[] {
  return Array.from({ length: quantos }, (_, i) => {
    const nome = nomeSorteado(r);
    const apelidos = Array.from({ length: r.inteiro(4) }, () => (r.proximo() < 0.6 ? variacao(r, nome) : nomeSorteado(r, 7)));
    return { id: `b${i}`, nome, localidade: null, nomes: [...new Set([nome, ...apelidos].filter(Boolean))] };
  });
}

/** Nomes sem correspondência: variações dos bairros, partes deles, sorteados e alguns longos (mais de 32 letras). */
function nomesDaPagina(r: ReturnType<typeof sorteador>, bairros: Bairro[], quantos: number): string[] {
  return Array.from({ length: quantos }, () => {
    const b = r.um(bairros);
    const x = r.proximo();
    if (x < 0.45) return variacao(r, r.um(b.nomes));
    if (x < 0.55) return r.um(b.nomes).split(' ').slice(0, 1 + r.inteiro(2)).join(' ');
    if (x < 0.65) return `${r.um(b.nomes)} ${nomeSorteado(r, 4)}`;
    if (x < 0.75) return normalizarNome(`${r.um(b.nomes)} ${nomeSorteado(r, 6)} ${nomeSorteado(r, 6)}`);
    if (x < 0.85) return nomeSorteado(r, 6);
    // Sem palavra conhecida: letras sorteadas (quase sempre sem bairro parecido).
    return Array.from({ length: 1 + r.inteiro(4) }, () => Array.from({ length: 3 + r.inteiro(8) }, () => r.um([...LETRAS])).join('')).join(' ');
  }).filter(Boolean);
}

describe('Vigilância: bairros parecidos da conciliação (quarta rodada, conciliacao-1)', () => {
  it('a distância de edição por vetores de bits é a mesma da tabela, inclusive acima de 32 letras e fora do ASCII', () => {
    const r = sorteador(20261117);
    const alfabeto = ['A', 'B', 'C', ' ', '1', 'Ç', 'É'];
    let comparados = 0;
    for (let k = 0; k < 6000; k++) {
      const tam = () => (r.proximo() < 0.15 ? 28 + r.inteiro(12) : r.inteiro(14));
      const a = Array.from({ length: tam() }, () => (r.proximo() < 0.97 ? r.um(alfabeto.slice(0, 5)) : r.um(alfabeto))).join('');
      const b = r.proximo() < 0.3 ? a : Array.from({ length: tam() }, () => r.um(alfabeto.slice(0, 5))).join('');
      expect(distanciaDeEdicao(a, b), `${JSON.stringify(a)} x ${JSON.stringify(b)}`).toBe(levenshteinAntigo(a, b));
      comparados++;
    }
    // As bordas: vazio, 32 e 33 letras, um só caractere.
    for (const [a, b] of [
      ['', ''],
      ['', 'ABC'],
      ['A'.repeat(32), 'A'.repeat(31) + 'B'],
      ['AB'.repeat(16), 'BA'.repeat(16)],
      ['A'.repeat(33), 'B'.repeat(33)],
      ['X', 'Y'],
      ['JARDIM OFICIAL 7A', 'JARDIM OFICIAL 7'],
    ] as const)
      expect(distanciaDeEdicao(a, b)).toBe(levenshteinAntigo(a, b));
    expect(comparados).toBe(6000);
  });

  it('os candidatos e a ordem são os da conta antiga, em territórios e nomes sorteados', () => {
    for (const semente of [1, 2, 3, 4, 5, 6]) {
      const r = sorteador(semente * 7919);
      const bairros = territorio(r, 120 + r.inteiro(200));
      const comparaveis = bairrosComparaveis(bairros);
      let comCandidato = 0;
      for (const norm of nomesDaPagina(r, bairros, 120)) {
        const esperado = parecidosAntigos(norm, bairros);
        if (esperado.length) comCandidato++;
        expect(
          bairrosParecidos(norm, comparaveis).map((b) => b.id),
          `semente ${semente}: ${norm}`,
        ).toEqual(esperado);
      }
      // O sorteio cobre os dois lados: nomes com e sem bairro parecido.
      expect(comCandidato).toBeGreaterThan(20);
      expect(comCandidato).toBeLessThan(120);
    }
  });

  it('3.000 bairros × 4 nomes numa página de 50: muito menos tempo que a conta antiga e o laço de eventos cedido entre os nomes', async () => {
    const letras = (i: number, n: number) => Array.from({ length: n }, (_, k) => String.fromCharCode(65 + (Math.floor(i / 26 ** k) % 26))).join('');
    const bairros: Bairro[] = Array.from({ length: 3000 }, (_, i) => {
      const nome = `JARDIM RESIDENCIAL ${letras(i, 5)}`;
      return { id: `b${i}`, nome, localidade: null, nomes: [nome, `JD RES ${letras(i, 5)} 1`, `JARDIM RES ${letras(i, 5)}`, `RESIDENCIAL ${letras(i, 5)} II`] };
    });
    // 200 nomes sem correspondência de ~24 letras: os da página 1 são os com mais registros (alguns parecidos com bairros).
    const grafias = Array.from({ length: 200 }, (_, i) => (i % 10 === 0 ? `JARDIM RESIDENCIAL ${letras(i * 7, 5)}X` : `VILA LIVRE ${letras(i, 8)} CONJ`));
    const nomes = new Map(grafias.map((g, i) => [g, { contagens: new Map([[g, 1000 - i]]), codigo: null, registros: 1000 - i }]));
    const pagina = grafias.slice(0, 50);

    const t0 = performance.now();
    const antigos = pagina.map((n) => parecidosAntigos(n, bairros));
    const tempoAntigo = performance.now() - t0;

    const t1 = performance.now();
    const comparaveis = bairrosComparaveis(bairros);
    const novos = pagina.map((n) => bairrosParecidos(n, comparaveis).map((b) => b.id));
    const tempoNovo = performance.now() - t1;
    expect(novos).toEqual(antigos);

    // A página pelo serviço (a leitura do banco simulada), medindo o maior atraso do laço de eventos.
    const servico = Object.create(ConciliacaoService.prototype) as ConciliacaoService & { nomesSemCorrespondencia: () => Promise<unknown> };
    servico.nomesSemCorrespondencia = async () => ({ nomes, bairros });
    let maior = 0;
    let ultimo = performance.now();
    const relogio = setInterval(() => {
      const agora = performance.now();
      maior = Math.max(maior, agora - ultimo - 5);
      ultimo = agora;
    }, 5);
    const t2 = performance.now();
    let lista: Awaited<ReturnType<ConciliacaoService['bairros']>>;
    try {
      lista = await servico.bairros({} as RequestContext, { pagina: 1 });
    } finally {
      clearInterval(relogio);
    }
    const tempoServico = performance.now() - t2;
    console.log(`conciliacao-1: página de 50 com 3.000 bairros × 4 nomes: conta antiga ${tempoAntigo.toFixed(0)} ms; nova ${tempoNovo.toFixed(0)} ms; serviço ${tempoServico.toFixed(0)} ms, laço parado no máximo ${maior.toFixed(0)} ms`);
    expect(lista.total).toBe(200);
    expect(lista.itens.map((i) => i.nome)).toEqual(pagina);
    expect(lista.itens.map((i) => i.candidatos.map((c) => c.neighborhoodId))).toEqual(antigos);
    expect(lista.itens.filter((i) => i.candidatos.length).length).toBeGreaterThanOrEqual(5);
    expect(tempoNovo).toBeLessThan(tempoAntigo / 3);
    // Antes, a página inteira rodava sem ceder o laço: o atraso era o tempo da página.
    expect(maior).toBeLessThan(Math.max(250, tempoAntigo / 8));
  });
});
