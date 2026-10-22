import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError, SigiloSession, WrongPasswordError } from '@sigilo/core';
import { createNetwork } from '../src/services.js';
import { KDF_POLICY, startServer, watch } from './harness.js';

const status = (code: number) => (e: unknown) => e instanceof ApiError && e.status === code;

describe('contas criadas pelo administrador', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let admin: SigiloSession;

  before(async () => {
    srv = await startServer({ maxLoginFailures: 3 });
    admin = (await srv.network('conta')).admin;
  });
  after(() => srv.close());

  it('não existe cadastro público: só o administrador cria contas, e a conta nasce pendente', async () => {
    const api = new ApiClient({ baseUrl: srv.baseUrl });
    await assert.rejects(() => api.createMember({ username: 'intruso', displayName: 'I' }), status(401));
    const created = await admin.api.createMember({ username: 'joana', displayName: 'Joana' });
    assert.equal(created.member.status, 'pending');
    assert.equal(created.member.handle, 'joana@conta');
    assert.match(created.activationCode, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    // O código não fica guardado em claro.
    const row = srv.ctx.db.prepare('SELECT activation_hash FROM users WHERE handle = ?').get('joana@conta') as { activation_hash: string };
    assert.ok(!row.activation_hash.includes(created.activationCode.replaceAll('-', '')));
    // Conta pendente não entra, nem aparece nos contatos.
    await assert.rejects(() => srv.login('joana@conta', 'qualquer-coisa'), status(401));
    assert.ok(!(await admin.loadContacts()).some((c) => c.handle === 'joana@conta'));
    // Ativa com o código e a senha que ela escolhe.
    const joana = await srv.activate('joana@conta', created.activationCode, 'minha-senha-nova');
    assert.equal(joana.user.networkSlug, 'conta');
    assert.ok((await admin.loadContacts()).some((c) => c.handle === 'joana@conta'));
    // O código não pode ser usado de novo.
    await assert.rejects(() => srv.activate('joana@conta', created.activationCode, 'outra'), status(401));
  });

  it('nomes de usuário inválidos ou repetidos são recusados', async () => {
    await assert.rejects(() => admin.api.createMember({ username: 'Com Espaço', displayName: 'X' }), status(400));
    await assert.rejects(() => admin.api.createMember({ username: 'a', displayName: 'X' }), status(400));
    await assert.rejects(() => admin.api.createMember({ username: 'joana', displayName: 'Outra' }), status(409));
  });

  it('o mesmo nome de usuário pode existir em redes diferentes', async () => {
    const other = (await srv.network('outra-conta')).admin;
    const m = await other.api.createMember({ username: 'joana', displayName: 'Joana 2' });
    assert.equal(m.member.handle, 'joana@outra-conta');
  });

  it('código de ativação errado é recusado e, após 5 erros, o código é invalidado', async () => {
    const created = await admin.api.createMember({ username: 'forca-bruta', displayName: 'FB' });
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => srv.activate('forca-bruta@conta', 'AAAA-BBBB-CCCC-DDDD', 'x-senha-longa'), status(401));
    }
    // Até o código certo agora é inútil: precisa de reemissão pelo administrador.
    await assert.rejects(() => srv.activate('forca-bruta@conta', created.activationCode, 'x-senha-longa'), status(401));
    const reissued = await admin.api.resetActivation(created.member.id);
    const s = await srv.activate('forca-bruta@conta', reissued.activationCode, 'x-senha-longa');
    assert.equal(s.user.handle, 'forca-bruta@conta');
  });

  it('código de ativação expirado é recusado', async () => {
    const created = await admin.api.createMember({ username: 'atrasado', displayName: 'A' });
    srv.ctx.db.prepare('UPDATE users SET activation_expires = ? WHERE handle = ?').run(Date.now() - 1, 'atrasado@conta');
    await assert.rejects(() => srv.activate('atrasado@conta', created.activationCode, 'senha-qualquer'), status(401));
  });

  it('login: senha errada falha, bloqueia após o limite e libera depois', async () => {
    const m = await srv.member(admin, 'lock-user', 'senha-correta-1');
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => srv.login('lock-user@conta', 'senha-errada'), status(401));
    }
    // Bloqueada: nem a senha certa entra.
    await assert.rejects(() => srv.login('lock-user@conta', m.password), status(429));
    srv.ctx.db.prepare('UPDATE users SET locked_until = 0 WHERE handle = ?').run('lock-user@conta');
    const s = await srv.login('lock-user@conta', m.password);
    assert.equal(s.isUnlocked, true);
  });

  it('prelogin responde do mesmo jeito para contas que existem e que não existem', async () => {
    const api = new ApiClient({ baseUrl: srv.baseUrl });
    const real = await api.prelogin('joana@conta');
    const fake1 = await api.prelogin('fantasma@conta');
    const fake2 = await api.prelogin('fantasma@conta');
    assert.deepEqual(Object.keys(real).sort(), Object.keys(fake1).sort());
    assert.equal(fake1.kdfSalt, fake2.kdfSalt); // estável: não dá para distinguir por variação
    assert.equal(fake1.kdfSalt.length, real.kdfSalt.length);
    // Login com usuário inexistente = mesmo erro de senha errada.
    await assert.rejects(() => srv.login('fantasma@conta', 'x-senha-longa'), status(401));
  });

  it('login em outro aparelho funciona com a senha; a chave privada vem cifrada do servidor', async () => {
    const m = await srv.member(admin, 'multi', 'senha-multi-aparelho');
    const row = srv.ctx.db.prepare('SELECT encrypted_private_key, public_key FROM users WHERE handle = ?').get('multi@conta') as { encrypted_private_key: string; public_key: string };
    assert.ok(!row.encrypted_private_key.includes(m.session.publicKey));
    const second = await srv.login('multi@conta', m.password);
    assert.equal(second.publicKey, m.session.publicKey);
    await assert.rejects(() => srv.login('multi@conta', 'senha-errada'), status(401));
    // Quem recebe o cofre mas não sabe a senha não abre.
    const resumed = await srv.resume(second.token);
    await assert.rejects(() => resumed.unlock('chute'), WrongPasswordError);
  });

  it('troca de senha: a antiga deixa de valer, a nova vale, outros aparelhos são desconectados', async () => {
    const m = await srv.member(admin, 'trocasenha', 'senha-antiga-123');
    const other = await srv.login('trocasenha@conta', m.password);
    const watcher = watch(other);
    await watcher.ready;

    await assert.rejects(() => m.session.changePassword('senha-errada', 'senha-nova-456'), WrongPasswordError);
    await m.session.changePassword('senha-antiga-123', 'senha-nova-456');

    await assert.rejects(() => srv.login('trocasenha@conta', 'senha-antiga-123'), status(401));
    const again = await srv.login('trocasenha@conta', 'senha-nova-456');
    assert.equal(again.publicKey, m.session.publicKey); // mesma identidade: contatos não precisam reverificar
    await watcher.next('session.revoked');
    await assert.rejects(() => other.api.me(), status(401));
    assert.equal((await m.session.api.me()).user.handle, 'trocasenha@conta'); // a sessão atual continua
  });

  it('desativar uma conta derruba sessões, apaga mensagens e impede novo login', async () => {
    const a = await srv.member(admin, 'sai', 'senha-sai-1234');
    const b = await srv.member(admin, 'fica', 'senha-fica-1234');
    await b.session.send(a.session.user.id, 'pendente para quem sai');
    const watcher = watch(a.session);
    await watcher.ready;

    await admin.api.disableMember(a.id);
    await watcher.next('session.revoked');
    await assert.rejects(() => a.session.api.me(), status(401));
    await assert.rejects(() => srv.login('sai@conta', a.password), status(403));
    assert.equal(srv.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ?').get(a.id)!.n, 0);
    assert.ok(!(await b.session.loadContacts()).some((c) => c.id === a.id));
    await assert.rejects(() => b.session.send(a.session.user.id, 'oi'), status(404));

    await admin.api.enableMember(a.id);
    const back = await srv.login('sai@conta', a.password);
    assert.equal(back.user.handle, 'sai@conta');
    // O administrador não pode se desativar nem se resetar pela API.
    await assert.rejects(() => admin.api.disableMember(admin.user.id), status(400));
    await assert.rejects(() => admin.api.resetActivation(admin.user.id), status(400));
  });

  it('"esqueci a senha": o administrador zera a conta; o usuário ativa de novo com chaves novas', async () => {
    const m = await srv.member(admin, 'esqueceu', 'senha-esquecida-1');
    const oldKey = m.session.publicKey;
    const reset = await admin.api.resetActivation(m.id);
    assert.equal(reset.member.status, 'pending');
    await assert.rejects(() => m.session.api.me(), status(401));
    await assert.rejects(() => srv.login('esqueceu@conta', m.password), status(401));
    const fresh = await srv.activate('esqueceu@conta', reset.activationCode, 'senha-nova-1234');
    assert.notEqual(fresh.publicKey, oldKey);
  });

  it('a CLI/serviço de criação de rede recusa códigos de rede inválidos ou repetidos', () => {
    const cfg = srv.config;
    assert.throws(() => createNetwork(srv.ctx.db, cfg, { slug: 'Inválido!', name: 'X', adminUsername: 'adm', adminDisplayName: 'A' }), /Código da rede/);
    assert.throws(() => createNetwork(srv.ctx.db, cfg, { slug: 'conta', name: 'Repetida', adminUsername: 'adm', adminDisplayName: 'A' }), /Já existe/);
    // Falha no meio não deixa rede órfã (transação).
    assert.throws(() => createNetwork(srv.ctx.db, cfg, { slug: 'orfa', name: 'Órfã', adminUsername: 'X Inválido', adminDisplayName: 'A' }));
    assert.equal(srv.ctx.db.prepare("SELECT COUNT(*) AS n FROM networks WHERE slug = 'orfa'").get()!.n, 0);
  });

  it('o servidor recusa parâmetros de KDF fracos na ativação', async () => {
    const created = await admin.api.createMember({ username: 'fraco', displayName: 'Fraco' });
    const api = new ApiClient({ baseUrl: srv.baseUrl });
    await assert.rejects(
      () =>
        api.activate({
          handle: 'fraco@conta',
          activationCode: created.activationCode,
          kdfSalt: 'A'.repeat(22),
          kdfParams: { alg: 'scrypt', N: 16, r: 8, p: 1 },
          authSecret: 'A'.repeat(43),
          publicKey: 'A'.repeat(43),
          encryptedPrivateKey: 'x'.repeat(40),
        }),
      status(400),
    );
  });
});

describe('tempo real (WebSocket)', () => {
  it('conexão sem autenticação é encerrada; com token inválido também', async () => {
    const srv = await startServer();
    try {
      const url = srv.baseUrl.replace('http', 'ws') + '/ws';
      const closeCode = (send?: string) =>
        new Promise<number>((resolve) => {
          const ws = new WebSocket(url);
          ws.onopen = () => send && ws.send(send);
          ws.onclose = (ev) => resolve(ev.code);
        });
      assert.equal(await closeCode('{"type":"auth","token":"token-falso"}'), 4401);
      assert.equal(await closeCode('isto não é json'), 4400);
      assert.equal(await closeCode('{"type":"oi"}'), 4400);
    } finally {
      await srv.close();
    }
  });
});
