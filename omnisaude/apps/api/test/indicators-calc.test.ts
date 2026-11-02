import { fromZonedParts, localDateString } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import {
  apurarMes,
  Calendario,
  gestacoes,
  Indice,
  maisMeses,
  pendencias,
  pontuarCrianca,
  pontuarGestacao,
  type Condicao,
  type Consulta,
  type DadosEquipe,
  type Mes,
  type Pessoa,
  type Vacina,
  type Visita,
} from '../src/modules/indicators/indicators-calc';

/**
 * Apuração sem banco, com instantes fixos: as janelas sobre datas sem hora (nascimento, DUM, desfecho) seguem o dia
 * do calendário da instituição (UTC-3), e não a meia-noite UTC. Os registros das 21h às 23h59 locais caem no dia
 * seguinte em UTC; é nesse horário que a comparação direta errava.
 */

const TZ = 'America/Sao_Paulo';
/** Instante na hora de Brasília (sem horário de verão desde 2019). */
const local = (diaHora: string) => new Date(`${diaHora}:00-03:00`);
/** Campo `@db.Date` como o Prisma devolve: meia-noite UTC. */
const data = (dia: string) => new Date(dia);

function mes(competencia: string, asOf: Date): Mes {
  const [y, m] = competencia.split('-').map(Number) as [number, number];
  const inicio = fromZonedParts({ year: y, month: m, day: 1, hour: 0, minute: 0, second: 0 }, TZ);
  const fim = fromZonedParts({ year: m === 12 ? y + 1 : y, month: m === 12 ? 1 : m + 1, day: 1, hour: 0, minute: 0, second: 0 }, TZ);
  return { competencia, inicio, fim, asOf, asOfLocal: localDateString(asOf, TZ), timeZone: TZ };
}

const pessoa = (id: string, birthDate: string, sex = 'F'): Pessoa => ({ id, name: id, birthDate: data(birthDate), sex, cadastradoEm: new Date('2020-01-01T12:00:00Z') });
const consulta = (patientId: string, at: Date): Consulta => ({ patientId, encounterId: `enc-${patientId}-${at.getTime()}`, authorId: 'medica', cbo: '225125', at, codes: [], kind: 'SOAP', programada: false });
const gestacao = (patientId: string, dum: string, resolvedAt: string | null = null): Condicao => ({
  patientId,
  system: 'CID10',
  code: 'Z34',
  lineOfCare: 'GESTANTE',
  onsetAt: data(dum),
  recordedAt: new Date(`${dum}T15:00:00Z`),
  active: resolvedAt === null,
  resolvedAt: resolvedAt ? data(resolvedAt) : null,
});

function dados(parcial: Partial<DadosEquipe>): DadosEquipe {
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
    ...parcial,
  };
}

// DUM 01/12/2025 sem desfecho: desfecho estimado em 21/09/2026 (294 dias) e puerpério até 02/11/2026 (42 dias).
const DUM = '2025-12-01';

describe('Calendário da instituição', () => {
  it('converte o dia em instantes do fuso do tenant e o instante no dia local', () => {
    const sp = new Calendario(TZ);
    expect(sp.inicioDoDia('2026-11-02').toISOString()).toBe('2026-11-02T03:00:00.000Z');
    expect(sp.fimDoDia('2026-11-02').toISOString()).toBe('2026-11-03T02:59:59.999Z');
    expect(sp.dia(new Date('2026-11-03T01:45:00Z'))).toBe('2026-11-02');
    const acre = new Calendario('America/Rio_Branco');
    expect(acre.inicioDoDia('2026-11-02').toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(acre.dia(new Date('2026-11-03T04:30:00Z'))).toBe('2026-11-02');
  });

  it('soma meses de calendário; sem o dia no mês de chegada, vale o dia 1º do mês seguinte', () => {
    expect(maisMeses('2024-11-02', 6)).toBe('2025-05-02');
    expect(maisMeses('2024-02-29', 24)).toBe('2026-03-01');
    expect(maisMeses('2025-08-31', 6)).toBe('2026-03-01');
    expect(maisMeses('2025-01-31', 1)).toBe('2025-03-01');
  });
});

describe('C3: janelas da gestação e do puerpério no dia local', () => {
  it('limites da gestação em instantes de UTC-3', () => {
    const ix = new Indice(dados({ pessoas: [pessoa('g', '1998-02-02')], condicoes: [gestacao('g', DUM)] }), TZ);
    const [g] = gestacoes(ix);
    expect(g).toMatchObject({ dum: DUM, desfecho: '2026-09-21', ultimoDiaPuerperio: '2026-11-02', desfechoRegistrado: false });
    expect(g!.inicioGestacao.toISOString()).toBe('2025-12-01T03:00:00.000Z');
    expect(g!.fimGestacao.toISOString()).toBe('2026-09-21T02:59:59.999Z');
    expect(g!.inicioPuerperio.toISOString()).toBe('2026-09-21T03:00:00.000Z');
    expect(g!.fimPuerperio.toISOString()).toBe('2026-11-03T02:59:59.999Z');
  });

  it('consulta às 22h do último dia do puerpério conta na boa prática I (apuração às 22h45)', () => {
    const d = dados({ pessoas: [pessoa('g', '1998-02-02')], condicoes: [gestacao('g', DUM)], consultas: [consulta('g', local('2026-11-02T22:00'))] });
    const corte = local('2026-11-02T22:45');
    expect(corte.toISOString()).toBe('2026-11-03T01:45:00.000Z');
    const r = apurarMes('C3', d, mes('2026-11', corte));
    expect(r).toMatchObject({ denominador: 1, valor: 9 });
    expect(r.detalhe?.I).toEqual({ obtido: 1, possivel: 1 });
    const lista = pendencias('C3', d, corte, TZ);
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ pontos: 9, observacao: 'puerpério (sem desfecho registrado)' });
  });

  it('consulta à 0h30 do dia seguinte ao fim do puerpério não conta', () => {
    const d = dados({ pessoas: [pessoa('g', '1998-02-02')], condicoes: [gestacao('g', DUM)], consultas: [consulta('g', local('2026-11-03T00:30'))] });
    const r = apurarMes('C3', d, mes('2026-11', local('2026-11-03T01:00')));
    expect(r).toMatchObject({ denominador: 1, valor: 0 });
  });

  it('a gestação começa às 0h do dia da DUM e a 1ª consulta vale até o fim do 84º dia', () => {
    const casos: [string, boolean][] = [
      ['2025-11-30T22:00', false], // véspera da DUM em hora local (já 01/12 em UTC)
      ['2026-02-23T22:00', true], // 84º dia após a DUM, à noite
      ['2026-02-24T00:30', false], // 85º dia
    ];
    for (const [quando, conta] of casos) {
      const ix = new Indice(dados({ pessoas: [pessoa('g', '1998-02-02')], condicoes: [gestacao('g', DUM)], consultas: [consulta('g', local(quando))] }), TZ);
      const pt = pontuarGestacao(ix, gestacoes(ix)[0]!, local('2026-11-02T23:00'), false);
      expect(
        pt.obtidas.some((bp) => bp.letra === 'A'),
        quando,
      ).toBe(conta);
    }
  });

  it('com desfecho registrado, o dia do desfecho já é puerpério', () => {
    const d = dados({ pessoas: [pessoa('g', '1998-02-02')], condicoes: [gestacao('g', DUM, '2026-08-10')], consultas: [consulta('g', local('2026-08-10T08:00'))] });
    const ix = new Indice(d, TZ);
    const [g] = gestacoes(ix);
    expect(g).toMatchObject({ desfecho: '2026-08-10', ultimoDiaPuerperio: '2026-09-21', desfechoRegistrado: true });
    const pt = pontuarGestacao(ix, g!, local('2026-09-21T23:30'), false);
    expect(pt.obtidas.map((bp) => bp.letra)).toEqual(['I']);
  });
});

describe('C2: janelas da criança no dia local', () => {
  // Nascida em 02/11/2024: 30 dias em 02/12/2024, 6 meses em 02/05/2025, 12 meses em 02/11/2025, 2 anos em 02/11/2026.
  const crianca = pessoa('c', '2024-11-02');
  const vacinas = (patientId: string, extra: Vacina[] = []): Vacina[] => [
    ...['2025-01-02', '2025-03-03', '2025-05-02'].flatMap((dia) => [
      { patientId, componentes: ['DTP', 'HEPB', 'HIB'] as Vacina['componentes'], at: local(`${dia}T09:00`) },
      { patientId, componentes: ['VIP'] as Vacina['componentes'], at: local(`${dia}T09:00`) },
    ]),
    { patientId, componentes: ['PNEUMO'], at: local('2025-01-02T09:00') },
    { patientId, componentes: ['PNEUMO'], at: local('2025-03-03T09:00') },
    { patientId, componentes: ['SCR'], at: local('2026-02-10T09:00') },
    ...extra,
  ];

  it('consulta e visita às 22h do 30º dia e visita às 22h do dia dos 6 meses contam', () => {
    const visitas: Visita[] = [
      { patientId: 'c', at: local('2024-12-02T22:00') },
      { patientId: 'c', at: local('2025-05-02T22:00') },
    ];
    const ix = new Indice(dados({ pessoas: [crianca], consultas: [consulta('c', local('2024-12-02T22:00'))], visitas }), TZ);
    const pt = pontuarCrianca(ix, crianca, local('2026-11-02T22:45'), false);
    expect(pt.obtidas.map((bp) => bp.letra)).toEqual(['A', 'D']);
  });

  it('a 1ª dose de SCR conta a partir das 0h do dia em que completa 12 meses', () => {
    const corte = local('2026-11-02T22:45');
    const naVespera = new Indice(dados({ pessoas: [crianca], vacinas: vacinas('c', [{ patientId: 'c', componentes: ['SCR'], at: local('2025-11-01T22:00') }]) }), TZ);
    expect(pontuarCrianca(naVespera, crianca, corte, false).obtidas.some((bp) => bp.letra === 'E')).toBe(false);
    const noDia = new Indice(dados({ pessoas: [crianca], vacinas: vacinas('c', [{ patientId: 'c', componentes: ['SCR'], at: local('2025-11-02T01:00') }]) }), TZ);
    expect(pontuarCrianca(noDia, crianca, corte, false).obtidas.some((bp) => bp.letra === 'E')).toBe(true);
  });

  it('a criança que completa dois anos hoje entra na coorte do mês às 22h45', () => {
    const comSegundaScr = vacinas('c', [{ patientId: 'c', componentes: ['SCR'], at: local('2025-11-10T09:00') }]);
    const r = apurarMes('C2', dados({ pessoas: [crianca], vacinas: comSegundaScr }), mes('2026-11', local('2026-11-02T22:45')));
    expect(r).toMatchObject({ denominador: 1, valor: 20 });
  });
});

describe('Datas sem hora fora das janelas de C2 e C3', () => {
  const hipertensao = (resolvedAt: string): Condicao => ({
    patientId: 'h',
    system: 'CIAP2',
    code: 'K86',
    lineOfCare: 'HIPERTENSAO',
    onsetAt: null,
    recordedAt: new Date('2026-01-10T12:00:00Z'),
    active: false,
    resolvedAt: data(resolvedAt),
  });

  it('condição encerrada sai do denominador a partir do dia local do desfecho', () => {
    const d = dados({ pessoas: [pessoa('h', '1970-05-05', 'M')], condicoes: [hipertensao('2026-11-03')] });
    expect(apurarMes('C5', d, mes('2026-11', local('2026-11-02T22:45'))).denominador).toBe(1);
    expect(apurarMes('C5', d, mes('2026-11', local('2026-11-03T00:30'))).denominador).toBe(0);
  });

  it('a idade muda no dia local do aniversário (C6)', () => {
    const d = dados({ pessoas: [pessoa('i', '1966-11-03')] });
    expect(apurarMes('C6', d, mes('2026-11', local('2026-11-02T22:45'))).denominador).toBe(0);
    expect(apurarMes('C6', d, mes('2026-11', local('2026-11-03T00:30'))).denominador).toBe(1);
  });
});
