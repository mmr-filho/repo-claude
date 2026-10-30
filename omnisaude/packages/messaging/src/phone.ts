/** Telefones brasileiros no formato aceito pela WhatsApp Cloud API: E.164 sem o "+" (ex.: 5511999998888). */

const VALID_DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91,
  92, 93, 94, 95, 96, 97, 98, 99,
]);

/**
 * Normaliza para 55 + DDD + número. Aceita celulares com 9 dígitos e também com 8 (o "wa_id" de contas
 * antigas chega sem o nono dígito) e fixos com 8. Devolve null quando o número não é válido.
 */
export function normalizeBrazilPhone(input: string): string | null {
  let digits = input.replace(/\D+/g, '');
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  } else {
    // Prefixos de discagem nacional ("0" ou "0 + operadora"): 0 11 9..., 0 21 11 9...
    if (digits.startsWith('0')) {
      digits = digits.replace(/^0+/, '');
      if (digits.length === 12 || digits.length === 13) digits = digits.slice(2);
    }
  }
  if (digits.length !== 10 && digits.length !== 11) return null;
  const ddd = Number(digits.slice(0, 2));
  if (!VALID_DDDS.has(ddd)) return null;
  const number = digits.slice(2);
  if (number.length === 9 && number[0] !== '9') return null;
  if (number.length === 8 && !/^[2-9]/.test(number)) return null;
  return `55${digits}`;
}

export function isValidBrazilPhone(input: string): boolean {
  return normalizeBrazilPhone(input) !== null;
}

/** "5511999998888" -> "(11) 99999-8888" */
export function formatBrazilPhone(e164: string): string {
  const n = normalizeBrazilPhone(e164);
  if (!n) return e164;
  const ddd = n.slice(2, 4);
  const rest = n.slice(4);
  const split = rest.length - 4;
  return `(${ddd}) ${rest.slice(0, split)}-${rest.slice(split)}`;
}
