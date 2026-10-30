import { fromZonedParts, localDateString } from '@omnisaude/shared';
import { DomainError } from '../../core/errors';

const DAY = 86_400_000;

function parseDay(value: string, timeZone: string, plusDays = 0): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new DomainError('PERIODO_INVALIDO', `Data inválida: ${value} (use AAAA-MM-DD)`, 400);
  const base = fromZonedParts({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: 0, minute: 0, second: 0 }, timeZone);
  // Soma dias pelo calendário local (o Brasil não tem horário de verão desde 2019).
  return new Date(base.getTime() + plusDays * DAY);
}

/** Período em dias locais, com "até" inclusivo. Sem datas: últimos 30 dias. */
export function periodRange(timeZone: string, from?: string, to?: string) {
  const today = localDateString(new Date(), timeZone);
  const toDay = to ?? today;
  const fromDay = from ?? localDateString(new Date(parseDay(toDay, timeZone).getTime() - 29 * DAY), timeZone);
  const start = parseDay(fromDay, timeZone);
  const end = parseDay(toDay, timeZone, 1);
  if (end <= start) throw new DomainError('PERIODO_INVALIDO', 'A data final deve ser posterior à inicial', 400);
  if (end.getTime() - start.getTime() > 732 * DAY) throw new DomainError('PERIODO_INVALIDO', 'Período máximo de 2 anos', 400);
  return { from: fromDay, to: toDay, start, end };
}
