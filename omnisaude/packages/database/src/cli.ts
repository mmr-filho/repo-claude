#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { applyMigrations } from './migrate';
import { migrateAllTenants, provisionTenant } from './provision';
import { seedDemo } from './seed/demo';
import { createMasterClient, envCredentials } from './tenancy';

/**
 * Operação da base de dados:
 *   migrate                aplica migrações no master_auth_db e em todos os tenants
 *   tenant:create          provisiona um novo tenant (banco dedicado + roteamento)
 *   seed                   cria o tenant de demonstração "demo" (somente desenvolvimento)
 *
 * Variáveis: MASTER_DATABASE_URL, TENANT_DB_HOST, TENANT_DB_PORT, TENANT_REPLICA_HOST, TENANT_REPLICA_PORT,
 * TENANT_DB_USER/PASSWORD, TENANT_ADMIN_USER/PASSWORD, TENANT_BI_USER/PASSWORD.
 */
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const masterUrl = required('MASTER_DATABASE_URL');
  const credentials = envCredentials();
  const host = process.env.TENANT_DB_HOST ?? 'localhost';
  const port = Number(process.env.TENANT_DB_PORT ?? 5432);
  const replicaHost = process.env.TENANT_REPLICA_HOST || undefined;
  const replicaPort = process.env.TENANT_REPLICA_PORT ? Number(process.env.TENANT_REPLICA_PORT) : undefined;

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
      const result = await seedDemo({ master, credentials, primaryHost: host, primaryPort: port, replicaHost, replicaPort });
      console.log(result.skipped ? `Tenant demo já populado (${result.dbName})` : `Tenant demo criado em ${result.dbName}`);
    } finally {
      await master.$disconnect();
    }
    return;
  }

  throw new Error('Comandos: migrate | tenant:create | seed');
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
