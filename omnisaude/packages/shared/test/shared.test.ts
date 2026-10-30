import { describe, expect, it } from 'vitest';
import {
  ageInMonths,
  compareRisk,
  formatCns,
  formatCpf,
  fromZonedParts,
  gs1ElementString,
  gs1HumanReadable,
  GS,
  isValidCns,
  isValidCpf,
  isValidGtin,
  normalizePersonName,
  parseGs1,
  personNameKey,
  roleHasPermission,
  suggestRiskColor,
  zonedParts,
} from '@omnisaude/shared';

describe('documentos', () => {
  it('valida CPF', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224726')).toBe(false);
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(formatCpf('52998224725')).toBe('529.982.247-25');
  });

  it('valida CNS definitivo e provisório', () => {
    expect(isValidCns('123456789010000')).toBe(true);
    expect(isValidCns('123 4567 8901 0000')).toBe(true);
    expect(isValidCns('123456789010001')).toBe(false);
    // Provisório (inicia com 7, 8 ou 9): soma ponderada múltipla de 11.
    expect(isValidCns('700000000000005')).toBe(true);
    expect(isValidCns('700000000000006')).toBe(false);
    expect(formatCns('123456789010000')).toBe('123 4567 8901 0000');
  });

  it('normaliza nomes', () => {
    expect(normalizePersonName('  MARIA  DA SILVA e SOUZA ')).toBe('Maria da Silva e Souza');
    expect(personNameKey('José  Antônio')).toBe('JOSE ANTONIO');
  });
});

describe('datas', () => {
  it('converte entre fuso e UTC', () => {
    const d = new Date('2026-03-10T09:01:00Z');
    expect(zonedParts(d, 'America/Sao_Paulo')).toMatchObject({ hour: 6, minute: 1, day: 10 });
    expect(fromZonedParts({ year: 2026, month: 3, day: 10, hour: 6, minute: 1, second: 0 }, 'America/Manaus').toISOString()).toBe(
      '2026-03-10T10:01:00.000Z',
    );
  });

  it('calcula idade em meses', () => {
    expect(ageInMonths(new Date('2025-01-15'), new Date('2026-01-14'))).toBe(11);
    expect(ageInMonths(new Date('2025-01-15'), new Date('2026-01-15'))).toBe(12);
  });
});

describe('classificação de risco', () => {
  it('sugere a cor mais grave encontrada', () => {
    expect(suggestRiskColor({ spo2: 88, painScore: 3 }).color).toBe('LARANJA');
    expect(suggestRiskColor({ systolic: 120, heartRate: 80 }).color).toBe('AZUL');
    expect(suggestRiskColor({ temperature: 38 }, ['parada_cardiorrespiratoria']).color).toBe('VERMELHO');
  });

  it('ordena a fila por cor e chegada', () => {
    const t = (m: number) => new Date(2026, 0, 1, 8, m);
    const fila = [
      { id: 'a', color: 'VERDE' as const, classifiedAt: t(1) },
      { id: 'b', color: 'AMARELO' as const, classifiedAt: t(5) },
      { id: 'c', color: 'AMARELO' as const, classifiedAt: t(2) },
    ].sort(compareRisk);
    expect(fila.map((f) => f.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('GS1 Datamatrix', () => {
  const data = { gtin: '7891234567895', expiry: '2027-12-31', lot: 'L123', serial: '000001' };

  it('gera e interpreta as duas formas', () => {
    expect(isValidGtin('7891234567895')).toBe(true);
    expect(gs1HumanReadable(data)).toBe('(01)07891234567895(17)271231(10)L123(21)000001');
    expect(gs1ElementString(data)).toBe(`010789123456789517271231` + `10L123${GS}21000001`);
    expect(parseGs1(gs1ElementString(data))).toEqual({ ...data, gtin: '07891234567895' });
    expect(parseGs1(`]d2${gs1ElementString(data)}`)).toEqual({ ...data, gtin: '07891234567895' });
    expect(parseGs1(gs1HumanReadable(data))).toEqual({ ...data, gtin: '07891234567895' });
  });

  it('interpreta dia 00 como fim do mês e recusa GTIN inválido', () => {
    expect(parseGs1('(01)07891234567895(17)280200').expiry).toBe('2028-02-29');
    expect(() => parseGs1('(01)07891234567896')).toThrow(/dígito verificador/);
  });
});

describe('papéis', () => {
  it('aplica a matriz de permissões', () => {
    expect(roleHasPermission('MEDICO', 'prescricao.emitir')).toBe(true);
    expect(roleHasPermission('RECEPCAO', 'prescricao.emitir')).toBe(false);
    expect(roleHasPermission('GESTOR', 'bi.consultar')).toBe(true);
  });
});

describe('geradores de documentos', () => {
  it('gera CPF e CNS válidos', async () => {
    const { completeCpf, cnsFromBase } = await import('@omnisaude/shared');
    for (let i = 0; i < 50; i++) {
      expect(isValidCpf(completeCpf(String(100000000 + i * 7919)))).toBe(true);
      expect(isValidCns(cnsFromBase(String(10000000000 + i * 104729)))).toBe(true);
    }
  });
});
