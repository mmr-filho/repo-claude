import { Client } from 'pg';
import { dbSslEnabled, roleName, type CredentialsResolver } from './tenancy';

/**
 * Prepara um cluster PostgreSQL gerenciado (ex.: PlanetScale) usando o papel administrador do provedor:
 * cria os papéis da aplicação e do BI e o banco master. Idempotente: pode rodar a cada partida.
 * Em servidores próprios isso é feito pelo script docker/postgres/01-roles.sql.
 */
export async function bootstrapCluster(opts: { host: string; port: number; masterDb: string; credentials: CredentialsResolver; log?: (m: string) => void }) {
  const log = opts.log ?? (() => {});
  const admin = opts.credentials('default', 'admin');
  const app = opts.credentials('default', 'oltp');
  const bi = opts.credentials('default', 'readonly');
  // No PlanetScale o usuário de conexão leva o id do branch (e "|replica"); o papel em si não tem sufixo.
  const appRole = roleName(app.user);
  const biRole = roleName(bi.user);
  const client = new Client({
    host: opts.host,
    port: opts.port,
    database: process.env.PG_ADMIN_DATABASE ?? 'postgres',
    user: admin.user,
    password: admin.password,
    ssl: dbSslEnabled() ? { rejectUnauthorized: true } : undefined,
  });
  await client.connect();
  const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  try {
    const exists = async (role: string) => (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount! > 0;
    // Senhas vão como literal SQL: CREATE/ALTER ROLE não aceitam parâmetros ($1).
    if (await exists(appRole)) await client.query(`ALTER ROLE ${ident(appRole)} WITH LOGIN PASSWORD ${literal(app.password)}`);
    else await client.query(`CREATE ROLE ${ident(appRole)} LOGIN PASSWORD ${literal(app.password)}`);
    if (!(await exists('omni_bi'))) await client.query('CREATE ROLE omni_bi NOLOGIN');
    if (await exists(biRole)) await client.query(`ALTER ROLE ${ident(biRole)} WITH LOGIN PASSWORD ${literal(bi.password)}`);
    else await client.query(`CREATE ROLE ${ident(biRole)} LOGIN PASSWORD ${literal(bi.password)} IN ROLE omni_bi`);
    await client.query(`ALTER ROLE ${ident(biRole)} SET default_transaction_read_only = on`);
    await client.query(`ALTER ROLE ${ident(biRole)} SET search_path = bi`);
    // Para criar bancos com dono omni_app, o administrador precisa poder assumir esse papel.
    const member = await client.query('SELECT pg_has_role(current_user, $1, $2) AS ok', [appRole, 'SET']);
    if (!member.rows[0].ok) await client.query(`GRANT ${ident(appRole)} TO CURRENT_USER`);
    const db = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [opts.masterDb]);
    if (db.rowCount === 0) {
      await client.query(`CREATE DATABASE ${ident(opts.masterDb)} OWNER ${ident(appRole)}`);
      log(`Banco ${opts.masterDb} criado`);
    }
    log('Papéis e banco master conferidos');
  } finally {
    await client.end();
  }
}
