import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { hashPassword, passwordProblems, verifyPassword, type TenantClient } from '@omnisaude/database';
import { isValidCpf, onlyDigits, ROLE_LABELS, ROLE_PERMISSIONS, type Role } from '@omnisaude/shared';
import { appendAudit } from '@omnisaude/database';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import type { RequestContext } from '../../core/context';
import { decryptSecret, encryptSecret } from '../../core/crypto';
import { TenantsService } from '../../core/database';
import { DomainError } from '../../core/errors';
import { TokenService, type TokenClaims } from '../../core/tokens';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../core/totp';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

const invalidLogin = () => new DomainError('LOGIN_INVALIDO', 'CPF ou senha incorretos', HttpStatus.UNAUTHORIZED);

export interface AssignmentView {
  unitId: string;
  unitName: string;
  unitType: string;
  role: Role;
  roleLabel: string;
  cbo: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly tenants: TenantsService,
    private readonly tokens: TokenService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async login(input: { tenant: string; cpf: string; password: string }, ip: string) {
    const cpf = onlyDigits(input.cpf);
    if (!isValidCpf(cpf)) throw invalidLogin();
    const tenant = await this.tenants.resolve(input.tenant.trim().toLowerCase());
    const db = await this.tenants.client(tenant.id);
    const user = await db.user.findUnique({ where: { cpf } });
    if (!user || !user.active) {
      await hashPassword(input.password); // tempo constante: não revela se o CPF existe
      throw invalidLogin();
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new DomainError('CONTA_BLOQUEADA', `Conta bloqueada por tentativas inválidas até ${user.lockedUntil.toISOString()}`, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      const failures = user.failedLogins + 1;
      await db.user.update({
        where: { id: user.id },
        data: { failedLogins: failures, lockedUntil: failures >= MAX_FAILURES ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null },
      });
      await this.auditLogin(db, user.id, ip, 'auth.falha', { failures });
      throw invalidLogin();
    }
    await db.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });

    const base = { tid: tenant.id, tslug: tenant.slug, sub: user.id };
    if (user.mfaEnabled && user.totpSecret) {
      return { stage: 'mfa' as const, token: await this.tokens.sign({ ...base, stage: 'mfa', mfa: false }) };
    }
    return this.contextStage(db, { ...base, stage: 'context', mfa: false }, ip);
  }

  async verifyMfa(claims: TokenClaims, code: string, ip: string) {
    if (claims.stage !== 'mfa') throw invalidLogin();
    const db = await this.tenants.client(claims.tid);
    const user = await db.user.findUniqueOrThrow({ where: { id: claims.sub } });
    if (!user.totpSecret || !verifyTotp(decryptSecret(user.totpSecret, this.config.DATA_KEY), code)) {
      await this.auditLogin(db, user.id, ip, 'auth.mfa_falha', {});
      throw new DomainError('MFA_INVALIDO', 'Código de verificação inválido', HttpStatus.UNAUTHORIZED);
    }
    return this.contextStage(db, { ...claims, stage: 'context', mfa: true }, ip);
  }

  private async contextStage(db: TenantClient, claims: TokenClaims, ip: string) {
    await db.user.update({ where: { id: claims.sub }, data: { lastLoginAt: new Date() } });
    await this.auditLogin(db, claims.sub, ip, 'auth.login', { mfa: claims.mfa });
    return { stage: 'context' as const, token: await this.tokens.sign(claims), assignments: await this.assignments(db, claims.sub) };
  }

  async assignments(db: TenantClient, userId: string): Promise<AssignmentView[]> {
    const rows = await db.userAssignment.findMany({
      where: { userId, active: true, unit: { active: true } },
      include: { unit: true },
      orderBy: [{ unit: { name: 'asc' } }, { role: 'asc' }],
    });
    return rows.map((a) => ({
      unitId: a.unitId,
      unitName: a.unit.name,
      unitType: a.unit.type,
      role: a.role,
      roleLabel: ROLE_LABELS[a.role],
      cbo: a.cbo,
    }));
  }

  /** Escolhe (ou troca) a unidade e o papel ativos sem novo login. */
  async selectContext(claims: TokenClaims, unitId: string, role: Role) {
    if (claims.stage !== 'context' && claims.stage !== 'access') throw invalidLogin();
    const db = await this.tenants.client(claims.tid);
    const assignment = await db.userAssignment.findFirst({
      where: { userId: claims.sub, unitId, role, active: true, user: { active: true }, unit: { active: true } },
    });
    if (!assignment) throw new DomainError('CONTEXTO_INVALIDO', 'Você não tem este papel nesta unidade', HttpStatus.FORBIDDEN);
    const token = await this.tokens.sign({ ...claims, stage: 'access', unit: unitId, role, cbo: assignment.cbo });
    return { token, permissions: ROLE_PERMISSIONS[role] };
  }

  async me(ctx: RequestContext) {
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId } });
    const unit = await ctx.db.unit.findUniqueOrThrow({ where: { id: ctx.session.unitId } });
    const { aiEnabled, whatsappEnabled, rndsEnabled, icpBrasilEnabled } = ctx.tenant.settings;
    return {
      user: { id: user.id, name: user.socialName ?? user.name, cpf: user.cpf, cns: user.cns, mfaEnabled: user.mfaEnabled },
      tenant: { id: ctx.tenant.id, slug: ctx.tenant.slug, name: ctx.tenant.name, timeZone: ctx.tenant.timeZone },
      context: { unitId: unit.id, unitName: unit.name, unitType: unit.type, role: ctx.session.role, roleLabel: ROLE_LABELS[ctx.session.role], cbo: ctx.cbo, mfa: ctx.session.mfa },
      permissions: ROLE_PERMISSIONS[ctx.session.role],
      features: { aiEnabled, whatsappEnabled, rndsEnabled, icpBrasilEnabled },
      assignments: await this.assignments(ctx.db, user.id),
    };
  }

  async startMfaSetup(ctx: RequestContext) {
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId } });
    const secret = generateTotpSecret();
    await ctx.db.user.update({ where: { id: user.id }, data: { totpSecret: encryptSecret(secret, this.config.DATA_KEY), mfaEnabled: false } });
    return { secret, otpauthUrl: otpauthUrl(secret, `${ctx.tenant.slug}:${user.cpf}`) };
  }

  async confirmMfaSetup(ctx: RequestContext, code: string) {
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId } });
    if (!user.totpSecret || !verifyTotp(decryptSecret(user.totpSecret, this.config.DATA_KEY), code)) {
      throw new DomainError('MFA_INVALIDO', 'Código de verificação inválido', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    await ctx.db.user.update({ where: { id: user.id }, data: { mfaEnabled: true } });
    return { mfaEnabled: true };
  }

  async changePassword(ctx: RequestContext, current: string, next: string) {
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId } });
    if (!(await verifyPassword(current, user.passwordHash))) throw new DomainError('SENHA_INCORRETA', 'Senha atual incorreta', HttpStatus.UNPROCESSABLE_ENTITY);
    const problems = passwordProblems(next);
    if (problems.length) throw new DomainError('SENHA_FRACA', problems.join('; '), HttpStatus.UNPROCESSABLE_ENTITY);
    await ctx.db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(next) } });
    return { ok: true };
  }

  /** Confere a credencial de um segundo profissional (dupla checagem em POPs e administração). */
  async verifyColleague(ctx: RequestContext, cpf: string, password: string) {
    const user = await ctx.db.user.findUnique({ where: { cpf: onlyDigits(cpf) }, include: { assignments: { where: { active: true } } } });
    if (!user || !user.active || !(await verifyPassword(password, user.passwordHash))) {
      throw new DomainError('DUPLA_CHECAGEM_INVALIDA', 'Credencial da dupla checagem inválida', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (user.id === ctx.session.userId) {
      throw new DomainError('DUPLA_CHECAGEM_MESMO_USUARIO', 'A dupla checagem deve ser feita por outro profissional', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const clinical = user.assignments.some((a) => ['ENFERMAGEM', 'MEDICO', 'FARMACIA'].includes(a.role));
    if (!clinical) throw new DomainError('DUPLA_CHECAGEM_PAPEL', 'A dupla checagem exige enfermagem, médico ou farmacêutico', HttpStatus.UNPROCESSABLE_ENTITY);
    return { userId: user.id, name: user.name };
  }

  private auditLogin(db: TenantClient, userId: string, ip: string, action: string, payload: unknown) {
    return db.$transaction((tx) => appendAudit(tx, { userId, ip, mfa: false, action, entityType: 'User', entityId: userId, payload }));
  }
}
