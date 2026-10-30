import { describe, expect, it } from 'vitest';
import { listCarePathways, suggestCarePathway } from '@omnisaude/ai-engine';

describe('linhas de cuidado', () => {
  it('casa CID-10 por prefixo, com ou sem ponto', () => {
    const has = suggestCarePathway('I10');
    expect(has?.protocol.id).toBe('HAS');
    expect(has?.protocol.source).toMatch(/Caderno de Atenção Básica nº 37/);
    expect(has?.exams.map((e) => e.sigtapCode)).toContain('02.02.01.031-0');
    expect(suggestCarePathway('e11.9')?.protocol.id).toBe('DM2');
    expect(suggestCarePathway('E10')?.protocol.id).toBe('DM1');
    expect(suggestCarePathway('Z34.0')?.protocol.id).toBe('PRE-NATAL');
    expect(suggestCarePathway('O24.4')?.protocol.id).toBe('DMG');
    expect(suggestCarePathway('J45')?.exams).toEqual([]);
  });

  it('distingue CIAP-2 de CID-10 (K86 é hipertensão só no CIAP-2)', () => {
    expect(suggestCarePathway('K86', 'CIAP2')?.protocol.id).toBe('HAS');
    expect(suggestCarePathway('K86', 'CID10')).toBeNull();
    expect(suggestCarePathway('T90', 'CIAP2')?.protocol.id).toBe('DM2');
    expect(suggestCarePathway('W78', 'CIAP2')?.protocol.id).toBe('PRE-NATAL');
  });

  it('códigos SIGTAP no formato oficial e catálogo listável', () => {
    for (const p of ['I10', 'E11', 'E10', 'Z34', 'O24']) {
      for (const e of suggestCarePathway(p)!.exams) expect(e.sigtapCode).toMatch(/^\d{2}\.\d{2}\.\d{2}\.\d{3}-\d$/);
    }
    expect(listCarePathways().length).toBeGreaterThanOrEqual(6);
    expect(suggestCarePathway('')).toBeNull();
    expect(suggestCarePathway('A00')).toBeNull();
  });
});
