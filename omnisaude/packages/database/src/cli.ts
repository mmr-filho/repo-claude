#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { bootstrapCluster } from './bootstrap';
import type { PrismaClient as MasterClient } from './generated/master/client';
import { applyMigrations } from './migrate';
import { hashPassword, passwordProblems } from './passwords';
import { migrateAllTenants, provisionTenant } from './provision';
import { DEMO_PLATFORM_EMAIL, seedDemo } from './seed/demo';
import { createMasterClient, envCredentials } from './tenancy';

/**
 * Operação da base de dados:
 *   migrate                aplica migrações no master_auth_db e em todos os tenants
 *   tenant:create          provisiona um novo tenant (banco dedicado + roteamento)
 *   seed                   cria o tenant de demonstração "demo" (somente desenvolvimento)
 *   bootstrap              cria papéis e o banco master num PostgreSQL gerenciado (usa TENANT_ADMIN_*)
 *   boot                   partida do container: bootstrap (BOOTSTRAP=true), demo (SEED_DEMO=true) e migrate
 *                          (falha de um tenant fica no log, sem impedir a API de subir)
 *
 * Variáveis: MASTER_DATABASE_URL, TENANT_DB_HOST, TENANT_DB_PORT, TENANT_REPLICA_HOST, TENANT_REPLICA_PORT,
 * TENANT_DB_USER/PASSWORD, TENANT_ADMIN_USER/PASSWORD, TENANT_BI_USER/PASSWORD e, em seed/boot,
 * PLATFORM_ADMIN_EMAIL/PASSWORD (conta de operação da plataforma).
 */
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const masterUrl = required('MASTER_DATABASE_URL');
  const masterDb = decodeURIComponent(new URL(masterUrl).pathname.slice(1));
  const credentials = envCredentials();
  const host = process.env.TENANT_DB_HOST ?? 'localhost';
  const port = Number(process.env.TENANT_DB_PORT ?? 5432);
  const replicaHost = process.env.TENANT_REPLICA_HOST || undefined;
  const replicaPort = process.env.TENANT_REPLICA_PORT ? Number(process.env.TENANT_REPLICA_PORT) : undefined;

  if (command === 'bootstrap' || command === 'boot') {
    if (command === 'bootstrap' || process.env.BOOTSTRAP === 'true') {
      await bootstrapCluster({ host, port, masterDb, credentials, log: console.log });
    }
    if (command === 'bootstrap') return;
    await applyMigrations(masterUrl, 'master');
    const master = createMasterClient(masterUrl);
    try {
      if (process.env.SEED_DEMO === 'true') {
        const result = await seedDemo({ master, credentials, primaryHost: host, primaryPort: port, replicaHost, replicaPort, platformUser: !process.env.PLATFORM_ADMIN_PASSWORD });
        console.log(result.skipped ? `Tenant demo já existe (${result.dbName})` : `Tenant demo criado em ${result.dbName}`);
      }
      await ensurePlatformAdmin(master);
      // Na partida, um tenant com migração falhando não derruba a API dos demais: o erro fica no log.
      for (const r of await migrateAllTenants(master, credentials)) {
        if (r.error) console.error(`${r.slug}: ERRO na migração (o tenant segue na versão anterior): ${r.error}`);
        else console.log(`${r.slug}: ${r.applied.length ? r.applied.join(', ') : 'em dia'}`);
      }
    } finally {
      await master.$disconnect();
    }
    return;
  }

  if (command === 'migrate') {
    const applied = await applyMigrations(masterUrl, 'master');
    console.log(`master_auth_db: ${applied.length ? applied.join(', ') : 'em dia'}`);
    const master = createMasterClient(masterUrl);
    try {
      for (const r of await migrateAllTenants(master, credentials)) {
        console.log(`${r.slug}: ${r.error ? `ERRO ${r.error}` : r.applied.length ? r.applied.join(', ') : 'em dia'}`);
        if (r.error) process.exitCode = 1;
      }
    } finally {
      await master.$disconnect();
    }
    return;
  }

  if (command === 'tenant:create') {
    const { values } = parseArgs({
      args: rest,
      options: {
        slug: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string', default: 'PREFEITURA' },
        cnpj: { type: 'string' },
        ibge: { type: 'string' },
        uf: { type: 'string' },
        tz: { type: 'string', default: 'America/Sao_Paulo' },
      },
    });
    if (!values.slug || !values.name || !values.cnpj || !values.ibge || !values.uf) {
      throw new Error('Uso: tenant:create --slug <slug> --name <nome> --cnpj <cnpj> --ibge <código IBGE> --uf <UF> [--kind CONSORCIO] [--tz America/Manaus]');
    }
    await applyMigrations(masterUrl, 'master');
    const master = createMasterClient(masterUrl);
    try {
      const result = await provisionTenant(master, credentials, {
        slug: values.slug,
        name: values.name,
        kind: values.kind as 'PREFEITURA',
        cnpj: values.cnpj.replace(/\D/g, ''),
        ibgeCode: values.ibge,
        uf: values.uf.toUpperCase(),
        timeZone: values.tz,
        primaryHost: host,
        primaryPort: port,
        replicaHost,
        replicaPort,
      });
      console.log(`Tenant provisionado: ${result.dbName} (${result.tenantId})`);
    } finally {
      await master.$disconnect();
    }
    return;
  }

  if (command === 'seed') {
    await applyMigrations(masterUrl, 'master');
    const master = createMasterClient(masterUrl);
    try {
      const result = await seedDemo({ master, credentials, primaryHost: host, primaryPort: port, replicaHost, replicaPort, platformUser: !process.env.PLATFORM_ADMIN_PASSWORD });
      console.log(result.skipped ? `Tenant demo já populado (${result.dbName})` : `Tenant demo criado em ${result.dbName}`);
      await ensurePlatformAdmin(master);
    } finally {
      await master.$disconnect();
    }
    return;
  }

  throw new Error('Comandos: migrate | tenant:create | seed | bootstrap | boot');
}

/**
 * Com PLATFORM_ADMIN_PASSWORD, a conta de operação da plataforma (que cria e suspende tenants) usa essa senha,
 * e a conta da demonstração, de senha pública, fica desativada. Num endereço público isso é obrigatório.
 */
async function ensurePlatformAdmin(master: MasterClient) {
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!password) return;
  const problems = passwordProblems(password);
  if (problems.length) throw new Error(`PLATFORM_ADMIN_PASSWORD: ${problems.join('; ')}`);
  const email = (process.env.PLATFORM_ADMIN_EMAIL || DEMO_PLATFORM_EMAIL).toLowerCase();
  const passwordHash = await hashPassword(password);
  await master.platformUser.upsert({
    where: { email },
    update: { passwordHash, active: true },
    create: { email, name: 'Operação da Plataforma', passwordHash },
  });
  if (email !== DEMO_PLATFORM_EMAIL) await master.platformUser.updateMany({ where: { email: DEMO_PLATFORM_EMAIL }, data: { active: false } });
  console.log(`Conta da plataforma conferida (${email})`);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Defina ${name}`);
  return v;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
