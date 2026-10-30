import { Client } from 'pg';
import type { PrismaClient as MasterClient } from './generated/master/client';
import { applyMigrations, latestMigration } from './migrate';
import type { TenantSettings } from './settings';
import { connectionUrl, type CredentialsResolver } from './tenancy';

export interface NewTenant {
  slug: string;
  name: string;
  kind: 'PREFEITURA' | 'CONSORCIO' | 'ESTADO' | 'OUTRO';
  cnpj: string;
  ibgeCode: string;
  uf: string;
  timeZone?: string;
  settings?: Partial<TenantSettings>;
  primaryHost: string;
  primaryPort?: number;
  replicaHost?: string;
  replicaPort?: number;
  credentialsRef?: string;
}

export function tenantDbName(slug: string): string {
  return `tenant_db_${slug.replace(/-/g, '_')}`;
}

/**
 * Cria o banco dedicado do tenant, aplica as migrações e registra o roteamento no master.
 * Idempotente: pode ser executado de novo para terminar um provisionamento interrompido.
 */
export async function provisionTenant(master: MasterClient, credentials: CredentialsResolver, input: NewTenant) {
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(input.slug)) throw new Error('Slug deve ter de 3 a 40 caracteres: letras minúsculas, números e hífen');
  const dbName = tenantDbName(input.slug);
  const credentialsRef = input.credentialsRef ?? 'default';
  const port = input.primaryPort ?? 5432;

  const tenant = await master.tenant.upsert({
    where: { slug: input.slug },
    update: {},
    create: {
      slug: input.slug,
      name: input.name,
      kind: input.kind,
      cnpj: input.cnpj,
      ibgeCode: input.ibgeCode,
      uf: input.uf,
      timeZone: input.timeZone ?? 'America/Sao_Paulo',
      settings: (input.settings ?? {}) as object,
      status: 'PROVISIONANDO',
      database: {
        create: {
          dbName,
          primaryHost: input.primaryHost,
          primaryPort: port,
          replicaHost: input.replicaHost ?? null,
          replicaPort: input.replicaPort ?? null,
          credentialsRef,
        },
      },
    },
  });

  const admin = credentials(credentialsRef, 'admin');
  const owner = credentials(credentialsRef, 'oltp');
  const adminClient = new Client({ host: input.primaryHost, port, database: 'postgres', user: admin.user, password: admin.password });
  await adminClient.connect();
  try {
    const exists = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      // Identificadores não aceitam parâmetros; o nome já foi validado pelo padrão do slug.
      await adminClient.query(`CREATE DATABASE "${dbName}" OWNER "${owner.user.replace(/"/g, '')}"`);
    }
  } finally {
    await adminClient.end();
  }

  await applyMigrations(connectionUrl(input.primaryHost, port, dbName, owner), 'tenant');
  await master.tenant.update({
    where: { id: tenant.id },
    data: { status: 'ATIVO', database: { update: { schemaVersion: latestMigration('tenant'), migratedAt: new Date() } } },
  });
  await master.platformAudit.create({ data: { action: 'tenant.provisionado', tenantId: tenant.id, details: { dbName } } });
  return { tenantId: tenant.id, dbName };
}

/** Aplica migrações pendentes em todos os bancos de tenant ativos (usado em cada deploy). */
export async function migrateAllTenants(master: MasterClient, credentials: CredentialsResolver) {
  const tenants = await master.tenant.findMany({ where: { status: { in: ['ATIVO', 'PROVISIONANDO'] } }, include: { database: true } });
  const results: { slug: string; applied: string[]; error?: string }[] = [];
  for (const t of tenants) {
    if (!t.database) continue;
    try {
      const cred = credentials(t.database.credentialsRef, 'oltp');
      const url = connectionUrl(t.database.primaryHost, t.database.primaryPort, t.database.dbName, cred);
      const applied = await applyMigrations(url, 'tenant');
      if (applied.length) {
        await master.tenantDatabase.update({
          where: { tenantId: t.id },
          data: { schemaVersion: latestMigration('tenant'), migratedAt: new Date() },
        });
      }
      results.push({ slug: t.slug, applied });
    } catch (err) {
      results.push({ slug: t.slug, applied: [], error: (err as Error).message });
    }
  }
  return results;
}
