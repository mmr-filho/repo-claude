import { describe, expect, it } from 'vitest';
import {
  classificacaoNotaFinal,
  codigoImunobiologico,
  componentesDaVacina,
  conceitoDoIndicador,
  INDICADORES_APS,
  indicadoresDoBloco,
  mediaQuadrimestre,
  modalidadesDoTipo,
  notaFinal,
  quadrimestreDe,
  VALOR_QUALIDADE,
} from '../src/aps-indicadores';

describe('indicadores do componente de qualidade da APS', () => {
  it('tem os 15 indicadores com pesos que somam 10 em cada bloco', () => {
    expect(INDICADORES_APS).toHaveLength(15);
    for (const bloco of ['ESF_EAP', 'ESB', 'EMULTI'] as const) {
      expect(
        indicadoresDoBloco(bloco).reduce((s, i) => s + i.peso, 0),
        bloco,
      ).toBe(10);
    }
    expect(indicadoresDoBloco('ESF_EAP').map((i) => i.codigo)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']);
    // Boas práticas somam 100 pontos por pessoa (notas metodológicas, quadro 01).
    for (const i of INDICADORES_APS)
      if (i.boasPraticas)
        expect(
          i.boasPraticas.reduce((s, b) => s + b.pontos, 0),
          i.codigo,
        ).toBe(100);
  });

  it('classifica pelos parâmetros de cada nota metodológica, inclusive os de faixa', () => {
    expect(conceitoDoIndicador('C1', 44.34)).toBe('BOM');
    expect(conceitoDoIndicador('C1', 70)).toBe('OTIMO');
    expect(conceitoDoIndicador('C1', 70.1)).toBe('REGULAR');
    expect(conceitoDoIndicador('C1', 10)).toBe('REGULAR');
    expect(conceitoDoIndicador('C4', 75)).toBe('BOM');
    expect(conceitoDoIndicador('C4', 75.01)).toBe('OTIMO');
    expect(conceitoDoIndicador('C5', 25)).toBe('REGULAR');
    expect(conceitoDoIndicador('B3', 2.9)).toBe('REGULAR');
    expect(conceitoDoIndicador('B3', 3)).toBe('OTIMO');
    expect(conceitoDoIndicador('B3', 13.9)).toBe('SUFICIENTE');
    expect(conceitoDoIndicador('B3', 14)).toBe('REGULAR');
    expect(conceitoDoIndicador('B5', 85)).toBe('OTIMO');
    expect(conceitoDoIndicador('B5', 86)).toBe('REGULAR');
    expect(conceitoDoIndicador('B1', 1.3)).toBe('OTIMO');
    expect(conceitoDoIndicador('M1', 2.5)).toBe('BOM');
    expect(conceitoDoIndicador('M2', 1)).toBe('REGULAR');
    expect(conceitoDoIndicador('C2', null)).toBeNull();
  });

  it('reproduz o exemplo da Nota Técnica 8/2026: nota final 8,5 e conceito Ótimo', () => {
    const exemplo = [
      { peso: 1, conceito: 'BOM' as const },
      { peso: 2, conceito: 'OTIMO' as const },
      { peso: 2, conceito: 'OTIMO' as const },
      { peso: 1, conceito: 'SUFICIENTE' as const },
      { peso: 1, conceito: 'REGULAR' as const },
      { peso: 1, conceito: 'OTIMO' as const },
      { peso: 2, conceito: 'OTIMO' as const },
    ];
    expect(notaFinal(exemplo)).toBe(8.5);
    expect(classificacaoNotaFinal(8.5)).toBe('OTIMO');
    // Quadro 3 (eSB) corrigido na versão de 2026: 7,5 é "Bom" (≥ 5 e ≤ 7,5).
    expect(
      notaFinal([
        { peso: 2, conceito: 'BOM' },
        { peso: 2, conceito: 'OTIMO' },
        { peso: 2, conceito: 'OTIMO' },
        { peso: 1, conceito: 'SUFICIENTE' },
        { peso: 2, conceito: 'REGULAR' },
        { peso: 1, conceito: 'OTIMO' },
      ]),
    ).toBe(7.5);
    expect(classificacaoNotaFinal(7.5)).toBe('BOM');
    expect(classificacaoNotaFinal(5)).toBe('BOM');
    expect(classificacaoNotaFinal(4.99)).toBe('SUFICIENTE');
    expect(classificacaoNotaFinal(2.5)).toBe('REGULAR');
    // Média do quadrimestre ignora os meses sem resultado (C2/C3 sem coorte).
    expect(mediaQuadrimestre([42.62, 40.87, 41.9, 51.98])).toBe(44.34);
    expect(mediaQuadrimestre([80, null, 85, null])).toBe(82.5);
    expect(mediaQuadrimestre([null, null])).toBeNull();
  });

  it('conhece quadrimestres, modalidades e valores da Portaria 7.799/2025', () => {
    expect(quadrimestreDe('2026-10')).toMatchObject({ numero: 3, ano: 2026, meses: ['2026-09', '2026-10', '2026-11', '2026-12'] });
    expect(quadrimestreDe('2026-04').meses).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    expect(() => quadrimestreDe('2026-13')).toThrow();
    expect(modalidadesDoTipo('70')).toEqual(['ESF_40H']);
    expect(modalidadesDoTipo('76')).toEqual(['EAP_30H', 'EAP_20H']);
    expect(VALOR_QUALIDADE.ESF_40H).toEqual({ OTIMO: 8000, BOM: 6000, SUFICIENTE: 4000, REGULAR: 2000 });
    expect(VALOR_QUALIDADE.ESB_II_QUILOMBOLA.BOM).toBe(3675.38);
  });

  it('identifica o imunobiológico pelo código do e-SUS ou pelo nome', () => {
    expect(codigoImunobiologico('42', 'Penta')).toBe('42');
    expect(codigoImunobiologico('PENTA', 'Vacina penta (DTP/HepB/Hib)')).toBe('42');
    expect(componentesDaVacina(null, 'Vacina pentavalente')).toEqual(['DTP', 'HEPB', 'HIB']);
    expect(componentesDaVacina('VIP', 'Pólio inativada')).toEqual(['VIP']);
    expect(componentesDaVacina(null, 'Tríplice viral (SCR)')).toEqual(['SCR']);
    expect(componentesDaVacina(null, 'Influenza trivalente')).toEqual(['INFLUENZA']);
    expect(componentesDaVacina('57', 'dTpa adulto')).toEqual(['DTPA_ADULTO']);
    expect(componentesDaVacina(null, 'HPV quadrivalente')).toEqual(['HPV']);
    expect(componentesDaVacina(null, 'BCG')).toEqual([]);
  });
});
