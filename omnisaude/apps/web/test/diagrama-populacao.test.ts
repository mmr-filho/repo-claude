import { semanaEpidemiologica, type CoberturaAno, type PopulacaoUsada, type RespostaDiagrama } from '@omnisaude/shared';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Tabela "População e cobertura por ano" do diagrama: a coluna Fonte repetia o mesmo texto longo em todo ano e alargava
 * a tabela (em 1366 px). Com a mesma fonte em todos os anos, ela aparece uma vez, acima da tabela; a coluna só aparece
 * quando a fonte varia. Renderizado no servidor, com a consulta e a sessão simuladas.
 */

const simulado = vi.hoisted(() => ({ diagrama: null as unknown }));

vi.mock('@/lib/hooks', () => ({ useApi: () => ({ data: null, error: null, loading: false, reload: async () => {}, setData: () => {} }) }));
vi.mock('@/lib/session', () => ({
  useSession: () => ({
    me: { tenant: { timeZone: 'America/Sao_Paulo' }, context: { role: 'VIGILANCIA_EPIDEMIOLOGICA', unitId: 'u1' }, permissions: ['vigilancia.resumo', 'notificacao.sensivel'] },
    can: () => true,
  }),
}));
vi.mock('../src/components/consolidacao/consulta', () => ({
  useConsulta: (path: string | null) => ({ data: path ? simulado.diagrama : null, erro: null, loading: false, reload: async () => {} }),
  recusaPorSigilo: () => false,
}));

const { AbaDiagrama, fonteDaPopulacao, PopulacaoECobertura } = await import('../src/components/consolidacao/diagrama');

const html = <P extends object>(c: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(c, props));
const RIPSA = 'RIPSA/MS (estimativas para indicadores de saúde), versão 2025';
const colunaFonte = /<th[^>]*>Fonte<\/th>/;
const ocorrencias = (h: string, texto: string) => h.split(texto).length - 1;

const pop = (ano: number, fonte: PopulacaoUsada['fonte'] = 'RIPSA', versao: string | null = '2025', origem: PopulacaoUsada['origem'] = 'OFICIAL'): PopulacaoUsada => ({
  ano,
  populacao: fonte ? 100_000 + ano : null,
  fonte,
  versao,
  origem,
});
const cob = (ano: number): CoberturaAno => ({ ano, coberto: true, parcial: false, semanasCobertas: 52, motivo: 'Coberto o ano todo (OmniSaúde em uso)' });
const ANOS = [2021, 2022, 2023, 2024, 2025, 2026];

describe('fonte da população dos anos do canal', () => {
  it('a mesma em todos os anos com população: um texto só; mais de uma: varia; nenhuma: nem uma nem outra', () => {
    expect(fonteDaPopulacao(ANOS.map((a) => pop(a)))).toEqual({ unica: RIPSA, varia: false });
    // O ano sem população (sem fonte) não faz a fonte "variar".
    expect(fonteDaPopulacao([...ANOS.map((a) => pop(a)), pop(2027, null, null, 'AUSENTE')])).toEqual({ unica: RIPSA, varia: false });
    // A mesma fonte em outra versão é outra fonte.
    expect(fonteDaPopulacao([pop(2024), pop(2025, 'RIPSA', '2024')])).toEqual({ unica: null, varia: true });
    expect(fonteDaPopulacao([pop(2025, 'MANUAL', 'V1'), pop(2026, 'RIPSA')])).toEqual({ unica: null, varia: true });
    expect(fonteDaPopulacao([pop(2025, null, null, 'AUSENTE')])).toEqual({ unica: null, varia: false });
  });
});

describe('tabela "População e cobertura por ano"', () => {
  it('com a mesma fonte em todos os anos: a fonte aparece uma vez, acima da tabela, e a coluna Fonte some', () => {
    const h = html(PopulacaoECobertura, { populacao: ANOS.map((a) => pop(a)), cobertura: ANOS.map(cob), unidade: 'INCIDENCIA' });
    expect(h).toContain(`Fonte da população em todos os anos: <span class="font-medium text-slate-700">${RIPSA}</span>.`);
    expect(ocorrencias(h, RIPSA)).toBe(1);
    expect(h).not.toMatch(colunaFonte);
    // População e origem continuam por ano; o rodapé com a cobertura ocupa as 4 colunas.
    expect(h).toContain('102.026');
    expect(ocorrencias(h, 'Estimativa do ano')).toBe(ANOS.length);
    expect(h).toMatch(/colspan="4"/i);
  });

  it('com a fonte variando entre os anos: a coluna Fonte aparece, com a fonte de cada ano', () => {
    const populacao = [pop(2024, 'IBGE_DOU', null), pop(2025), pop(2026, 'RIPSA', '2025', 'REPETIDA')];
    const h = html(PopulacaoECobertura, { populacao, cobertura: populacao.map((p) => cob(p.ano)), unidade: 'INCIDENCIA' });
    expect(h).toMatch(colunaFonte);
    expect(h).not.toContain('Fonte da população em todos os anos');
    expect(ocorrencias(h, RIPSA)).toBe(2);
    expect(h).toContain('IBGE (estimativa publicada no DOU)');
    expect(h).toMatch(/colspan="5"/i);
  });

  it('em número de casos: sem população, sem fonte', () => {
    const h = html(PopulacaoECobertura, { populacao: ANOS.map((a) => pop(a)), cobertura: ANOS.map(cob), unidade: 'CASOS' });
    expect(h).not.toContain(RIPSA);
    expect(h).not.toMatch(colunaFonte);
    expect(h).toMatch(/colspan="2"/i);
  });

  it('na aba do diagrama, o card usa a tabela nova (a fonte uma vez, sem a coluna)', () => {
    // O ano do filtro inicial da aba (o ano epidemiológico de hoje).
    const ano = semanaEpidemiologica(new Date(), 'America/Sao_Paulo').ano;
    simulado.diagrama = {
      grupo: 'dengue',
      agravo: 'Dengue',
      ano,
      eixo: 'EPIDEMIOLOGICO',
      territorio: { nivel: 'MUNICIPIO', id: null, nome: 'Município' },
      pontos: [],
      canais: [
        {
          ano,
          canal: {
            anosReferencia: ANOS.slice(0, 5),
            receita: {
              metodo: 'QUARTIS',
              quartil: 'EXC',
              unidade: 'INCIDENCIA',
              k: 1.96,
              base: 'PROVAVEIS',
              anos: 5,
              janela: 'NENHUMA',
              borda: 'TRUNCADA',
              anoEmAnaliseTodosNotificados: false,
              incluiAnoEmAnalise: false,
            },
            semanas: [],
            avisos: [],
          },
          congelado: null,
          observado: [],
          referenciaIncompleta: [],
        },
      ],
      configuracao: {
        receita: { metodo: 'QUARTIS', quartil: 'EXC', unidade: 'INCIDENCIA', k: 1.96, base: 'PROVAVEIS', anos: 5, janela: 'NENHUMA', borda: 'TRUNCADA', anoEmAnaliseTodosNotificados: false, incluiAnoEmAnalise: false },
        anosExcluidos: [],
      },
      avisos: [],
      semanasIncompletas: [],
      populacao: ANOS.map((a) => pop(a)),
      cobertura: ANOS.map(cob),
      semSemanaSintomas: 0,
      bairrosSemCorrespondencia: 0,
    } as unknown as RespostaDiagrama;
    const h = html(AbaDiagrama, { podeConfigurar: false });
    expect(h).toContain('População e cobertura por ano');
    expect(h).toContain('Fonte da população em todos os anos');
    expect(ocorrencias(h, RIPSA)).toBe(1);
    expect(h).not.toMatch(colunaFonte);
  });
});

beforeEach(() => {
  simulado.diagrama = null;
});
