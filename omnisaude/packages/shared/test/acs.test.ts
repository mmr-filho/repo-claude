import { describe, expect, it } from 'vitest';
import { ehCboAcs, MOTIVO_VISITA_LABEL, MOTIVOS_VISITA, ordenarOperacoes, resumirVisitas, turnoDaHora } from '../src/acs';
import { roleFromCbo } from '../src/cnes';
import { ROLE_PERMISSIONS, roleHasPermission } from '../src/roles';

describe('trabalho de campo do ACS', () => {
  it('tem os motivos da ficha de visita sem repetição e o turno pela hora', () => {
    const codigos = MOTIVOS_VISITA.flatMap((g) => g.motivos.map((m) => m.codigo));
    expect(new Set(codigos).size).toBe(codigos.length);
    expect(MOTIVO_VISITA_LABEL['29']).toBe('Visita periódica');
    expect([turnoDaHora(7), turnoDaHora(13), turnoDaHora(19)]).toEqual([1, 2, 3]);
    expect(ehCboAcs('515105')).toBe(true);
    expect(ehCboAcs('223505')).toBe(false);
    expect(roleFromCbo('515105')).toBe('ACS');
  });

  it('o papel ACS registra em campo e vê o território; enfermagem e gestão só acompanham', () => {
    expect(roleHasPermission('ACS', 'acs.campo')).toBe(true);
    expect(roleHasPermission('ACS', 'paciente.cadastrar')).toBe(true);
    expect(roleHasPermission('ENFERMAGEM', 'acs.territorio')).toBe(true);
    expect(roleHasPermission('ENFERMAGEM', 'acs.campo')).toBe(false);
    expect(roleHasPermission('GESTOR', 'acs.territorio')).toBe(true);
    expect(ROLE_PERMISSIONS.ACS).not.toContain('prontuario.evoluir');
  });

  it('ordena o lote: pessoas, domicílios e visitas, cada grupo por data de registro', () => {
    const ops = ordenarOperacoes([
      { tipo: 'VISITA' as const, registradoEm: '2026-10-31T10:00:00Z' },
      { tipo: 'DOMICILIO' as const, registradoEm: '2026-10-31T09:00:00Z' },
      { tipo: 'PESSOA' as const, registradoEm: '2026-10-31T09:30:00Z' },
      { tipo: 'PESSOA' as const, registradoEm: '2026-10-31T08:00:00Z' },
    ]);
    expect(ops.map((o) => `${o.tipo}@${o.registradoEm.slice(11, 16)}`)).toEqual(['PESSOA@08:00', 'PESSOA@09:30', 'DOMICILIO@09:00', 'VISITA@10:00']);
  });

  it('resume a produtividade por agente: desfechos, domicílios e pessoas distintas, cobertura e motivos', () => {
    const r = resumirVisitas(
      [
        { professionalId: 'a', desfecho: '1', householdId: 'h1', patientId: 'p1', motivos: ['29', '11'] },
        { professionalId: 'a', desfecho: '1', householdId: 'h1', patientId: 'p2', motivos: ['29'] },
        { professionalId: 'a', desfecho: '3', householdId: 'h2', patientId: null, motivos: ['29'] },
        { professionalId: 'a', desfecho: '2', householdId: 'h3', patientId: 'p3', motivos: ['5'] },
        { professionalId: 'b', desfecho: '1', householdId: 'h9', patientId: null, motivos: ['1'] },
      ],
      new Map([['a', 10]]),
    );
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ professionalId: 'a', visitas: 4, realizadas: 2, recusadas: 1, ausentes: 1, domiciliosVisitados: 1, pessoasVisitadas: 2, cobertura: 10 });
    expect(r[0]!.motivosFrequentes[0]).toEqual({ codigo: '29', descricao: 'Visita periódica', total: 3 });
    expect(r[1]).toMatchObject({ professionalId: 'b', realizadas: 1, cobertura: null });
  });
});
