import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { applyMigrations, createMasterClient, demoFixtures, envCredentials, seedDemo } from '@omnisaude/database';
import { Client } from 'pg';
import request from 'supertest';

/**
 * Sobe a API contra um cluster Postgres real (OMNI_TEST_PG, superusuário) com bancos próprios dos testes:
 * omni_test_master_<arquivo> e tenant_db_t_<arquivo>. O cluster precisa dos papéis de docker/postgres/01-roles.sql.
 */
export const TEST_PG = process.env.OMNI_TEST_PG ?? 'postgresql://postgres@127.0.0.1:54329/postgres';
// Cada arquivo de teste (e cada execução paralela, via OMNI_TEST_SUFFIX) usa bancos próprios.
const SUFFIX = (process.env.OMNI_TEST_SUFFIX ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function names(name: string) {
  const key = `${name}${SUFFIX}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  const slug = `t-${key}`.slice(0, 40);
  return { slug, masterDb: `omni_test_master_${key}`, tenantDb: `tenant_db_${slug.replace(/-/g, '_')}` };
}

export async function pgAvailable(): Promise<boolean> {
  const c = new Client({ connectionString: TEST_PG, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

async function resetDatabases(masterDb: string, tenantDb: string) {
  const c = new Client({ connectionString: TEST_PG });
  await c.connect();
  for (const db of [masterDb, tenantDb]) await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${masterDb} OWNER omni_app`);
  await c.end();
}

export interface TestApp {
  slug: string;
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  login: (staffKey: string, unitName?: string, role?: string) => Promise<string>;
  close: () => Promise<void>;
}

export async function startTestApp(name: string, extraEnv: Record<string, string> = {}): Promise<TestApp> {
  const url = new URL(TEST_PG);
  const { slug: SLUG, masterDb, tenantDb } = names(name);
  Object.assign(process.env, {
    MASTER_DATABASE_URL: `postgresql://omni_app:omni_app@${url.hostname}:${url.port}/${masterDb}`,
    TENANT_DB_HOST: url.hostname,
    TENANT_DB_PORT: url.port,
    TENANT_DB_USER: 'omni_app',
    TENANT_DB_PASSWORD: 'omni_app',
    TENANT_ADMIN_USER: 'omni_admin',
    TENANT_ADMIN_PASSWORD: 'omni_admin',
    TENANT_BI_USER: 'omni_bi_reader',
    TENANT_BI_PASSWORD: 'omni_bi',
    JWT_SECRET: 'segredo-de-teste-com-mais-de-32-caracteres!!',
    DATA_KEY: Buffer.alloc(32, 7).toString('base64'),
    LOCAL_STORAGE_DIR: `/tmp/omni-test-storage-${process.pid}`,
    ...extraEnv,
  });
  await resetDatabases(masterDb, tenantDb);
  await applyMigrations(process.env.MASTER_DATABASE_URL!, 'master');
  const master = createMasterClient(process.env.MASTER_DATABASE_URL!);
  await seedDemo({ master, credentials: envCredentials(), primaryHost: url.hostname, primaryPort: Number(url.port), slug: SLUG });
  await master.$disconnect();

  const { createApp } = await import('../src/main');
  const app = await createApp();
  await app.init();
  const http = () => request(app.getHttpServer());

  const login = async (staffKey: string, unitName?: string, role?: string) => {
    const staff = demoFixtures.STAFF.find((s) => s.key === staffKey);
    if (!staff) throw new Error(`Profissional ${staffKey} não existe na carga de demonstração`);
    const res = await http().post('/api/auth/login').send({ tenant: SLUG, cpf: staff.cpf, password: demoFixtures.DEMO_PASSWORD }).expect(200);
    const assignment = (res.body.assignments as { unitName: string; unitId: string; role: string }[]).find(
      (a) => (!unitName || a.unitName === unitName) && (!role || a.role === role),
    );
    if (!assignment) throw new Error(`Sem lotação ${unitName}/${role} para ${staffKey}`);
    const ctx = await http()
      .post('/api/auth/context')
      .set('authorization', `Bearer ${res.body.token}`)
      .send({ unitId: assignment.unitId, role: assignment.role })
      .expect(200);
    return ctx.body.token as string;
  };

  return { slug: SLUG, app, http, login, close: () => app.close() };
}
