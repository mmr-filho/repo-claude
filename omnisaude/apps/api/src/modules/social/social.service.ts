import { Injectable } from '@nestjs/common';
import { ageInYears } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { conflict, DomainError, notFound } from '../../core/errors';

export const LINES_OF_CARE = ['HIPERTENSAO', 'DIABETES', 'GESTANTE', 'ONCOLOGIA', 'SAUDE_MENTAL', 'TUBERCULOSE', 'HANSENIASE', 'CRIANCA', 'IDOSO', 'MULHER', 'BOLSA_FAMILIA', 'SISVAN'] as const;
export type LineOfCare = (typeof LINES_OF_CARE)[number];

/** Dias sem consulta a partir dos quais o paciente entra no painel de busca ativa. */
export const RETURN_THRESHOLD_DAYS: Record<LineOfCare, number> = {
  HIPERTENSAO: 180,
  DIABETES: 180,
  GESTANTE: 30,
  ONCOLOGIA: 60,
  SAUDE_MENTAL: 90,
  TUBERCULOSE: 90,
  HANSENIASE: 90,
  CRIANCA: 60,
  IDOSO: 365,
  MULHER: 365,
  BOLSA_FAMILIA: 180,
  SISVAN: 180,
};

/** Janela em que uma falta (FALTOU) também coloca o paciente no painel. */
const MISSED_WINDOW_DAYS = 90;
const DAY = 86_400_000;

export const CONTACT_CHANNELS = ['TELEFONE', 'WHATSAPP', 'VISITA_DOMICILIAR', 'ACS'] as const;
export const VULNERABILITIES = ['TRANSPORTE', 'ABANDONO', 'BARREIRA_SOCIAL', 'FINANCEIRA', 'MOBILIDADE', 'OUTRA'] as const;
export const CONTACT_ACTIONS = ['TRANSPORTE_SANITARIO', 'VISITA_DOMICILIAR', 'CONSULTA_AGENDADA', 'ENCAMINHAMENTO_CRAS'] as const;

type CaseStatus = 'ABERTO' | 'EM_CONTATO' | 'AGENDADO' | 'ENCERRADO';

@Injectable()
export class SocialService {
  constructor(private readonly audit: AuditService) {}

  /** Último atendimento de cada paciente em qualquer unidade da rede. */
  private async lastVisits(ctx: RequestContext, patientIds: string[]) {
    const rows = await ctx.db.encounter.groupBy({
      by: ['patientId'],
      where: { patientId: { in: patientIds }, status: { notIn: ['CANCELADO'] } },
      _max: { startedAt: true },
    });
    return new Map(rows.map((r) => [r.patientId, r._max.startedAt]));
  }

  /**
   * Painel de crônicos e gestantes com retorno em atraso ou falta recente.
   * Uma linha por paciente e linha de cuidado (o caso de busca ativa é por linha).
   */
  async panel(ctx: RequestContext, lineOfCare?: LineOfCare) {
    const now = Date.now();
    const conditions = await ctx.db.patientCondition.findMany({
      where: { active: true, lineOfCare: lineOfCare ? lineOfCare : { not: null }, patient: { deceasedAt: null } },
      include: { patient: true },
    });
    const patientIds = [...new Set(conditions.map((c) => c.patientId))];
    const [visits, missed, cases] = await Promise.all([
      this.lastVisits(ctx, patientIds),
      ctx.db.appointment.groupBy({
        by: ['patientId'],
        where: { patientId: { in: patientIds }, status: 'FALTOU', startsAt: { gte: new Date(now - MISSED_WINDOW_DAYS * DAY) } },
        _count: { _all: true },
        _max: { startsAt: true },
      }),
      ctx.db.activeSearchCase.findMany({ where: { patientId: { in: patientIds }, status: { not: 'ENCERRADO' } } }),
    ]);
    const missedBy = new Map(missed.map((m) => [m.patientId, { count: m._count._all, last: m._max.startsAt }]));

    const seen = new Set<string>();
    const rows = [];
    for (const c of conditions) {
      const line = c.lineOfCare as LineOfCare;
      const key = `${c.patientId}|${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lastVisitAt = visits.get(c.patientId) ?? null;
      const daysSince = lastVisitAt ? Math.floor((now - lastVisitAt.getTime()) / DAY) : null;
      const threshold = RETURN_THRESHOLD_DAYS[line];
      const overdue = daysSince === null || daysSince > threshold;
      const miss = missedBy.get(c.patientId);
      if (!overdue && !miss) continue;
      const open = cases.find((k) => k.patientId === c.patientId && k.lineOfCare === line);
      const p = c.patient;
      rows.push({
        patientId: p.id,
        name: p.socialName ?? p.name,
        age: ageInYears(p.birthDate),
        cns: p.cns,
        phone: p.phone,
        whatsappOptIn: p.whatsappOptIn,
        district: p.district,
        lineOfCare: line,
        condition: { code: c.code, description: c.description },
        lastVisitAt,
        daysSinceLastVisit: daysSince,
        thresholdDays: threshold,
        daysOverdue: daysSince === null ? null : Math.max(0, daysSince - threshold),
        missedAppointments: miss?.count ?? 0,
        lastMissedAt: miss?.last ?? null,
        reasons: [...(overdue ? ['RETORNO_ATRASADO'] : []), ...(miss ? ['FALTA_RECENTE'] : [])],
        case: open ? { id: open.id, status: open.status, assignedTo: open.assignedTo, openedAt: open.openedAt } : null,
      });
    }
    // Sem consulta registrada vem primeiro; depois, o maior atraso.
    rows.sort((a, b) => (b.daysOverdue ?? Number.MAX_SAFE_INTEGER) - (a.daysOverdue ?? Number.MAX_SAFE_INTEGER) || b.missedAppointments - a.missedAppointments);
    return { generatedAt: new Date(now), thresholds: RETURN_THRESHOLD_DAYS, total: rows.length, items: rows };
  }

  async openCase(ctx: RequestContext, input: { patientId: string; lineOfCare: LineOfCare }) {
    const patient = await ctx.db.patient.findUnique({ where: { id: input.patientId } });
    if (!patient) throw notFound('Paciente');
    const existing = await ctx.db.activeSearchCase.findFirst({
      where: { patientId: input.patientId, lineOfCare: input.lineOfCare, status: { not: 'ENCERRADO' } },
    });
    if (existing) throw conflict('Já existe um caso aberto para este paciente nesta linha de cuidado', { caseId: existing.id });
    const lastVisitAt = (await this.lastVisits(ctx, [input.patientId])).get(input.patientId) ?? null;
    return ctx.db.$transaction(async (tx) => {
      const c = await tx.activeSearchCase.create({
        data: { patientId: input.patientId, lineOfCare: input.lineOfCare, assignedTo: ctx.session.userId, lastVisitAt },
      });
      await this.audit.record(ctx, tx, { action: 'busca_ativa.abrir', entityType: 'ActiveSearchCase', entityId: c.id, payload: input });
      return c;
    });
  }

  async listCases(ctx: RequestContext, status?: CaseStatus) {
    const rows = await ctx.db.activeSearchCase.findMany({
      where: status ? { status } : { status: { not: 'ENCERRADO' } },
      include: { patient: true, contacts: { orderBy: { at: 'desc' }, take: 1 } },
      orderBy: { openedAt: 'desc' },
    });
    const users = new Map((await ctx.db.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return rows.map((c) => ({
      id: c.id,
      status: c.status,
      lineOfCare: c.lineOfCare,
      patient: { id: c.patient.id, name: c.patient.socialName ?? c.patient.name, cns: c.patient.cns, phone: c.patient.phone, district: c.patient.district },
      assignedTo: c.assignedTo ? (users.get(c.assignedTo) ?? null) : null,
      lastVisitAt: c.lastVisitAt,
      openedAt: c.openedAt,
      closedAt: c.closedAt,
      lastContact: c.contacts[0] ?? null,
    }));
  }

  async getCase(ctx: RequestContext, id: string) {
    const c = await ctx.db.activeSearchCase.findUnique({ where: { id }, include: { patient: true, contacts: { orderBy: { at: 'asc' } } } });
    if (!c) throw notFound('Caso de busca ativa');
    const users = new Map((await ctx.db.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return {
      ...c,
      patient: {
        id: c.patient.id,
        name: c.patient.socialName ?? c.patient.name,
        cns: c.patient.cns,
        phone: c.patient.phone,
        whatsappOptIn: c.patient.whatsappOptIn,
        district: c.patient.district,
        age: ageInYears(c.patient.birthDate),
      },
      assignedToName: c.assignedTo ? (users.get(c.assignedTo) ?? null) : null,
      contacts: c.contacts.map((k) => ({ ...k, userName: users.get(k.userId) ?? null })),
    };
  }

  async addContact(ctx: RequestContext, caseId: string, input: { channel: string; outcome: string; vulnerabilities: string[]; actions: string[]; notes?: string }) {
    const c = await ctx.db.activeSearchCase.findUnique({ where: { id: caseId } });
    if (!c) throw notFound('Caso de busca ativa');
    if (c.status === 'ENCERRADO') throw new DomainError('CASO_ENCERRADO', 'O caso já foi encerrado');
    const status: CaseStatus = input.actions.includes('CONSULTA_AGENDADA') ? 'AGENDADO' : 'EM_CONTATO';
    return ctx.db.$transaction(async (tx) => {
      const contact = await tx.activeSearchContact.create({
        data: {
          caseId,
          channel: input.channel,
          outcome: input.outcome,
          vulnerabilities: input.vulnerabilities,
          actions: input.actions,
          notes: input.notes ?? null,
          userId: ctx.session.userId,
        },
      });
      await tx.activeSearchCase.update({ where: { id: caseId }, data: { status, assignedTo: c.assignedTo ?? ctx.session.userId } });
      await this.audit.record(ctx, tx, { action: 'busca_ativa.contato', entityType: 'ActiveSearchCase', entityId: caseId, payload: input });
      return { contact, status };
    });
  }

  async closeCase(ctx: RequestContext, caseId: string, reason: string) {
    const c = await ctx.db.activeSearchCase.findUnique({ where: { id: caseId } });
    if (!c) throw notFound('Caso de busca ativa');
    if (c.status === 'ENCERRADO') throw new DomainError('CASO_ENCERRADO', 'O caso já foi encerrado');
    return ctx.db.$transaction(async (tx) => {
      const updated = await tx.activeSearchCase.update({ where: { id: caseId }, data: { status: 'ENCERRADO', closedAt: new Date(), closeReason: reason } });
      await this.audit.record(ctx, tx, { action: 'busca_ativa.encerrar', entityType: 'ActiveSearchCase', entityId: caseId, payload: { reason } });
      return updated;
    });
  }
}
