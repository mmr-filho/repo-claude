import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit.service';
import { APP_CONFIG, type AppConfig } from '../../core/config';
import type { RequestContext } from '../../core/context';
import { TenantsService } from '../../core/database';
import { conflict, DomainError } from '../../core/errors';
import { PharmacyClock } from './clock';
import { InventoryService } from './inventory.service';
import { NfeParseError, parseNfe, type ParsedNfe, type ParsedNfeItem } from './nfe';
import { credit, normalizeText, startOfDay } from './stock';

interface ResolvedItem {
  item: ParsedNfeItem;
  productId: string;
  factor: number;
}

@Injectable()
export class NfeService {
  constructor(
    private readonly audit: AuditService,
    private readonly tenants: TenantsService,
    private readonly inventory: InventoryService,
    private readonly clock: PharmacyClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async tenantCnpj(ctx: RequestContext): Promise<string> {
    const tenant = await this.tenants.master.tenant.findUnique({ where: { id: ctx.tenant.id }, select: { cnpj: true } });
    return tenant?.cnpj ?? '';
  }

  /**
   * Entrada de NF-e: confere destinatário, chave única, De-Para e o bloco <rastro> (obrigatório para
   * medicamentos) antes de gravar qualquer coisa. A entrada inteira é uma única transação.
   */
  async import(ctx: RequestContext, xml: string, locationId: string, source: 'UPLOAD' | 'SEFAZ' = 'UPLOAD') {
    const location = await this.inventory.ownLocation(ctx, locationId);
    let nfe: ParsedNfe;
    try {
      nfe = parseNfe(xml);
    } catch (err) {
      if (err instanceof NfeParseError) throw new DomainError('NFE_INVALIDA', err.message, HttpStatus.BAD_REQUEST);
      throw err;
    }

    const cnpj = await this.tenantCnpj(ctx);
    if (nfe.destCnpj !== cnpj) {
      throw new DomainError('NFE_OUTRO_DESTINATARIO', `A NF-e é destinada ao CNPJ ${nfe.destCnpj}, não ao CNPJ do tenant`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const existing = await ctx.db.invoice.findUnique({ where: { accessKey: nfe.accessKey } });
    if (existing) throw conflict('NF-e já importada', { invoiceId: existing.id, importedAt: existing.importedAt });

    const today = startOfDay(this.clock.now());
    const problems: { item: number; description: string; problem: string }[] = [];
    for (const it of nfe.items) {
      if (it.isMedicine && it.lots.length === 0) problems.push({ item: it.index, description: it.description, problem: 'Medicamento sem bloco <rastro> (lote, fabricação e validade)' });
      for (const l of it.lots) {
        if (!l.lot || !/^\d{4}-\d{2}-\d{2}$/.test(l.expiry)) problems.push({ item: it.index, description: it.description, problem: 'Rastro incompleto (nLote/dVal)' });
        else if (new Date(`${l.expiry}T00:00:00Z`) < today) problems.push({ item: it.index, description: it.description, problem: `Lote ${l.lot} vencido em ${l.expiry}` });
      }
      const lotsTotal = it.lots.reduce((s, l) => s + l.quantity, 0);
      if (it.lots.length && Math.abs(lotsTotal - it.quantity) > 0.001) {
        problems.push({ item: it.index, description: it.description, problem: `Soma dos lotes (${lotsTotal}) difere da quantidade (${it.quantity})` });
      }
    }
    if (problems.length) throw new DomainError('NFE_RASTREABILIDADE', 'NF-e com problemas de rastreabilidade', HttpStatus.UNPROCESSABLE_ENTITY, { problems });

    const resolved: ResolvedItem[] = [];
    const unmapped: { item: number; supplierCode: string; gtin: string | null; description: string; suggestions: { productId: string; description: string }[] }[] = [];
    for (const it of nfe.items) {
      const mapping = await this.findMapping(ctx, nfe.supplierCnpj, it);
      if (mapping) resolved.push({ item: it, productId: mapping.productId, factor: Number(mapping.conversionFactor) });
      else unmapped.push({ item: it.index, supplierCode: it.supplierCode, gtin: it.gtin, description: it.description, suggestions: await this.suggest(ctx, it.description) });
    }
    if (unmapped.length) {
      throw new DomainError('NFE_SEM_DE_PARA', 'Itens sem correspondência no catálogo: cadastre o De-Para', HttpStatus.UNPROCESSABLE_ENTITY, {
        supplierCnpj: nfe.supplierCnpj,
        unmapped,
      });
    }

    return ctx.db.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          accessKey: nfe.accessKey,
          number: nfe.number,
          series: nfe.series,
          supplierCnpj: nfe.supplierCnpj,
          supplierName: nfe.supplierName,
          issuedAt: nfe.issuedAt,
          totalValue: nfe.total,
          locationId: location.id,
          source,
          xml,
          importedBy: ctx.session.userId,
        },
      });
      const entries: { productId: string; lot: string; expiry: string; quantity: number }[] = [];
      for (const r of resolved) {
        const lots = r.item.lots.length ? r.item.lots : [];
        await tx.invoiceItem.create({
          data: {
            invoiceId: invoice.id,
            productId: r.productId,
            supplierCode: r.item.supplierCode,
            description: r.item.description,
            gtin: r.item.gtin,
            ncm: r.item.ncm,
            anvisaCode: r.item.anvisaCode,
            quantity: r.item.quantity,
            unitPrice: r.item.unitPrice,
            lots: lots as unknown as object,
          },
        });
        // Itens que não são medicamento podem vir sem rastro: entram em um lote genérico da nota.
        const effective = lots.length ? lots : [{ lot: `NF${nfe.number}`, quantity: r.item.quantity, manufacturedAt: null, expiry: '2099-12-31' }];
        for (const l of effective) {
          const lot = await tx.stockLot.upsert({
            where: { productId_lotNumber: { productId: r.productId, lotNumber: l.lot } },
            update: {},
            create: {
              productId: r.productId,
              lotNumber: l.lot,
              expiry: new Date(`${l.expiry}T00:00:00Z`),
              manufacturedAt: l.manufacturedAt ? new Date(`${l.manufacturedAt}T00:00:00Z`) : null,
            },
          });
          const quantity = l.quantity * r.factor;
          await credit(tx, location.id, lot.id, quantity, { kind: 'ENTRADA_NFE', userId: ctx.session.userId, refType: 'Invoice', refId: invoice.id });
          entries.push({ productId: r.productId, lot: l.lot, expiry: l.expiry, quantity });
        }
      }
      await this.audit.record(ctx, tx, {
        action: 'estoque.nfe.importar',
        entityType: 'Invoice',
        entityId: invoice.id,
        payload: { accessKey: nfe.accessKey, supplierCnpj: nfe.supplierCnpj, entries },
      });
      return { invoiceId: invoice.id, accessKey: nfe.accessKey, supplier: nfe.supplierName, total: nfe.total, locationId: location.id, entries };
    });
  }

  private async findMapping(ctx: RequestContext, supplierCnpj: string, item: ParsedNfeItem) {
    const bySupplier = await ctx.db.productMapping.findUnique({
      where: { supplierCnpj_supplierCode: { supplierCnpj, supplierCode: item.supplierCode } },
    });
    if (bySupplier) return bySupplier;
    if (!item.gtin) return null;
    const candidates = [item.gtin, item.gtin.padStart(14, '0'), item.gtin.replace(/^0+/, '')];
    return ctx.db.productMapping.findFirst({ where: { gtin: { in: candidates } } });
  }

  /** Sugestões para o De-Para: produtos cujo princípio ativo aparece na descrição do fornecedor. */
  private async suggest(ctx: RequestContext, description: string) {
    const text = normalizeText(description);
    const products = await ctx.db.product.findMany({ where: { active: true, activeIngredient: { not: null } } });
    return products
      .filter((p) => p.activeIngredient && text.includes(normalizeText(p.activeIngredient)))
      .slice(0, 5)
      .map((p) => ({ productId: p.id, description: p.description }));
  }

  private sefazBase(): string {
    const base = this.config.SEFAZ_URL ?? (this.config.MOCKS_URL ? `${this.config.MOCKS_URL.replace(/\/$/, '')}/sefaz` : undefined);
    if (!base) throw new DomainError('SEFAZ_NAO_CONFIGURADA', 'Consulta à SEFAZ não configurada: use o upload do XML (contingência)', HttpStatus.SERVICE_UNAVAILABLE);
    return base.replace(/\/$/, '');
  }

  /** Notas destinadas ao CNPJ do tenant disponíveis na SEFAZ (no desenvolvimento, o mock). */
  async pendingFromSefaz(ctx: RequestContext) {
    const base = this.sefazBase();
    const cnpj = await this.tenantCnpj(ctx);
    const res = await fetch(`${base}/nfe?cnpj=${cnpj}`);
    if (!res.ok) throw new DomainError('SEFAZ_INDISPONIVEL', `SEFAZ respondeu ${res.status}`, HttpStatus.BAD_GATEWAY);
    const body = (await res.json()) as { documentos: { chave: string; emitente: { cnpj: string; nome: string }; dataEmissao: string; valor: string }[] };
    const imported = new Set(
      (await ctx.db.invoice.findMany({ where: { accessKey: { in: body.documentos.map((d) => d.chave) } }, select: { accessKey: true } })).map((i) => i.accessKey),
    );
    return body.documentos.map((d) => ({ accessKey: d.chave, supplier: d.emitente, issuedAt: d.dataEmissao, total: Number(d.valor), imported: imported.has(d.chave) }));
  }

  async importFromSefaz(ctx: RequestContext, accessKey: string, locationId: string) {
    if (!/^\d{44}$/.test(accessKey)) throw new DomainError('CHAVE_INVALIDA', 'Chave de acesso inválida', HttpStatus.BAD_REQUEST);
    const res = await fetch(`${this.sefazBase()}/nfe/${accessKey}`);
    if (!res.ok) throw new DomainError('SEFAZ_INDISPONIVEL', `SEFAZ respondeu ${res.status}`, HttpStatus.BAD_GATEWAY);
    return this.import(ctx, await res.text(), locationId, 'SEFAZ');
  }

  async invoices(ctx: RequestContext) {
    const rows = await ctx.db.invoice.findMany({ orderBy: { importedAt: 'desc' }, take: 50, include: { items: true } });
    return rows.map(({ xml: _xml, ...inv }) => ({ ...inv, totalValue: Number(inv.totalValue), items: inv.items.map((i) => ({ ...i, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice) })) }));
  }
}
