import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { b64, randomBytes, utf8Encode } from '@sigilo/core';
import { generateSignKeys, signRelayRequest, type SignKeys } from '@sigilo/core/v2';
import { MAX_FRAME_BYTES, MAX_QUEUE_MESSAGES } from '../src/core.js';
import { buildRelay } from '../src/node-server.js';

type Relay = Awaited<ReturnType<typeof buildRelay>>;

const qidOf = () => b64.encode(randomBytes(16));

async function call(relay: Relay, method: string, path: string, opts: { key?: SignKeys; body?: Uint8Array; now?: number } = {}) {
  const body = opts.body ?? new Uint8Array(0);
  const headers: Record<string, string> = opts.key ? signRelayRequest(opts.key.secretKey, method, path, body, opts.now) : {};
  if (body.length) headers['content-type'] = 'application/octet-stream';
  const res = await relay.app.inject({ method: method as 'GET', url: path, headers, payload: body.length ? Buffer.from(body) : undefined });
  return { status: res.statusCode, json: res.body ? (res.headers['content-type']?.toString().includes('json') ? res.json() : undefined) : undefined };
}

async function createQueue(relay: Relay, qid = qidOf()) {
  const key = generateSignKeys();
  const body = utf8Encode(JSON.stringify({ recvPub: b64.encode(key.publicKey) }));
  const r = await call(relay, 'PUT', `/q/${qid}`, { key, body });
  assert.equal(r.status, 201);
  return { qid, key };
}

const frame = (n = 100) => randomBytes(n);

describe('relé anônimo', () => {
  let relay: Relay;
  before(async () => {
    relay = await buildRelay({ dbPath: ':memory:', rateLimit: false });
  });
  after(() => relay.app.close());

  it('criar caixa exige provar posse da chave; recriar com outra chave é recusado', async () => {
    const qid = qidOf();
    const key = generateSignKeys();
    const body = utf8Encode(JSON.stringify({ recvPub: b64.encode(key.publicKey) }));

    // Sem assinatura / assinatura de outra chave: recusado.
    assert.equal((await call(relay, 'PUT', `/q/${qid}`, { body })).status, 401);
    assert.equal((await call(relay, 'PUT', `/q/${qid}`, { key: generateSignKeys(), body })).status, 401);
    assert.equal((await call(relay, 'PUT', `/q/${qid}`, { key, body })).status, 201);
    // Idempotente com a mesma chave; conflito com outra.
    assert.equal((await call(relay, 'PUT', `/q/${qid}`, { key, body })).status, 200);
    const other = generateSignKeys();
    const otherBody = utf8Encode(JSON.stringify({ recvPub: b64.encode(other.publicKey) }));
    assert.equal((await call(relay, 'PUT', `/q/${qid}`, { key: other, body: otherBody })).status, 409);
    // Ids malformados e chaves inválidas.
    assert.equal((await call(relay, 'PUT', '/q/curto', { key, body })).status, 404);
    assert.equal((await call(relay, 'PUT', `/q/${qidOf()}`, { key, body: utf8Encode('{"recvPub":"xx"}') })).status, 400);
  });

  it('qualquer um envia, só o dono (assinatura) lê e confirma; confirmar apaga', async () => {
    const { qid, key } = await createQueue(relay);
    const f1 = frame(120);
    const f2 = frame(80);
    assert.equal((await call(relay, 'POST', `/q/${qid}/m`, { body: f1 })).status, 201);
    assert.equal((await call(relay, 'POST', `/q/${qid}/m`, { body: f2 })).status, 201);

    // Sem assinatura, com chave alheia: nada de ler.
    assert.equal((await call(relay, 'GET', `/q/${qid}/m`)).status, 401);
    assert.equal((await call(relay, 'GET', `/q/${qid}/m`, { key: generateSignKeys() })).status, 401);

    const listed = await call(relay, 'GET', `/q/${qid}/m`, { key });
    assert.equal(listed.status, 200);
    const msgs = (listed.json as { messages: Array<{ id: string; frame: string }> }).messages;
    assert.equal(msgs.length, 2);
    assert.deepEqual(b64.decode(msgs[0]!.frame), f1);
    assert.deepEqual(b64.decode(msgs[1]!.frame), f2);
    assert.equal(((await call(relay, 'GET', `/q/${qid}/n`, { key })).json as { n: number }).n, 2);

    assert.equal((await call(relay, 'DELETE', `/q/${qid}/m/${msgs[0]!.id}`)).status, 401);
    assert.equal((await call(relay, 'DELETE', `/q/${qid}/m/${msgs[0]!.id}`, { key })).status, 204);
    assert.equal((await call(relay, 'DELETE', `/q/${qid}/m/${msgs[0]!.id}`, { key })).status, 404);
    const after = (await call(relay, 'GET', `/q/${qid}/m`, { key })).json as { messages: unknown[] };
    assert.equal(after.messages.length, 1);
    // Realmente apagado do banco (nada de cópia).
    assert.equal(Number((relay.store.db.prepare('SELECT COUNT(*) AS n FROM msgs WHERE qid = ?').get(qid) as { n: number }).n), 1);
  });

  it('a chave de uma caixa não abre outra caixa', async () => {
    const a = await createQueue(relay);
    const b = await createQueue(relay);
    await call(relay, 'POST', `/q/${b.qid}/m`, { body: frame() });
    assert.equal((await call(relay, 'GET', `/q/${b.qid}/m`, { key: a.key })).status, 401);
    // Assinatura feita para o caminho de A reutilizada no caminho de B também falha.
    const headers = signRelayRequest(a.key.secretKey, 'GET', `/q/${a.qid}/m`);
    const res = await relay.app.inject({ method: 'GET', url: `/q/${b.qid}/m`, headers });
    assert.equal(res.statusCode, 401);
  });

  it('pedido assinado vencido (ou do futuro) é recusado: janela anti-repetição', async () => {
    const { qid, key } = await createQueue(relay);
    assert.equal((await call(relay, 'GET', `/q/${qid}/m`, { key, now: Date.now() - 6 * 60_000 })).status, 401);
    assert.equal((await call(relay, 'GET', `/q/${qid}/m`, { key, now: Date.now() + 6 * 60_000 })).status, 401);
    assert.equal((await call(relay, 'GET', `/q/${qid}/m`, { key, now: Date.now() - 60_000 })).status, 200);
  });

  it('assinatura cobre o corpo: não dá para trocar o conteúdo de um pedido assinado', async () => {
    const qid = qidOf();
    const key = generateSignKeys();
    const real = utf8Encode(JSON.stringify({ recvPub: b64.encode(key.publicKey) }));
    const headers = signRelayRequest(key.secretKey, 'PUT', `/q/${qid}`, real);
    const evil = generateSignKeys();
    const res = await relay.app.inject({
      method: 'PUT',
      url: `/q/${qid}`,
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from(utf8Encode(JSON.stringify({ recvPub: b64.encode(evil.publicKey) }))),
    });
    assert.equal(res.statusCode, 401);
  });

  it('limites: tamanho do quadro, caixa cheia, caixa inexistente', async () => {
    const { qid } = await createQueue(relay);
    assert.equal((await call(relay, 'POST', `/q/${qid}/m`, { body: new Uint8Array(MAX_FRAME_BYTES + 1) })).status, 413);
    assert.equal((await call(relay, 'POST', `/q/${qidOf()}/m`, { body: frame() })).status, 404);
    for (let i = 0; i < MAX_QUEUE_MESSAGES; i++) relay.store.queue(qid).push({ id: `x${i}`, ts: Date.now(), frame: frame(10) }, Date.now() + 1e9);
    assert.equal((await call(relay, 'POST', `/q/${qid}/m`, { body: frame() })).status, 429);
  });

  it('mensagens vencidas e caixas abandonadas são apagadas', async () => {
    const { qid, key } = await createQueue(relay);
    await call(relay, 'POST', `/q/${qid}/m`, { body: frame() });
    const day = 24 * 60 * 60 * 1000;
    assert.deepEqual(relay.store.purge(Date.now() + 1000, 60 * day), { messages: 0, queues: 0 });
    const purged = relay.store.purge(Date.now() + 8 * day, 60 * day);
    assert.ok(purged.messages >= 1);
    assert.equal(((await call(relay, 'GET', `/q/${qid}/m`, { key })).json as { messages: unknown[] }).messages.length, 0);
    // Caixa sem uso por muito tempo some; então ela deixa de existir.
    assert.ok(relay.store.purge(Date.now() + 100 * day, 60 * day).queues >= 1);
    assert.equal((await call(relay, 'GET', `/q/${qid}/m`, { key })).status, 404);
  });

  it('dono pode apagar a própria caixa', async () => {
    const { qid, key } = await createQueue(relay);
    assert.equal((await call(relay, 'DELETE', `/q/${qid}`)).status, 401);
    assert.equal((await call(relay, 'DELETE', `/q/${qid}`, { key })).status, 204);
    assert.equal((await call(relay, 'POST', `/q/${qid}/m`, { body: frame() })).status, 404);
  });

  it('o relé não guarda nenhum identificador do remetente (colunas e logs)', () => {
    const cols = (relay.store.db.prepare("SELECT name FROM pragma_table_info('msgs')").all() as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(cols.sort(), ['expires_at', 'frame', 'id', 'qid', 'ts']);
  });
});
