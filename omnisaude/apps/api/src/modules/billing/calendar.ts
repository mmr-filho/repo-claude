import { DEFAULT_TIME_ZONE, fromZonedParts, zonedParts } from '@omnisaude/shared';

/** Início (inclusivo) e fim (exclusivo) de uma competência AAAAMM no fuso do tenant. */
export function competenciaRange(competencia: string, timeZone: string = DEFAULT_TIME_ZONE) {
  const year = Number(competencia.slice(0, 4));
  const month = Number(competencia.slice(4, 6));
  const start = fromZonedParts({ year, month, day: 1, hour: 0, minute: 0, second: 0 }, timeZone);
  const end = fromZonedParts(
    { year: month === 12 ? year + 1 : year, month: month === 12 ? 1 : month + 1, day: 1, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
  return { start, end };
}

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), para achar a Sexta-feira Santa. */
function easter(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

const FIXED_HOLIDAYS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];

/** Feriados nacionais (fixos + Sexta-feira Santa). Feriados locais ficam a cargo do agendamento do tenant. */
export function isNationalHoliday(year: number, month: number, day: number): boolean {
  const key = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (FIXED_HOLIDAYS.includes(key)) return true;
  const e = easter(year);
  const goodFriday = new Date(Date.UTC(year, e.month - 1, e.day - 2));
  return goodFriday.getUTCMonth() + 1 === month && goodFriday.getUTCDate() === day;
}

function isBusinessDay(year: number, month: number, day: number): boolean {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !isNationalHoliday(year, month, day);
}

/** A sincronização da SIGTAP roda no primeiro dia útil de cada competência. */
export function isFirstBusinessDay(date: Date, timeZone: string = DEFAULT_TIME_ZONE): boolean {
  const p = zonedParts(date, timeZone);
  for (let day = 1; day <= 31; day++) {
    if (isBusinessDay(p.year, p.month, day)) return day === p.day;
  }
  return false;
}
