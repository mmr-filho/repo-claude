import { describe, expect, it } from 'vitest';
import { chaveNatural, deslocarSemana, normalizarNomePessoa, semanasEntre, semanasNoAno } from '@omnisaude/shared';

/** Auxiliares da fundação da semana 27 (VIG-1c); as regras do desenho têm testes próprios da frente F1. */
describe('semana 27: auxiliares da fundação', () => {
  it('desloca a semana epidemiológica atravessando o ano de 53 semanas', () => {
    expect(semanasNoAno(2025)).toBe(53);
    expect(semanasNoAno(2024)).toBe(52);
    expect(deslocarSemana('202553', 1)).toBe('202601');
    expect(deslocarSemana('202601', -1)).toBe('202553');
    expect(deslocarSemana('202452', 1)).toBe('202501');
    expect(deslocarSemana('202610', -12)).toBe('202551');
    expect(deslocarSemana('202610', 0)).toBe('202610');
    expect(() => deslocarSemana('202453', 1)).toThrow(/inexistente/);
    expect(semanasEntre('202551', '202602')).toEqual(['202551', '202552', '202553', '202601', '202602']);
    expect(semanasEntre('202602', '202601')).toEqual([]);
  });

  it('monta a chave natural de cada sistema', () => {
    const base = { numero: '0001234', notificadoEm: '2026-03-10', municipio: '1709500', agravo: 'A90', cnes: '2492075' };
    expect(chaveNatural({ ...base, sistema: 'SINAN_NET', tipo: 'INDIVIDUAL' })).toBe('1234|2026-03-10|170950|A90');
    expect(chaveNatural({ ...base, sistema: 'SINAN_ONLINE', tipo: 'INDIVIDUAL' })).toBe('1234|2026-03-10|170950|A90');
    expect(chaveNatural({ ...base, sistema: 'SINAN_NET', tipo: 'NEGATIVA', agravo: null })).toBe('1234|2026-03-10|170950|2492075');
    expect(chaveNatural({ ...base, sistema: 'ESUS_SINAN', tipo: 'INDIVIDUAL', numero: '172600000123', agravo: 'A930' })).toBe('172600000123|A930');
    expect(chaveNatural({ ...base, sistema: 'ESUS_NOTIFICA', tipo: 'INDIVIDUAL', numero: '172600012345' })).toBe('172600012345');
    expect(chaveNatural({ ...base, sistema: 'SINAN_NET', tipo: 'INDIVIDUAL', numero: '0000' })).toBe('0|2026-03-10|170950|A90');
  });

  it('normaliza o nome da pessoa: minúsculas, sem acento, só letras e espaço simples', () => {
    expect(normalizarNomePessoa('  JOSÉ  da Conceição-Silva ')).toBe('jose da conceicao silva');
    expect(normalizarNomePessoa("Íris D'Ávila 2ª")).toBe('iris d avila');
    expect(normalizarNomePessoa(null)).toBe('');
  });
});
