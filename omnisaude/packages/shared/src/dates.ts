/** Datas e fusos. O Brasil tem quatro fusos e nenhum horário de verão desde 2019; cada tenant guarda o seu. */

export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Data e hora "de parede" de um instante em um fuso. */
export function zonedParts(date: Date, timeZone: string = DEFAULT_TIME_ZONE): ZonedParts {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** Converte uma data e hora "de parede" em um fuso para o instante UTC correspondente. */
export function fromZonedParts(parts: ZonedParts, timeZone: string = DEFAULT_TIME_ZONE): Date {
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += asUtc - seen;
  }
  return new Date(guess);
}

/** "AAAA-MM-DD" no fuso informado. */
export function localDateString(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Competência de faturamento SUS ("AAAAMM"). */
export function competencia(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}${String(p.month).padStart(2, '0')}`;
}

export function ageInYears(birthDate: Date, at: Date = new Date()): number {
  let age = at.getUTCFullYear() - birthDate.getUTCFullYear();
  const m = at.getUTCMonth() - birthDate.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < birthDate.getUTCDate())) age--;
  return age;
}

/** Idade em meses completos (a SIGTAP expressa limites de idade em meses). */
export function ageInMonths(birthDate: Date, at: Date = new Date()): number {
  let months = (at.getUTCFullYear() - birthDate.getUTCFullYear()) * 12 + (at.getUTCMonth() - birthDate.getUTCMonth());
  if (at.getUTCDate() < birthDate.getUTCDate()) months--;
  return Math.max(0, months);
}
