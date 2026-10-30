import { demoFixtures } from '@omnisaude/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../src/core/totp';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();

describe.runIf(enabled)('autenticação e contexto', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp('auth');
  });
  afterAll(async () => {
    await t?.close();
  });

  const medica = demoFixtures.STAFF.find((s) => s.key === 'medica')!;

  it('recusa senha errada e rota sem token', async () => {
    await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf: medica.cpf, password: 'errada123456' }).expect(401);
    await t.http().get('/api/auth/me').expect(401);
  });

  it('faz login, escolhe contexto e respeita a matriz de papéis', async () => {
    const token = await t.login('medica', 'UPA 24h Norte', 'MEDICO');
    const me = await t.http().get('/api/auth/me').set('authorization', `Bearer ${token}`).expect(200);
    expect(me.body.context).toMatchObject({ unitName: 'UPA 24h Norte', role: 'MEDICO', cbo: '225125' });
    expect(me.body.permissions).toContain('prescricao.emitir');
    expect(me.body.assignments.length).toBe(3);
  });

  it('não permite assumir papel que o usuário não tem', async () => {
    const res = await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf: medica.cpf, password: demoFixtures.DEMO_PASSWORD }).expect(200);
    const farmacia = await t.http().get('/api/health').expect(200);
    expect(farmacia.body.status).toBe('ok');
    const unitId = res.body.assignments[0].unitId;
    await t.http().post('/api/auth/context').set('authorization', `Bearer ${res.body.token}`).send({ unitId, role: 'FARMACIA' }).expect(403);
  });

  it('ativa 2FA e exige o código no login seguinte', async () => {
    const token = await t.login('gestora');
    const setup = await t.http().post('/api/auth/mfa/setup').set('authorization', `Bearer ${token}`).expect(201);
    await t.http().post('/api/auth/mfa/enable').set('authorization', `Bearer ${token}`).send({ code: totpCode(setup.body.secret) }).expect(200);
    const gestora = demoFixtures.STAFF.find((s) => s.key === 'gestora')!;
    const step1 = await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf: gestora.cpf, password: demoFixtures.DEMO_PASSWORD }).expect(200);
    expect(step1.body.stage).toBe('mfa');
    await t.http().post('/api/auth/mfa').set('authorization', `Bearer ${step1.body.token}`).send({ code: '000000' }).expect(401);
    const step2 = await t.http().post('/api/auth/mfa').set('authorization', `Bearer ${step1.body.token}`).send({ code: totpCode(setup.body.secret) }).expect(200);
    expect(step2.body.stage).toBe('context');
    const ctx = await t.http().post('/api/auth/context').set('authorization', `Bearer ${step2.body.token}`).send({ unitId: step2.body.assignments[0].unitId, role: 'GESTOR' }).expect(200);
    const me = await t.http().get('/api/auth/me').set('authorization', `Bearer ${ctx.body.token}`).expect(200);
    expect(me.body.context.mfa).toBe(true);
  });

  it('bloqueia a conta após 5 senhas erradas', async () => {
    const social = demoFixtures.STAFF.find((s) => s.key === 'social')!;
    for (let i = 0; i < 5; i++) await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf: social.cpf, password: 'errada000000' }).expect(401);
    await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf: social.cpf, password: demoFixtures.DEMO_PASSWORD }).expect(429);
  });
});

describe.runIf(enabled)('diretório e auditoria', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp('directory');
  });
  afterAll(async () => {
    await t?.close();
  });

  it('lista unidades e profissionais e verifica a trilha encadeada', async () => {
    const token = await t.login('gestora', 'UBS Centro', 'GESTOR');
    const dir = await t.http().get('/api/directory').set('authorization', `Bearer ${token}`).expect(200);
    expect(dir.body.units.length).toBe(8);
    expect(dir.body.professionals.find((p: { name: string }) => p.name.startsWith('Carla')).roles.length).toBe(3);
    const verify = await t.http().get('/api/audit/verify').set('authorization', `Bearer ${token}`).expect(200);
    expect(verify.body.ok).toBe(true);
    expect(verify.body.checked).toBeGreaterThan(5);
    const entries = await t.http().get('/api/audit/entries').set('authorization', `Bearer ${token}`).expect(200);
    expect(entries.body[0].hash).toMatch(/^[0-9a-f]{64}$/);
    const medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    await t.http().get('/api/audit/verify').set('authorization', `Bearer ${medica}`).expect(403);
  });
});
