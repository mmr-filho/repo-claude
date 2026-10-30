import { DEFAULT_TIME_ZONE, fromZonedParts, zonedParts } from '@omnisaude/shared';

/**
 * Janela de Silêncio Sanitário: mensagens automáticas de rotina não saem entre 22h00 e 06h00 (hora local
 * do tenant) e são postergadas para 06h01. A janela bloqueada é [22:00, 06:01).
 */

export type MessagePriority = 'ROTINA' | 'URGENTE';

export interface QuietHoursConfig {
  /** Início do bloqueio, "HH:MM" (padrão 22:00). */
  start?: string;
  /** Primeiro horário liberado, "HH:MM" (padrão 06:01). */
  resumeAt?: string;
}

export interface QuietHoursOptions extends QuietHoursConfig {
  timeZone?: string;
}

export const DEFAULT_QUIET_HOURS = { start: '22:00', resumeAt: '06:01' } as const;

function toMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Horário inválido: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function quietWindow(opts: QuietHoursConfig) {
  const start = toMinutes(opts.start ?? DEFAULT_QUIET_HOURS.start);
  const resume = toMinutes(opts.resumeAt ?? DEFAULT_QUIET_HOURS.resumeAt);
  return { start, resume };
}

function blocked(minuteOfDay: number, start: number, resume: number): boolean {
  // A janela normalmente atravessa a meia-noite (22:00 -> 06:01).
  return start > resume ? minuteOfDay >= start || minuteOfDay < resume : minuteOfDay >= start && minuteOfDay < resume;
}

export function isWithinQuietHours(date: Date, opts: QuietHoursOptions = {}): boolean {
  const { start, resume } = quietWindow(opts);
  const p = zonedParts(date, opts.timeZone ?? DEFAULT_TIME_ZONE);
  return blocked(p.hour * 60 + p.minute, start, resume);
}

/** Primeiro instante permitido a partir de `date` (ele mesmo, se estiver fora da janela). */
export function nextAllowedTime(date: Date, opts: QuietHoursOptions = {}): Date {
  const timeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;
  const { start, resume } = quietWindow(opts);
  const p = zonedParts(date, timeZone);
  const minute = p.hour * 60 + p.minute;
  if (!blocked(minute, start, resume)) return date;
  // Se já passou do início (antes da meia-noite), libera no dia seguinte.
  const nextDay = start > resume && minute >= start;
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day + (nextDay ? 1 : 0)));
  return fromZonedParts(
    {
      year: day.getUTCFullYear(),
      month: day.getUTCMonth() + 1,
      day: day.getUTCDate(),
      hour: Math.floor(resume / 60),
      minute: resume % 60,
      second: 0,
    },
    timeZone,
  );
}

export interface ApplyQuietHoursOptions extends QuietHoursOptions {
  /** URGENTE ignora a janela; precisa ser informado explicitamente por quem envia. */
  priority?: MessagePriority;
}

export function applyQuietHours(sendAt: Date, opts: ApplyQuietHoursOptions = {}): Date {
  if (opts.priority === 'URGENTE') return sendAt;
  return nextAllowedTime(sendAt, opts);
}
