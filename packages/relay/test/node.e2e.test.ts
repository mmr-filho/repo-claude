import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { b64, jsScrypt, utf8Encode, WrongPasswordError } from '@sigilo/core';
import {
  LocalNode,
  LockedError,
  StaleVaultKeyError,
  MemoryLocalStore,
  PayloadType,
  RelayClient,
  UntrustedContactError,
  generateIdentity2,
  generateSignKeys,
  issueMemberCert,
  sealFrame,
  type NodeDeps,
} from '@sigilo/core/v2';
import { KDF, enroll, makeDeps, newNetwork, recordingFetch, settle, startRelay, type Clock } from './harness.js';

type Relay = Awaited<ReturnType<typeof startRelay>>;

describe('v2: rede sem servidor de contas', () => {
  let relay: Relay;
  before(async () => {
    relay = await startRelay();
  });
  after(() => relay.close());

  it('administrador cria a rede, convida, e a pessoa entra: certificado, nome do convite e lista de contatos', async () => {
    const admin = await newNetwork(relay.url, 'UniRG', 'Maria Admin');
    assert.equal(admin.isAdmin, true);
    const ana = await enroll(admin, 'Ana Souza');
    const bruno = await enroll(admin, 'Bruno Lima');
    await settle([admin, ana.node, bruno.node]);

    assert.equal(ana.node.isEnrolled, true);
    assert.equal(ana.node.me?.name, 'Ana Souza', 'o nome vem do convite (decidido pelo administrador)');
    assert.equal(ana.node.me?.role, 'member');
    assert.equal(ana.node.isAdmin, false);
    assert.deepEqual(ana.node.contacts().map((c) => c.name).sort(), ['Bruno Lima', 'Maria Admin']);
    assert.deepEqual(bruno.node.contacts().map((c) => c.name).sort(), ['Ana Souza', 'Maria Admin']);
    assert.equal(ana.node.network?.name, 'UniRG');
    assert.equal(admin.members().length, 3);
  });

  it('convite vale uma vez só, vence, e não se reaproveita com outro nome', async () => {
    const clock: Clock = { t: Date.now() };
    const admin = await newNetwork(relay.url, 'Convites', 'Adm', clock);
    const inv = await admin.createInvite('Primeira');
    const first = await LocalNode.join(makeDeps({ clock }), { password: 'senha-primeira', inviteCode: inv.code });
    const second = await LocalNode.join(makeDeps({ clock }), { password: 'senha-segunda', inviteCode: inv.code });
    await admin.poll();
    await first.poll();
    await second.poll();
    assert.equal(first.isEnrolled, true);
    assert.equal(second.isEnrolled, false, 'o mesmo convite não entra duas vezes');
    assert.equal(admin.members().length, 2);

    const old = await admin.createInvite('Vencido');
    clock.t += 8 * 24 * 60 * 60 * 1000;
    await assert.rejects(() => LocalNode.join(makeDeps({ clock }), { password: 'senha-qualquer', inviteCode: old.code }), /vencido/);
    await assert.rejects(() => LocalNode.join(makeDeps({ clock }), { password: 'x'.repeat(12), inviteCode: 'lixo' }), /tipo errado/);
  });

  it('mensagem: cifrada no relé, bloqueada até a senha, e some ao ser lida', async () => {
    const admin = await newNetwork(relay.url, 'Chat', 'Adm');
    const ana = await enroll(admin, 'Ana');
    const bruno = await enroll(admin, 'Bruno');
    await settle([admin, ana.node, bruno.node]);
    const anaId = ana.node.myBox;
    const brunoId = bruno.node.myBox;

    const SEGREDO = 'palavra-secreta-xyzzy-9876';
    const r = await ana.node.send(brunoId, SEGREDO);
    assert.equal(r.status, 'sent');
    assert.equal(r.via, 'relay');

    // O relé só tem texto cifrado, sem identidade de remetente (conferência direta no banco, só no relé Node).
    if (relay.store) {
      const dump = JSON.stringify(relay.store.db.prepare('SELECT * FROM msgs').all().map((m) => ({ ...m, frame: Buffer.from((m as { frame: Uint8Array }).frame).toString('latin1') })));
      assert.ok(!dump.includes('xyzzy'));
    }

    // Bruno fecha o app e reabre: cofre trancado. Sem senha sabe só QUANTAS mensagens esperam.
    await bruno.node.lock();
    assert.equal(bruno.node.isUnlocked, false);
    const reopened = (await LocalNode.load(bruno.deps))!;
    assert.equal(reopened.isUnlocked, false);
    assert.ok((await reopened.pendingCount()) >= 1);
    await assert.rejects(() => reopened.poll(), LockedError);
    await assert.rejects(() => reopened.openConversation(anaId), LockedError);
    await assert.rejects(() => reopened.unlock('senha-errada-123'), WrongPasswordError);
    assert.equal(reopened.isUnlocked, false);

    await reopened.unlock(bruno.password);
    const polled = await reopened.poll();
    assert.equal(polled.unread[anaId], 1);
    const before = await reopened.pendingCount();
    const convo = await reopened.openConversation(anaId);
    assert.deepEqual(convo.messages.map((m) => m.text), [SEGREDO]);
    assert.equal(await reopened.pendingCount(), before - 1, 'a leitura apagou a mensagem da caixa postal');

    // Ana descobre que foi lida; o texto some também da memória dela.
    const back = await ana.node.poll();
    assert.equal(back.receipts.length, 1);
    const view = await ana.node.openConversation(brunoId);
    assert.deepEqual(view.sent.map((m) => [m.status, m.text]), [['read', '']]);

    // Ler de novo não traz nada.
    assert.deepEqual((await reopened.openConversation(anaId)).messages, []);
    assert.deepEqual((await reopened.poll()).unread, {});
  });

  it('trancar durante a leitura não perde nem expõe a mensagem: ela continua cifrada no relé até ser lida', async () => {
    const admin = await newNetwork(relay.url, 'Trava', 'Adm');
    const ana = await enroll(admin, 'Ana');
    const bruno = await enroll(admin, 'Bruno');
    await settle([admin, ana.node, bruno.node]);
    await ana.node.send(bruno.node.myBox, 'chegou antes de trancar');
    assert.equal((await bruno.node.poll()).unread[ana.node.myBox], 1);
    await bruno.node.lock(); // texto saiu da memória
    await bruno.node.unlock(bruno.password);
    assert.equal((await bruno.node.poll()).unread[ana.node.myBox], 1, 'nada foi apagado por trancar');
    assert.deepEqual((await bruno.node.openConversation(ana.node.myBox)).messages.map((m) => m.text), ['chegou antes de trancar']);
  });

  it('estado em repouso: contatos, mensagens e chaves não ficam em claro no armazenamento do aparelho', async () => {
    const admin = await newNetwork(relay.url, 'Repouso', 'Adm');
    const ana = await enroll(admin, 'Ana');
    await enroll(admin, 'Contato Sigiloso');
    await settle([admin, ana.node]);
    assert.ok(ana.node.contacts().some((c) => c.name === 'Contato Sigiloso'));
    await ana.node.send(ana.node.contacts().find((c) => c.name === 'Contato Sigiloso')!.box, 'texto-que-nao-pode-vazar');
    const stored = JSON.stringify([...ana.deps.store.data.entries()]);
    assert.ok(!stored.includes('Contato Sigiloso'), 'contato em claro');
    assert.ok(!stored.includes('texto-que-nao-pode-vazar'), 'mensagem em claro');
    assert.ok(!stored.includes('senha-Ana'), 'senha em claro');
    // Só o perfil da tela de bloqueio (o próprio nome e o da rede) fica legível, de propósito.
    assert.match(String(ana.deps.store.data.get('meta')), /"name":"Ana"/);
    // Sem a senha, o cofre não abre.
    const stranger = (await LocalNode.load({ ...ana.deps }))!;
    await assert.rejects(() => stranger.unlock('chute-qualquer-aqui'), WrongPasswordError);
  });

  it('apagar para todos: o destinatário não vê a mensagem se ela ainda não foi lida', async () => {
    const admin = await newNetwork(relay.url, 'Recall', 'Adm');
    const ana = await enroll(admin, 'Ana');
    const bruno = await enroll(admin, 'Bruno');
    await settle([admin, ana.node, bruno.node]);
    const sent = await ana.node.send(bruno.node.myBox, 'mandei errado');
    await ana.node.recall(sent.id);
    const p = await bruno.node.poll();
    assert.deepEqual(p.unread, {});
    assert.deepEqual((await bruno.node.openConversation(ana.node.myBox)).messages, []);
  });

  it('o mesmo quadro por dois meios aparece uma vez só', async () => {
    const admin = await newNetwork(relay.url, 'Dedupe', 'Adm');
    const sentLog: Array<{ path: string; body: Uint8Array }> = [];
    const ana = await enroll(admin, 'Ana', undefined, undefined, makeDeps({ fetch: recordingFetch(sentLog) }));
    const bruno = await enroll(admin, 'Bruno');
    await settle([admin, ana.node, bruno.node]);
    sentLog.length = 0;
    await ana.node.send(bruno.node.myBox, 'uma só vez');
    const toBruno = sentLog.filter((s) => s.path.endsWith('/m')).pop()!;
    await bruno.node.receiveFrame(toBruno.body); // chegou também por "outro meio"
    await bruno.node.poll();
    const convo = await bruno.node.openConversation(ana.node.myBox);
    assert.equal(convo.messages.length, 1);
  });
});

describe('v2: isolamento, vínculos, revogação e vencimento', () => {
  let relay: Relay;
  before(async () => {
    relay = await startRelay();
  });
  after(() => relay.close());

  async function twoNetworks(clock?: Clock) {
    const adminA = await newNetwork(relay.url, 'Rede A', 'Admin A', clock);
    const adminB = await newNetwork(relay.url, 'Rede B', 'Admin B', clock);
    const ana = await enroll(adminA, 'Ana', undefined, clock);
    const bruno = await enroll(adminB, 'Bruno', undefined, clock);
    await settle([adminA, adminB, ana.node, bruno.node]);
    return { adminA, adminB, ana, bruno };
  }

  it('redes sem vínculo não se enxergam e quadros de fora nunca viram mensagem', async () => {
    const { adminA, adminB, ana, bruno } = await twoNetworks();
    assert.ok(!ana.node.contacts().some((c) => c.name === 'Bruno'));
    await assert.rejects(() => ana.node.send(bruno.node.myBox, 'oi'), /desconhecido/);

    // Vazamento simulado: o atacante conhece a caixa postal e a chave da Ana (estão no certificado dela).
    const rogueAuthority = generateSignKeys();
    const rogue = generateIdentity2();
    const cert = issueMemberCert(rogueAuthority, {
      box: b64.encode(rogue.box.publicKey),
      sign: b64.encode(rogue.sign.publicKey),
      name: 'Intruso',
      role: 'member',
      inbox: 'inbox-intruso',
      relay: relay.url,
    });
    const target = ana.node.me!;
    const send = (type: (typeof PayloadType)[keyof typeof PayloadType], body: Uint8Array, senderKey = false) =>
      new RelayClient().send(
        target.relay,
        target.inbox,
        sealFrame({ payload: { type, body, senderKey: senderKey ? rogue.box.publicKey : undefined }, sender: rogue.box, recipientBox: b64.decode(target.box), padTo: 128 }),
      );
    await send(PayloadType.Intro, utf8Encode(JSON.stringify(cert)), true);
    await send(PayloadType.Chat, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 0, ...utf8Encode('oi, sou do banco')), true);
    const polled = await ana.node.poll();
    assert.deepEqual(polled.unread, {}, 'nada de fora chega ao usuário');
    assert.ok(!ana.node.contacts().some((c) => c.name === 'Intruso'));
    void adminA;
    void adminB;
  });

  it('vínculo por pedido: o outro administrador precisa aceitar; depois conversam; não é transitivo', async () => {
    const { adminA, adminB, ana, bruno } = await twoNetworks();
    const adminC = await newNetwork(relay.url, 'Rede C', 'Admin C');
    const carla = await enroll(adminC, 'Carla');
    await settle([adminC, carla.node]);

    await adminA.requestLink(adminB.networkCode());
    await adminB.poll();
    assert.equal(adminB.proposals().length, 1);
    assert.equal(adminB.proposals()[0]!.networkName, 'Rede A');
    // Enquanto pendente, continua isolado.
    await settle([adminA, adminB, ana.node, bruno.node]);
    assert.equal(ana.node.contacts().some((c) => c.name === 'Bruno'), false);

    await adminB.acceptLink(adminB.proposals()[0]!.id);
    await settle([adminA, adminB, ana.node, bruno.node], 4);
    assert.deepEqual(adminA.linkedNetworks().map((l) => l.name), ['Rede B']);
    const bruNoFromAna = ana.node.contacts().find((c) => c.name === 'Bruno');
    assert.ok(bruNoFromAna && !bruNoFromAna.sameNetwork && bruNoFromAna.networkName === 'Rede B');
    assert.ok(bruno.node.contacts().some((c) => c.name === 'Ana' && !c.sameNetwork));

    // Conversa entre redes, de ponta a ponta.
    const r = await ana.node.send(bruno.node.myBox, 'olá de outra rede');
    assert.equal(r.status, 'sent');
    assert.equal((await bruno.node.poll()).unread[ana.node.myBox], 1);
    assert.deepEqual((await bruno.node.openConversation(ana.node.myBox)).messages.map((m) => m.text), ['olá de outra rede']);

    // Rede C liga só com B. A não vê C, C não vê A, e quadros de C para A não viram mensagem.
    await adminC.requestLink(adminB.networkCode());
    await adminB.poll();
    await adminB.acceptLink(adminB.proposals()[0]!.id);
    await settle([adminA, adminB, adminC, ana.node, bruno.node, carla.node], 4);
    assert.ok(bruno.node.contacts().some((c) => c.name === 'Carla'));
    assert.ok(!ana.node.contacts().some((c) => c.name === 'Carla'), 'A–B e B–C não ligam A a C');
    assert.ok(!carla.node.contacts().some((c) => c.name === 'Ana'));
    await assert.rejects(() => carla.node.send(ana.node.myBox, 'oi'), /desconhecido/);
  });

  it('desfazer o vínculo: contatos de fora somem nos dois lados', async () => {
    const { adminA, adminB, ana, bruno } = await twoNetworks();
    await adminA.requestLink(adminB.networkCode());
    await adminB.poll();
    await adminB.acceptLink(adminB.proposals()[0]!.id);
    await settle([adminA, adminB, ana.node, bruno.node], 4);
    assert.ok(ana.node.contacts().some((c) => c.name === 'Bruno'));

    await adminA.unlink(adminB.network!.net);
    await settle([adminA, adminB, ana.node, bruno.node], 4);
    assert.ok(!ana.node.contacts().some((c) => c.name === 'Bruno'));
    assert.ok(!bruno.node.contacts().some((c) => c.name === 'Ana'));
    assert.deepEqual(adminA.linkedNetworks(), []);
    assert.deepEqual(adminB.linkedNetworks(), []);
    await assert.rejects(() => ana.node.send(bruno.node.myBox, 'oi'), /desconhecido/);
  });

  it('revogar um membro: some dos contatos, perde o acesso e não consegue mais mandar mensagem', async () => {
    const admin = await newNetwork(relay.url, 'Revoga', 'Adm');
    const ana = await enroll(admin, 'Ana');
    const bruno = await enroll(admin, 'Bruno');
    await settle([admin, ana.node, bruno.node]);
    assert.ok(ana.node.contacts().some((c) => c.name === 'Bruno'));

    await admin.revokeMember(bruno.node.myBox);
    await settle([admin, ana.node, bruno.node]);
    assert.ok(!ana.node.contacts().some((c) => c.name === 'Bruno'));
    assert.equal(bruno.node.isRevoked, true);
    await assert.rejects(() => bruno.node.send(ana.node.myBox, 'ainda estou aí?'), /revogado/);
    await assert.rejects(() => ana.node.send(bruno.node.myBox, 'oi'), /desconhecido/);
    assert.ok(!admin.members().some((m) => m.name === 'Bruno'));
    await assert.rejects(() => admin.revokeMember(admin.myBox), /não pode se revogar/);
  });

  it('certificados vencem e são renovados sozinhos; quem fica fora do ar perde a confiança', async () => {
    const clock: Clock = { t: Date.now() };
    const admin = await newNetwork(relay.url, 'Vencimento', 'Adm', clock);
    const ana = await enroll(admin, 'Ana', undefined, clock);
    const bruno = await enroll(admin, 'Bruno', undefined, clock);
    await settle([admin, ana.node, bruno.node]);
    const firstExp = ana.node.me!.exp;
    const day = 24 * 60 * 60 * 1000;

    clock.t += 24 * day; // faltam 6 dias: a Ana pede renovação sozinha; o Bruno está sem usar o app
    await ana.node.poll();
    await admin.poll();
    const renewed = await ana.node.poll();
    assert.ok(renewed.events.includes('renewed'));
    assert.ok(ana.node.me!.exp > firstExp);

    clock.t += 10 * day; // o certificado do Bruno venceu
    await ana.node.poll();
    assert.ok(!ana.node.contacts().some((c) => c.name === 'Bruno'), 'certificado vencido não é contato confiável');
    await assert.rejects(() => ana.node.send(bruno.node.myBox, 'oi'), /desconhecido|vencido/);
    assert.ok(ana.node.contacts().some((c) => c.name === 'Adm'));
  });

  it('recusa um certificado válido fora da validade, mesmo vindo do administrador certo', async () => {
    const clock: Clock = { t: Date.now() };
    const admin = await newNetwork(relay.url, 'Antigo', 'Adm', clock);
    const ana = await enroll(admin, 'Ana', undefined, clock);
    await settle([admin, ana.node]);
    clock.t += 40 * 24 * 60 * 60 * 1000; // tudo venceu, inclusive o do administrador
    assert.deepEqual(ana.node.contacts(), []);
  });
});

describe('v2: vários meios de envio', () => {
  let relay: Relay;
  before(async () => {
    relay = await startRelay();
  });
  after(() => relay.close());

  const offline: typeof fetch = async () => {
    throw new TypeError('sem internet');
  };

  function fakeSms(delivered: Array<{ phone: string; frame: Uint8Array }>) {
    return {
      id: 'sms' as const,
      privacyRank: 3,
      leavesCarrierRecord: true,
      padTo: 0,
      isAvailable: async () => true,
      canReach: (p: { sms?: { phone: string } }) => !!p.sms,
      send: async (p: { sms?: { phone: string } }, frame: Uint8Array) => void delivered.push({ phone: p.sms!.phone, frame }),
    };
  }

  it('sem internet a mensagem espera na fila; volta a internet e ela sai', async () => {
    const admin = await newNetwork(relay.url, 'Fila', 'Adm');
    const ana = await enroll(admin, 'Ana');
    const bruno = await enroll(admin, 'Bruno');
    await settle([admin, ana.node, bruno.node]);

    // O aparelho da Ana perde a internet (mesmo armazenamento, outro cliente de rede).
    const anaBox = ana.node.myBox;
    await ana.node.lock();
    const down = makeDeps({ store: ana.deps.store, fetch: offline });
    const anaOffline = (await LocalNode.load(down))!;
    await anaOffline.unlock(ana.password);
    const r = await anaOffline.send(bruno.node.myBox, 'mandada sem internet');
    assert.equal(r.status, 'queued');
    assert.equal((await bruno.node.poll()).unread[anaBox], undefined);

    await anaOffline.lock();
    const up = makeDeps({ store: ana.deps.store });
    const anaOnline = (await LocalNode.load(up))!;
    await anaOnline.unlock(ana.password);
    assert.equal(await anaOnline.flushOutbox(), 1);
    assert.equal((await bruno.node.poll()).unread[anaBox], 1);
    assert.deepEqual((await bruno.node.openConversation(anaBox)).messages.map((m) => m.text), ['mandada sem internet']);
  });

  it('SMS só como último recurso e só com a permissão do usuário para aquele contato', async () => {
    const admin = await newNetwork(relay.url, 'Sms', 'Adm');
    const smsOut: Array<{ phone: string; frame: Uint8Array }> = [];
    const anaDeps = makeDeps({ fetch: offline, transports: [fakeSms(smsOut)] });
    // Ana entra normalmente (com internet) e depois fica sem.
    const online = makeDeps({ store: anaDeps.store });
    const invite = await admin.createInvite('Ana');
    const ana = await LocalNode.join(online, { password: 'senha-ana-123', inviteCode: invite.code });
    const bruno = await enroll(admin, 'Bruno');
    await settle([admin, ana, bruno.node]);
    await ana.lock();
    const anaNode = (await LocalNode.load(anaDeps))!;
    await anaNode.unlock('senha-ana-123');
    const brunoBox = bruno.node.myBox;

    // Sem internet e SEM permissão: não usa SMS, avisa que precisa de consentimento.
    const blocked = await anaNode.send(brunoBox, 'preciso falar com você');
    assert.equal(blocked.status, 'queued');
    assert.equal(blocked.needsConsent, 'sms');
    assert.equal(smsOut.length, 0);

    // Com permissão e número: sai por SMS, cabendo em poucas partes, e o outro aparelho lê.
    await anaNode.setSmsConsent(brunoBox, true, '+5511999990000');
    await anaNode.lock();
    await anaNode.unlock('senha-ana-123');
    const sent = await anaNode.send(brunoBox, 'Reunião 15h');
    assert.equal(sent.status, 'sent');
    assert.equal(sent.via, 'sms');
    const chatFrame = smsOut.find((s) => s.phone === '+5511999990000' && s.frame.length < 140);
    assert.ok(chatFrame, 'a mensagem curta cabe num SMS');
    for (const s of smsOut) await bruno.node.receiveFrame(s.frame);
    assert.deepEqual((await bruno.node.openConversation(anaNode.myBox)).messages.map((m) => m.text), ['Reunião 15h']);
  });

  it('com internet o relé tem prioridade sobre o SMS mesmo com permissão', async () => {
    const admin = await newNetwork(relay.url, 'Prioridade', 'Adm');
    const smsOut: Array<{ phone: string; frame: Uint8Array }> = [];
    const anaDeps = makeDeps({ transports: [fakeSms(smsOut)] });
    const invite = await admin.createInvite('Ana');
    const ana = await LocalNode.join(anaDeps, { password: 'senha-ana-123', inviteCode: invite.code });
    const bruno = await enroll(admin, 'Bruno');
    await settle([admin, ana, bruno.node]);
    await ana.setSmsConsent(bruno.node.myBox, true, '+5511999990000');
    const r = await ana.send(bruno.node.myBox, 'pela internet');
    assert.equal(r.via, 'relay');
    assert.equal(smsOut.length, 0);
  });
});

describe('v2: o que a interface exige', () => {
  let relay: Relay;
  before(async () => {
    relay = await startRelay();
  });
  after(() => relay.close());

  it('operações simultâneas não se atropelam: várias consultas ao mesmo tempo entregam a mensagem uma vez', async () => {
    const admin = await newNetwork(relay.url, 'Simultaneo', 'Adm');
    const ana = await enroll(admin, 'Ana');
    const bruno = await enroll(admin, 'Bruno');
    await settle([admin, ana.node, bruno.node]);
    const anaBox = ana.node.myBox;
    await Promise.all([ana.node.send(bruno.node.myBox, 'primeira'), ana.node.send(bruno.node.myBox, 'segunda'), ana.node.poll()]);
    const polls = await Promise.all([bruno.node.poll(), bruno.node.poll(), bruno.node.poll(), bruno.node.poll()]);
    for (const p of polls) assert.equal(p.unread[anaBox], 2);
    const [a, b] = await Promise.all([bruno.node.openConversation(anaBox), bruno.node.openConversation(anaBox)]);
    assert.equal(a.messages.length + b.messages.length, 2, 'cada mensagem é entregue exatamente uma vez');
    assert.deepEqual([...a.messages, ...b.messages].map((m) => m.text).sort(), ['primeira', 'segunda']);
  });

  it('trancar no meio de uma consulta não perde a entrada na rede (a resposta já foi apagada do relé)', async () => {
    const admin = await newNetwork(relay.url, 'Trava2', 'Adm');
    const invite = await admin.createInvite('Ana');
    const deps = makeDeps();
    const ana = await LocalNode.join(deps, { password: 'senha-ana-123', inviteCode: invite.code });
    await admin.poll(); // a resposta de entrada está na caixa da Ana
    const polling = ana.poll();
    const locking = ana.lock(); // tranca enquanto a consulta ainda está em andamento
    assert.equal(ana.isUnlocked, false, 'a partir de agora, novas operações são recusadas');
    await assert.rejects(() => ana.poll(), LockedError);
    await Promise.all([polling, locking]);

    const reopened = (await LocalNode.load(deps))!;
    await reopened.unlock('senha-ana-123');
    assert.equal(reopened.isEnrolled, true, 'a resposta foi processada e gravada antes de trancar');
    assert.equal(reopened.me?.name, 'Ana');
  });

  it('trocar a senha: a antiga deixa de abrir, a nova abre, e a identidade continua a mesma', async () => {
    const admin = await newNetwork(relay.url, 'Senha', 'Adm');
    const ana = await enroll(admin, 'Ana');
    const boxBefore = ana.node.myBox;
    await assert.rejects(() => ana.node.changePassword('errada-errada-1', 'nova-senha-forte'), WrongPasswordError);
    await ana.node.changePassword(ana.password, 'nova-senha-forte');
    await ana.node.lock();
    const reopened = (await LocalNode.load(ana.deps))!;
    await assert.rejects(() => reopened.unlock(ana.password), WrongPasswordError);
    await reopened.unlock('nova-senha-forte');
    assert.equal(reopened.myBox, boxBefore, 'os contatos não precisam reverificar nada');
    assert.ok(reopened.isEnrolled);
  });

  it('o administrador mantém a chave da rede ao trocar a senha', async () => {
    const admin = await newNetwork(relay.url, 'SenhaAdm', 'Adm');
    const net = admin.network!.net;
    await admin.changePassword('senha-do-admin', 'outra-senha-do-admin');
    const deps = (admin as unknown as { deps: ReturnType<typeof makeDeps> }).deps;
    await admin.lock();
    const again = (await LocalNode.load(deps))!;
    await again.unlock('outra-senha-do-admin');
    assert.equal(again.isAdmin, true);
    assert.equal(again.network?.net, net);
    assert.match((await again.createInvite('Teste')).code, /^sigilo2-convite:/);
  });

  it('apagar a identidade do aparelho: some tudo local e a caixa postal no relé; não há volta sem convite novo', async () => {
    const admin = await newNetwork(relay.url, 'Esquece', 'Adm');
    const ana = await enroll(admin, 'Ana');
    const qid = ana.node.profile.qid;
    const me = ana.node.me!;
    await ana.node.lock();
    await LocalNode.forget(ana.deps);
    assert.equal(await LocalNode.load(ana.deps), null);
    assert.equal(ana.deps.store.data.size, 0);
    // A caixa postal deixou de existir: depositar nela agora é recusado.
    await assert.rejects(() => new RelayClient().send(me.relay, qid, new Uint8Array(64)), /não existe/);
  });

  it('resumo do que aguarda leitura do outro lado', async () => {
    const admin = await newNetwork(relay.url, 'Aguarda', 'Adm');
    const ana = await enroll(admin, 'Ana');
    const bruno = await enroll(admin, 'Bruno');
    await settle([admin, ana.node, bruno.node]);
    await ana.node.send(bruno.node.myBox, 'um');
    await ana.node.send(bruno.node.myBox, 'dois');
    assert.deepEqual(ana.node.awaitingRead(), { [bruno.node.myBox]: 2 });
    await bruno.node.poll();
    await bruno.node.openConversation(ana.node.myBox);
    await ana.node.poll();
    assert.deepEqual(ana.node.awaitingRead(), {});
  });
});


describe('v2: destravar com a digital (chave do cofre guardada no hardware)', () => {
  let relay: Relay;
  before(async () => {
    relay = await startRelay();
  });
  after(() => relay.close());

  it('com a chave do cofre destrava sem senha e sem refazer o scrypt', async () => {
    const admin = await newNetwork(relay.url, 'Digital', 'Adm');
    const calls: number[] = [];
    const deps = makeDeps();
    deps.vault = { ...KDF, scrypt: (pw, salt, o) => (calls.push(o.N), jsScrypt(pw, salt, o)) };
    const invite = await admin.createInvite('Ana');
    const ana = await LocalNode.join(deps, { password: 'senha-ana-123', inviteCode: invite.code });
    await admin.poll();
    await ana.poll();
    assert.ok(ana.isEnrolled);

    // O app pede a chave (uma vez, com a senha) e a guarda no armazenamento protegido pela digital.
    await assert.rejects(() => ana.exportVaultKey('senha-errada-1'), WrongPasswordError);
    const key = await ana.exportVaultKey('senha-ana-123');
    assert.equal(key.length, 32);
    const boxBefore = ana.myBox;
    await ana.lock();

    // Depois, o toque na digital libera a chave: nenhum scrypt, nenhuma senha.
    const reopened = (await LocalNode.load(deps))!;
    calls.length = 0;
    await reopened.unlockWithKey(key);
    assert.equal(calls.length, 0, 'destravar com a chave não deriva a senha de novo');
    assert.equal(reopened.isUnlocked, true);
    assert.equal(reopened.myBox, boxBefore);
    assert.ok(reopened.isEnrolled);
  });

  it('chave errada ou desatualizada é recusada e o cofre continua trancado', async () => {
    const admin = await newNetwork(relay.url, 'DigitalVelha', 'Adm');
    const ana = await enroll(admin, 'Ana');
    const oldKey = await ana.node.exportVaultKey(ana.password);
    await ana.node.changePassword(ana.password, 'nova-senha-forte');
    await ana.node.lock();
    const reopened = (await LocalNode.load(ana.deps))!;
    await assert.rejects(() => reopened.unlockWithKey(oldKey), StaleVaultKeyError);
    await assert.rejects(() => reopened.unlockWithKey(new Uint8Array(32)), StaleVaultKeyError);
    assert.equal(reopened.isUnlocked, false);
    // Com a senha nova (e a chave nova) volta a funcionar.
    const newKey = await (async () => {
      await reopened.unlock('nova-senha-forte');
      const k = await reopened.exportVaultKey('nova-senha-forte');
      await reopened.lock();
      return k;
    })();
    await reopened.unlockWithKey(newKey);
    assert.equal(reopened.isUnlocked, true);
  });

  it('destravar enquanto o trancamento termina não perde nem apaga as chaves recém-carregadas', async () => {
    const admin = await newNetwork(relay.url, 'Corrida', 'Adm');
    const ana = await enroll(admin, 'Ana');
    const key = await ana.node.exportVaultKey(ana.password);
    const locking = ana.node.lock();
    const unlocking = ana.node.unlockWithKey(key); // chamado antes de o trancamento acabar
    await Promise.all([locking, unlocking]);
    assert.equal(ana.node.isUnlocked, true);
    assert.ok(ana.node.myBox); // as chaves continuam na memória
    await ana.node.poll();
  });
});
