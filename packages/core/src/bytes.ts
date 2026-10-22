import { base64urlnopad } from '@scure/base';

export type Bytes = Uint8Array;

/** UTF-8 manual: não depende de TextEncoder/TextDecoder, que variam entre runtimes React Native. */
export function utf8Encode(input: string): Bytes {
  const out: number[] = [];
  for (const ch of input) {
    let cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // surrogate solto
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes: Bytes): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    let cp = 0xfffd;
    let len = 1;
    if (b < 0x80) cp = b;
    else if (b >= 0xc2 && b < 0xe0) len = 2;
    else if (b >= 0xe0 && b < 0xf0) len = 3;
    else if (b >= 0xf0 && b < 0xf5) len = 4;
    if (len > 1) {
      if (i + len <= bytes.length) {
        cp = len === 2 ? b & 0x1f : len === 3 ? b & 0x0f : b & 0x07;
        for (let k = 1; k < len; k++) {
          const c = bytes[i + k]!;
          if ((c & 0xc0) !== 0x80) {
            cp = 0xfffd;
            len = k;
            break;
          }
          cp = (cp << 6) | (c & 0x3f);
        }
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
      } else {
        len = bytes.length - i;
      }
    }
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

export const b64 = {
  encode: (bytes: Bytes): string => base64urlnopad.encode(bytes),
  decode: (text: string): Bytes => base64urlnopad.decode(text),
};

export function concatBytes(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function randomBytes(n: number): Bytes {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) {
    throw new Error('crypto.getRandomValues indisponível: instale o polyfill de aleatoriedade antes de usar @sigilo/core');
  }
  const out = new Uint8Array(n);
  c.getRandomValues(out);
  return out;
}

/** UUID v4 gerado a partir de randomBytes (não depende de crypto.randomUUID). */
export function randomUuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function wipe(...arrays: Bytes[]): void {
  for (const a of arrays) a.fill(0);
}

export function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
