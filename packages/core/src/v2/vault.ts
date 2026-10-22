import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64, randomBytes, utf8Decode, utf8Encode, wipe, type Bytes } from '../bytes';
import {
  DEFAULT_KDF_PARAMS,
  DEFAULT_KDF_POLICY,
  WrongPasswordError,
  assertKdfParams,
  jsScrypt,
  newKdfSalt,
  type KdfParams,
  type KdfPolicy,
  type ScryptFn,
} from '../crypto';

/*
 * Cofre do aparelho (v2): as chaves secretas, cifradas com a senha. Não existe cópia em servidor:
 * sem a senha, nem o dono nem ninguém abre. Perdeu o aparelho ou a senha = o administrador emite uma identidade nova.
 */

export interface VaultSecrets {
  /** Chave secreta X25519 (base64url). */
  box: string;
  /** Chave secreta Ed25519 de assinatura. */
  sign: string;
  /** Chave secreta da autoridade da rede (só no aparelho do administrador). */
  authority?: string;
}

export interface VaultRecord {
  v: 1;
  salt: string;
  params: KdfParams;
  wrapped: string;
}

export interface VaultOptions {
  params?: KdfParams;
  policy?: KdfPolicy;
  scrypt?: ScryptFn;
}

const AAD = utf8Encode('sigilo/v2/vault');

async function vaultKey(password: string, salt: string, params: KdfParams, o: VaultOptions): Promise<Bytes> {
  const policy = o.policy ?? DEFAULT_KDF_POLICY;
  assertKdfParams(params, policy);
  const pw = utf8Encode(typeof password.normalize === 'function' ? password.normalize('NFKC') : password);
  const mk = await (o.scrypt ?? jsScrypt)(pw, b64.decode(salt), { N: params.N, r: params.r, p: params.p, dkLen: 32 });
  const key = hkdf(sha256, mk, undefined, utf8Encode('sigilo/v2/vault-key'), 32);
  wipe(mk);
  return key;
}

export async function createVault(password: string, secrets: VaultSecrets, o: VaultOptions = {}): Promise<VaultRecord> {
  const params = o.params ?? DEFAULT_KDF_PARAMS;
  const salt = newKdfSalt();
  const key = await vaultKey(password, salt, params, o);
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305(key, nonce, AAD).encrypt(utf8Encode(JSON.stringify(secrets)));
  wipe(key);
  return { v: 1, salt, params, wrapped: JSON.stringify({ n: b64.encode(nonce), c: b64.encode(sealed) }) };
}

/** Lança WrongPasswordError se a senha estiver errada. */
export async function openVault(password: string, record: VaultRecord, o: VaultOptions = {}): Promise<VaultSecrets> {
  const key = await vaultKey(password, record.salt, record.params, o);
  try {
    const w = JSON.parse(record.wrapped) as { n: string; c: string };
    const plain = xchacha20poly1305(key, b64.decode(w.n), AAD).decrypt(b64.decode(w.c));
    const secrets = JSON.parse(utf8Decode(plain)) as VaultSecrets;
    wipe(plain);
    return secrets;
  } catch {
    throw new WrongPasswordError();
  } finally {
    wipe(key);
  }
}

/** Cifra o estado do app (contatos, certificados...) com uma chave derivada da identidade: só legível com o cofre aberto. */
export function sealState(secretKey: Bytes, json: string): string {
  const key = hkdf(sha256, secretKey, undefined, utf8Encode('sigilo/v2/state-key'), 32);
  const nonce = randomBytes(24);
  const c = xchacha20poly1305(key, nonce, utf8Encode('sigilo/v2/state')).encrypt(utf8Encode(json));
  wipe(key);
  return JSON.stringify({ n: b64.encode(nonce), c: b64.encode(c) });
}

export function openState(secretKey: Bytes, sealed: string): string {
  const key = hkdf(sha256, secretKey, undefined, utf8Encode('sigilo/v2/state-key'), 32);
  try {
    const w = JSON.parse(sealed) as { n: string; c: string };
    return utf8Decode(xchacha20poly1305(key, b64.decode(w.n), utf8Encode('sigilo/v2/state')).decrypt(b64.decode(w.c)));
  } finally {
    wipe(key);
  }
}
