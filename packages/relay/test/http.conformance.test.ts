// Contrato HTTP do relé. Roda contra o relé Node (padrão) ou contra qualquer relé em RELAY_URL (ex.: o Worker).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { b64, generateSignKeys, randomBytes, signRelayRequest, utf8Encode, type SignKeys } from '@sigilo/core/v2';
import { MAX_FRAME_BYTES } from '../src/core.js';
import { startRelay } from './harness.js';

type Relay = Awaited<ReturnType<typeof startRelay>>;
const qidOf = () => b64.encode(randomBytes(16));

describe('contrato HTTP do relé', () => {
  let relay: Relay;
  before(async () => {
    relay = await startRelay();
  });
  after(() => relay.close());

  async function call(method: string, path: string, opts: { key?: SignKeys; body?: Uint8Array; now?: number; headers?: Record<string, string> } = {}) {
    const body = opts.body ?? new Uint8Array(0);
    const headers: Record<string, string> = { ...(opts.key ? signRelayRequest(opts.key.secretKey, method, path, body, opts.now) : {}), ...opts.headers };
    if (body.length) headers['content-type'] = 'application/octet-stream';
    const res = await fetch(relay.url + path, { method, headers, body: body.length ? (body as BodyInit) : undefined });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  }

  async function createQueue() {
    const qid = qidOf();
    const key = generateSignKeys();
    const body = utf8Encode(JSON.stringify({ recvPub: b64.encode(key.publicKey) }));
    assert.equal((await call('PUT', `/q/${qid}`, { key, body })).status, 201);
    return { qid, key, body };
  }

  it('saúde e rotas desconhecidas', async () => {
    assert.deepEqual((await call('GET', '/health')).json, { ok: true });
    assert.equal((await call('GET', '/qualquer-coisa')).status, 404);
    assert.equal((await call('GET', '/q/curto/m')).status, 404);
  });

  it('criar a caixa exige provar a posse da chave; é idempotente e recusa outra chave', async () => {
    const qid = qidOf();
    const key = generateSignKeys();
    const body = utf8Encode(JSON.stringify({ recvPub: b64.encode(key.publicKey) }));
    assert.equal((await call('PUT', `/q/${qid}`, { body })).status, 401);
    assert.equal((await call('PUT', `/q/${qid}`, { key: generateSignKeys(), body })).status, 401);
    assert.equal((await call('PUT', `/q/${qid}`, { key, body })).status, 201);
    assert.equal((await call('PUT', `/q/${qid}`, { key, body })).status, 200);
    const other = generateSignKeys();
    assert.equal((await call('PUT', `/q/${qid}`, { key: other, body: utf8Encode(JSON.stringify({ recvPub: b64.encode(other.publicKey) })) })).status, 409);
    assert.equal((await call('PUT', `/q/${qidOf()}`, { key, body: utf8Encode('{"recvPub":"xx"}') })).status, 400);
  });

  it('qualquer um envia; só o dono lê e confirma; confirmar apaga', async () => {
    const { qid, key } = await createQueue();
    const f1 = randomBytes(120);
    const f2 = randomBytes(80);
    assert.equal((await call('POST', `/q/${qid}/m`, { body: f1 })).status, 201);
    assert.equal((await call('POST', `/q/${qid}/m`, { body: f2 })).status, 201);
    assert.equal((await call('GET', `/q/${qid}/m`)).status, 401);
    assert.equal((await call('GET', `/q/${qid}/m`, { key: generateSignKeys() })).status, 401);

    const msgs = ((await call('GET', `/q/${qid}/m`, { key })).json as { messages: Array<{ id: string; frame: string }> }).messages;
    assert.equal(msgs.length, 2);
    assert.deepEqual(b64.decode(msgs[0]!.frame), f1);
    assert.deepEqual(b64.decode(msgs[1]!.frame), f2);
    assert.equal(((await call('GET', `/q/${qid}/n`, { key })).json as { n: number }).n, 2);

    assert.equal((await call('DELETE', `/q/${qid}/m/${msgs[0]!.id}`)).status, 401);
    assert.equal((await call('DELETE', `/q/${qid}/m/${msgs[0]!.id}`, { key })).status, 204);
    assert.equal((await call('DELETE', `/q/${qid}/m/${msgs[0]!.id}`, { key })).status, 404);
    assert.equal(((await call('GET', `/q/${qid}/m`, { key })).json as { messages: unknown[] }).messages.length, 1);
  });

  it('a chave de uma caixa não abre outra, nem uma assinatura reaproveitada em outro caminho', async () => {
    const a = await createQueue();
    const b = await createQueue();
    await call('POST', `/q/${b.qid}/m`, { body: randomBytes(50) });
    assert.equal((await call('GET', `/q/${b.qid}/m`, { key: a.key })).status, 401);
    const stolen = signRelayRequest(a.key.secretKey, 'GET', `/q/${a.qid}/m`);
    assert.equal((await call('GET', `/q/${b.qid}/m`, { headers: stolen })).status, 401);
  });

  it('janela de tempo contra repetição; assinatura cobre o corpo', async () => {
    const { qid, key } = await createQueue();
    assert.equal((await call('GET', `/q/${qid}/m`, { key, now: Date.now() - 6 * 60_000 })).status, 401);
    assert.equal((await call('GET', `/q/${qid}/m`, { key, now: Date.now() + 6 * 60_000 })).status, 401);
    assert.equal((await call('GET', `/q/${qid}/m`, { key, now: Date.now() - 60_000 })).status, 200);

    const fresh = qidOf();
    const k = generateSignKeys();
    const real = utf8Encode(JSON.stringify({ recvPub: b64.encode(k.publicKey) }));
    const sig = signRelayRequest(k.secretKey, 'PUT', `/q/${fresh}`, real);
    const evil = generateSignKeys();
    const swapped = utf8Encode(JSON.stringify({ recvPub: b64.encode(evil.publicKey) }));
    assert.equal((await call('PUT', `/q/${fresh}`, { body: swapped, headers: sig })).status, 401);
  });

  it('limites: quadro grande demais, vazio e caixa inexistente', async () => {
    const { qid } = await createQueue();
    assert.equal((await call('POST', `/q/${qid}/m`, { body: new Uint8Array(MAX_FRAME_BYTES + 1) })).status, 413);
    assert.equal((await call('POST', `/q/${qidOf()}/m`, { body: randomBytes(20) })).status, 404);
  });

  it('o dono apaga a própria caixa', async () => {
    const { qid, key } = await createQueue();
    assert.equal((await call('DELETE', `/q/${qid}`)).status, 401);
    assert.equal((await call('DELETE', `/q/${qid}`, { key })).status, 204);
    assert.equal((await call('POST', `/q/${qid}/m`, { body: randomBytes(20) })).status, 404);
  });
});
