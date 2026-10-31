import { Injectable, Logger } from '@nestjs/common';
import type { RequestContext } from '../../core/context';
import { DomainError } from '../../core/errors';
import {
  buildDischargeSummaryBundle,
  buildDispensationBundle,
  buildImmunizationBundle,
  buildRacBundle,
  FhirInputError,
  RndsCadsusClient,
  RndsClient,
  RndsError,
  validateRndsBundle,
  type FhirBundle,
  type PatientIdentity,
  type ProblemInput,
} from '@omnisaude/fhir';
import { IntegrationConfigService, type RndsConfig } from './integration-config.service';
import type { SystemContext } from './messaging.service';

const MAX_ATTEMPTS = 8;

/** Erro que não se resolve com nova tentativa (dado clínico incompleto ou rejeitado pela validação). */
class PermanentError extends Error {}

/** Códigos guardados como "CID10:I10" ou "CIAP2:K86" (o mesmo código pode existir nos dois sistemas). */
export function parseCode(code: string): ProblemInput {
  const [system, value] = code.includes(':') ? code.split(':', 2) : ['CID10', code];
  return { system: system === 'CIAP2' ? 'CIAP2' : 'CID10', code: value!.toUpperCase() };
}

@Injectable()
export class RndsService {
  private readonly logger = new Logger('RNDS');
  private readonly clients = new Map<string, { client: RndsClient; cfg: RndsConfig }>();

  constructor(private readonly integrations: IntegrationConfigService) {}

  private async client(tenantId: string) {
    const hit = this.clients.get(tenantId);
    if (hit) return hit;
    const cfg = await this.integrations.rnds(tenantId);
    if (!cfg) return null;
    const entry = { client: new RndsClient({ authUrl: cfg.authUrl, ehrUrl: cfg.ehrUrl, requesterCns: cfg.requesterCns, requesterCpf: cfg.requesterCpf, tls: cfg.tls }), cfg };
    this.clients.set(tenantId, entry);
    return entry;
  }

  /** Situação da configuração da RNDS da instituição, sem segredos, e a fila de envio. */
  async status(sys: SystemContext) {
    const cfg = await this.integrations.rnds(sys.tenant.id);
    const groups = await sys.db.outboxMessage.groupBy({ by: ['status'], _count: { _all: true }, where: { kind: { in: ['RNDS_RAC', 'RNDS_IMUNIZACAO', 'RNDS_DISPENSACAO', 'RNDS_SUMARIO_ALTA'] } } });
    const mask = (v: string) => `${v.slice(0, 3)}${'*'.repeat(Math.max(0, v.length - 5))}${v.slice(-2)}`;
    return {
      enabled: sys.tenant.settings.rndsEnabled,
      configured: !!cfg,
      environment: cfg?.environment ?? null,
      uf: cfg?.uf?.toUpperCase() ?? null,
      authUrl: cfg?.authUrl ?? null,
      ehrUrl: cfg?.ehrUrl ?? null,
      requester: cfg?.requesterCns ? { kind: 'CNS', value: mask(cfg.requesterCns) } : cfg?.requesterCpf ? { kind: 'CPF', value: mask(cfg.requesterCpf) } : null,
      requesterId: cfg?.requesterId ?? null,
      certificate: !!cfg?.tls,
      outbox: Object.fromEntries(groups.map((g) => [g.status, g._count._all])) as Record<string, number>,
    };
  }

  /** Obtém um token novo e consulta o próprio estabelecimento (CNES da unidade da sessão) na RNDS. */
  async testConnection(ctx: RequestContext) {
    this.clients.delete(ctx.tenant.id);
    const rnds = await this.client(ctx.tenant.id);
    if (!rnds) throw new DomainError('RNDS_NAO_CONFIGURADA', 'A RNDS não está configurada para esta instituição (ambiente, certificado e CNS do solicitante)');
    const unit = await ctx.db.unit.findUniqueOrThrow({ where: { id: ctx.session.unitId }, select: { cnes: true, name: true } });
    const started = Date.now();
    try {
      rnds.client.invalidateToken();
      const org = await rnds.client.getOrganization(unit.cnes);
      return { ok: true, environment: rnds.cfg.environment, cnes: unit.cnes, unit: unit.name, organization: org.name ?? null, elapsedMs: Date.now() - started };
    } catch (err) {
      const e = err as Partial<RndsError> & Error;
      return { ok: false, environment: rnds.cfg.environment, cnes: unit.cnes, unit: unit.name, status: e.status ?? null, message: e.message, elapsedMs: Date.now() - started };
    }
  }

  async cadsus(tenantId: string) {
    const c = await this.client(tenantId);
    return c ? new RndsCadsusClient(c.client) : null;
  }

  /** Processa o outbox: monta o documento FHIR a partir do registro e envia com mTLS, com backoff exponencial. */
  async dispatchDue(sys: SystemContext, now = new Date(), limit = 50) {
    const result = { sent: 0, failed: 0, discarded: 0 };
    if (!sys.tenant.settings.rndsEnabled) return result;
    const rnds = await this.client(sys.tenant.id);
    if (!rnds) return result;
    const due = await sys.db.outboxMessage.findMany({ where: { status: { in: ['PENDENTE', 'ERRO'] }, notBefore: { lte: now } }, orderBy: { createdAt: 'asc' }, take: limit });
    for (const msg of due) {
      try {
        const bundle = await this.buildBundle(sys, msg.kind, msg.aggregateId, msg.payload as Record<string, unknown>, rnds.cfg.requesterId, msg.id);
        const validation = validateRndsBundle(bundle);
        if (!validation.valid) throw new PermanentError(validation.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
        const sent = await rnds.client.sendBundle(bundle);
        await sys.db.outboxMessage.update({ where: { id: msg.id }, data: { status: 'ENVIADO', externalId: sent.id, sentAt: new Date(), attempts: { increment: 1 }, lastError: null } });
        result.sent++;
      } catch (err) {
        const permanent = err instanceof PermanentError || err instanceof FhirInputError || (err instanceof RndsError && err.status >= 400 && err.status < 500 && err.status !== 429 && err.status !== 401);
        const attempts = msg.attempts + 1;
        const discard = permanent || attempts >= MAX_ATTEMPTS;
        await sys.db.outboxMessage.update({
          where: { id: msg.id },
          data: {
            status: discard ? 'DESCARTADO' : 'ERRO',
            attempts,
            lastError: (err as Error).message.slice(0, 1000),
            notBefore: new Date(now.getTime() + 2 ** attempts * 60_000),
          },
        });
        if (discard) result.discarded++;
        else result.failed++;
        if (!permanent) this.logger.warn(`Falha ao enviar ${msg.kind} ${msg.id}: ${(err as Error).message}`);
      }
    }
    return result;
  }

  private async patientIdentity(sys: SystemContext, patientId: string): Promise<PatientIdentity> {
    const p = await sys.db.patient.findUniqueOrThrow({ where: { id: patientId } });
    if (!p.cpf && !p.cns) throw new PermanentError('Paciente sem CPF ou CNS: não pode ser enviado à RNDS');
    return { ...(p.cpf ? { cpf: p.cpf } : {}), ...(p.cns ? { cns: p.cns } : {}) };
  }

  private async practitioner(sys: SystemContext, userId: string, cbo: string) {
    const u = await sys.db.user.findUniqueOrThrow({ where: { id: userId } });
    return { cpf: u.cpf, ...(u.cns ? { cns: u.cns } : {}), cbo, name: u.name };
  }

  async buildBundle(sys: SystemContext, kind: string, aggregateId: string, payload: Record<string, unknown>, requesterId: string, localId: string): Promise<FhirBundle> {
    const meta = { rndsRequesterId: requesterId, localId };
    if (kind === 'RNDS_RAC') {
      const note = await sys.db.clinicalNote.findUniqueOrThrow({ where: { id: aggregateId }, include: { encounter: { include: { unit: true, triages: { orderBy: { classifiedAt: 'desc' }, take: 1 } } } } });
      const enc = note.encounter;
      const t = enc.triages[0];
      const problems = note.codes.map(parseCode);
      if (problems.length === 0) throw new PermanentError('Registro sem CID-10/CIAP-2');
      const production = await sys.db.productionRecord.findMany({ where: { encounterId: enc.id } });
      return buildRacBundle({
        ...meta,
        patient: await this.patientIdentity(sys, enc.patientId),
        practitioner: await this.practitioner(sys, note.authorId, note.cbo),
        establishment: { cnes: enc.unit.cnes, name: enc.unit.name },
        careLevel: enc.unit.type === 'UBS' ? 'ATENCAO_BASICA' : 'ATENCAO_ESPECIALIZADA',
        encounter: { start: enc.startedAt, end: enc.endedAt ?? note.signedAt ?? undefined, modality: enc.kind === 'DOMICILIAR' ? 'DOMICILIAR' : 'PRESENCIAL' },
        problems,
        procedures: production.map((p) => ({ sigtapCode: p.procedureCode, quantity: p.quantity })),
        vitals: t
          ? {
              systolic: t.systolic ?? undefined,
              diastolic: t.diastolic ?? undefined,
              heartRate: t.heartRate ?? undefined,
              respiratoryRate: t.respiratoryRate ?? undefined,
              temperature: t.temperature ? Number(t.temperature) : undefined,
              spo2: t.spo2 ?? undefined,
              weightKg: t.weightKg ? Number(t.weightKg) : undefined,
              heightCm: t.heightCm ?? undefined,
            }
          : undefined,
      });
    }
    if (kind === 'RNDS_DISPENSACAO') {
      const d = await sys.db.dispensation.findUniqueOrThrow({ where: { id: aggregateId }, include: { items: true } });
      const unit = await sys.db.unit.findUniqueOrThrow({ where: { id: d.unitId } });
      const assignment = await sys.db.userAssignment.findFirst({ where: { userId: d.dispensedBy, unitId: d.unitId } });
      const items = [];
      for (const i of d.items) {
        const product = await sys.db.product.findUniqueOrThrow({ where: { id: i.productId } });
        const lot = await sys.db.stockLot.findUniqueOrThrow({ where: { id: i.lotId } });
        if (!product.catmat) throw new PermanentError(`Produto ${product.code} sem código CATMAT no catálogo`);
        items.push({ catmatCode: product.catmat, display: product.description, quantity: Number(i.quantity), unit: product.unit, lot: lot.lotNumber, expirationDate: lot.expiry.toISOString().slice(0, 10) });
      }
      return buildDispensationBundle({
        ...meta,
        patient: await this.patientIdentity(sys, d.patientId),
        dispenser: await this.practitioner(sys, d.dispensedBy, assignment?.cbo ?? '223405'),
        establishment: { cnes: unit.cnes, name: unit.name },
        items,
        dispensedAt: d.dispensedAt,
        ...(d.prescriptionId ? { prescription: { identifier: d.prescriptionId } } : {}),
      });
    }
    if (kind === 'RNDS_IMUNIZACAO') {
      const v = await sys.db.vaccination.findUniqueOrThrow({ where: { id: aggregateId } });
      const unit = await sys.db.unit.findUniqueOrThrow({ where: { id: v.unitId } });
      const assignment = await sys.db.userAssignment.findFirst({ where: { userId: v.professionalId, unitId: v.unitId } });
      return buildImmunizationBundle({
        ...meta,
        patient: await this.patientIdentity(sys, v.patientId),
        practitioner: await this.practitioner(sys, v.professionalId, assignment?.cbo ?? '223505'),
        establishment: { cnes: unit.cnes, name: unit.name },
        vaccine: { code: v.vaccineCode, display: v.vaccineName },
        lot: v.lot,
        manufacturer: { code: v.manufacturer, display: v.manufacturer },
        dose: { code: v.dose, display: v.dose },
        occurrence: v.appliedAt,
        route: { code: v.route },
        ...(v.site ? { site: { code: v.site } } : {}),
      });
    }
    if (kind === 'RNDS_SUMARIO_ALTA') {
      const a = await sys.db.admission.findUniqueOrThrow({ where: { id: aggregateId }, include: { encounter: { include: { unit: true } } } });
      if (!a.dischargedAt) throw new PermanentError('Internação sem data de alta');
      const responsible = a.encounter.responsibleId ?? (payload.practitionerId as string | undefined);
      if (!responsible) throw new PermanentError('Internação sem profissional responsável');
      const assignment = await sys.db.userAssignment.findFirst({ where: { userId: responsible, unitId: a.encounter.unitId } });
      const secondary = Array.isArray(payload.secondaryCids) ? (payload.secondaryCids as string[]) : [];
      return buildDischargeSummaryBundle({
        ...meta,
        patient: await this.patientIdentity(sys, a.patientId),
        practitioner: await this.practitioner(sys, responsible, assignment?.cbo ?? '225125'),
        establishment: { cnes: a.encounter.unit.cnes, name: a.encounter.unit.name },
        admission: a.admittedAt,
        discharge: a.dischargedAt,
        dischargeDisposition: (payload.disposition as string) ?? 'home',
        diagnoses: [{ system: 'CID10', code: a.mainCid, role: 'principal' }, ...secondary.map((code) => ({ system: 'CID10' as const, code, role: 'secundario' as const }))],
        clinicalSummary: payload.summary as string | undefined,
        followUp: payload.followUp as string | undefined,
      });
    }
    throw new PermanentError(`Tipo de mensagem desconhecido: ${kind}`);
  }
}
