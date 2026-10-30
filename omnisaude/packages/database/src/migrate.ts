import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

export type SchemaKind = 'master' | 'tenant';

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

/** Pasta com as migrações SQL versionadas (geradas pelo Prisma + scripts manuais). */
export function migrationsDir(kind: SchemaKind): string {
  return join(__dirname, '..', 'prisma', kind, 'migrations');
}

export function loadMigrations(kind: SchemaKind): Migration[] {
  const dir = migrationsDir(kind);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Aplica as migrações pendentes em um banco. Cada migração roda em sua própria transação
 * e um advisory lock impede que duas instâncias migrem o mesmo banco ao mesmo tempo.
 * Uma migração já aplicada cujo conteúdo mudou interrompe o processo: migrações são imutáveis.
 */
export async function applyMigrations(connectionString: string, kind: SchemaKind): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('omnisaude_migrations'))`);
    await client.query(`CREATE TABLE IF NOT EXISTS _omni_migrations (
      name text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM _omni_migrations');
    const done = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const m of loadMigrations(kind)) {
      const previous = done.get(m.name);
      if (previous) {
        if (previous !== m.checksum) throw new Error(`A migração ${m.name} foi alterada depois de aplicada`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO _omni_migrations (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
        await client.query('COMMIT');
        applied.push(m.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falha ao aplicar ${kind}/${m.name}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('omnisaude_migrations'))`).catch(() => {});
    await client.end();
  }
  return applied;
}

export function latestMigration(kind: SchemaKind): string {
  return loadMigrations(kind).at(-1)?.name ?? '';
}
