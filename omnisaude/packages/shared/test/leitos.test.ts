import { describe, expect, it } from 'vitest';
import { dvAih, horasEmFila, news2, numeroAih, numeroProtocoloLeito, ordenarFilaLeitos, prazoMetaLeito, prioridadeLeitoSugerida, validarNumeroAih } from '../src/leitos';

describe('NEWS2', () => {
  it('pontua um paciente estável como risco baixo', () => {
    const n = news2({ fr: 16, sato2: 97, pas: 125, fc: 78, temp: 36.8, consciencia: 'ALERTA', oxigenio: false });
    expect(n.pontos).toBe(0);
    expect(n.risco).toBe('BAIXO');
    expect(n.faltando).toEqual([]);
  });
  it('soma os parâmetros e eleva o risco com um único parâmetro extremo', () => {
    const n = news2({ fr: 26, sato2: 90, pas: 88, fc: 125, temp: 38.5, consciencia: 'CONFUSO', oxigenio: true });
    expect(n.componentes).toEqual({ fr: 3, sato2: 3, oxigenio: 2, pas: 3, fc: 2, consciencia: 3, temp: 1 });
    expect(n.pontos).toBe(17);
    expect(n.risco).toBe('ALTO');
    expect(news2({ fr: 16, sato2: 97, pas: 125, fc: 78, temp: 36.8, consciencia: 'VOZ' }).risco).toBe('BAIXO_MEDIO');
    expect(news2({ fr: 22, sato2: 93, pas: 105, fc: 95, temp: 36.8, consciencia: 'ALERTA' }).risco).toBe('MEDIO');
  });
  it('aponta os parâmetros que faltam', () => {
    const n = news2({ fr: 18 });
    expect(n.faltando).toEqual(['saturação', 'pressão arterial', 'frequência cardíaca', 'nível de consciência', 'temperatura']);
  });
});

describe('Prioridade e fila de leitos', () => {
  it('sugere a prioridade pelo suporte, pelo tipo de leito e pelo NEWS2', () => {
    const estavel = news2({ fr: 16, sato2: 97, pas: 125, fc: 78, temp: 36.8, consciencia: 'ALERTA' });
    expect(prioridadeLeitoSugerida(estavel, { drogaVasoativa: true }, 'CLINICA_MEDICA')).toBe('VERMELHA');
    expect(prioridadeLeitoSugerida(estavel, {}, 'UTI_ADULTO')).toBe('VERMELHA');
    expect(prioridadeLeitoSugerida(news2({ fr: 22, sato2: 93, pas: 105, fc: 95, temp: 36.8, consciencia: 'ALERTA' }), {}, 'CLINICA_MEDICA')).toBe('AMARELA');
    expect(prioridadeLeitoSugerida(estavel, { oxigenio: true }, 'CLINICA_MEDICA')).toBe('AMARELA');
    expect(prioridadeLeitoSugerida(estavel, {}, 'CLINICA_MEDICA')).toBe('VERDE');
    expect(prioridadeLeitoSugerida(estavel, {}, 'CIRURGICA', true)).toBe('AZUL');
    expect(prioridadeLeitoSugerida(null, {}, 'CIRURGICA', true)).toBe('AZUL');
  });
  it('ordena por prioridade e tempo de espera e calcula prazo e horas', () => {
    const fila = ordenarFilaLeitos([
      { id: 'b', priority: 'VERDE', createdAt: '2026-10-01T10:00:00Z' },
      { id: 'c', priority: 'VERMELHA', createdAt: '2026-10-01T12:00:00Z' },
      { id: 'a', priority: 'VERMELHA', createdAt: '2026-10-01T09:00:00Z' },
    ] as const);
    expect(fila.map((f) => f.id)).toEqual(['a', 'c', 'b']);
    expect(prazoMetaLeito('AMARELA', '2026-10-01T10:00:00Z').toISOString()).toBe('2026-10-01T16:00:00.000Z');
    expect(horasEmFila('2026-10-01T10:00:00Z', '2026-10-01T13:30:00Z')).toBe(3.5);
    expect(numeroProtocoloLeito(2026, 12)).toBe('LEI-2026-000012');
  });
});

describe('Número da AIH', () => {
  it('gera o número com UF, ano, tipo, sequencial e dígito verificador', () => {
    const n = numeroAih('TO', 2026, '1', 123);
    expect(n).toHaveLength(13);
    expect(n.startsWith('17261')).toBe(true);
    expect(n.slice(5, 12)).toBe('0000123');
    expect(n[12]).toBe(dvAih(n.slice(0, 12)));
    expect(validarNumeroAih(n)).toEqual({ ok: true });
  });
  it('recusa números malformados ou com DV errado', () => {
    const n = numeroAih('TO', 2026, '5', 9_999_999);
    const errado = `${n.slice(0, 12)}${(Number(n[12]) + 1) % 10}`;
    expect(validarNumeroAih(errado).motivo).toBe('Dígito verificador inválido');
    expect(validarNumeroAih('123').ok).toBe(false);
    expect(validarNumeroAih('9926100000011').motivo).toContain('UF');
    expect(() => numeroAih('XX', 2026, '1', 1)).toThrow();
    expect(() => numeroAih('TO', 2026, '1', 0)).toThrow();
  });
});
