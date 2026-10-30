/** Utilitários de texto em português: comparação sem acentos e números por extenso. */

/** Remove acentos e passa para minúsculas, caractere a caractere: o resultado tem o mesmo tamanho do original. */
export function fold(text: string): string {
  let out = '';
  for (const ch of text) {
    const base = ch.normalize('NFD').charAt(0).toLowerCase();
    // Mantém o comprimento em unidades UTF-16 para que índices do texto dobrado valham no original.
    out += ch.length === base.length ? base : ch;
  }
  return out;
}

/** Remove acentos, minúsculas, espaços únicos. Para chaves de busca (o tamanho pode mudar). */
export function normalizeKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const UNITS: Record<string, number> = {
  zero: 0,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  quatorze: 14,
  catorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezasseis: 16,
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
};
const TENS: Record<string, number> = {
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50,
  sessenta: 60,
  setenta: 70,
  oitenta: 80,
  noventa: 90,
};
const HUNDREDS: Record<string, number> = {
  cem: 100,
  cento: 100,
  duzentos: 200,
  duzentas: 200,
  trezentos: 300,
  trezentas: 300,
  quatrocentos: 400,
  quatrocentas: 400,
  quinhentos: 500,
  quinhentas: 500,
  seiscentos: 600,
  seiscentas: 600,
  setecentos: 700,
  setecentas: 700,
  oitocentos: 800,
  oitocentas: 800,
  novecentos: 900,
  novecentas: 900,
};

function wordValue(word: string): number | undefined {
  return UNITS[word] ?? TENS[word] ?? HUNDREDS[word] ?? (word === 'mil' ? 1000 : undefined);
}

function magnitude(value: number): number {
  if (value >= 1000) return 1000;
  if (value >= 100) return 100;
  if (value >= 20) return 10;
  return 1;
}

interface Token {
  core: string;
  suffix: string; // pontuação colada à palavra ("oito," -> "oito" + ",")
}

function tokenValue(token: Token | undefined): number | undefined {
  return token ? wordValue(token.core) : undefined;
}

/** Lê um número por extenso a partir de `start`; devolve o valor e o índice do próximo token. */
function readNumber(tokens: Token[], start: number): { value: number; next: number } | null {
  if (tokenValue(tokens[start]) === undefined) return null;
  let total = 0;
  let current = 0;
  let j = start;
  while (j < tokens.length) {
    const v = tokenValue(tokens[j]);
    if (v === undefined) break;
    if (v === 1000) {
      total += (current || 1) * 1000;
      current = 0;
    } else {
      current += v;
    }
    const punctuated = tokens[j]!.suffix !== '';
    j++;
    if (punctuated) break;
    const mag = magnitude(v);
    // "cento e vinte", "trinta e oito", "mil e duzentos": o "e" só une partes de ordem menor.
    const afterE = tokenValue(tokens[j + 1]);
    if (tokens[j]?.core === 'e' && tokens[j]!.suffix === '' && afterE !== undefined && mag > 1 && afterE < mag) {
      j++;
      continue;
    }
    const next = tokenValue(tokens[j]);
    if (next !== undefined && ((next === 1000 && v < 1000) || (mag > 1 && next < mag))) continue;
    break;
  }
  return { value: total + current, next: j };
}

/**
 * Converte números por extenso em algarismos: "quinhentos" -> "500", "cento e vinte" -> "120",
 * "trinta e oito virgula cinco" -> "38.5", "um e meio" -> "1.5", "dois mil e quinhentos" -> "2500".
 * Espera texto já dobrado (sem acentos, minúsculas); espaços repetidos viram um só.
 */
export function wordsToNumbers(text: string): string {
  const tokens: Token[] = text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const m = /^(.*?)([,;:.!?)]*)$/.exec(w)!;
      return { core: m[1]!, suffix: m[2]! };
    });
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const parsed = readNumber(tokens, i);
    if (!parsed) {
      out.push(tokens[i]!.core + tokens[i]!.suffix);
      i++;
      continue;
    }
    let value = String(parsed.value);
    let next = parsed.next;
    let suffix = tokens[next - 1]!.suffix;
    const sep = tokens[next];
    if (!suffix && (sep?.core === 'virgula' || sep?.core === 'ponto') && sep.suffix === '') {
      const frac = readNumber(tokens, next + 1);
      if (frac) {
        value = `${parsed.value}.${frac.value}`;
        next = frac.next;
        suffix = tokens[next - 1]!.suffix;
      }
    } else if (!suffix && sep?.core === 'e' && sep.suffix === '' && tokens[next + 1]?.core === 'meio') {
      value = String(parsed.value + 0.5);
      suffix = tokens[next + 1]!.suffix;
      next += 2;
    }
    out.push(value + suffix);
    i = next;
  }
  return out.join(' ');
}

/** Divide em frases preservando o texto. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
