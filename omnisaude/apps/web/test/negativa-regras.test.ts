import { analisarGrade, type CelulaGrade, type ColunaGrade, type LinhaGradeNegativa, type RespostaGradeNegativa, type SituacaoUnidadeSemana, type UnidadeNotificante } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import {
  CELULA,
  cartoesDaGrade,
  DESCRICAO_SITUACAO,
  filtrarLinhas,
  filtrarUnidades,
  LEGENDA_GRADE,
  pendenciasAbrirPeriodo,
  pendenciasDesignacao,
  pendenciasEncerrarPeriodo,
  percentuaisDaGrade,
  podeAtestarEmNome,
  resumoMinhas,
  resumoUnidades,
  rotuloColuna,
  semanasParaSeletor,
  semTitular,
  situacaoDaUnidade,
  textoCancelamento,
  textoFontes,
  tituloCelula,
} from '../src/components/consolidacao/negativa-regras';

/*
 * Regras da notificação negativa (web): a grade unidade × semana com cor e texto, o percentual por semana com a meta
 * (julgada só depois do prazo), os cartões (silenciosas, só negativas, regularidade), os filtros e a configuração das
 * unidades notificantes e dos responsáveis. A análise vem do `analisarGrade` compartilhado, como na API.
 */

const SEMANAS = ['202640', '202641', '202642', '202643', '202644', '202645'];
// Prazo de cada semana: segunda-feira seguinte, 14h (17h UTC). A 202644 vence em 2026-11-09T17:00Z.
const PRAZOS = ['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'].map((d) => `${d}T17:00:00.000Z`);
const INICIOS = ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01', '2026-11-08'];
// Segunda-feira 09/11, 9h em São Paulo: o prazo da SE 44 (14h) ainda não venceu; a SE 45 está em curso.
const AGORA = new Date('2026-11-09T12:00:00.000Z');

const colunas: ColunaGrade[] = SEMANAS.map((semana, i) => ({ semana, inicio: INICIOS[i]!, fim: INICIOS[i]!.replace(/\d{2}$/, (d) => String(Number(d) + 6).padStart(2, '0')), fechada: i < 5, prazo: PRAZOS[i]! }));

const vazio = { notificacoes: 0, surtos: 0, registrosOficiais: 0, atesto: null, negativaSinan: false };

function linha(id: string, nome: string, cnes: string, s: SituacaoUnidadeSemana[]): LinhaGradeNegativa {
  return {
    unidade: { id, nome, cnes },
    tipoUnidade: 'UBS',
    celulas: s.map(
      (situacao, i): CelulaGrade => ({
        semana: SEMANAS[i]!,
        situacao,
        fontes: situacao === 'POSITIVA' ? { ...vazio, notificacoes: 2 } : situacao.startsWith('NEGATIVA') ? { ...vazio, atesto: { id: `a-${id}-${i}`, atrasado: situacao === 'NEGATIVA_ATRASADA' } } : vazio,
      }),
    ),
  };
}

const linhas = [
  linha('u1', 'UBS Centro', '1000001', ['POSITIVA', 'NEGATIVA', 'NEGATIVA', 'POSITIVA', 'NEGATIVA', 'EM_CURSO']),
  linha('u2', 'UBS Jardim das Flores', '1000002', ['NEGATIVA', 'POSITIVA', 'SEM_INFORMACAO', 'SEM_INFORMACAO', 'SEM_INFORMACAO', 'EM_CURSO']),
  linha('u3', 'Policlínica São José', '1000003', ['NEGATIVA', 'NEGATIVA_ATRASADA', 'NEGATIVA', 'NEGATIVA', 'NEGATIVA', 'EM_CURSO']),
  linha('u4', 'UPA Norte', '1000004', ['NAO_NOTIFICANTE', 'NAO_NOTIFICANTE', 'POSITIVA', 'NEGATIVA', 'AGUARDANDO', 'EM_CURSO']),
];

const cfg = { semanasSilenciosa: 2, semanasSoNegativa: 4, semanasRegularidadeMunicipal: 8, contaAtrasada: true };

function grade(ls: LinhaGradeNegativa[] = linhas): RespostaGradeNegativa {
  return {
    colunas,
    linhas: ls,
    analise: analisarGrade(
      ls.map((l) => ({ unitId: l.unidade.id, semanas: l.celulas.map((c) => c.situacao) })),
      cfg,
    ),
    metaPercentual: 80,
    atestadoSemSinan: [],
    sinanSemAtesto: [],
    avisos: [],
  };
}

function unidade(id: string, o: Partial<UnidadeNotificante> = {}): UnidadeNotificante {
  return { unidade: { id, nome: `Unidade ${id}`, cnes: `20000${id}` }, tipoUnidade: 'UBS', ativa: true, periodoAtual: null, periodos: [], responsaveis: [], semConfiguracao: false, ...o };
}

const aberto = { id: 'p1', desde: '2026-01-01', ate: null, motivoFim: null };
const titular = { id: 'r1', userId: 'us1', nome: 'Bruno Almeida', tipo: 'TITULAR' as const, desde: '2026-01-01', ate: null, designadoEm: '2026-01-02T12:00:00.000Z', designadoPor: 'Vera' };

describe('células da grade', () => {
  it('toda situação tem texto, cor e descrição na legenda', () => {
    expect(LEGENDA_GRADE).toHaveLength(7);
    for (const s of LEGENDA_GRADE) {
      expect(CELULA[s].texto.length).toBeGreaterThan(3);
      expect(CELULA[s].classe).toMatch(/bg-/);
      expect(DESCRICAO_SITUACAO[s].length).toBeGreaterThan(10);
    }
    expect(CELULA.SEM_INFORMACAO.texto).toBe('Sem informação');
    expect(CELULA.NEGATIVA_ATRASADA.texto).toBe('Atrasada');
  });

  it('escreve o cabeçalho da coluna, as fontes e o rótulo acessível', () => {
    expect(rotuloColuna(colunas[4]!)).toEqual({ titulo: 'SE 44/2026', periodo: '01/11 a 07/11' });
    expect(textoFontes({ notificacoes: 1, surtos: 2, registrosOficiais: 1, atesto: { id: 'a', atrasado: true }, negativaSinan: true })).toBe(
      '1 notificação, 2 surtos, 1 registro oficial, atesto fora do prazo, negativa digitada no Sinan',
    );
    expect(textoFontes({ ...vazio, notificacoes: 3, registrosOficiais: 2 })).toBe('3 notificações, 2 registros oficiais');
    expect(textoFontes(vazio)).toBe('nenhuma informação');
    expect(tituloCelula({ nome: 'UBS Centro' }, linhas[0]!.celulas[1]!)).toBe('UBS Centro, SE 41/2026: Negativa. atesto no prazo.');
  });

  it('a vigilância atesta em nome só a semana terminada sem informação nem atesto', () => {
    const sem = linhas[1]!.celulas[2]!;
    expect(podeAtestarEmNome(sem, colunas[2]!)).toBe(true);
    expect(podeAtestarEmNome(linhas[3]!.celulas[4]!, colunas[4]!)).toBe(true);
    expect(podeAtestarEmNome(linhas[0]!.celulas[1]!, colunas[1]!)).toBe(false);
    expect(podeAtestarEmNome(linhas[0]!.celulas[5]!, colunas[5]!)).toBe(false);
  });
});

describe('percentual por semana e cartões', () => {
  it('calcula o % de unidades com informação e julga a meta só depois do prazo', () => {
    const p = percentuaisDaGrade(grade(), AGORA);
    expect(p.map((x) => [x.texto, x.comInformacao, x.notificantes, x.abaixoDaMeta])).toEqual([
      ['100%', 3, 3, false],
      ['100%', 3, 3, false],
      ['75%', 3, 4, true],
      ['75%', 3, 4, true],
      // SE 44: a UPA ainda está no prazo (aguardando) e entra no denominador; a meta só se julga depois do prazo.
      ['50%', 2, 4, null],
      // SE 45 em curso: ninguém no denominador.
      ['—', 0, 0, null],
    ]);
    const g = grade([linha('u9', 'UBS Nove', '1000009', ['POSITIVA', 'POSITIVA', 'NEGATIVA_ATRASADA', 'POSITIVA', 'POSITIVA', 'EM_CURSO']), ...linhas.slice(0, 2)]);
    expect(percentuaisDaGrade(g, AGORA)[2]!.texto).toBe('66,7%');
  });

  it('monta os cartões com os nomes, a regularidade e a última semana com o prazo vencido', () => {
    const c = cartoesDaGrade(grade(), AGORA);
    expect(c.silenciosas).toEqual([{ unidade: { id: 'u2', nome: 'UBS Jardim das Flores', cnes: '1000002' }, semanasSeguidas: 3 }]);
    expect(c.soNegativas).toEqual([{ unidade: { id: 'u3', nome: 'Policlínica São José', cnes: '1000003' }, semanas: 5 }]);
    expect(c.regularidade).toEqual({ semanasSemInformacao: 0, irregular: false, texto: 'Regular: o município teve informação na última semana fechada.' });
    expect(c.ultimaFechada?.semana).toBe('202643');
    const muda = cartoesDaGrade({ ...grade(), analise: { ...grade().analise, regularidadeMunicipal: { semanasSemInformacao: 8, irregular: true } } }, AGORA);
    expect(muda.regularidade.texto).toBe('Irregular: 8 semanas fechadas seguidas sem nenhuma informação no município (PRC GM/MS nº 6/2017, art. 454-E).');
    const tres = cartoesDaGrade({ ...grade(), analise: { ...grade().analise, regularidadeMunicipal: { semanasSemInformacao: 3, irregular: false } } }, AGORA);
    expect(tres.regularidade.texto).toBe('3 semana(s) fechada(s) seguida(s) sem nenhuma informação no município.');
    expect(cartoesDaGrade(grade(), new Date('2026-10-01T00:00:00.000Z')).ultimaFechada).toBeNull();
  });

  it('filtra as linhas por situação e pela busca (sem acento, nome ou CNES)', () => {
    const g = grade();
    expect(filtrarLinhas(g, 'TODAS', '').map((l) => l.unidade.id)).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(filtrarLinhas(g, 'SILENCIOSAS', '').map((l) => l.unidade.id)).toEqual(['u2']);
    expect(filtrarLinhas(g, 'SO_NEGATIVAS', '').map((l) => l.unidade.id)).toEqual(['u3']);
    expect(filtrarLinhas(g, 'SEM_INFORMACAO', '').map((l) => l.unidade.id)).toEqual(['u2']);
    expect(filtrarLinhas(g, 'TODAS', 'policlinica sao').map((l) => l.unidade.id)).toEqual(['u3']);
    expect(filtrarLinhas(g, 'TODAS', '1000004').map((l) => l.unidade.id)).toEqual(['u4']);
  });

  it('oferece as semanas do seletor da mais recente para a mais antiga', () => {
    expect(semanasParaSeletor(['202643', '202644', '202645'])).toEqual([
      { valor: '202645', rotulo: 'SE 45/2026 (em curso)' },
      { valor: '202644', rotulo: 'SE 44/2026' },
      { valor: '202643', rotulo: 'SE 43/2026' },
    ]);
  });
});

describe('unidades notificantes e responsáveis', () => {
  const lista = [
    unidade('1', { periodoAtual: aberto, periodos: [aberto], responsaveis: [titular] }),
    unidade('2', { periodoAtual: aberto, periodos: [aberto] }),
    unidade('3', { semConfiguracao: true }),
    unidade('4', { ativa: false }),
    unidade('5', {
      periodoAtual: { id: 'p5', desde: '2026-01-01', ate: '2026-12-31', motivoFim: 'Fecha no fim do ano' },
      periodos: [{ id: 'p5', desde: '2026-01-01', ate: '2026-12-31', motivoFim: 'Fecha no fim do ano' }],
    }),
  ];

  it('mostra a situação de cada unidade', () => {
    expect(lista.map((u) => situacaoDaUnidade(u))).toEqual([
      { texto: 'Notificante desde 01/01/2026', tom: 'green' },
      { texto: 'Notificante desde 01/01/2026', tom: 'green' },
      { texto: 'Sem configuração', tom: 'red' },
      { texto: 'Unidade inativa', tom: 'slate' },
      { texto: 'Notificante até 31/12/2026', tom: 'amber' },
    ]);
  });

  it('filtra e resume a configuração', () => {
    expect(filtrarUnidades(lista, 'NOTIFICANTES', '').map((u) => u.unidade.id)).toEqual(['1', '2']);
    expect(filtrarUnidades(lista, 'SEM_CONFIGURACAO', '').map((u) => u.unidade.id)).toEqual(['3']);
    expect(filtrarUnidades(lista, 'SEM_TITULAR', '').map((u) => u.unidade.id)).toEqual(['2']);
    expect(filtrarUnidades(lista, 'NAO_NOTIFICANTES', '').map((u) => u.unidade.id)).toEqual(['3', '4', '5']);
    expect(filtrarUnidades(lista, 'TODAS', 'unidade 4').map((u) => u.unidade.id)).toEqual(['4']);
    expect(semTitular(lista[0]!)).toBe(false);
    expect(semTitular(lista[2]!)).toBe(false);
    expect(resumoUnidades(lista)).toEqual({ notificantes: 2, semConfiguracao: 1, semTitular: 1, semResponsavel: 1 });
  });

  it('confere a abertura e o encerramento do período como a API', () => {
    expect(pendenciasAbrirPeriodo(lista[0]!, '2026-11-10')).toEqual(['A unidade já é notificante desde 01/01/2026: encerre o período antes de abrir outro.']);
    expect(pendenciasAbrirPeriodo(lista[3]!, '2026-11-10')).toEqual(['Unidade inativa não é notificante.']);
    expect(pendenciasAbrirPeriodo(lista[4]!, '2026-06-01')).toEqual(['O novo período não pode começar antes do fim do anterior (31/12/2026).']);
    expect(pendenciasAbrirPeriodo(lista[2]!, '')).toEqual(['Informe o início do período.']);
    expect(pendenciasAbrirPeriodo(lista[2]!, '2026-11-10')).toEqual([]);
    expect(pendenciasEncerrarPeriodo(lista[0]!, '2025-12-31', 'Fechou')).toEqual(['O fim não pode ser antes do início do período.']);
    expect(pendenciasEncerrarPeriodo(lista[0]!, '2026-11-30', 'curt')).toEqual(['Escreva o motivo (pelo menos 5 caracteres).']);
    expect(pendenciasEncerrarPeriodo(lista[2]!, '2026-11-30', 'Unidade fechada')).toEqual(['A unidade não tem período de notificante aberto.']);
    expect(pendenciasEncerrarPeriodo(lista[0]!, '2026-11-30', 'Unidade fechada')).toEqual([]);
  });

  it('confere a designação: período aberto, um titular e sem repetir o responsável', () => {
    expect(pendenciasDesignacao(lista[0]!, { userId: 'us2', tipo: 'TITULAR', desde: '2026-11-10' })).toEqual(['A unidade já tem titular (Bruno Almeida): revogue a designação antes.']);
    expect(pendenciasDesignacao(lista[0]!, { userId: 'us2', tipo: 'SUBSTITUTO', desde: '2026-11-10' })).toEqual([]);
    expect(pendenciasDesignacao(lista[0]!, { userId: 'us1', tipo: 'SUBSTITUTO', desde: '2026-11-10' })).toEqual(['Bruno Almeida já é titular desta unidade.']);
    expect(pendenciasDesignacao(lista[2]!, { userId: '', tipo: 'TITULAR', desde: '' })).toEqual([
      'A unidade não é notificante: abra o período antes de designar responsáveis.',
      'Escolha um usuário lotado na unidade.',
      'Informe o início da designação.',
    ]);
  });
});

describe('tela do responsável', () => {
  it('conta as semanas a atestar e as vencidas', () => {
    const semana = (podeAtestar: boolean, prazoPassou: boolean) => ({ semana: '202644', inicio: '', fim: '', situacao: 'AGUARDANDO' as const, prazo: '', prazoPassou, podeAtestar, motivo: null, atesto: null, texto: '' });
    const r = {
      unidades: [
        { unidade: { id: 'u1', nome: 'UBS Centro', cnes: '1' }, tipo: 'TITULAR' as const, semanas: [semana(true, false), semana(true, true), semana(false, true)] },
        { unidade: { id: 'u2', nome: 'UPA', cnes: '2' }, tipo: 'SUBSTITUTO' as const, semanas: [semana(true, true)] },
      ],
      historico: [],
    };
    expect(resumoMinhas(r)).toEqual({ aAtestar: 3, vencidas: 2, unidades: 2 });
  });

  it('explica por que o atesto deixou de valer', () => {
    expect(textoCancelamento({ status: 'ATESTADA', causa: null, motivoCancelamento: null })).toBeNull();
    expect(textoCancelamento({ status: 'CANCELADA', causa: { tipo: 'NOTIFICACAO', id: 'n' }, motivoCancelamento: null })).toBe('Cancelado: a unidade passou a ter uma notificação na semana.');
    expect(textoCancelamento({ status: 'CANCELADA', causa: { tipo: 'SURTO', id: 's' }, motivoCancelamento: null })).toBe('Cancelado: a unidade passou a ter um surto na semana.');
    expect(textoCancelamento({ status: 'CANCELADA', causa: null, motivoCancelamento: 'Registro oficial' })).toBe('Cancelado: Registro oficial');
    expect(textoCancelamento({ status: 'ANULADA', causa: null, motivoCancelamento: 'Atesto feito por engano' })).toBe('Anulado pela vigilância: Atesto feito por engano');
  });
});
