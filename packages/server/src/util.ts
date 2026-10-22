import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: Buffer, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'bad_request') => new HttpError(400, code, message);
export const unauthorized = (message = 'Credenciais inválidas') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Operação não permitida') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Não encontrado') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);

export const now = () => Date.now();
export const newId = () => randomUUID();

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hmacBytes(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/** Alfabeto de Crockford: sem I, L, O, U para evitar confusão na hora de ditar o código. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 16 símbolos (80 bits), no formato XXXX-XXXX-XXXX-XXXX. */
export function newCode(): string {
  const bytes = randomBytes(16);
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31]!);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export const hashCode = (code: string) => sha256Hex(`code:${normalizeCode(code)}`);

/** O authSecret já vem de um KDF no aparelho; aqui só acrescentamos um hash com sal para o banco. */
export async function hashAuthSecret(authSecret: string, saltB64u: string): Promise<string> {
  const out = await scrypt(Buffer.from(authSecret), Buffer.from(saltB64u, 'base64url'), 32, {
    N: 2 ** 14,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return out.toString('hex');
}
