import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { b64, bytesEqual, concatBytes, randomBytes, utf8Decode, utf8Encode, wipe, type Bytes } from './bytes';

/*
 * Protocolo de criptografia do Sigilo (v1). Resumo; detalhes em docs/ARQUITETURA.md.
 *
 *  senha ──scrypt(salt)──▶ MK ──HKDF "kek"──▶ KEK   (nunca sai do aparelho)
 *                             └─HKDF "auth"─▶ authSecret (enviado ao servidor para login)
 *
 *  Cada conta tem um par X25519 gerado no aparelho. A chave privada é guardada no
 *  servidor apenas cifrada com a KEK (XChaCha20-Poly1305).
 *
 *  Mensagem: ECIES autenticado (estilo Noise "X"): efêmera→destino + estática→destino.
 *  A chave estática do remetente autentica quem enviou; a efêmera dá sigilo futuro
 *  em relação à chave do remetente.
 */

const V = 'sigilo/v1';

export class WrongPasswordError extends Error {
  constructor() {
    super('Senha incorreta');
    this.name = 'WrongPasswordError';
  }
}

export class DecryptError extends Error {
  constructor(message = 'Não foi possível descriptografar a mensagem') {
    super(message);
    this.name = 'DecryptError';
  }
}

// ───────────────────────── KDF ─────────────────────────

export interface KdfParams {
  alg: 'scrypt';
  N: number;
  r: number;
  p: number;
}

/** N=2^15, r=8 => ~32 MiB de memória. Ajustável por conta: os parâmetros são gravados junto com o salt. */
export const DEFAULT_KDF_PARAMS: KdfParams = { alg: 'scrypt', N: 2 ** 15, r: 8, p: 1 };

/** Impede que um servidor malicioso force parâmetros fracos (ou absurdos) no cliente. */
export interface KdfPolicy {
  minN: number;
  maxN: number;
}
export const DEFAULT_KDF_POLICY: KdfPolicy = { minN: 2 ** 14, maxN: 2 ** 20 };

export function assertKdfParams(params: KdfParams, policy: KdfPolicy = DEFAULT_KDF_POLICY): void {
  const { N, r, p } = params;
  const pow2 = Number.isInteger(N) && N > 1 && (N & (N - 1)) === 0;
  if (params.alg !== 'scrypt' || !pow2 || N < policy.minN || N > policy.maxN || r < 8 || r > 16 || p < 1 || p > 4) {
    throw new Error('Parâmetros de derivação de chave recusados');
  }
}

export interface AccountKeys {
  /** Chave que cifra a chave privada. Fica só na memória do aparelho. */
  kek: Bytes;
  /** Prova de senha enviada ao servidor; não permite derivar a KEK. */
  authSecret: string;
}

export function newKdfSalt(): string {
  return b64.encode(randomBytes(16));
}

export async function deriveAccountKeys(
  password: string,
  saltB64: string,
  params: KdfParams,
  policy: KdfPolicy = DEFAULT_KDF_POLICY,
): Promise<AccountKeys> {
  assertKdfParams(params, policy);
  const normalized = typeof password.normalize === 'function' ? password.normalize('NFKC') : password;
  const mk = await scryptAsync(utf8Encode(normalized), b64.decode(saltB64), {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: 32,
    asyncTick: 10,
  });
  const kek = hkdf(sha256, mk, undefined, utf8Encode(`${V}/kek`), 32);
  const auth = hkdf(sha256, mk, undefined, utf8Encode(`${V}/auth`), 32);
  wipe(mk);
  const authSecret = b64.encode(auth);
  wipe(auth);
  return { kek, authSecret };
}

// ───────────────────────── Identidade ─────────────────────────

export interface Identity {
  secretKey: Bytes;
  publicKey: Bytes;
}

export function generateIdentity(): Identity {
  const secretKey = randomBytes(32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

interface Sealed {
  v: 1;
  n: string;
  c: string;
}

export function wipeIdentity(identity: Identity): void {
  wipe(identity.secretKey);
}

/** Cifra a chave privada com a KEK. Retorna string opaca para o servidor guardar. */
export function wrapSecretKey(kek: Bytes, identity: Identity): string {
  const nonce = randomBytes(24);
  const aad = utf8Encode(`${V}/identity|${b64.encode(identity.publicKey)}`);
  const c = xchacha20poly1305(kek, nonce, aad).encrypt(identity.secretKey);
  const sealed: Sealed = { v: 1, n: b64.encode(nonce), c: b64.encode(c) };
  return JSON.stringify(sealed);
}

/** Lança WrongPasswordError se a KEK não abrir o envelope. */
export function unwrapSecretKey(kek: Bytes, publicKeyB64: string, wrapped: string): Identity {
  const publicKey = b64.decode(publicKeyB64);
  let secretKey: Bytes;
  try {
    const sealed = JSON.parse(wrapped) as Sealed;
    if (sealed.v !== 1) throw new Error('versão');
    const aad = utf8Encode(`${V}/identity|${publicKeyB64}`);
    secretKey = xchacha20poly1305(kek, b64.decode(sealed.n), aad).decrypt(b64.decode(sealed.c));
  } catch {
    throw new WrongPasswordError();
  }
  if (!bytesEqual(x25519.getPublicKey(secretKey), publicKey)) {
    wipe(secretKey);
    throw new WrongPasswordError();
  }
  return { secretKey, publicKey };
}

// ───────────────────────── Mensagens ─────────────────────────

export interface MessageContext {
  messageId: string;
  senderId: string;
  recipientId: string;
}

export interface MessagePayload {
  text: string;
  /** Relógio do remetente (ms). Informativo. */
  sentAt: number;
}

/** 'recipient': cópia que o destinatário lê. 'sender': cópia que o remetente relê enquanto a mensagem não foi lida. */
export type EnvelopeRole = 'recipient' | 'sender';

interface MessageEnvelope {
  v: 1;
  epk: string;
  n: string;
  c: string;
}

const PAD_BLOCK = 128;
export const MAX_TEXT_BYTES = 8192;

function pad(data: Bytes): Bytes {
  const body = 4 + data.length;
  const total = Math.ceil(body / PAD_BLOCK) * PAD_BLOCK;
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, data.length, false);
  out.set(data, 4);
  return out;
}

function unpad(padded: Bytes): Bytes {
  if (padded.length < 4) throw new DecryptError();
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, false);
  if (len > padded.length - 4) throw new DecryptError();
  return padded.slice(4, 4 + len);
}

function messageKey(dh1: Bytes, dh2: Bytes, epk: Bytes, authorPk: Bytes, targetPk: Bytes, role: EnvelopeRole): Bytes {
  const ikm = concatBytes(dh1, dh2);
  const key = hkdf(sha256, ikm, concatBytes(epk, authorPk, targetPk), utf8Encode(`${V}/msg/${role}`), 32);
  wipe(ikm, dh1, dh2);
  return key;
}

function messageAad(ctx: MessageContext, role: EnvelopeRole): Bytes {
  return utf8Encode(`${V}/${role}|${ctx.messageId}|${ctx.senderId}|${ctx.recipientId}`);
}

/**
 * Cifra `payload` para `targetPublicKey`, assinando implicitamente com a chave estática do autor.
 * Para a cópia do destinatário, target = chave do destinatário; para a cópia do remetente, target = própria chave.
 */
export function sealMessage(args: {
  payload: MessagePayload;
  ctx: MessageContext;
  role: EnvelopeRole;
  author: Identity;
  targetPublicKey: Bytes;
}): string {
  const { payload, ctx, role, author, targetPublicKey } = args;
  const plain = utf8Encode(JSON.stringify({ v: 1, text: payload.text, sentAt: payload.sentAt }));
  if (plain.length > MAX_TEXT_BYTES + 64) throw new Error('Mensagem muito longa');
  const eph = generateIdentity();
  const key = messageKey(
    x25519.getSharedSecret(eph.secretKey, targetPublicKey),
    x25519.getSharedSecret(author.secretKey, targetPublicKey),
    eph.publicKey,
    author.publicKey,
    targetPublicKey,
    role,
  );
  const nonce = randomBytes(24);
  const c = xchacha20poly1305(key, nonce, messageAad(ctx, role)).encrypt(pad(plain));
  wipe(key, eph.secretKey);
  const env: MessageEnvelope = { v: 1, epk: b64.encode(eph.publicKey), n: b64.encode(nonce), c: b64.encode(c) };
  return JSON.stringify(env);
}

/** Abre um envelope destinado a `self`, escrito por quem tem `authorPublicKey`. */
export function openMessage(args: {
  envelope: string;
  ctx: MessageContext;
  role: EnvelopeRole;
  self: Identity;
  authorPublicKey: Bytes;
}): MessagePayload {
  const { envelope, ctx, role, self, authorPublicKey } = args;
  let plain: Bytes;
  try {
    const env = JSON.parse(envelope) as MessageEnvelope;
    if (env.v !== 1) throw new Error('versão');
    const epk = b64.decode(env.epk);
    const key = messageKey(
      x25519.getSharedSecret(self.secretKey, epk),
      x25519.getSharedSecret(self.secretKey, authorPublicKey),
      epk,
      authorPublicKey,
      self.publicKey,
      role,
    );
    try {
      plain = unpad(xchacha20poly1305(key, b64.decode(env.n), messageAad(ctx, role)).decrypt(b64.decode(env.c)));
    } finally {
      wipe(key);
    }
  } catch {
    throw new DecryptError();
  }
  try {
    const body = JSON.parse(utf8Decode(plain)) as { v?: number; text?: unknown; sentAt?: unknown };
    if (body.v !== 1 || typeof body.text !== 'string') throw new Error('formato');
    return { text: body.text, sentAt: typeof body.sentAt === 'number' ? body.sentAt : 0 };
  } catch {
    throw new DecryptError();
  } finally {
    wipe(plain);
  }
}

// ───────────────────────── Verificação de chaves ─────────────────────────

/**
 * "Número de segurança": 12 grupos de 5 dígitos, igual para os dois lados da conversa.
 * Comparado fora do app (pessoalmente/telefone), detecta um servidor que troque chaves públicas.
 */
export function safetyNumber(publicKeyA: Bytes, publicKeyB: Bytes): string {
  const [first, second] = compareBytes(publicKeyA, publicKeyB) <= 0 ? [publicKeyA, publicKeyB] : [publicKeyB, publicKeyA];
  const digest = hkdf(sha256, concatBytes(first, second), undefined, utf8Encode(`${V}/safety`), 60);
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    let n = 0;
    for (let k = 0; k < 5; k++) n = n * 256 + digest[i * 5 + k]!;
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

function compareBytes(a: Bytes, b: Bytes): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
