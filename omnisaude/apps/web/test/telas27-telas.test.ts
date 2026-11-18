import type { DetalheSurto, ListaUnidadesNotificantes, ListaVinculados, RespostaGradeNegativa, RespostaSugestoesSurto, SituacaoContingencia } from '@omnisaude/shared';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * As telas novas e alteradas da semana 27 renderizadas no servidor (sem navegador), com as respostas da API e a
 * sessão simuladas: a lista de vinculados (K9), a legenda das semanas no canal (tel-3), a linha sob sigilo e a inclusão
 * de registro oficial na planilha (K10), os parâmetros (K3), o tipo da unidade e a unidade inativa na grade e na
 * configuração (tel-7) e a unidade do excesso nas sugestões (K6).
 */

const simulado = vi.hoisted(() => ({
  respostas: new Map<string, unknown>(),
  permissoes: [] as string[],
  papel: 'VIGILANCIA_EPIDEMIOLOGICA',
  fuso: 'America/Manaus',
}));

vi.mock('@/lib/hooks', () => ({
  useApi: (path: string | null) => {
    const chave = path ? [...simulado.respostas.keys()].find((k) => path.startsWith(k)) : undefined;
    return { data: chave ? simulado.respostas.get(chave) : null, error: null, loading: false, reload: async () => {}, setData: () => {} };
  },
}));

vi.mock('@/lib/session', () => ({
  useSession: () => ({
    me: { tenant: { timeZone: simulado.fuso }, context: { role: simulado.papel, unitId: 'u1' }, permissions: simulado.permissoes },
    can: (...p: string[]) => p.some((x) => simulado.permissoes.includes(x)),
  }),
}));

const { ListaVinculadosConciliacao } = await import('../src/components/consolidacao/conciliacao-listas');
const { ContingenciaSituacao } = await import('../src/components/consolidacao/contingencia-situacao');
const { SurtoPlanilha } = await import('../src/components/consolidacao/surto-planilha');
const { ParametrosVigilancia } = await import('../src/components/consolidacao/parametros-vigilancia');
const { NegativaGrade } = await import('../src/components/consolidacao/negativa-grade');
const { NegativaUnidades } = await import('../src/components/consolidacao/negativa-unidades');
const { SurtoSugestoes } = await import('../src/components/consolidacao/surto-sugestoes');

const html = <P extends object>(c: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(c, props));

beforeEach(() => {
  simulado.respostas.clear();
  simulado.permissoes = ['vigilancia.importar', 'vigilancia.consolidacao', 'vigilancia.catalogo', 'vigilancia.surto', 'notificacao.sensivel'];
});

const registro = {
  id: 'r1',
  sistema: 'SINAN_NET',
  tipo: 'INDIVIDUAL',
  numero: '0012345',
  notificadoEm: '2026-11-02',
  semanaNotificacao: '202645',
  agravo: 'A90',
  grupo: 'dengue',
  agravoNome: 'Dengue',
  unidade: { id: 'u1', cnes: '1234567', nome: 'UBS Centro' },
  situacao: 'CONFIRMADO',
  gravidade: null,
  evolucao: null,
  encerradoEm: null,
  paciente: { nome: 'Ana Souza', nascimento: '1990-02-01', sexo: 'F' },
  sigiloso: false,
  excluido: true,
  ausenteDesde: null,
  vinculo: { notificationId: 'n1', numero: '2026/000101', metodo: 'MANUAL', em: '2026-11-05T15:00:00.000Z' },
} as const;

const notificacao = {
  id: 'n1',
  numero: '2026/000101',
  status: 'NOTIFICADA',
  grupo: 'dengue',
  agravo: 'Dengue',
  notificadaEm: '2026-11-02T13:00:00.000Z',
  inicioSintomas: '2026-10-30',
  unidade: { id: 'u1', nome: 'UBS Centro' },
  paciente: { nome: 'Ana Souza', nascimento: '1990-02-01', sexo: 'F' },
  sigilosa: false,
  sistemaOficial: 'SINAN_NET',
  numeroOficial: '0012345',
  situacao: 'CONFIRMADO',
} as const;

describe('conciliação: lista de vinculados (K9)', () => {
  it('mostra o par sem diferença, o registro excluído no sistema oficial, o vínculo e o desvincular', () => {
    const pagina: ListaVinculados = { total: 1, pagina: 1, porPagina: 50, itens: [{ registro: { ...registro }, notificacao: { ...notificacao }, divergencias: [] }] } as unknown as ListaVinculados;
    simulado.respostas.set('/vigilancia/conciliacao/vinculados', pagina);
    const h = html(ListaVinculadosConciliacao, { filtro: { metodo: 'MANUAL' }, onMudou: () => {} });
    expect(h).toContain('Excluído no sistema oficial');
    expect(h).toContain('Sem diferença');
    expect(h).toContain('Vínculo: Manual, em 05/11/2026');
    expect(h).toContain('Desvincular…');
    expect(h).toContain('1 a 1 de 1');
  });
});

describe('contingência: últimas semanas no canal (tel-3)', () => {
  it('cada selo escreve a situação, e a legenda tem o selo colorido de cada uma', () => {
    const s = {
      territorio: { nivel: 'MUNICIPIO', id: null, nome: 'Município' },
      plano: null,
      estagioAtual: { chave: 'NORMALIDADE', nome: 'Normalidade', desde: null, acionamentoId: null },
      semanaReferencia: '202645',
      semanasIncompletas: ['202646', '202647'],
      indicadores: [
        {
          grupo: 'dengue',
          semanas: [
            { semana: '202644', status: 'ACIMA_LS', completa: true },
            { semana: '202645', status: 'ENTRE_CENTRO_E_LS', completa: false },
          ],
          provaveis: 10,
          graves: 1,
          sinaisAlarme: 2,
          obitosAgravo: 0,
          obitosInvestigacao: 0,
          incidenciaAcumulada: 12.5,
        },
      ],
      avaliacao: null,
      respostas: [],
      historico: [],
      checklist: [],
      avisos: [],
    } as unknown as SituacaoContingencia;
    const h = html(ContingenciaSituacao, { s, podeAgir: false, territorio: { nivel: 'MUNICIPIO', territorio: null }, opcoes: [{ grupo: 'dengue', nome: 'Dengue' }], onMudou: () => {} });
    expect(h).toContain('44 · acima do LS');
    expect(h).toContain('45 · centro a LS (incompleta)');
    expect(h).toContain('Legenda das semanas no canal');
    for (const t of ['abaixo do LI', 'até o centro', 'sem canal', 'Abaixo do limite inferior', 'Acima do limite superior']) expect(h).toContain(t);
  });
});

describe('surto: planilha (K10 e linha sob sigilo)', () => {
  const detalhe = (planilha: unknown[]) =>
    ({
      id: 's1',
      numero: '2026/0003',
      status: 'ABERTO',
      grupo: 'hepatite-a',
      agravo: 'Hepatite A',
      casos: 3,
      planilha,
      permissoes: { editar: true, encerrar: false, descartar: false, numeroOficial: false },
    }) as unknown as DetalheSurto;

  it('oferece incluir notificação, registro oficial e linha manual; a linha restrita vem só com o número', () => {
    const restrita = {
      id: 'c1',
      numero: 1,
      notificationId: 'n9',
      notificacaoNumero: null,
      officialRecordId: null,
      iniciais: null,
      sexo: null,
      idade: null,
      municipioResidencia: null,
      bairroId: null,
      bairroNome: null,
      inicioSintomas: null,
      hospitalizado: null,
      obito: null,
      classificacao: null,
      criterio: null,
      cidFinal: null,
      semNotificacaoIndividual: false,
      restrito: true,
    };
    const h = html(SurtoPlanilha, { d: detalhe([restrita]), onMudou: () => {} });
    expect(h).toContain('Incluir notificação');
    expect(h).toContain('Incluir registro oficial');
    expect(h).toContain('Linha manual');
    expect(h).toContain('Dados sob sigilo: só quem pode abrir a notificação vê a linha.');
    expect(h).toContain('Notificação sob sigilo');
  });

  it('a inclusão não depende mais do painel da vigilância (vigilancia.painel)', () => {
    simulado.permissoes = ['vigilancia.surto'];
    expect(html(SurtoPlanilha, { d: detalhe([]), onMudou: () => {} })).toContain('Incluir notificação');
  });
});

describe('parâmetros da semana (K3)', () => {
  it('mostra os campos com os valores gravados e o prazo em texto', () => {
    simulado.respostas.set('/vigilancia/configuracoes', {
      negativa: { prazoDiaSemana: 1, prazoHora: '14:00', contaAtrasada: true, metaPercentual: 80, semanasSilenciosa: 2, semanasSoNegativa: 12, semanasRegularidadeMunicipal: 8, semanasAtesto: 8 },
      consolidacao: { semanasIncompletas: 2, expiraPreviaHoras: 24 },
      surto: { regras: null, diasInusitado: 365 },
      whatsappEnabled: false,
    });
    const h = html(ParametrosVigilancia, {});
    expect(h).toContain('Prazo do atesto: segunda-feira às 14:00 da semana seguinte à SE atestada (fuso da instituição).');
    expect(h).toContain('id="par-diasInusitado"');
    expect(h).toContain('value="365"');
    expect(h).toContain('Gravar os parâmetros');
  });
});

describe('notificação negativa: tipo e situação da unidade (tel-7)', () => {
  it('a grade mostra o tipo pelo nome e marca a unidade inativa', () => {
    const grade = {
      colunas: [{ semana: '202645', inicio: '2026-11-01', fim: '2026-11-07', fechada: true, prazo: '2026-11-09T18:00:00.000Z' }],
      linhas: [
        {
          unidade: { id: 'u1', nome: 'Vigilância Central', cnes: '7654321' },
          tipoUnidade: 'VIGILANCIA_SAUDE',
          ativa: false,
          celulas: [{ semana: '202645', situacao: 'SEM_INFORMACAO', fontes: { notificacoes: 0, surtos: 0, registrosOficiais: 0, atesto: null, negativaSinan: false } }],
        },
      ],
      analise: { silenciosas: [], soNegativas: [], percentualPorSemana: [{ semana: 0, comInformacao: 0, notificantes: 1, percentual: 0 }], regularidadeMunicipal: { semanasSemInformacao: 1, irregular: false } },
      metaPercentual: 80,
      atestadoSemSinan: [],
      sinanSemAtesto: [],
      avisos: [],
    } as unknown as RespostaGradeNegativa;
    simulado.respostas.set('/vigilancia/negativas/grade', grade);
    const h = html(NegativaGrade, { podeConfigurar: true });
    expect(h).toContain('Vigilância em saúde');
    expect(h).not.toContain('VIGILANCIA_SAUDE');
    expect(h).toContain('Inativa no cadastro');
  });

  it('a configuração das unidades mostra o tipo pelo nome e os avisos da unidade', () => {
    const lista = [
      {
        unidade: { id: 'u2', nome: 'Farmácia Central', cnes: '1112223' },
        tipoUnidade: 'FARMACIA_CENTRAL',
        ativa: false,
        periodoAtual: { id: 'p1', desde: '2026-01-01', ate: null, motivoFim: null },
        periodos: [{ id: 'p1', desde: '2026-01-01', ate: null, motivoFim: null }],
        responsaveis: [],
        semConfiguracao: false,
        avisos: ['Unidade inativa com período de notificante aberto: encerre o período.'],
      },
    ] as unknown as ListaUnidadesNotificantes;
    simulado.respostas.set('/vigilancia/unidades-notificantes', lista);
    const h = html(NegativaUnidades, {});
    expect(h).toContain('Farmácia central');
    expect(h).not.toContain('FARMACIA_CENTRAL');
    expect(h).toContain('Unidade inativa com período de notificante aberto: encerre o período.');
  });
});

describe('sugestões de surto: unidade do excesso (K6)', () => {
  it('o valor e o limite superior saem na unidade do canal', () => {
    const r = {
      sugestoes: [],
      excessos: [
        { grupo: 'dengue', nivel: 'BAIRRO', territorioId: 'b1', territorioNome: 'Centro', semana: '202645', casos: 12, valor: 12, ls: 7.5, unidade: 'CASOS' },
        { grupo: 'chikungunya', nivel: 'LOCALIDADE', territorioId: 'l1', territorioNome: 'Sede', semana: '202645', casos: 9, valor: 35.4321, ls: 20, unidade: 'INCIDENCIA' },
      ],
      avisos: [],
    } as unknown as RespostaSugestoesSurto;
    simulado.respostas.set('/vigilancia/surtos/sugestoes', r);
    const h = html(SurtoSugestoes, { opcoes: [], onAbrir: () => {} });
    expect(h).toContain('12 casos');
    expect(h).toContain('7,5 casos');
    expect(h).toContain('35,43 por 100 mil');
    expect(h).toContain('20 por 100 mil');
  });
});
