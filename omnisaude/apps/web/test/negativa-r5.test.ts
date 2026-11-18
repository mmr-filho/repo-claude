import type { AtestoNegativa, CelulaGrade, ColunaGrade, LinhaGradeNegativa, ListaUnidadesNotificantes, RespostaMinhasNegativas, UnidadeNotificante } from '@omnisaude/shared';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Quinta rodada da semana 27 (notificação negativa), renderizada no servidor com a API e a sessão simuladas.
 * R5-10: os nomes acessíveis que se repetiam ficam distintos — na tela do responsável com mais de uma unidade, Atestar
 * e o PDF dizem a unidade; no histórico, o atesto que não é o vigente (anulado, cancelado) diz a situação e quando foi
 * atestado; e o "Revogar" das unidades notificantes diz a unidade. R5-11: o detalhe da célula da grade mostra o prazo
 * da semana (o da regra de agora, o da coluna) e o prazo do atesto (o gravado com ele, que decidiu o "fora do prazo").
 * "Hoje" fixo: quarta 15/07/2026 em Brasília.
 */

const simulado = vi.hoisted(() => ({
  respostas: new Map<string, unknown>(),
  busca: new URLSearchParams(),
  botoes: [] as { texto: string; rotulo?: string }[],
}));

vi.mock('@/lib/hooks', () => ({
  useApi: (path: string | null) => {
    const chave = path ? [...simulado.respostas.keys()].find((k) => path.startsWith(k)) : undefined;
    return { data: chave ? simulado.respostas.get(chave) : null, error: null, loading: false, reload: async () => {}, setData: () => {} };
  },
}));

vi.mock('@/lib/session', () => ({
  useSession: () => ({ me: { tenant: { timeZone: 'America/Sao_Paulo' }, context: { role: 'VIGILANCIA_EPIDEMIOLOGICA', unitId: 'u1' }, permissions: [] }, can: () => true }),
}));

vi.mock('next/navigation', () => ({ useSearchParams: () => simulado.busca }));

// O diálogo aparece inline (o Radix usa portal, que não sai na renderização no servidor).
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  return {
    Dialog: (p: { open: boolean; title: string; description?: string; children: unknown; footer?: unknown }) =>
      p.open ? h('section', { 'data-dialogo': p.title }, h('h2', null, p.title), p.description ? h('p', null, p.description) : null, p.children as never, p.footer as never) : null,
  };
});

// O botão de verdade, que também guarda o texto e o nome acessível de cada um.
vi.mock('@/components/ui/button', async () => {
  const { createElement: h, isValidElement } = await import('react');
  const texto = (n: unknown): string =>
    typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(texto).join('') : isValidElement(n) ? texto((n.props as { children?: unknown }).children) : '';
  return {
    Button: ({ loading, variant: _v, size: _s, children, ...p }: { loading?: boolean; variant?: string; size?: string; children?: unknown; onClick?: () => unknown; 'aria-label'?: string; disabled?: boolean }) => {
      simulado.botoes.push({ texto: texto(children).replace(/\s+/g, ' ').trim(), rotulo: p['aria-label'] });
      return h('button', { type: 'button', ...p, onClick: undefined, disabled: p.disabled || loading }, children as never);
    },
  };
});

const { NegativaUnidades } = await import('../src/components/consolidacao/negativa-unidades');
const { NegativaMinhas } = await import('../src/components/consolidacao/negativa-minhas');
const grade = await import('../src/components/consolidacao/negativa-grade');
const regras = await import('../src/components/consolidacao/negativa-regras');

const html = <P extends object>(c: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(c, props));
/** Os nomes acessíveis dos botões com o texto dado, na ordem da tela. */
const rotulos = (texto: string) => simulado.botoes.filter((b) => b.texto === texto).map((b) => b.rotulo ?? null);
const repetidos = (xs: (string | null)[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-15T15:00:00Z'));
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  simulado.respostas.clear();
  simulado.botoes = [];
});

const atesto = (id: string, semana: string, unitId: string, nome: string, status: AtestoNegativa['status'] = 'ATESTADA', atestadoEm = '2026-06-01T15:00:00.000Z'): AtestoNegativa => ({
  id,
  unitId,
  unidade: nome,
  cnes: unitId === 'u1' ? '9000011' : '9000012',
  semana,
  status,
  atestadoEm,
  atestadoPor: 'Bruno Almeida Enfermeiro',
  funcao: null,
  emNome: false,
  motivoEmNome: null,
  atrasado: false,
  declaracao: 'Declaro.',
  canceladoEm: status === 'ATESTADA' ? null : '2026-06-02T15:00:00.000Z',
  motivoCancelamento: status === 'ANULADA' ? 'Atesto feito por engano na unidade errada' : null,
  causa: status === 'CANCELADA' ? { tipo: 'NOTIFICACAO', id: 'n1' } : null,
  registroOficialId: null,
});

const semana = (s: string, extra: object) => ({
  semana: s,
  inicio: '2026-06-28',
  fim: '2026-07-04',
  situacao: 'SEM_INFORMACAO',
  prazo: '2026-07-06T17:00:00.000Z',
  prazoPassou: true,
  podeAtestar: true,
  motivo: null,
  atesto: null,
  texto: 'Eu, Bruno, declaro...',
  ...extra,
});

describe('R5-10: nomes acessíveis distintos na tela do responsável', () => {
  it('com duas unidades, Atestar e o PDF da semana dizem a unidade (r4vneg-1)', () => {
    const r = {
      unidades: [
        {
          unidade: { id: 'u1', nome: 'UBS Centro', cnes: '9000011' },
          tipo: 'TITULAR',
          semanas: [semana('202627', {}), semana('202626', { podeAtestar: false, situacao: 'NEGATIVA', atesto: atesto('a1', '202626', 'u1', 'UBS Centro') })],
        },
        {
          unidade: { id: 'u2', nome: 'UBS Jardim', cnes: '9000012' },
          tipo: 'TITULAR',
          semanas: [semana('202627', {}), semana('202626', { podeAtestar: false, situacao: 'NEGATIVA', atesto: atesto('a2', '202626', 'u2', 'UBS Jardim') })],
        },
      ],
      historico: [],
    } as unknown as RespostaMinhasNegativas;
    simulado.respostas.set('/vigilancia/negativas/minhas', r);
    html(NegativaMinhas, {});
    expect(rotulos('Atestar')).toEqual(['Atestar a SE 27/2026, UBS Centro', 'Atestar a SE 27/2026, UBS Jardim']);
    expect(rotulos('PDF')).toEqual(['Espelho em PDF da SE 26/2026, UBS Centro', 'Espelho em PDF da SE 26/2026, UBS Jardim']);
  });

  it('com uma unidade só, os nomes seguem só com a SE (a tela é da unidade)', () => {
    const r = {
      unidades: [
        {
          unidade: { id: 'u1', nome: 'UBS Centro', cnes: '9000011' },
          tipo: 'TITULAR',
          semanas: [semana('202627', {}), semana('202626', { podeAtestar: false, situacao: 'NEGATIVA', atesto: atesto('a1', '202626', 'u1', 'UBS Centro') })],
        },
      ],
      historico: [],
    } as unknown as RespostaMinhasNegativas;
    simulado.respostas.set('/vigilancia/negativas/minhas', r);
    html(NegativaMinhas, {});
    expect(rotulos('Atestar')).toEqual(['Atestar a SE 27/2026']);
    expect(rotulos('PDF')).toEqual(['Espelho em PDF da SE 26/2026']);
  });

  it('no histórico, o atesto anulado e o refeito da mesma SE e unidade têm nomes distintos; o anulado e o cancelado dizem a situação e quando foram atestados (r4vneg-2)', () => {
    const r = {
      unidades: [],
      historico: [
        atesto('a3', '202625', 'u1', 'UBS Centro', 'ATESTADA', '2026-06-03T13:10:00.000Z'),
        atesto('a4', '202625', 'u1', 'UBS Centro', 'ANULADA', '2026-06-01T15:00:00.000Z'),
        atesto('a5', '202624', 'u1', 'UBS Centro', 'CANCELADA', '2026-06-15T12:30:00.000Z'),
      ],
    } as unknown as RespostaMinhasNegativas;
    simulado.respostas.set('/vigilancia/negativas/minhas', r);
    html(NegativaMinhas, {});
    const pdf = rotulos('PDF');
    expect(pdf).toEqual([
      'Espelho em PDF da SE 25/2026, UBS Centro',
      'Espelho em PDF da SE 25/2026, UBS Centro, anulada, atestada em 01/06/2026, 12:00',
      'Espelho em PDF da SE 24/2026, UBS Centro, cancelada, atestada em 15/06/2026, 09:30',
    ]);
    expect(repetidos(pdf)).toEqual([]);
  });

  it('na semana, o atesto que não é o vigente também diz a situação (o mesmo nome do histórico, para o mesmo espelho)', () => {
    const anulado = atesto('a6', '202626', 'u1', 'UBS Centro', 'ANULADA', '2026-06-29T14:00:00.000Z');
    const r = {
      unidades: [{ unidade: { id: 'u1', nome: 'UBS Centro', cnes: '9000011' }, tipo: 'TITULAR', semanas: [semana('202626', { situacao: 'SEM_INFORMACAO', atesto: anulado })] }],
      historico: [anulado],
    } as unknown as RespostaMinhasNegativas;
    simulado.respostas.set('/vigilancia/negativas/minhas', r);
    html(NegativaMinhas, {});
    expect(rotulos('PDF')).toEqual(['Espelho em PDF da SE 26/2026, anulada, atestada em 29/06/2026, 11:00', 'Espelho em PDF da SE 26/2026, UBS Centro, anulada, atestada em 29/06/2026, 11:00']);
  });

  it('o cenário do revisor inteiro (duas unidades, com o histórico das duas): nenhum nome repetido para espelhos diferentes', () => {
    const vigentes = [atesto('a1', '202626', 'u1', 'UBS Centro'), atesto('a2', '202626', 'u2', 'UBS Jardim')];
    const r = {
      unidades: [
        { unidade: { id: 'u1', nome: 'UBS Centro', cnes: '9000011' }, tipo: 'TITULAR', semanas: [semana('202627', {}), semana('202626', { podeAtestar: false, situacao: 'NEGATIVA', atesto: vigentes[0] })] },
        { unidade: { id: 'u2', nome: 'UBS Jardim', cnes: '9000012' }, tipo: 'SUBSTITUTO', semanas: [semana('202627', {}), semana('202626', { podeAtestar: false, situacao: 'NEGATIVA', atesto: vigentes[1] })] },
      ],
      historico: [...vigentes, atesto('a7', '202626', 'u1', 'UBS Centro', 'ANULADA', '2026-06-29T14:00:00.000Z')],
    } as unknown as RespostaMinhasNegativas;
    simulado.respostas.set('/vigilancia/negativas/minhas', r);
    html(NegativaMinhas, {});
    expect(repetidos(rotulos('Atestar'))).toEqual([]);
    // O mesmo atesto na semana e no histórico tem o mesmo nome (é o mesmo espelho); espelhos diferentes, nomes diferentes.
    const porNome = new Map<string, Set<string>>();
    const ids = ['a1', 'a2', 'a1', 'a2', 'a7'];
    rotulos('PDF').forEach((n, i) => porNome.set(n!, new Set([...(porNome.get(n!) ?? []), ids[i]!])));
    expect([...porNome.values()].every((s) => s.size === 1)).toBe(true);
    expect(porNome.size).toBe(3);
  });
});

describe('R5-10: "Revogar" das unidades notificantes diz a unidade (r4vneg-3)', () => {
  it('o mesmo responsável em duas unidades (o enfermeiro da demonstração)', () => {
    const responsavel = (id: string) => ({
      id,
      userId: 'enf',
      nome: 'Bruno Almeida Enfermeiro',
      tipo: 'TITULAR' as const,
      desde: '2026-01-01',
      ate: null,
      designadoEm: '2026-01-01T13:00:00.000Z',
      designadoPor: 'Vera',
      valido: true,
      motivoInvalido: null,
    });
    const unidade = (id: string, nome: string, r: ReturnType<typeof responsavel>): UnidadeNotificante => ({
      unidade: { id, nome, cnes: `90000${id}` },
      tipoUnidade: 'UBS',
      ativa: true,
      periodoAtual: { id: `p${id}`, desde: '2026-01-01', ate: null, motivoFim: null },
      periodos: [{ id: `p${id}`, desde: '2026-01-01', ate: null, motivoFim: null }],
      responsaveis: [r],
      semConfiguracao: false,
      avisos: [],
    });
    const lista: ListaUnidadesNotificantes = [unidade('11', 'UBS Centro', responsavel('r1')), unidade('12', 'UPA 24h', responsavel('r2'))];
    simulado.respostas.set('/vigilancia/unidades-notificantes', lista);
    const h = html(NegativaUnidades, {});
    expect(rotulos('Revogar')).toEqual(['Revogar a designação de Bruno Almeida Enfermeiro como responsável da UBS Centro', 'Revogar a designação de Bruno Almeida Enfermeiro como responsável da UPA 24h']);
    expect(h).toContain('aria-label="Revogar a designação de Bruno Almeida Enfermeiro como responsável da UPA 24h"');
  });
});

describe('R5-11: o detalhe da célula mostra o prazo da semana e o prazo gravado do atesto (r4vneg-4)', () => {
  const linha: Pick<LinhaGradeNegativa, 'unidade'> = { unidade: { id: 'u1', nome: 'UBS V4 Prazo Gravado', cnes: '9005901' } };
  // SE 24/2026 (14 a 20/06): o prazo da coluna é o da regra de agora (segunda 22/06, 18h); o atesto das 14h30 foi
  // julgado pelo prazo que valia quando foi feito (14h) e está fora do prazo.
  const coluna: ColunaGrade = { semana: '202624', inicio: '2026-06-14', fim: '2026-06-20', fechada: true, prazo: '2026-06-22T21:00:00.000Z' };
  const celula: CelulaGrade = {
    semana: '202624',
    situacao: 'NEGATIVA_ATRASADA',
    fontes: { notificacoes: 0, surtos: 0, registrosOficiais: 0, atesto: { id: 'a1', atrasado: true, prazo: '2026-06-22T17:00:00.000Z' }, negativaSinan: false },
  };

  it('regras: "prazo da semana" é o da coluna; com atesto, "prazo do atesto" é o gravado; a nota explica quando os dois diferem', () => {
    expect(regras.descricaoDaCelula(linha, coluna, 'America/Sao_Paulo')).toBe('CNES 9005901 · de 14/06 a 20/06 · prazo da semana: 22/06/2026, 18:00');
    expect(regras.descricaoDaCelula(linha, coluna, 'America/Sao_Paulo', celula.fontes.atesto)).toBe('CNES 9005901 · de 14/06 a 20/06 · prazo da semana: 22/06/2026, 18:00 · prazo do atesto: 22/06/2026, 14:00');
    expect(regras.notaPrazoDoAtesto(coluna, celula.fontes.atesto)).toBe('O prazo do atesto é o que valia quando ele foi feito; a regra do prazo mudou depois.');
    // Sem mudança de regra, os dois prazos são o mesmo e não há nota; sem atesto, também não.
    expect(regras.notaPrazoDoAtesto(coluna, { ...celula.fontes.atesto!, prazo: coluna.prazo })).toBeNull();
    expect(regras.notaPrazoDoAtesto(coluna, null)).toBeNull();
  });

  it('o diálogo da célula: o atesto das 14h30 fora do prazo aparece com o prazo do atesto das 14h, não com o da semana', () => {
    const h = html(grade.CelulaDialog, {
      aberta: { linha: { ...linha, tipoUnidade: 'UBS', ativa: true, celulas: [celula] }, celula, coluna },
      podeConfigurar: true,
      onFechar: () => {},
      onMudou: () => {},
    });
    expect(h).toContain('prazo da semana: 22/06/2026, 18:00 · prazo do atesto: 22/06/2026, 14:00');
    expect(h).not.toContain('prazo do atesto: 22/06/2026, 18:00');
    expect(h).toContain('atesto fora do prazo');
    expect(h).toContain('O prazo do atesto é o que valia quando ele foi feito; a regra do prazo mudou depois.');
  });

  it('o diálogo da célula sem atesto mostra só o prazo da semana', () => {
    const vazia: CelulaGrade = { semana: '202624', situacao: 'SEM_INFORMACAO', fontes: { notificacoes: 0, surtos: 0, registrosOficiais: 0, atesto: null, negativaSinan: false } };
    const h = html(grade.CelulaDialog, { aberta: { linha: { ...linha, tipoUnidade: 'UBS', ativa: true, celulas: [vazia] }, celula: vazia, coluna }, podeConfigurar: true, onFechar: () => {}, onMudou: () => {} });
    expect(h).toContain('CNES 9005901 · de 14/06 a 20/06 · prazo da semana: 22/06/2026, 18:00');
    expect(h).not.toContain('prazo do atesto');
  });
});
