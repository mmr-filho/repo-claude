import { HttpStatus, Injectable } from '@nestjs/common';
import { gs1HumanReadable } from '@omnisaude/shared';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, forbidden, notFound } from '../../core/errors';
import { PharmacyClock } from './clock';
import { InventoryService } from './inventory.service';
import type { receiveSchema, transferSchema, unitizeSchema } from './pharmacy.schemas';
import { credit, dateOnly, debit, startOfDay } from './stock';

@Injectable()
export class LogisticsService {
  constructor(
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly clock: PharmacyClock,
  ) {}

  // ── Transferências (almoxarifado → farmácias setoriais) com dupla conferência ──

  async createTransfer(ctx: RequestContext, input: z.infer<typeof transferSchema>) {
    if (input.fromLocationId === input.toLocationId) throw new DomainError('TRANSFERENCIA_INVALIDA', 'Origem e destino devem ser diferentes');
    await this.inventory.ownLocation(ctx, input.fromLocationId);
    const to = await ctx.db.stockLocation.findUnique({ where: { id: input.toLocationId } });
    if (!to) throw notFound('Local de destino');
    for (const it of input.items) {
      const bal = await ctx.db.stockBalance.findUnique({ where: { locationId_lotId: { locationId: input.fromLocationId, lotId: it.lotId } } });
      if (!bal || Number(bal.quantity) < it.quantity) throw new DomainError('SALDO_INSUFICIENTE', 'Saldo insuficiente na origem para um dos lotes', HttpStatus.UNPROCESSABLE_ENTITY, { lotId: it.lotId });
    }
    return ctx.db.transfer.create({
      data: {
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        notes: input.notes,
        createdBy: ctx.session.userId,
        items: { create: input.items.map((i) => ({ lotId: i.lotId, quantity: i.quantity })) },
      },
      include: { items: true },
    });
  }

  /** Baixa de expedição na origem. */
  async dispatch(ctx: RequestContext, transferId: string) {
    const t = await ctx.db.transfer.findUnique({ where: { id: transferId }, include: { items: true } });
    if (!t) throw notFound('Transferência');
    if (t.status !== 'SEPARACAO') throw new DomainError('TRANSFERENCIA_ESTADO', `Transferência em ${t.status} não pode ser expedida`);
    await this.inventory.ownLocation(ctx, t.fromLocationId);
    return ctx.db.$transaction(async (tx) => {
      const { count } = await tx.transfer.updateMany({ where: { id: t.id, status: 'SEPARACAO' }, data: { status: 'EXPEDIDA', dispatchedBy: ctx.session.userId, dispatchedAt: this.clock.now() } });
      if (count !== 1) throw new DomainError('TRANSFERENCIA_ESTADO', 'Transferência já expedida');
      for (const it of t.items) {
        await debit(tx, t.fromLocationId, it.lotId, Number(it.quantity), { kind: 'TRANSFERENCIA_SAIDA', userId: ctx.session.userId, refType: 'Transfer', refId: t.id });
      }
      await this.audit.record(ctx, tx, { action: 'estoque.transferencia.expedir', entityType: 'Transfer', entityId: t.id, payload: { items: t.items } });
      return tx.transfer.findUniqueOrThrow({ where: { id: t.id }, include: { items: true } });
    });
  }

  /**
   * Confirmação por bipagem no destino, por outro profissional. Diferenças ficam registradas
   * (DIVERGENTE) e só o que foi conferido entra no estoque do destino.
   */
  async receive(ctx: RequestContext, transferId: string, input: z.infer<typeof receiveSchema>) {
    const t = await ctx.db.transfer.findUnique({ where: { id: transferId }, include: { items: true } });
    if (!t) throw notFound('Transferência');
    if (t.status !== 'EXPEDIDA') throw new DomainError('TRANSFERENCIA_ESTADO', `Transferência em ${t.status} não pode ser recebida`);
    await this.inventory.ownLocation(ctx, t.toLocationId);
    if (t.dispatchedBy === ctx.session.userId) throw forbidden('O recebimento deve ser conferido por outro profissional (dupla conferência)');
    const confirmed = new Map(input.items.map((i) => [i.lotId, i.receivedQuantity]));
    const unknown = input.items.filter((i) => !t.items.some((ti) => ti.lotId === i.lotId));
    if (unknown.length) throw new DomainError('LOTE_NAO_PREVISTO', 'Lote conferido não consta na transferência', HttpStatus.UNPROCESSABLE_ENTITY, { lots: unknown.map((u) => u.lotId) });

    return ctx.db.$transaction(async (tx) => {
      let divergent = false;
      for (const it of t.items) {
        const received = confirmed.get(it.lotId) ?? 0;
        if (received > Number(it.quantity)) throw new DomainError('QUANTIDADE_EXCEDENTE', 'Quantidade recebida maior que a expedida', HttpStatus.UNPROCESSABLE_ENTITY, { lotId: it.lotId });
        if (Math.abs(received - Number(it.quantity)) > 0.0001) divergent = true;
        await tx.transferItem.update({ where: { id: it.id }, data: { receivedQuantity: received } });
        if (received > 0) await credit(tx, t.toLocationId, it.lotId, received, { kind: 'TRANSFERENCIA_ENTRADA', userId: ctx.session.userId, refType: 'Transfer', refId: t.id });
      }
      const status = divergent ? 'DIVERGENTE' : 'RECEBIDA';
      const { count } = await tx.transfer.updateMany({
        where: { id: t.id, status: 'EXPEDIDA' },
        data: { status, receivedBy: ctx.session.userId, receivedAt: this.clock.now(), notes: input.notes ?? t.notes },
      });
      if (count !== 1) throw new DomainError('TRANSFERENCIA_ESTADO', 'Transferência já recebida');
      await this.audit.record(ctx, tx, { action: 'estoque.transferencia.receber', entityType: 'Transfer', entityId: t.id, payload: { status, items: input.items } });
      return tx.transfer.findUniqueOrThrow({ where: { id: t.id }, include: { items: true } });
    });
  }

  async cancelTransfer(ctx: RequestContext, transferId: string) {
    const t = await ctx.db.transfer.findUnique({ where: { id: transferId } });
    if (!t) throw notFound('Transferência');
    await this.inventory.ownLocation(ctx, t.fromLocationId);
    const { count } = await ctx.db.transfer.updateMany({ where: { id: t.id, status: 'SEPARACAO' }, data: { status: 'CANCELADA' } });
    if (count !== 1) throw new DomainError('TRANSFERENCIA_ESTADO', 'Só transferências em separação podem ser canceladas');
    return { id: t.id, status: 'CANCELADA' };
  }

  async transfers(ctx: RequestContext, status?: string) {
    const locations = (await ctx.db.stockLocation.findMany({ where: { unitId: ctx.session.unitId }, select: { id: true } })).map((l) => l.id);
    const rows = await ctx.db.transfer.findMany({
      where: { OR: [{ fromLocationId: { in: locations } }, { toLocationId: { in: locations } }], ...(status ? { status: status as never } : {}) },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const lotIds = [...new Set(rows.flatMap((r) => r.items.map((i) => i.lotId)))];
    const lots = new Map((await ctx.db.stockLot.findMany({ where: { id: { in: lotIds } }, include: { product: true } })).map((l) => [l.id, l]));
    const locNames = new Map((await ctx.db.stockLocation.findMany()).map((l) => [l.id, l.name]));
    return rows.map((r) => ({
      ...r,
      fromLocationName: locNames.get(r.fromLocationId),
      toLocationName: locNames.get(r.toLocationId),
      direction: locations.includes(r.toLocationId) && !locations.includes(r.fromLocationId) ? 'ENTRADA' : 'SAIDA',
      items: r.items.map((i) => {
        const lot = lots.get(i.lotId);
        return { ...i, quantity: Number(i.quantity), receivedQuantity: i.receivedQuantity === null ? null : Number(i.receivedQuantity), product: lot?.product.description, gtin: lot?.product.gtin, lot: lot?.lotNumber, expiry: lot ? dateOnly(lot.expiry) : null };
      }),
    }));
  }

  // ── Unitarização (RDC 67/2007) ──

  /**
   * Desmembra N unidades de um lote em doses unitárias serializadas. A validade recalculada após
   * fracionamento nunca pode passar da validade original do lote.
   */
  async unitize(ctx: RequestContext, input: z.infer<typeof unitizeSchema>) {
    await this.inventory.ownLocation(ctx, input.fromLocationId);
    const to = await ctx.db.stockLocation.findUnique({ where: { id: input.toLocationId } });
    if (!to) throw notFound('Local de destino');
    if (to.unitId !== ctx.session.unitId) throw forbidden('As doses unitárias devem ficar em um local da mesma unidade');
    const lot = await ctx.db.stockLot.findUnique({ where: { id: input.lotId }, include: { product: true } });
    if (!lot) throw notFound('Lote');
    if (!lot.product.gtin) throw new DomainError('PRODUTO_SEM_GTIN', 'Produto sem GTIN: cadastre o GTIN para gerar o Datamatrix');
    const today = startOfDay(this.clock.now());
    if (lot.expiry < today) throw new DomainError('LOTE_VENCIDO', 'Lote vencido não pode ser unitarizado');
    const expiry = input.expiry ? new Date(`${input.expiry}T00:00:00Z`) : lot.expiry;
    if (expiry > lot.expiry) throw new DomainError('VALIDADE_INVALIDA', `A validade da dose unitária não pode passar da do lote (${dateOnly(lot.expiry)})`);
    if (expiry < today) throw new DomainError('VALIDADE_INVALIDA', 'Validade recalculada já vencida');
    const expiryIso = dateOnly(expiry);
    const gtin = lot.product.gtin;

    return ctx.db.$transaction(async (tx) => {
      await debit(tx, input.fromLocationId, lot.id, input.quantity, { kind: 'UNITARIZACAO_SAIDA', userId: ctx.session.userId, refType: 'Unitizacao', refId: lot.id });
      const labels = [];
      for (let i = 0; i < input.quantity; i++) {
        const serial = `U${randomBytes(7).toString('hex').toUpperCase()}`;
        const gs1 = gs1HumanReadable({ gtin, expiry: expiryIso, lot: lot.lotNumber, serial });
        const dose = await tx.unitDose.create({
          data: { serial, productId: lot.productId, lotId: lot.id, gtin, expiry, locationId: input.toLocationId, gs1, createdBy: ctx.session.userId },
        });
        labels.push({ unitDoseId: dose.id, serial, gtin, lot: lot.lotNumber, expiry: expiryIso, gs1, product: lot.product.description, unit: lot.product.unit, highAlert: lot.product.highAlert });
      }
      await credit(tx, input.toLocationId, lot.id, input.quantity, { kind: 'UNITARIZACAO_ENTRADA', userId: ctx.session.userId, refType: 'Unitizacao', refId: lot.id });
      await this.audit.record(ctx, tx, {
        action: 'estoque.unitarizar',
        entityType: 'StockLot',
        entityId: lot.id,
        payload: { quantity: input.quantity, from: input.fromLocationId, to: input.toLocationId, expiry: expiryIso, serials: labels.map((l) => l.serial) },
      });
      return { quantity: labels.length, labels };
    });
  }

  // ── Logística reversa ──

  /** Devolve doses unitárias não administradas (medicação suspensa, alta) à farmácia setorial. */
  async returnDoses(ctx: RequestContext, unitDoseIds: string[], reason: string, toLocationId?: string) {
    const doses = await ctx.db.unitDose.findMany({ where: { id: { in: unitDoseIds } } });
    if (doses.length !== unitDoseIds.length) throw notFound('Dose unitária');
    const blocked = doses.filter((d) => d.status !== 'DISPONIVEL');
    if (blocked.length) throw new DomainError('DOSE_INDISPONIVEL', 'Só doses disponíveis podem ser devolvidas', HttpStatus.UNPROCESSABLE_ENTITY, { serials: blocked.map((d) => d.serial) });
    const destination = toLocationId
      ? await this.inventory.ownLocation(ctx, toLocationId)
      : await ctx.db.stockLocation.findFirst({ where: { unitId: ctx.session.unitId, kind: { in: ['FARMACIA_SETORIAL', 'FARMACIA_CENTRAL'] } }, orderBy: { kind: 'desc' } });
    if (!destination) throw new DomainError('SEM_FARMACIA', 'A unidade não tem farmácia para receber a devolução');
    const origins = await ctx.db.stockLocation.findMany({ where: { id: { in: [...new Set(doses.map((d) => d.locationId))] } } });
    if (origins.some((o) => o.unitId !== ctx.session.unitId)) throw forbidden('Doses de outra unidade');

    return ctx.db.$transaction(async (tx) => {
      for (const d of doses) {
        const { count } = await tx.unitDose.updateMany({ where: { id: d.id, status: 'DISPONIVEL' }, data: { status: 'DEVOLVIDA', locationId: destination.id } });
        if (count !== 1) throw new DomainError('DOSE_INDISPONIVEL', `Dose ${d.serial} já movimentada`);
        if (d.locationId !== destination.id) {
          await debit(tx, d.locationId, d.lotId, 1, { kind: 'DEVOLUCAO', userId: ctx.session.userId, refType: 'UnitDose', refId: d.id });
          await credit(tx, destination.id, d.lotId, 1, { kind: 'DEVOLUCAO', userId: ctx.session.userId, refType: 'UnitDose', refId: d.id });
        }
      }
      await this.audit.record(ctx, tx, { action: 'estoque.devolucao', entityType: 'UnitDose', payload: { serials: doses.map((d) => d.serial), reason, to: destination.id } });
      return { returned: doses.length, toLocationId: destination.id, serials: doses.map((d) => d.serial) };
    });
  }
}
