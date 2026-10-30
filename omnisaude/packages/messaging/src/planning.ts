import { DEFAULT_TIME_ZONE } from '@omnisaude/shared';
import { applyQuietHours, type QuietHoursConfig } from './quiet-hours';

const HOUR = 3_600_000;

export interface PlannedSend {
  sendAt: Date;
  /** Verdadeiro quando o envio foi empurrado pela janela de silêncio. */
  postponed: boolean;
}

export interface AppointmentReminderOptions extends QuietHoursConfig {
  hoursBefore?: number;
}

/**
 * Confirmação ativa da consulta: 48h antes, respeitando a janela de silêncio. Se a consulta já está a menos
 * de 48h, envia assim que permitido; não envia se a consulta já passou ou se o aviso chegaria depois dela.
 */
export function planAppointmentReminder(
  appointment: { startsAt: Date },
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
  opts: AppointmentReminderOptions = {},
): PlannedSend | null {
  const startsAt = appointment.startsAt.getTime();
  if (startsAt <= now.getTime()) return null;
  const target = new Date(Math.max(startsAt - (opts.hoursBefore ?? 48) * HOUR, now.getTime()));
  const sendAt = applyQuietHours(target, { ...opts, timeZone });
  if (sendAt.getTime() >= startsAt) return null;
  return { sendAt, postponed: sendAt.getTime() !== target.getTime() };
}

export interface AdherencePlanInput extends QuietHoursConfig {
  firstDoseAt: Date;
  intervalHours: number;
  durationDays: number;
  medication: string;
  dose?: string;
  timeZone?: string;
}

export interface AdherenceReminder extends PlannedSend {
  medication: string;
  dose?: string;
  /** Horários das doses cobertas por este aviso (mais de um quando avisos postergados coincidem). */
  doseTimes: Date[];
}

export const MAX_ADHERENCE_REMINDERS = 1000;

/**
 * Lembretes de aderência sincronizados com a prescrição. Doses na janela de silêncio têm o aviso
 * postergado para 06h01; avisos que caem no mesmo instante viram uma única mensagem.
 */
export function planAdherenceReminders(input: AdherencePlanInput): AdherenceReminder[] {
  const { firstDoseAt, intervalHours, durationDays, medication, dose } = input;
  if (!(intervalHours > 0)) throw new Error('O intervalo entre doses deve ser maior que zero');
  if (!(durationDays > 0)) throw new Error('A duração do tratamento deve ser maior que zero');
  const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
  const end = firstDoseAt.getTime() + durationDays * 24 * HOUR;
  const doses: Date[] = [];
  for (let t = firstDoseAt.getTime(); t < end; t += intervalHours * HOUR) {
    doses.push(new Date(t));
    if (doses.length > MAX_ADHERENCE_REMINDERS) {
      throw new Error(`Plano excede ${MAX_ADHERENCE_REMINDERS} lembretes`);
    }
  }

  const bySendAt = new Map<number, AdherenceReminder>();
  for (const doseAt of doses) {
    const sendAt = applyQuietHours(doseAt, { start: input.start, resumeAt: input.resumeAt, timeZone });
    const key = sendAt.getTime();
    const existing = bySendAt.get(key);
    if (existing) {
      existing.doseTimes.push(doseAt);
      existing.postponed ||= key !== doseAt.getTime();
    } else {
      bySendAt.set(key, {
        sendAt,
        postponed: key !== doseAt.getTime(),
        medication,
        ...(dose ? { dose } : {}),
        doseTimes: [doseAt],
      });
    }
  }
  return [...bySendAt.values()].sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
}
