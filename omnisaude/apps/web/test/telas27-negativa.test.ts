import type { UnidadeNotificante } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import { motivoNaoAtesta, pendenciasDesignacao, rotuloTipoUnidade } from '../src/components/consolidacao/negativa-regras';

/*
 * Notificação negativa (web): achado tel-7 (o tipo da unidade aparecia como o código do cadastro) e o contrato novo
 * da designação (só quem tem papel que atesta a negativa na unidade pode ser designado; a API recusa com 422
 * PAPEL_SEM_NEGATIVA).
 */

describe('tipo da unidade (tel-7)', () => {
  it('pelo nome do cadastro, não pelo código', () => {
    expect(rotuloTipoUnidade('VIGILANCIA_SAUDE')).toBe('Vigilância em saúde');
    expect(rotuloTipoUnidade('FARMACIA_CENTRAL')).toBe('Farmácia central');
    expect(rotuloTipoUnidade('POLICLINICA')).toBe('Policlínica / especialidades');
    // Tipo que a web ainda não conhece: o próprio texto, sem quebrar a tela.
    expect(rotuloTipoUnidade('NOVO_TIPO')).toBe('NOVO_TIPO');
    expect(rotuloTipoUnidade(null)).toBe('—');
  });
});

describe('designação do responsável', () => {
  const unidade: UnidadeNotificante = {
    unidade: { id: 'u1', nome: 'UBS Centro', cnes: '1234567' },
    tipoUnidade: 'UBS',
    ativa: true,
    periodoAtual: { id: 'p1', desde: '2026-01-01', ate: null, motivoFim: null },
    periodos: [{ id: 'p1', desde: '2026-01-01', ate: null, motivoFim: null }],
    responsaveis: [],
    semConfiguracao: false,
    avisos: [],
  };

  it('quem não tem papel que atesta na unidade não pode ser escolhido', () => {
    expect(motivoNaoAtesta({ podeAtestar: false })).toBe('Papel sem a negativa nesta unidade: não pode ser designado.');
    expect(motivoNaoAtesta({ podeAtestar: true })).toBeNull();
    expect(pendenciasDesignacao(unidade, { userId: 'acs', tipo: 'TITULAR', desde: '2026-11-16' }, 'Joaquim', { podeAtestar: false })).toEqual([
      'Joaquim não tem, nesta unidade, papel que atesta a negativa. Escolha quem tem lotação em papel que atesta.',
    ]);
    expect(pendenciasDesignacao(unidade, { userId: 'enf', tipo: 'TITULAR', desde: '2026-11-16' }, 'Maria', { podeAtestar: true })).toEqual([]);
    // Sem o lotado escolhido (lista ainda carregando), a regra antiga continua valendo.
    expect(pendenciasDesignacao(unidade, { userId: 'enf', tipo: 'TITULAR', desde: '2026-11-16' })).toEqual([]);
  });
});
