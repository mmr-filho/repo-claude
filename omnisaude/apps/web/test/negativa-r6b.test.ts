import type { ListaUnidadesNotificantes, ResponsavelNegativa, RespostaMinhasNegativas, UnidadeNotificante } from '@omnisaude/shared';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Sexta rodada da semana 27 (notificação negativa), depois da verificação (r6vout), renderizada no servidor com a API e
 * a sessão simuladas, como no negativa-r6:
 * - r6vout-1: o "Revogar" diz o tipo da designação (titular ou substituto): duas pessoas de mesmo nome na mesma unidade
 *   (o nome não é único, só o usuário é) ficam distintas; dois substitutos de mesmo nome dizem também o início da
 *   designação e, no mesmo início, a ordem dela;
 * - r6vout-2: os controles que se repetem por linha dizem o objeto: o resumo "Designações anteriores (N)", a unidade; a
 *   caixa "Li a declaração…", a SE e, com mais de uma unidade na tela, a unidade. O texto visível fica inteiro no nome
 *   acessível (WCAG 2.5.3). "Hoje" fixo: quarta 15/07/2026 em Brasília.
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
const regras = await import('../src/components/consolidacao/negativa-regras');

const html = <P extends object>(c: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(c, props));
/** Os nomes acessíveis dos botões com o texto dado, na ordem da tela. */
const rotulos = (texto: string) => simulado.botoes.filter((b) => b.texto === texto).map((b) => b.rotulo ?? null);
const repetidos = (xs: (string | null)[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
/** Cada <summary> da página: o nome acessível (aria-label, null sem ele) e o texto visível. */
const sumarios = (h: string) => [...h.matchAll(/<summary([^>]*)>([^<]*)<\/summary>/g)].map((m) => ({ rotulo: /aria-label="([^"]*)"/.exec(m[1]!)?.[1] ?? null, texto: m[2]! }));
/** Cada caixa de marcar da página: o nome acessível (aria-label, null sem ele) e o texto visível do rótulo dela. */
const caixas = (h: string) => [...h.matchAll(/<label[^>]*>(<input type="checkbox"[^>]*\/>)([^<]*)<\/label>/g)].map((m) => ({ rotulo: /aria-label="([^"]*)"/.exec(m[1]!)?.[1] ?? null, texto: m[2]!.trim() }));

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

const responsavel = (id: string, userId: string, nome: string, tipo: ResponsavelNegativa['tipo'], o: Partial<ResponsavelNegativa> = {}): ResponsavelNegativa => ({
  id,
  userId,
  nome,
  tipo,
  desde: '2026-01-01',
  ate: null,
  designadoEm: '2026-01-01T13:00:00.000Z',
  designadoPor: 'Vera',
  valido: true,
  motivoInvalido: null,
  ...o,
});
const aberto = (id: string) => ({ id, desde: '2026-01-01', ate: null, motivoFim: null });
const notificante = (id: string, nome: string, cnes: string, responsaveis: ResponsavelNegativa[]): UnidadeNotificante => ({
  unidade: { id, nome, cnes },
  tipoUnidade: 'UBS',
  ativa: true,
  periodoAtual: aberto(`p${id}`),
  periodos: [aberto(`p${id}`)],
  responsaveis,
  semConfiguracao: false,
  avisos: [],
});

describe('r6vout-1: "Revogar" com pessoas de mesmo nome na mesma unidade', () => {
  it('a titular e a substituta "Maria da Silva" (usuários diferentes) na UBS Centro: cada "Revogar" diz o tipo', () => {
    const lista: ListaUnidadesNotificantes = [notificante('u1', 'UBS Centro', '9000011', [responsavel('r1', 'enf-1', 'Maria da Silva', 'TITULAR'), responsavel('r2', 'enf-2', 'Maria da Silva', 'SUBSTITUTO')])];
    simulado.respostas.set('/vigilancia/unidades-notificantes', lista);
    const h = html(NegativaUnidades, {});
    expect(rotulos('Revogar')).toEqual([
      'Revogar a designação de Maria da Silva (titular) como responsável da unidade UBS Centro',
      'Revogar a designação de Maria da Silva (substituto) como responsável da unidade UBS Centro',
    ]);
    expect(h).toContain('aria-label="Revogar a designação de Maria da Silva (titular) como responsável da unidade UBS Centro"');
  });

  it('dois substitutos de mesmo nome (maiúsculas e acentos não distinguem): dizem o início da designação e, no mesmo início, a ordem dela', () => {
    // A ordem da API: as ativas da mais recente para a mais antiga (pela hora da designação).
    const lista: ListaUnidadesNotificantes = [
      notificante('u1', 'UBS Centro', '9000011', [
        responsavel('r4', 'enf-4', 'JOSÉ SANTOS', 'SUBSTITUTO', { desde: '2026-03-01', designadoEm: '2026-03-01T13:00:00.000Z' }),
        responsavel('r3', 'enf-3', 'José Santos', 'SUBSTITUTO', { desde: '2026-02-01', designadoEm: '2026-02-01T13:00:00.000Z' }),
        responsavel('r2', 'enf-2', 'José  Santos', 'SUBSTITUTO', { desde: '2026-02-01', designadoEm: '2026-01-31T13:00:00.000Z' }),
        responsavel('r1', 'enf-1', 'Ana Souza', 'TITULAR'),
      ]),
      // A mesma pessoa em outra unidade já se distingue pela unidade: sem o início.
      notificante('u2', 'UBS Norte', '9000014', [responsavel('r5', 'enf-3', 'José Santos', 'SUBSTITUTO', { desde: '2026-02-01' })]),
    ];
    simulado.respostas.set('/vigilancia/unidades-notificantes', lista);
    html(NegativaUnidades, {});
    const revogar = rotulos('Revogar');
    expect(revogar).toEqual([
      'Revogar a designação de JOSÉ SANTOS (substituto) como responsável da unidade UBS Centro, desde 01/03/2026',
      'Revogar a designação de José Santos (substituto) como responsável da unidade UBS Centro, desde 01/02/2026 (2 de 2)',
      'Revogar a designação de José  Santos (substituto) como responsável da unidade UBS Centro, desde 01/02/2026 (1 de 2)',
      'Revogar a designação de Ana Souza (titular) como responsável da unidade UBS Centro',
      'Revogar a designação de José Santos (substituto) como responsável da unidade UBS Norte',
    ]);
    // Nenhum nome acessível repetido entre os botões da tela, nem lido igual (sem maiúsculas, acentos e espaços repetidos).
    const lido = (s: string | null) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ');
    expect(repetidos(simulado.botoes.flatMap((b) => (b.rotulo ? [lido(b.rotulo)] : [])))).toEqual([]);
  });

  it('rotulosRevogar: no mesmo início e no mesmo instante, a ordem é a do id; o tipo vem do rótulo do cadastro', () => {
    const a = responsavel('b', 'x2', 'Maria da Silva', 'SUBSTITUTO');
    const b = responsavel('a', 'x1', 'Maria da Silva', 'SUBSTITUTO');
    const revogar = regras.rotulosRevogar([a, b], 'UBS Centro');
    expect([revogar(a), revogar(b)]).toEqual([
      'Revogar a designação de Maria da Silva (substituto) como responsável da unidade UBS Centro, desde 01/01/2026 (2 de 2)',
      'Revogar a designação de Maria da Silva (substituto) como responsável da unidade UBS Centro, desde 01/01/2026 (1 de 2)',
    ]);
    expect(regras.rotuloRevogar(responsavel('t', 'x3', 'Maria da Silva', 'TITULAR'), 'UBS Centro')).toBe('Revogar a designação de Maria da Silva (titular) como responsável da unidade UBS Centro');
  });
});

describe('r6vout-2: os controles que se repetem por linha dizem o objeto', () => {
  const encerrada = (id: string) => responsavel(id, `x-${id}`, 'Ana Souza', 'TITULAR', { desde: '2025-01-01', ate: '2025-12-31', valido: null });

  it('o resumo "Designações anteriores (N)" de cada linha diz a unidade (com o CNES quando outra tem o mesmo nome); o texto visível fica igual', () => {
    simulado.respostas.set('/vigilancia/unidades-notificantes', [
      notificante('u1', 'UBS Centro', '9000011', [encerrada('r1')]),
      notificante('u2', 'Posto de Saúde', '9100001', [encerrada('r2'), encerrada('r3')]),
      notificante('u3', 'Posto de Saúde', '9100002', [encerrada('r4')]),
    ] as ListaUnidadesNotificantes);
    const s = sumarios(html(NegativaUnidades, {}));
    expect(s).toEqual([
      { rotulo: 'Designações anteriores (1) da unidade UBS Centro', texto: 'Designações anteriores (1)' },
      { rotulo: 'Designações anteriores (2) da unidade Posto de Saúde (CNES 9100001)', texto: 'Designações anteriores (2)' },
      { rotulo: 'Designações anteriores (1) da unidade Posto de Saúde (CNES 9100002)', texto: 'Designações anteriores (1)' },
    ]);
    // O texto visível está inteiro, no começo do nome acessível (WCAG 2.5.3).
    expect(s.every((x) => x.rotulo?.startsWith(x.texto))).toBe(true);
  });

  const semana = (s: string) => ({
    semana: s,
    inicio: '2026-06-21',
    fim: '2026-06-27',
    situacao: 'SEM_INFORMACAO',
    prazo: '2026-06-29T17:00:00.000Z',
    prazoPassou: true,
    podeAtestar: true,
    motivo: null,
    atesto: null,
    texto: `Eu declaro (SE ${s})`,
  });
  const doResponsavel = (id: string, nome: string, cnes: string) => ({ unidade: { id, nome, cnes }, tipo: 'TITULAR', semanas: [semana('202627'), semana('202626')] });
  const TEXTO = 'Li a declaração e confirmo que não houve caso na semana.';

  it('a caixa "Li a declaração…" de cada semana diz a SE; com uma unidade só, sem a unidade', () => {
    simulado.respostas.set('/vigilancia/negativas/minhas', { unidades: [doResponsavel('u1', 'UBS Centro', '9000011')], historico: [] } as unknown as RespostaMinhasNegativas);
    expect(caixas(html(NegativaMinhas, {}))).toEqual([
      { rotulo: 'Li a declaração e confirmo que não houve caso na semana (SE 27/2026)', texto: TEXTO },
      { rotulo: 'Li a declaração e confirmo que não houve caso na semana (SE 26/2026)', texto: TEXTO },
    ]);
  });

  it('com mais de uma unidade, a caixa diz também a unidade, como o Atestar (com o CNES quando duas têm o mesmo nome)', () => {
    simulado.respostas.set('/vigilancia/negativas/minhas', {
      unidades: [doResponsavel('u1', 'UBS Centro', '9000011'), doResponsavel('u2', 'Posto de Saúde', '9100001'), doResponsavel('u3', 'Posto de Saúde', '9100002')],
      historico: [],
    } as unknown as RespostaMinhasNegativas);
    const c = caixas(html(NegativaMinhas, {}));
    expect(c.map((x) => x.rotulo)).toEqual([
      'Li a declaração e confirmo que não houve caso na semana (SE 27/2026, UBS Centro)',
      'Li a declaração e confirmo que não houve caso na semana (SE 26/2026, UBS Centro)',
      'Li a declaração e confirmo que não houve caso na semana (SE 27/2026, Posto de Saúde (CNES 9100001))',
      'Li a declaração e confirmo que não houve caso na semana (SE 26/2026, Posto de Saúde (CNES 9100001))',
      'Li a declaração e confirmo que não houve caso na semana (SE 27/2026, Posto de Saúde (CNES 9100002))',
      'Li a declaração e confirmo que não houve caso na semana (SE 26/2026, Posto de Saúde (CNES 9100002))',
    ]);
    // O texto visível fica o mesmo, e o nome acessível o contém (sem o ponto final) antes do objeto.
    expect(c.every((x) => x.texto === TEXTO && x.rotulo?.startsWith(TEXTO.slice(0, -1)))).toBe(true);
    expect(rotulos('Atestar')[0]).toBe('Atestar a SE 27/2026, UBS Centro');
  });
});
