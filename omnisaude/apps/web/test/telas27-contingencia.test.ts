import * as compartilhado from '@omnisaude/shared';
import { ROTULO_STATUS_SEMANA, type StatusSemana } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import * as regras from '../src/components/consolidacao/contingencia-regras';

/*
 * Contingência (web): achado tel-3 (a situação das últimas semanas no canal só pela cor) e ponto K8 (a validação do
 * plano é a do pacote compartilhado, a mesma da API, e não uma cópia da web que pode divergir).
 */

describe('últimas semanas no canal (tel-3)', () => {
  it('o selo escreve a SE e a situação, não só a cor; o título traz o nome completo', () => {
    expect(regras.seloDaSemana({ rotulo: '44/2026', status: 'ACIMA_LS', completa: true })).toEqual({ texto: '44 · acima do LS', titulo: 'SE 44/2026: Acima do limite superior' });
    expect(regras.seloDaSemana({ rotulo: '45/2026', status: 'ATE_CENTRO', completa: false })).toEqual({ texto: '45 · até o centro (incompleta)', titulo: 'SE 45/2026: Até o centro (incompleta)' });
  });

  it('a legenda tem um selo de cada situação, com texto curto e nome completo distintos', () => {
    const todas = Object.keys(ROTULO_STATUS_SEMANA) as StatusSemana[];
    expect([...regras.LEGENDA_STATUS_SEMANA].sort()).toEqual([...todas].sort());
    const curtos = todas.map((s) => regras.ROTULO_CURTO_STATUS[s]);
    expect(new Set(curtos).size).toBe(todas.length);
    expect(curtos.every((t) => t.length > 0 && t.length <= 15)).toBe(true);
  });
});

describe('validação do plano (K8)', () => {
  it('é a função do pacote compartilhado, a mesma que a API usa', () => {
    expect(regras.validarPlano).toBe(compartilhado.validarPlano);
  });

  it('continua recusando o plano inválido com as mensagens da API', () => {
    const modelo = compartilhado.PLANO_MODELO_MS_2025;
    expect(regras.validarPlano(modelo)).toEqual([]);
    expect(regras.validarPlano({ ...modelo, agravos: [] })).toContain('O plano precisa de pelo menos um agravo.');
  });
});
