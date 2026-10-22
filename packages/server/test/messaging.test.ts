import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, KeyChangedError, LockedError, WrongPasswordError, type SigiloSession } from '@sigilo/core';
import { startServer, watch } from './harness.js';

describe('mensagens: bloqueio por senha e apagamento após a leitura', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let alice: SigiloSession;
  let bob: SigiloSession;
  let bobPassword: string;

  before(async () => {
    srv = await startServer();
    const net = await srv.network('unirg');
    const a = await srv.member(net.admin, 'alice', 'alice-senha-forte');
    const b = await srv.member(net.admin, 'bob', 'bob-senha-forte');
    alice = a.session;
    bob = b.session;
    bobPassword = b.password;
  });
  after(() => srv.close());

  it('o texto enviado nunca é gravado em claro no servidor', async () => {
    const secret = 'palavra-secreta-xyzzy-12345';
    const bobId = bob.user.id;
    await alice.send(bobId, secret);

    const dump = JSON.stringify({
      messages: srv.ctx.db.prepare('SELECT * FROM messages').all(),
      users: srv.ctx.db.prepare('SELECT * FROM users').all(),
      sessions: srv.ctx.db.prepare('SELECT * FROM sessions').all(),
    });
    assert.ok(!dump.includes(secret), 'texto em claro encontrado no banco');
    assert.ok(!dump.includes('alice-senha-forte'), 'senha encontrada no banco');
    assert.ok(!dump.includes('bob-senha-forte'), 'senha encontrada no banco');

    // limpa para os próximos testes
    const reader = await srv.resume(bob.token);
    await reader.unlock(bobPassword);
    await reader.openConversation(alice.user.id);
  });

  it('mensagem fica bloqueada até a senha ser digitada e some depois de lida', async () => {
    const bobId = bob.user.id;
    const aliceId = alice.user.id;
    const watcher = watch(alice);
    await watcher.ready;

    await alice.send(bobId, 'Oi Bob, reunião às 15h');
    await alice.send(bobId, 'Traga o relatório');

    // Bob abre o app com o token guardado: o cofre está trancado.
    const bobDevice = await srv.resume(bob.token);
    assert.equal(bobDevice.isUnlocked, false);
    // Sem a senha só há metadados: quantidade, nenhum texto.
    const summary = await bobDevice.summary();
    assert.deepEqual(
      summary.map((s) => ({ peerId: s.peerId, incoming: s.incoming })),
      [{ peerId: aliceId, incoming: 2 }],
    );
    assert.ok(!JSON.stringify(summary).includes('reunião'));
    await assert.rejects(() => bobDevice.openConversation(aliceId), LockedError);
    // Senha errada não abre.
    await assert.rejects(() => bobDevice.unlock('senha-errada'), WrongPasswordError);
    assert.equal(bobDevice.isUnlocked, false);
    // Nada foi apagado por tentativas sem senha.
    assert.equal(srv.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, 2);

    // Com a senha certa, lê.
    await bobDevice.unlock(bobPassword);
    const convo = await bobDevice.openConversation(aliceId);
    assert.deepEqual(
      convo.messages.map((m) => [m.direction, m.text]),
      [
        ['in', 'Oi Bob, reunião às 15h'],
        ['in', 'Traga o relatório'],
      ],
    );
    assert.deepEqual(convo.unreadable, []);

    // Depois de lidas, foram apagadas do servidor: abrir de novo não traz nada.
    assert.equal(srv.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, 0);
    assert.deepEqual((await bobDevice.openConversation(aliceId)).messages, []);
    assert.deepEqual(await bobDevice.summary(), []);

    // Alice é avisada de que leram.
    const read = await watcher.next('message.read');
    assert.equal(read.readerId, bobId);
    assert.equal(read.ids.length, 2);
  });

  it('trancar o cofre apaga a chave da memória e exige a senha de novo', async () => {
    const device = await srv.resume(bob.token);
    await device.unlock(bobPassword);
    assert.equal(device.isUnlocked, true);
    device.lock();
    assert.equal(device.isUnlocked, false);
    await assert.rejects(() => device.openConversation(alice.user.id), LockedError);
    await assert.rejects(() => device.send(alice.user.id, 'oi'), LockedError);
    await device.unlock(bobPassword);
    assert.equal(device.isUnlocked, true);
  });

  it('o remetente relê o que enviou enquanto não for lido; depois some', async () => {
    const bobId = bob.user.id;
    await alice.send(bobId, 'mensagem pendente');
    const mine = await alice.openConversation(bobId);
    assert.deepEqual(mine.messages.map((m) => [m.direction, m.text]), [['out', 'mensagem pendente']]);

    const reader = await srv.resume(bob.token);
    await reader.unlock(bobPassword);
    await reader.openConversation(alice.user.id);

    assert.deepEqual((await alice.openConversation(bobId)).messages, []);
  });

  it('"apagar para todos" funciona antes da leitura e avisa o destinatário', async () => {
    const watcher = watch(bob);
    await watcher.ready;
    const msg = await alice.send(bob.user.id, 'mandei errado');
    await watcher.next('message.new');
    await alice.recall(msg.id);
    const recalled = await watcher.next('message.recalled');
    assert.equal(recalled.id, msg.id);

    const reader = await srv.resume(bob.token);
    await reader.unlock(bobPassword);
    assert.deepEqual((await reader.openConversation(alice.user.id)).messages, []);
    // Depois de lida não dá mais para recolher.
    const m2 = await alice.send(bob.user.id, 'esta será lida');
    await reader.openConversation(alice.user.id);
    await assert.rejects(() => alice.recall(m2.id), (e: ApiError) => e.status === 404);
  });

  it('mensagem adulterada pelo servidor é recusada e NÃO é apagada', async () => {
    const sent = await alice.send(bob.user.id, 'conteúdo legítimo');
    const row = srv.ctx.db.prepare('SELECT envelope FROM messages WHERE id = ?').get(sent.id) as { envelope: string };
    const env = JSON.parse(row.envelope);
    env.c = env.c.slice(0, -2) + (env.c.endsWith('AA') ? 'BB' : 'AA');
    srv.ctx.db.prepare('UPDATE messages SET envelope = ? WHERE id = ?').run(JSON.stringify(env), sent.id);

    const reader = await srv.resume(bob.token);
    await reader.unlock(bobPassword);
    const convo = await reader.openConversation(alice.user.id);
    assert.deepEqual(convo.messages, []);
    assert.deepEqual(convo.unreadable, [sent.id]);
    assert.equal(srv.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(sent.id)!.n, 1);
    await reader.discard(convo.unreadable);
    assert.equal(srv.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(sent.id)!.n, 0);
  });

  it('um terceiro não consegue ler nem apagar mensagens alheias', async () => {
    const net = await srv.network('outra-rede-eve', 'eve');
    const sent = await alice.send(bob.user.id, 'só para o Bob');
    const eve = net.admin;
    // Eve tenta marcar como lida (apagar) a mensagem do Bob.
    const res = await eve.api.markRead([sent.id]);
    assert.equal(res.deleted, 0);
    assert.deepEqual(await eve.api.inbox(), []);
    assert.deepEqual(await eve.api.outbox(), []);
    // E tenta recolher a mensagem da Alice.
    await assert.rejects(() => eve.api.recall(sent.id), (e: ApiError) => e.status === 404);
    // A mensagem continua lá para o Bob.
    const reader = await srv.resume(bob.token);
    await reader.unlock(bobPassword);
    assert.equal((await reader.openConversation(alice.user.id)).messages.length, 1);
  });

  it('mensagens não lidas expiram no servidor', async () => {
    await alice.send(bob.user.id, 'vai expirar');
    const { purgeExpired } = await import('../src/services.js');
    assert.equal(purgeExpired(srv.ctx.db, Date.now() + 1000).messages, 0);
    const removed = purgeExpired(srv.ctx.db, Date.now() + srv.config.messageTtlMs + 1000);
    assert.equal(removed.messages, 1);
    assert.deepEqual(await bob.api.inbox(), []);
  });

  it('rejeita mensagem vazia, para si mesmo e ids repetidos', async () => {
    await assert.rejects(() => alice.send(bob.user.id, '   '), /vazia/);
    await assert.rejects(() => alice.send(alice.user.id, 'oi'), (e: ApiError) => e.status === 404 || e.status === 400);
    const m = await alice.send(bob.user.id, 'uma vez');
    const row = srv.ctx.db.prepare('SELECT envelope, sender_envelope FROM messages WHERE id = ?').get(m.id) as { envelope: string; sender_envelope: string };
    await assert.rejects(
      () => alice.api.sendMessage({ id: m.id, recipientId: bob.user.id, envelope: row.envelope, senderEnvelope: row.sender_envelope }),
      (e: ApiError) => e.status === 409,
    );
    const reader = await srv.resume(bob.token);
    await reader.unlock(bobPassword);
    await reader.openConversation(alice.user.id);
  });
});

describe('chaves dos contatos', () => {
  it('detecta troca de chave (confiança no primeiro uso) e exige confirmação', async () => {
    const srv = await startServer();
    try {
      const net = await srv.network('chaves');
      const a = await srv.member(net.admin, 'ana');
      const b = await srv.member(net.admin, 'beto');
      await a.session.send(b.session.user.id, 'primeira'); // fixa a chave do Beto

      // Beto "perde" a conta: o admin zera, ele ativa de novo com novo par de chaves.
      const reset = await net.admin.api.resetActivation(b.id);
      await srv.activate(b.session.user.handle, reset.activationCode, 'nova-senha-beto');

      const ana = await srv.resume(a.session.token);
      await ana.unlock(a.password);
      // O app da Ana já conhecia a chave antiga do Beto.
      const pinStoreSession = a.session; // mesma sessão (mesmo pinStore em memória)
      await assert.rejects(() => pinStoreSession.send(b.session.user.id, 'segunda'), KeyChangedError);
      assert.match(pinStoreSession.safetyNumberWith((await pinStoreSession.loadContacts()).find((c) => c.id === b.session.user.id)!), /^(\d{5} ){11}\d{5}$/);
      await pinStoreSession.trustKey(b.session.user.id);
      await pinStoreSession.send(b.session.user.id, 'segunda');
    } finally {
      await srv.close();
    }
  });
});
