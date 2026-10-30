import { Injectable, type OnModuleInit } from '@nestjs/common';
import { fromZonedParts, localDateString, zonedParts } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { conflict, DomainError, notFound } from '../../core/errors';
import { RealtimeService } from '../../core/realtime.service';
import { MessagingService, type AppointmentReply, type SystemContext } from '../integrations/messaging.service';

const ACTIVE = ['AGENDADO', 'CONFIRMADO', 'ATENDIDO', 'FALTOU'] as const;

export interface Slot {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: 'LIVRE' | 'OCUPADO' | 'BLOQUEADO' | 'PASSADO';
  ruleId: string;
  appointmentId?: string;
}

type Sys = SystemContext & Partial<Pick<RequestContext, 'session'>>;

/** Identificador curto e estável de um horário (aceito nos botões do WhatsApp). */
const slotId = (d: Date) => Math.floor(d.getTime() / 60_000).toString(36);
const slotFromId = (id: string) => new Date(parseInt(id, 36) * 60_000);

@Injectable()
export class SchedulingService implements OnModuleInit {
  constructor(
    private readonly audit: AuditService,
    private readonly messaging: MessagingService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit() {
    this.messaging.onAppointmentReply((sys, reply) => this.handleWhatsAppReply(sys, reply));
  }

  listSchedules(ctx: RequestContext, unitId?: string) {
    return ctx.db.schedule.findMany({
      where: { unitId: unitId ?? ctx.session.unitId, active: true },
      include: { rules: { orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }] } },
      orderBy: { name: 'asc' },
    });
  }

  async createSchedule(ctx: RequestContext, input: { professionalId: string; name: string; cbo: string; slotMinutes: number; unitId?: string; rules: { weekday: number; startTime: string; endTime: string; firstVisitQuota: number; returnQuota: number }[] }) {
    const unitId = input.unitId ?? ctx.session.unitId;
    const assignment = await ctx.db.userAssignment.findFirst({ where: { userId: input.professionalId, unitId, active: true } });
    if (!assignment) throw new DomainError('PROFISSIONAL_SEM_LOTACAO', 'O profissional não está lotado nesta unidade');
    for (const r of input.rules) if (r.startTime >= r.endTime) throw new DomainError('GRADE_INVALIDA', `Horário inválido: ${r.startTime}-${r.endTime}`);
    return ctx.db.schedule.create({
      data: { unitId, professionalId: input.professionalId, name: input.name, cbo: input.cbo, slotMinutes: input.slotMinutes, rules: { create: input.rules } },
      include: { rules: true },
    });
  }

  async addBlock(ctx: RequestContext, scheduleId: string, input: { startsAt: string; endsAt: string; reason: string }) {
    await this.schedule(ctx, scheduleId);
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (endsAt <= startsAt) throw new DomainError('BLOQUEIO_INVALIDO', 'Fim do bloqueio antes do início');
    const affected = await ctx.db.appointment.count({ where: { scheduleId, status: { in: ['AGENDADO', 'CONFIRMADO'] }, startsAt: { gte: startsAt, lt: endsAt } } });
    const block = await ctx.db.scheduleBlock.create({ data: { scheduleId, startsAt, endsAt, reason: input.reason, createdBy: ctx.session.userId } });
    return { block, affectedAppointments: affected };
  }

  private async schedule(sys: Pick<SystemContext, 'db'>, scheduleId: string) {
    const s = await sys.db.schedule.findUnique({ where: { id: scheduleId }, include: { rules: true, blocks: true } });
    if (!s) throw notFound('Agenda');
    return s;
  }

  /** Horários de um dia (no fuso do tenant), já descontando bloqueios e marcações, com o uso das cotas. */
  async slots(sys: Sys, scheduleId: string, date: string, now = new Date()) {
    const s = await this.schedule(sys, scheduleId);
    const tz = sys.tenant.timeZone;
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const dayStart = fromZonedParts({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, tz);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const appts = await sys.db.appointment.findMany({ where: { scheduleId, startsAt: { gte: dayStart, lt: dayEnd }, status: { in: [...ACTIVE] } } });
    const slots: Slot[] = [];
    const quotas = [];
    for (const rule of s.rules.filter((r) => r.weekday === weekday)) {
      const [sh, sm] = rule.startTime.split(':').map(Number) as [number, number];
      const [eh, em] = rule.endTime.split(':').map(Number) as [number, number];
      const start = fromZonedParts({ year: y, month: m, day: d, hour: sh, minute: sm, second: 0 }, tz);
      const end = fromZonedParts({ year: y, month: m, day: d, hour: eh, minute: em, second: 0 }, tz);
      for (let t = start.getTime(); t + s.slotMinutes * 60_000 <= end.getTime(); t += s.slotMinutes * 60_000) {
        const startsAt = new Date(t);
        const endsAt = new Date(t + s.slotMinutes * 60_000);
        const appt = appts.find((a) => a.startsAt < endsAt && a.endsAt > startsAt);
        const blocked = s.blocks.some((b) => b.startsAt < endsAt && b.endsAt > startsAt);
        slots.push({
          id: slotId(startsAt),
          startsAt,
          endsAt,
          ruleId: rule.id,
          status: appt ? 'OCUPADO' : blocked ? 'BLOQUEADO' : startsAt <= now ? 'PASSADO' : 'LIVRE',
          ...(appt ? { appointmentId: appt.id } : {}),
        });
      }
      const inRule = appts.filter((a) => a.startsAt >= start && a.startsAt < end);
      quotas.push({
        ruleId: rule.id,
        window: `${rule.startTime}-${rule.endTime}`,
        firstVisit: { quota: rule.firstVisitQuota, used: inRule.filter((a) => a.kind === 'PRIMEIRA_CONSULTA').length },
        return: { quota: rule.returnQuota, used: inRule.filter((a) => a.kind === 'RETORNO').length },
      });
    }
    return { scheduleId, date, slotMinutes: s.slotMinutes, slots, quotas };
  }

  async book(sys: Sys, input: { scheduleId: string; patientId: string; startsAt: string | Date; kind: 'PRIMEIRA_CONSULTA' | 'RETORNO'; notes?: string; rescheduledFromId?: string }, createdBy: string, now = new Date()) {
    const s = await this.schedule(sys, input.scheduleId);
    const startsAt = new Date(input.startsAt);
    const date = localDateString(startsAt, sys.tenant.timeZone);
    const day = await this.slots(sys, s.id, date, now);
    const slot = day.slots.find((x) => x.startsAt.getTime() === startsAt.getTime());
    if (!slot) throw new DomainError('HORARIO_FORA_DA_GRADE', 'Horário fora da grade da agenda');
    if (slot.status !== 'LIVRE') throw conflict(`Horário indisponível (${slot.status.toLowerCase()})`);
    const quota = day.quotas.find((q) => q.ruleId === slot.ruleId)!;
    const q = input.kind === 'PRIMEIRA_CONSULTA' ? quota.firstVisit : quota.return;
    if (q.used >= q.quota) throw new DomainError('COTA_ESGOTADA', `Cota de ${input.kind === 'PRIMEIRA_CONSULTA' ? 'primeira consulta' : 'retorno'} esgotada neste turno`);
    const sameDay = await sys.db.appointment.count({
      where: { scheduleId: s.id, patientId: input.patientId, status: { in: ['AGENDADO', 'CONFIRMADO'] }, startsAt: { gte: day.slots[0]?.startsAt ?? startsAt, lte: day.slots.at(-1)?.startsAt ?? startsAt } },
    });
    if (sameDay > 0) throw conflict('Paciente já tem horário nesta agenda neste dia');
    const appt = await sys.db.appointment.create({
      data: {
        scheduleId: s.id,
        unitId: s.unitId,
        patientId: input.patientId,
        professionalId: s.professionalId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        kind: input.kind,
        notes: input.notes,
        createdBy,
        rescheduledFromId: input.rescheduledFromId ?? null,
      },
    });
    await this.messaging.scheduleAppointmentConfirmation(sys, appt.id, now);
    return appt;
  }

  list(ctx: RequestContext, q: { date?: string; scheduleId?: string; status?: string; patientId?: string }) {
    const where: Record<string, unknown> = { unitId: ctx.session.unitId };
    if (q.scheduleId) where.scheduleId = q.scheduleId;
    if (q.status) where.status = q.status;
    if (q.patientId) where.patientId = q.patientId;
    if (q.date) {
      const [y, m, d] = q.date.split('-').map(Number) as [number, number, number];
      const start = fromZonedParts({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0 }, ctx.tenant.timeZone);
      where.startsAt = { gte: start, lt: new Date(start.getTime() + 86_400_000) };
    }
    return ctx.db.appointment.findMany({
      where,
      orderBy: { startsAt: 'asc' },
      include: { patient: { select: { id: true, name: true, socialName: true, cns: true, phone: true, birthDate: true } }, schedule: { select: { name: true } } },
    });
  }

  private async appointment(sys: SystemContext, id: string) {
    const a = await sys.db.appointment.findUnique({ where: { id } });
    if (!a) throw notFound('Agendamento');
    return a;
  }

  async confirm(sys: SystemContext, id: string, channel: string) {
    const a = await this.appointment(sys, id);
    if (a.status !== 'AGENDADO' && a.status !== 'CONFIRMADO') throw new DomainError('STATUS_INVALIDO', `Agendamento ${a.status.toLowerCase()}`);
    return sys.db.appointment.update({ where: { id }, data: { status: 'CONFIRMADO', confirmedAt: new Date(), confirmationChannel: channel } });
  }

  /** Cancela, libera a vaga e oferece à lista de espera da mesma especialidade (CBO) na unidade. */
  async cancel(sys: SystemContext, id: string, reason: string) {
    const a = await this.appointment(sys, id);
    if (a.status !== 'AGENDADO' && a.status !== 'CONFIRMADO') throw new DomainError('STATUS_INVALIDO', `Agendamento ${a.status.toLowerCase()}`);
    const updated = await sys.db.appointment.update({ where: { id }, data: { status: 'CANCELADO', cancelledAt: new Date(), cancelReason: reason } });
    await this.messaging.cancelScheduled(sys, id);
    const schedule = await sys.db.schedule.findUniqueOrThrow({ where: { id: a.scheduleId } });
    const next = await sys.db.waitlistEntry.findFirst({
      where: { unitId: a.unitId, cbo: schedule.cbo, status: 'AGUARDANDO' },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    if (next) {
      await sys.db.waitlistEntry.update({ where: { id: next.id }, data: { status: 'OFERTADO', offeredAppointmentId: id } });
      this.realtime.emitToUnit(sys.tenant.id, a.unitId, 'agenda.vaga_liberada', { appointmentId: id, startsAt: a.startsAt, waitlistEntryId: next.id });
    }
    return { appointment: updated, offeredTo: next?.id ?? null };
  }

  async noShow(ctx: RequestContext, id: string) {
    const a = await this.appointment(ctx, id);
    if (a.startsAt > new Date()) throw new DomainError('AINDA_NAO_OCORREU', 'Só é possível registrar falta após o horário');
    if (a.status !== 'AGENDADO' && a.status !== 'CONFIRMADO') throw new DomainError('STATUS_INVALIDO', `Agendamento ${a.status.toLowerCase()}`);
    return ctx.db.appointment.update({ where: { id }, data: { status: 'FALTOU' } });
  }

  /** Chegada do paciente agendado: abre o atendimento ambulatorial na unidade. */
  async checkIn(ctx: RequestContext, id: string) {
    const a = await this.appointment(ctx, id);
    if (a.status !== 'AGENDADO' && a.status !== 'CONFIRMADO') throw new DomainError('STATUS_INVALIDO', `Agendamento ${a.status.toLowerCase()}`);
    return ctx.db.$transaction(async (tx) => {
      await tx.appointment.update({ where: { id }, data: { status: 'ATENDIDO' } });
      const enc = await tx.encounter.create({
        data: { unitId: a.unitId, patientId: a.patientId, kind: 'AMBULATORIAL', appointmentId: a.id, responsibleId: a.professionalId, createdBy: ctx.session.userId },
      });
      await this.audit.record(ctx, tx, { action: 'agenda.chegada', entityType: 'Encounter', entityId: enc.id, payload: { appointmentId: a.id } });
      return enc;
    });
  }

  async reschedule(sys: Sys, id: string, startsAt: string | Date, by: string) {
    const a = await this.appointment(sys, id);
    if (a.status !== 'AGENDADO' && a.status !== 'CONFIRMADO') throw new DomainError('STATUS_INVALIDO', `Agendamento ${a.status.toLowerCase()}`);
    const created = await this.book(sys, { scheduleId: a.scheduleId, patientId: a.patientId, startsAt, kind: a.kind, rescheduledFromId: a.id }, by);
    await sys.db.appointment.update({ where: { id }, data: { status: 'REMARCADO' } });
    await this.messaging.cancelScheduled(sys, id);
    return created;
  }

  /** Próximos horários livres da mesma agenda (oferta de remarcação pelo WhatsApp). */
  async nextFreeSlots(sys: Sys, scheduleId: string, count = 3, now = new Date()) {
    const out: Slot[] = [];
    for (let i = 0; i < 30 && out.length < count; i++) {
      const date = localDateString(new Date(now.getTime() + i * 86_400_000), sys.tenant.timeZone);
      const day = await this.slots(sys, scheduleId, date, now);
      out.push(...day.slots.filter((s) => s.status === 'LIVRE').slice(0, count - out.length));
    }
    return out;
  }

  private async handleWhatsAppReply(sys: SystemContext, reply: AppointmentReply) {
    const a = await sys.db.appointment.findUnique({ where: { id: reply.appointmentId }, include: { patient: true } });
    if (!a || (a.status !== 'AGENDADO' && a.status !== 'CONFIRMADO')) return;
    // Só aceita resposta vinda do telefone do próprio paciente.
    if (a.patient.phone && !reply.from.endsWith(a.patient.phone.replace(/\D/g, '').slice(-8))) return;
    if (reply.action === 'CONFIRM') await this.confirm(sys, a.id, 'WHATSAPP');
    else if (reply.action === 'CANCEL') await this.cancel(sys, a.id, 'Cancelado pelo paciente via WhatsApp');
    else if (reply.action === 'RESCHEDULE') {
      const slots = await this.nextFreeSlots(sys, a.scheduleId);
      if (slots.length) {
        const unit = await sys.db.unit.findUniqueOrThrow({ where: { id: a.unitId } });
        const message = this.messaging.buildRescheduleMessage(a.id, slots, unit.name, sys.tenant.timeZone);
        await this.messaging.sendInteractiveNow(sys, a.patientId, reply.from, message, a.id);
      }
      this.realtime.emitToUnit(sys.tenant.id, a.unitId, 'agenda.remarcacao_solicitada', { appointmentId: a.id });
    } else if (reply.action === 'SLOT' && reply.slotId) {
      await this.reschedule(sys, a.id, slotFromId(reply.slotId), a.createdBy);
    }
  }

  waitlist(ctx: RequestContext, status = 'AGUARDANDO') {
    return ctx.db.waitlistEntry.findMany({ where: { unitId: ctx.session.unitId, status: status as never }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] });
  }

  addToWaitlist(ctx: RequestContext, input: { patientId: string; cbo: string; priority?: number; reason?: string }) {
    return ctx.db.waitlistEntry.create({ data: { unitId: ctx.session.unitId, patientId: input.patientId, cbo: input.cbo, priority: input.priority ?? 0, reason: input.reason } });
  }

  /** Absenteísmo (no-show) por agenda no período. */
  async absenteeism(ctx: RequestContext, from: string, to: string) {
    const rows = await ctx.db.appointment.groupBy({
      by: ['scheduleId', 'status'],
      where: { unitId: ctx.session.unitId, startsAt: { gte: new Date(from), lt: new Date(to) } },
      _count: { _all: true },
    });
    const schedules = new Map((await ctx.db.schedule.findMany({ where: { unitId: ctx.session.unitId } })).map((s) => [s.id, s.name]));
    const by = new Map<string, { scheduleId: string; schedule: string; total: number; noShow: number; attended: number }>();
    for (const r of rows) {
      const e = by.get(r.scheduleId) ?? { scheduleId: r.scheduleId, schedule: schedules.get(r.scheduleId) ?? '', total: 0, noShow: 0, attended: 0 };
      if (r.status !== 'CANCELADO' && r.status !== 'REMARCADO') e.total += r._count._all;
      if (r.status === 'FALTOU') e.noShow += r._count._all;
      if (r.status === 'ATENDIDO') e.attended += r._count._all;
      by.set(r.scheduleId, e);
    }
    return [...by.values()].map((e) => ({ ...e, noShowRate: e.total ? Math.round((e.noShow / e.total) * 1000) / 10 : 0 }));
  }

  /** Data local de hoje no fuso do tenant (padrão das telas). */
  today(ctx: RequestContext) {
    const p = zonedParts(new Date(), ctx.tenant.timeZone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }
}
