import { describe, expect, it } from 'vitest';
import { GRUPOS_SIGILOSOS_NACIONAIS, opcoesDeAgravo, opcoesVisiveis, podeVerDiagramaSigiloso } from '../src/components/consolidacao/diagrama-agravos';
import { congelamentoDoCanal, seloCobertura } from '../src/components/consolidacao/diagrama-dados';

/*
 * Diagrama de controle (web), achados tel-2 e tra-2 e o contrato novo da cobertura:
 * - não oferecer "Congelar" quando a referência do canal inclui ano ainda incompleto (a API recusa com 422);
 * - não oferecer agravo sigiloso (HIV, aids, sífilis, violências) a quem não é da vigilância municipal (a API dá 403);
 * - o ano coberto só em parte aparece como tal.
 */

describe('congelar o canal (tel-2)', () => {
  it('com a referência completa, pode congelar', () => {
    expect(congelamentoDoCanal({ ano: 2026, referenciaIncompleta: [] })).toEqual({ pode: true, motivo: null });
    // Resposta antiga, sem o campo: não bloqueia (a API ainda recusa, e a recusa aparece no diálogo).
    expect(congelamentoDoCanal({ ano: 2026 })).toEqual({ pode: true, motivo: null });
  });

  it('com o ano em curso na referência (canal do ano seguinte), não oferece e diz até quando esperar', () => {
    expect(congelamentoDoCanal({ ano: 2027, referenciaIncompleta: [2026] })).toEqual({
      pode: false,
      motivo: 'O canal de 2027 usaria 2026 na referência, ano ainda incompleto (em curso ou com semanas incompletas). Congele depois que a SE 52/2026 estiver completa.',
    });
    // Logo depois da virada: o ano que acabou ainda com SE incompletas e o que começou (SE 53 em 2025).
    expect(congelamentoDoCanal({ ano: 2026, referenciaIncompleta: [2025, 2025] }).motivo).toContain('Congele depois que a SE 53/2025 estiver completa.');
    expect(congelamentoDoCanal({ ano: 2027, referenciaIncompleta: [2026, 2025] }).motivo).toBe(
      'O canal de 2027 usaria 2025 e 2026 na referência, anos ainda incompletos (em curso ou com semanas incompletas). Congele depois que a SE 52/2026 estiver completa.',
    );
  });
});

describe('cobertura do ano', () => {
  it('coberto, coberto em parte (com as SE cobertas) ou sem cobertura', () => {
    expect(seloCobertura({ coberto: true, parcial: false, semanasCobertas: 52 })).toEqual({ texto: 'Coberto', tom: 'green' });
    expect(seloCobertura({ coberto: true, parcial: true, semanasCobertas: 14 })).toEqual({ texto: 'Coberto em parte (14 SE)', tom: 'amber' });
    expect(seloCobertura({ coberto: false, parcial: false, semanasCobertas: 0 })).toEqual({ texto: 'Sem cobertura', tom: 'slate' });
  });
});

describe('agravo sigiloso no seletor (tra-2)', () => {
  it('os grupos sigilosos do catálogo nacional são os de HIV, aids, sífilis e violências', () => {
    expect([...GRUPOS_SIGILOSOS_NACIONAIS].sort()).toEqual(['aids', 'hiv', 'hiv-gestacao', 'sifilis', 'violencia', 'violencia-sexual-suicidio']);
  });

  it('o catálogo marca o grupo sigiloso pelo nacional ou pela linha sigilosa do tenant', () => {
    const o = opcoesDeAgravo([
      { key: 'dengue', groupKey: 'dengue', name: 'Dengue - Casos', context: 'CASO', sensitive: false },
      // O tenant desmarcou a linha, mas o grupo é sigiloso no catálogo nacional.
      { key: 'sifilis-adquirida', groupKey: 'sifilis', name: 'Sífilis adquirida', context: 'CASO', sensitive: false },
      // Agravo local marcado como sigiloso no catálogo do tenant.
      { key: 'mun-local', groupKey: 'mun-local', name: 'Agravo local', context: 'CASO', sensitive: true },
      { key: 'hanseniase', groupKey: 'hanseniase', name: 'Hanseníase', context: 'CASO' },
    ]);
    expect(o.filter((x) => x.sigiloso).map((x) => x.grupo)).toEqual(['mun-local', 'sifilis']);
    expect(o.find((x) => x.grupo === 'dengue')).toEqual({ grupo: 'dengue', nome: 'Dengue' });
  });

  it('sem o catálogo (gestor), a tabela do Sinan também traz a marca', () => {
    const o = opcoesDeAgravo(null);
    expect(o.find((x) => x.grupo === 'sifilis')?.sigiloso).toBe(true);
    expect(o.find((x) => x.grupo === 'dengue')?.sigiloso).toBeUndefined();
  });

  it('só a vigilância municipal com acesso ao sigilo vê o diagrama do agravo sigiloso (gestor e núcleo não)', () => {
    expect(podeVerDiagramaSigiloso('VIGILANCIA_EPIDEMIOLOGICA', ['vigilancia.resumo', 'notificacao.sensivel'])).toBe(true);
    expect(podeVerDiagramaSigiloso('NUCLEO_VIGILANCIA', ['vigilancia.painel', 'notificacao.sensivel'])).toBe(false);
    expect(podeVerDiagramaSigiloso('GESTOR', ['vigilancia.resumo'])).toBe(false);
    expect(podeVerDiagramaSigiloso('VIGILANCIA_EPIDEMIOLOGICA', ['vigilancia.resumo'])).toBe(false);
    expect(podeVerDiagramaSigiloso(undefined, [])).toBe(false);
  });

  it('o seletor tira os sigilosos de quem não pode vê-los, mas mantém o já escolhido', () => {
    const o = opcoesDeAgravo(null);
    const sem = opcoesVisiveis(o, false, 'dengue');
    expect(sem.some((x) => x.grupo === 'hiv' || x.grupo === 'sifilis' || x.grupo === 'violencia')).toBe(false);
    expect(sem.some((x) => x.grupo === 'dengue')).toBe(true);
    expect(opcoesVisiveis(o, false, 'sifilis').some((x) => x.grupo === 'sifilis')).toBe(true);
    expect(opcoesVisiveis(o, true, 'dengue')).toEqual(o);
  });
});
