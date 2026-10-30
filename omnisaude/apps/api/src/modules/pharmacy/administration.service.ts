import { Injectable } from '@nestjs/common';
import { normalizeGtin, parseGs1, type Gs1Data } from '@omnisaude/shared';
import type { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, forbidden, notFound } from '../../core/errors';
import { PharmacyClock } from './clock';
import type { administrationSchema } from './pharmacy.schemas';
import { dateOnly, debit, normalizeText, startOfDay } from './stock';

/** Tolerância do "horário certo" em torno do horário aprazado. */
export const TIME_TOLERANCE_MINUTES = 30;
const ACTIVE_ENCOUNTER = ['ABERTO', 'TRIADO', 'EM_ATENDIMENTO'];
/** Um checklist de POP vale por 2 horas e para uma única administração. */
const POP_VALIDITY_MS = 2 * 3_600_000;

export const POP_TRIGGERS = {
  highAlert: 'administracao.alta_vigilancia',
  antimicrobialRestricted: 'administracao.antimicrobiano_restrito',
} as const;

export type CheckName = 'PACIENTE' | 'PRESCRICAO' | 'MEDICAMENTO' | 'VIA' | 'DOSE' | 'HORARIO' | 'POP';
export interface Check {
  check: CheckName;
  ok: boolean;
  detail: string;
}

type Input = z.infer<typeof administrationSchema>;

@Injectable()
export class AdministrationService {
  /** Data e hora no fuso do tenant, como a enfermagem lê na tela ("30/10 14:00"). */
  private when(ctx: RequestContext, d: Date): string {
    return d.toLocaleString('pt-BR', { timeZone: ctx.tenant.timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  constructor(
    private readonly audit: AuditService,
    private readonly clock: PharmacyClock,
  ) {}

  /** Horários aprazados: início da prescrição + k × intervalo, até o fim do tratamento. */
  static slots(signedAt: Date, frequencyHours: number | null, durationDays: number | null, from: Date, to: Date): Date[] {
    if (!frequencyHours) return [];
    const step = frequencyHours * 3_600_000;
    const end = durationDays ? signedAt.getTime() + durationDays * 86_400_000 : Number.POSITIVE_INFINITY;
    const out: Date[] = [];
    let k = Math.max(0, Math.ceil((from.getTime() - signedAt.getTime()) / step));
    for (let t = signedAt.getTime() + k * step; t <= to.getTime() && t < end; k++, t = signedAt.getTime() + k * step) out.push(new Date(t));
    return out;
  }

  /**
   * Administração beira-leito com a regra dos 5 certos (paciente, medicamento, via, dose e horário),
   * mais os hard gates de POP. Só aqui a dose sai definitivamente do estoque do posto.
   */
  async administer(ctx: RequestContext, input: Input) {
    const now = this.clock.now();
    const item = await ctx.db.prescriptionItem.findUnique({
      where: { id: input.prescriptionItemId },
      include: { prescription: { include: { encounter: { include: { admission: true } } } } },
    });
    if (!item) throw notFound('Item de prescrição');
    const { prescription } = item;
    const encounter = prescription.encounter;
    if (encounter.unitId !== ctx.session.unitId) throw forbidden('O paciente está em outra unidade');

    const checks: Check[] = [];
    const add = (check: CheckName, ok: boolean, detail: string) => checks.push({ check, ok, detail });

    // 1. Paciente certo: pulseira = paciente da prescrição, com atendimento/internação ativa.
    const scannedPatient = /^PAC:([0-9a-f-]{36})$/i.exec(input.patientCode.trim())?.[1]?.toLowerCase();
    const activeEncounter = ACTIVE_ENCOUNTER.includes(encounter.status) && !encounter.admission?.dischargedAt;
    if (!scannedPatient) add('PACIENTE', false, 'Pulseira ilegível');
    else if (scannedPatient !== prescription.patientId) add('PACIENTE', false, 'A pulseira lida é de outro paciente');
    else if (!activeEncounter) add('PACIENTE', false, 'Paciente sem atendimento ou internação ativa');
    else add('PACIENTE', true, 'Pulseira confere com a prescrição');

    const itemActive = prescription.status === 'ATIVA' && !item.suspendedAt;
    add('PRESCRICAO', itemActive, itemActive ? 'Prescrição ativa' : 'Item suspenso ou prescrição encerrada');

    // 2. Medicamento certo e 4. dose certa: a dose unitária lida (Datamatrix) e seu estado.
    let gs1: Gs1Data | null = null;
    try {
      gs1 = parseGs1(input.doseCode);
    } catch {
      gs1 = null;
    }
    const dose = gs1?.serial ? await ctx.db.unitDose.findUnique({ where: { serial: gs1.serial } }) : null;
    const product = item.productId
      ? await ctx.db.product.findUnique({ where: { id: item.productId } })
      : dose
        ? await ctx.db.product.findUnique({ where: { id: dose.productId } })
        : null;
    if (!gs1) add('MEDICAMENTO', false, 'Código da dose ilegível');
    else if (!dose) add('MEDICAMENTO', false, 'Dose unitária não encontrada (etiqueta sem série válida)');
    else {
      const sameProduct = item.productId
        ? dose.productId === item.productId
        : !!(item.activeIngredient && product?.activeIngredient && normalizeText(item.activeIngredient) === normalizeText(product.activeIngredient));
      const sameGtin = normalizeGtin(dose.gtin) === normalizeGtin(gs1.gtin);
      if (!sameGtin) add('MEDICAMENTO', false, 'GTIN da etiqueta não confere com a dose cadastrada');
      else if (!sameProduct) add('MEDICAMENTO', false, `Medicamento lido não é o prescrito (${item.description})`);
      else add('MEDICAMENTO', true, item.description);
    }

    // 3. Via certa.
    const prescribedRoute = (item.route ?? '').toUpperCase();
    add('VIA', !!prescribedRoute && prescribedRoute === input.route, prescribedRoute === input.route ? `Via ${input.route}` : `Via prescrita: ${prescribedRoute || 'não informada'}`);

    const today = startOfDay(now);
    const station = dose ? await ctx.db.stockLocation.findUnique({ where: { id: dose.locationId } }) : null;
    if (!dose) add('DOSE', false, 'Sem dose unitária válida');
    else if (dose.status !== 'DISPONIVEL') add('DOSE', false, `Dose ${dose.status.toLowerCase()}`);
    else if (dose.expiry < today) add('DOSE', false, `Dose vencida em ${dateOnly(dose.expiry).split('-').reverse().join('/')}`);
    else if (!station || station.kind !== 'POSTO_ENFERMAGEM' || station.unitId !== encounter.unitId) add('DOSE', false, 'A dose não está no posto de enfermagem desta unidade');
    else add('DOSE', true, `Lote válido até ${dateOnly(dose.expiry).split('-').reverse().join('/')}`);

    // 5. Horário certo: dentro da tolerância de um horário aprazado ainda não administrado.
    let slot: Date | null = null;
    if (!item.frequencyHours) {
      slot = now;
      add('HORARIO', true, 'Dose sem aprazamento fixo');
    } else {
      const tol = TIME_TOLERANCE_MINUTES * 60_000;
      const candidates = AdministrationService.slots(prescription.signedAt, item.frequencyHours, item.durationDays, new Date(now.getTime() - tol), new Date(now.getTime() + tol));
      slot = candidates[0] ?? null;
      if (!slot) {
        const next = AdministrationService.slots(prescription.signedAt, item.frequencyHours, item.durationDays, now, new Date(now.getTime() + 7 * 86_400_000))[0];
        add('HORARIO', false, next ? `Fora do horário: próxima dose às ${this.when(ctx, next)}` : 'Tratamento encerrado');
      } else {
        const done = await ctx.db.administration.findFirst({ where: { prescriptionItemId: item.id, status: 'ADMINISTRADO', scheduledFor: slot } });
        if (done) add('HORARIO', false, `Dose das ${this.when(ctx, slot)} já administrada`);
        else add('HORARIO', true, `Horário aprazado ${this.when(ctx, slot)}`);
      }
    }

    // Hard gates: alta vigilância e antimicrobiano restrito exigem POP executado (com dupla checagem).
    const triggers: string[] = [];
    if (product?.highAlert) triggers.push(POP_TRIGGERS.highAlert);
    if (product?.antimicrobialRestricted) triggers.push(POP_TRIGGERS.antimicrobialRestricted);
    const executionIds = [...(input.popExecutionIds ?? []), ...(input.popExecutionId ? [input.popExecutionId] : [])];
    const usedExecutions: { id: string; doubleCheckUserId: string | null }[] = [];
    if (triggers.length) {
      const execs = executionIds.length
        ? await ctx.db.popExecution.findMany({ where: { id: { in: executionIds } }, include: { pop: true } })
        : [];
      const missing: string[] = [];
      for (const trigger of triggers) {
        const exec = execs.find(
          (e) =>
            e.pop.trigger === trigger &&
            e.pop.kind === 'HARD' &&
            !e.consumedAt &&
            e.userId === ctx.session.userId &&
            (!e.patientId || e.patientId === prescription.patientId) &&
            (!e.pop.requiresDoubleCheck || e.doubleCheckUserId) &&
            // Validade do checklist em tempo real (independe do horário aprazado).
            Date.now() - e.completedAt.getTime() <= POP_VALIDITY_MS,
        );
        if (exec) usedExecutions.push({ id: exec.id, doubleCheckUserId: exec.doubleCheckUserId });
        else missing.push(trigger);
      }
      add('POP', missing.length === 0, missing.length ? `POP obrigatório não executado: ${missing.join(', ')}` : 'POP executado com checklist');
    }

    const ok = checks.every((c) => c.ok);
    const patientId = prescription.patientId;
    const locationId =
      dose?.locationId ??
      (await ctx.db.stockLocation.findFirst({ where: { unitId: encounter.unitId, kind: 'POSTO_ENFERMAGEM' } }))?.id ??
      (await ctx.db.stockLocation.findFirstOrThrow({ where: { unitId: encounter.unitId } })).id;

    if (!ok) {
      const blocked = await ctx.db.$transaction(async (tx) => {
        const adm = await tx.administration.create({
          data: { patientId, prescriptionItemId: item.id, unitDoseId: dose?.id ?? null, locationId, status: 'BLOQUEADO', checks: checks as unknown as object, route: input.route, scheduledFor: slot, administeredBy: ctx.session.userId, at: now },
        });
        await this.audit.record(ctx, tx, { action: 'administracao.bloqueada', entityType: 'Administration', entityId: adm.id, payload: { itemId: item.id, checks } });
        return adm;
      });
      return { ok: false as const, body: { status: 'BLOQUEADO' as const, administrationId: blocked.id, checks, sound: 'BLOQUEIO' as const } };
    }

    const done = await ctx.db.$transaction(async (tx) => {
      // Serializa administrações do mesmo item para que o mesmo horário não seja dado duas vezes.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${item.id}))`;
      const already = await tx.administration.findFirst({ where: { prescriptionItemId: item.id, status: 'ADMINISTRADO', scheduledFor: slot } });
      if (already && item.frequencyHours) throw new DomainError('DOSE_JA_ADMINISTRADA', 'Este horário acabou de ser administrado por outro profissional');
      const { count } = await tx.unitDose.updateMany({ where: { id: dose!.id, status: 'DISPONIVEL' }, data: { status: 'ADMINISTRADA' } });
      if (count !== 1) throw new DomainError('DOSE_INDISPONIVEL', 'A dose acabou de ser movimentada');
      await debit(tx, dose!.locationId, dose!.lotId, 1, { kind: 'ADMINISTRACAO', userId: ctx.session.userId, refType: 'UnitDose', refId: dose!.id, patientId });
      for (const e of usedExecutions) {
        const r = await tx.popExecution.updateMany({ where: { id: e.id, consumedAt: null }, data: { consumedAt: now } });
        if (r.count !== 1) throw new DomainError('POP_JA_UTILIZADO', 'Execução de POP já utilizada em outra administração');
      }
      const adm = await tx.administration.create({
        data: {
          patientId,
          prescriptionItemId: item.id,
          unitDoseId: dose!.id,
          locationId: dose!.locationId,
          status: 'ADMINISTRADO',
          checks: checks as unknown as object,
          route: input.route,
          scheduledFor: slot,
          administeredBy: ctx.session.userId,
          doubleCheckBy: usedExecutions.find((e) => e.doubleCheckUserId)?.doubleCheckUserId ?? null,
          popExecutionId: usedExecutions[0]?.id ?? null,
          at: now,
        },
      });
      await this.audit.record(ctx, tx, {
        action: 'administracao.registrar',
        entityType: 'Administration',
        entityId: adm.id,
        payload: { itemId: item.id, serial: dose!.serial, route: input.route, scheduledFor: slot, checks, pops: usedExecutions.map((e) => e.id) },
      });
      return adm;
    });
    return { ok: true as const, body: { status: 'ADMINISTRADO' as const, administrationId: done.id, scheduledFor: slot, checks, sound: 'APROVADO' as const } };
  }

  /** Aprazamento do paciente para a tela beira-leito: itens ativos, próximos horários e o que está devido agora. */
  async schedule(ctx: RequestContext, patientId: string) {
    const now = this.clock.now();
    const tol = TIME_TOLERANCE_MINUTES * 60_000;
    const prescriptions = await ctx.db.prescription.findMany({
      where: { patientId, status: 'ATIVA', kind: 'HOSPITALAR', encounter: { status: { in: ACTIVE_ENCOUNTER as never } } },
      include: { items: true, encounter: true },
    });
    const productIds = prescriptions.flatMap((p) => p.items.map((i) => i.productId).filter((x): x is string => !!x));
    const products = new Map((await ctx.db.product.findMany({ where: { id: { in: productIds } } })).map((p) => [p.id, p]));
    const stations = await ctx.db.stockLocation.findMany({ where: { unitId: ctx.session.unitId, kind: 'POSTO_ENFERMAGEM' } });
    const items = [];
    for (const p of prescriptions) {
      for (const i of p.items.filter((x) => !x.suspendedAt)) {
        const product = i.productId ? products.get(i.productId) : undefined;
        const upcoming = AdministrationService.slots(p.signedAt, i.frequencyHours, i.durationDays, new Date(now.getTime() - tol), new Date(now.getTime() + 24 * 3_600_000));
        const done = await ctx.db.administration.findMany({ where: { prescriptionItemId: i.id, status: 'ADMINISTRADO' }, orderBy: { at: 'desc' } });
        const doneSlots = new Set(done.map((d) => d.scheduledFor?.getTime()));
        const pending = upcoming.filter((s) => !doneSlots.has(s.getTime()));
        const due = pending.find((s) => Math.abs(s.getTime() - now.getTime()) <= tol) ?? null;
        const available = i.productId
          ? await ctx.db.unitDose.count({ where: { productId: i.productId, status: 'DISPONIVEL', locationId: { in: stations.map((s) => s.id) }, expiry: { gte: startOfDay(now) } } })
          : 0;
        items.push({
          prescriptionId: p.id,
          prescriptionItemId: i.id,
          description: i.description,
          productId: i.productId,
          dose: i.dose === null ? null : Number(i.dose),
          doseUnit: i.doseUnit,
          route: i.route,
          frequencyHours: i.frequencyHours,
          dueNow: !!due,
          dueAt: due,
          nextTimes: pending.slice(0, 4),
          lastAdministeredAt: done[0]?.at ?? null,
          requiredPops: [
            ...(product?.highAlert ? [POP_TRIGGERS.highAlert] : []),
            ...(product?.antimicrobialRestricted ? [POP_TRIGGERS.antimicrobialRestricted] : []),
          ],
          availableUnitDoses: available,
        });
      }
    }
    return { patientId, now, toleranceMinutes: TIME_TOLERANCE_MINUTES, items };
  }

  async history(ctx: RequestContext, patientId: string) {
    return ctx.db.administration.findMany({ where: { patientId }, orderBy: { at: 'desc' }, take: 100 });
  }
}
