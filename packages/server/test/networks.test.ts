import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, type SigiloSession } from '@sigilo/core';
import { startServer, watch } from './harness.js';

const status = (code: number) => (e: unknown) => e instanceof ApiError && e.status === code;

describe('redes isoladas e vínculos entre redes', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let adminA: SigiloSession, adminB: SigiloSession, adminC: SigiloSession;
  let ana: Awaited<ReturnType<typeof srv.member>>;
  let bruno: Awaited<ReturnType<typeof srv.member>>;
  let carla: Awaited<ReturnType<typeof srv.member>>;

  before(async () => {
    srv = await startServer();
    adminA = (await srv.network('rede-a')).admin;
    adminB = (await srv.network('rede-b')).admin;
    adminC = (await srv.network('rede-c')).admin;
    ana = await srv.member(adminA, 'ana');
    bruno = await srv.member(adminB, 'bruno');
    carla = await srv.member(adminC, 'carla');
  });
  after(() => srv.close());

  it('redes sem vínculo não se enxergam nem trocam mensagens', async () => {
    const contacts = await ana.session.loadContacts();
    assert.deepEqual(contacts.map((c) => c.handle).sort(), ['admin@rede-a']);
    assert.ok(contacts.every((c) => c.sameNetwork));

    await assert.rejects(() => ana.session.send(bruno.session.user.id, 'oi?'), status(404));
    await assert.rejects(() => ana.session.api.contact(bruno.session.user.id), status(404));
    // Descobrir o id de alguém de outra rede não adianta: o servidor responde igual a "não existe".
    await assert.rejects(() => ana.session.api.sendMessage({
      id: '6f1c2a40-7a53-4b52-8f1d-0b8b2d6a9c11',
      recipientId: bruno.session.user.id,
      envelope: 'x'.repeat(30),
      senderEnvelope: 'x'.repeat(30),
    }), status(404));
  });

  it('só administradores acessam /admin e cada um só mexe na própria rede', async () => {
    await assert.rejects(() => ana.session.api.members(), status(403));
    await assert.rejects(() => ana.session.api.links(), status(403));
    await assert.rejects(() => ana.session.api.createMember({ username: 'x1', displayName: 'X' }), status(403));
    // Admin da rede B não consegue desativar nem resetar gente da rede A.
    await assert.rejects(() => adminB.api.disableMember(ana.id), status(404));
    await assert.rejects(() => adminB.api.resetActivation(ana.id), status(404));
    assert.deepEqual((await adminB.api.members()).map((m) => m.handle).sort(), ['admin@rede-b', 'bruno@rede-b']);
  });

  describe('vínculo por PEDIDO', () => {
    it('só vale depois que o administrador da outra rede aceita', async () => {
      const watcherAna = watch(ana.session);
      await watcherAna.ready;

      await adminA.api.requestLink('rede-b');
      let a = await adminA.api.links();
      assert.equal(a.outgoing.length, 1);
      assert.equal(a.outgoing[0]!.peerSlug, 'rede-b');
      let b = await adminB.api.links();
      assert.equal(b.incoming.length, 1);
      const linkId = b.incoming[0]!.id;

      // Pendente = continua isolado.
      await assert.rejects(() => ana.session.send(bruno.session.user.id, 'oi'), status(404));
      // Quem pediu não pode aceitar o próprio pedido; quem não faz parte nem vê o vínculo.
      await assert.rejects(() => adminA.api.acceptLink(linkId), status(403));
      await assert.rejects(() => adminC.api.acceptLink(linkId), status(404));
      // Nem repetir o pedido, nem pedir no sentido contrário enquanto há um aberto.
      await assert.rejects(() => adminA.api.requestLink('rede-b'), status(409));
      await assert.rejects(() => adminB.api.requestLink('rede-a'), status(409));
      // Membro comum não decide.
      await assert.rejects(() => bruno.session.api.acceptLink(linkId), status(403));

      await adminB.api.acceptLink(linkId);
      await watcherAna.next('contacts.changed');

      a = await adminA.api.links();
      assert.equal(a.active.length, 1);
      assert.equal(a.outgoing.length, 0);

      // Agora conversam, em criptografia ponta a ponta.
      const contacts = await ana.session.loadContacts();
      assert.ok(contacts.some((c) => c.handle === 'bruno@rede-b' && !c.sameNetwork && c.networkName === 'Rede rede-b'));
      assert.ok(!contacts.some((c) => c.handle === 'carla@rede-c'));
      await ana.session.send(bruno.session.user.id, 'Olá de outra rede');
      const brunoDevice = await srv.resume(bruno.session.token);
      await brunoDevice.unlock(bruno.password);
      const convo = await brunoDevice.openConversation(ana.session.user.id);
      assert.deepEqual(convo.messages.map((m) => m.text), ['Olá de outra rede']);
    });

    it('vínculo NÃO é transitivo: A–B e B–C não ligam A a C', async () => {
      await adminC.api.requestLink('rede-b');
      const incoming = (await adminB.api.links()).incoming;
      assert.equal(incoming.length, 1);
      await adminB.api.acceptLink(incoming[0]!.id);

      // B enxerga A e C…
      const brunoContacts = await bruno.session.loadContacts();
      assert.deepEqual(
        brunoContacts.map((c) => c.handle).sort(),
        ['admin@rede-a', 'admin@rede-b', 'admin@rede-c', 'ana@rede-a', 'carla@rede-c'],
      );
      // …mas A não enxerga C e não consegue escrever para ela.
      assert.ok(!(await ana.session.loadContacts()).some((c) => c.networkSlug === 'rede-c'));
      await assert.rejects(() => ana.session.send(carla.session.user.id, 'oi'), status(404));
      await assert.rejects(() => carla.session.send(ana.session.user.id, 'oi'), status(404));
      // Pedir a conexão direta continua sendo necessário.
      assert.equal((await adminA.api.links()).active.length, 1);
    });

    it('qualquer lado pode revogar; contatos somem e mensagens pendentes entre as redes são apagadas', async () => {
      await ana.session.send(bruno.session.user.id, 'não lida, será apagada');
      const countBefore = srv.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n;
      assert.equal(countBefore, 1);

      const link = (await adminB.api.links()).active.find((l) => l.peerSlug === 'rede-a')!;
      await adminB.api.revokeLink(link.id);

      assert.equal(srv.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages').get()!.n, 0);
      assert.ok(!(await ana.session.loadContacts()).some((c) => c.networkSlug === 'rede-b'));
      await assert.rejects(() => ana.session.send(bruno.session.user.id, 'oi'), status(404));
      await assert.rejects(() => bruno.session.send(ana.session.user.id, 'oi'), status(404));
      // Revogar de novo não faz sentido.
      await assert.rejects(() => adminA.api.revokeLink(link.id), status(409));
      // Rede C ainda está ligada a B.
      assert.equal((await adminB.api.links()).active.length, 1);
    });

    it('pedido recusado ou cancelado não vincula, e dá para pedir de novo', async () => {
      await adminA.api.requestLink('rede-b');
      const id = (await adminB.api.links()).incoming[0]!.id;
      await adminB.api.rejectLink(id);
      assert.equal((await adminA.api.links()).outgoing.length, 0);
      await assert.rejects(() => ana.session.send(bruno.session.user.id, 'oi'), status(404));
      await assert.rejects(() => adminB.api.acceptLink(id), status(409));

      await adminA.api.requestLink('rede-b');
      const out = (await adminA.api.links()).outgoing[0]!;
      await assert.rejects(() => adminB.api.cancelLink(out.id), status(403));
      await adminA.api.cancelLink(out.id);
      assert.equal((await adminB.api.links()).incoming.length, 0);
    });

    it('rejeita pedido para rede inexistente ou para a própria rede', async () => {
      await assert.rejects(() => adminA.api.requestLink('nao-existe'), status(404));
      await assert.rejects(() => adminA.api.requestLink('rede-a'), status(400));
    });
  });

  describe('vínculo por CONVITE', () => {
    it('o administrador da outra rede aceita o convite com o código; o código só vale uma vez', async () => {
      // Estado limpo entre A e B.
      assert.equal((await adminA.api.links()).active.length, 0);

      await assert.rejects(() => ana.session.api.createInvite(), status(403));
      const invite = await adminA.api.createInvite();
      assert.match(invite.code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
      assert.ok(invite.expiresAt > Date.now());

      // Convite emitido ainda não liga nada.
      await assert.rejects(() => ana.session.send(bruno.session.user.id, 'oi'), status(404));
      // Membro comum e a própria rede emissora não aceitam.
      await assert.rejects(() => bruno.session.api.acceptInvite(invite.code), status(403));
      await assert.rejects(() => adminA.api.acceptInvite(invite.code), status(400));
      // Código errado.
      await assert.rejects(() => adminB.api.acceptInvite('AAAA-BBBB-CCCC-DDDD'), status(410));

      // O código tolera minúsculas, espaços e hífens a mais (foi digitado/ditado).
      await adminB.api.acceptInvite(invite.code.toLowerCase().replaceAll('-', ' '));
      assert.equal((await adminA.api.links()).active.length, 1);
      await ana.session.send(bruno.session.user.id, 'convite aceito');

      // Segunda utilização falha.
      await assert.rejects(() => adminC.api.acceptInvite(invite.code), status(410));
      // Limpa o vínculo para os próximos testes.
      await adminA.api.revokeLink((await adminA.api.links()).active[0]!.id);
    });

    it('convite expirado não pode ser aceito', async () => {
      const invite = await adminA.api.createInvite();
      srv.ctx.db.prepare('UPDATE link_invites SET expires_at = ?').run(Date.now() - 1000);
      await assert.rejects(() => adminB.api.acceptInvite(invite.code), status(410));
    });

    it('convite não cria vínculo duplicado se já existir um aberto', async () => {
      await adminA.api.requestLink('rede-b');
      const invite = await adminA.api.createInvite();
      await assert.rejects(() => adminB.api.acceptInvite(invite.code), status(409));
      await adminA.api.cancelLink((await adminA.api.links()).outgoing[0]!.id);
    });
  });
});
