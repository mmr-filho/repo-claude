import { HttpStatus, Injectable } from '@nestjs/common';
import { localDateString } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { TenantsService } from '../../core/database';
import { DomainError, notFound } from '../../core/errors';
import { RealtimeService } from '../../core/realtime.service';
import { TokenService } from '../../core/tokens';

const PREFIX = { NORMAL: 'N', PRIORIDADE: 'P' } as const;

/** Leitura do código da senha para a síntese de voz do painel: "N003" -> "N, 0, 0, 3". */
export function spokenTicket(code: string, desk: string): string {
  return `Senha ${code.split('').join(', ')}. ${desk}.`;
}

@Injectable()
export class ReceptionService {
  constructor(
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly tokens: TokenService,
    private readonly tenants: TenantsService,
  ) {}

  /** Emite a próxima senha do dia; a numeração recomeça a cada dia e é separada por tipo. */
  async issue(ctx: RequestContext, input: { kind: 'NORMAL' | 'PRIORIDADE'; sector?: string; patientId?: string }) {
    const day = localDateString(new Date(), ctx.tenant.timeZone);
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await ctx.db.ticket.findFirst({ where: { unitId: ctx.session.unitId, day, kind: input.kind }, orderBy: { sequence: 'desc' } });
      const sequence = (last?.sequence ?? 0) + 1;
      try {
        const ticket = await ctx.db.ticket.create({
          data: {
            unitId: ctx.session.unitId,
            day,
            sequence,
            kind: input.kind,
            code: `${PREFIX[input.kind]}${String(sequence).padStart(3, '0')}`,
            sector: input.sector ?? 'RECEPCAO',
            patientId: input.patientId ?? null,
          },
        });
        this.realtime.emitToUnit(ctx.tenant.id, ctx.session.unitId, 'fila.atualizada', { ticketId: ticket.id });
        return ticket;
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }
    throw new DomainError('SENHA_CONCORRENCIA', 'Não foi possível emitir a senha, tente de novo', HttpStatus.CONFLICT);
  }

  list(ctx: RequestContext, status?: string) {
    const day = localDateString(new Date(), ctx.tenant.timeZone);
    return ctx.db.ticket.findMany({
      where: { unitId: ctx.session.unitId, day, ...(status ? { status: status as never } : {}) },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    });
  }

  private async ticket(ctx: RequestContext, id: string) {
    const t = await ctx.db.ticket.findFirst({ where: { id, unitId: ctx.session.unitId } });
    if (!t) throw notFound('Senha');
    return t;
  }

  async call(ctx: RequestContext, id: string, desk: string) {
    const t = await this.ticket(ctx, id);
    if (t.status === 'FINALIZADA') throw new DomainError('SENHA_FINALIZADA', 'Senha já finalizada');
    const updated = await ctx.db.ticket.update({
      where: { id },
      data: { status: 'CHAMADA', desk, calledAt: new Date(), calledBy: ctx.session.userId, callCount: { increment: 1 } },
    });
    let firstName: string | null = null;
    if (t.patientId) {
      const p = await ctx.db.patient.findUnique({ where: { id: t.patientId }, select: { name: true, socialName: true } });
      // Painel público: só o primeiro nome (o nome social, quando houver).
      firstName = (p?.socialName ?? p?.name ?? '').split(' ')[0] || null;
    }
    const event = { ticketId: id, code: updated.code, kind: updated.kind, desk, sector: updated.sector, firstName, callCount: updated.callCount, calledAt: updated.calledAt, speech: spokenTicket(updated.code, desk) };
    this.realtime.emitToUnit(ctx.tenant.id, ctx.session.unitId, 'senha.chamada', event);
    return event;
  }

  /** Chama a próxima: atendimento prioritário (Lei 10.048/2000) antes da fila normal. */
  async callNext(ctx: RequestContext, desk: string, sector?: string) {
    const day = localDateString(new Date(), ctx.tenant.timeZone);
    const next = await ctx.db.ticket.findFirst({
      where: { unitId: ctx.session.unitId, day, status: 'AGUARDANDO', ...(sector ? { sector } : {}) },
      orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }],
    });
    if (!next) throw new DomainError('FILA_VAZIA', 'Não há senhas aguardando', HttpStatus.NOT_FOUND);
    return this.call(ctx, next.id, desk);
  }

  async absent(ctx: RequestContext, id: string) {
    await this.ticket(ctx, id);
    return ctx.db.ticket.update({ where: { id }, data: { status: 'AUSENTE' } });
  }

  /**
   * Acolhimento da demanda espontânea (sem agendamento): vincula a senha ao paciente e abre o atendimento,
   * que entra na fila da classificação de risco.
   */
  async checkIn(ctx: RequestContext, input: { patientId: string; kind: 'URGENCIA' | 'AMBULATORIAL' | 'ODONTOLOGICO'; ticketId?: string }) {
    const patient = await ctx.db.patient.findUnique({ where: { id: input.patientId } });
    if (!patient) throw notFound('Paciente');
    const open = await ctx.db.encounter.findFirst({ where: { patientId: input.patientId, unitId: ctx.session.unitId, status: { in: ['ABERTO', 'TRIADO', 'EM_ATENDIMENTO'] } } });
    if (open) throw new DomainError('ATENDIMENTO_ABERTO', 'Paciente já tem atendimento aberto nesta unidade', HttpStatus.CONFLICT, { encounterId: open.id });
    const enc = await ctx.db.$transaction(async (tx) => {
      const e = await tx.encounter.create({
        data: { unitId: ctx.session.unitId, patientId: input.patientId, kind: input.kind, ticketId: input.ticketId ?? null, createdBy: ctx.session.userId },
      });
      if (input.ticketId) await tx.ticket.update({ where: { id: input.ticketId }, data: { patientId: input.patientId, encounterId: e.id, status: 'FINALIZADA' } });
      await this.audit.record(ctx, tx, { action: 'recepcao.acolhimento', entityType: 'Encounter', entityId: e.id, payload: input });
      return e;
    });
    this.realtime.emitToUnit(ctx.tenant.id, ctx.session.unitId, 'fila.atualizada', { encounterId: enc.id });
    return enc;
  }

  async panelToken(ctx: RequestContext) {
    const token = await this.tokens.sign({ stage: 'panel', tid: ctx.tenant.id, tslug: ctx.tenant.slug, sub: ctx.session.userId, mfa: false, unit: ctx.session.unitId });
    return { token, expiresInDays: 30 };
  }

  /** Estado inicial do painel (TV), autenticado pelo token de painel. */
  async panelState(token: string) {
    const claims = await this.tokens.verify(token);
    if (!claims || claims.stage !== 'panel' || !claims.unit) throw new DomainError('PAINEL_TOKEN', 'Token de painel inválido', HttpStatus.UNAUTHORIZED);
    const tenant = await this.tenants.resolve(claims.tid);
    const db = await this.tenants.client(tenant.id);
    const unit = await db.unit.findUniqueOrThrow({ where: { id: claims.unit } });
    const day = localDateString(new Date(), tenant.timeZone);
    const calls = await db.ticket.findMany({ where: { unitId: unit.id, day, calledAt: { not: null } }, orderBy: { calledAt: 'desc' }, take: 6 });
    return { unitName: unit.name, tenantName: tenant.name, lastCalls: calls.map((c) => ({ code: c.code, desk: c.desk, calledAt: c.calledAt, kind: c.kind })) };
  }
}
