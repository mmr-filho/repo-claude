import { Injectable } from '@nestjs/common';
import { ageInYears, compareRisk, RISK_COLORS, RISK_FLAGS, RISK_INFO, suggestRiskColor, type RiskColor, type RiskFlag, type VitalSigns } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { recordProduction, SIGTAP } from '../../core/production';
import { RealtimeService } from '../../core/realtime.service';

export interface PainPoint {
  view: 'FRENTE' | 'COSTAS';
  region: string;
  x: number;
  y: number;
  intensity: number;
}

export interface TriageInput extends VitalSigns {
  complaint: string;
  weightKg?: number;
  heightCm?: number;
  painMap?: PainPoint[];
  flags?: RiskFlag[];
  vulnerability?: string;
  /** Cor decidida pela enfermagem; se omitida, vale a sugestão. */
  riskColor?: RiskColor;
  overrideReason?: string;
}

@Injectable()
export class TriageService {
  constructor(
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  maxWait(ctx: RequestContext, color: RiskColor): number {
    return ctx.tenant.settings.accrMaxWaitMinutes[color] ?? RISK_INFO[color].maxWaitMinutes;
  }

  suggest(input: VitalSigns & { flags?: RiskFlag[] }) {
    const { flags, ...vitals } = input;
    return suggestRiskColor(vitals, flags ?? []);
  }

  /** Filas da unidade: aguardando classificação (por chegada) e aguardando atendimento (por cor e chegada). */
  async queue(ctx: RequestContext, now = new Date()) {
    const encounters = await ctx.db.encounter.findMany({
      where: { unitId: ctx.session.unitId, status: { in: ['ABERTO', 'TRIADO', 'EM_ATENDIMENTO'] }, kind: { in: ['URGENCIA', 'AMBULATORIAL', 'ODONTOLOGICO'] } },
      include: { patient: true, triages: { orderBy: { classifiedAt: 'desc' }, take: 1 } },
      orderBy: { startedAt: 'asc' },
    });
    const ticketIds = encounters.map((e) => e.ticketId).filter((x): x is string => !!x);
    const tickets = new Map((await ctx.db.ticket.findMany({ where: { id: { in: ticketIds } } })).map((t) => [t.id, t.code]));
    const rows = encounters.map((e) => {
      const t = e.triages[0];
      const waitingMinutes = Math.floor((now.getTime() - (t?.classifiedAt ?? e.startedAt).getTime()) / 60_000);
      const max = t ? this.maxWait(ctx, t.riskColor) : null;
      return {
        encounterId: e.id,
        status: e.status,
        kind: e.kind,
        ticket: e.ticketId ? tickets.get(e.ticketId) ?? null : null,
        arrivedAt: e.startedAt,
        patient: { id: e.patient.id, name: e.patient.socialName ?? e.patient.name, age: ageInYears(e.patient.birthDate), sex: e.patient.sex },
        triage: t ? { color: t.riskColor, classifiedAt: t.classifiedAt, complaint: t.complaint, painScore: t.painScore } : null,
        waitingMinutes,
        maxWaitMinutes: max,
        overdue: max !== null && e.status === 'TRIADO' && waitingMinutes > max,
      };
    });
    const awaitingDoctor = rows
      .filter((r) => r.status === 'TRIADO' && r.triage)
      .sort((a, b) => compareRisk({ color: a.triage!.color, classifiedAt: a.triage!.classifiedAt }, { color: b.triage!.color, classifiedAt: b.triage!.classifiedAt }));
    return {
      awaitingTriage: rows.filter((r) => r.status === 'ABERTO' && r.kind === 'URGENCIA'),
      awaitingDoctor,
      inProgress: rows.filter((r) => r.status === 'EM_ATENDIMENTO'),
      scheduled: rows.filter((r) => r.status === 'ABERTO' && r.kind !== 'URGENCIA'),
      counts: Object.fromEntries(RISK_COLORS.map((c) => [c, awaitingDoctor.filter((r) => r.triage!.color === c).length])),
    };
  }

  async classify(ctx: RequestContext, encounterId: string, input: TriageInput) {
    const enc = await ctx.db.encounter.findFirst({ where: { id: encounterId, unitId: ctx.session.unitId } });
    if (!enc) throw notFound('Atendimento');
    if (enc.status === 'ENCERRADO' || enc.status === 'CANCELADO') throw new DomainError('ATENDIMENTO_ENCERRADO', 'Atendimento já encerrado');
    for (const f of input.flags ?? []) if (!(f in RISK_FLAGS)) throw new DomainError('DISCRIMINADOR_INVALIDO', `Discriminador desconhecido: ${f}`);
    if (input.painMap?.some((p) => p.intensity < 0 || p.intensity > 10)) throw new DomainError('DOR_INVALIDA', 'Intensidade da dor deve ir de 0 a 10');
    const suggestion = this.suggest(input);
    const color = input.riskColor ?? suggestion.color;
    // Classificar abaixo do que os parâmetros indicam exige justificativa registrada.
    const lessSevere = RISK_COLORS.indexOf(color) > RISK_COLORS.indexOf(suggestion.color);
    if (lessSevere && !input.overrideReason?.trim()) {
      throw new DomainError('JUSTIFICATIVA_OBRIGATORIA', `Os parâmetros sugerem ${suggestion.color}; justifique a classificação ${color}`, 422, { suggestion });
    }
    const painScore = input.painScore ?? (input.painMap?.length ? Math.max(...input.painMap.map((p) => p.intensity)) : undefined);
    const triage = await ctx.db.$transaction(async (tx) => {
      const t = await tx.triage.create({
        data: {
          encounterId,
          nurseId: ctx.session.userId,
          complaint: input.complaint,
          systolic: input.systolic,
          diastolic: input.diastolic,
          heartRate: input.heartRate,
          respiratoryRate: input.respiratoryRate,
          temperature: input.temperature,
          spo2: input.spo2,
          glucose: input.glucose,
          weightKg: input.weightKg,
          heightCm: input.heightCm,
          painScore,
          painMap: (input.painMap ?? []) as object,
          flags: input.flags ?? [],
          vulnerability: input.vulnerability,
          suggestedColor: suggestion.color,
          riskColor: color,
          overrideReason: input.overrideReason,
        },
      });
      if (enc.status === 'ABERTO') await tx.encounter.update({ where: { id: encounterId }, data: { status: 'TRIADO' } });
      await recordProduction(tx, ctx, { procedureCode: SIGTAP.ACOLHIMENTO_CLASSIFICACAO_RISCO, instrument: 'BPA_C', encounterId, patientId: enc.patientId });
      if (input.systolic) await recordProduction(tx, ctx, { procedureCode: SIGTAP.AFERICAO_PA, instrument: 'BPA_C', encounterId, patientId: enc.patientId });
      if (input.glucose) await recordProduction(tx, ctx, { procedureCode: SIGTAP.GLICEMIA_CAPILAR, instrument: 'BPA_C', encounterId, patientId: enc.patientId });
      await this.audit.record(ctx, tx, { action: 'triagem.classificar', entityType: 'Triage', entityId: t.id, payload: { encounterId, input, suggestion } });
      return t;
    });
    this.realtime.emitToUnit(ctx.tenant.id, ctx.session.unitId, 'fila.atualizada', { encounterId });
    if (color === 'VERMELHO') this.realtime.emitToUnit(ctx.tenant.id, ctx.session.unitId, 'alerta.emergencia', { encounterId, complaint: input.complaint });
    return { triage, suggestion, maxWaitMinutes: this.maxWait(ctx, color) };
  }
}
