import { describe, expect, it } from 'vitest';
import {
  applyQuietHours,
  isWithinQuietHours,
  nextAllowedTime,
  planAdherenceReminders,
  planAppointmentReminder,
} from '@omnisaude/messaging';

const iso = (d: Date | null | undefined) => d?.toISOString();

describe('janela de silêncio sanitário', () => {
  it('bloqueia entre 22h00 e 06h00 e libera às 06h01 (São Paulo, UTC-3)', () => {
    const tz = 'America/Sao_Paulo';
    expect(isWithinQuietHours(new Date('2026-03-10T00:59:00Z'), { timeZone: tz })).toBe(false); // 21:59
    expect(isWithinQuietHours(new Date('2026-03-10T01:00:00Z'), { timeZone: tz })).toBe(true); // 22:00
    expect(iso(nextAllowedTime(new Date('2026-03-10T01:30:00Z'), { timeZone: tz }))).toBe('2026-03-10T09:01:00.000Z');
    expect(iso(nextAllowedTime(new Date('2026-03-10T08:30:00Z'), { timeZone: tz }))).toBe('2026-03-10T09:01:00.000Z');
    // 06:00:30 ainda está bloqueado: o aviso matinal sai às 06:01.
    expect(iso(nextAllowedTime(new Date('2026-03-10T09:00:30Z'), { timeZone: tz }))).toBe('2026-03-10T09:01:00.000Z');
    const allowed = new Date('2026-03-10T09:01:00Z');
    expect(nextAllowedTime(allowed, { timeZone: tz })).toBe(allowed);
  });

  it('respeita o fuso do tenant (Manaus UTC-4, Rio Branco UTC-5)', () => {
    expect(iso(applyQuietHours(new Date('2026-03-10T02:30:00Z'), { timeZone: 'America/Manaus' }))).toBe(
      '2026-03-10T10:01:00.000Z',
    );
    expect(iso(applyQuietHours(new Date('2026-03-10T09:00:00Z'), { timeZone: 'America/Rio_Branco' }))).toBe(
      '2026-03-10T11:01:00.000Z',
    );
    // 21:30 em Rio Branco é 02:30Z: fora da janela local, mesmo sendo madrugada em UTC.
    expect(isWithinQuietHours(new Date('2026-03-10T02:30:00Z'), { timeZone: 'America/Rio_Branco' })).toBe(false);
  });

  it('virada de mês e ano', () => {
    expect(iso(applyQuietHours(new Date('2027-01-01T02:00:00Z'), { timeZone: 'America/Sao_Paulo' }))).toBe(
      '2027-01-01T09:01:00.000Z',
    );
  });

  it('URGENTE ignora a janela e a janela pode ser configurada', () => {
    const night = new Date('2026-03-10T03:00:00Z');
    expect(applyQuietHours(night, { priority: 'URGENTE' })).toBe(night);
    expect(isWithinQuietHours(new Date('2026-03-10T00:30:00Z'), { start: '21:00', resumeAt: '07:00' })).toBe(true);
    expect(() => isWithinQuietHours(night, { start: '25:00' })).toThrow(/Horário inválido/);
  });
});

describe('planejamento de confirmação de consulta', () => {
  const tz = 'America/Sao_Paulo';
  const now = new Date('2026-03-01T12:00:00Z');

  it('agenda 48h antes', () => {
    const plan = planAppointmentReminder({ startsAt: new Date('2026-03-12T17:00:00Z') }, now, tz);
    expect(plan).toEqual({ sendAt: new Date('2026-03-10T17:00:00Z'), postponed: false });
  });

  it('posterga quando 48h antes cai na madrugada', () => {
    const plan = planAppointmentReminder({ startsAt: new Date('2026-03-12T02:00:00Z') }, now, tz); // 23:00 local
    expect(plan).toEqual({ sendAt: new Date('2026-03-10T09:01:00Z'), postponed: true });
  });

  it('envia já se faltar menos de 48h, e não envia se o aviso chegaria tarde', () => {
    const late = new Date('2026-03-11T12:00:00Z');
    expect(planAppointmentReminder({ startsAt: new Date('2026-03-12T17:00:00Z') }, late, tz)?.sendAt).toEqual(late);
    const night = new Date('2026-03-11T02:30:00Z'); // 23:30 local
    expect(planAppointmentReminder({ startsAt: new Date('2026-03-11T09:30:00Z') }, night, tz)?.sendAt).toEqual(
      new Date('2026-03-11T09:01:00Z'),
    );
    expect(planAppointmentReminder({ startsAt: new Date('2026-03-11T09:00:00Z') }, night, tz)).toBeNull();
    expect(planAppointmentReminder({ startsAt: new Date('2026-02-01T09:00:00Z') }, now, tz)).toBeNull();
  });
});

describe('lembretes de aderência', () => {
  it('posterga doses noturnas e junta avisos coincidentes', () => {
    const reminders = planAdherenceReminders({
      firstDoseAt: new Date('2026-03-10T17:00:00Z'), // 14:00 local
      intervalHours: 8,
      durationDays: 2,
      medication: 'Amoxicilina 500 mg',
      dose: '1 cápsula',
      timeZone: 'America/Sao_Paulo',
    });
    expect(reminders.map((r) => [iso(r.sendAt), r.doseTimes.length, r.postponed])).toEqual([
      ['2026-03-10T17:00:00.000Z', 1, false],
      ['2026-03-11T09:01:00.000Z', 2, true],
      ['2026-03-11T17:00:00.000Z', 1, false],
      ['2026-03-12T09:01:00.000Z', 2, true],
    ]);
    expect(reminders[1]!.doseTimes.map(iso)).toEqual(['2026-03-11T01:00:00.000Z', '2026-03-11T09:00:00.000Z']);
    expect(reminders.reduce((n, r) => n + r.doseTimes.length, 0)).toBe(6);
  });

  it('valida a entrada', () => {
    const base = { firstDoseAt: new Date(), durationDays: 1, medication: 'X' };
    expect(() => planAdherenceReminders({ ...base, intervalHours: 0 })).toThrow();
    expect(() => planAdherenceReminders({ ...base, intervalHours: 0.001, durationDays: 30 })).toThrow(/excede/);
  });
});
