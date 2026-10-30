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
    const tenant = await this.tenants.resolve(claims.tid);
    const db = await this.tenants.client(tenant.id);
    const assignment = await db.userAssignment.findFirst({
      where: { userId: claims.sub, unitId, role, active: true, user: { active: true }, unit: { active: true } },
    });
    if (!assignment) throw new DomainError('CONTEXTO_INVALIDO', 'Você não tem este papel nesta unidade', HttpStatus.FORBIDDEN);
    // Papéis sensíveis (definidos pela gestão em Administração > Segurança) exigem o segundo fator na sessão.
    if (tenant.settings.mfaRequiredRoles.includes(role) && !claims.mfa) {
      const user = await db.user.findUniqueOrThrow({ where: { id: claims.sub }, select: { mfaEnabled: true } });
      throw new DomainError(
        'MFA_OBRIGATORIO',
        user.mfaEnabled
          ? 'Este papel exige o segundo fator: entre de novo com o código do autenticador'
          : 'Este papel exige verificação em duas etapas: configure o autenticador para continuar',
        HttpStatus.FORBIDDEN,
        { mfaEnabled: user.mfaEnabled, role },
      );
    }
    const token = await this.tokens.sign({ ...claims, stage: 'access', unit: unitId, role, cbo: assignment.cbo });
    return { token, permissions: ROLE_PERMISSIONS[role] };
  }

  async me(ctx: RequestContext) {
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId } });
    const unit = await ctx.db.unit.findUniqueOrThrow({ where: { id: ctx.session.unitId } });
    const { aiEnabled, whatsappEnabled, rndsEnabled, icpBrasilEnabled } = ctx.tenant.settings;
    return {
      user: { id: user.id, name: user.socialName ?? user.name, cpf: user.cpf, cns: user.cns, mfaEnabled: user.mfaEnabled, mustChangePassword: user.mustChangePassword },
      tenant: { id: ctx.tenant.id, slug: ctx.tenant.slug, name: ctx.tenant.name, timeZone: ctx.tenant.timeZone },
      context: { unitId: unit.id, unitName: unit.name, unitType: unit.type, role: ctx.session.role, roleLabel: ROLE_LABELS[ctx.session.role], cbo: ctx.cbo, mfa: ctx.session.mfa },
      permissions: ROLE_PERMISSIONS[ctx.session.role],
      features: { aiEnabled, whatsappEnabled, rndsEnabled, icpBrasilEnabled },
      assignments: await this.assignments(ctx.db, user.id),
    };
  }

  /**
   * Gera um novo segredo TOTP sem alterar o atual: ele só passa a valer quando o usuário confirma um código
   * do novo autenticador. Quem já usa 2FA precisa estar numa sessão aberta com o segundo fator para trocá-lo.
   */
  async startMfaSetup(ctx: RequestContext) {
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId } });
    return this.newMfaSetup(ctx.tenant.slug, user, ctx.session.mfa);
  }

  async confirmMfaSetup(ctx: RequestContext, code: string, setupToken: string) {
    await this.enableMfa(ctx.db, { userId: ctx.session.userId, unitId: ctx.session.unitId, role: ctx.session.role, ip: ctx.ip, mfa: ctx.session.mfa }, code, setupToken);
    return { mfaEnabled: true };
  }

  /** Configuração do 2FA ainda na etapa de escolha do contexto (papel que exige o segundo fator). */
  async startPendingMfaSetup(claims: TokenClaims) {
    if (claims.stage !== 'context') throw invalidLogin();
    const tenant = await this.tenants.resolve(claims.tid);
    const db = await this.tenants.client(tenant.id);
    const user = await db.user.findUniqueOrThrow({ where: { id: claims.sub } });
    if (!user.active) throw invalidLogin();
    return this.newMfaSetup(tenant.slug, user, claims.mfa);
  }

  async confirmPendingMfaSetup(claims: TokenClaims, code: string, setupToken: string, ip: string) {
    if (claims.stage !== 'context') throw invalidLogin();
    const db = await this.tenants.client(claims.tid);
    await this.enableMfa(db, { userId: claims.sub, ip, mfa: claims.mfa }, code, setupToken);
    // O código confirmado prova a posse do autenticador: a sessão passa a contar com o segundo fator.
    return { mfaEnabled: true, token: await this.tokens.sign({ ...claims, mfa: true }) };
  }

  private newMfaSetup(slug: string, user: { id: string; cpf: string; mfaEnabled: boolean }, sessionMfa: boolean) {
    if (user.mfaEnabled && !sessionMfa) {
      throw new DomainError('MFA_SESSAO', 'Entre com o código do autenticador atual para trocá-lo', HttpStatus.FORBIDDEN);
    }
    const secret = generateTotpSecret();
    const setupToken = encryptSecret(JSON.stringify({ uid: user.id, secret, exp: Date.now() + 10 * 60_000 }), this.config.DATA_KEY);
    return { secret, otpauthUrl: otpauthUrl(secret, `${slug}:${user.cpf}`), setupToken };
  }

  private async enableMfa(db: TenantClient, who: { userId: string; unitId?: string; role?: Role; ip: string; mfa: boolean }, code: string, setupToken: string) {
    let pending: { uid: string; secret: string; exp: number };
    try {
      pending = JSON.parse(decryptSecret(setupToken, this.config.DATA_KEY));
    } catch {
      throw new DomainError('MFA_CONFIGURACAO', 'Configuração de 2FA inválida: comece de novo', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (pending.uid !== who.userId || pending.exp < Date.now()) {
      throw new DomainError('MFA_CONFIGURACAO', 'Configuração de 2FA expirada: comece de novo', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (!verifyTotp(pending.secret, code)) throw new DomainError('MFA_INVALIDO', 'Código de verificação inválido', HttpStatus.UNPROCESSABLE_ENTITY);
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: who.userId }, data: { totpSecret: encryptSecret(pending.secret, this.config.DATA_KEY), mfaEnabled: true } });
      await appendAudit(tx, { userId: who.userId, unitId: who.unitId, role: who.role, ip: who.ip, mfa: who.mfa, action: 'auth.mfa_ativar', entityType: 'User', entityId: who.userId, payload: {} });
    });
  }

  async changePassword(ctx: RequestContext, current: string, next: string) {
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId } });
    if (!(await verifyPassword(current, user.passwordHash))) throw new DomainError('SENHA_INCORRETA', 'Senha atual incorreta', HttpStatus.UNPROCESSABLE_ENTITY);
    const problems = passwordProblems(next);
    if (problems.length) throw new DomainError('SENHA_FRACA', problems.join('; '), HttpStatus.UNPROCESSABLE_ENTITY);
    if (next === current) throw new DomainError('SENHA_REPETIDA', 'A nova senha precisa ser diferente da atual', HttpStatus.UNPROCESSABLE_ENTITY);
    const passwordHash = await hashPassword(next);
    await ctx.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() } });
      await appendAudit(tx, { userId: user.id, unitId: ctx.session.unitId, role: ctx.session.role, ip: ctx.ip, mfa: ctx.session.mfa, action: 'auth.senha_alterar', entityType: 'User', entityId: user.id, payload: {} });
    });
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
