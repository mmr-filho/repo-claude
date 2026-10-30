import { HttpStatus, Injectable } from '@nestjs/common';
import type { TenantPrisma } from '@omnisaude/database';
import { ageInYears } from '@omnisaude/shared';
import type { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { conflict, DomainError, notFound } from '../../core/errors';
import { OutboxService } from '../../core/outbox.service';
import { RealtimeService } from '../../core/realtime.service';
import type { admissionSchema, bedUpdateSchema, dischargeSchema, transferBedSchema } from './beds.schemas';

type Tx = TenantPrisma.TransactionClient;
type BedStatus = 'VAGO' | 'OCUPADO' | 'HIGIENIZACAO' | 'BLOQUEADO';
type Isolation = 'NENHUM' | 'CONTATO' | 'GOTICULAS' | 'AEROSSOIS';

const DAY = 86_400_000;

@Injectable()
export class BedsService {
  constructor(
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Censo diário: leitos por setor, ocupante, totais por situação e taxa de ocupação. */
  async census(ctx: RequestContext, unitId?: string) {
    const unit = await ctx.db.unit.findUnique({ where: { id: unitId ?? ctx.session.unitId } });
    if (!unit) throw notFound('Unidade');
    const wards = await ctx.db.ward.findMany({
      where: { unitId: unit.id },
      orderBy: { name: 'asc' },
      include: {
        beds: {
          orderBy: { code: 'asc' },
          include: { admissions: { where: { dischargedAt: null }, include: { encounter: { include: { patient: true } } } } },
        },
      },
    });
    const now = Date.now();
    const totals: Record<BedStatus, number> = { VAGO: 0, OCUPADO: 0, HIGIENIZACAO: 0, BLOQUEADO: 0 };
    const isolated = { total: 0 };
    const view = wards.map((w) => ({
      id: w.id,
      name: w.name,
      kind: w.kind,
      beds: w.beds.map((b) => {
        totals[b.status]++;
        if (b.isolation !== 'NENHUM') isolated.total++;
        const adm = b.admissions[0];
        const patient = adm?.encounter.patient;
        return {
          id: b.id,
          code: b.code,
          status: b.status,
          isolation: b.isolation,
          updatedAt: b.updatedAt,
          occupant: adm
            ? {
                admissionId: adm.id,
                encounterId: adm.encounterId,
                patientId: adm.patientId,
                name: patient!.socialName ?? patient!.name,
                age: ageInYears(patient!.birthDate),
                sex: patient!.sex,
                mainCid: adm.mainCid,
                admittedAt: adm.admittedAt,
                daysAdmitted: Math.floor((now - adm.admittedAt.getTime()) / DAY),
                regulationCode: adm.regulationCode,
              }
            : null,
        };
      }),
    }));
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    const operational = total - totals.BLOQUEADO;
    return {
      unit: { id: unit.id, name: unit.name },
      totals: { ...totals, total, isolated: isolated.total },
      occupancyRate: operational > 0 ? Math.round((totals.OCUPADO / operational) * 1000) / 10 : 0,
      wards: view,
    };
  }

  private async bedWithUnit(ctx: RequestContext | { db: Tx }, bedId: string) {
    const bed = await ctx.db.bed.findUnique({ where: { id: bedId }, include: { ward: true, admissions: { where: { dischargedAt: null } } } });
    if (!bed) throw notFound('Leito');
    return bed;
  }

  private emit(ctx: RequestContext, unitId: string, payload: Record<string, unknown>) {
    this.realtime.emitToUnit(ctx.tenant.id, unitId, 'censo', { ...payload, at: new Date().toISOString() });
  }

  private event(tx: Tx, ctx: RequestContext, bedId: string, status: BedStatus, isolation: Isolation, reason?: string) {
    return tx.bedEvent.create({ data: { bedId, status, isolation, reason: reason ?? null, userId: ctx.session.userId } });
  }

  /**
   * Mudança manual de situação (higienização, bloqueio, isolamento). OCUPADO só entra pela internação
   * e só sai pela alta ou transferência, para o censo não divergir das internações.
   */
  async update(ctx: RequestContext, bedId: string, input: z.infer<typeof bedUpdateSchema>) {
    const bed = await this.bedWithUnit(ctx, bedId);
    const occupied = bed.admissions.length > 0 || bed.status === 'OCUPADO';
    if (input.status === 'OCUPADO') throw new DomainError('LEITO_TRANSICAO', 'Leito só fica ocupado por meio de uma internação');
    if (input.status && occupied && input.status !== bed.status) {
      throw new DomainError('LEITO_OCUPADO', 'Leito ocupado: libere pela alta ou transferência do paciente');
    }
    const status = (input.status ?? bed.status) as BedStatus;
    const isolation = (input.isolation ?? bed.isolation) as Isolation;
    const updated = await ctx.db.$transaction(async (tx) => {
      const b = await tx.bed.update({ where: { id: bed.id }, data: { status, isolation } });
      await this.event(tx, ctx, bed.id, status, isolation, input.reason);
      await this.audit.record(ctx, tx, { action: 'leito.atualizar', entityType: 'Bed', entityId: bed.id, payload: { from: { status: bed.status, isolation: bed.isolation }, to: { status, isolation }, reason: input.reason } });
      return b;
    });
    this.emit(ctx, bed.ward.unitId, { bedId: bed.id, code: bed.code, status, isolation });
    return updated;
  }

  async history(ctx: RequestContext, bedId: string) {
    await this.bedWithUnit(ctx, bedId);
    return ctx.db.bedEvent.findMany({ where: { bedId }, orderBy: { at: 'desc' }, take: 100 });
  }

  /** Leito sob isolamento só recebe paciente com a mesma precaução; leito comum passa a isolar se o paciente exigir. */
  private isolationFor(bed: { isolation: string }, need: Isolation): Isolation {
    if (bed.isolation !== 'NENHUM' && bed.isolation !== need) {
      throw new DomainError('ISOLAMENTO_INCOMPATIVEL', `Leito em isolamento por ${bed.isolation.toLowerCase()} não pode receber este paciente`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return need === 'NENHUM' ? (bed.isolation as Isolation) : need;
  }

  /**
   * Internação a partir de um atendimento (ou do paciente). Quando o atendimento é de outra unidade
   * (ex.: UPA → hospital), abre-se um atendimento de internação na unidade do leito.
   * O código de regulação (SISREG) é apenas registrado: não há API pública do SISREG integrada aqui.
   */
  async admit(ctx: RequestContext, input: z.infer<typeof admissionSchema>) {
    const bed = await this.bedWithUnit(ctx, input.bedId);
    if (bed.status !== 'VAGO' || bed.admissions.length) throw new DomainError('LEITO_INDISPONIVEL', `Leito ${bed.code} não está vago (${bed.status})`);
    const isolation = this.isolationFor(bed, input.isolation);
    const origin = input.encounterId ? await ctx.db.encounter.findUnique({ where: { id: input.encounterId }, include: { admission: true } }) : null;
    if (input.encounterId && !origin) throw notFound('Atendimento');
    if (origin && ['ENCERRADO', 'CANCELADO', 'EVADIU'].includes(origin.status)) throw new DomainError('ATENDIMENTO_ENCERRADO', 'Atendimento já encerrado');
    const patientId = origin?.patientId ?? input.patientId!;
    if (input.patientId && origin && input.patientId !== origin.patientId) throw new DomainError('PACIENTE_DIVERGENTE', 'Paciente não corresponde ao atendimento');
    const active = await ctx.db.admission.findFirst({ where: { patientId, dischargedAt: null } });
    if (active) throw conflict('Paciente já está internado', { admissionId: active.id });
    const patient = await ctx.db.patient.findUnique({ where: { id: patientId } });
    if (!patient) throw notFound('Paciente');

    const result = await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.bed.updateMany({ where: { id: bed.id, status: 'VAGO' }, data: { status: 'OCUPADO', isolation } });
      if (count !== 1) throw new DomainError('LEITO_INDISPONIVEL', 'O leito acabou de ser ocupado');
      let encounterId: string;
      if (origin && origin.unitId === bed.ward.unitId && !origin.admission) {
        await tx.encounter.update({ where: { id: origin.id }, data: { kind: 'INTERNACAO', status: 'EM_ATENDIMENTO', mainCid: input.mainCid } });
        encounterId = origin.id;
      } else {
        const enc = await tx.encounter.create({
          data: { unitId: bed.ward.unitId, patientId, kind: 'INTERNACAO', status: 'EM_ATENDIMENTO', mainCid: input.mainCid, createdBy: ctx.session.userId },
        });
        encounterId = enc.id;
        if (origin) await tx.encounter.update({ where: { id: origin.id }, data: { status: 'ENCERRADO', outcome: 'INTERNACAO', endedAt: new Date() } });
      }
      const admission = await tx.admission.create({
        data: { encounterId, patientId, bedId: bed.id, mainCid: input.mainCid.toUpperCase(), regulationCode: input.regulationCode ?? null },
      });
      await this.event(tx, ctx, bed.id, 'OCUPADO', isolation, `Internação ${admission.id}`);
      await this.audit.record(ctx, tx, { action: 'internacao.admitir', entityType: 'Admission', entityId: admission.id, payload: { bedId: bed.id, patientId, encounterId, mainCid: input.mainCid, regulationCode: input.regulationCode } });
      return admission;
    });
    this.emit(ctx, bed.ward.unitId, { bedId: bed.id, code: bed.code, status: 'OCUPADO', admissionId: result.id });
    return result;
  }

  private async activeAdmission(ctx: RequestContext, admissionId: string) {
    const adm = await ctx.db.admission.findUnique({ where: { id: admissionId }, include: { bed: { include: { ward: true } }, encounter: true } });
    if (!adm) throw notFound('Internação');
    if (adm.dischargedAt) throw new DomainError('INTERNACAO_ENCERRADA', 'Internação já encerrada');
    return adm;
  }

  /** Transferência de leito: o leito anterior vai para higienização. */
  async transfer(ctx: RequestContext, admissionId: string, input: z.infer<typeof transferBedSchema>) {
    const adm = await this.activeAdmission(ctx, admissionId);
    if (adm.bedId === input.bedId) throw new DomainError('MESMO_LEITO', 'O paciente já está neste leito');
    const target = await this.bedWithUnit(ctx, input.bedId);
    if (target.status !== 'VAGO' || target.admissions.length) throw new DomainError('LEITO_INDISPONIVEL', `Leito ${target.code} não está vago (${target.status})`);
    const need = (adm.bed?.isolation ?? 'NENHUM') as Isolation;
    const isolation = this.isolationFor(target, need);
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.bed.updateMany({ where: { id: target.id, status: 'VAGO' }, data: { status: 'OCUPADO', isolation } });
      if (count !== 1) throw new DomainError('LEITO_INDISPONIVEL', 'O leito acabou de ser ocupado');
      if (adm.bedId) {
        await tx.bed.update({ where: { id: adm.bedId }, data: { status: 'HIGIENIZACAO' } });
        await this.event(tx, ctx, adm.bedId, 'HIGIENIZACAO', (adm.bed?.isolation ?? 'NENHUM') as Isolation, `Transferência para ${target.code}`);
      }
      await tx.admission.update({ where: { id: adm.id }, data: { bedId: target.id } });
      await this.event(tx, ctx, target.id, 'OCUPADO', isolation, input.reason ?? `Transferência de ${adm.bed?.code ?? 'sem leito'}`);
      await this.audit.record(ctx, tx, { action: 'internacao.transferir_leito', entityType: 'Admission', entityId: adm.id, payload: { from: adm.bedId, to: target.id, reason: input.reason } });
    });
    this.emit(ctx, target.ward.unitId, { admissionId: adm.id, from: adm.bed?.code, to: target.code });
    return { admissionId: adm.id, bedId: target.id, previousBedId: adm.bedId };
  }

  /**
   * Alta: encerra o atendimento, manda o leito para higienização, gera o Sumário de Alta para a RNDS
   * (outbox) e devolve as doses unitárias pendentes no posto para a logística reversa.
   */
  async discharge(ctx: RequestContext, admissionId: string, input: z.infer<typeof dischargeSchema>) {
    const adm = await this.activeAdmission(ctx, admissionId);
    const now = new Date();
    await ctx.db.$transaction(async (tx) => {
      await tx.admission.update({ where: { id: adm.id }, data: { dischargedAt: now } });
      await tx.encounter.update({
        where: { id: adm.encounterId },
        data: { status: 'ENCERRADO', outcome: input.outcome, endedAt: now, mainCid: adm.encounter.mainCid ?? adm.mainCid },
      });
      if (adm.bedId) {
        await tx.bed.update({ where: { id: adm.bedId }, data: { status: 'HIGIENIZACAO' } });
        await this.event(tx, ctx, adm.bedId, 'HIGIENIZACAO', (adm.bed?.isolation ?? 'NENHUM') as Isolation, `Alta (${input.outcome})`);
      }
      await tx.prescription.updateMany({ where: { encounterId: adm.encounterId, status: 'ATIVA' }, data: { status: 'ENCERRADA' } });
      await this.outbox.enqueue(tx, 'RNDS_SUMARIO_ALTA', adm.id, {
        outcome: input.outcome,
        summary: input.summary,
        diagnoses: [adm.mainCid, ...input.diagnoses.filter((d) => d !== adm.mainCid)],
        procedures: input.procedures,
        followUp: input.followUp ?? null,
        admittedAt: adm.admittedAt.toISOString(),
        dischargedAt: now.toISOString(),
      });
      await this.audit.record(ctx, tx, { action: 'internacao.alta', entityType: 'Admission', entityId: adm.id, payload: input });
    });
    if (adm.bed) this.emit(ctx, adm.bed.ward.unitId, { bedId: adm.bedId, code: adm.bed.code, status: 'HIGIENIZACAO', admissionId: adm.id });
    return { admissionId: adm.id, dischargedAt: now, bedId: adm.bedId, pendingUnitDoses: await this.pendingDoses(ctx, adm.encounterId, adm.encounter.unitId) };
  }

  /**
   * Doses unitárias disponíveis nos postos da unidade para os medicamentos prescritos nesta internação.
   * A dose unitária não é vinculada ao paciente no cadastro, então a lista é para conferência da enfermagem.
   */
  private async pendingDoses(ctx: RequestContext, encounterId: string, unitId: string) {
    const items = await ctx.db.prescriptionItem.findMany({ where: { prescription: { encounterId } }, select: { productId: true } });
    const productIds = [...new Set(items.map((i) => i.productId).filter((x): x is string => !!x))];
    if (!productIds.length) return [];
    const stations = await ctx.db.stockLocation.findMany({ where: { unitId, kind: 'POSTO_ENFERMAGEM' }, select: { id: true } });
    const doses = await ctx.db.unitDose.findMany({
      where: { productId: { in: productIds }, status: 'DISPONIVEL', locationId: { in: stations.map((s) => s.id) } },
      orderBy: { createdAt: 'asc' },
    });
    const products = new Map((await ctx.db.product.findMany({ where: { id: { in: productIds } } })).map((p) => [p.id, p.description]));
    return doses.map((d) => ({ unitDoseId: d.id, serial: d.serial, product: products.get(d.productId), expiry: d.expiry.toISOString().slice(0, 10), locationId: d.locationId }));
  }

  async admissions(ctx: RequestContext, unitId?: string, active = true) {
    const rows = await ctx.db.admission.findMany({
      where: { encounter: { unitId: unitId ?? ctx.session.unitId }, ...(active ? { dischargedAt: null } : {}) },
      include: { bed: { include: { ward: true } }, encounter: { include: { patient: true } } },
      orderBy: { admittedAt: 'desc' },
      take: 200,
    });
    return rows.map((a) => ({
      id: a.id,
      encounterId: a.encounterId,
      patientId: a.patientId,
      patientName: a.encounter.patient.socialName ?? a.encounter.patient.name,
      bed: a.bed ? { id: a.bed.id, code: a.bed.code, ward: a.bed.ward.name } : null,
      mainCid: a.mainCid,
      regulationCode: a.regulationCode,
      admittedAt: a.admittedAt,
      dischargedAt: a.dischargedAt,
    }));
  }
}
