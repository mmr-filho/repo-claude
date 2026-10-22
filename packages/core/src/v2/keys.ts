import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64, randomBytes, utf8Encode, wipe, type Bytes } from '../bytes';
import { concatBytes } from './wire';

/** Par de chaves de assinatura Ed25519. */
export interface SignKeys {
  secretKey: Bytes;
  publicKey: Bytes;
}

/** Par de chaves de acordo X25519 (cifrar/decifrar). */
export interface BoxKeys {
  secretKey: Bytes;
  publicKey: Bytes;
}

/** Identidade de uma pessoa: uma chave para cifrar e outra para assinar. */
export interface Identity2 {
  box: BoxKeys;
  sign: SignKeys;
}

export function generateBoxKeys(): BoxKeys {
  const secretKey = randomBytes(32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function generateSignKeys(): SignKeys {
  const secretKey = randomBytes(32);
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

export function generateIdentity2(): Identity2 {
  return { box: generateBoxKeys(), sign: generateSignKeys() };
}

export function wipeIdentity2(id: Identity2): void {
  wipe(id.box.secretKey, id.sign.secretKey);
}

export const sign = (secretKey: Bytes, message: Bytes): Bytes => ed25519.sign(message, secretKey);

export function verify(publicKey: Bytes, message: Bytes, signature: Bytes): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** Referência curta (8 bytes) de uma chave pública, usada para achar o remetente sem expor a chave inteira. */
export function refOf(boxPublicKey: Bytes): Bytes {
  return sha256(concatBytes(utf8Encode('sigilo/v2/ref'), boxPublicKey)).slice(0, 8);
}

/** Identificador de uma rede: hash da chave pública da autoridade (16 bytes em base64url). */
export function networkIdOf(authorityPublicKey: Bytes): string {
  return b64.encode(sha256(concatBytes(utf8Encode('sigilo/v2/net'), authorityPublicKey)).slice(0, 16));
}

export function sha256Bytes(...parts: Bytes[]): Bytes {
  return sha256(concatBytes(...parts));
}
