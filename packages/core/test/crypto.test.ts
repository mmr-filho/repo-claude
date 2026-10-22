import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DecryptError,
  WrongPasswordError,
  assertKdfParams,
  deriveAccountKeys,
  generateIdentity,
  newKdfSalt,
  openMessage,
  safetyNumber,
  sealMessage,
  unwrapSecretKey,
  wrapSecretKey,
  type KdfParams,
} from '../src/crypto';
import { b64, randomBytes, randomUuid, utf8Decode, utf8Encode } from '../src/bytes';

const FAST: KdfParams = { alg: 'scrypt', N: 1024, r: 8, p: 1 };
const FAST_POLICY = { minN: 1024, maxN: 2 ** 20 };

test('utf8 próprio equivale a TextEncoder/TextDecoder, inclusive emoji', () => {
  const samples = ['', 'olá, mundo', 'ação ✓ 日本語', '😀👩‍👩‍👧 emoji', 'a\u0000b'];
  for (const s of samples) {
    assert.deepEqual(utf8Encode(s), new TextEncoder().encode(s));
    assert.equal(utf8Decode(utf8Encode(s)), s);
  }
  const garbage = Uint8Array.from([0xff, 0xc3, 0x28, 0xe2, 0x82]);
  assert.equal(utf8Decode(garbage), new TextDecoder().decode(garbage));
});

test('randomUuid tem formato v4 e não repete', () => {
  const a = randomUuid();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, randomUuid());
});

test('KDF: mesma senha+salt => mesmas chaves; senha ou salt diferentes => chaves diferentes', async () => {
  const salt = newKdfSalt();
  const a = await deriveAccountKeys('correct horse', salt, FAST, FAST_POLICY);
  const b = await deriveAccountKeys('correct horse', salt, FAST, FAST_POLICY);
  const c = await deriveAccountKeys('correct horse!', salt, FAST, FAST_POLICY);
  const d = await deriveAccountKeys('correct horse', newKdfSalt(), FAST, FAST_POLICY);
  assert.deepEqual(a.kek, b.kek);
  assert.equal(a.authSecret, b.authSecret);
  assert.notDeepEqual(a.kek, c.kek);
  assert.notEqual(a.authSecret, d.authSecret);
  // A prova de senha não pode ser a própria KEK.
  assert.notEqual(a.authSecret, b64.encode(a.kek));
});

test('KDF: normalização NFKC torna equivalentes as formas compostas e decompostas', async () => {
  const salt = newKdfSalt();
  const composed = await deriveAccountKeys('ação', salt, FAST, FAST_POLICY);
  const decomposed = await deriveAccountKeys('ação'.normalize('NFD'), salt, FAST, FAST_POLICY);
  assert.equal(composed.authSecret, decomposed.authSecret);
});

test('KDF: política recusa parâmetros fracos, absurdos ou inválidos vindos do servidor', () => {
  assert.throws(() => assertKdfParams({ alg: 'scrypt', N: 1024, r: 8, p: 1 }));
  assert.throws(() => assertKdfParams({ alg: 'scrypt', N: 2 ** 15 + 1, r: 8, p: 1 }));
  assert.throws(() => assertKdfParams({ alg: 'scrypt', N: 2 ** 30, r: 8, p: 1 }));
  assert.throws(() => assertKdfParams({ alg: 'scrypt', N: 2 ** 15, r: 1, p: 1 }));
  assert.doesNotThrow(() => assertKdfParams({ alg: 'scrypt', N: 2 ** 15, r: 8, p: 1 }));
});

test('chave privada embrulhada só abre com a KEK certa', async () => {
  const id = generateIdentity();
  const salt = newKdfSalt();
  const right = await deriveAccountKeys('senha-certa', salt, FAST, FAST_POLICY);
  const wrong = await deriveAccountKeys('senha-errada', salt, FAST, FAST_POLICY);
  const wrapped = wrapSecretKey(right.kek, id);
  const pub = b64.encode(id.publicKey);

  const opened = unwrapSecretKey(right.kek, pub, wrapped);
  assert.deepEqual(opened.secretKey, id.secretKey);
  assert.throws(() => unwrapSecretKey(wrong.kek, pub, wrapped), WrongPasswordError);
  // Trocar a chave pública anunciada também invalida o envelope (AAD).
  assert.throws(() => unwrapSecretKey(right.kek, b64.encode(generateIdentity().publicKey), wrapped), WrongPasswordError);
  assert.throws(() => unwrapSecretKey(right.kek, pub, 'lixo'), WrongPasswordError);
});

function pair() {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const ctx = { messageId: randomUuid(), senderId: 'alice', recipientId: 'bob' };
  return { alice, bob, ctx };
}

test('mensagem: destinatário e remetente leem as respectivas cópias', () => {
  const { alice, bob, ctx } = pair();
  const payload = { text: 'Olá, Bob 👋', sentAt: 1_700_000_000_000 };
  const forBob = sealMessage({ payload, ctx, role: 'recipient', author: alice, targetPublicKey: bob.publicKey });
  const forAlice = sealMessage({ payload, ctx, role: 'sender', author: alice, targetPublicKey: alice.publicKey });

  assert.deepEqual(openMessage({ envelope: forBob, ctx, role: 'recipient', self: bob, authorPublicKey: alice.publicKey }), payload);
  assert.deepEqual(openMessage({ envelope: forAlice, ctx, role: 'sender', self: alice, authorPublicKey: alice.publicKey }), payload);
});

test('mensagem: o envelope não contém o texto em claro e cada cifragem é diferente', () => {
  const { alice, bob, ctx } = pair();
  const payload = { text: 'segredo-super-especifico', sentAt: 1 };
  const a = sealMessage({ payload, ctx, role: 'recipient', author: alice, targetPublicKey: bob.publicKey });
  const b = sealMessage({ payload, ctx, role: 'recipient', author: alice, targetPublicKey: bob.publicKey });
  assert.ok(!a.includes('segredo'));
  assert.notEqual(a, b);
});

test('mensagem: terceiros, remetente que não é o autor e a cópia do remetente não abrem o envelope do destinatário', () => {
  const { alice, bob, ctx } = pair();
  const eve = generateIdentity();
  const payload = { text: 'x', sentAt: 1 };
  const env = sealMessage({ payload, ctx, role: 'recipient', author: alice, targetPublicKey: bob.publicKey });

  assert.throws(() => openMessage({ envelope: env, ctx, role: 'recipient', self: eve, authorPublicKey: alice.publicKey }), DecryptError);
  // Bob acreditando que quem escreveu foi Eve (autor forjado): falha.
  assert.throws(() => openMessage({ envelope: env, ctx, role: 'recipient', self: bob, authorPublicKey: eve.publicKey }), DecryptError);
  // Papel trocado.
  assert.throws(() => openMessage({ envelope: env, ctx, role: 'sender', self: bob, authorPublicKey: alice.publicKey }), DecryptError);
});

test('mensagem: autenticidade do remetente — Eve não consegue se passar por Alice', () => {
  const { alice, bob, ctx } = pair();
  const eve = generateIdentity();
  // Eve conhece a chave pública de Bob e cifra "como se fosse" Alice, usando a própria chave estática.
  const forged = sealMessage({ payload: { text: 'sou a Alice', sentAt: 1 }, ctx, role: 'recipient', author: eve, targetPublicKey: bob.publicKey });
  assert.throws(() => openMessage({ envelope: forged, ctx, role: 'recipient', self: bob, authorPublicKey: alice.publicKey }), DecryptError);
});

test('mensagem: ids no contexto são autenticados (reencaminhamento/troca de remetente falham)', () => {
  const { alice, bob, ctx } = pair();
  const env = sealMessage({ payload: { text: 'x', sentAt: 1 }, ctx, role: 'recipient', author: alice, targetPublicKey: bob.publicKey });
  for (const tampered of [
    { ...ctx, messageId: randomUuid() },
    { ...ctx, senderId: 'carol' },
    { ...ctx, recipientId: 'dave' },
  ]) {
    assert.throws(() => openMessage({ envelope: env, ctx: tampered, role: 'recipient', self: bob, authorPublicKey: alice.publicKey }), DecryptError);
  }
});

test('mensagem: qualquer alteração no envelope é detectada', () => {
  const { alice, bob, ctx } = pair();
  const env = JSON.parse(sealMessage({ payload: { text: 'x', sentAt: 1 }, ctx, role: 'recipient', author: alice, targetPublicKey: bob.publicKey }));
  for (const field of ['epk', 'n', 'c'] as const) {
    const bytes = b64.decode(env[field]);
    bytes[0] = bytes[0]! ^ 1;
    const bad = JSON.stringify({ ...env, [field]: b64.encode(bytes) });
    assert.throws(() => openMessage({ envelope: bad, ctx, role: 'recipient', self: bob, authorPublicKey: alice.publicKey }), DecryptError, field);
  }
  assert.throws(() => openMessage({ envelope: '{}', ctx, role: 'recipient', self: bob, authorPublicKey: alice.publicKey }), DecryptError);
});

test('mensagem: preenchimento esconde o tamanho exato e o texto longo faz ida e volta', () => {
  const { alice, bob, ctx } = pair();
  const size = (text: string) => b64.decode(JSON.parse(sealMessage({ payload: { text, sentAt: 1 }, ctx, role: 'recipient', author: alice, targetPublicKey: bob.publicKey })).c).length;
  assert.equal(size('oi'), size('oi, tudo bem com você?'));
  const long = 'ã'.repeat(3000);
  const env = sealMessage({ payload: { text: long, sentAt: 1 }, ctx, role: 'recipient', author: alice, targetPublicKey: bob.publicKey });
  assert.equal(openMessage({ envelope: env, ctx, role: 'recipient', self: bob, authorPublicKey: alice.publicKey }).text, long);
  assert.throws(() => sealMessage({ payload: { text: 'a'.repeat(9000), sentAt: 1 }, ctx, role: 'recipient', author: alice, targetPublicKey: bob.publicKey }), /muito longa/);
});

test('número de segurança é simétrico, estável e muda com a chave', () => {
  const a = generateIdentity().publicKey;
  const b = generateIdentity().publicKey;
  assert.equal(safetyNumber(a, b), safetyNumber(b, a));
  assert.match(safetyNumber(a, b), /^(\d{5} ){11}\d{5}$/);
  assert.notEqual(safetyNumber(a, b), safetyNumber(a, generateIdentity().publicKey));
  assert.equal(randomBytes(32).length, 32);
});
