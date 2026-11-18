import { PLANO_MODELO_MS_2025, type DetalhePlano, type SituacaoContingencia } from '@omnisaude/shared';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { avisoDoAcionamento, textoVigencia } from '../src/components/consolidacao/contingencia-regras';

/*
 * Textos da contingência depois do acionamento no mesmo dia (TELAS-3 e TELAS-4) e do plano posto em vigor e
 * substituído no mesmo dia (DIAGRAMA-3): o acionamento aberto que começou hoje termina hoje, e o plano em vigor que
 * começou na data da vigência nova vigorou só naquele dia. Renderizado no servidor, com a sessão simulada e o diálogo
 * sempre aberto (o do Radix só monta no navegador).
 */

vi.mock('@/lib/hooks', () => ({ useApi: () => ({ data: null, error: null, loading: false, reload: async () => {}, setData: () => {} }) }));
vi.mock('@/lib/session', () => ({
  useSession: () => ({
    me: { tenant: { timeZone: 'America/Sao_Paulo' }, context: { role: 'VIGILANCIA_EPIDEMIOLOGICA', unitId: 'u1' }, permissions: ['vigilancia.contingencia'] },
    can: () => true,
  }),
}));
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  return {
    Dialog: (p: { title: string; description?: string; children: unknown; footer?: unknown }) =>
      h('section', { 'data-dialogo': p.title }, h('h2', null, p.title), h('p', null, p.description ?? ''), p.children as never, p.footer as never),
  };
});

const { ContingenciaSituacao } = await import('../src/components/consolidacao/contingencia-situacao');
const { ContingenciaAcionar } = await import('../src/components/consolidacao/contingencia-acionar');
const { PorEmVigor } = await import('../src/components/consolidacao/contingencia-plano');

const html = <P extends object>(c: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(c, props));

const plano = {
  id: 'p1',
  escopo: 'ARBOVIROSES',
  nome: 'Plano municipal',
  versao: 2,
  status: 'RASCUNHO',
  vigenteDesde: null,
  vigenteAte: null,
  fonte: null,
  atualizadoEm: '2026-08-17T13:00:00.000Z',
  definicao: PLANO_MODELO_MS_2025,
} as DetalhePlano;

/** Alerta acionado às 10h de 17/08 e epidemia às 22h30 do mesmo dia: o alerta começou e terminou em 17/08. */
const situacao = {
  territorio: { nivel: 'MUNICIPIO', id: null, nome: 'Município' },
  plano: { ...plano, status: 'VIGENTE', vigenteDesde: '2026-01-04' },
  estagioAtual: { chave: 'EPIDEMIA', nome: 'Situação de epidemia', desde: '2026-08-17', acionamentoId: 'a2' },
  semanaReferencia: '202631',
  semanasIncompletas: ['202632', '202633'],
  indicadores: [],
  avaliacao: null,
  respostas: [],
  historico: [
    {
      id: 'a2',
      estagio: 'EPIDEMIA',
      estagioNome: 'Situação de epidemia',
      inicio: '2026-08-17',
      semanaInicio: '202633',
      fim: null,
      semanaFim: null,
      justificativa: 'Óbitos em alta.',
      ato: null,
      decididoPor: 'Vera',
      decididoEm: '2026-08-18T01:30:00.000Z',
      indicadores: [],
    },
    {
      id: 'a1',
      estagio: 'ALERTA',
      estagioNome: 'Alerta',
      inicio: '2026-08-17',
      semanaInicio: '202633',
      fim: '2026-08-17',
      semanaFim: '202633',
      justificativa: 'Curva acima do LS.',
      ato: null,
      decididoPor: 'Vera',
      decididoEm: '2026-08-17T13:00:00.000Z',
      indicadores: [],
    },
  ],
  checklist: [],
  avisos: [],
} as unknown as SituacaoContingencia;

describe('acionamento no mesmo dia (TELAS-3)', () => {
  it('o histórico diz que o anterior fecha na véspera ou no mesmo dia, sem prometer vigências sem sobreposição', () => {
    const h = html(ContingenciaSituacao, { s: situacao, podeAgir: true, territorio: { nivel: 'MUNICIPIO', territorio: null }, opcoes: [], onMudou: () => {} });
    expect(h).toContain('Cada acionamento fecha o anterior na véspera, ou no mesmo dia se o anterior começou nesse dia.');
    expect(h).not.toContain('sem sobreposição');
    expect(h).toContain('17/08/2026 (SE 33/2026)<span class="block">até 17/08/2026 (SE 33/2026)');
  });

  it('o diálogo diz que o estágio em vigor fecha na véspera, ou hoje se começou hoje', () => {
    const d = html(ContingenciaAcionar, { s: situacao, territorio: { nivel: 'MUNICIPIO', territorio: null }, onFechar: () => {}, onAcionado: () => {} });
    expect(d).toContain('O estágio em vigor é encerrado na véspera (ou hoje, se começou hoje) e o novo começa hoje, com o checklist de ações do plano em vigor.');
  });
});

describe('aviso do acionamento (TELAS-4)', () => {
  it('concorda com o estágio: "Estágio Mobilização acionado", nunca "Mobilização acionado"', () => {
    expect(avisoDoAcionamento('Mobilização', 'Município', 40)).toBe('Estágio Mobilização acionado em Município; 40 ação(ões) no checklist.');
    expect(avisoDoAcionamento('Situação de epidemia', 'Bairro Centro', 61)).toBe('Estágio Situação de epidemia acionado em Bairro Centro; 61 ação(ões) no checklist.');
  });
});

describe('plano posto em vigor no mesmo dia do anterior (DIAGRAMA-3)', () => {
  it('o diálogo diz até quando o plano em vigor fica valendo', () => {
    const d = html(PorEmVigor, { plano, onFechar: () => {}, onFeito: () => {} });
    expect(d).toContain('O plano em vigor hoje fica arquivado até a véspera dessa data, ou até a própria data se começou nela.');
    expect(d).not.toContain('é arquivado na véspera');
  });

  it('o arquivado que vigorou um dia só aparece assim, e nunca de 01/03 a 28/02', () => {
    expect(textoVigencia({ status: 'ARQUIVADO', vigenteDesde: '2017-03-01', vigenteAte: '2017-03-01' })).toBe('Vigorou só em 01/03/2017');
    expect(textoVigencia({ status: 'ARQUIVADO', vigenteDesde: '2017-03-01', vigenteAte: '2017-03-04' })).toBe('Vigorou de 01/03/2017 a 04/03/2017');
  });
});
