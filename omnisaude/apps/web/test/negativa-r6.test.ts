import type { AtestoNegativa, ListaUnidadesNotificantes, RespostaGradeNegativa, RespostaMinhasNegativas, UnidadeNotificante } from '@omnisaude/shared';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Sexta rodada da semana 27 (notificação negativa), renderizada no servidor com a API e a sessão simuladas.
 * R6-6 (r5vout-1): os nomes acessíveis não se repetem também com unidades de mesmo nome (o nome não é único, só o CNES
 * é: units_cnes_key) e com atestos que não são o vigente atestados no mesmo minuto. O nome leva o CNES quando outra
 * unidade da mesma tela tem o mesmo nome; o PDF do atesto que não é o vigente diz a hora com os segundos (e, se dois
 * ainda coincidirem no mesmo segundo, a ordem deles); e os botões das unidades notificantes dizem "da unidade <nome>"
 * (antes saía "responsável da Posto de Saúde"). "Hoje" fixo: quarta 15/07/2026 em Brasília.
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

const { NegativaUnidades, EncerrarPeriodo } = await import('../src/components/consolidacao/negativa-unidades');
const { NegativaMinhas } = await import('../src/components/consolidacao/negativa-minhas');
const { NegativaGrade } = await import('../src/components/consolidacao/negativa-grade');
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

const atesto = (id: string, semana: string, unitId: string, cnes: string, nome: string, status: AtestoNegativa['status'] = 'ATESTADA', atestadoEm = '2026-06-01T15:00:00.000Z'): AtestoNegativa => ({
  id,
  unitId,
  unidade: nome,
  cnes,
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
  motivoCancelamento: status === 'ANULADA' ? 'Atesto feito por engano' : null,
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

/** Unidade do responsável com a SE 27 a atestar e a SE 26 atestada (`a`). */
const doResponsavel = (id: string, nome: string, cnes: string, a: AtestoNegativa) => ({
  unidade: { id, nome, cnes },
  tipo: 'TITULAR',
  semanas: [semana('202627', {}), semana('202626', { podeAtestar: false, situacao: 'NEGATIVA', atesto: a })],
});

describe('R6-6: tela do responsável com unidades de mesmo nome (r5vout-1)', () => {
  it('duas unidades "Posto de Saúde" (CNES 9100001 e 9100002): Atestar e o PDF dizem o CNES de cada uma', () => {
    const r = {
      unidades: [
        doResponsavel('u1', 'Posto de Saúde', '9100001', atesto('a1', '202626', 'u1', '9100001', 'Posto de Saúde')),
        doResponsavel('u2', 'Posto de Saúde', '9100002', atesto('a2', '202626', 'u2', '9100002', 'Posto de Saúde')),
      ],
      historico: [],
    } as unknown as RespostaMinhasNegativas;
    simulado.respostas.set('/vigilancia/negativas/minhas', r);
    html(NegativaMinhas, {});
    expect(rotulos('Atestar')).toEqual(['Atestar a SE 27/2026, Posto de Saúde (CNES 9100001)', 'Atestar a SE 27/2026, Posto de Saúde (CNES 9100002)']);
    expect(rotulos('PDF')).toEqual(['Espelho em PDF da SE 26/2026, Posto de Saúde (CNES 9100001)', 'Espelho em PDF da SE 26/2026, Posto de Saúde (CNES 9100002)']);
  });

  it('só as unidades de mesmo nome levam o CNES (maiúsculas e acentos não distinguem o nome); a de outro nome fica só com o nome', () => {
    const r = {
      unidades: [
        doResponsavel('u1', 'Posto de Saúde', '9100001', atesto('a1', '202626', 'u1', '9100001', 'Posto de Saúde')),
        doResponsavel('u2', 'POSTO DE SAUDE', '9100002', atesto('a2', '202626', 'u2', '9100002', 'POSTO DE SAUDE')),
        doResponsavel('u3', 'UBS Centro', '9000011', atesto('a3', '202626', 'u3', '9000011', 'UBS Centro')),
      ],
      historico: [],
    } as unknown as RespostaMinhasNegativas;
    simulado.respostas.set('/vigilancia/negativas/minhas', r);
    html(NegativaMinhas, {});
    expect(rotulos('Atestar')).toEqual(['Atestar a SE 27/2026, Posto de Saúde (CNES 9100001)', 'Atestar a SE 27/2026, POSTO DE SAUDE (CNES 9100002)', 'Atestar a SE 27/2026, UBS Centro']);
    expect(repetidos(rotulos('PDF'))).toEqual([]);
  });

  it('uma unidade só, com uma de mesmo nome no histórico: a semana segue só com a SE; o histórico diz o CNES de cada uma', () => {
    const a1 = atesto('a1', '202626', 'u1', '9100001', 'Posto de Saúde');
    const r = {
      unidades: [doResponsavel('u1', 'Posto de Saúde', '9100001', a1)],
      // A outra "Posto de Saúde" é de quando a pessoa respondia por ela (o histórico junta as unidades).
      historico: [a1, atesto('a9', '202625', 'u2', '9100002', 'Posto de Saúde')],
    } as unknown as RespostaMinhasNegativas;
    simulado.respostas.set('/vigilancia/negativas/minhas', r);
    html(NegativaMinhas, {});
    expect(rotulos('Atestar')).toEqual(['Atestar a SE 27/2026']);
    expect(rotulos('PDF')).toEqual(['Espelho em PDF da SE 26/2026', 'Espelho em PDF da SE 26/2026, Posto de Saúde (CNES 9100001)', 'Espelho em PDF da SE 25/2026, Posto de Saúde (CNES 9100002)']);
  });

  it('com as duas de mesmo nome e o histórico delas: o mesmo atesto na semana e no histórico tem o mesmo nome; espelhos diferentes, nomes diferentes', () => {
    const vigentes = [atesto('a1', '202626', 'u1', '9100001', 'Posto de Saúde'), atesto('a2', '202626', 'u2', '9100002', 'Posto de Saúde')];
    const r = {
      unidades: [doResponsavel('u1', 'Posto de Saúde', '9100001', vigentes[0]!), doResponsavel('u2', 'Posto de Saúde', '9100002', vigentes[1]!)],
      historico: [...vigentes, atesto('a7', '202626', 'u1', '9100001', 'Posto de Saúde', 'ANULADA', '2026-06-29T14:00:00.000Z')],
    } as unknown as RespostaMinhasNegativas;
    simulado.respostas.set('/vigilancia/negativas/minhas', r);
    html(NegativaMinhas, {});
    const pdf = rotulos('PDF');
    expect(pdf).toEqual([
      'Espelho em PDF da SE 26/2026, Posto de Saúde (CNES 9100001)',
      'Espelho em PDF da SE 26/2026, Posto de Saúde (CNES 9100002)',
      'Espelho em PDF da SE 26/2026, Posto de Saúde (CNES 9100001)',
      'Espelho em PDF da SE 26/2026, Posto de Saúde (CNES 9100002)',
      'Espelho em PDF da SE 26/2026, Posto de Saúde (CNES 9100001), anulada, atestada em 29/06/2026, 11:00:00',
    ]);
    const porNome = new Map<string, Set<string>>();
    const ids = ['a1', 'a2', 'a1', 'a2', 'a7'];
    pdf.forEach((n, i) => porNome.set(n!, new Set([...(porNome.get(n!) ?? []), ids[i]!])));
    expect([...porNome.values()].every((s) => s.size === 1)).toBe(true);
    expect(porNome.size).toBe(3);
  });
});

describe('R6-6: histórico com atestos que não são o vigente atestados no mesmo minuto (r5vout-1)', () => {
  it('a hora do PDF vai com os segundos: dois anulados da mesma SE e unidade, no mesmo minuto, ficam distintos', () => {
    const r = {
      unidades: [],
      historico: [
        atesto('a3', '202625', 'u1', '9000011', 'UBS Centro', 'ATESTADA', '2026-06-01T15:07:50.000Z'),
        atesto('a4', '202625', 'u1', '9000011', 'UBS Centro', 'ANULADA', '2026-06-01T15:07:30.000Z'),
        atesto('a5', '202625', 'u1', '9000011', 'UBS Centro', 'ANULADA', '2026-06-01T15:07:05.000Z'),
      ],
    } as unknown as RespostaMinhasNegativas;
    simulado.respostas.set('/vigilancia/negativas/minhas', r);
    html(NegativaMinhas, {});
    expect(rotulos('PDF')).toEqual([
      'Espelho em PDF da SE 25/2026, UBS Centro',
      'Espelho em PDF da SE 25/2026, UBS Centro, anulada, atestada em 01/06/2026, 12:07:30',
      'Espelho em PDF da SE 25/2026, UBS Centro, anulada, atestada em 01/06/2026, 12:07:05',
    ]);
  });

  it('no mesmo segundo, cada anulado diz a sua ordem pela hora do atesto; o cancelado do mesmo segundo já se distingue pela situação', () => {
    // A ordem da API: SE e hora do atesto, do mais recente para o mais antigo.
    const r = {
      unidades: [],
      historico: [
        atesto('a7', '202625', 'u1', '9000011', 'UBS Centro', 'ANULADA', '2026-06-01T15:07:05.900Z'),
        atesto('a8', '202625', 'u1', '9000011', 'UBS Centro', 'CANCELADA', '2026-06-01T15:07:05.500Z'),
        atesto('a6', '202625', 'u1', '9000011', 'UBS Centro', 'ANULADA', '2026-06-01T15:07:05.200Z'),
      ],
    } as unknown as RespostaMinhasNegativas;
    simulado.respostas.set('/vigilancia/negativas/minhas', r);
    html(NegativaMinhas, {});
    expect(rotulos('PDF')).toEqual([
      'Espelho em PDF da SE 25/2026, UBS Centro, anulada, atestada em 01/06/2026, 12:07:05 (2 de 2)',
      'Espelho em PDF da SE 25/2026, UBS Centro, cancelada, atestada em 01/06/2026, 12:07:05',
      'Espelho em PDF da SE 25/2026, UBS Centro, anulada, atestada em 01/06/2026, 12:07:05 (1 de 2)',
    ]);
  });
});

describe('R6-6: unidades notificantes com unidades de mesmo nome (r5vout-1)', () => {
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
  const aberto = (id: string) => ({ id, desde: '2026-01-01', ate: null, motivoFim: null });
  const unidade = (id: string, nome: string, cnes: string, o: Partial<UnidadeNotificante> = {}): UnidadeNotificante => ({
    unidade: { id, nome, cnes },
    tipoUnidade: 'UBS',
    ativa: true,
    periodoAtual: null,
    periodos: [],
    responsaveis: [],
    semConfiguracao: false,
    avisos: [],
    ...o,
  });
  const notificante = (id: string, nome: string, cnes: string, r: ReturnType<typeof responsavel>) => unidade(id, nome, cnes, { periodoAtual: aberto(`p${id}`), periodos: [aberto(`p${id}`)], responsaveis: [r] });

  it('o mesmo enfermeiro nas duas "Posto de Saúde": cada "Revogar" diz "da unidade" e o CNES', () => {
    const lista: ListaUnidadesNotificantes = [notificante('u1', 'Posto de Saúde', '9100001', responsavel('r1')), notificante('u2', 'Posto de Saúde', '9100002', responsavel('r2'))];
    simulado.respostas.set('/vigilancia/unidades-notificantes', lista);
    const h = html(NegativaUnidades, {});
    expect(rotulos('Revogar')).toEqual([
      'Revogar a designação de Bruno Almeida Enfermeiro como responsável da unidade Posto de Saúde (CNES 9100001)',
      'Revogar a designação de Bruno Almeida Enfermeiro como responsável da unidade Posto de Saúde (CNES 9100002)',
    ]);
    expect(h).toContain('aria-label="Revogar a designação de Bruno Almeida Enfermeiro como responsável da unidade Posto de Saúde (CNES 9100002)"');
  });

  it('Designar, Encerrar período e Tornar notificante: o CNES só nas de mesmo nome; "da unidade <nome>"', () => {
    const lista: ListaUnidadesNotificantes = [
      notificante('u1', 'Posto de Saúde', '9100001', responsavel('r1')),
      notificante('u2', 'Posto de Saúde', '9100002', responsavel('r2')),
      unidade('u3', 'Posto de Saúde', '9100003', { semConfiguracao: true }),
      unidade('u4', 'UBS Norte', '9000014', { semConfiguracao: true }),
    ];
    simulado.respostas.set('/vigilancia/unidades-notificantes', lista);
    html(NegativaUnidades, {});
    expect(rotulos('Designar')).toEqual(['Designar responsável da unidade Posto de Saúde (CNES 9100001)', 'Designar responsável da unidade Posto de Saúde (CNES 9100002)']);
    expect(rotulos('Encerrar período')).toEqual(['Encerrar o período da unidade Posto de Saúde (CNES 9100001)', 'Encerrar o período da unidade Posto de Saúde (CNES 9100002)']);
    expect(rotulos('Tornar notificante')).toEqual(['Tornar Posto de Saúde (CNES 9100003) notificante', 'Tornar UBS Norte notificante']);
    // Nenhum nome acessível repetido entre todos os botões da tela (Designar, Encerrar, Tornar e os Revogar).
    expect(repetidos(simulado.botoes.flatMap((b) => (b.rotulo ? [b.rotulo] : [])))).toEqual([]);
  });

  it('o diálogo chama a unidade como a linha (com o CNES quando há outra de mesmo nome)', () => {
    const u = notificante('u2', 'Posto de Saúde', '9100002', responsavel('r2'));
    const h = html(EncerrarPeriodo, { u, nome: 'Posto de Saúde (CNES 9100002)', onFechar: () => {}, onFeito: () => {} });
    expect(h).toContain('data-dialogo="Encerrar o período: Posto de Saúde (CNES 9100002)"');
    // Sem o nome da tela, o diálogo usa o nome da unidade (como antes).
    expect(html(EncerrarPeriodo, { u, onFechar: () => {}, onFeito: () => {} })).toContain('data-dialogo="Encerrar o período: Posto de Saúde"');
  });
});

describe('R6-6: grade com unidades de mesmo nome', () => {
  it('as células e o cartão das silenciosas dizem o CNES das unidades de mesmo nome', () => {
    const vazio = { notificacoes: 0, surtos: 0, registrosOficiais: 0, atesto: null, negativaSinan: false };
    const linha = (id: string, nome: string, cnes: string, situacao: string, fontes: object = vazio) => ({
      unidade: { id, nome, cnes },
      tipoUnidade: 'UBS',
      ativa: true,
      celulas: [{ semana: '202627', situacao, fontes }],
    });
    const grade = {
      colunas: [{ semana: '202627', inicio: '2026-06-28', fim: '2026-07-04', fechada: true, prazo: '2026-07-06T17:00:00.000Z' }],
      linhas: [
        linha('u1', 'Posto de Saúde', '9100001', 'SEM_INFORMACAO'),
        linha('u2', 'Posto de Saúde', '9100002', 'SEM_INFORMACAO'),
        linha('u3', 'UBS Centro', '9000011', 'NEGATIVA', { ...vazio, atesto: { id: 'a1', atrasado: false, prazo: '2026-07-06T17:00:00.000Z' } }),
      ],
      analise: {
        silenciosas: [
          { unitId: 'u1', semanasSeguidas: 1 },
          { unitId: 'u2', semanasSeguidas: 1 },
        ],
        soNegativas: [],
        percentualPorSemana: [{ semana: 0, comInformacao: 1, notificantes: 3, percentual: 33.3 }],
        regularidadeMunicipal: { semanasSemInformacao: 0, irregular: false },
      },
      metaPercentual: 80,
      atestadoSemSinan: [],
      sinanSemAtesto: [],
      avisos: [],
    } as unknown as RespostaGradeNegativa;
    simulado.respostas.set('/vigilancia/negativas/grade', grade);
    const h = html(NegativaGrade, { podeConfigurar: true });
    const celulas = [...h.matchAll(/<button[^>]*aria-label="([^"]*SE 27\/2026[^"]*)"/g)].map((m) => m[1]);
    expect(celulas).toEqual([
      'Posto de Saúde (CNES 9100001), SE 27/2026: Sem informação. nenhuma informação.',
      'Posto de Saúde (CNES 9100002), SE 27/2026: Sem informação. nenhuma informação.',
      'UBS Centro, SE 27/2026: Negativa. atesto no prazo.',
    ]);
    expect(h).toContain('>Posto de Saúde (CNES 9100001)</span>');
    expect(h).toContain('>Posto de Saúde (CNES 9100002)</span>');
  });
});

describe('R6-6: regras dos nomes', () => {
  it('nomeDaUnidadeNaTela: o CNES só quando outra unidade (outro id) tem o mesmo nome, sem diferença de maiúsculas, acentos e espaços', () => {
    const nome = regras.nomeDaUnidadeNaTela([
      { id: 'u1', nome: 'Posto de Saúde' },
      { id: 'u2', nome: 'POSTO  DE   SAUDE' },
      { id: 'u3', nome: 'UBS Centro' },
      // A mesma unidade em dois lugares da tela (a semana e o histórico) não é outra unidade.
      { id: 'u3', nome: 'UBS Centro' },
    ]);
    expect(nome({ nome: 'Posto de Saúde', cnes: '9100001' })).toBe('Posto de Saúde (CNES 9100001)');
    expect(nome({ nome: 'POSTO  DE   SAUDE', cnes: '9100002' })).toBe('POSTO  DE   SAUDE (CNES 9100002)');
    expect(nome({ nome: 'UBS Centro', cnes: '9000011' })).toBe('UBS Centro');
    // Sem CNES (a unidade que a grade não conhece) não há o que acrescentar.
    expect(nome({ nome: 'Posto de Saúde', cnes: '' })).toBe('Posto de Saúde');
  });

  it('rotuloEspelhoPdf: a hora com os segundos no fuso da instituição; fuso desconhecido cai no de Brasília', () => {
    const anulado = { semana: '202625', status: 'ANULADA' as const, atestadoEm: '2026-06-01T15:07:05.000Z' };
    expect(regras.rotuloEspelhoPdf(anulado, 'America/Sao_Paulo', 'UBS Centro')).toBe('Espelho em PDF da SE 25/2026, UBS Centro, anulada, atestada em 01/06/2026, 12:07:05');
    expect(regras.rotuloEspelhoPdf(anulado, 'America/Manaus')).toBe('Espelho em PDF da SE 25/2026, anulada, atestada em 01/06/2026, 11:07:05');
    expect(regras.rotuloEspelhoPdf(anulado, 'Fuso/Inexistente')).toBe('Espelho em PDF da SE 25/2026, anulada, atestada em 01/06/2026, 12:07:05');
    // O vigente não leva a hora (há um só por SE e unidade).
    expect(regras.rotuloEspelhoPdf({ ...anulado, status: 'ATESTADA' }, 'America/Sao_Paulo', 'UBS Centro')).toBe('Espelho em PDF da SE 25/2026, UBS Centro');
  });

  it('nomesDaTelaDoResponsavel: a ordem no mesmo segundo vale para o mesmo atesto na semana e no histórico; no mesmo instante, pelo id', () => {
    const x1 = atesto('x1', '202626', 'u1', '9100001', 'Posto de Saúde', 'ANULADA', '2026-06-01T15:07:05.900Z');
    const x0 = atesto('x0', '202626', 'u1', '9100001', 'Posto de Saúde', 'ANULADA', '2026-06-01T15:07:05.100Z');
    const r = {
      unidades: [
        { unidade: { id: 'u1', nome: 'Posto de Saúde', cnes: '9100001' }, tipo: 'TITULAR', semanas: [semana('202626', { atesto: x1 })] },
        { unidade: { id: 'u2', nome: 'Posto de Saúde', cnes: '9100002' }, tipo: 'TITULAR', semanas: [semana('202627', {})] },
      ],
      historico: [x1, x0],
    } as unknown as RespostaMinhasNegativas;
    const nomes = regras.nomesDaTelaDoResponsavel(r, 'America/Sao_Paulo');
    const base = 'Espelho em PDF da SE 26/2026, Posto de Saúde (CNES 9100001), anulada, atestada em 01/06/2026, 12:07:05';
    expect(nomes.pdf(x1, 'semana')).toBe(`${base} (2 de 2)`);
    expect(nomes.pdf(x1, 'historico')).toBe(`${base} (2 de 2)`);
    expect(nomes.pdf(x0, 'historico')).toBe(`${base} (1 de 2)`);
    expect(nomes.atestar(r.unidades[1]!.unidade, '202627')).toBe('Atestar a SE 27/2026, Posto de Saúde (CNES 9100002)');
    // No mesmo instante (até o milissegundo), a ordem é a do id.
    const y2 = atesto('y-b', '202624', 'u1', '9100001', 'Posto de Saúde', 'ANULADA', '2026-06-01T15:07:05.000Z');
    const y1 = atesto('y-a', '202624', 'u1', '9100001', 'Posto de Saúde', 'ANULADA', '2026-06-01T15:07:05.000Z');
    const mesmos = regras.nomesDaTelaDoResponsavel({ unidades: [], historico: [y2, y1] }, 'America/Sao_Paulo');
    expect([mesmos.pdf(y2, 'historico'), mesmos.pdf(y1, 'historico')]).toEqual([
      'Espelho em PDF da SE 24/2026, Posto de Saúde, anulada, atestada em 01/06/2026, 12:07:05 (2 de 2)',
      'Espelho em PDF da SE 24/2026, Posto de Saúde, anulada, atestada em 01/06/2026, 12:07:05 (1 de 2)',
    ]);
  });
});
