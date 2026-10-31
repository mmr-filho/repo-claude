import { describe, expect, it } from 'vitest';
import {
  CALENDARIO_VACINAL_0_24M,
  classificarPeDiabetico,
  classificarRiscoGestacional,
  estadoNutricionalImc,
  intervaloPreNatalDias,
  MCHAT_ITENS,
  pontuarMchat,
  PROGRAMAS_APS,
  vigenciaBolsaFamilia,
} from '../src/aps-programas';

describe('programas da APS e estratificações', () => {
  it('tem os oito programas com ações e linhas de busca ativa', () => {
    expect(PROGRAMAS_APS.map((p) => p.codigo)).toEqual(['PRE_NATAL', 'PUERICULTURA', 'HAS_DM', 'IDOSO', 'MULHER', 'BOLSA_FAMILIA', 'SISVAN', 'TB_HANSENIASE']);
    for (const p of PROGRAMAS_APS) {
      expect(p.acoes.length, p.codigo).toBeGreaterThan(0);
      expect(p.linhasBuscaAtiva.length, p.codigo).toBeGreaterThan(0);
    }
    expect(PROGRAMAS_APS.find((p) => p.codigo === 'HAS_DM')!.indicadores).toEqual(['C4', 'C5']);
  });

  it('pontua o M-CHAT-R com os itens invertidos 2, 5 e 12', () => {
    expect(MCHAT_ITENS).toHaveLength(20);
    expect(MCHAT_ITENS.filter((i) => i.riscoNoSim).map((i) => i.numero)).toEqual([2, 5, 12]);
    const todasSim = Object.fromEntries(MCHAT_ITENS.map((i) => [String(i.numero), true]));
    const todasNao = Object.fromEntries(MCHAT_ITENS.map((i) => [String(i.numero), false]));
    const tipico = { ...todasSim, '2': false, '5': false, '12': false };
    expect(pontuarMchat(tipico)).toMatchObject({ pontos: 0, resultado: 'BAIXO' });
    expect(pontuarMchat(todasSim)).toMatchObject({ pontos: 3, resultado: 'MEDIO', itensRisco: [2, 5, 12] });
    expect(pontuarMchat(todasNao)).toMatchObject({ pontos: 17, resultado: 'ALTO' });
    expect(pontuarMchat({ ...tipico, '1': false, '7': false, '9': false, '10': false, '14': false, '15': false, '16': false, '17': false }).resultado).toBe('ALTO');
    expect(() => pontuarMchat({ '1': true })).toThrow(/sem resposta/);
  });

  it('classifica o pé diabético pelo manual do Ministério da Saúde', () => {
    expect(classificarPeDiabetico([])).toMatchObject({ grau: 0, retornoMeses: 12 });
    expect(classificarPeDiabetico(['PSP'])).toMatchObject({ grau: 1, retornoMeses: 3 });
    expect(classificarPeDiabetico(['DEFORMIDADE'])).toMatchObject({ grau: 1 });
    expect(classificarPeDiabetico(['PSP', 'DAP'])).toMatchObject({ grau: 2, retornoMeses: 2 });
    expect(classificarPeDiabetico(['ULCERA_PREVIA'])).toMatchObject({ grau: 3, retornoMeses: 1 });
    expect(classificarPeDiabetico(['DAP', 'AMPUTACAO_PREVIA'])).toMatchObject({ grau: 3 });
  });

  it('classifica o risco gestacional: qualquer fator de alto risco encaminha', () => {
    expect(classificarRiscoGestacional([])).toMatchObject({ resultado: 'RISCO_HABITUAL', altoRisco: [], atencao: [] });
    expect(classificarRiscoGestacional(['IDADE', 'TABAGISMO'])).toMatchObject({ resultado: 'RISCO_HABITUAL', atencao: ['IDADE', 'TABAGISMO'] });
    expect(classificarRiscoGestacional(['IDADE', 'HAS_CRONICA'])).toMatchObject({ resultado: 'ALTO_RISCO', altoRisco: ['HAS_CRONICA'] });
    expect(classificarRiscoGestacional(['INEXISTENTE'])).toMatchObject({ resultado: 'RISCO_HABITUAL' });
  });

  it('conhece o calendário, os intervalos do pré-natal, as vigências do Bolsa Família e o IMC do SISVAN', () => {
    expect(CALENDARIO_VACINAL_0_24M.filter((d) => d.componente === 'DTP').map((d) => d.meses)).toEqual([2, 4, 6, 15]);
    expect(CALENDARIO_VACINAL_0_24M.filter((d) => d.componente === 'SCR').map((d) => d.meses)).toEqual([12, 15]);
    expect(intervaloPreNatalDias(10)).toBe(30);
    expect(intervaloPreNatalDias(30)).toBe(15);
    expect(intervaloPreNatalDias(38)).toBe(7);
    expect(vigenciaBolsaFamilia(new Date('2026-03-15T12:00:00Z'))).toMatchObject({ ano: 2026, semestre: 1 });
    expect(vigenciaBolsaFamilia(new Date('2026-10-31T12:00:00Z')).fim.toISOString().slice(0, 10)).toBe('2026-12-31');
    expect(estadoNutricionalImc(17, 30)).toBe('BAIXO_PESO');
    expect(estadoNutricionalImc(26, 30)).toBe('SOBREPESO');
    expect(estadoNutricionalImc(31, 30)).toBe('OBESIDADE');
    expect(estadoNutricionalImc(21, 70)).toBe('BAIXO_PESO');
    expect(estadoNutricionalImc(26, 70)).toBe('ADEQUADO');
    expect(estadoNutricionalImc(28, 70)).toBe('SOBREPESO');
  });
});
