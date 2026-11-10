import { describe, expect, it } from 'vitest';
import { analisarGrade, intervaloDaSemana, prazoDaNegativa, situacaoDaSemana, textoDoAtesto, type ParametrosGrade, type SituacaoUnidadeSemana } from '@omnisaude/shared';

/** Notificação negativa semanal (VIG-1c, §3.4 do desenho): prazo, texto do atesto, situação da semana e grade. */
const SEG_14H = { prazoDiaSemana: 1, prazoHora: '14:00' };
const CFG: ParametrosGrade = { semanasSilenciosa: 2, semanasSoNegativa: 12, semanasRegularidadeMunicipal: 8, contaAtrasada: true };

const P: SituacaoUnidadeSemana = 'POSITIVA';
const N: SituacaoUnidadeSemana = 'NEGATIVA';
const T: SituacaoUnidadeSemana = 'NEGATIVA_ATRASADA';
const S: SituacaoUnidadeSemana = 'SEM_INFORMACAO';
const G: SituacaoUnidadeSemana = 'AGUARDANDO';
const X: SituacaoUnidadeSemana = 'NAO_NOTIFICANTE';
const C: SituacaoUnidadeSemana = 'EM_CURSO';

describe('negativa: prazo e texto do atesto', () => {
  it('prazo no dia e na hora configurados da semana seguinte à SE, no fuso da instituição', () => {
    // SE 45/2026: 08/11 a 14/11/2026; prazo na segunda-feira seguinte, 16/11, às 14h.
    expect(intervaloDaSemana(2026, 45)).toEqual({ inicio: '2026-11-08', fim: '2026-11-14' });
    expect(prazoDaNegativa('202645', SEG_14H, 'America/Sao_Paulo').toISOString()).toBe('2026-11-16T17:00:00.000Z');
    expect(prazoDaNegativa('202645', SEG_14H, 'America/Manaus').toISOString()).toBe('2026-11-16T18:00:00.000Z');
    expect(prazoDaNegativa('202645', { prazoDiaSemana: 0, prazoHora: '23:59' }, 'America/Sao_Paulo').toISOString()).toBe('2026-11-16T02:59:00.000Z');
    expect(prazoDaNegativa('202645', { prazoDiaSemana: 6, prazoHora: '8:30' }, 'America/Sao_Paulo').toISOString()).toBe('2026-11-21T11:30:00.000Z');
    // SE 53/2025 (28/12/2025 a 03/01/2026): o prazo cai em 05/01/2026.
    expect(prazoDaNegativa('202553', SEG_14H, 'America/Sao_Paulo').toISOString()).toBe('2026-01-05T17:00:00.000Z');
    // Fora do horário de verão e na virada do mês.
    expect(prazoDaNegativa('202644', SEG_14H, 'America/Sao_Paulo').toISOString()).toBe('2026-11-09T17:00:00.000Z');
  });

  it('recusa semana, dia ou hora inválidos', () => {
    expect(() => prazoDaNegativa('202654', SEG_14H, 'America/Sao_Paulo')).toThrow(/inexistente/);
    expect(() => prazoDaNegativa('2026-45', SEG_14H, 'America/Sao_Paulo')).toThrow(/inválida/);
    expect(() => prazoDaNegativa('202645', { prazoDiaSemana: 7, prazoHora: '14:00' }, 'America/Sao_Paulo')).toThrow(/Dia do prazo/);
    expect(() => prazoDaNegativa('202645', { prazoDiaSemana: 1, prazoHora: '25:00' }, 'America/Sao_Paulo')).toThrow(/Hora do prazo/);
  });

  it('texto do atesto com a unidade, a SE, as datas e a citação da PRC nº 4/2017', () => {
    const base = { unidade: 'UBS Centro', cnes: '2492075', semana: '202645', inicio: '2026-11-08', fim: '2026-11-14', nome: 'Bruno Almeida', funcao: 'Enfermeiro' };
    expect(textoDoAtesto(base)).toBe(
      'Eu, Bruno Almeida, Enfermeiro, declaro, como responsável pela notificação da unidade UBS Centro (CNES 2492075), que na semana epidemiológica 45/2026 ' +
        '(08/11 a 14/11/2026) não foi identificado nenhum caso de doença, agravo ou evento de saúde pública da Lista Nacional de Notificação Compulsória ' +
        '(PRC nº 4/2017, Anexo V, art. 2º, IX).',
    );
    // Na virada do ano, o início leva o ano; sem função, só o nome.
    const virada = textoDoAtesto({ ...base, semana: '202553', inicio: '2025-12-28', fim: '2026-01-03', funcao: ' ' });
    expect(virada).toContain('Eu, Bruno Almeida, declaro');
    expect(virada).toContain('semana epidemiológica 53/2025 (28/12/2025 a 03/01/2026)');
  });
});

describe('negativa: situação da unidade na semana', () => {
  const f = { notificante: true, positivas: 0, negativa: null, emCurso: false, prazoPassou: true };
  it('cada situação, na ordem de precedência', () => {
    expect(situacaoDaSemana({ ...f, notificante: false, positivas: 3 })).toBe('NAO_NOTIFICANTE');
    expect(situacaoDaSemana({ ...f, emCurso: true, positivas: 1, prazoPassou: false })).toBe('EM_CURSO');
    expect(situacaoDaSemana({ ...f, positivas: 1, negativa: { atrasada: false } })).toBe('POSITIVA');
    expect(situacaoDaSemana({ ...f, negativa: { atrasada: false } })).toBe('NEGATIVA');
    expect(situacaoDaSemana({ ...f, negativa: { atrasada: true } })).toBe('NEGATIVA_ATRASADA');
    expect(situacaoDaSemana({ ...f, prazoPassou: false })).toBe('AGUARDANDO');
    expect(situacaoDaSemana({ ...f, prazoPassou: false, negativa: { atrasada: false } })).toBe('NEGATIVA');
    expect(situacaoDaSemana(f)).toBe('SEM_INFORMACAO');
  });
});

describe('negativa: grade unidade × semana', () => {
  it('a unidade silenciosa aparece: semanas fechadas seguidas sem informação', () => {
    const grade = [
      { unitId: 'ubs-centro', semanas: [P, N, N, P, N, G, C] },
      // UBS Jardim das Flores: sem informação nas 3 últimas semanas fechadas (a que aguarda o prazo e a em curso não contam).
      { unitId: 'ubs-jardim', semanas: [N, P, N, S, S, S, G, C] },
      { unitId: 'upa-norte', semanas: [S, S, S, P, S, G, C] },
      { unitId: 'hospital', semanas: [S, S, S, S, X, X, C] },
    ];
    const a = analisarGrade(grade, CFG);
    expect(a.silenciosas).toEqual([{ unitId: 'ubs-jardim', semanasSeguidas: 3 }]);
    // Com 1 semana basta: a UPA entra; a unidade que deixou de ser notificante não.
    expect(analisarGrade(grade, { ...CFG, semanasSilenciosa: 1 }).silenciosas.map((s) => s.unitId)).toEqual(['ubs-jardim', 'upa-norte']);
  });

  it('só negativas nas últimas semanas fechadas', () => {
    const doze = Array.from({ length: 12 }, (_, i) => (i % 3 ? N : T));
    const grade = [
      { unitId: 'so-negativa', semanas: [P, ...doze, G, C] },
      { unitId: 'com-positiva', semanas: [...doze.slice(1), P, C] },
      { unitId: 'curta', semanas: [N, N, N, C] },
    ];
    expect(analisarGrade(grade, CFG).soNegativas).toEqual([{ unitId: 'so-negativa', semanas: 12 }]);
  });

  it('percentual por semana: positivas e negativas sobre as notificantes, com a meta de contar ou não o atraso', () => {
    const grade = [
      { unitId: 'a', semanas: [P, S, C] },
      { unitId: 'b', semanas: [N, G, C] },
      { unitId: 'c', semanas: [T, N, C] },
      { unitId: 'd', semanas: [X, X, X] },
    ];
    const comAtraso = analisarGrade(grade, CFG).percentualPorSemana;
    expect(comAtraso[0]).toEqual({ semana: 0, comInformacao: 3, notificantes: 3, percentual: 100 });
    // Coluna aguardando o prazo: quem aguarda ainda conta no denominador.
    expect(comAtraso[1]).toEqual({ semana: 1, comInformacao: 1, notificantes: 3, percentual: 100 / 3 });
    // Semana em curso: sem percentual.
    expect(comAtraso[2]).toEqual({ semana: 2, comInformacao: 0, notificantes: 0, percentual: null });
    const semAtraso = analisarGrade(grade, { ...CFG, contaAtrasada: false }).percentualPorSemana;
    expect(semAtraso[0]).toMatchObject({ comInformacao: 2, notificantes: 3 });
    expect(semAtraso[0]!.percentual).toBeCloseTo(66.667, 3);
  });

  it('regularidade do município: 8 semanas fechadas seguidas sem nenhuma informação (PRC nº 6/2017, art. 454-E)', () => {
    const vazio = (n: number) => Array.from({ length: n }, () => S);
    const irregular = analisarGrade(
      [
        { unitId: 'a', semanas: [P, ...vazio(8), G, C] },
        { unitId: 'b', semanas: [N, ...vazio(8), G, C] },
      ],
      CFG,
    );
    expect(irregular.regularidadeMunicipal).toEqual({ semanasSemInformacao: 8, irregular: true });
    const regular = analisarGrade(
      [
        { unitId: 'a', semanas: [P, ...vazio(7), G, C] },
        { unitId: 'b', semanas: [N, ...vazio(7), G, C] },
      ],
      CFG,
    );
    expect(regular.regularidadeMunicipal).toEqual({ semanasSemInformacao: 7, irregular: false });
    // Uma negativa atrasada no meio também é informação para o Sinan e quebra a sequência.
    const comAtraso = analisarGrade([{ unitId: 'a', semanas: [...vazio(5), T, ...vazio(4), C] }], { ...CFG, contaAtrasada: false });
    expect(comAtraso.regularidadeMunicipal).toEqual({ semanasSemInformacao: 4, irregular: false });
    // Uma unidade com positiva na semana mais recente: regular, mesmo com as outras silenciosas.
    expect(
      analisarGrade(
        [
          { unitId: 'a', semanas: vazio(10) },
          { unitId: 'b', semanas: [...vazio(9), P] },
        ],
        CFG,
      ).regularidadeMunicipal,
    ).toEqual({ semanasSemInformacao: 0, irregular: false });
    expect(analisarGrade([], CFG)).toEqual({ silenciosas: [], soNegativas: [], percentualPorSemana: [], regularidadeMunicipal: { semanasSemInformacao: 0, irregular: false } });
  });
});
