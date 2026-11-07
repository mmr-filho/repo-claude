import { describe, expect, it } from 'vitest';
import { ehCboAce, ehCboAcs } from '../src/acs';
import { roleFromCbo } from '../src/cnes';
import { casosAgrupam, cicloBimestral, conferirVisitaVetorial, indicesLarvarios, motivosEsusVisitaVetorial, ordenarOperacoesAce, progresso, totaisDepositos, type VisitaVetorialCampo } from '../src/endemias';
import { ROLE_PERMISSIONS } from '../src/roles';
import { metrosPorGrau, type Posicao } from '../src/territorio/geo';

const O: Posicao = [-49.05, -11.71];
const m = metrosPorGrau(O[1]);
const em = (lesteM: number) => ({ lat: O[1], lng: O[0] + lesteM / m.lng });

describe('endemias: regras da visita do ACE', () => {
  const base: VisitaVetorialCampo = { atividade: 'LI_T', situacao: 'TRABALHADO' };

  it('confere depósitos, amostras e tratamento antes de ir para a fila', () => {
    expect(
      conferirVisitaVetorial({
        ...base,
        depositos: { A2: { inspecionados: 2, comFoco: 1, eliminados: 0, tratados: 1 } },
        amostras: [{ numero: 1, deposito: 'A2' }],
        tratamentos: [{ produtoId: 'x', loteId: 'l', quantidade: 0.8, depositos: 1 }],
      }),
    ).toEqual([]);
    expect(conferirVisitaVetorial({ ...base, depositos: { A1: { inspecionados: 1, comFoco: 2, eliminados: 0, tratados: 0 } } })).toEqual(['Depósito A1: mais depósitos com foco do que inspecionados']);
    expect(conferirVisitaVetorial({ ...base, depositos: { C: { inspecionados: 2, comFoco: 0, eliminados: 2, tratados: 1 } }, tratamentos: [{ produtoId: 'x', loteId: 'l', quantidade: 1, depositos: 1 }] })).toContain(
      'Depósito C: eliminados mais tratados passam dos inspecionados',
    );
    // Vaso (B) e bromélia (E) não recebem larvicida; lixo (D2) só em ponto estratégico.
    const b = conferirVisitaVetorial({ ...base, depositos: { B: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 1 } }, tratamentos: [{ produtoId: 'x', loteId: 'l', quantidade: 1, depositos: 1 }] });
    expect(b.join()).toMatch(/Depósito B não recebe larvicida/);
    const d2 = { ...base, depositos: { D2: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 1 } }, tratamentos: [{ produtoId: 'x', loteId: 'l', quantidade: 1, depositos: 1 }] };
    expect(conferirVisitaVetorial(d2).join()).toMatch(/só recebe larvicida em ponto estratégico/);
    expect(conferirVisitaVetorial(d2, { pontoEstrategico: true })).toEqual([]);
    // Um tubito por depósito com foco; números de 1 a 999 sem repetir.
    expect(
      conferirVisitaVetorial({
        ...base,
        depositos: { C: { inspecionados: 1, comFoco: 1, eliminados: 0, tratados: 0 } },
        amostras: [
          { numero: 1, deposito: 'C' },
          { numero: 2, deposito: 'C' },
        ],
      }).join(),
    ).toMatch(/um tubito por depósito com foco/);
    expect(
      conferirVisitaVetorial({
        ...base,
        depositos: { C: { inspecionados: 2, comFoco: 2, eliminados: 0, tratados: 0 } },
        amostras: [
          { numero: 3, deposito: 'C' },
          { numero: 3, deposito: 'C' },
        ],
      }),
    ).toContain('Tubito 3 repetido na visita');
    // Tratados na tabela e nos produtos precisam bater; o lote é obrigatório.
    expect(conferirVisitaVetorial({ ...base, depositos: { A1: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 1 } } }).join()).toMatch(/informe produto, lote e quantidade/);
    expect(
      conferirVisitaVetorial({ ...base, depositos: { A1: { inspecionados: 3, comFoco: 0, eliminados: 0, tratados: 2 } }, tratamentos: [{ produtoId: 'x', loteNumero: 'B1', quantidade: 1, depositos: 1 }] }).join(),
    ).toMatch(/somam 1 depósito/);
    expect(conferirVisitaVetorial({ ...base, depositos: { A1: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 1 } }, tratamentos: [{ produtoId: 'x', quantidade: 1, depositos: 1 }] })).toContain(
      'Informe o lote do larvicida usado',
    );
    // Pendência (fechado, recusado, abandonado) não tem depósito nem tratamento.
    expect(conferirVisitaVetorial({ atividade: 'BLOQUEIO', situacao: 'FECHADO', ubv: 'PERI' }).join()).toMatch(/registre só a pendência/);
    expect(conferirVisitaVetorial({ atividade: 'BLOQUEIO', situacao: 'RECUSADO' })).toEqual([]);
  });

  it('motivos da ficha do e-SUS: 34 a 37 conforme o trabalho feito; recusada ou ausente sem motivo; nenhum vira 28', () => {
    expect(motivosEsusVisitaVetorial({ situacao: 'TRABALHADO', acaoEducativa: true, depositos: { C: { inspecionados: 2, comFoco: 1, eliminados: 1, tratados: 1 } } })).toEqual(['34', '35', '36', '37']);
    expect(motivosEsusVisitaVetorial({ situacao: 'TRABALHADO', ubv: 'INTRA' })).toEqual(['37']);
    expect(motivosEsusVisitaVetorial({ situacao: 'TRABALHADO', depositos: { A1: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 0 } } })).toEqual(['28']);
    expect(motivosEsusVisitaVetorial({ situacao: 'FECHADO', acaoEducativa: true })).toEqual([]);
    expect(totaisDepositos({ A1: { inspecionados: 1, comFoco: 1, eliminados: 0, tratados: 1 }, E: { inspecionados: 2, comFoco: 0, eliminados: 2, tratados: 0 } })).toEqual({
      inspecionados: 3,
      comFoco: 1,
      eliminados: 2,
      tratados: 1,
    });
  });

  it('ciclo bimestral no ano civil e ordem das operações (imóvel antes da visita)', () => {
    expect(cicloBimestral('2026-01-15')).toEqual({ ano: 2026, ciclo: 1, chave: '2026-1', inicio: '2026-01-01', fim: '2026-02-28' });
    expect(cicloBimestral('2028-02-29').fim).toBe('2028-02-29');
    expect(cicloBimestral('2026-11-06')).toMatchObject({ ciclo: 6, inicio: '2026-11-01', fim: '2026-12-31' });
    const ops = ordenarOperacoesAce([
      { tipo: 'VISITA_VETORIAL' as const, registradoEm: '2026-11-06T10:00:00Z' },
      { tipo: 'IMOVEL' as const, registradoEm: '2026-11-06T11:00:00Z' },
      { tipo: 'VISITA_VETORIAL' as const, registradoEm: '2026-11-06T09:00:00Z' },
    ]);
    expect(ops.map((o) => `${o.tipo}@${o.registradoEm.slice(11, 13)}`)).toEqual(['IMOVEL@11', 'VISITA_VETORIAL@09', 'VISITA_VETORIAL@10']);
  });

  it('índices larvários: cada imóvel conta uma vez, pela última visita trabalhada', () => {
    const i = indicesLarvarios([
      { imovelId: 'a', situacao: 'FECHADO' },
      { imovelId: 'a', situacao: 'TRABALHADO', depositos: { A2: { inspecionados: 2, comFoco: 1, eliminados: 0, tratados: 1 }, B: { inspecionados: 3, comFoco: 1, eliminados: 1, tratados: 0 } } },
      { imovelId: 'b', situacao: 'TRABALHADO', depositos: { C: { inspecionados: 1, comFoco: 0, eliminados: 0, tratados: 0 } } },
      { imovelId: 'c', situacao: 'TRABALHADO', depositos: { D1: { inspecionados: 4, comFoco: 2, eliminados: 4, tratados: 0 } } },
      { imovelId: 'd', situacao: 'RECUSADO' },
    ]);
    expect(i).toMatchObject({ imoveisInspecionados: 3, imoveisComFoco: 2, depositosInspecionados: 10, depositosComFoco: 4, iip: 66.7, ib: 133.3, ir: 40, classe: 'RISCO' });
    expect(i.itr).toMatchObject({ A2: 25, B: 25, D1: 50, C: 0 });
    expect(indicesLarvarios([]).iip).toBeNull();
    expect(
      indicesLarvarios(Array.from({ length: 200 }, (_, k) => ({ imovelId: String(k), situacao: 'TRABALHADO' as const, depositos: k < 1 ? { A1: { inspecionados: 1, comFoco: 1, eliminados: 0, tratados: 0 } } : {} })))
        .classe,
    ).toBe('SATISFATORIO');
  });

  it('agrupamento do bloqueio: até 2× o raio e 7 dias; o mesmo imóvel ou pessoa agrupa sem posição, dentro da janela', () => {
    const a = { ...em(0), dataReferencia: '2026-11-06', householdId: 'h1', patientId: 'p1' };
    expect(casosAgrupam(a, { ...em(299), dataReferencia: '2026-11-01' }, 150, 7)).toBe(true);
    expect(casosAgrupam(a, { ...em(301), dataReferencia: '2026-11-06' }, 150, 7)).toBe(false);
    expect(casosAgrupam(a, { ...em(10), dataReferencia: '2026-10-30' }, 150, 7)).toBe(true);
    expect(casosAgrupam(a, { ...em(10), dataReferencia: '2026-10-29' }, 150, 7)).toBe(false);
    expect(casosAgrupam(a, { lat: null, lng: null, dataReferencia: '2026-11-02', householdId: 'h1' }, 150, 7)).toBe(true);
    // O mesmo imóvel (ou a mesma pessoa) semanas depois é outra transmissão: não entra na ordem antiga.
    expect(casosAgrupam(a, { lat: null, lng: null, dataReferencia: '2026-10-12', householdId: 'h1' }, 150, 7)).toBe(false);
    expect(casosAgrupam(a, { ...em(5000), dataReferencia: '2026-10-15', patientId: 'p1' }, 150, 7)).toBe(false);
    expect(casosAgrupam(a, { lat: null, lng: null, dataReferencia: '2026-11-06', patientId: 'p1' }, 150, 7)).toBe(true);
    expect(casosAgrupam(a, { lat: null, lng: null, dataReferencia: '2026-11-06' }, 150, 7)).toBe(false);
    expect(progresso(20, 15, 3)).toEqual({ imoveis: 20, trabalhados: 15, pendentes: 3, semVisita: 2, cobertura: 75, pendencia: 15 });
  });

  it('CBO 515140 é ACE (não ACS) e o ACE não lê prontuário', () => {
    expect(roleFromCbo('515140')).toBe('ACE');
    expect(roleFromCbo('5151F1')).toBe('ACE');
    expect(roleFromCbo('515105')).toBe('ACS');
    expect(ehCboAce('515140')).toBe(true);
    expect(ehCboAcs('515140')).toBe(false);
    expect(ehCboAcs('515105')).toBe(true);
    expect(ROLE_PERMISSIONS.ACE).not.toContain('paciente.ler');
    expect(ROLE_PERMISSIONS.ACE).toContain('endemias.campo');
    expect(ROLE_PERMISSIONS.VIGILANCIA_EPIDEMIOLOGICA).toContain('endemias.ler');
    expect(ROLE_PERMISSIONS.COORDENADOR_ENDEMIAS).not.toContain('vigilancia.mapa');
  });
});
