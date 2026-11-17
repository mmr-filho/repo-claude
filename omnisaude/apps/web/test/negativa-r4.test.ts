import type { AtestoNegativa, ListaUnidadesNotificantes, PeriodoNotificante, RespostaMinhasNegativas, UnidadeNotificante } from '@omnisaude/shared';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Quarta rodada da semana 27 (notificação negativa e cadastro), renderizada no servidor com a API e a sessão simuladas:
 * os botões que se repetem em cada linha dizem o objeto no nome acessível (TELAS-7 da negativa e do cadastro de
 * unidades), e o encerramento do período da unidade inativa vai até hoje e alcança o período que ainda termina depois
 * de hoje (N14). "Hoje" fixo: quarta 15/07/2026 em Brasília.
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
const { UnitsAdmin } = await import('../src/components/admin/units-admin');
const regras = await import('../src/components/consolidacao/negativa-regras');

const html = <P extends object>(c: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(c, props));
/** Os nomes acessíveis dos botões com o texto dado, na ordem da tela. */
const rotulos = (texto: string) => simulado.botoes.filter((b) => b.texto === texto).map((b) => b.rotulo ?? null);

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

const aberto = (id: string, desde = '2026-01-01'): PeriodoNotificante => ({ id, desde, ate: null, motivoFim: null });
const unidade = (id: string, nome: string, periodos: PeriodoNotificante[], ativa = true): UnidadeNotificante => ({
  unidade: { id, nome, cnes: `90000${id}` },
  tipoUnidade: 'UBS',
  ativa,
  periodoAtual: periodos.find((p) => p.ate === null) ?? periodos.find((p) => p.desde <= '2026-07-15' && (p.ate ?? '9999') >= '2026-07-15') ?? null,
  periodos,
  responsaveis: [],
  semConfiguracao: ativa && !periodos.length,
  avisos: [],
});

describe('botões repetidos por linha dizem o objeto (TELAS-7)', () => {
  it('unidades notificantes: Designar, Encerrar período e Tornar notificante com o nome da unidade', () => {
    const lista: ListaUnidadesNotificantes = [
      unidade('11', 'UBS Norte', [aberto('p1')]),
      unidade('12', 'UBS Sul', [aberto('p2')]),
      unidade('13', 'UBS Leste', []),
      unidade('14', 'UBS Oeste', [{ id: 'p4', desde: '2026-01-01', ate: '2026-03-31', motivoFim: 'Reforma do prédio' }]),
    ];
    simulado.respostas.set('/vigilancia/unidades-notificantes', lista);
    const h = html(NegativaUnidades, {});
    expect(rotulos('Designar')).toEqual(['Designar responsável da UBS Norte', 'Designar responsável da UBS Sul']);
    expect(rotulos('Encerrar período')).toEqual(['Encerrar o período da UBS Norte', 'Encerrar o período da UBS Sul']);
    expect(rotulos('Tornar notificante')).toEqual(['Tornar UBS Leste notificante', 'Tornar UBS Oeste notificante']);
    expect(h).toContain('aria-label="Designar responsável da UBS Norte"');
  });

  it('tela do responsável: Atestar com a SE; PDF com a SE e, no histórico, com a unidade', () => {
    const atesto = (id: string, semana: string, nome: string): AtestoNegativa => ({
      id,
      unitId: 'u1',
      unidade: nome,
      cnes: '9000011',
      semana,
      status: 'ATESTADA',
      atestadoEm: '2026-06-01T15:00:00.000Z',
      atestadoPor: 'Fulano',
      funcao: null,
      emNome: false,
      motivoEmNome: null,
      atrasado: false,
      declaracao: 'Declaro.',
      canceladoEm: null,
      motivoCancelamento: null,
      causa: null,
      registroOficialId: null,
    });
    const semana = (s: string, extra: object) => ({
      semana: s,
      inicio: '2026-06-07',
      fim: '2026-06-13',
      situacao: 'SEM_INFORMACAO',
      prazo: '2026-06-15T17:00:00.000Z',
      prazoPassou: true,
      podeAtestar: true,
      motivo: null,
      atesto: null,
      texto: 'Eu, Fulano, declaro...',
      ...extra,
    });
    const r = {
      unidades: [
        {
          unidade: { id: 'u1', nome: 'UBS Norte', cnes: '9000011' },
          tipo: 'TITULAR',
          semanas: [semana('202627', {}), semana('202626', {}), semana('202625', { podeAtestar: false, situacao: 'NEGATIVA', atesto: atesto('a0', '202625', 'UBS Norte') })],
        },
      ],
      historico: [atesto('a1', '202621', 'UBS Norte'), atesto('a2', '202621', 'UBS Sul'), atesto('a3', '202620', 'UBS Norte')],
    } as unknown as RespostaMinhasNegativas;
    simulado.respostas.set('/vigilancia/negativas/minhas', r);
    html(NegativaMinhas, {});
    expect(rotulos('Atestar')).toEqual(['Atestar a SE 27/2026', 'Atestar a SE 26/2026']);
    expect(rotulos('PDF')).toEqual(['Espelho em PDF da SE 25/2026', 'Espelho em PDF da SE 21/2026, UBS Norte', 'Espelho em PDF da SE 21/2026, UBS Sul', 'Espelho em PDF da SE 20/2026, UBS Norte']);
  });

  it('cadastro de unidades: Editar, Desativar e Reativar com o nome da unidade', () => {
    const u = { id: 'u1', name: 'UBS Centro', type: 'UBS', cnes: '9000011', ibgeCode: '3550308', address: null, phone: null, email: null, openingHours: null, active: true, _count: { assignments: 7 } };
    simulado.respostas.set('/admin/units', [u, { ...u, id: 'u2', name: 'UBS Jardim' }, { ...u, id: 'u3', name: 'UBS Antiga', cnes: '9000099', active: false }]);
    html(UnitsAdmin, {});
    expect(rotulos('Editar')).toEqual(['Editar UBS Centro', 'Editar UBS Jardim', 'Editar UBS Antiga']);
    expect(rotulos('Desativar')).toEqual(['Desativar UBS Centro', 'Desativar UBS Jardim']);
    expect(rotulos('Reativar')).toEqual(['Reativar UBS Antiga']);
  });
});

describe('unidade inativa: o fim do período vai até hoje (N14)', () => {
  const inativaAberta = unidade('21', 'UBS Inativa Aberta', [aberto('p21')], false);
  const inativaFimFuturo = unidade('22', 'UBS Inativa Fim Futuro', [{ id: 'p22', desde: '2026-01-01', ate: '2026-12-31', motivoFim: 'Transferência planejada' }], false);
  const ativaFimFuturo = unidade('23', 'UBS Ativa Fim Futuro', [{ id: 'p23', desde: '2026-01-01', ate: '2026-12-31', motivoFim: 'Transferência planejada' }]);

  it('as pendências recusam o fim depois de hoje na unidade inativa, como a API (422 FIM_DEPOIS_DE_HOJE)', () => {
    const recusa = 'A unidade está inativa: o fim do período não pode passar de hoje (15/07/2026). Use a data da desativação.';
    expect(regras.pendenciasEncerrarPeriodo(inativaAberta, '2026-12-31', 'Unidade desativada', '2026-07-15')).toEqual([recusa]);
    expect(regras.pendenciasEncerrarPeriodo(inativaAberta, '2026-07-15', 'Unidade desativada', '2026-07-15')).toEqual([]);
    expect(regras.pendenciasEncerrarPeriodo(inativaAberta, '2026-06-17', 'Unidade desativada', '2026-07-15')).toEqual([]);
    // O período que termina depois de hoje também se encerra na unidade inativa (a API encurta o fim).
    expect(regras.periodoParaEncerrar(inativaFimFuturo, '2026-07-15')).toMatchObject({ id: 'p22' });
    expect(regras.pendenciasEncerrarPeriodo(inativaFimFuturo, '2026-06-17', 'Unidade desativada', '2026-07-15')).toEqual([]);
    expect(regras.pendenciasEncerrarPeriodo(inativaFimFuturo, '2026-07-16', 'Unidade desativada', '2026-07-15')).toEqual([recusa]);
    // Na ativa, só o aberto (como antes): o fim futuro vale.
    expect(regras.periodoParaEncerrar(ativaFimFuturo, '2026-07-15')).toBeNull();
    expect(regras.pendenciasEncerrarPeriodo(unidade('24', 'UBS Ativa', [aberto('p24')]), '2026-12-31', 'Transferência planejada', '2026-07-15')).toEqual([]);
  });

  it('o diálogo limita a data a hoje na unidade inativa (e só nela)', () => {
    const inativa = html(EncerrarPeriodo, { u: inativaAberta, onFechar: () => {}, onFeito: () => {} });
    expect(inativa).toMatch(/<input[^>]*id="neg-encerrar-ate"[^>]*max="2026-07-15"/);
    expect(inativa).toContain('A unidade está inativa: o fim vai até hoje.');
    const ativa = html(EncerrarPeriodo, { u: unidade('24', 'UBS Ativa', [aberto('p24')]), onFechar: () => {}, onFeito: () => {} });
    expect(ativa).not.toMatch(/<input[^>]*id="neg-encerrar-ate"[^>]*max=/);
  });

  it('a linha da unidade inativa com período que termina depois de hoje tem o botão de encerrar; a ativa segue como antes', () => {
    simulado.respostas.set('/vigilancia/unidades-notificantes', [inativaFimFuturo, ativaFimFuturo]);
    html(NegativaUnidades, {});
    expect(rotulos('Encerrar período')).toEqual(['Encerrar o período da UBS Inativa Fim Futuro']);
    expect(rotulos('Tornar notificante')).toEqual(['Tornar UBS Ativa Fim Futuro notificante']);
    expect(rotulos('Designar')).toEqual([]);
  });
});
