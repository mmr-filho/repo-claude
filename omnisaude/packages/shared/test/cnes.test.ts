import { describe, expect, it } from 'vitest';
import { ibge6, ibge7, roleFromCbo, teamTypeLabel, unitTypeFromCnes } from '@omnisaude/shared';

describe('CNES: códigos e sugestões', () => {
  it('converte o código IBGE entre 6 e 7 dígitos', () => {
    expect(ibge6('1709500')).toBe('170950');
    expect(ibge6('170950')).toBe('170950');
    expect(ibge7('170950')).toBe('1709500');
    expect(ibge7('355030')).toBe('3550308');
    expect(ibge7('1709500')).toBe('1709500');
  });

  it('sugere o tipo de unidade a partir do tipo do CNES', () => {
    expect(unitTypeFromCnes(2)).toBe('UBS');
    expect(unitTypeFromCnes('73')).toBe('UPA');
    expect(unitTypeFromCnes('05')).toBe('HOSPITAL');
    expect(unitTypeFromCnes(42)).toBe('SAMU');
    expect(unitTypeFromCnes(70)).toBe('CAPS');
    expect(unitTypeFromCnes(43)).toBe('FARMACIA_CENTRAL');
    expect(unitTypeFromCnes(50)).toBeNull();
  });

  it('sugere o papel pela ocupação e rotula tipos de equipe', () => {
    expect(roleFromCbo('225125')).toBe('MEDICO');
    expect(roleFromCbo('223505')).toBe('ENFERMAGEM');
    expect(roleFromCbo('322205')).toBe('ENFERMAGEM');
    expect(roleFromCbo('223405')).toBe('FARMACIA');
    expect(roleFromCbo('251605')).toBe('SERVICO_SOCIAL');
    expect(roleFromCbo('515105')).toBe('MULTIPROFISSIONAL');
    expect(teamTypeLabel('70')).toContain('eSF');
    expect(teamTypeLabel('72')).toContain('eMulti');
  });
});
