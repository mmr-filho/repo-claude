import { describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_SETTINGS, tenantSettings } from '../src/settings';

describe('configurações do tenant', () => {
  it('dá os padrões da semana 27 ao tenant antigo, sem as chaves novas', () => {
    const s = tenantSettings({ vigilancia: { ackMinutes: 30, onCallPhones: [], whatsappAlerts: false, relEnabled: true, prazosEncerramento: { dengue: 60 }, modeloPolicial: null } });
    expect(s.vigilancia.ackMinutes).toBe(30);
    expect(s.vigilancia.prazosEncerramento).toEqual({ dengue: 60 });
    expect(s.vigilancia.negativa).toEqual({
      prazoDiaSemana: 1,
      prazoHora: '14:00',
      contaAtrasada: true,
      metaPercentual: 80,
      semanasSilenciosa: 2,
      semanasSoNegativa: 12,
      semanasRegularidadeMunicipal: 8,
      semanasAtesto: 8,
    });
    expect(s.vigilancia.consolidacao).toEqual({ semanasIncompletas: 2, expiraPreviaHoras: 24 });
    expect(s.vigilancia.surto).toEqual({ regras: null, diasInusitado: 365 });
  });

  it('mescla o objeto aninhado gravado em parte com o padrão', () => {
    const s = tenantSettings({ vigilancia: { negativa: { prazoHora: '12:00', semanasSilenciosa: 3 }, surto: { diasInusitado: 180 } } });
    expect(s.vigilancia.negativa).toMatchObject({ prazoDiaSemana: 1, prazoHora: '12:00', semanasSilenciosa: 3, metaPercentual: 80 });
    expect(s.vigilancia.surto).toEqual({ regras: null, diasInusitado: 180 });
    expect(s.vigilancia.ackMinutes).toBe(60);
    // O padrão não é alterado pela mescla.
    expect(DEFAULT_TENANT_SETTINGS.vigilancia.negativa.prazoHora).toBe('14:00');
    expect(tenantSettings(null).vigilancia.negativa).not.toBe(DEFAULT_TENANT_SETTINGS.vigilancia.negativa);
  });
});
