import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLocalVaultStore, SigiloSession, WrongPasswordError, jsScrypt, type ScryptFn } from '@sigilo/core';
import { KDF_POLICY, startServer } from './harness.js';

const SERVER_N = 2048; // custo "forte" do servidor (contas novas)
const LOCAL_N = 1024; // custo do cofre local

describe('cofre local: desbloqueio rápido sem enfraquecer o login', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let adminHandle: string;
  let activationCode: string;
  const calls: number[] = [];

  const countingScrypt: ScryptFn = (pw, salt, opts) => {
    calls.push(opts.N);
    return jsScrypt(pw, salt, opts);
  };
  const opts = (store: MemoryLocalVaultStore) => ({
    baseUrl: srv.baseUrl,
    kdfPolicy: KDF_POLICY,
    localVault: store,
    localKdf: { alg: 'scrypt' as const, N: LOCAL_N, r: 8, p: 1 },
    scrypt: countingScrypt,
  });

  before(async () => {
    srv = await startServer({ kdfDefaults: { alg: 'scrypt', N: SERVER_N, r: 8, p: 1 } });
    const { createNetwork } = await import('../src/services.js');
    const created = createNetwork(srv.ctx.db, srv.config, { slug: 'cofre', name: 'Cofre', adminUsername: 'adm', adminDisplayName: 'Adm' });
    adminHandle = created.member.handle;
    activationCode = created.activationCode;
  });
  after(() => srv.close());

  it('ativação grava o cofre local; reabrir o app e desbloquear usa só o KDF barato', async () => {
    const store = new MemoryLocalVaultStore();
    calls.length = 0;
    const first = await SigiloSession.activate({ ...opts(store), handle: adminHandle, activationCode, password: 'senha-forte-aqui' });
    assert.deepEqual(calls, [SERVER_N, LOCAL_N], 'ativação: um KDF forte (servidor) e um barato (cofre local)');
    assert.ok(store.record, 'cofre local gravado');

    // "Reabre o app": só tem o token. Cofre trancado.
    calls.length = 0;
    const reopened = await SigiloSession.resume({ ...opts(store), token: first.token });
    assert.equal(reopened.isUnlocked, false);
    await reopened.unlock('senha-forte-aqui');
    assert.equal(reopened.isUnlocked, true);
    assert.deepEqual(calls, [LOCAL_N], 'desbloqueio rápido: nenhum KDF forte');
  });

  it('senha errada é recusada pelo caminho rápido, sem cair no lento', async () => {
    const store = new MemoryLocalVaultStore();
    const s = await SigiloSession.login({ ...opts(store), handle: adminHandle, password: 'senha-forte-aqui' });
    const reopened = await SigiloSession.resume({ ...opts(store), token: s.token });
    calls.length = 0;
    await assert.rejects(() => reopened.unlock('senha-errada-123'), WrongPasswordError);
    assert.deepEqual(calls, [LOCAL_N]);
    assert.equal(reopened.isUnlocked, false);
  });

  it('sem cofre local (outro aparelho/dados limpos) cai no envelope forte e recria o cofre', async () => {
    const store = new MemoryLocalVaultStore();
    const s = await SigiloSession.login({ ...opts(store), handle: adminHandle, password: 'senha-forte-aqui' });
    const bare = new MemoryLocalVaultStore();
    const reopened = await SigiloSession.resume({ ...opts(bare), token: s.token });
    calls.length = 0;
    await reopened.unlock('senha-forte-aqui');
    assert.deepEqual(calls, [SERVER_N, LOCAL_N]);
    assert.ok(bare.record);
    // O servidor continua exigindo a senha: sem cofre local, senha errada também falha.
    const other = new MemoryLocalVaultStore();
    const again = await SigiloSession.resume({ ...opts(other), token: s.token });
    await assert.rejects(() => again.unlock('errada-errada'), WrongPasswordError);
    assert.equal(other.record, null);
  });

  it('cofre local de uma conta antiga (chave pública diferente) é ignorado', async () => {
    const store = new MemoryLocalVaultStore();
    const s = await SigiloSession.login({ ...opts(store), handle: adminHandle, password: 'senha-forte-aqui' });
    store.record = { ...store.record!, pk: 'A'.repeat(43) };
    const reopened = await SigiloSession.resume({ ...opts(store), token: s.token });
    calls.length = 0;
    await reopened.unlock('senha-forte-aqui');
    assert.deepEqual(calls, [SERVER_N, LOCAL_N]);
    assert.notEqual(store.record!.pk, 'A'.repeat(43));
  });

  it('troca de senha reembrulha o cofre local: a antiga deixa de abrir, a nova abre', async () => {
    const store = new MemoryLocalVaultStore();
    const s = await SigiloSession.login({ ...opts(store), handle: adminHandle, password: 'senha-forte-aqui' });
    await s.changePassword('senha-forte-aqui', 'outra-senha-forte');
    const reopened = await SigiloSession.resume({ ...opts(store), token: s.token });
    await assert.rejects(() => reopened.unlock('senha-forte-aqui'), WrongPasswordError);
    calls.length = 0;
    await reopened.unlock('outra-senha-forte');
    assert.deepEqual(calls, [LOCAL_N]);
    // Volta para a senha original para não afetar outros testes.
    await reopened.changePassword('outra-senha-forte', 'senha-forte-aqui');
  });

  it('logout apaga o cofre local', async () => {
    const store = new MemoryLocalVaultStore();
    const s = await SigiloSession.login({ ...opts(store), handle: adminHandle, password: 'senha-forte-aqui' });
    assert.ok(store.record);
    await s.logout();
    assert.equal(store.record, null);
  });

  it('o cofre local guardado não contém a chave privada em claro', async () => {
    const store = new MemoryLocalVaultStore();
    await SigiloSession.login({ ...opts(store), handle: adminHandle, password: 'senha-forte-aqui' });
    const json = JSON.stringify(store.record);
    assert.match(json, /"v":1/);
    assert.ok(!json.includes('senha-forte-aqui'));
    assert.ok(JSON.parse(store.record!.wrapped).c.length > 40); // texto cifrado + etiqueta de autenticação
  });
});
