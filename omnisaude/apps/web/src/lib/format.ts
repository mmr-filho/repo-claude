import { formatCns, formatCpf } from '@omnisaude/shared';

export { formatCns, formatCpf };

const tz = 'America/Sao_Paulo';

export function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return d.toLocaleDateString('pt-BR', { timeZone: tz });
}

export function fmtDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
}

export function fmtTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

/** Data de hoje (AAAA-MM-DD) no fuso de Brasília. */
export function todayIso(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function fmtMinutes(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
}

export function fmtMoney(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
