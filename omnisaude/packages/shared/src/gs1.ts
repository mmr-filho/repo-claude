/**
 * Códigos GS1 para rastreabilidade de medicamentos (Datamatrix 2D).
 * Formato legível: (01)GTIN(17)AAMMDD(10)LOTE(21)SERIE. No código lido do leitor, os campos de
 * tamanho variável são separados pelo caractere GS (0x1D).
 */

export const GS = '\u001d';

export interface Gs1Data {
  gtin: string; // AI 01, 14 dígitos
  expiry?: string; // AI 17, AAAA-MM-DD
  manufactured?: string; // AI 11, AAAA-MM-DD
  lot?: string; // AI 10
  serial?: string; // AI 21
}

const FIXED_LENGTH: Record<string, number> = { '01': 14, '11': 6, '17': 6 };
const VARIABLE_MAX: Record<string, number> = { '10': 20, '21': 20 };

export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const weight = (body.length - i) % 2 === 1 ? 3 : 1;
    sum += Number(body[i]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

/** Aceita GTIN-8/12/13/14 e devolve sempre 14 dígitos. */
export function normalizeGtin(value: string): string {
  const digits = value.replace(/\D+/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) throw new Error(`GTIN com tamanho inválido: ${value}`);
  return digits.padStart(14, '0');
}

export function isValidGtin(value: string): boolean {
  const digits = value.replace(/\D+/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  return gtinCheckDigit(digits.slice(0, -1)) === Number(digits.at(-1));
}

function toYymmdd(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`Data inválida: ${isoDate}`);
  return `${m[1]!.slice(2)}${m[2]}${m[3]}`;
}

function fromYymmdd(value: string): string {
  const yy = Number(value.slice(0, 2));
  const mm = value.slice(2, 4);
  let dd = value.slice(4, 6);
  const year = 2000 + yy;
  // Dia "00" significa último dia do mês.
  if (dd === '00') dd = String(new Date(Date.UTC(year, Number(mm), 0)).getUTCDate()).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function checkVariable(ai: string, value: string) {
  if (!value || value.length > VARIABLE_MAX[ai]! || value.includes(GS) || /[()]/.test(value)) {
    throw new Error(`Valor inválido para o AI ${ai}: ${value}`);
  }
}

/** Campos na ordem recomendada: tamanho fixo primeiro, variáveis por último. */
function fields(data: Gs1Data): [string, string][] {
  const out: [string, string][] = [['01', normalizeGtin(data.gtin)]];
  if (data.manufactured) out.push(['11', toYymmdd(data.manufactured)]);
  if (data.expiry) out.push(['17', toYymmdd(data.expiry)]);
  if (data.lot) {
    checkVariable('10', data.lot);
    out.push(['10', data.lot]);
  }
  if (data.serial) {
    checkVariable('21', data.serial);
    out.push(['21', data.serial]);
  }
  return out;
}

/** "(01)07891234567895(17)271231(10)L123(21)0001": usado na etiqueta e no gerador de Datamatrix. */
export function gs1HumanReadable(data: Gs1Data): string {
  return fields(data)
    .map(([ai, v]) => `(${ai})${v}`)
    .join('');
}

/** Cadeia de elementos como sai do leitor (sem o FNC1 inicial). */
export function gs1ElementString(data: Gs1Data): string {
  const f = fields(data);
  return f.map(([ai, v], i) => (ai in VARIABLE_MAX && i < f.length - 1 ? `${ai}${v}${GS}` : `${ai}${v}`)).join('');
}

/** Interpreta tanto a forma legível "(01)...(10)..." quanto a cadeia crua lida pelo scanner. */
export function parseGs1(input: string): Gs1Data {
  let raw = input.trim().replace(/^\](d2|C1|Q3|e0)/, '');
  const values: Record<string, string> = {};
  if (raw.startsWith('(')) {
    for (const m of raw.matchAll(/\((\d{2})\)([^(]*)/g)) values[m[1]!] = m[2]!;
  } else {
    if (raw.startsWith(GS)) raw = raw.slice(1);
    let i = 0;
    while (i < raw.length) {
      const ai = raw.slice(i, i + 2);
      i += 2;
      if (ai in FIXED_LENGTH) {
        values[ai] = raw.slice(i, i + FIXED_LENGTH[ai]!);
        i += FIXED_LENGTH[ai]!;
      } else if (ai in VARIABLE_MAX) {
        let end = raw.indexOf(GS, i);
        if (end === -1) end = raw.length;
        values[ai] = raw.slice(i, end);
        i = end + 1;
      } else {
        throw new Error(`Identificador de aplicação GS1 não suportado: ${ai}`);
      }
    }
  }
  if (!values['01']) throw new Error('Código GS1 sem GTIN (AI 01)');
  if (!isValidGtin(values['01'])) throw new Error(`GTIN com dígito verificador inválido: ${values['01']}`);
  return {
    gtin: values['01'],
    ...(values['17'] ? { expiry: fromYymmdd(values['17']) } : {}),
    ...(values['11'] ? { manufactured: fromYymmdd(values['11']) } : {}),
    ...(values['10'] ? { lot: values['10'] } : {}),
    ...(values['21'] ? { serial: values['21'] } : {}),
  };
}
