import { HttpStatus, Injectable } from '@nestjs/common';
import type { TenantPrisma } from '@omnisaude/database';
import { localDateString, type TratamentoCampo } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { conflict, DomainError, notFound } from '../../core/errors';
import { credit, debit, tryDebit } from '../pharmacy/stock';
import { violouUnico } from './erros-banco';

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

/** A mesma guia não entra duas vezes no mesmo lote enquanto não for estornada (índice único parcial, só no SQL). */
const INDICE_GUIA = 'vector_stock_receipts_document_lot_id_ativa';

const tres = (n: number) => Math.round(n * 1000) / 1000;
const numeroPtBr = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const unicos = <T>(xs: T[]) => [...new Set(xs)];

/**
 * Depósito de endemias da unidade. Se houver mais de um (criados antes da trava da primeira entrada), vale sempre o mais
 * antigo (os ids são UUID v7, em ordem de criação): a baixa, o pacote do aparelho e a resolução usam o mesmo.
 */
export function depositoDaUnidade(db: Pick<Tx, 'stockLocation'>, unitId: string) {
  return db.stockLocation.findFirst({ where: { unitId, kind: 'ENDEMIAS' }, orderBy: { id: 'asc' } });
}

interface LinhaResolvida {
  linha: TratamentoCampo;
  produto: { id: string; description: string };
  lote: { id: string; lotNumber: string; expiry: Date } | null;
  numero: string | null;
  motivo: MotivoPendencia | null;
}

/**
 * Larvicidas e adulticidas do controle vetorial: baixa por lote no depósito de endemias da unidade a cada tratamento
 * registrado em campo, entrada por remessa do Ministério ou da SES (SIES, sem nota fiscal), estorno da entrada lançada
 * errada e resolução das baixas que ficaram pendentes. Reaproveita as primitivas do estoque da farmácia (saldo nunca
 * negativo, um movimento por alteração).
 */
@Injectable()
export class EstoqueVetorialService {
  constructor(private readonly audit: AuditService) {}

  /**
   * Grava as linhas de tratamento da visita e tenta as baixas, na transação da visita. Sem saldo ou sem lote conhecido,
   * a linha fica PENDENTE (a visita já aconteceu e não pode se perder); o índice único do movimento impede a baixa em
   * dobro. Os saldos são travados antes, na ordem dos lotes: duas visitas que usaram os mesmos lotes em ordem diferente
   * esperam uma pela outra em vez de se travarem (deadlock). As linhas mantêm a ordem (seq) em que vieram.
   */
  async baixarTratamentos(ctx: RequestContext, tx: Tx, p: { visitId: string; linhas: TratamentoCampo[]; dataLocal: string }): Promise<string[]> {
    const deposito = await depositoDaUnidade(tx, ctx.session.unitId);
    const resolvidas: LinhaResolvida[] = [];
    for (const linha of p.linhas) resolvidas.push(await this.resolverLinha(tx, linha, !!deposito));
    const lotes = unicos(resolvidas.flatMap((r) => (!r.motivo && r.lote ? [r.lote.id] : [])));
    if (deposito && lotes.length) await tx.$executeRaw`SELECT 1 FROM stock_balances WHERE location_id = ${deposito.id}::uuid AND lot_id = ANY(${lotes}::uuid[]) ORDER BY lot_id FOR NO KEY UPDATE`;
    const avisos: string[] = [];
    for (const [i, r] of resolvidas.entries()) avisos.push(...(await this.gravarLinha(ctx, tx, { visitId: p.visitId, seq: i + 1, dataLocal: p.dataLocal, depositoId: deposito?.id ?? null, r })));
    return avisos;
  }

  private async resolverLinha(tx: Tx, linha: TratamentoCampo, temDeposito: boolean): Promise<LinhaResolvida> {
    const produto = await tx.product.findUnique({ where: { id: linha.produtoId } });
    if (!produto || !produto.vectorControl) throw new DomainError('PRODUTO_INVALIDO', 'O produto do tratamento não é insumo do controle vetorial');
    const numero = linha.loteNumero?.trim().toUpperCase() || null;
    let lote = linha.loteId
      ? await tx.stockLot.findUnique({ where: { id: linha.loteId } })
      : numero
        ? await tx.stockLot.findUnique({ where: { productId_lotNumber: { productId: produto.id, lotNumber: numero } } })
        : null;
    let motivo: MotivoPendencia | null = null;
    if (lote && lote.productId !== produto.id) {
      motivo = 'LOTE_DE_OUTRO_PRODUTO';
      lote = null;
    } else if (!lote) motivo = linha.loteId || numero ? 'LOTE_DESCONHECIDO' : 'LOTE_NAO_INFORMADO';
    if (!motivo && !temDeposito) motivo = 'SEM_DEPOSITO';
    return { linha, produto, lote, numero, motivo };
  }

  private async gravarLinha(ctx: RequestContext, tx: Tx, p: { visitId: string; seq: number; dataLocal: string; depositoId: string | null; r: LinhaResolvida }): Promise<string[]> {
    const { linha, produto, lote, numero } = p.r;
    let motivo = p.r.motivo;
    const quantidade = tres(linha.quantidade);
    const vencido = !!lote && localDateString(lote.expiry, 'UTC') < p.dataLocal;
    const t = await tx.vectorTreatment.create({
      data: {
        visitId: p.visitId,
        seq: p.seq,
        productId: produto.id,
        lotId: lote?.id ?? null,
        lotNumber: lote?.lotNumber ?? numero,
        quantity: quantidade,
        deposits: linha.depositos,
        locationId: p.depositoId,
        stockStatus: 'PENDENTE',
        pendingReason: motivo,
        expiredAtUse: vencido,
      },
    });
    const avisos: string[] = [];
    if (vencido) avisos.push(`${produto.description}: o lote ${lote!.lotNumber} estava vencido na data da visita`);
    if (!motivo) {
      const movimento = await tryDebit(tx, p.depositoId!, lote!.id, quantidade, { kind: 'TRATAMENTO_FOCAL', refType: 'TratamentoFocal', refId: t.id, userId: ctx.session.userId });
      if (movimento) {
        await tx.vectorTreatment.update({ where: { id: t.id }, data: { stockStatus: 'BAIXADO', movementId: movimento } });
        return avisos;
      }
      motivo = 'SALDO_INSUFICIENTE';
      await tx.vectorTreatment.update({ where: { id: t.id }, data: { pendingReason: motivo } });
    }
    avisos.push(`${produto.description}: baixa pendente (${MOTIVO_PENDENCIA_LABEL[motivo]}); a supervisão regulariza`);
    return avisos;
  }

  /** Lotes com saldo no depósito de endemias da unidade, primeiro o que vence antes (para o aparelho levar sem internet). */
  async lotesDisponiveis(ctx: RequestContext) {
    const deposito = await depositoDaUnidade(ctx.db, ctx.session.unitId);
    if (!deposito) return [];
    const saldos = await ctx.db.stockBalance.findMany({
      where: { locationId: deposito.id, quantity: { gt: 0 }, lot: { product: { vectorControl: { not: null }, active: true } } },
      include: { lot: { include: { product: true } } },
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
      deposito: deposito.name,
    }));
  }

  /**
   * Insumos do controle vetorial ativos, com ou sem saldo: o aparelho registra o produto usado mesmo sem lote no pacote
   * (remessa ainda não lançada, saldo do sistema abaixo do físico), e a baixa fica pendente para a supervisão.
   */
  async produtosCampo(ctx: RequestContext) {
    const produtos = await ctx.db.product.findMany({ where: { vectorControl: { not: null }, active: true }, orderBy: { description: 'asc' } });
    return produtos.map((p) => ({ id: p.id, codigo: p.code, descricao: p.description, unidade: p.unit, tipo: p.vectorControl }));
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

  /**
   * Depósito de endemias da unidade do contexto; criado na primeira entrada. A criação passa por uma trava da unidade:
   * duas guias lançadas juntas na primeira entrada não criam dois depósitos (a segunda espera e relê).
   */
  private async deposito(ctx: RequestContext, tx: Tx) {
    const atual = await depositoDaUnidade(tx, ctx.session.unitId);
    if (atual) return atual;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deposito-endemias:${ctx.session.unitId}`}))`;
    return (await depositoDaUnidade(tx, ctx.session.unitId)) ?? tx.stockLocation.create({ data: { unitId: ctx.session.unitId, name: 'Depósito de Endemias', kind: 'ENDEMIAS' } });
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
        // Lote novo lançado ao mesmo tempo por duas guias: quem chega depois não cria outro, espera e relê o mesmo.
        await tx.stockLot.createMany({
          data: [{ productId: produto.id, lotNumber, expiry: new Date(`${input.expiry}T00:00:00Z`), manufacturedAt: input.manufacturedAt ? new Date(`${input.manufacturedAt}T00:00:00Z`) : null }],
          skipDuplicates: true,
        });
        const lote = await tx.stockLot.findUniqueOrThrow({ where: { productId_lotNumber: { productId: produto.id, lotNumber } } });
        if (localDateString(lote.expiry, 'UTC') !== input.expiry)
          throw new DomainError(
            'VALIDADE_DIFERENTE',
            `O lote ${lotNumber} já está cadastrado com validade ${localDateString(lote.expiry, 'UTC')}; se a validade foi prorrogada por nota técnica, use "Prorrogar validade"`,
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
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
      // Só o índice da guia quer dizer "já lançada"; outro conflito não pode virar essa mensagem (a guia não entraria).
      if (violouUnico(err, INDICE_GUIA)) throw conflict(`A guia ${document} já foi lançada para o lote ${lotNumber}`);
      throw err;
    }
  }

  /** Entradas de remessa mais recentes (até 100), com o estorno quando houver. */
  async entradas(ctx: RequestContext) {
    const rs = await ctx.db.vectorStockReceipt.findMany({ orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 100 });
    const [produtos, lotes, depositos, usuarios] = await Promise.all([
      ctx.db.product.findMany({ where: { id: { in: unicos(rs.map((r) => r.productId)) } }, select: { id: true, description: true, unit: true } }),
      ctx.db.stockLot.findMany({ where: { id: { in: unicos(rs.map((r) => r.lotId)) } }, select: { id: true, lotNumber: true } }),
      ctx.db.stockLocation.findMany({ where: { id: { in: unicos(rs.map((r) => r.locationId)) } }, include: { unit: { select: { name: true } } } }),
      ctx.db.user.findMany({ where: { id: { in: unicos(rs.flatMap((r) => [r.receivedBy, ...(r.reversedBy ? [r.reversedBy] : [])])) } }, select: { id: true, name: true } }),
    ]);
    const nome = (id: string | null) => (id ? (usuarios.find((u) => u.id === id)?.name ?? null) : null);
    return rs.map((r) => {
      const produto = produtos.find((p) => p.id === r.productId);
      const deposito = depositos.find((d) => d.id === r.locationId);
      return {
        id: r.id,
        documento: r.document,
        origem: r.origin,
        produto: produto?.description ?? null,
        unidade: produto?.unit ?? null,
        lote: lotes.find((l) => l.id === r.lotId)?.lotNumber ?? null,
        loteId: r.lotId,
        quantidade: Number(r.quantity),
        deposito: deposito?.name ?? null,
        unidadeDeposito: deposito?.unit.name ?? null,
        recebidaEm: r.receivedAt.toISOString(),
        recebidaPor: nome(r.receivedBy),
        estornadaEm: r.reversedAt?.toISOString() ?? null,
        estornadaPor: nome(r.reversedBy),
        motivoEstorno: r.reversalReason,
        observacao: r.notes,
      };
    });
  }

  /**
   * Estorno da entrada lançada errada (ex.: "25.000" lido como 25): movimento inverso no lote e no depósito da entrada,
   * auditado. Só com saldo para devolver tudo (o que já saiu em campo não volta); depois dele, a mesma guia pode ser
   * lançada de novo com a quantidade certa.
   */
  async estornar(ctx: RequestContext, id: string, motivo: string) {
    const r = await ctx.db.vectorStockReceipt.findUnique({ where: { id } });
    if (!r) throw notFound('Entrada de remessa');
    const jaEstornada = () => new DomainError('JA_ESTORNADA', 'Esta entrada já foi estornada', HttpStatus.UNPROCESSABLE_ENTITY);
    if (r.reversedAt) throw jaEstornada();
    const quantidade = Number(r.quantity);
    const nota = motivo.trim();
    return ctx.db.$transaction(async (tx) => {
      const agora = new Date();
      // Guarda contra dois cliques ou duas pessoas: só um estorno vence.
      const { count } = await tx.vectorStockReceipt.updateMany({ where: { id, reversedAt: null }, data: { reversedAt: agora, reversedBy: ctx.session.userId, reversalReason: nota } });
      if (count !== 1) throw jaEstornada();
      const movimento = await tryDebit(tx, r.locationId, r.lotId, quantidade, { kind: 'ESTORNO_REMESSA', refType: 'RemessaEndemias', refId: id, userId: ctx.session.userId });
      const lote = await tx.stockLot.findUnique({ where: { id: r.lotId }, include: { product: true } });
      if (!movimento) {
        const saldo = Number((await tx.stockBalance.findUnique({ where: { locationId_lotId: { locationId: r.locationId, lotId: r.lotId } } }))?.quantity ?? 0);
        const un = lote?.product.unit ?? '';
        throw new DomainError(
          'SALDO_INSUFICIENTE',
          `O lote ${lote?.lotNumber ?? ''} tem ${numeroPtBr(saldo)} ${un} no depósito, menos que os ${numeroPtBr(quantidade)} ${un} da entrada: o que já foi usado não pode ser estornado`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      await this.audit.record(ctx, tx, {
        action: 'endemias.estorno_remessa',
        entityType: 'VectorStockReceipt',
        entityId: id,
        payload: { documento: r.document, produto: lote?.product.code ?? null, lote: lote?.lotNumber ?? null, quantidade, deposito: r.locationId, motivo: nota },
      });
      return { id, estornadaEm: agora.toISOString() };
    });
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

  /** Baixas de larvicida pendentes, para a supervisão resolver (com a unidade da visita e o depósito da baixa). */
  async pendentes(ctx: RequestContext) {
    const linhas = await ctx.db.vectorTreatment.findMany({
      where: { stockStatus: 'PENDENTE' },
      include: { product: true, lot: true, visit: { select: { id: true, visitedAt: true, userId: true, householdId: true, unitId: true } } },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    const [usuarios, imoveis, unidades, depositos] = await Promise.all([
      ctx.db.user.findMany({ where: { id: { in: unicos(linhas.map((l) => l.visit.userId)) } }, select: { id: true, name: true } }),
      ctx.db.household.findMany({ where: { id: { in: unicos(linhas.map((l) => l.visit.householdId)) } }, select: { id: true, street: true, number: true } }),
      ctx.db.unit.findMany({ where: { id: { in: unicos(linhas.map((l) => l.visit.unitId)) } }, select: { id: true, name: true } }),
      ctx.db.stockLocation.findMany({ where: { id: { in: unicos(linhas.flatMap((l) => (l.locationId ? [l.locationId] : []))) } }, select: { id: true, name: true } }),
    ]);
    return linhas.map((l) => ({
      id: l.id,
      visitaId: l.visitId,
      visitadoEm: l.visit.visitedAt.toISOString(),
      agente: usuarios.find((u) => u.id === l.visit.userId)?.name ?? null,
      imovel: (() => {
        const h = imoveis.find((i) => i.id === l.visit.householdId);
        return h ? [h.street, h.number].filter(Boolean).join(', ') : null;
      })(),
      unidadeVisita: unidades.find((u) => u.id === l.visit.unitId)?.name ?? null,
      depositoId: l.locationId,
      deposito: depositos.find((d) => d.id === l.locationId)?.name ?? null,
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
   * estava abaixo do físico: ajuste de entrada mais a baixa) ou CANCELAR (registro errado, sem efeito no estoque). O
   * depósito é o escolhido pela supervisão, senão o da linha, senão o da unidade da visita; sem nenhum (unidade sem
   * depósito de endemias), a supervisão escolhe de qual depósito saiu o larvicida.
   */
  async resolver(ctx: RequestContext, id: string, input: { acao: 'BAIXAR' | 'REGULARIZAR' | 'CANCELAR'; loteId?: string | null; depositoId?: string | null; nota: string }) {
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
      let deposito;
      if (input.depositoId) {
        deposito = await tx.stockLocation.findUnique({ where: { id: input.depositoId } });
        if (!deposito || deposito.kind !== 'ENDEMIAS') throw new DomainError('DEPOSITO_INVALIDO', 'Escolha um depósito de endemias', HttpStatus.BAD_REQUEST);
      } else deposito = (linha.locationId && (await tx.stockLocation.findUnique({ where: { id: linha.locationId } }))) || (await depositoDaUnidade(tx, linha.visit.unitId));
      if (!deposito) throw new DomainError('SEM_DEPOSITO', 'A unidade da visita não tem depósito de endemias: escolha o depósito de onde saiu o larvicida');
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
        payload: { lote: lote.lotNumber, quantidade, deposito: deposito.id, nota },
      });
      return { id, status };
    });
  }
}
