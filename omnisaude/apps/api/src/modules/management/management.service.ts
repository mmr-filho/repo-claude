import { Injectable } from '@nestjs/common';
import { RISK_INFO, ROLE_LABELS, type RiskColor, type Role } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { notFound } from '../../core/errors';
import { periodRange } from './period';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Quando a pessoa tem vários papéis, a categoria da produtividade segue esta ordem. */
const CATEGORY_PRIORITY: Role[] = ['MEDICO', 'MULTIPROFISSIONAL', 'ENFERMAGEM', 'SERVICO_SOCIAL', 'ACS', 'FARMACIA', 'NIR', 'RECEPCAO', 'FATURAMENTO', 'GESTOR'];

type Severity = 'ALTA' | 'MEDIA' | 'BAIXA';

interface Counters {
  encountersClosed: number;
  durationTotalMin: number;
  durationCount: number;
  referrals: number;
  signedNotes: number;
  prescriptions: number;
  triages: number;
}

const emptyCounters = (): Counters => ({ encountersClosed: 0, durationTotalMin: 0, durationCount: 0, referrals: 0, signedNotes: 0, prescriptions: 0, triages: 0 });

function finish(c: Counters) {
  const { durationTotalMin, durationCount, ...rest } = c;
  return { ...rest, avgDurationMin: durationCount ? Math.round((durationTotalMin / durationCount) * 10) / 10 : null };
}

export interface SlaItem {
  key: string;
  label: string;
  severity: Severity;
  count: number;
  records: Record<string, unknown>[];
}

@Injectable()
export class ManagementService {
  constructor(private readonly audit: AuditService) {}

  // ───────────────────────────── Produtividade ─────────────────────────────

  async productivity(ctx: RequestContext, q: { from?: string; to?: string; unitId?: string }) {
    const db = ctx.db;
    const period = periodRange(ctx.tenant.timeZone, q.from, q.to);
    const inRange = { gte: period.start, lt: period.end };
    const unitFilter = q.unitId ? { encounter: { unitId: q.unitId } } : {};
    const [encounters, notes, prescriptions, triages, users, units, assignments] = await Promise.all([
      db.encounter.findMany({
        where: { status: 'ENCERRADO', endedAt: inRange, ...(q.unitId ? { unitId: q.unitId } : {}) },
        select: { unitId: true, responsibleId: true, startedAt: true, endedAt: true, outcome: true },
      }),
      db.clinicalNote.findMany({ where: { status: 'ASSINADO', signedAt: inRange, ...unitFilter }, select: { authorId: true, role: true, encounter: { select: { unitId: true } } } }),
      db.prescription.findMany({ where: { signedAt: inRange, ...unitFilter }, select: { prescriberId: true, encounter: { select: { unitId: true } } } }),
      db.triage.findMany({ where: { classifiedAt: inRange, ...unitFilter }, select: { nurseId: true, encounter: { select: { unitId: true } } } }),
      db.user.findMany({ select: { id: true, name: true } }),
      db.unit.findMany({ select: { id: true, name: true, type: true } }),
      db.userAssignment.findMany({ where: { active: true }, select: { userId: true, role: true } }),
    ]);

    const people = new Map<string, Counters & { noteRoles: Map<string, number> }>();
    const byUnit = new Map<string, Counters>();
    const person = (id: string) => {
      let p = people.get(id);
      if (!p) people.set(id, (p = { ...emptyCounters(), noteRoles: new Map() }));
      return p;
    };
    const unit = (id: string) => {
      let u = byUnit.get(id);
      if (!u) byUnit.set(id, (u = emptyCounters()));
      return u;
    };

    for (const e of encounters) {
      const minutes = e.endedAt ? (e.endedAt.getTime() - e.startedAt.getTime()) / 60_000 : null;
      for (const c of [e.responsibleId ? person(e.responsibleId) : null, unit(e.unitId)]) {
        if (!c) continue;
        c.encountersClosed++;
        if (minutes !== null && minutes >= 0) {
          c.durationTotalMin += minutes;
          c.durationCount++;
        }
        if (e.outcome === 'ENCAMINHAMENTO') c.referrals++;
      }
    }
    for (const n of notes) {
      const p = person(n.authorId);
      p.signedNotes++;
      p.noteRoles.set(n.role, (p.noteRoles.get(n.role) ?? 0) + 1);
      unit(n.encounter.unitId).signedNotes++;
    }
    for (const r of prescriptions) {
      person(r.prescriberId).prescriptions++;
      unit(r.encounter.unitId).prescriptions++;
    }
    for (const t of triages) {
      person(t.nurseId).triages++;
      unit(t.encounter.unitId).triages++;
    }

    const names = new Map(users.map((u) => [u.id, u.name]));
    const rolesOf = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (!rolesOf.has(a.userId)) rolesOf.set(a.userId, new Set());
      rolesOf.get(a.userId)!.add(a.role);
    }
    const categoryOf = (userId: string, noteRoles: Map<string, number>): Role => {
      const fromNotes = [...noteRoles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (fromNotes) return fromNotes as Role;
      const roles = rolesOf.get(userId) ?? new Set<string>();
      return CATEGORY_PRIORITY.find((r) => roles.has(r)) ?? 'MULTIPROFISSIONAL';
    };

    const professionals = [...people.entries()].map(([userId, c]) => {
      const category = categoryOf(userId, c.noteRoles);
      const { noteRoles: _ignored, ...counters } = c;
      return { userId, name: names.get(userId) ?? null, category, categoryLabel: ROLE_LABELS[category], counters, ...finish(counters) };
    });
    const categories = new Map<Role, Counters>();
    for (const p of professionals) {
      const c = categories.get(p.category) ?? emptyCounters();
      for (const k of Object.keys(c) as (keyof Counters)[]) c[k] += p.counters[k];
      categories.set(p.category, c);
    }
    const unitNames = new Map(units.map((u) => [u.id, u]));
    return {
      period: { from: period.from, to: period.to },
      professionals: professionals.map(({ counters: _c, ...rest }) => rest).sort((a, b) => b.encountersClosed - a.encountersClosed || b.signedNotes - a.signedNotes),
      categories: [...categories.entries()].map(([role, c]) => ({ category: role, label: ROLE_LABELS[role], ...finish(c) })),
      units: [...byUnit.entries()].map(([id, c]) => ({ unitId: id, unit: unitNames.get(id)?.name ?? null, unitType: unitNames.get(id)?.type ?? null, ...finish(c) })),
    };
  }

  // ───────────────────────────── SLAs e não conformidades ─────────────────────────────

  async sla(ctx: RequestContext, q: { from?: string; to?: string } = {}): Promise<{ generatedAt: Date; period: { from: string; to: string }; total: number; items: SlaItem[] }> {
    const db = ctx.db;
    const now = Date.now();
    const period = periodRange(ctx.tenant.timeZone, q.from, q.to ?? undefined);
    const [units, users] = await Promise.all([db.unit.findMany({ select: { id: true, name: true } }), db.user.findMany({ select: { id: true, name: true } })]);
    const unitName = new Map(units.map((u) => [u.id, u.name]));
    const userName = new Map(users.map((u) => [u.id, u.name]));
    const maxWait = (color: RiskColor) => ctx.tenant.settings.accrMaxWaitMinutes[color] ?? RISK_INFO[color].maxWaitMinutes;

    const [openEncounters, drafts, waiting, blocked, cleaningBeds, outboxErrors, glosas] = await Promise.all([
      db.encounter.findMany({
        where: { status: { in: ['ABERTO', 'TRIADO', 'EM_ATENDIMENTO'] }, kind: { not: 'INTERNACAO' }, startedAt: { lt: new Date(now - 12 * HOUR) } },
        include: { patient: { select: { name: true } } },
        orderBy: { startedAt: 'asc' },
        take: 200,
      }),
      db.clinicalNote.findMany({
        where: { status: 'RASCUNHO', createdAt: { lt: new Date(now - 12 * HOUR) } },
        include: { encounter: { select: { unitId: true, patient: { select: { name: true } } } } },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
      db.encounter.findMany({
        where: { status: 'TRIADO' },
        include: { patient: { select: { name: true } }, triages: { orderBy: { classifiedAt: 'desc' }, take: 1 } },
      }),
      db.administration.findMany({ where: { status: 'BLOQUEADO', at: { gte: period.start, lt: period.end } }, orderBy: { at: 'desc' }, take: 200 }),
      db.bed.findMany({ where: { status: 'HIGIENIZACAO', updatedAt: { lt: new Date(now - 2 * HOUR) } }, include: { ward: { select: { name: true, unitId: true } } } }),
      db.outboxMessage.findMany({ where: { status: 'ERRO' }, orderBy: { createdAt: 'asc' }, take: 200 }),
      db.productionRecord.findMany({ where: { status: 'GLOSA_PREVISTA' }, take: 500 }),
    ]);

    const accrOverdue = waiting
      .map((e) => {
        const t = e.triages[0];
        if (!t) return null;
        const color = t.riskColor as RiskColor;
        const waited = Math.floor((now - t.classifiedAt.getTime()) / 60_000);
        return waited > maxWait(color) ? { encounterId: e.id, patient: e.patient.name, unit: unitName.get(e.unitId), color, waitedMinutes: waited, maxWaitMinutes: maxWait(color) } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const items: SlaItem[] = [
      {
        key: 'atendimentos_abertos',
        label: 'Atendimentos abertos há mais de 12 horas (sem encerramento formal)',
        severity: 'ALTA',
        count: openEncounters.length,
        records: openEncounters.map((e) => ({
          encounterId: e.id,
          patient: e.patient.name,
          unit: unitName.get(e.unitId),
          status: e.status,
          startedAt: e.startedAt,
          responsible: e.responsibleId ? userName.get(e.responsibleId) : null,
        })),
      },
      {
        key: 'prontuarios_rascunho',
        label: 'Prontuários em rascunho há mais de 12 horas (não assinados após o turno)',
        severity: 'ALTA',
        count: drafts.length,
        records: drafts.map((n) => ({ noteId: n.id, encounterId: n.encounterId, author: userName.get(n.authorId), patient: n.encounter.patient.name, unit: unitName.get(n.encounter.unitId), createdAt: n.createdAt })),
      },
      {
        key: 'accr_atrasado',
        label: 'Pacientes classificados aguardando além do tempo-alvo da cor',
        severity: 'ALTA',
        count: accrOverdue.length,
        records: accrOverdue,
      },
      {
        key: 'administracoes_bloqueadas',
        label: 'Administrações beira-leito bloqueadas pela checagem dos 5 certos/POP',
        severity: 'MEDIA',
        count: blocked.length,
        records: blocked.map((a) => ({ administrationId: a.id, at: a.at, by: userName.get(a.administeredBy), checks: a.checks })),
      },
      {
        key: 'leitos_higienizacao',
        label: 'Leitos em higienização há mais de 2 horas',
        severity: 'MEDIA',
        count: cleaningBeds.length,
        records: cleaningBeds.map((b) => ({ bedId: b.id, bed: b.code, ward: b.ward.name, unit: unitName.get(b.ward.unitId), since: b.updatedAt })),
      },
      {
        key: 'rnds_erro',
        label: 'Envios à RNDS com erro',
        severity: 'MEDIA',
        count: outboxErrors.length,
        records: outboxErrors.map((o) => ({ id: o.id, kind: o.kind, attempts: o.attempts, lastError: o.lastError, createdAt: o.createdAt })),
      },
      {
        key: 'glosas_previstas',
        label: 'Produção com glosa prevista pela crítica',
        severity: 'BAIXA',
        count: glosas.length,
        records: glosas.slice(0, 50).map((g) => ({ id: g.id, competencia: g.competencia, procedureCode: g.procedureCode, unit: unitName.get(g.unitId), issues: g.issues })),
      },
    ];
    return { generatedAt: new Date(now), period: { from: period.from, to: period.to }, total: items.reduce((s, i) => s + i.count, 0), items };
  }

  // ───────────────────────────── Pautas de reunião ─────────────────────────────

  /** Compila os gargalos do período em uma pauta estruturada (JSON + Markdown), sem depender de IA. */
  async generateAgenda(ctx: RequestContext, q: { from?: string; to?: string; unitId?: string }) {
    const db = ctx.db;
    const tz = ctx.tenant.timeZone;
    const period = periodRange(tz, q.from, q.to);
    const now = Date.now();
    const unitScope = q.unitId ? { unitId: q.unitId } : {};
    const units = await db.unit.findMany({ select: { id: true, name: true } });
    const unitName = new Map(units.map((u) => [u.id, u.name]));

    // 1. Leitos
    const beds = await db.bed.findMany({ include: { ward: { select: { unitId: true } } }, where: q.unitId ? { ward: { unitId: q.unitId } } : {} });
    const bedsByUnit = new Map<string, { total: number; ocupados: number; vagos: number; higienizacao: number; bloqueados: number; isolamento: number }>();
    for (const b of beds) {
      const s = bedsByUnit.get(b.ward.unitId) ?? { total: 0, ocupados: 0, vagos: 0, higienizacao: 0, bloqueados: 0, isolamento: 0 };
      s.total++;
      if (b.status === 'OCUPADO') s.ocupados++;
      if (b.status === 'VAGO') s.vagos++;
      if (b.status === 'HIGIENIZACAO') s.higienizacao++;
      if (b.status === 'BLOQUEADO') s.bloqueados++;
      if (b.isolation !== 'NENHUM') s.isolamento++;
      bedsByUnit.set(b.ward.unitId, s);
    }
    const leitos = [...bedsByUnit.entries()].map(([unitId, s]) => {
      const available = s.total - s.bloqueados;
      return { unit: unitName.get(unitId), ...s, occupancyPct: available ? Math.round((s.ocupados / available) * 100) : 0 };
    });

    // 2. Absenteísmo por agenda
    const appointments = await db.appointment.findMany({
      where: { startsAt: { gte: period.start, lt: period.end }, status: { in: ['ATENDIDO', 'FALTOU', 'CONFIRMADO', 'AGENDADO'] }, ...unitScope },
      select: { scheduleId: true, status: true, startsAt: true },
    });
    const schedules = new Map((await db.schedule.findMany({ select: { id: true, name: true, cbo: true, unitId: true } })).map((s) => [s.id, s]));
    const absByAgenda = new Map<string, { total: number; faltas: number }>();
    for (const a of appointments) {
      if (a.startsAt.getTime() > now) continue; // só o que já deveria ter acontecido
      const s = absByAgenda.get(a.scheduleId) ?? { total: 0, faltas: 0 };
      s.total++;
      if (a.status === 'FALTOU') s.faltas++;
      absByAgenda.set(a.scheduleId, s);
    }
    const absenteismo = [...absByAgenda.entries()]
      .map(([id, s]) => ({ schedule: schedules.get(id)?.name ?? id, unit: unitName.get(schedules.get(id)?.unitId ?? ''), cbo: schedules.get(id)?.cbo, ...s, ratePct: Math.round((s.faltas / s.total) * 100) }))
      .sort((a, b) => b.ratePct - a.ratePct || b.faltas - a.faltas)
      .slice(0, 5);

    // 3. Fila de espera por especialidade (CBO)
    const waitlist = await db.waitlistEntry.findMany({ where: { status: 'AGUARDANDO', ...unitScope }, select: { unitId: true, cbo: true, createdAt: true } });
    const queue = new Map<string, { unit: string | undefined; cbo: string; waiting: number; oldestDays: number }>();
    for (const w of waitlist) {
      const key = `${w.unitId}|${w.cbo}`;
      const days = Math.floor((now - w.createdAt.getTime()) / DAY);
      const s = queue.get(key) ?? { unit: unitName.get(w.unitId), cbo: w.cbo, waiting: 0, oldestDays: 0 };
      s.waiting++;
      s.oldestDays = Math.max(s.oldestDays, days);
      queue.set(key, s);
    }
    const filaEspera = [...queue.values()].sort((a, b) => b.oldestDays - a.oldestDays || b.waiting - a.waiting).slice(0, 5);

    // 4. Exames solicitados há mais de 30 dias sem coleta (proxy de faltas a exames)
    const pendingExams = await db.examRequest.groupBy({
      by: ['name'],
      where: { status: 'SOLICITADO', requestedAt: { lt: new Date(now - 30 * DAY) } },
      _count: { _all: true },
    });
    const exames = pendingExams
      .map((e) => ({ exam: e.name, pending: e._count._all }))
      .sort((a, b) => b.pending - a.pending)
      .slice(0, 5);

    // 5. Classificação de risco no período
    const triages = await db.triage.findMany({
      where: { classifiedAt: { gte: period.start, lt: period.end }, ...(q.unitId ? { encounter: { unitId: q.unitId } } : {}) },
      select: { riskColor: true },
    });
    const accrByColor: Record<string, number> = {};
    for (const t of triages) accrByColor[t.riskColor] = (accrByColor[t.riskColor] ?? 0) + 1;

    // 6. Faturamento
    const glosaRecords = await db.productionRecord.findMany({ where: { status: 'GLOSA_PREVISTA', ...unitScope }, select: { issues: true } });
    const glosasByRule: Record<string, number> = {};
    for (const g of glosaRecords) for (const i of (g.issues as { rule?: string }[]) ?? []) if (i.rule) glosasByRule[i.rule] = (glosasByRule[i.rule] ?? 0) + 1;

    // 7. Estoque vencendo em 60 dias
    const expiring = await db.stockBalance.findMany({
      where: { quantity: { gt: 0 }, lot: { expiry: { lt: new Date(now + 60 * DAY) } }, ...(q.unitId ? { location: { unitId: q.unitId } } : {}) },
      include: { lot: { include: { product: { select: { description: true } } } }, location: { select: { name: true } } },
      orderBy: { lot: { expiry: 'asc' } },
      take: 20,
    });
    const estoque = expiring.map((b) => ({ product: b.lot.product.description, lot: b.lot.lotNumber, expiry: b.lot.expiry.toISOString().slice(0, 10), location: b.location.name, quantity: Number(b.quantity) }));

    // 8. SLAs
    const sla = await this.sla(ctx, { from: period.from, to: period.to });
    const slaCounts = sla.items.filter((i) => i.count > 0).map((i) => ({ key: i.key, label: i.label, count: i.count, severity: i.severity }));

    const content = {
      period: { from: period.from, to: period.to },
      scope: q.unitId ? unitName.get(q.unitId) : 'Rede',
      leitos,
      absenteismo,
      filaEspera,
      exames,
      accr: { byColor: accrByColor, overdueNow: sla.items.find((i) => i.key === 'accr_atrasado')?.count ?? 0 },
      faturamento: { glosasPrevistas: glosaRecords.length, byRule: glosasByRule },
      estoque,
      sla: slaCounts,
    };
    const markdown = renderAgendaMarkdown(content);
    const agenda = await db.$transaction(async (tx) => {
      const a = await tx.meetingAgenda.create({
        data: { periodStart: period.start, periodEnd: period.end, scope: q.unitId ?? 'REDE', content: content as unknown as object, markdown, createdBy: ctx.session.userId },
      });
      await this.audit.record(ctx, tx, { action: 'gestao.pauta.gerar', entityType: 'MeetingAgenda', entityId: a.id, payload: { period: content.period, scope: content.scope } });
      return a;
    });
    return { id: agenda.id, createdAt: agenda.createdAt, content, markdown };
  }

  async listAgendas(ctx: RequestContext) {
    return ctx.db.meetingAgenda.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, periodStart: true, periodEnd: true, scope: true, createdAt: true, createdBy: true },
    });
  }

  async getAgenda(ctx: RequestContext, id: string) {
    const a = await ctx.db.meetingAgenda.findUnique({ where: { id } });
    if (!a) throw notFound('Pauta');
    return a;
  }
}

type AgendaContent = {
  period: { from: string; to: string };
  scope: string | undefined;
  leitos: { unit: string | undefined; total: number; ocupados: number; vagos: number; higienizacao: number; bloqueados: number; isolamento: number; occupancyPct: number }[];
  absenteismo: { schedule: string; unit: string | undefined; total: number; faltas: number; ratePct: number }[];
  filaEspera: { unit: string | undefined; cbo: string; waiting: number; oldestDays: number }[];
  exames: { exam: string; pending: number }[];
  accr: { byColor: Record<string, number>; overdueNow: number };
  faturamento: { glosasPrevistas: number; byRule: Record<string, number> };
  estoque: { product: string; lot: string; expiry: string; location: string; quantity: number }[];
  sla: { label: string; count: number; severity: string }[];
};

const fmtDate = (iso: string) => iso.split('-').reverse().join('/');

export function renderAgendaMarkdown(c: AgendaContent): string {
  const out: string[] = [];
  out.push(`# Pauta da reunião de gestão — ${c.scope ?? 'Rede'}`, '', `Período analisado: ${fmtDate(c.period.from)} a ${fmtDate(c.period.to)}.`, '');

  out.push('## 1. Leitos e giro', '');
  if (c.leitos.length === 0) out.push('- Sem leitos cadastrados no escopo.');
  for (const l of c.leitos) {
    out.push(`- **${l.unit}**: ocupação ${l.occupancyPct}% (${l.ocupados}/${l.total - l.bloqueados}), ${l.higienizacao} em higienização, ${l.bloqueados} bloqueado(s), ${l.isolamento} em isolamento.`);
  }
  const crowded = c.leitos.filter((l) => l.occupancyPct >= 85);
  if (crowded.length) out.push(`- Encaminhamento sugerido: avaliar altas e transferências em ${crowded.map((l) => l.unit).join(', ')} (ocupação acima de 85%).`);
  if (c.leitos.some((l) => l.higienizacao > 0)) out.push('- Encaminhamento sugerido: rever o fluxo de higienização para liberar leitos mais cedo.');
  out.push('');

  out.push('## 2. Absenteísmo (faltas às consultas)', '');
  if (c.absenteismo.length === 0) out.push('- Sem consultas realizadas no período.');
  for (const a of c.absenteismo) out.push(`- ${a.schedule} (${a.unit}): ${a.faltas} falta(s) em ${a.total} consulta(s) — ${a.ratePct}%.`);
  if (c.absenteismo.some((a) => a.ratePct >= 20)) out.push('- Encaminhamento sugerido: reforçar a confirmação por WhatsApp e acionar a busca ativa dos faltosos.');
  out.push('');

  out.push('## 3. Especialidades com maior espera', '');
  if (c.filaEspera.length === 0) out.push('- Nenhum paciente aguardando na fila de espera.');
  for (const f of c.filaEspera) out.push(`- CBO ${f.cbo} (${f.unit}): ${f.waiting} aguardando; o mais antigo há ${f.oldestDays} dia(s).`);
  out.push('');

  out.push('## 4. Exames pendentes de coleta (mais de 30 dias)', '');
  if (c.exames.length === 0) out.push('- Nenhum exame pendente há mais de 30 dias.');
  for (const e of c.exames) out.push(`- ${e.exam}: ${e.pending}.`);
  out.push('');

  out.push('## 5. Classificação de risco', '');
  const colors = Object.entries(c.accr.byColor)
    .map(([k, v]) => `${k.toLowerCase()} ${v}`)
    .join(', ');
  out.push(`- Classificações no período: ${colors || 'nenhuma'}.`);
  out.push(`- Pacientes aguardando além do tempo-alvo agora: ${c.accr.overdueNow}.`);
  out.push('');

  out.push('## 6. Faturamento', '');
  out.push(`- Registros com glosa prevista: ${c.faturamento.glosasPrevistas}.`);
  for (const [rule, n] of Object.entries(c.faturamento.byRule)) out.push(`  - ${rule.replaceAll('_', ' ').toLowerCase()}: ${n}`);
  out.push('');

  out.push('## 7. Estoque vencendo em até 60 dias', '');
  if (c.estoque.length === 0) out.push('- Nenhum lote vencendo nos próximos 60 dias.');
  for (const s of c.estoque) out.push(`- ${s.product} — lote ${s.lot}, validade ${fmtDate(s.expiry)}, ${s.quantity} em ${s.location}.`);
  out.push('');

  out.push('## 8. Não conformidades e SLAs', '');
  if (c.sla.length === 0) out.push('- Nenhuma não conformidade aberta.');
  for (const s of c.sla) out.push(`- [${s.severity}] ${s.label}: ${s.count}.`);
  out.push('');
  return out.join('\n');
}
