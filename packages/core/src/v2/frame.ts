import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { DecryptError } from '../crypto';
import { randomBytes, utf8Encode, wipe, type Bytes } from '../bytes';
import { generateBoxKeys, refOf, type BoxKeys } from './keys';
import { concatBytes, equalBytes, varintDecode, varintEncode } from './wire';

/*
 * Quadro (frame) cifrado do Sigilo v2. Cabe em SMS e em Bluetooth, e o relé não aprende quem enviou.
 *
 *   frame = versão(1) ‖ epk(32) ‖ AEAD_k1( refRemetente(8) ‖ carga ‖ mac(16) )
 *
 *   k1  = HKDF( X25519(efêmera, destinatário) )                    → só o destinatário abre ("sealed sender")
 *   mac = HMAC( HKDF( X25519(remetente_estático, destinatário) ) ) → prova quem enviou (negável, como no v1)
 *
 * Sobrecarga fixa: 73 bytes. O nonce e a chave saem do mesmo HKDF (cada mensagem tem chave efêmera nova).
 */

export const FRAME_VERSION = 2;
const V = 'sigilo/v2';
export const FRAME_OVERHEAD = 1 + 32 + 16 + 8 + 16;

export const PayloadType = {
  Chat: 1,
  Intro: 2,
  Receipt: 3,
  Recall: 4,
  Roster: 5,
  EnrollRequest: 6,
  EnrollResponse: 7,
  RenewRequest: 8,
  LinkProposal: 9,
  LinkAccepted: 10,
} as const;
export type PayloadType = (typeof PayloadType)[keyof typeof PayloadType];

/** Bit que indica "a chave pública do remetente vem junto" (primeiro contato / pedido de entrada). */
const FLAG_SENDER_KEY = 0x80;

export interface Payload {
  type: PayloadType;
  body: Bytes;
  /** Chave de cifra do remetente, enviada junto quando o destinatário ainda não o conhece. */
  senderKey?: Bytes;
}

export interface OpenedFrame extends Payload {
  /** Chave (box) do remetente, já autenticada pelo mac. */
  sender: Bytes;
}

function encodePayload(p: Payload, padTo: number): Bytes {
  const flag = p.senderKey ? FLAG_SENDER_KEY : 0;
  const head = concatBytes(Uint8Array.of(p.type | flag), p.senderKey ?? new Uint8Array(0), varintEncode(p.body.length));
  const raw = concatBytes(head, p.body);
  if (padTo <= 0) return raw;
  const total = Math.ceil(raw.length / padTo) * padTo;
  const out = new Uint8Array(total);
  out.set(raw);
  return out;
}

function decodePayload(buf: Bytes): { type: PayloadType; senderKey?: Bytes; body: Bytes } {
  const first = buf[0];
  if (first === undefined) throw new DecryptError();
  const hasKey = (first & FLAG_SENDER_KEY) !== 0;
  const type = (first & ~FLAG_SENDER_KEY) as PayloadType;
  let off = 1;
  let senderKey: Bytes | undefined;
  if (hasKey) {
    senderKey = buf.slice(off, off + 32);
    if (senderKey.length !== 32) throw new DecryptError();
    off += 32;
  }
  const { value: len, next } = varintDecode(buf, off);
  const body = buf.slice(next, next + len);
  if (body.length !== len) throw new DecryptError();
  return { type, senderKey, body };
}

function outerKey(dh1: Bytes, epk: Bytes, rcptPub: Bytes): { key: Bytes; nonce: Bytes } {
  const okm = hkdf(sha256, dh1, concatBytes(epk, rcptPub), utf8Encode(`${V}/outer`), 44);
  return { key: okm.slice(0, 32), nonce: okm.slice(32, 44) };
}

function authMac(dh2: Bytes, epk: Bytes, senderPub: Bytes, rcptPub: Bytes, payload: Bytes): Bytes {
  const k = hkdf(sha256, dh2, concatBytes(epk, senderPub, rcptPub), utf8Encode(`${V}/auth`), 32);
  const tag = hmac(sha256, k, concatBytes(epk, payload)).slice(0, 16);
  wipe(k);
  return tag;
}

const aad = (rcptPub: Bytes) => concatBytes(Uint8Array.of(FRAME_VERSION), refOf(rcptPub));

/**
 * Cifra `payload` para `recipientBox`. `padTo` > 0 arredonda a carga para múltiplos desse tamanho
 * (esconde o comprimento no relé; no SMS use 0 para caber).
 */
export function sealFrame(args: { payload: Payload; sender: BoxKeys; recipientBox: Bytes; padTo?: number }): Bytes {
  const { sender, recipientBox } = args;
  const eph = generateBoxKeys();
  const payload = encodePayload(args.payload, args.padTo ?? 0);
  const dh1 = x25519.getSharedSecret(eph.secretKey, recipientBox);
  const dh2 = x25519.getSharedSecret(sender.secretKey, recipientBox);
  const mac = authMac(dh2, eph.publicKey, sender.publicKey, recipientBox, payload);
  const { key, nonce } = outerKey(dh1, eph.publicKey, recipientBox);
  const inner = concatBytes(refOf(sender.publicKey), payload, mac);
  const sealed = chacha20poly1305(key, nonce, aad(recipientBox)).encrypt(inner);
  wipe(key, dh1, dh2, eph.secretKey);
  return concatBytes(Uint8Array.of(FRAME_VERSION), eph.publicKey, sealed);
}

/**
 * Abre um quadro destinado a `self`. `knownSenders` devolve as chaves candidatas para uma referência de
 * remetente; se o remetente se apresentou junto (primeiro contato) a chave embutida é usada. Em qualquer caso
 * o mac precisa conferir, ou o quadro é recusado.
 */
export function openFrame(args: { frame: Bytes; self: BoxKeys; knownSenders: (ref: Bytes) => Bytes[] }): OpenedFrame {
  const { frame, self } = args;
  try {
    if (frame.length < FRAME_OVERHEAD + 2 || frame[0] !== FRAME_VERSION) throw new Error('versão');
    const epk = frame.slice(1, 33);
    const dh1 = x25519.getSharedSecret(self.secretKey, epk);
    const { key, nonce } = outerKey(dh1, epk, self.publicKey);
    let inner: Bytes;
    try {
      inner = chacha20poly1305(key, nonce, aad(self.publicKey)).decrypt(frame.slice(33));
    } finally {
      wipe(key, dh1);
    }
    const ref = inner.slice(0, 8);
    const mac = inner.slice(inner.length - 16);
    const payloadBytes = inner.slice(8, inner.length - 16);
    const p = decodePayload(payloadBytes);

    const candidates = p.senderKey ? [p.senderKey] : args.knownSenders(ref);
    for (const cand of candidates) {
      if (!equalBytes(refOf(cand), ref)) continue;
      const dh2 = x25519.getSharedSecret(self.secretKey, cand);
      const expected = authMac(dh2, epk, cand, self.publicKey, payloadBytes);
      wipe(dh2);
      if (equalBytes(expected, mac)) return { type: p.type, body: p.body, senderKey: p.senderKey, sender: cand };
    }
    throw new Error('remetente não autenticado');
  } catch {
    throw new DecryptError();
  }
}

/** Gera 8 bytes aleatórios para identificar uma mensagem. */
export const newMessageId = (): Bytes => randomBytes(8);
