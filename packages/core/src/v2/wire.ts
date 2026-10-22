import { concatBytes, type Bytes } from '../bytes';

export { concatBytes };

/** Inteiro sem sinal em LEB128 (1 byte para valores < 128). */
export function varintEncode(n: number): Bytes {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('varint inválido');
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Uint8Array.from(out);
}

export function varintDecode(buf: Bytes, offset = 0): { value: number; next: number } {
  let value = 0;
  let mul = 1;
  for (let i = offset; i < buf.length && i < offset + 8; i++) {
    const b = buf[i]!;
    value += (b & 0x7f) * mul;
    if ((b & 0x80) === 0) return { value, next: i + 1 };
    mul *= 0x80;
  }
  throw new Error('varint truncado');
}

export function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function unhex(text: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/.test(text)) throw new Error('hex inválido');
  return Uint8Array.from((text.match(/../g) ?? []).map((h) => parseInt(h, 16)));
}
