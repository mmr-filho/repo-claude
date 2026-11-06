import { HttpStatus, Injectable } from '@nestjs/common';
import type { TenantPrisma } from '@omnisaude/database';
import { localDateString, type TratamentoCampo } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { conflict, DomainError, notFound } from '../../core/errors';
import { credit, debit, tryDebit } from '../pharmacy/stock';

type Tx = TenantPrisma.TransactionClient;

/** Por que a baixa do larvicida ficou para a supervisão (a visita nunca é recusada por causa do estoque). */
export type MotivoPendencia = 'SALDO_INSUFICIENTE' | 'LOTE_DESCONHECIDO' | 'LOTE_DE_OUTRO_PRODUTO' | 'LOTE_NAO_INFORMADO' | 'SEM_DEPOSITO';

export const MOTIVO_PENDENCIA_LABEL: Record<MotivoPendencia, string> = {
  SALDO_INSUFICIENTE: 'sem saldo suficiente no lote',
  LOTE_DESCONHECIDO: 'lote não cadastrado no depósito',
  LOTE_DE_OUTRO_PRODUTO: 'lote de outro produto',
  LOTE_NAO_INFORMADO: 'lote não informado',
  SEM_DEPOSITO: 'a unidade não tem depósito de endemias',
};

const tres = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Larvicidas e adulticidas do controle vetorial: baixa por lote no depósito de endemias da unidade a cada tratamento
 * registrado em campo, entrada por remessa do Ministério ou da SES (SIES, sem nota fiscal) e resolução das baixas que
 * ficaram pendentes. Reaproveita as primitivas do estoque da farmácia (saldo nunca negativo, um movimento por alteração).
 */
@Injectable()
export class EstoqueVetorialService {
  constructor(private readonly audit: AuditService) {}

  /**
   * Grava a linha de tratamento e tenta a baixa, na transação da visita. Sem saldo ou sem lote conhecido, a linha fica
   * PENDENTE (a visita já aconteceu e não pode se perder); o índice único do movimento impede a baixa em dobro.
   */
  async baixarNaVisita(ctx: RequestContext, tx: Tx, p: { visitId: string; seq: number; linha: TratamentoCampo; dataLocal: string }): Promise<string[]> {
    const produto = await tx.product.findUnique({ where: { id: p.linha.produtoId } });
    if (!produto || !produto.vectorControl) throw new DomainError('PRODUTO_INVALIDO', 'O produto do tratamento não é insumo do controle vetorial');
    const numero = p.linha.loteNumero?.trim().toUpperCase() || null;
    let lote = p.linha.loteId
      ? await tx.stockLot.findUnique({ where: { id: p.linha.loteId } })
      : numero
        ? await tx.stockLot.findUnique({ where: { productId_lotNumber: { productId: produto.id, lotNumber: numero } } })
        : null;
    let motivo: MotivoPendencia | null = null;
    if (lote && lote.productId !== produto.id) {
      motivo = 'LOTE_DE_OUTRO_PRODUTO';
      lote = null;
    } else if (!lote) motivo = p.linha.loteId || numero ? 'LOTE_DESCONHECIDO' : 'LOTE_NAO_INFORMADO';
    const deposito = await tx.stockLocation.findFirst({ where: { unitId: ctx.session.unitId, kind: 'ENDEMIAS' }, orderBy: { name: 'asc' } });
    if (!motivo && !deposito) motivo = 'SEM_DEPOSITO';
    const quantidade = tres(p.linha.quantidade);
    const vencido = !!lote && localDateString(lote.expiry, 'UTC') < p.dataLocal;
    const linha = await tx.vectorTreatment.create({
      data: {
        visitId: p.visitId,
        seq: p.seq,
        productId: produto.id,
        lotId: lote?.id ?? null,
        lotNumber: lote?.lotNumber ?? numero,
        quantity: quantidade,
        deposits: p.linha.depositos,
        locationId: deposito?.id ?? null,
        stockStatus: 'PENDENTE',
        pendingReason: motivo,
        expiredAtUse: vencido,
      },
    });
    const avisos: string[] = [];
    if (vencido) avisos.push(`${produto.description}: o lote ${lote!.lotNumber} estava vencido na data da visita`);
    if (!motivo) {
      const movimento = await tryDebit(tx, deposito!.id, lote!.id, quantidade, { kind: 'TRATAMENTO_FOCAL', refType: 'TratamentoFocal', refId: linha.id, userId: ctx.session.userId });
      if (movimento) {
        await tx.vectorTreatment.update({ where: { id: linha.id }, data: { stockStatus: 'BAIXADO', movementId: movimento } });
        return avisos;
      }
      motivo = 'SALDO_INSUFICIENTE';
      await tx.vectorTreatment.update({ where: { id: linha.id }, data: { pendingReason: motivo } });
    }
    avisos.push(`${produto.description}: baixa pendente (${MOTIVO_PENDENCIA_LABEL[motivo]}); a supervisão regulariza`);
    return avisos;
  }

  /** Lotes com saldo no depósito de endemias da unidade, primeiro o que vence antes (para o aparelho levar sem internet). */
  async lotesDisponiveis(ctx: RequestContext) {
    const saldos = await ctx.db.stockBalance.findMany({
      where: { quantity: { gt: 0 }, location: { unitId: ctx.session.unitId, kind: 'ENDEMIAS' }, lot: { product: { vectorControl: { not: null }, active: true } } },
      include: { lot: { include: { product: true } }, location: true },
      orderBy: [{ lot: { expiry: 'asc' } }],
    });
    const hoje = localDateString(new Date(), ctx.tenant.timeZone);
    return saldos.map((s) => ({
      produtoId: s.lot.productId,
      produto: s.lot.product.description,
      unidade: s.lot.product.unit,
      tipo: s.lot.product.vectorControl,
      loteId: s.lotId,
      lote: s.lot.lotNumber,
      validade: localDateString(s.lot.expiry, 'UTC'),
      vencido: localDateString(s.lot.expiry, 'UTC') < hoje,
      saldo: Number(s.quantity),
      deposito: s.location.name,
    }));
  }

  /** Painel do estoque vetorial: saldos por lote, consumo dos últimos 30 dias e baixas pendentes. */
  async painel(ctx: RequestContext) {
    const produtos = await ctx.db.product.findMany({ where: { vectorControl: { not: null } }, orderBy: { description: 'asc' } });
    const ids = produtos.map((p) => p.id);
    const [saldos, consumo, pendentes, depositos] = await Promise.all([
      ctx.db.stockBalance.findMany({
        where: { lot: { productId: { in: ids } }, location: { kind: 'ENDEMIAS' } },
        include: { lot: true, location: { include: { unit: { select: { name: true } } } } },
        orderBy: [{ lot: { expiry: 'asc' } }],
      }),
      ctx.db.vectorTreatment.groupBy({ by: ['productId'], where: { productId: { in: ids }, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) }, stockStatus: { not: 'CANCELADO' } }, _sum: { quantity: true } }),
      ctx.db.vectorTreatment.groupBy({ by: ['productId'], where: { productId: { in: ids }, stockStatus: 'PENDENTE' }, _count: { _all: true } }),
      ctx.db.stockLocation.findMany({ where: { kind: 'ENDEMIAS' }, include: { unit: { select: { name: true } } }, orderBy: { name: 'asc' } }),
    ]);
    const hoje = localDateString(new Date(), ctx.tenant.timeZone);
    return {
      depositos: depositos.map((d) => ({ id: d.id, nome: d.name, unidade: d.unit.name, unitId: d.unitId })),
      produtos: produtos.map((p) => ({
        id: p.id,
        codigo: p.code,
        descricao: p.description,
        principioAtivo: p.activeIngredient,
        concentracao: p.concentration,
        forma: p.pharmaceuticalForm,
        unidade: p.unit,
        tipo: p.vectorControl,
        ativo: p.active,
        consumo30d: Number(consumo.find((c) => c.productId === p.id)?._sum.quantity ?? 0),
        baixasPendentes: pendentes.find((c) => c.productId === p.id)?._count._all ?? 0,
        lotes: saldos
          .filter((s) => s.lot.productId === p.id)
          .map((s) => ({
            loteId: s.lotId,
            lote: s.lot.lotNumber,
            validade: localDateString(s.lot.expiry, 'UTC'),
            vencido: localDateString(s.lot.expiry, 'UTC') < hoje,
            fabricacao: s.lot.manufacturedAt ? localDateString(s.lot.manufacturedAt, 'UTC') : null,
            depositoId: s.locationId,
            deposito: s.location.name,
            unidade: s.location.unit.name,
            saldo: Number(s.quantity),
          })),
      })),
    };
  }

  async cadastrarProduto(
    ctx: RequestContext,
    input: { code: string; description: string; activeIngredient?: string | null; concentration?: string | null; pharmaceuticalForm?: string | null; unit: string; tipo: 'LARVICIDA' | 'ADULTICIDA' },
  ) {
    const code = input.code.trim().toUpperCase();
    if (await ctx.db.product.findUnique({ where: { code } })) throw conflict(`Já existe um produto com o código ${code}`);
    return ctx.db.$transaction(async (tx) => {
      const p = await tx.product.create({
        data: {
          code,
          description: input.description.trim(),
          activeIngredient: input.activeIngredient?.trim() || null,
          concentration: input.concentration?.trim() || null,
          pharmaceuticalForm: input.pharmaceuticalForm?.trim() || null,
          unit: input.unit.trim().toUpperCase(),
          vectorControl: input.tipo,
        },
      });
      await this.audit.record(ctx, tx, { action: 'endemias.produto', entityType: 'Product', entityId: p.id, payload: { code, description: p.description, tipo: input.tipo, unidade: p.unit } });
      return p;
    });
  }

  /** Depósito de endemias da unidade do contexto; criado na primeira entrada. */
  private async deposito(ctx: RequestContext, tx: Tx) {
    const atual = await tx.stockLocation.findFirst({ where: { unitId: ctx.session.unitId, kind: 'ENDEMIAS' }, orderBy: { name: 'asc' } });
    return atual ?? tx.stockLocation.create({ data: { unitId: ctx.session.unitId, name: 'Depósito de Endemias', kind: 'ENDEMIAS' } });
  }

  /** Entrada por remessa (guia do SIES ou da SES): um registro por documento e lote, sem duplicar no reenvio. */
  async entrada(ctx: RequestContext, input: { productId: string; lotNumber: string; expiry: string; manufacturedAt?: string | null; quantity: number; document: string; origin: string; notes?: string | null }) {
    const produto = await ctx.db.product.findUnique({ where: { id: input.productId } });
    if (!produto || !produto.vectorControl) throw notFound('Insumo do controle vetorial');
    const lotNumber = input.lotNumber.trim().toUpperCase();
    const document = input.document.trim().toUpperCase();
    const quantity = tres(input.quantity);
    try {
      return await ctx.db.$transaction(async (tx) => {
        const dep = await this.deposito(ctx, tx);
        const existente = await tx.stockLot.findUnique({ where: { productId_lotNumber: { productId: produto.id, lotNumber } } });
        if (existente && localDateString(existente.expiry, 'UTC') !== input.expiry)
          throw new DomainError(
            'VALIDADE_DIFERENTE',
            `O lote ${lotNumber} já está cadastrado com validade ${localDateString(existente.expiry, 'UTC')}; se a validade foi prorrogada por nota técnica, use "Prorrogar validade"`,
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        const lote =
          existente ??
          (await tx.stockLot.create({
            data: { productId: produto.id, lotNumber, expiry: new Date(`${input.expiry}T00:00:00Z`), manufacturedAt: input.manufacturedAt ? new Date(`${input.manufacturedAt}T00:00:00Z`) : null },
          }));
        const r = await tx.vectorStockReceipt.create({
          data: { locationId: dep.id, productId: produto.id, lotId: lote.id, quantity, document, origin: input.origin, notes: input.notes?.trim() || null, receivedBy: ctx.session.userId },
        });
        await credit(tx, dep.id, lote.id, quantity, { kind: 'ENTRADA_REMESSA', refType: 'RemessaEndemias', refId: r.id, userId: ctx.session.userId });
        await this.audit.record(ctx, tx, {
          action: 'endemias.entrada_larvicida',
          entityType: 'VectorStockReceipt',
          entityId: r.id,
          payload: { produto: produto.code, lote: lotNumber, quantidade: quantity, documento: document, origem: input.origin },
        });
        return { id: r.id, loteId: lote.id, depositoId: dep.id };
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw conflict(`A guia ${document} já foi lançada para o lote ${lotNumber}`);
      throw err;
    }
  }

  /** Validade prorrogada pelo Ministério (ex.: Nota Técnica nº 54/2025-CGARB, lotes de Bti WG); fica na trilha de auditoria. */
  async prorrogarValidade(ctx: RequestContext, lotId: string, input: { validade: string; documento: string }) {
    const lote = await ctx.db.stockLot.findUnique({ where: { id: lotId }, include: { product: true } });
    if (!lote || !lote.product.vectorControl) throw notFound('Lote de insumo do controle vetorial');
    const anterior = localDateString(lote.expiry, 'UTC');
    if (input.validade <= anterior) throw new DomainError('VALIDADE_INVALIDA', 'A nova validade precisa ser posterior à atual', HttpStatus.BAD_REQUEST);
    await ctx.db.$transaction(async (tx) => {
      await tx.stockLot.update({ where: { id: lotId }, data: { expiry: new Date(`${input.validade}T00:00:00Z`) } });
      await this.audit.record(ctx, tx, {
        action: 'endemias.prorrogar_validade',
        entityType: 'StockLot',
        entityId: lotId,
        payload: { lote: lote.lotNumber, produto: lote.product.code, anterior, nova: input.validade, documento: input.documento.trim() },
      });
    });
    return { loteId: lotId, validade: input.validade, anterior };
  }

  /** Baixas de larvicida pendentes, para a supervisão resolver. */
  async pendentes(ctx: RequestContext) {
    const linhas = await ctx.db.vectorTreatment.findMany({
      where: { stockStatus: 'PENDENTE' },
      include: { product: true, lot: true, visit: { select: { id: true, visitedAt: true, userId: true, householdId: true, unitId: true } } },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    const usuarios = await ctx.db.user.findMany({ where: { id: { in: [...new Set(linhas.map((l) => l.visit.userId))] } }, select: { id: true, name: true } });
    const imoveis = await ctx.db.household.findMany({ where: { id: { in: [...new Set(linhas.map((l) => l.visit.householdId))] } }, select: { id: true, street: true, number: true } });
    return linhas.map((l) => ({
      id: l.id,
      visitaId: l.visitId,
      visitadoEm: l.visit.visitedAt.toISOString(),
      agente: usuarios.find((u) => u.id === l.visit.userId)?.name ?? null,
      imovel: (() => {
        const h = imoveis.find((i) => i.id === l.visit.householdId);
        return h ? [h.street, h.number].filter(Boolean).join(', ') : null;
      })(),
      produtoId: l.productId,
      produto: l.product.description,
      unidade: l.product.unit,
      loteId: l.lotId,
      lote: l.lotNumber,
      quantidade: Number(l.quantity),
      motivo: l.pendingReason as MotivoPendencia | null,
      motivoLabel: l.pendingReason ? (MOTIVO_PENDENCIA_LABEL[l.pendingReason as MotivoPendencia] ?? l.pendingReason) : null,
    }));
  }

  /**
   * Resolve uma baixa pendente: BAIXAR (no lote informado ou em outro, com saldo), REGULARIZAR (o saldo do sistema
   * estava abaixo do físico: ajuste de entrada mais a baixa) ou CANCELAR (registro errado, sem efeito no estoque).
   */
  async resolver(ctx: RequestContext, id: string, input: { acao: 'BAIXAR' | 'REGULARIZAR' | 'CANCELAR'; loteId?: string | null; nota: string }) {
    const linha = await ctx.db.vectorTreatment.findUnique({ where: { id }, include: { visit: { select: { unitId: true } } } });
    if (!linha) throw notFound('Tratamento');
    if (linha.stockStatus !== 'PENDENTE') throw conflict('Esta baixa já foi resolvida');
    const nota = input.nota.trim();
    return ctx.db.$transaction(async (tx) => {
      // Guarda contra dois cliques ou duas pessoas: só uma resolução vence.
      const { count } = await tx.vectorTreatment.updateMany({ where: { id, stockStatus: 'PENDENTE' }, data: { resolvedBy: ctx.session.userId, resolvedAt: new Date(), resolution: nota } });
      if (count !== 1) throw conflict('Esta baixa já foi resolvida');
      if (input.acao === 'CANCELAR') {
        await tx.vectorTreatment.update({ where: { id }, data: { stockStatus: 'CANCELADO' } });
        await this.audit.record(ctx, tx, { action: 'endemias.baixa_cancelada', entityType: 'VectorTreatment', entityId: id, payload: { nota } });
        return { id, status: 'CANCELADO' as const };
      }
      const loteId = input.loteId ?? linha.lotId;
      if (!loteId) throw new DomainError('LOTE_OBRIGATORIO', 'Escolha o lote para a baixa', HttpStatus.BAD_REQUEST);
      const lote = await tx.stockLot.findUnique({ where: { id: loteId } });
      if (!lote || lote.productId !== linha.productId) throw new DomainError('LOTE_INVALIDO', 'O lote não é do produto usado', HttpStatus.BAD_REQUEST);
      const deposito =
        (linha.locationId && (await tx.stockLocation.findUnique({ where: { id: linha.locationId } }))) ||
        (await tx.stockLocation.findFirst({ where: { unitId: linha.visit.unitId, kind: 'ENDEMIAS' }, orderBy: { name: 'asc' } }));
      if (!deposito) throw new DomainError('SEM_DEPOSITO', 'A unidade da visita não tem depósito de endemias');
      const quantidade = Number(linha.quantity);
      if (input.acao === 'REGULARIZAR') {
        // Ajuste só da diferença: o saldo do sistema passa a cobrir a baixa, sem nunca ficar negativo.
        const saldo = Number((await tx.stockBalance.findUnique({ where: { locationId_lotId: { locationId: deposito.id, lotId: lote.id } } }))?.quantity ?? 0);
        const falta = tres(quantidade - saldo);
        if (falta > 0) await credit(tx, deposito.id, lote.id, falta, { kind: 'AJUSTE', refType: 'TratamentoFocal', refId: id, userId: ctx.session.userId });
      }
      const movimento = await debit(tx, deposito.id, lote.id, quantidade, { kind: 'TRATAMENTO_FOCAL', refType: 'TratamentoFocal', refId: id, userId: ctx.session.userId });
      const status = input.acao === 'REGULARIZAR' ? ('REGULARIZADO' as const) : ('BAIXADO' as const);
      await tx.vectorTreatment.update({ where: { id }, data: { stockStatus: status, lotId: lote.id, lotNumber: lote.lotNumber, locationId: deposito.id, movementId: movimento, pendingReason: null } });
      await this.audit.record(ctx, tx, {
        action: input.acao === 'REGULARIZAR' ? 'endemias.baixa_regularizada' : 'endemias.baixa_feita',
        entityType: 'VectorTreatment',
        entityId: id,
        payload: { lote: lote.lotNumber, quantidade, nota },
      });
      return { id, status };
    });
  }
}
