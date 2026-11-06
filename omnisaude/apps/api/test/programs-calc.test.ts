import { describe, expect, it } from 'vitest';
import type { Condicao, Consulta, Medicao, Pessoa } from '../src/modules/indicators/indicators-calc';
import { listarPrograma, type DadosPrograma, type Estratificacao, type LinhaPrograma } from '../src/modules/programs/programs-calc';

/**
 * Listas dos programas sem banco, com horários fixos: idades, marcos e datas exibidas seguem o dia do calendário da
 * instituição (UTC-3). Das 21h à meia-noite locais o instante já é o dia seguinte em UTC; é aí que as contas erravam.
 */

const TZ = 'America/Sao_Paulo';
/** Instante na hora de Brasília (sem horário de verão desde 2019). */
const local = (diaHora: string) => new Date(`${diaHora}:00-03:00`);
/** Campo `@db.Date` como o Prisma devolve: meia-noite UTC. */
const data = (dia: string) => new Date(dia);

const pessoa = (id: string, birthDate: string, extra: Partial<Pessoa> = {}): Pessoa => ({ id, name: id, birthDate: data(birthDate), sex: 'F', cadastradoEm: new Date('2020-01-01T12:00:00Z'), ...extra });
const consulta = (patientId: string, at: Date): Consulta => ({ patientId, encounterId: `enc-${patientId}-${at.getTime()}`, authorId: 'medica', cbo: '225125', at, codes: [], kind: 'SOAP', programada: false });
const medida = (patientId: string, at: Date): Medicao => ({ patientId, at, pa: true, pesoAltura: true, peso: 70, altura: 170 });
const condicao = (patientId: string, code: string, lineOfCare: string, onsetAt: string | null = null): Condicao => ({
  patientId,
  system: 'CID10',
  code,
  lineOfCare,
  onsetAt: onsetAt ? data(onsetAt) : null,
  recordedAt: new Date('2026-01-10T12:00:00Z'),
  active: true,
  resolvedAt: null,
});

function dados(parcial: Partial<DadosPrograma>): DadosPrograma {
  return {
    team: { id: 'equipe', typeCode: '70', name: 'ESF Teste' },
    membros: new Set(['medica']),
    pessoas: [],
    consultas: [],
    medicoes: [],
    exames: [],
    vacinas: [],
    procedimentos: [],
    condicoes: [],
    visitas: [],
    coautores: new Map(),
    referencia: { total: 0, criancas6a12: 0 },
    estratificacoes: [],
    ...parcial,
  };
}

const linhaDe = (d: DadosPrograma, programa: Parameters<typeof listarPrograma>[0], asOf: Date, id: string): LinhaPrograma | undefined => listarPrograma(programa, d, asOf, TZ).pessoas.find((p) => p.patientId === id);
const codigos = (l: LinhaPrograma | undefined) => l?.faltas.map((f) => f.codigo) ?? [];

// Quinta-feira, 05/11/2026, 22h30 em Brasília = 06/11/2026, 1h30 em UTC.
const NOITE = local('2026-11-05T22:30');

describe('Puericultura no dia local', () => {
  it('a criança só completa 6 meses no dia do mesversário, não às 21h da véspera', () => {
    const d = dados({ pessoas: [pessoa('c', '2026-05-06')] });
    expect(NOITE.toISOString()).toBe('2026-11-06T01:30:00.000Z');
    const vespera = linhaDe(d, 'PUERICULTURA', NOITE, 'c');
    expect(vespera?.situacao).toMatch(/^5 meses/);
    expect(vespera?.proximaAcao).toBe('Consulta dos 6 meses em 06/11/2026');
    const noDia = linhaDe(d, 'PUERICULTURA', local('2026-11-06T08:00'), 'c');
    expect(noDia?.situacao).toMatch(/^6 meses/);
    expect(noDia?.proximaAcao).toBe('Consulta dos 9 meses em 06/02/2027');
  });

  it('a 1ª dose de SCR fica em atraso a partir das 0h do dia dos 12 meses + 30 dias', () => {
    // Nascida em 07/10/2025: 12 meses em 07/10/2026, atraso a partir de 06/11/2026.
    const d = dados({ pessoas: [pessoa('c', '2025-10-07')] });
    expect(codigos(linhaDe(d, 'PUERICULTURA', local('2026-11-05T23:59'), 'c'))).not.toContain('VACINA_SCR_1');
    expect(codigos(linhaDe(d, 'PUERICULTURA', local('2026-11-06T00:01'), 'c'))).toContain('VACINA_SCR_1');
  });
});

describe('Datas exibidas no dia local', () => {
  it('pré-natal: consulta das 22h aparece com a data local e o próximo prazo conta dela', () => {
    // DUM 01/08/2026: 13 semanas em 05/11/2026, intervalo de 30 dias entre consultas.
    const d = dados({ pessoas: [pessoa('g', '1998-02-02')], condicoes: [condicao('g', 'Z34', 'GESTANTE', '2026-08-01')], consultas: [consulta('g', local('2026-09-20T22:00'))] });
    const l = linhaDe(d, 'PRE_NATAL', NOITE, 'g');
    expect(l?.situacao).toMatch(/^13 semanas · DPP 08\/05\/2027/);
    expect(l?.faltas.find((f) => f.codigo === 'CONSULTA')?.descricao).toBe('Consulta em atraso: última em 20/09/2026, intervalo de 30 dias');
    expect(l?.proximaAcao).toBe('Próxima consulta até 20/10/2026');
  });

  it('diabetes: a reavaliação do pé vence no dia previsto, e a última consulta aparece no dia local', () => {
    const pe: Estratificacao = { patientId: 'dm', kind: 'PE_DIABETICO', result: '1', score: 1, assessedAt: new Date('2026-08-08T13:00:00Z'), nextDueAt: data('2026-11-06') };
    const d = dados({ pessoas: [pessoa('dm', '1970-03-10')], condicoes: [condicao('dm', 'E11', 'DIABETES')], consultas: [consulta('dm', local('2026-11-05T22:00'))], estratificacoes: [pe] });
    const vespera = linhaDe(d, 'HAS_DM', NOITE, 'dm');
    expect(codigos(vespera)).not.toContain('PE_RISCO');
    expect(vespera?.situacao).toContain('última consulta 05/11/2026');
    expect(vespera?.proximaAcao).toBe('Consulta até 05/05/2027');
    expect(vespera?.estratificacao?.nextDueAt).toBe('2026-11-06');
    const noDia = linhaDe(d, 'HAS_DM', local('2026-11-06T08:00'), 'dm');
    expect(noDia?.faltas.find((f) => f.codigo === 'PE_RISCO')?.descricao).toBe('Reavaliar o pé (grau 1, prevista para 06/11/2026)');
  });

  it('SISVAN: a última medida das 22h aparece com a data local', () => {
    const d = dados({ pessoas: [pessoa('a', '1990-04-04')], medicoes: [medida('a', local('2026-11-05T22:00'))] });
    const l = linhaDe(d, 'SISVAN', NOITE, 'a');
    expect(l?.situacao).toContain('última medida 05/11/2026');
    expect(l?.proximaAcao).toBe('Antropometria até 05/11/2027');
  });
});

describe('Bolsa Família e tuberculose no dia local', () => {
  it('às 22h30 de 30/06 ainda é a 1ª vigência, e a medida das 22h conta nela', () => {
    const d = dados({ pessoas: [pessoa('bf', '1996-07-07', { bolsaFamilia: true })], medicoes: [medida('bf', local('2026-06-30T22:00'))] });
    const l = linhaDe(d, 'BOLSA_FAMILIA', local('2026-06-30T22:30'), 'bf');
    expect(l?.situacao).toBe('Mulher 14 a 44 anos · 1ª vigência de 2026');
    expect(l?.faltas).toEqual([]);
    expect(l?.proximaAcao).toBe('Próxima vigência a partir de 01/07/2026');
  });

  it('tuberculose: previsão de alta em meses de calendário e alerta só depois dos 30 dias de tolerância, no dia local', () => {
    const d = dados({ pessoas: [pessoa('tb', '1980-01-01', { sex: 'M' })], condicoes: [condicao('tb', 'A15', 'TUBERCULOSE', '2026-05-06')], consultas: [consulta('tb', local('2026-11-05T22:00'))] });
    const l = linhaDe(d, 'TB_HANSENIASE', NOITE, 'tb');
    expect(l?.situacao).toBe('Tuberculose desde 06/05/2026 · previsão de alta 06/11/2026');
    expect(l?.proximaAcao).toBe('Consulta até 05/12/2026');
    expect(codigos(linhaDe(d, 'TB_HANSENIASE', local('2026-12-06T23:00'), 'tb'))).not.toContain('ALTA');
    expect(codigos(linhaDe(d, 'TB_HANSENIASE', local('2026-12-07T00:30'), 'tb'))).toContain('ALTA');
  });
});
