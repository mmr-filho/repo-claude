import { describe, expect, it } from 'vitest';
import { hashPassword, passwordProblems, verifyPassword } from '@omnisaude/database';

describe('senhas', () => {
  it('confere a senha certa e recusa a errada', async () => {
    const stored = await hashPassword('Correta123456');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('Correta123456', stored)).toBe(true);
    expect(await verifyPassword('Errada1234567', stored)).toBe(false);
    expect(await verifyPassword('x', 'formato-invalido')).toBe(false);
  });

  it('aplica a regra mínima', () => {
    expect(passwordProblems('curta1')).toHaveLength(1);
    expect(passwordProblems('semnumerosaqui')).toHaveLength(1);
    expect(passwordProblems('ComNumeros2026')).toHaveLength(0);
  });
});
