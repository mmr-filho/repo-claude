import { cnsFromBase, motivosEsusVisitaVetorial, TIPO_IMOVEL } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import { conferirEntradaVisita as conferirNoAparelho } from '../../../apps/web/src/components/acs/visita-regras';
import { TIPO_DADO } from '../src/codes';
import { buildVisitaDomiciliar, type VisitaDomiciliarInput } from '../src/fichas';
import { lediUuid } from '../src/ledi';
import { conferirEntradaVisita, validateFicha } from '../src/validate';

const NOW = new Date('2026-10-31T12:00:00Z');
const headerAcs = { cns: cnsFromBase('19876543210'), cbo: '515105', cnes: '9000011', ine: '0000123456', dataAtendimento: new Date('2026-10-30T03:00:00Z'), codigoIbge: '1709500' };
const cidadao = { name: 'Joana da Silva', birthDate: new Date('1981-02-03'), sex: 'F', cpf: '52998224725', cns: null };
const base = { turno: 1 as const, desfecho: 1 as const, microArea: '01' };

/** Monta a ficha com as visitas e devolve, por visita, os problemas da validação ("campo: mensagem"). */
function ficha(visitas: VisitaDomiciliarInput[], header = headerAcs) {
  const f = buildVisitaDomiciliar({ uuid: lediUuid('9000011'), header, visitas });
  const issues = validateFicha(TIPO_DADO.VISITA_DOMICILIAR, f, NOW);
  const de = (i: number) => issues.filter((x) => x.path.startsWith(`$.visitasDomiciliares[${i}]`)).map((x) => `${x.path.replace(/^\$\.visitasDomiciliares\[\d+\]\./, '')}: ${x.message}`);
  return { f, issues, de, visitas: f.visitasDomiciliares as Record<string, unknown>[] };
}

describe('ficha de visita: pessoa nos tipos 07 a 11 e 99 (LEDI 8.7.0)', () => {
  it('abrigo, ILPI e outros sem pessoa passam com cadastramento (1) ou visita periódica (29), como o PEC aceita', () => {
    const r = ficha([
      { ...base, cidadao, motivos: [29, 11], tipoImovel: '01' },
      { ...base, motivos: [29], tipoImovel: '07' },
      { ...base, motivos: [1], tipoImovel: '99' },
      { ...base, motivos: [29], tipoImovel: '08' },
      { ...base, motivos: [1, 29, 27], tipoImovel: '11' },
    ]);
    expect(r.issues).toEqual([]);
  });

  it('nesses tipos a pessoa é obrigatória com busca ativa, acompanhamento, 25, 31 ou com peso e altura', () => {
    const r = ficha([
      { ...base, motivos: [11], tipoImovel: '07' },
      { ...base, motivos: [31], tipoImovel: '99' },
      { ...base, motivos: [2], tipoImovel: '09' },
      { ...base, motivos: [25], tipoImovel: '10' },
      { ...base, motivos: [29], tipoImovel: '08', pesoKg: 70 },
      { ...base, motivos: [29], tipoImovel: '07', alturaCm: 160 },
    ]);
    for (let i = 0; i < 6; i++) expect(r.de(i).join('\n')).toMatch(/cnsCidadao: .*precisa identificar a pessoa visitada/);
  });

  it('no domicílio (01) continua a regra do produto: pessoa, salvo nos motivos que não são de uma pessoa (controle vetorial)', () => {
    const r = ficha([
      { ...base, motivos: [29], tipoImovel: '01' },
      { ...base, motivos: [1], tipoImovel: '01' },
      { ...base, motivos: [34, 35], tipoImovel: '01' },
      { ...base, motivos: [28], tipoImovel: '01' },
    ]);
    expect(r.de(0).join()).toMatch(/visita realizada a domicílio precisa identificar a pessoa/);
    expect(r.de(1).join()).toMatch(/visita realizada a domicílio precisa identificar a pessoa/);
    expect(r.de(2)).toEqual([]);
    expect(r.de(3)).toEqual([]);
  });
});

describe('ficha de visita: motivos fora do domicílio', () => {
  it('motivo não aceito fora do domicílio é apontado com a mensagem certa, e não como visita sem motivo', () => {
    const r = ficha([
      { ...base, motivos: [29], tipoImovel: '02' },
      { ...base, motivos: [4], tipoImovel: '06' },
      // CASAI com pessoa e visita periódica: a pessoa não vai (não é domicílio) e o 29 é apontado.
      { ...base, cidadao, motivos: [29], tipoImovel: '13' },
    ]);
    expect(r.visitas[0]).toMatchObject({ tipoDeImovel: 2, motivosVisita: [29] });
    expect(r.de(0)).toEqual(['motivosVisita: motivo 29 não é aceito em imóvel que não é domicílio']);
    expect(r.de(1)).toEqual(['motivosVisita: motivo 4 não é aceito em imóvel que não é domicílio']);
    expect(r.visitas[2]).toMatchObject({ tipoDeImovel: 13, motivosVisita: [29] });
    expect(r.visitas[2]!.cpfCidadao).toBeUndefined();
    expect(r.de(2)).toEqual(['motivosVisita: motivo 29 não é aceito em imóvel que não é domicílio']);
    expect(r.issues.some((i) => /informe ao menos um motivo/.test(i.message))).toBe(false);
  });

  it('com ao menos um motivo aceito, os demais saem e a visita passa (a escola com 29 e ação educativa vai com 34)', () => {
    const r = ficha([{ ...base, motivos: [29, 34], tipoImovel: '05' }]);
    expect(r.visitas[0]).toMatchObject({ motivosVisita: [34] });
    expect(r.issues).toEqual([]);
  });
});

describe('ficha de visita do ACE: nebulização (UBV) não é tratamento focal', () => {
  const headerAce = { ...headerAcs, cbo: '515140', ine: null };
  const visitaVetorial = (v: Parameters<typeof motivosEsusVisitaVetorial>[0], tipoImovel = '01'): VisitaDomiciliarInput => ({
    turno: 1,
    desfecho: 1,
    foraDaArea: true,
    tipoImovel,
    motivos: motivosEsusVisitaVetorial(v).map(Number),
  });

  it('visita de bloqueio só com UBV vai como 28 (ou 34 com ação educativa); larvicida no depósito é que é 37', () => {
    const r = ficha(
      [
        visitaVetorial({ situacao: 'TRABALHADO', ubv: 'PERI' }),
        visitaVetorial({ situacao: 'TRABALHADO', ubv: 'INTRA_PERI', acaoEducativa: true }),
        visitaVetorial({ situacao: 'TRABALHADO', ubv: 'INTRA', depositos: { A2: { inspecionados: 2, comFoco: 0, eliminados: 0, tratados: 1 } } }),
        visitaVetorial({ situacao: 'TRABALHADO', ubv: 'PERI' }, '04'),
      ],
      headerAce,
    );
    expect(r.issues).toEqual([]);
    expect(r.visitas.map((v) => v.motivosVisita)).toEqual([[28], [34], [37], [28]]);
  });
});

describe('entrada da visita do ACS (app e sincronização)', () => {
  const visita = (o: Partial<Parameters<typeof conferirEntradaVisita>[0]>) => ({ tipoImovel: '01', desfecho: '1', motivos: ['29'], pessoa: false, medicao: false, pesoOuAltura: false, ...o });

  it('recusa na entrada o que o lote acusaria, com a mensagem de cada caso', () => {
    expect(conferirEntradaVisita(visita({}))?.codigo).toBe('PESSOA_OBRIGATORIA');
    expect(conferirEntradaVisita(visita({ pessoa: true }))).toBeNull();
    expect(conferirEntradaVisita(visita({ desfecho: '3' }))).toBeNull();
    // Abrigo e outros: sem pessoa com 29 ou 1; com acompanhamento, 31 ou peso, a pessoa é obrigatória.
    expect(conferirEntradaVisita(visita({ tipoImovel: '07' }))).toBeNull();
    expect(conferirEntradaVisita(visita({ tipoImovel: '99', motivos: ['1'] }))).toBeNull();
    expect(conferirEntradaVisita(visita({ tipoImovel: '07', motivos: ['29', '11'] }))?.codigo).toBe('PESSOA_OBRIGATORIA');
    expect(conferirEntradaVisita(visita({ tipoImovel: '99', motivos: ['31'] }))?.codigo).toBe('PESSOA_OBRIGATORIA');
    expect(conferirEntradaVisita(visita({ tipoImovel: '08', medicao: true, pesoOuAltura: true }))?.codigo).toBe('PESSOA_OBRIGATORIA');
    expect(conferirEntradaVisita(visita({ tipoImovel: '08', medicao: true }))).toBeNull();
    // Fora do domicílio: só os motivos aceitos, sem pessoa e sem medição.
    expect(conferirEntradaVisita(visita({ tipoImovel: '02' }))).toMatchObject({ codigo: 'MOTIVO_FORA_DO_DOMICILIO', mensagem: expect.stringContaining('só aceita os motivos') });
    expect(conferirEntradaVisita(visita({ tipoImovel: '05', motivos: ['29', '34'] }))?.codigo).toBe('MOTIVO_FORA_DO_DOMICILIO');
    expect(conferirEntradaVisita(visita({ tipoImovel: '05', motivos: ['34', '31'] }))).toBeNull();
    expect(conferirEntradaVisita(visita({ tipoImovel: '13', motivos: ['31'], pessoa: true }))?.codigo).toBe('PESSOA_FORA_DO_DOMICILIO');
    expect(conferirEntradaVisita(visita({ tipoImovel: '12', motivos: ['27'], medicao: true }))?.codigo).toBe('MEDICAO_FORA_DO_DOMICILIO');
    expect(conferirEntradaVisita(visita({ tipoImovel: '06', motivos: ['4'], desfecho: '2' }))).toBeNull();
  });

  it('a visita aceita na entrada não é recusada pela validação da ficha', () => {
    const motivos = ['1', '29', '2', '4', '11', '25', '27', '28', '31', '34', '35', '36', '37'];
    for (const tipoImovel of Object.keys(TIPO_IMOVEL))
      for (const m of motivos)
        for (const pessoa of [false, true]) {
          if (conferirEntradaVisita(visita({ tipoImovel, motivos: [m], pessoa }))) continue;
          const r = ficha([{ ...base, tipoImovel, motivos: [Number(m)], cidadao: pessoa ? cidadao : null }]);
          expect(r.issues, `${tipoImovel} [${m}] pessoa=${pessoa}`).toEqual([]);
        }
  });

  it('o aparelho confere com as mesmas regras da API (sem divergência)', () => {
    const motivos = [['29'], ['1'], ['2'], ['11'], ['25'], ['31'], ['34'], ['28', '29'], ['35', '36', '37'], ['27']];
    for (const tipoImovel of [...Object.keys(TIPO_IMOVEL), '00'])
      for (const m of motivos)
        for (const desfecho of ['1', '2', '3'])
          for (const pessoa of [false, true])
            for (const [medicao, pesoOuAltura] of [
              [false, false],
              [true, false],
              [true, true],
            ] as const) {
              const v = { tipoImovel, desfecho, motivos: m, pessoa, medicao, pesoOuAltura };
              expect(conferirNoAparelho(v), JSON.stringify(v)).toEqual(conferirEntradaVisita(v));
            }
  });
});
