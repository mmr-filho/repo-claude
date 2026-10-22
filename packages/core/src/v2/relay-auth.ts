import { sha256 } from '@noble/hashes/sha2.js';
import { b64, utf8Encode, type Bytes } from '../bytes';
import { sign, verify } from './keys';
import { concatBytes } from './wire';

/*
 * Autenticação de pedidos ao relé. O relé não tem contas nem senhas: cada caixa postal tem uma chave
 * pública Ed25519 registrada na criação, e quem lê/apaga assina o pedido com a chave privada.
 */

export const RELAY_SKEW_MS = 5 * 60 * 1000;
export const HEADER_TS = 'x-sigilo-ts';
export const HEADER_SIG = 'x-sigilo-sig';

const hex = (b: Bytes) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function signedText(method: string, path: string, ts: number, body: Bytes): Bytes {
  return concatBytes(utf8Encode(`sigilo-relay/v1\n${method.toUpperCase()}\n${path}\n${ts}\n`), utf8Encode(hex(sha256(body))));
}

export function signRelayRequest(secretKey: Bytes, method: string, path: string, body: Bytes = new Uint8Array(0), now = Date.now()): Record<string, string> {
  return {
    [HEADER_TS]: String(now),
    [HEADER_SIG]: b64.encode(sign(secretKey, signedText(method, path, now, body))),
  };
}

export function verifyRelayRequest(
  publicKeyB64: string,
  method: string,
  path: string,
  headers: { ts?: string | null; sig?: string | null },
  body: Bytes = new Uint8Array(0),
  now = Date.now(),
): boolean {
  try {
    const ts = Number(headers.ts);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > RELAY_SKEW_MS || !headers.sig) return false;
    return verify(b64.decode(publicKeyB64), signedText(method, path, ts, body), b64.decode(headers.sig));
  } catch {
    return false;
  }
}
