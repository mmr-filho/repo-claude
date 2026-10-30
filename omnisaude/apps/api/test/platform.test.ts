import { Client } from 'pg';
import { latestMigration } from '@omnisaude/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, TEST_PG, type TestApp } from './harness';

const enabled = await pgAvailable();
const SLUG = `plat-novo${(process.env.OMNI_TEST_SUFFIX ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;

describe.runIf(enabled)('operação da plataforma', () => {
  let t: TestApp;
  beforeAll(async () => {
    const c = new Client({ connectionString: TEST_PG });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS tenant_db_${SLUG.replace(/-/g, '_')} WITH (FORCE)`);
    await c.end();
    t = await startTestApp('platform');
  });
  afterAll(async () => {
    await t?.close();
  });

  it('provisiona um tenant, ajusta preferências e suspende o acesso', async () => {
    await t.http().get('/api/platform/tenants').expect(401);
    const login = await t.http().post('/api/platform/login').send({ email: 'plataforma@omnisaude.dev', password: 'OmniSaude2026' }).expect(200);
    const auth = { authorization: `Bearer ${login.body.token}` };
    // O token de um tenant não abre a plataforma.
    const tenantToken = await t.login('gestora');
    await t.http().get('/api/platform/tenants').set('authorization', `Bearer ${tenantToken}`).expect(401);

    const created = await t.http().post('/api/platform/tenants').set(auth).send({ slug: SLUG, name: 'Prefeitura de Teste', kind: 'PREFEITURA', cnpj: '11222333000181', ibgeCode: '1709500', uf: 'TO', timeZone: 'America/Araguaina' }).expect(201);
    expect(created.body.dbName).toBe(`tenant_db_${SLUG.replace(/-/g, '_')}`);
    const list = await t.http().get('/api/platform/tenants').set(auth).expect(200);
    const novo = list.body.find((x: { slug: string }) => x.slug === SLUG);
    expect(novo.status).toBe('ATIVO');
    expect(novo.database.schemaVersion).toBe(latestMigration('tenant'));

    const demo = list.body.find((x: { slug: string }) => x.slug === t.slug);
    const upd = await t.http().patch(`/api/platform/tenants/${demo.id}`).set(auth).send({ settings: { aiEnabled: false } }).expect(200);
    expect(upd.body.settings.aiEnabled).toBe(false);
    await t.http().patch(`/api/platform/tenants/${demo.id}`).set(auth).send({ status: 'SUSPENSO' }).expect(200);
    const res = await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf: '10000000957', password: 'OmniSaude2026' });
    expect(res.status).toBe(403);
  });
});
