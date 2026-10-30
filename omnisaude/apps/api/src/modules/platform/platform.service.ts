import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { envCredentials, provisionTenant, tenantSettings, verifyPassword, type MasterClient, type NewTenant, type TenantSettings } from '@omnisaude/database';
import { jwtVerify, SignJWT } from 'jose';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import { MASTER_DB, TenantsService } from '../../core/database';
import { DomainError } from '../../core/errors';

/**
 * Operação da plataforma (master_auth_db): provisionamento e parametrização de tenants.
 * Os operadores da plataforma não têm acesso aos dados assistenciais dos tenants.
 */
@Injectable()
export class PlatformService {
  private readonly key: Uint8Array;

  constructor(
    @Inject(MASTER_DB) private readonly master: MasterClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly tenants: TenantsService,
  ) {
    this.key = new TextEncoder().encode(`${config.JWT_SECRET}:plataforma`);
  }

  async login(email: string, password: string, ip: string) {
    const user = await this.master.platformUser.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !user.active || !(await verifyPassword(password, user.passwordHash))) {
      await this.master.platformAudit.create({ data: { action: 'plataforma.login_falha', details: { email }, ip } });
      throw new DomainError('LOGIN_INVALIDO', 'E-mail ou senha incorretos', HttpStatus.UNAUTHORIZED);
    }
    await this.master.platformAudit.create({ data: { action: 'plataforma.login', actorId: user.id, ip } });
    const token = await new SignJWT({ scope: 'platform' }).setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setExpirationTime('4h').sign(this.key);
    return { token, name: user.name };
  }

  async verify(authz: string | undefined): Promise<string> {
    const token = authz?.startsWith('Bearer ') ? authz.slice(7) : '';
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      if (payload.scope !== 'platform' || !payload.sub) throw new Error();
      return payload.sub;
    } catch {
      throw new DomainError('PLATAFORMA_SESSAO', 'Sessão da plataforma inválida', HttpStatus.UNAUTHORIZED);
    }
  }

  async list() {
    const rows = await this.master.tenant.findMany({ include: { database: true, licenses: true }, orderBy: { name: 'asc' } });
    return rows.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      kind: t.kind,
      uf: t.uf,
      status: t.status,
      timeZone: t.timeZone,
      settings: tenantSettings(t.settings),
      database: t.database ? { name: t.database.dbName, host: t.database.primaryHost, replica: t.database.replicaHost, schemaVersion: t.database.schemaVersion } : null,
      licenses: t.licenses,
    }));
  }

  async create(actorId: string, input: Omit<NewTenant, 'primaryHost' | 'primaryPort' | 'replicaHost' | 'replicaPort'>) {
    const result = await provisionTenant(this.master, envCredentials(), {
      ...input,
      primaryHost: process.env.TENANT_DB_HOST ?? 'localhost',
      primaryPort: Number(process.env.TENANT_DB_PORT ?? 5432),
      replicaHost: process.env.TENANT_REPLICA_HOST || undefined,
      replicaPort: process.env.TENANT_REPLICA_PORT ? Number(process.env.TENANT_REPLICA_PORT) : undefined,
    });
    await this.master.platformAudit.create({ data: { action: 'tenant.criar', actorId, tenantId: result.tenantId, details: { slug: input.slug } } });
    return result;
  }

  async update(actorId: string, id: string, input: { status?: 'ATIVO' | 'SUSPENSO' | 'ENCERRADO'; settings?: Partial<TenantSettings> }) {
    const t = await this.master.tenant.findUnique({ where: { id } });
    if (!t) throw new DomainError('NAO_ENCONTRADO', 'Tenant não encontrado', HttpStatus.NOT_FOUND);
    const settings = input.settings ? { ...tenantSettings(t.settings), ...input.settings } : undefined;
    const updated = await this.master.tenant.update({ where: { id }, data: { ...(input.status ? { status: input.status } : {}), ...(settings ? { settings: settings as object } : {}) } });
    await this.master.platformAudit.create({ data: { action: 'tenant.atualizar', actorId, tenantId: id, details: input as object } });
    // O roteamento é cacheado por instância: invalida para a mudança valer já nesta.
    this.tenants.connections.invalidate(t.slug);
    this.tenants.connections.invalidate(t.id);
    return { id: updated.id, status: updated.status, settings: tenantSettings(updated.settings) };
  }
}
