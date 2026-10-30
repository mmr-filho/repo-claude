import { Controller, Get, Query } from '@nestjs/common';
import { verifyAuditChain } from '@omnisaude/database';
import { ROLE_LABELS } from '@omnisaude/shared';
import { Authenticated, Ctx, RequirePermission, type RequestContext } from '../../core/context';

@Controller()
export class DirectoryController {
  /** Unidades e profissionais do tenant (seleção em agendas, transferências, internações). */
  @Authenticated()
  @Get('directory')
  async directory(@Ctx() ctx: RequestContext, @Query('unitId') unitId?: string) {
    const units = await ctx.db.unit.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, type: true, cnes: true } });
    const assignments = await ctx.db.userAssignment.findMany({
      where: { active: true, user: { active: true }, ...(unitId ? { unitId } : {}) },
      include: { user: { select: { id: true, name: true } } },
    });
    const professionals = new Map<string, { id: string; name: string; roles: { unitId: string; role: string; roleLabel: string; cbo: string }[] }>();
    for (const a of assignments) {
      const p = professionals.get(a.userId) ?? { id: a.user.id, name: a.user.name, roles: [] };
      p.roles.push({ unitId: a.unitId, role: a.role, roleLabel: ROLE_LABELS[a.role], cbo: a.cbo });
      professionals.set(a.userId, p);
    }
    return { units, professionals: [...professionals.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')) };
  }

  /** Últimas entradas da trilha encadeada (sem o conteúdo clínico, que só entra no hash). */
  @RequirePermission('auditoria.ler')
  @Get('audit/entries')
  async entries(@Ctx() ctx: RequestContext, @Query('entityType') entityType?: string, @Query('entityId') entityId?: string) {
    const rows = await ctx.db.auditEntry.findMany({
      where: { ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) },
      orderBy: { seq: 'desc' },
      take: 200,
    });
    const users = new Map((await ctx.db.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return rows.map((r) => ({ ...r, seq: r.seq.toString(), userName: r.userId ? (users.get(r.userId) ?? null) : null }));
  }

  /** Recalcula a cadeia de hashes inteira e aponta a primeira entrada adulterada, se houver. */
  @RequirePermission('auditoria.ler')
  @Get('audit/verify')
  async verify(@Ctx() ctx: RequestContext) {
    const r = await verifyAuditChain(ctx.db);
    return { ...r, brokenAt: r.brokenAt?.toString() ?? null };
  }
}
