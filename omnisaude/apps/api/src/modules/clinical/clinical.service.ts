import { Inject, Injectable } from '@nestjs/common';
import {
  analyzePrescription,
  parseVoiceCommand,
  structureSoap,
  suggestCarePathway,
  WhisperAsrProvider,
  type MedicationItem,
} from '@omnisaude/ai-engine';
import { ageInYears, roleHasPermission } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import type { RequestContext } from '../../core/context';
import { DomainError, forbidden, notFound } from '../../core/errors';
import { OutboxService } from '../../core/outbox.service';
import { recordProduction, SIGTAP } from '../../core/production';
import { AiService } from '../integrations/ai.service';
import { MessagingService } from '../integrations/messaging.service';

export interface CodeRef {
  system: 'CID10' | 'CIAP2';
  code: string;
}

export interface NoteInput {
  kind: 'SOAP' | 'EVOLUCAO' | 'ODONTOGRAMA' | 'LAUDO_INTERNACAO';
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
  codes?: CodeRef[];
  data?: Record<string, unknown>;
}

export interface PrescriptionItemInput {
  productId?: string;
  description: string;
  activeIngredient?: string;
  dose?: number;
  doseUnit?: string;
  route?: string;
  frequencyHours?: number;
  durationDays?: number;
  quantity?: number;
  instructions?: string;
}

const encodeCode = (c: CodeRef) => `${c.system}:${c.code.toUpperCase().replace('.', '')}`;

@Injectable()
export class ClinicalService {
  constructor(
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly ai: AiService,
    private readonly messaging: MessagingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async encounter(ctx: RequestContext, id: string) {
    const e = await ctx.db.encounter.findUnique({ where: { id }, include: { unit: true } });
    if (!e) throw notFound('Atendimento');
    return e;
  }

  async get(ctx: RequestContext, id: string) {
    const e = await ctx.db.encounter.findUnique({
      where: { id },
      include: {
        unit: true,
        patient: { include: { allergies: true, conditions: { where: { active: true } } } },
        triages: { orderBy: { classifiedAt: 'desc' } },
        notes: { orderBy: { createdAt: 'asc' } },
        prescriptions: { include: { items: true }, orderBy: { signedAt: 'desc' } },
        examRequests: { orderBy: { requestedAt: 'desc' } },
        admission: true,
      },
    });
    if (!e) throw notFound('Atendimento');
    const users = new Map((await ctx.db.user.findMany({ where: { id: { in: [...new Set(e.notes.map((n) => n.authorId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    await this.audit.recordStandalone(ctx, { action: 'prontuario.visualizar', entityType: 'Encounter', entityId: id, payload: { patientId: e.patientId } });
    return {
      ...e,
      patient: { ...e.patient, age: ageInYears(e.patient.birthDate) },
      notes: e.notes.map((n) => ({ ...n, authorName: users.get(n.authorId) ?? null })),
    };
  }

  async start(ctx: RequestContext, id: string) {
    const e = await this.encounter(ctx, id);
    if (e.status === 'ENCERRADO' || e.status === 'CANCELADO') throw new DomainError('ATENDIMENTO_ENCERRADO', 'Atendimento encerrado');
    return ctx.db.$transaction(async (tx) => {
      const updated = await tx.encounter.update({ where: { id }, data: { status: 'EM_ATENDIMENTO', responsibleId: ctx.session.userId } });
      await this.audit.record(ctx, tx, { action: 'atendimento.iniciar', entityType: 'Encounter', entityId: id, payload: {} });
      return updated;
    });
  }

  async createNote(ctx: RequestContext, encounterId: string, input: NoteInput) {
    if (input.kind === 'ODONTOGRAMA' && !roleHasPermission(ctx.session.role, 'odontograma.registrar')) throw forbidden('Odontograma é registrado pela equipe de odontologia');
    const e = await this.encounter(ctx, encounterId);
    if (e.status === 'ENCERRADO' || e.status === 'CANCELADO') throw new DomainError('ATENDIMENTO_ENCERRADO', 'Atendimento encerrado: registre em um novo atendimento');
    return ctx.db.clinicalNote.create({
      data: {
        encounterId,
        authorId: ctx.session.userId,
        role: ctx.session.role,
        cbo: ctx.cbo,
        kind: input.kind,
        subjective: input.subjective,
        objective: input.objective,
        assessment: input.assessment,
        plan: input.plan,
        codes: (input.codes ?? []).map(encodeCode),
        data: (input.data ?? {}) as object,
      },
    });
  }

  private async draft(ctx: RequestContext, id: string) {
    const n = await ctx.db.clinicalNote.findUnique({ where: { id } });
    if (!n) throw notFound('Registro clínico');
    if (n.authorId !== ctx.session.userId) throw forbidden('Somente o autor altera ou assina o registro');
    if (n.status === 'ASSINADO') throw new DomainError('REGISTRO_ASSINADO', 'Registro já assinado: registre uma nova evolução');
    return n;
  }

  async updateNote(ctx: RequestContext, id: string, input: Partial<NoteInput>) {
    await this.draft(ctx, id);
    return ctx.db.clinicalNote.update({
      where: { id },
      data: {
        subjective: input.subjective,
        objective: input.objective,
        assessment: input.assessment,
        plan: input.plan,
        ...(input.codes ? { codes: input.codes.map(encodeCode) } : {}),
        ...(input.data ? { data: input.data as object } : {}),
      },
    });
  }

  /**
   * Assinatura: congela o registro (gatilho no banco impede alterações), grava o hash SHA-256 na trilha
   * encadeada (conteúdo + instante UTC + IP + 2FA), lança a produção e envia o RAC à RNDS pelo outbox.
   */
  async signNote(ctx: RequestContext, id: string) {
    const n = await this.draft(ctx, id);
    if (n.kind === 'SOAP' && !n.assessment?.trim()) throw new DomainError('AVALIACAO_OBRIGATORIA', 'Preencha a avaliação antes de assinar');
    if (n.kind === 'SOAP' && n.codes.length === 0) throw new DomainError('CID_OBRIGATORIO', 'Informe ao menos um CID-10 ou CIAP-2');
    const e = await this.encounter(ctx, n.encounterId);
    return ctx.db.$transaction(async (tx) => {
      const payload = {
        noteId: n.id,
        encounterId: n.encounterId,
        patientId: e.patientId,
        kind: n.kind,
        subjective: n.subjective,
        objective: n.objective,
        assessment: n.assessment,
        plan: n.plan,
        codes: n.codes,
        data: n.data,
        author: ctx.session.userId,
        cbo: n.cbo,
      };
      const { hash } = await this.audit.record(ctx, tx, { action: 'prontuario.assinar', entityType: 'ClinicalNote', entityId: n.id, payload });
      const signed = await tx.clinicalNote.update({ where: { id }, data: { status: 'ASSINADO', signedAt: new Date(), auditHash: hash } });
      // Produção da atenção especializada/urgência vai para o BPA; a da atenção básica segue pelo e-SUS APS.
      if (n.kind === 'SOAP' && e.unit.type !== 'UBS') {
        const procedureCode =
          ctx.session.role === 'MEDICO'
            ? e.kind === 'URGENCIA'
              ? SIGTAP.ATENDIMENTO_URGENCIA
              : SIGTAP.CONSULTA_ESPECIALIZADA
            : SIGTAP.CONSULTA_NIVEL_SUPERIOR_ESPECIALIZADA;
        const cid = n.codes.find((c) => !c.startsWith('CIAP2:'));
        await recordProduction(tx, ctx, { procedureCode, instrument: 'BPA_I', encounterId: e.id, patientId: e.patientId, cid });
      }
      if (n.kind === 'SOAP' && ctx.tenant.settings.rndsEnabled) await this.outbox.enqueue(tx, 'RNDS_RAC', n.id);
      return signed;
    });
  }

  async close(ctx: RequestContext, id: string, input: { outcome: 'ALTA' | 'INTERNACAO' | 'ENCAMINHAMENTO' | 'TRANSFERENCIA' | 'OBITO' | 'EVASAO'; mainCid?: string }) {
    const e = await this.encounter(ctx, id);
    if (e.status === 'ENCERRADO') throw new DomainError('ATENDIMENTO_ENCERRADO', 'Atendimento já encerrado');
    const drafts = await ctx.db.clinicalNote.count({ where: { encounterId: id, status: 'RASCUNHO' } });
    if (drafts > 0) throw new DomainError('RASCUNHOS_PENDENTES', 'Assine ou descarte os registros em rascunho antes de encerrar');
    const signed = await ctx.db.clinicalNote.count({ where: { encounterId: id, status: 'ASSINADO' } });
    if (signed === 0 && input.outcome !== 'EVASAO') throw new DomainError('SEM_REGISTRO', 'Não há registro clínico assinado neste atendimento');
    return ctx.db.$transaction(async (tx) => {
      const updated = await tx.encounter.update({
        where: { id },
        data: { status: input.outcome === 'EVASAO' ? 'EVADIU' : 'ENCERRADO', outcome: input.outcome, endedAt: new Date(), mainCid: input.mainCid ?? e.mainCid },
      });
      await this.audit.record(ctx, tx, { action: 'atendimento.encerrar', entityType: 'Encounter', entityId: id, payload: input });
      return updated;
    });
  }

  async deleteDraft(ctx: RequestContext, id: string) {
    await this.draft(ctx, id);
    await ctx.db.clinicalNote.delete({ where: { id } });
    return { deleted: true };
  }

  // ───────────── Prescrição com copiloto clínico ─────────────

  /** Monta o contexto clínico do paciente (medicamentos em uso, alergias, condições e exames recentes). */
  private async copilotContext(ctx: RequestContext, patientId: string) {
    const patient = await ctx.db.patient.findUnique({ where: { id: patientId }, include: { allergies: true, conditions: { where: { active: true } } } });
    if (!patient) throw notFound('Paciente');
    const since = new Date(Date.now() - 180 * 86_400_000);
    const active = await ctx.db.prescription.findMany({
      where: { patientId, status: 'ATIVA', signedAt: { gte: since } },
      include: { items: { where: { suspendedAt: null } } },
    });
    const currentMedications: MedicationItem[] = active
      .flatMap((p) => p.items.filter((i) => !i.durationDays || p.signedAt.getTime() + i.durationDays * 86_400_000 > Date.now()))
      .map((i) => ({ name: i.description, ...(i.activeIngredient ? { activeIngredients: [i.activeIngredient] } : {}), route: i.route ?? undefined }));
    const exams = await ctx.db.examRequest.findMany({ where: { patientId, status: 'RESULTADO', analyte: { not: null }, resultValue: { not: null } }, orderBy: { resultAt: 'desc' } });
    const latest = new Map<string, (typeof exams)[number]>();
    for (const x of exams) if (!latest.has(x.analyte!)) latest.set(x.analyte!, x);
    const lastTriage = await ctx.db.triage.findFirst({ where: { encounter: { patientId }, weightKg: { not: null } }, orderBy: { classifiedAt: 'desc' } });
    return {
      patient,
      input: {
        currentMedications,
        allergies: patient.allergies.map((a) => a.substance),
        conditions: patient.conditions.filter((c) => c.system === 'CID10').map((c) => c.code),
        labs: [...latest.values()].map((x) => ({ code: x.analyte!, value: Number(x.resultValue), unit: x.resultUnit ?? undefined, collectedAt: x.resultAt ?? x.requestedAt })),
        patient: {
          ageYears: ageInYears(patient.birthDate),
          sex: patient.sex,
          weightKg: lastTriage?.weightKg ? Number(lastTriage.weightKg) : undefined,
          pregnant: patient.conditions.some((c) => c.lineOfCare === 'GESTANTE'),
        },
      },
    };
  }

  private toMedication(i: PrescriptionItemInput): MedicationItem {
    return {
      name: i.description,
      ...(i.activeIngredient ? { activeIngredients: [i.activeIngredient] } : {}),
      ...(i.dose ? { dose: `${i.dose} ${i.doseUnit ?? ''}`.trim() } : {}),
      ...(i.route ? { route: i.route } : {}),
      ...(i.frequencyHours ? { frequency: `${i.frequencyHours}/${i.frequencyHours}h` } : {}),
    };
  }

  async checkPrescription(ctx: RequestContext, patientId: string, items: PrescriptionItemInput[]) {
    const { input } = await this.copilotContext(ctx, patientId);
    return analyzePrescription({ ...input, newItems: items.map((i) => this.toMedication(i)) });
  }

  /** Prescrição eletrônica: alerta GRAVE exige justificativa formal do prescritor para prosseguir. */
  async prescribe(ctx: RequestContext, encounterId: string, input: { kind?: 'AMBULATORIAL' | 'HOSPITALAR'; items: PrescriptionItemInput[]; justification?: string }) {
    const e = await this.encounter(ctx, encounterId);
    if (e.status === 'ENCERRADO' || e.status === 'CANCELADO') throw new DomainError('ATENDIMENTO_ENCERRADO', 'Atendimento encerrado');
    for (const i of input.items) {
      if (i.productId && !(await ctx.db.product.findUnique({ where: { id: i.productId } }))) throw notFound(`Produto ${i.productId}`);
    }
    const analysis = await this.checkPrescription(ctx, e.patientId, input.items);
    if (analysis.requiresJustification && !input.justification?.trim()) {
      throw new DomainError('JUSTIFICATIVA_OBRIGATORIA', 'Há alerta crítico: registre a justificativa clínica para prosseguir', 422, { alerts: analysis.alerts });
    }
    const kind = input.kind ?? (e.kind === 'INTERNACAO' ? 'HOSPITALAR' : 'AMBULATORIAL');
    const rx = await ctx.db.$transaction(async (tx) => {
      const created = await tx.prescription.create({
        data: {
          encounterId,
          patientId: e.patientId,
          prescriberId: ctx.session.userId,
          kind,
          alerts: analysis.alerts as unknown as object,
          justification: input.justification?.trim() || null,
          items: {
            create: input.items.map((i) => ({
              productId: i.productId ?? null,
              description: i.description,
              activeIngredient: i.activeIngredient ?? null,
              dose: i.dose ?? null,
              doseUnit: i.doseUnit ?? null,
              route: i.route ?? null,
              frequencyHours: i.frequencyHours ?? null,
              durationDays: i.durationDays ?? null,
              quantity: i.quantity ?? null,
              instructions: i.instructions ?? null,
            })),
          },
        },
        include: { items: true },
      });
      const { hash } = await this.audit.record(ctx, tx, {
        action: 'prescricao.emitir',
        entityType: 'Prescription',
        entityId: created.id,
        payload: { encounterId, items: input.items, alerts: analysis.alerts, justification: input.justification ?? null },
      });
      return tx.prescription.update({ where: { id: created.id }, data: { auditHash: hash }, include: { items: true } });
    });
    let reminders = 0;
    if (kind === 'AMBULATORIAL') reminders = await this.messaging.scheduleAdherenceReminders({ tenant: ctx.tenant, db: ctx.db }, rx.id);
    return { prescription: rx, alerts: analysis.alerts, egfr: analysis.egfr ?? null, adherenceReminders: reminders };
  }

  async suspendItem(ctx: RequestContext, prescriptionId: string, itemId: string, reason: string) {
    const item = await ctx.db.prescriptionItem.findFirst({ where: { id: itemId, prescriptionId } });
    if (!item) throw notFound('Item de prescrição');
    if (item.suspendedAt) throw new DomainError('JA_SUSPENSO', 'Item já suspenso');
    return ctx.db.$transaction(async (tx) => {
      const updated = await tx.prescriptionItem.update({ where: { id: itemId }, data: { suspendedAt: new Date() } });
      await tx.messageLog.updateMany({ where: { refId: itemId, status: 'AGENDADA' }, data: { status: 'CANCELADA' } });
      await this.audit.record(ctx, tx, { action: 'prescricao.suspender', entityType: 'PrescriptionItem', entityId: itemId, payload: { reason } });
      return updated;
    });
  }

  patientPrescriptions(ctx: RequestContext, patientId: string, activeOnly: boolean) {
    return ctx.db.prescription.findMany({
      where: { patientId, ...(activeOnly ? { status: 'ATIVA' } : {}) },
      include: { items: true },
      orderBy: { signedAt: 'desc' },
      take: 50,
    });
  }

  // ───────────── Exames e linhas de cuidado ─────────────

  async requestExams(ctx: RequestContext, encounterId: string, items: { sigtapCode: string; name: string; analyte?: string }[]) {
    const e = await this.encounter(ctx, encounterId);
    return ctx.db.$transaction(
      items.map((i) =>
        ctx.db.examRequest.create({
          data: { encounterId, patientId: e.patientId, requesterId: ctx.session.userId, sigtapCode: i.sigtapCode.replace(/\D/g, ''), name: i.name, analyte: i.analyte ?? null },
        }),
      ),
    );
  }

  async recordResult(ctx: RequestContext, id: string, input: { value?: number; unit?: string; text?: string }) {
    const x = await ctx.db.examRequest.findUnique({ where: { id } });
    if (!x) throw notFound('Exame');
    return ctx.db.examRequest.update({ where: { id }, data: { status: 'RESULTADO', resultValue: input.value ?? null, resultUnit: input.unit ?? null, resultText: input.text ?? null, resultAt: new Date() } });
  }

  carePathway(code: string, system: 'CID10' | 'CIAP2' = 'CID10') {
    const p = suggestCarePathway(code, system);
    if (!p) throw new DomainError('SEM_PROTOCOLO', `Sem linha de cuidado cadastrada para ${code}`, 404);
    return p;
  }

  /** Solicita de uma vez os exames recomendados pelo protocolo da condição. */
  async requestPathwayExams(ctx: RequestContext, encounterId: string, code: string, system: 'CID10' | 'CIAP2') {
    const p = this.carePathway(code, system);
    return this.requestExams(ctx, encounterId, p.exams.map((x) => ({ sigtapCode: x.sigtapCode, name: x.name })));
  }

  // ───────────── Voz e IA ─────────────

  /** Ditado clínico estruturado: com IA ativada usa o modelo; senão, a segmentação heurística local. */
  async soapFromTranscript(ctx: RequestContext, transcript: string, useAi = true) {
    const llm = useAi && this.ai.enabledFor(ctx) ? this.ai.client! : undefined;
    return structureSoap(transcript, { llm });
  }

  async transcribe(ctx: RequestContext, audioBase64: string, mimeType: string) {
    if (!this.config.WHISPER_ASR_URL) throw new DomainError('STT_INDISPONIVEL', 'Transcrição no servidor não configurada; use o ditado do aparelho', 503);
    const provider = new WhisperAsrProvider({ baseUrl: this.config.WHISPER_ASR_URL });
    return provider.transcribe({ data: Buffer.from(audioBase64, 'base64'), mimeType }, { language: 'pt' });
  }

  voiceCommand(text: string) {
    return parseVoiceCommand(text);
  }

  // ───────────── Atestado e vacinação ─────────────

  /** Atestado: o CID só é impresso com autorização expressa do paciente (Código de Ética Médica). */
  async certificate(ctx: RequestContext, encounterId: string, input: { days: number; cid?: string; includeCid: boolean; text?: string }) {
    const e = await this.encounter(ctx, encounterId);
    const patient = await ctx.db.patient.findUniqueOrThrow({ where: { id: e.patientId } });
    const author = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId }, include: { assignments: { where: { unitId: ctx.session.unitId } } } });
    const signed = await ctx.db.$transaction(async (tx) => {
      const note = await tx.clinicalNote.create({
        data: {
          encounterId,
          authorId: ctx.session.userId,
          role: ctx.session.role,
          cbo: ctx.cbo,
          kind: 'ATESTADO',
          plan: input.text ?? `Atestado de ${input.days} dia(s) de afastamento.`,
          codes: input.cid ? [encodeCode({ system: 'CID10', code: input.cid })] : [],
          data: { days: input.days, includeCid: input.includeCid, cid: input.includeCid ? (input.cid ?? null) : null },
        },
      });
      const { hash } = await this.audit.record(ctx, tx, { action: 'atestado.emitir', entityType: 'ClinicalNote', entityId: note.id, payload: { encounterId, ...input } });
      return tx.clinicalNote.update({ where: { id: note.id }, data: { status: 'ASSINADO', signedAt: new Date(), auditHash: hash } });
    });
    return {
      noteId: signed.id,
      auditHash: signed.auditHash,
      printable: {
        title: 'ATESTADO',
        patient: patient.socialName ?? patient.name,
        days: input.days,
        cid: input.includeCid ? input.cid ?? null : null,
        text: input.text ?? `Atesto, para os devidos fins, que ${patient.socialName ?? patient.name} esteve sob meus cuidados e necessita de ${input.days} dia(s) de afastamento de suas atividades.`,
        professional: author.name,
        council: author.assignments[0]?.council ?? null,
        unit: e.unit.name,
        issuedAt: signed.signedAt,
        verification: signed.auditHash,
      },
    };
  }

  async vaccinate(ctx: RequestContext, input: { patientId: string; vaccineCode: string; vaccineName: string; lot: string; manufacturer: string; dose: string; route: string; site?: string; appliedAt?: string }) {
    const patient = await ctx.db.patient.findUnique({ where: { id: input.patientId } });
    if (!patient) throw notFound('Paciente');
    return ctx.db.$transaction(async (tx) => {
      const v = await tx.vaccination.create({
        data: { ...input, appliedAt: input.appliedAt ? new Date(input.appliedAt) : new Date(), unitId: ctx.session.unitId, professionalId: ctx.session.userId },
      });
      await this.audit.record(ctx, tx, { action: 'vacina.aplicar', entityType: 'Vaccination', entityId: v.id, payload: input });
      if (ctx.tenant.settings.rndsEnabled) await this.outbox.enqueue(tx, 'RNDS_IMUNIZACAO', v.id);
      return v;
    });
  }
}
