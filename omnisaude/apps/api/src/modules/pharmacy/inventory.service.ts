import { Injectable } from '@nestjs/common';
import { normalizeGtin, parseGs1 } from '@omnisaude/shared';
import type { z } from 'zod';
import type { RequestContext } from '../../core/context';
import { DomainError, forbidden, notFound } from '../../core/errors';
import { PharmacyClock } from './clock';
import type { mappingSchema, productSchema } from './pharmacy.schemas';
import { dateOnly, startOfDay } from './stock';

const EXPIRY_ALERT_DAYS = 60;

@Injectable()
export class InventoryService {
  constructor(private readonly clock: PharmacyClock) {}

  async products(ctx: RequestContext, q?: string) {
    const term = q?.trim();
    const rows = await ctx.db.product.findMany({
      where: {
        active: true,
        ...(term
          ? { OR: [{ description: { contains: term, mode: 'insensitive' } }, { activeIngredient: { contains: term, mode: 'insensitive' } }, { code: term }, { gtin: term }, { catmat: term }] }
          : {}),
      },
      orderBy: { description: 'asc' },
      take: 100,
    });
    return rows;
  }

  createProduct(ctx: RequestContext, input: z.infer<typeof productSchema>) {
    return ctx.db.product.create({
      data: {
        ...input,
        catmat: input.catmat ?? null,
        activeIngredient: input.activeIngredient?.toLowerCase() ?? null,
        gtin: input.gtin ?? null,
        controlledList: input.controlledList ?? null,
        highAlert: input.highAlert ?? false,
        antimicrobialRestricted: input.antimicrobialRestricted ?? false,
      },
    });
  }

  /** "De-Para": vincula código do fornecedor/GTIN ao item do catálogo, com fator de conversão. */
  async upsertMapping(ctx: RequestContext, input: z.infer<typeof mappingSchema>) {
    const product = await ctx.db.product.findUnique({ where: { id: input.productId } });
    if (!product) throw notFound('Produto');
    const data = {
      productId: input.productId,
      supplierCnpj: input.supplierCnpj ?? null,
      supplierCode: input.supplierCode ?? null,
      gtin: input.gtin ?? null,
      conversionFactor: input.conversionFactor,
    };
    if (data.supplierCnpj && data.supplierCode) {
      return ctx.db.productMapping.upsert({
        where: { supplierCnpj_supplierCode: { supplierCnpj: data.supplierCnpj, supplierCode: data.supplierCode } },
        update: data,
        create: data,
      });
    }
    return ctx.db.productMapping.create({ data });
  }

  async locations(ctx: RequestContext, scope: 'unit' | 'all' = 'unit') {
    return ctx.db.stockLocation.findMany({
      where: scope === 'unit' ? { unitId: ctx.session.unitId } : {},
      include: { unit: { select: { id: true, name: true, type: true } } },
      orderBy: [{ unit: { name: 'asc' } }, { name: 'asc' }],
    });
  }

  /** Movimentar estoque só nos locais da unidade do contexto ativo. */
  async ownLocation(ctx: RequestContext, locationId: string) {
    const loc = await ctx.db.stockLocation.findUnique({ where: { id: locationId } });
    if (!loc) throw notFound('Local de estoque');
    if (loc.unitId !== ctx.session.unitId) throw forbidden('O local de estoque não pertence à unidade do contexto ativo');
    return loc;
  }

  async stock(ctx: RequestContext, locationId?: string) {
    const locations = locationId ? [await this.ownLocationOrRead(ctx, locationId)] : await this.locations(ctx);
    const today = startOfDay(this.clock.now());
    const limit = new Date(today.getTime() + EXPIRY_ALERT_DAYS * 86_400_000);
    const balances = await ctx.db.stockBalance.findMany({
      where: { locationId: { in: locations.map((l) => l.id) }, quantity: { gt: 0 } },
      include: { lot: { include: { product: true } }, location: true },
      orderBy: [{ lot: { product: { description: 'asc' } } }, { lot: { expiry: 'asc' } }],
    });
    const items = balances.map((b) => {
      const expired = b.lot.expiry < today;
      const expiring = !expired && b.lot.expiry <= limit;
      return {
        locationId: b.locationId,
        locationName: b.location.name,
        productId: b.lot.productId,
        productCode: b.lot.product.code,
        product: b.lot.product.description,
        unit: b.lot.product.unit,
        controlledList: b.lot.product.controlledList,
        highAlert: b.lot.product.highAlert,
        lotId: b.lotId,
        lot: b.lot.lotNumber,
        expiry: dateOnly(b.lot.expiry),
        quantity: Number(b.quantity),
        alert: expired ? 'VENCIDO' : expiring ? 'VENCE_EM_BREVE' : null,
      };
    });
    return {
      items,
      alerts: {
        expired: items.filter((i) => i.alert === 'VENCIDO').length,
        expiringSoon: items.filter((i) => i.alert === 'VENCE_EM_BREVE').length,
        windowDays: EXPIRY_ALERT_DAYS,
      },
    };
  }

  /** Leitura de saldo é permitida em qualquer local da rede (visão do almoxarifado/gestão). */
  private async ownLocationOrRead(ctx: RequestContext, locationId: string) {
    const loc = await ctx.db.stockLocation.findUnique({ where: { id: locationId }, include: { unit: { select: { id: true, name: true, type: true } } } });
    if (!loc) throw notFound('Local de estoque');
    return loc;
  }

  /** Interpreta um código lido pelo leitor: Datamatrix GS1 (dose unitária ou embalagem) ou GTIN simples. */
  async lookup(ctx: RequestContext, code: string) {
    let gtin: string;
    let lotNumber: string | undefined;
    let serial: string | undefined;
    try {
      if (/^\d{8,14}$/.test(code.trim())) gtin = normalizeGtin(code.trim());
      else {
        const parsed = parseGs1(code);
        gtin = parsed.gtin;
        lotNumber = parsed.lot;
        serial = parsed.serial;
      }
    } catch (err) {
      throw new DomainError('CODIGO_ILEGIVEL', `Código não reconhecido: ${(err as Error).message}`);
    }
    const candidates = [gtin, gtin.replace(/^0+/, '')];
    const product =
      (await ctx.db.product.findFirst({ where: { gtin: { in: candidates } } })) ??
      (await ctx.db.productMapping.findFirst({ where: { gtin: { in: candidates } }, include: { product: true } }))?.product ??
      null;
    if (!product) throw notFound('Produto com este GTIN');
    const lot = lotNumber ? await ctx.db.stockLot.findUnique({ where: { productId_lotNumber: { productId: product.id, lotNumber } } }) : null;
    const unitDose = serial ? await ctx.db.unitDose.findUnique({ where: { serial } }) : null;
    return {
      product: { id: product.id, code: product.code, description: product.description, unit: product.unit, highAlert: product.highAlert, antimicrobialRestricted: product.antimicrobialRestricted, controlledList: product.controlledList },
      lot: lot ? { id: lot.id, lotNumber: lot.lotNumber, expiry: dateOnly(lot.expiry) } : null,
      unitDose: unitDose ? { id: unitDose.id, serial: unitDose.serial, status: unitDose.status, expiry: dateOnly(unitDose.expiry), locationId: unitDose.locationId } : null,
    };
  }
}
