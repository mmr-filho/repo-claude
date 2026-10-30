import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { appendAudit, hashPassword, tenantSettings, type MasterClient, type TenantClient, type TenantPrisma } from '@omnisaude/database';
import { cboLabel, isValidCns, isValidCpf, onlyDigits, ROLE_LABELS, type Role, type UnitType } from '@omnisaude/shared';
import type { RequestContext } from '../../core/context';
import { MASTER_DB, TenantsService } from '../../core/database';
import { DomainError, notFound } from '../../core/errors';
import { generateProvisionalPassword } from './passwords';
import { linkStaged } from './staged';

export interface UnitInput {
  name: string;
  type: UnitType;
  cnes: string;
  ibgeCode: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  openingHours?: string | null;
  active?: boolean;
}

export interface AssignmentInput {
  unitId: string;
  role: Role;
  cbo: string;
  council?: string | null;
}

export interface UserInput {
  cpf: string;
  cns?: string | null;
  name: string;
  socialName?: string | null;
  email?: string | null;
  phone?: string | null;
  assignments: AssignmentInput[];
}

const userInclude = {
  assignments: { include: { unit: { select: { id: true, name: true, type: true } } }, orderBy: [{ active: 'desc' }, { unit: { name: 'asc' } }, { role: 'asc' }] },
} satisfies TenantPrisma.UserInclude;

type UnitFields = { name?: string; type?: UnitType; cnes?: string; ibgeCode?: string; address?: string | null; phone?: string | null; email?: string | null; openingHours?: string | null };
type PersonFields = { cpf?: string; cns?: string | null; name?: string; socialName?: string | null; email?: string | null; phone?: string | null };

const clean = (value: string | null | undefined) => value?.trim() || null;

/**
 * Cadastros administrativos do tenant (unidades, profissionais e suas lotações, segurança). Toda alteração
 * vai para a trilha de auditoria. Um profissional novo recebe uma senha provisória, mostrada uma única vez,
 * e só usa o sistema depois de trocá-la.
 */
@Injectable()
export class AdminService {
  constructor(
    @Inject(MASTER_DB) private readonly master: MasterClient,
    private readonly tenants: TenantsService,
  ) {}

  // ── Unidades ──

  listUnits(ctx: RequestContext, includeInactive: boolean) {
    return ctx.db.unit.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { assignments: { where: { active: true } } } } },
    });
  }

  async createUnit(ctx: RequestContext, input: UnitInput) {
    return ctx.db.$transaction(async (tx) => {
      const unit = await tx.unit.create({
        data: {
          name: input.name.trim(),
          type: input.type,
          cnes: onlyDigits(input.cnes),
          ibgeCode: onlyDigits(input.ibgeCode),
          address: clean(input.address),
          phone: clean(input.phone),
          email: clean(input.email)?.toLowerCase() ?? null,
          openingHours: clean(input.openingHours),
          active: input.active ?? true,
        },
      });
      await this.audit(tx, ctx, 'unidade.criar', 'Unit', unit.id, { cnes: unit.cnes, name: unit.name });
      return unit;
    });
  }

  async updateUnit(ctx: RequestContext, id: string, input: Partial<UnitInput>) {
    const current = await ctx.db.unit.findUnique({ where: { id } });
    if (!current) throw notFound('Unidade');
    if (input.active === false && id === ctx.session.unitId) {
      throw new DomainError('UNIDADE_EM_USO', 'Não é possível desativar a unidade da sessão atual', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return ctx.db.$transaction(async (tx) => {
      const unit = await tx.unit.update({ where: { id }, data: { ...this.unitData(input), ...(input.active === undefined ? {} : { active: input.active }) } });
      await this.audit(tx, ctx, 'unidade.atualizar', 'Unit', id, input);
      return unit;
    });
  }

  private unitData(input: Partial<UnitInput>): UnitFields {
    const data: UnitFields = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.type !== undefined) data.type = input.type;
    if (input.cnes !== undefined) data.cnes = onlyDigits(input.cnes);
    if (input.ibgeCode !== undefined) data.ibgeCode = onlyDigits(input.ibgeCode);
    if (input.address !== undefined) data.address = clean(input.address);
    if (input.phone !== undefined) data.phone = clean(input.phone);
    if (input.email !== undefined) data.email = clean(input.email)?.toLowerCase() ?? null;
    if (input.openingHours !== undefined) data.openingHours = clean(input.openingHours);
    return data;
  }

  // ── Profissionais ──

  async listUsers(ctx: RequestContext, filter: { q?: string; unitId?: string; role?: Role; includeInactive?: boolean }) {
    const q = filter.q?.trim();
    const digits = q ? onlyDigits(q) : '';
    const rows = await ctx.db.user.findMany({
      where: {
        AND: [
          filter.includeInactive ? {} : { active: true },
          q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { socialName: { contains: q, mode: 'insensitive' } }, ...(digits ? [{ cpf: { contains: digits } }] : [])] } : {},
          filter.unitId || filter.role ? { assignments: { some: { active: true, ...(filter.unitId ? { unitId: filter.unitId } : {}), ...(filter.role ? { role: filter.role } : {}) } } } : {},
        ],
      },
      include: userInclude,
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      take: 500,
    });
    return rows.map((u) => this.userView(u));
  }

  async getUser(ctx: RequestContext, id: string) {
    const user = await ctx.db.user.findUnique({ where: { id }, include: userInclude });
    if (!user) throw notFound('Profissional');
    return this.userView(user);
  }

  /** Cria o acesso com senha provisória; `stagedId` vincula um pré-cadastro vindo do CNES (e suas equipes). */
  async createUser(ctx: RequestContext, input: UserInput & { stagedId?: string | null }) {
    const person = this.personData(input);
    const assignments = await this.validateAssignments(ctx.db, input.assignments);
    const provisionalPassword = generateProvisionalPassword();
    const passwordHash = await hashPassword(provisionalPassword);
    const user = await ctx.db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { ...person, cpf: person.cpf!, name: person.name!, passwordHash, mustChangePassword: true, assignments: { create: assignments } },
        include: userInclude,
      });
      if (input.stagedId) await linkStaged(tx, input.stagedId, created.id);
      await this.audit(tx, ctx, 'profissional.criar', 'User', created.id, { cpf: created.cpf, name: created.name, assignments, stagedId: input.stagedId ?? null });
      return created;
    });
    return { user: this.userView(user), provisionalPassword };
  }

  /** Inclui (ou reativa) uma lotação sem mexer nas demais; usado pela importação de planilhas. */
  async addAssignment(ctx: RequestContext, userId: string, input: AssignmentInput) {
    const [a] = await this.validateAssignments(ctx.db, [input]);
    await ctx.db.$transaction(async (tx) => {
      await tx.userAssignment.upsert({
        where: { userId_unitId_role: { userId, unitId: a!.unitId, role: a!.role } },
        create: { userId, ...a!, active: true },
        update: { cbo: a!.cbo, council: a!.council ?? undefined, active: true },
      });
      await this.audit(tx, ctx, 'profissional.lotacao_incluir', 'User', userId, a);
    });
  }

  async updateUser(ctx: RequestContext, id: string, input: Partial<Omit<UserInput, 'assignments'>> & { active?: boolean }) {
    const current = await ctx.db.user.findUnique({ where: { id } });
    if (!current) throw notFound('Profissional');
    if (id === ctx.session.userId && input.active === false) {
      throw new DomainError('AUTO_DESATIVACAO', 'Você não pode desativar a própria conta', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const person = this.personData(input);
    const user = await ctx.db.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { ...person, ...(input.active === undefined ? {} : { active: input.active }) },
        include: userInclude,
      });
      await this.audit(tx, ctx, input.active === false ? 'profissional.desativar' : 'profissional.atualizar', 'User', id, input);
      return updated;
    });
    return this.userView(user);
  }

  /** Substitui o conjunto de lotações: as que saem ficam inativas (histórico preservado), as demais são criadas ou atualizadas. */
  async replaceAssignments(ctx: RequestContext, id: string, input: AssignmentInput[]) {
    const current = await ctx.db.user.findUnique({ where: { id }, include: { assignments: true } });
    if (!current) throw notFound('Profissional');
    const wanted = await this.validateAssignments(ctx.db, input);
    if (id === ctx.session.userId && !wanted.some((a) => a.unitId === ctx.session.unitId && a.role === ctx.session.role)) {
      throw new DomainError('LOTACAO_EM_USO', 'Não é possível remover a lotação em uso nesta sessão', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const user = await ctx.db.$transaction(async (tx) => {
      for (const a of wanted) {
        await tx.userAssignment.upsert({
          where: { userId_unitId_role: { userId: id, unitId: a.unitId, role: a.role } },
          create: { userId: id, ...a, active: true },
          update: { cbo: a.cbo, council: a.council, active: true },
        });
      }
      const keep = new Set(wanted.map((a) => `${a.unitId}:${a.role}`));
      for (const existing of current.assignments) {
        if (existing.active && !keep.has(`${existing.unitId}:${existing.role}`)) {
          await tx.userAssignment.update({ where: { id: existing.id }, data: { active: false } });
        }
      }
      await this.audit(tx, ctx, 'profissional.lotacoes', 'User', id, { assignments: wanted });
      return tx.user.findUniqueOrThrow({ where: { id }, include: userInclude });
    });
    return this.userView(user);
  }

  /** Nova senha provisória (mostrada uma vez); desbloqueia a conta e exige a troca no próximo acesso. */
  async resetPassword(ctx: RequestContext, id: string) {
    if (id === ctx.session.userId) throw new DomainError('AUTO_REDEFINICAO', 'Troque a própria senha em Minha conta', HttpStatus.UNPROCESSABLE_ENTITY);
    const user = await ctx.db.user.findUnique({ where: { id } });
    if (!user) throw notFound('Profissional');
    const provisionalPassword = generateProvisionalPassword();
    const passwordHash = await hashPassword(provisionalPassword);
    await ctx.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true, failedLogins: 0, lockedUntil: null } });
      await this.audit(tx, ctx, 'profissional.senha_redefinir', 'User', id, {});
    });
    return { provisionalPassword };
  }

  /** Remove o autenticador de quem perdeu o aparelho; o profissional configura outro no próximo acesso. */
  async resetMfa(ctx: RequestContext, id: string) {
    if (id === ctx.session.userId) throw new DomainError('AUTO_REDEFINICAO', 'Troque o próprio autenticador em Minha conta', HttpStatus.UNPROCESSABLE_ENTITY);
    const user = await ctx.db.user.findUnique({ where: { id } });
    if (!user) throw notFound('Profissional');
    await ctx.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { totpSecret: null, mfaEnabled: false } });
      await this.audit(tx, ctx, 'profissional.mfa_redefinir', 'User', id, {});
    });
    return { mfaEnabled: false };
  }

  private personData(input: Partial<UserInput>): PersonFields {
    const data: PersonFields = {};
    if (input.cpf !== undefined) {
      const cpf = onlyDigits(input.cpf);
      if (!isValidCpf(cpf)) throw new DomainError('CPF_INVALIDO', 'CPF inválido', HttpStatus.UNPROCESSABLE_ENTITY);
      data.cpf = cpf;
    }
    if (input.cns !== undefined) {
      const cns = input.cns ? onlyDigits(input.cns) : null;
      if (cns && !isValidCns(cns)) throw new DomainError('CNS_INVALIDO', 'Cartão SUS inválido', HttpStatus.UNPROCESSABLE_ENTITY);
      data.cns = cns;
    }
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.socialName !== undefined) data.socialName = clean(input.socialName);
    if (input.email !== undefined) data.email = clean(input.email)?.toLowerCase() ?? null;
    if (input.phone !== undefined) {
      const phone = clean(input.phone);
      data.phone = phone ? onlyDigits(phone) : null;
    }
    return data;
  }

  private async validateAssignments(db: TenantClient, input: AssignmentInput[]) {
    if (input.length === 0) throw new DomainError('SEM_LOTACAO', 'Informe pelo menos uma lotação (unidade e papel)', HttpStatus.UNPROCESSABLE_ENTITY);
    const seen = new Set<string>();
    for (const a of input) {
      const key = `${a.unitId}:${a.role}`;
      if (seen.has(key)) throw new DomainError('LOTACAO_DUPLICADA', 'Mesma unidade e papel informados duas vezes', HttpStatus.UNPROCESSABLE_ENTITY);
      seen.add(key);
    }
    const unitIds = [...new Set(input.map((a) => a.unitId))];
    const units = await db.unit.findMany({ where: { id: { in: unitIds }, active: true }, select: { id: true } });
    if (units.length !== unitIds.length) throw new DomainError('UNIDADE_INVALIDA', 'Unidade inexistente ou desativada', HttpStatus.UNPROCESSABLE_ENTITY);
    return input.map((a) => ({ unitId: a.unitId, role: a.role, cbo: onlyDigits(a.cbo), council: a.council?.trim() || null }));
  }

  private userView(u: {
    id: string;
    cpf: string;
    cns: string | null;
    name: string;
    socialName: string | null;
    email: string | null;
    phone: string | null;
    active: boolean;
    mfaEnabled: boolean;
    mustChangePassword: boolean;
    lastLoginAt: Date | null;
    lockedUntil: Date | null;
    createdAt: Date;
    assignments: { id: string; unitId: string; role: Role; cbo: string; council: string | null; active: boolean; unit: { id: string; name: string; type: string } }[];
  }) {
    return {
      id: u.id,
      cpf: u.cpf,
      cns: u.cns,
      name: u.name,
      socialName: u.socialName,
      email: u.email,
      phone: u.phone,
      active: u.active,
      mfaEnabled: u.mfaEnabled,
      mustChangePassword: u.mustChangePassword,
      lastLoginAt: u.lastLoginAt,
      locked: !!u.lockedUntil && u.lockedUntil > new Date(),
      createdAt: u.createdAt,
      assignments: u.assignments.map((a) => ({
        id: a.id,
        unitId: a.unitId,
        unitName: a.unit.name,
        unitType: a.unit.type,
        role: a.role,
        roleLabel: ROLE_LABELS[a.role],
        cbo: a.cbo,
        cboLabel: cboLabel(a.cbo) ?? null,
        council: a.council,
        active: a.active,
      })),
    };
  }

  // ── Segurança ──

  security(ctx: RequestContext) {
    return { mfaRequiredRoles: ctx.tenant.settings.mfaRequiredRoles };
  }

  /** Papéis que exigem 2FA ficam nas preferências do tenant (master), que valem para todas as instâncias. */
  async updateSecurity(ctx: RequestContext, input: { mfaRequiredRoles: Role[] }) {
    const t = await this.master.tenant.findUniqueOrThrow({ where: { id: ctx.tenant.id } });
    const settings = { ...tenantSettings(t.settings), mfaRequiredRoles: [...new Set(input.mfaRequiredRoles)] };
    await this.master.tenant.update({ where: { id: ctx.tenant.id }, data: { settings: settings as object } });
    this.tenants.connections.invalidate(ctx.tenant.slug);
    this.tenants.connections.invalidate(ctx.tenant.id);
    await ctx.db.$transaction((tx) => this.audit(tx, ctx, 'seguranca.atualizar', 'Tenant', ctx.tenant.id, input));
    return { mfaRequiredRoles: settings.mfaRequiredRoles };
  }

  private audit(tx: Parameters<typeof appendAudit>[0], ctx: RequestContext, action: string, entityType: string, entityId: string, payload: unknown) {
    return appendAudit(tx, { userId: ctx.session.userId, unitId: ctx.session.unitId, role: ctx.session.role, ip: ctx.ip, mfa: ctx.session.mfa, action, entityType, entityId, payload });
  }
}
