import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecryptError } from '../../src/crypto';
import { utf8Decode, utf8Encode } from '../../src/bytes';
import { FRAME_OVERHEAD, PayloadType, openFrame, sealFrame } from '../../src/v2/frame';
import { FRAGMENT_HEADER, Reassembler, fragment } from '../../src/v2/fragment';
import { generateBoxKeys, refOf } from '../../src/v2/keys';

const known = (...keys: Uint8Array[]) => (ref: Uint8Array) => keys.filter((k) => Buffer.from(refOf(k)).equals(Buffer.from(ref)));

test('quadro: ida e volta, remetente autenticado', () => {
  const ana = generateBoxKeys();
  const bruno = generateBoxKeys();
  const frame = sealFrame({ payload: { type: PayloadType.Chat, body: utf8Encode('Olá, Bruno 👋') }, sender: ana, recipientBox: bruno.publicKey });
  const opened = openFrame({ frame, self: bruno, knownSenders: known(ana.publicKey) });
  assert.equal(utf8Decode(opened.body), 'Olá, Bruno 👋');
  assert.equal(opened.type, PayloadType.Chat);
  assert.deepEqual(opened.sender, ana.publicKey);
});

test('quadro: sobrecarga é pequena e cabe em SMS (mensagem curta = 1 parte de 140 B)', () => {
  const ana = generateBoxKeys();
  const bruno = generateBoxKeys();
  const text = utf8Encode('Reunião 15h');
  const frame = sealFrame({ payload: { type: PayloadType.Chat, body: text }, sender: ana, recipientBox: bruno.publicKey });
  assert.equal(frame.length, FRAME_OVERHEAD + 1 + 1 + text.length);
  assert.ok(frame.length <= 140, `quadro de ${frame.length} bytes`);
  assert.equal(fragment(frame, 140).length, 1);
  // Texto mais longo vira poucas partes.
  const long = sealFrame({ payload: { type: PayloadType.Chat, body: utf8Encode('x'.repeat(300)) }, sender: ana, recipientBox: bruno.publicKey });
  assert.equal(fragment(long, 140).length, Math.ceil(long.length / (140 - FRAGMENT_HEADER)));
});

test('quadro: o relé não vê texto nem a identidade do remetente (nada se repete entre quadros)', () => {
  const ana = generateBoxKeys();
  const bruno = generateBoxKeys();
  const mk = () => sealFrame({ payload: { type: PayloadType.Chat, body: utf8Encode('segredo-xyz') }, sender: ana, recipientBox: bruno.publicKey });
  const a = mk();
  const b = mk();
  assert.ok(!Buffer.from(a).includes(Buffer.from('segredo-xyz')));
  assert.ok(!Buffer.from(a).includes(Buffer.from(refOf(ana.publicKey))), 'a referência do remetente aparece em claro');
  assert.ok(!Buffer.from(a).includes(Buffer.from(ana.publicKey)));
  // Nenhum trecho de 8 bytes depois do cabeçalho se repete entre dois quadros iguais: não há pseudônimo estável.
  const shared = [];
  for (let i = 1; i + 8 <= a.length; i++) if (Buffer.from(b).includes(Buffer.from(a.slice(i, i + 8)))) shared.push(i);
  assert.deepEqual(shared, []);
});

test('quadro: só o destinatário abre', () => {
  const ana = generateBoxKeys();
  const bruno = generateBoxKeys();
  const eve = generateBoxKeys();
  const frame = sealFrame({ payload: { type: PayloadType.Chat, body: utf8Encode('oi') }, sender: ana, recipientBox: bruno.publicKey });
  assert.throws(() => openFrame({ frame, self: eve, knownSenders: known(ana.publicKey) }), DecryptError);
  // Nem a própria remetente (a efêmera foi descartada).
  assert.throws(() => openFrame({ frame, self: ana, knownSenders: known(ana.publicKey) }), DecryptError);
});

test('quadro: Eve não consegue se passar por Ana nem trocar a identidade do remetente', () => {
  const ana = generateBoxKeys();
  const bruno = generateBoxKeys();
  const eve = generateBoxKeys();
  // Eve cifra para Bruno usando a própria chave, mas Bruno só conhece Ana.
  const forged = sealFrame({ payload: { type: PayloadType.Chat, body: utf8Encode('sou a Ana') }, sender: eve, recipientBox: bruno.publicKey });
  assert.throws(() => openFrame({ frame: forged, self: bruno, knownSenders: known(ana.publicKey) }), DecryptError);
  // Mesmo que Bruno conheça as duas, o mac aponta Eve, não Ana.
  const opened = openFrame({ frame: forged, self: bruno, knownSenders: known(ana.publicKey, eve.publicKey) });
  assert.deepEqual(opened.sender, eve.publicKey);
  assert.notDeepEqual(opened.sender, ana.publicKey);
});

test('quadro: qualquer alteração é detectada, inclusive na versão e no cabeçalho', () => {
  const ana = generateBoxKeys();
  const bruno = generateBoxKeys();
  const frame = sealFrame({ payload: { type: PayloadType.Chat, body: utf8Encode('intacta') }, sender: ana, recipientBox: bruno.publicKey });
  for (const i of [0, 1, 20, 33, 40, 60, frame.length - 1]) {
    const copy = frame.slice();
    copy[i] = copy[i]! ^ 1;
    assert.throws(() => openFrame({ frame: copy, self: bruno, knownSenders: known(ana.publicKey) }), DecryptError, `byte ${i}`);
  }
  assert.throws(() => openFrame({ frame: frame.slice(0, 40), self: bruno, knownSenders: known(ana.publicKey) }), DecryptError);
});

test('quadro: primeiro contato leva a chave do remetente junto e ainda é autenticado', () => {
  const ana = generateBoxKeys();
  const bruno = generateBoxKeys();
  const frame = sealFrame({
    payload: { type: PayloadType.Intro, body: utf8Encode('{"cert":1}'), senderKey: ana.publicKey },
    sender: ana,
    recipientBox: bruno.publicKey,
  });
  const opened = openFrame({ frame, self: bruno, knownSenders: () => [] });
  assert.deepEqual(opened.sender, ana.publicKey);
  // Uma chave embutida que não bate com quem de fato assinou é recusada.
  const eve = generateBoxKeys();
  const lie = sealFrame({ payload: { type: PayloadType.Intro, body: utf8Encode('x'), senderKey: ana.publicKey }, sender: eve, recipientBox: bruno.publicKey });
  assert.throws(() => openFrame({ frame: lie, self: bruno, knownSenders: () => [] }), DecryptError);
});

test('quadro: preenchimento esconde o comprimento exato', () => {
  const ana = generateBoxKeys();
  const bruno = generateBoxKeys();
  const size = (t: string) => sealFrame({ payload: { type: PayloadType.Chat, body: utf8Encode(t) }, sender: ana, recipientBox: bruno.publicKey, padTo: 128 }).length;
  assert.equal(size('oi'), size('uma mensagem um pouco mais comprida que a outra'));
  const frame = sealFrame({ payload: { type: PayloadType.Chat, body: utf8Encode('com padding') }, sender: ana, recipientBox: bruno.publicKey, padTo: 128 });
  assert.equal(utf8Decode(openFrame({ frame, self: bruno, knownSenders: known(ana.publicKey) }).body), 'com padding');
});

test('fragmentação: junta fora de ordem, ignora repetidas e descarta incompletas', () => {
  const ana = generateBoxKeys();
  const bruno = generateBoxKeys();
  const frame = sealFrame({ payload: { type: PayloadType.Chat, body: utf8Encode('y'.repeat(500)) }, sender: ana, recipientBox: bruno.publicKey });
  const parts = fragment(frame, 100);
  assert.ok(parts.length > 4);
  const shuffled = [...parts].reverse();
  const r = new Reassembler();
  let done: Uint8Array | undefined;
  for (const p of [shuffled[0]!, shuffled[0]!, ...shuffled.slice(1)]) done = r.push(p) ?? done;
  assert.deepEqual(done, frame);
  assert.equal(r.incomplete, 0);
  assert.equal(utf8Decode(openFrame({ frame: done!, self: bruno, knownSenders: known(ana.publicKey) }).body), 'y'.repeat(500));

  // Faltando uma parte: nunca completa; vence pelo tempo.
  let t = 0;
  const r2 = new Reassembler(1000, () => t);
  for (const p of parts.slice(1)) assert.equal(r2.push(p), undefined);
  assert.equal(r2.incomplete, 1);
  t = 5000;
  r2.push(new Uint8Array(0));
  assert.equal(r2.push(parts[0]!), undefined, 'parte atrasada de um quadro já descartado não completa');
  assert.throws(() => fragment(frame, 5), /pequeno/);
});
