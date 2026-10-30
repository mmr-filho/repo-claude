import { fold, wordsToNumbers } from './text';

/** Doses por dia a partir de uma posologia em texto ("8/8h", "de 6 em 6 horas", "3x ao dia", "dose única"). */
export function dosesPerDay(frequency: string): number | undefined {
  const f = wordsToNumbers(fold(frequency));
  let m = /(\d+)\s*\/\s*\1\s*h/.exec(f) ?? /de\s+(\d+)\s+em\s+\1\s*h/.exec(f) ?? /(?:a\s+)?cada\s+(\d+)\s*h/.exec(f) ?? /(\d+)\s+em\s+\1\s*h/.exec(f);
  if (m) {
    const hours = Number(m[1]);
    return hours > 0 && hours <= 24 ? 24 / hours : undefined;
  }
  m = /(\d+)\s*(?:x|vez|vezes)\s*(?:ao|por|\/)?\s*dia/.exec(f);
  if (m) return Number(m[1]);
  if (/dose unica|1\s*vez\s*(?:ao|por)\s*dia|(?:^|\s)(?:diariamente|ao dia|por dia)(?:\s|$)/.test(f)) return 1;
  return undefined;
}

/** Quantidade em mg de uma dose ("500 mg", "1 g", "2 comprimidos de 500 mg"). Concentrações ("mg/ml") não são interpretadas. */
export function doseInMg(dose: string): number | undefined {
  const d = wordsToNumbers(fold(dose)).replace(/(\d),(\d)/g, '$1.$2');
  const m = /(\d+(?:\.\d+)?)\s*(mg|g|mcg|miligramas?|gramas?|microgramas?)\b(?!\s*\/)/.exec(d);
  if (!m) return undefined;
  const unit = m[2]!;
  let mg = Number(m[1]);
  if (unit === 'g' || unit.startsWith('grama')) mg *= 1000;
  else if (unit === 'mcg' || unit.startsWith('micrograma')) mg /= 1000;
  const count = /(\d+(?:\.\d+)?)\s*(?:comprimidos?|cps?|capsulas?|caps?|drageas?)\s+de\s/.exec(d.slice(0, m.index));
  if (count) mg *= Number(count[1]);
  return mg;
}

export function estimateDailyDoseMg(dose?: string, frequency?: string): number | undefined {
  if (!dose || !frequency) return undefined;
  const mg = doseInMg(dose);
  const n = dosesPerDay(frequency);
  return mg !== undefined && n !== undefined ? mg * n : undefined;
}
