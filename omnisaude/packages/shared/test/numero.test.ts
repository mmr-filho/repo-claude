import { describe, expect, it } from 'vitest';
import { lerNumeroPtBr } from '../src';

describe('lerNumeroPtBr', () => {
  it('lê milhar com ponto e decimal com vírgula', () => {
    expect(lerNumeroPtBr('25.000')).toBe(25000);
    expect(lerNumeroPtBr('1.000,5')).toBe(1000.5);
    expect(lerNumeroPtBr('1.234.567,25')).toBe(1234567.25);
    expect(lerNumeroPtBr('25,5')).toBe(25.5);
    expect(lerNumeroPtBr('25000')).toBe(25000);
    expect(lerNumeroPtBr(' 1 500 ')).toBe(1500);
    expect(lerNumeroPtBr(',5')).toBe(0.5);
    expect(lerNumeroPtBr('0')).toBe(0);
  });
  it('recusa o ambíguo, o inválido e o vazio', () => {
    for (const t of ['2.5', '25.00', '1.0000', '1,2,3', '1.000.0', 'abc', '1,', '-3', '1e3', '', '   ', null, undefined, '.5', '1..000'])
      expect(lerNumeroPtBr(t as string)).toBeNull();
  });
});
