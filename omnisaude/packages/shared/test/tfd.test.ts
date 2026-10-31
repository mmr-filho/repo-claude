import { describe, expect, it } from 'vitest';
import { roleHasPermission } from '../src/roles';
import { alertasFrota, consumoMedio, numeroProcessoTfd, ocupacaoViagem, totalAjudaCusto } from '../src/tfd';

const hoje = new Date('2026-10-31T12:00:00Z');
const dias = (n: number) => new Date(hoje.getTime() + n * 86_400_000);

describe('TFD e transporte sanitário', () => {
  it('soma a ajuda de custo por beneficiário e numera o processo', () => {
    const r = totalAjudaCusto([
      { tipo: 'PASSAGEM', beneficiario: 'PACIENTE', quantidade: 2, valorUnitario: 89.9 },
      { tipo: 'PASSAGEM', beneficiario: 'ACOMPANHANTE', quantidade: 2, valorUnitario: 89.9 },
      { tipo: 'DIARIA', beneficiario: 'PACIENTE', quantidade: 3, valorUnitario: 50 },
    ]);
    expect(r).toEqual({ total: 509.6, porBeneficiario: { PACIENTE: 329.8, ACOMPANHANTE: 179.8 } });
    expect(numeroProcessoTfd(2026, 12)).toBe('TFD-2026-000012');
  });

  it('calcula a ocupação da viagem (acompanhante ocupa lugar; falta e cancelamento liberam)', () => {
    const o = ocupacaoViagem(4, [
      { status: 'AGENDADO', acompanhante: true, cadeirante: true },
      { status: 'EMBARCOU', acompanhante: false },
      { status: 'FALTOU', acompanhante: true },
      { status: 'CANCELADO', acompanhante: false },
    ]);
    expect(o).toEqual({ assentos: 4, usados: 3, livres: 1, cadeirantes: 1, lotada: false });
    expect(ocupacaoViagem(2, [{ status: 'AGENDADO', acompanhante: true }]).lotada).toBe(true);
  });

  it('consumo médio e alertas da frota', () => {
    expect(
      consumoMedio([
        { odometerKm: 10000, liters: 40 },
        { odometerKm: 10400, liters: 50 },
        { odometerKm: 10900, liters: 50 },
      ]),
    ).toBe(9);
    expect(consumoMedio([{ odometerKm: 10000, liters: 40 }])).toBeNull();
    const alertas = alertasFrota(
      [
        { plate: 'ABC1D23', odometerKm: 50200, nextMaintenanceKm: 50000, nextMaintenanceAt: null },
        { plate: 'DEF4G56', odometerKm: 10000, nextMaintenanceKm: 10300, nextMaintenanceAt: dias(10) },
        { plate: 'OK', odometerKm: 1000, nextMaintenanceKm: 9000, nextMaintenanceAt: dias(100) },
      ],
      [
        { name: 'João', cnhExpiry: dias(-1) },
        { name: 'Ana', cnhExpiry: dias(20) },
        { name: 'Bia', cnhExpiry: dias(400) },
      ],
      hoje,
    );
    expect(alertas).toEqual([
      'ABC1D23: manutenção vencida por km (50200 km, prevista aos 50000 km)',
      'DEF4G56: manutenção em até 300 km',
      'DEF4G56: manutenção prevista em até 30 dias',
      'João: CNH vencida',
      'Ana: CNH vence em até 30 dias',
    ]);
  });

  it('permissões: médico e serviço social cuidam do TFD; NIR e gestão gerem o transporte', () => {
    expect(roleHasPermission('MEDICO', 'tfd.gerir')).toBe(true);
    expect(roleHasPermission('SERVICO_SOCIAL', 'tfd.gerir')).toBe(true);
    expect(roleHasPermission('RECEPCAO', 'tfd.gerir')).toBe(false);
    expect(roleHasPermission('RECEPCAO', 'transporte.ler')).toBe(true);
    expect(roleHasPermission('NIR', 'transporte.gerir')).toBe(true);
    expect(roleHasPermission('SERVICO_SOCIAL', 'transporte.gerir')).toBe(false);
  });
});
