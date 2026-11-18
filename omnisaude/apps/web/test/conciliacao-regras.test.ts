import { describe, expect, it } from 'vitest';
import {
  consultaConciliacao,
  motivoValido,
  percentualVinculado,
  podePreencherNumero,
  semPagina,
  temPaginaSeguinte,
  textoCobertura,
  textoDaPagina,
  textoDivergencia,
  textoPaciente,
} from '../src/components/consolidacao/conciliacao-regras';

/*
 * Aba Conciliação (web): filtros e páginas das listas, divergências em texto, paciente sigiloso e quando oferecer o
 * preenchimento do número oficial ao vincular.
 */

describe('filtros e páginas', () => {
  it('consulta só com o que foi preenchido; busca aparada; página 1 fica de fora', () => {
    expect(consultaConciliacao({})).toBe('');
    expect(consultaConciliacao({ sistema: 'SINAN_ONLINE', grupo: 'dengue', de: '2026-01-01', ate: '2026-03-31', busca: '  maria  ', pagina: 2 })).toBe(
      '?sistema=SINAN_ONLINE&grupo=dengue&de=2026-01-01&ate=2026-03-31&busca=maria&pagina=2',
    );
    expect(consultaConciliacao({ busca: '   ', pagina: 1 })).toBe('');
    expect(consultaConciliacao({ busca: 'x'.repeat(80) })).toBe(`?busca=${'x'.repeat(60)}`);
    expect(semPagina({ grupo: 'zika', pagina: 4 })).toEqual({ grupo: 'zika', pagina: undefined });
  });

  it('texto e navegação das páginas (50 por página, como a API)', () => {
    expect(textoDaPagina({ total: 120, pagina: 2, itens: new Array(50) })).toBe('51 a 100 de 120');
    expect(textoDaPagina({ total: 120, pagina: 3, itens: new Array(20) })).toBe('101 a 120 de 120');
    expect(textoDaPagina({ total: 0, pagina: 1, itens: [] })).toBe('Nenhum registro');
    expect(textoDaPagina({ total: 10, pagina: 5, itens: [] })).toBe('Página 5 vazia (10 no total)');
    expect(temPaginaSeguinte({ total: 120, pagina: 2 })).toBe(true);
    expect(temPaginaSeguinte({ total: 100, pagina: 2 })).toBe(false);
  });
});

describe('pares e pacientes', () => {
  it('divergências com rótulos: situação, evolução com o código e datas em dd/mm/aaaa', () => {
    expect(textoDivergencia({ campo: 'situacao', oficial: 'CONFIRMADO', omnisaude: 'EM_INVESTIGACAO' })).toEqual({ campo: 'Situação', oficial: 'Confirmado', omnisaude: 'Em investigação' });
    expect(textoDivergencia({ campo: 'evolucao', oficial: '2', omnisaude: null })).toEqual({ campo: 'Evolução', oficial: 'Óbito pelo agravo notificado (2)', omnisaude: 'sem informação' });
    expect(textoDivergencia({ campo: 'evolucao', oficial: '4', omnisaude: '1' })).toEqual({ campo: 'Evolução', oficial: 'código 4', omnisaude: 'Cura (1)' });
    expect(textoDivergencia({ campo: 'encerramento', oficial: '2026-03-05', omnisaude: null })).toEqual({ campo: 'Encerramento', oficial: '05/03/2026', omnisaude: 'sem informação' });
  });

  it('paciente: identificação quando há; sigiloso sem permissão; sem identificação quando o arquivo não trouxe', () => {
    expect(textoPaciente({ nome: 'Ana Souza', nascimento: '1990-02-01', sexo: 'F' }, false)).toBe('Ana Souza · nasc. 01/02/1990 · feminino');
    expect(textoPaciente({ nome: null, nascimento: null, sexo: 'M' }, false)).toBe('Sem nome · masculino');
    expect(textoPaciente(null, true)).toBe('Sigiloso (sem permissão para ver a identificação)');
    expect(textoPaciente(null, false)).toBe('Sem identificação');
  });

  it('oferece preencher o número oficial só sem número, no mesmo sistema e com permissão de digitar', () => {
    const r = { sistema: 'SINAN_NET' as const };
    expect(podePreencherNumero({ numeroOficial: null, sistemaOficial: 'SINAN_NET' }, r, true)).toBe(true);
    expect(podePreencherNumero({ numeroOficial: null, sistemaOficial: 'SINAN_NET' }, r, false)).toBe(false);
    expect(podePreencherNumero({ numeroOficial: '1234567', sistemaOficial: 'SINAN_NET' }, r, true)).toBe(false);
    expect(podePreencherNumero({ numeroOficial: null, sistemaOficial: 'ESUS_SINAN' }, r, true)).toBe(false);
    expect(podePreencherNumero({ numeroOficial: null, sistemaOficial: null }, r, true)).toBe(false);
  });

  it('motivo de 10 a 1.000 caracteres (aparado)', () => {
    expect(motivoValido('   curto   ')).toBe(false);
    expect(motivoValido('Pessoas diferentes: nascimento e mãe diferem')).toBe(true);
    expect(motivoValido('x'.repeat(1001))).toBe(false);
  });
});

describe('resumo', () => {
  it('percentual vinculado com uma casa; sem registros, null', () => {
    expect(percentualVinculado({ registros: 3, vinculados: 2 })).toBe(66.7);
    expect(percentualVinculado({ registros: 0, vinculados: 0 })).toBeNull();
  });

  it('cobertura em texto (no Sinan Online, os agravos que vieram)', () => {
    expect(textoCobertura({ sistema: 'SINAN_ONLINE', grupos: ['dengue', 'chikungunya'], de: '2025-01-01', ate: '2025-12-31' })).toBe('Sinan Online (dengue e chikungunya) · dengue, chikungunya · 01/01/2025 a 31/12/2025');
    expect(textoCobertura({ sistema: 'SINAN_NET', grupos: null, de: '2025-01-01', ate: '2025-06-30' })).toBe('Sinan Net · 01/01/2025 a 30/06/2025');
  });
});
