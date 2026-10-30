import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient as MasterClient } from './generated/master/client';
import { PrismaClient as TenantClient } from './generated/tenant/client';
import { tenantSettings, type TenantSettings } from './settings';

export interface DbCredentials {
  user: string;
  password: string;
}

/** oltp: aplicação; readonly: BI na réplica (papel omni_bi); admin: CREATE DATABASE no provisionamento. */
export type CredentialPurpose = 'oltp' | 'readonly' | 'admin';
export type CredentialsResolver = (ref: string, purpose: CredentialPurpose) => DbCredentials;

/**
 * Credenciais vindas do ambiente (ou de um cofre que as injeta como variáveis).
 * oltp: TENANT_DB_USER/PASSWORD; readonly: TENANT_BI_*; admin: TENANT_ADMIN_*.
 * Um ref diferente de "default" (ex.: "sp") procura antes TENANT_DB_SP_USER etc.
 */
export function envCredentials(env: NodeJS.ProcessEnv = process.env): CredentialsResolver {
  return (ref, purpose) => {
    const scope = ref === 'default' ? '' : `${ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
    const kind = purpose === 'readonly' ? 'BI' : purpose === 'admin' ? 'ADMIN' : 'DB';
    const user = env[`TENANT_${kind}_${scope}USER`] ?? env[`TENANT_${kind}_USER`];
    const password = env[`TENANT_${kind}_${scope}PASSWORD`] ?? env[`TENANT_${kind}_PASSWORD`];
    if (!user || password === undefined) throw new Error(`Credenciais ${purpose} não configuradas para "${ref}"`);
    return { user, password };
  };
}

export function connectionUrl(host: string, port: number, database: string, cred: DbCredentials, ssl = false): string {
  const u = new URL(`postgresql://${host}:${port}/${encodeURIComponent(database)}`);
  u.username = cred.user;
  u.password = cred.password;
  if (ssl) u.searchParams.set('sslmode', 'require');
  return u.toString();
}

export function createMasterClient(connectionString: string): MasterClient {
  return new MasterClient({ adapter: new PrismaPg({ connectionString }) });
}

export interface TenantInfo {
  id: string;
  slug: string;
  name: string;
  status: string;
  timeZone: string;
  settings: TenantSettings;
  db: {
    name: string;
    primaryHost: string;
    primaryPort: number;
    replicaHost: string | null;
    replicaPort: number | null;
    credentialsRef: string;
  };
}

export interface TenantConnectionOptions {
  credentials: CredentialsResolver;
  /** Quantos tenants mantêm conexões abertas ao mesmo tempo (os menos usados são fechados). */
  maxOpenTenants?: number;
  poolSize?: number;
  ssl?: boolean;
  /** Tempo de cache do catálogo de roteamento. */
  catalogTtlMs?: number;
  /** Limite de tempo das consultas analíticas na réplica. */
  biStatementTimeoutMs?: number;
}

interface OpenTenant {
  client: TenantClient;
  readonly?: Pool;
  lastUsed: number;
}

/**
 * Roteamento dinâmico database-per-tenant: resolve o tenant no catálogo do master_auth_db
 * e mantém um PrismaClient por banco (LRU), além de um pool somente leitura para a réplica analítica.
 */
export class TenantConnectionManager {
  private readonly catalog = new Map<string, { info: TenantInfo; at: number }>();
  private readonly open = new Map<string, OpenTenant>();
  private readonly opening = new Map<string, Promise<OpenTenant>>();

  constructor(
    private readonly master: MasterClient,
    private readonly options: TenantConnectionOptions,
  ) {}

  async resolve(slugOrId: string): Promise<TenantInfo> {
    const ttl = this.options.catalogTtlMs ?? 60_000;
    const cached = this.catalog.get(slugOrId);
    if (cached && Date.now() - cached.at < ttl) return cached.info;
    const isUuid = /^[0-9a-f-]{36}$/i.test(slugOrId);
    const tenant = await this.master.tenant.findUnique({
      where: isUuid ? { id: slugOrId } : { slug: slugOrId },
      include: { database: true },
    });
    if (!tenant || !tenant.database) throw new TenantNotFoundError(slugOrId);
    const info: TenantInfo = {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      timeZone: tenant.timeZone,
      settings: tenantSettings(tenant.settings),
      db: {
        name: tenant.database.dbName,
        primaryHost: tenant.database.primaryHost,
        primaryPort: tenant.database.primaryPort,
        replicaHost: tenant.database.replicaHost,
        replicaPort: tenant.database.replicaPort,
        credentialsRef: tenant.database.credentialsRef,
      },
    };
    this.catalog.set(tenant.id, { info, at: Date.now() });
    this.catalog.set(tenant.slug, { info, at: Date.now() });
    return info;
  }

  /** Esquece o cache do catálogo (ex.: tenant suspenso ou migrado de servidor). */
  invalidate(slugOrId?: string): void {
    if (slugOrId) this.catalog.delete(slugOrId);
    else this.catalog.clear();
  }

  /** Confere o status a cada uso (cache de catalogTtlMs): tenant suspenso perde o acesso mesmo com conexão aberta. */
  async client(tenantId: string): Promise<TenantClient> {
    const info = await this.resolve(tenantId);
    if (info.status !== 'ATIVO') throw new TenantUnavailableError(info.slug, info.status);
    return (await this.openTenant(info.id)).client;
  }

  /**
   * Pool para BI/Text-to-SQL: réplica de leitura (ou o primário, se não houver réplica),
   * com o papel omni_bi, search_path restrito ao schema "bi", transações somente leitura e timeout.
   */
  async readonlyPool(tenantId: string): Promise<Pool> {
    const info = await this.resolve(tenantId);
    if (info.status !== 'ATIVO') throw new TenantUnavailableError(info.slug, info.status);
    const t = await this.openTenant(info.id);
    if (!t.readonly) {
      const cred = this.options.credentials(info.db.credentialsRef, 'readonly');
      const timeout = this.options.biStatementTimeoutMs ?? 15_000;
      t.readonly = new Pool({
        host: info.db.replicaHost ?? info.db.primaryHost,
        port: info.db.replicaPort ?? info.db.primaryPort,
        database: info.db.name,
        user: cred.user,
        password: cred.password,
        max: 4,
        ssl: this.options.ssl ? { rejectUnauthorized: true } : undefined,
        options: `-c search_path=bi -c default_transaction_read_only=on -c statement_timeout=${timeout}`,
      });
    }
    return t.readonly;
  }

  private async openTenant(tenantId: string): Promise<OpenTenant> {
    const existing = this.open.get(tenantId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    let pending = this.opening.get(tenantId);
    if (!pending) {
      pending = this.connect(tenantId).finally(() => this.opening.delete(tenantId));
      this.opening.set(tenantId, pending);
    }
    return pending;
  }

  private async connect(tenantId: string): Promise<OpenTenant> {
    const info = await this.resolve(tenantId);
    if (info.status !== 'ATIVO') throw new TenantUnavailableError(info.slug, info.status);
    const cred = this.options.credentials(info.db.credentialsRef, 'oltp');
    const adapter = new PrismaPg({
      connectionString: connectionUrl(info.db.primaryHost, info.db.primaryPort, info.db.name, cred, this.options.ssl),
      max: this.options.poolSize ?? 10,
    });
    const entry: OpenTenant = { client: new TenantClient({ adapter }), lastUsed: Date.now() };
    this.open.set(info.id, entry);
    await this.evict();
    return entry;
  }

  private async evict(): Promise<void> {
    const max = this.options.maxOpenTenants ?? 50;
    while (this.open.size > max) {
      const [oldestId, oldest] = [...this.open.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]!;
      this.open.delete(oldestId);
      await Promise.allSettled([oldest.client.$disconnect(), oldest.readonly?.end()]);
    }
  }

  async close(): Promise<void> {
    const all = [...this.open.values()];
    this.open.clear();
    await Promise.allSettled(all.flatMap((t) => [t.client.$disconnect(), t.readonly?.end()]));
  }
}

export class TenantNotFoundError extends Error {
  constructor(public readonly tenant: string) {
    super(`Tenant não encontrado: ${tenant}`);
  }
}

export class TenantUnavailableError extends Error {
  constructor(
    public readonly tenant: string,
    public readonly status: string,
  ) {
    super(`Tenant ${tenant} indisponível (${status})`);
  }
}
