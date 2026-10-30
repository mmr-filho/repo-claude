import { HttpStatus, Injectable } from '@nestjs/common';
import type { TenantPrisma } from '@omnisaude/database';
import type { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, forbidden, notFound } from '../../core/errors';
import { OutboxService } from '../../core/outbox.service';
import { PharmacyClock } from './clock';
import { InventoryService } from './inventory.service';
import type { dispensationSchema } from './pharmacy.schemas';
import { dateOnly, debit, normalizeText, startOfDay } from './stock';

const DISPENSING_LOCATIONS = ['FARMACIA_CENTRAL', 'FARMACIA_SETORIAL'] as const;

@Injectable()
export class DispensationService {
  constructor(
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly inventory: InventoryService,
    private readonly clock: PharmacyClock,
  ) {}

  /**
   * Dispensação ambulatorial vinculada ao paciente (CNS/CPF) e à prescrição. Sem lote informado,
   * escolhe pelo FEFO (vence primeiro, sai primeiro), podendo dividir entre lotes.
   * Controlados da Portaria 344/98 exigem a receita (interna ou externa).
   */
  async dispense(ctx: RequestContext, input: z.infer<typeof dispensationSchema>) {
    const patient = await ctx.db.patient.findUnique({ where: { id: input.patientId } });
    if (!patient) throw notFound('Paciente');
    const location = input.locationId
      ? await this.inventory.ownLocation(ctx, input.locationId)
      : await ctx.db.stockLocation.findFirst({ where: { unitId: ctx.session.unitId, kind: { in: [...DISPENSING_LOCATIONS] } } });
    if (!location) throw new DomainError('SEM_FARMACIA', 'A unidade do contexto ativo não tem farmácia de dispensação');
    if (!(DISPENSING_LOCATIONS as readonly string[]).includes(location.kind)) throw forbidden('Dispensação só a partir de farmácia');

    const products = await ctx.db.product.findMany({ where: { id: { in: input.items.map((i) => i.productId) } } });
    if (products.length !== new Set(input.items.map((i) => i.productId)).size) throw notFound('Produto');
    const byId = new Map(products.map((p) => [p.id, p]));
    const controlled = products.filter((p) => p.controlledList);

    let prescription: Awaited<ReturnType<typeof this.loadPrescription>> | null = null;
    if (input.prescriptionId) {
      prescription = await this.loadPrescription(ctx, input.prescriptionId);
      if (prescription.patientId !== patient.id) throw new DomainError('PRESCRICAO_OUTRO_PACIENTE', 'A prescrição é de outro paciente');
      if (prescription.status !== 'ATIVA') throw new DomainError('PRESCRICAO_INATIVA', 'Prescrição suspensa ou encerrada');
      const prescribed = prescription.items.filter((i) => !i.suspendedAt);
      const missing = products.filter(
        (p) => !prescribed.some((i) => i.productId === p.id || (i.activeIngredient && p.activeIngredient && normalizeText(i.activeIngredient) === normalizeText(p.activeIngredient))),
      );
      if (missing.length) throw new DomainError('ITEM_NAO_PRESCRITO', 'Item não consta na prescrição', HttpStatus.UNPROCESSABLE_ENTITY, { products: missing.map((m) => m.description) });
    }
    if (controlled.length && !prescription && !input.externalPrescription) {
      throw new DomainError('CONTROLADO_SEM_RECEITA', 'Medicamento controlado (Portaria 344/98) exige receita', HttpStatus.UNPROCESSABLE_ENTITY, {
        products: controlled.map((c) => ({ description: c.description, list: c.controlledList })),
      });
    }

    const today = startOfDay(this.clock.now());
    return ctx.db.$transaction(async (tx) => {
      const dispensation = await tx.dispensation.create({
        data: {
          unitId: ctx.session.unitId,
          locationId: location.id,
          patientId: patient.id,
          prescriptionId: prescription?.id ?? null,
          externalPrescription: input.externalPrescription ?? undefined,
          controlled: controlled.length > 0,
          dispensedBy: ctx.session.userId,
          dispensedAt: this.clock.now(),
        },
      });
      const lines: { product: string; lot: string; expiry: string; quantity: number }[] = [];
      for (const item of input.items) {
        const product = byId.get(item.productId)!;
        const plan = item.lotId ? [{ lotId: item.lotId, quantity: item.quantity }] : await this.fefo(tx, location.id, product.id, item.quantity, today);
        for (const p of plan) {
          const lot = await tx.stockLot.findUnique({ where: { id: p.lotId } });
          if (!lot || lot.productId !== product.id) throw new DomainError('LOTE_INVALIDO', 'Lote não corresponde ao produto');
          if (lot.expiry < today) throw new DomainError('LOTE_VENCIDO', `Lote ${lot.lotNumber} vencido`);
          await debit(tx, location.id, p.lotId, p.quantity, { kind: 'DISPENSACAO', userId: ctx.session.userId, refType: 'Dispensation', refId: dispensation.id, patientId: patient.id });
          await tx.dispensationItem.create({ data: { dispensationId: dispensation.id, productId: product.id, lotId: p.lotId, quantity: p.quantity } });
          lines.push({ product: product.description, lot: lot.lotNumber, expiry: dateOnly(lot.expiry), quantity: p.quantity });
        }
      }
      await this.outbox.enqueue(tx, 'RNDS_DISPENSACAO', dispensation.id, {});
      await this.audit.record(ctx, tx, {
        action: 'farmacia.dispensar',
        entityType: 'Dispensation',
        entityId: dispensation.id,
        payload: { patientId: patient.id, prescriptionId: prescription?.id, externalPrescription: input.externalPrescription, lines },
      });
      return { id: dispensation.id, patientId: patient.id, locationId: location.id, controlled: controlled.length > 0, items: lines };
    });
  }

  private loadPrescription(ctx: RequestContext, id: string) {
    return ctx.db.prescription.findUnique({ where: { id }, include: { items: true } }).then((p) => {
      if (!p) throw notFound('Prescrição');
      return p;
    });
  }

  /** FEFO: lotes válidos com saldo, do que vence primeiro ao último. */
  private async fefo(tx: TenantPrisma.TransactionClient, locationId: string, productId: string, quantity: number, today: Date) {
    const balances = await tx.stockBalance.findMany({
      where: { locationId, quantity: { gt: 0 }, lot: { productId, expiry: { gte: today } } },
      include: { lot: true },
      orderBy: { lot: { expiry: 'asc' } },
    });
    const plan: { lotId: string; quantity: number }[] = [];
    let remaining = quantity;
    for (const b of balances) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(b.quantity));
      plan.push({ lotId: b.lotId, quantity: take });
      remaining -= take;
    }
    if (remaining > 0.0001) throw new DomainError('SALDO_INSUFICIENTE', 'Saldo insuficiente para a dispensação', HttpStatus.UNPROCESSABLE_ENTITY, { productId, missing: remaining });
    return plan;
  }

  async list(ctx: RequestContext, patientId?: string) {
    const rows = await ctx.db.dispensation.findMany({
      where: patientId ? { patientId } : { unitId: ctx.session.unitId },
      orderBy: { dispensedAt: 'desc' },
      take: 100,
      include: { items: true, patient: { select: { id: true, name: true, cns: true } } },
    });
    const products = new Map((await ctx.db.product.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => r.items.map((i) => i.productId)))] } } })).map((p) => [p.id, p.description]));
    return rows.map((r) => ({ ...r, items: r.items.map((i) => ({ ...i, quantity: Number(i.quantity), product: products.get(i.productId) })) }));
  }

  /**
   * Movimentação de controlados (Portaria SVS/MS 344/98) nos locais da unidade, por produto e lista:
   * entradas, saídas e saldo, para a escrituração e a vigilância sanitária.
   */
  async controlledReport(ctx: RequestContext, from: string, to: string) {
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000);
    if (end <= start) throw new DomainError('PERIODO_INVALIDO', 'Período inválido');
    const locations = await ctx.db.stockLocation.findMany({ where: { unitId: ctx.session.unitId } });
    const locIds = locations.map((l) => l.id);
    const lots = await ctx.db.stockLot.findMany({ where: { product: { controlledList: { not: null } } }, include: { product: true } });
    const lotIds = lots.map((l) => l.id);
    const lotById = new Map(lots.map((l) => [l.id, l]));
    const [movements, balances] = await Promise.all([
      ctx.db.stockMovement.findMany({ where: { lotId: { in: lotIds }, locationId: { in: locIds }, createdAt: { gte: start, lt: end } }, orderBy: { createdAt: 'asc' } }),
      ctx.db.stockBalance.findMany({ where: { lotId: { in: lotIds }, locationId: { in: locIds } } }),
    ]);
    const report = new Map<string, { productId: string; product: string; list: string; entries: number; exits: number; balance: number; movements: unknown[] }>();
    const row = (lotId: string) => {
      const lot = lotById.get(lotId)!;
      let r = report.get(lot.productId);
      if (!r) {
        r = { productId: lot.productId, product: lot.product.description, list: lot.product.controlledList!, entries: 0, exits: 0, balance: 0, movements: [] };
        report.set(lot.productId, r);
      }
      return r;
    };
    for (const m of movements) {
      const r = row(m.lotId);
      const q = Number(m.quantity);
      if (q >= 0) r.entries += q;
      else r.exits += -q;
      r.movements.push({ at: m.createdAt, kind: m.kind, lot: lotById.get(m.lotId)!.lotNumber, quantity: q, patientId: m.patientId, refType: m.refType, refId: m.refId });
    }
    for (const b of balances) row(b.lotId).balance += Number(b.quantity);
    return { unitId: ctx.session.unitId, from, to, products: [...report.values()].sort((a, b) => a.list.localeCompare(b.list) || a.product.localeCompare(b.product)) };
  }
}
