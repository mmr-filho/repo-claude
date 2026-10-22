import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoTransportError, TransportManager, type PeerAddress, type Transport, type TransportId } from '../../src/v2/transport';

function fake(id: TransportId, rank: number, o: { reach?: boolean; fail?: boolean; carrier?: boolean; available?: boolean; log: string[]; padTo?: number }): Transport {
  return {
    id,
    privacyRank: rank,
    leavesCarrierRecord: o.carrier,
    padTo: o.padTo ?? 0,
    isAvailable: async () => o.available ?? true,
    canReach: () => o.reach ?? true,
    send: async (_p: PeerAddress, frame: Uint8Array) => {
      o.log.push(`${id}:${frame.length}`);
      if (o.fail) throw new Error('falhou');
    },
  };
}

const peer: PeerAddress = { box: 'contato' };
const build = (padTo: number) => new Uint8Array(padTo === 0 ? 50 : 128);

test('o meio mais privado vai primeiro: proximidade > relé > SMS', async () => {
  const log: string[] = [];
  const m = new TransportManager(
    [fake('sms', 3, { log, carrier: true }), fake('relay', 2, { log, padTo: 128 }), fake('proximity', 1, { log })],
    () => true,
  );
  assert.deepEqual(m.ids, ['proximity', 'relay', 'sms']);
  const r = await m.send(peer, build);
  assert.equal(r.via, 'proximity');
  assert.deepEqual(log, ['proximity:50']);
});

test('cai para o próximo meio quando o anterior falha ou está indisponível, e registra o motivo', async () => {
  const log: string[] = [];
  const m = new TransportManager(
    [fake('proximity', 1, { log, available: false }), fake('relay', 2, { log, fail: true, padTo: 128 }), fake('sms', 3, { log, carrier: true })],
    () => true,
  );
  const r = await m.send(peer, build);
  assert.equal(r.via, 'sms');
  assert.deepEqual(r.failed.map((f) => f.id), ['proximity', 'relay']);
  assert.deepEqual(log, ['relay:128', 'sms:50'], 'cada meio recebe o quadro no tamanho que quer');
});

test('SMS não é usado sem permissão do contato; o erro diz que falta consentimento', async () => {
  const log: string[] = [];
  const m = new TransportManager([fake('relay', 2, { log, fail: true }), fake('sms', 3, { log, carrier: true })], () => false);
  await assert.rejects(
    () => m.send(peer, build),
    (e: unknown) => e instanceof NoTransportError && e.needsConsent === 'sms' && e.failed.length === 1,
  );
  assert.deepEqual(log, ['relay:50'], 'o SMS não chegou a ser tentado');
});

test('permissão é por contato', async () => {
  const log: string[] = [];
  const m = new TransportManager([fake('relay', 2, { log, fail: true }), fake('sms', 3, { log, carrier: true })], (box) => box === 'liberado');
  assert.equal((await m.send({ box: 'liberado' }, build)).via, 'sms');
  await assert.rejects(() => m.send({ box: 'outro' }, build), NoTransportError);
});

test('meio que não alcança o contato é ignorado; sem nenhum meio, o erro é claro', async () => {
  const log: string[] = [];
  const m = new TransportManager([fake('relay', 2, { log, reach: false })], () => true);
  await assert.rejects(
    () => m.send(peer, build),
    (e: unknown) => e instanceof NoTransportError && e.needsConsent === undefined && /Nenhum meio/.test(e.message),
  );
});

test('SMS indisponível no aparelho (iPhone) não gera pedido de permissão', async () => {
  const log: string[] = [];
  const m = new TransportManager([fake('relay', 2, { log, fail: true }), fake('sms', 3, { log, carrier: true, available: false })], () => false);
  await assert.rejects(() => m.send(peer, build), (e: unknown) => e instanceof NoTransportError && e.needsConsent === undefined);
});
