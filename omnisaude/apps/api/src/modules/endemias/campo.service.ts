import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { TenantPrisma } from '@omnisaude/database';
import {
  avaliarGps,
  cicloBimestral,
  conferirImovelCampo,
  conferirVisitaVetorial,
  distanciaAteArea,
  localDateString,
  ordenarOperacoesAce,
  PRECISAO_INFO,
  SITUACAO_INFO,
  TIPO_IMOVEL,
  totaisDepositos,
  turnoDaHora,
  zonedParts,
  type Area,
  type OperacaoAce,
  type PrecisaoGeo,
  type ResultadoSyncAce,
  type VisitaVetorialCampo,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { LocalizadorService, PRECISAO_LIGA_QUARTEIRAO, TOLERANCIA_QUARTEIRAO_M } from '../territorio/localizador.service';
import { TerritorioService } from '../territorio/territorio.service';
import { validarOperacaoAce } from './campo.schema';
import { ehConflitoPassageiro, restricaoCheckViolada, violouUnico } from './erros-banco';
import { EstoqueVetorialService } from './estoque-vetorial.service';

type Tx = TenantPrisma.TransactionClient;

const DIA = 86_400_000;

/** Data informada pelo aparelho, nunca no futuro (relógio errado) nem com mais de um ano. */
export function quandoDoAparelho(iso: string, agora = Date.now()): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() > agora) return new Date(agora);
  if (d.getTime() < agora - 366 * DIA) throw new DomainError('DATA_INVALIDA', 'Registro com mais de um ano: confira a data do aparelho');
  return d;
}

/**
 * Data do imóvel novo. Ela só marca o registro e a posição: fora do intervalo aceito (relógio do aparelho errado), fica
 * a do envio, em vez de recusar o imóvel e, com ele, as visitas que o referenciam.
 */
export function quandoDoImovel(iso: string, agora = Date.now()): { data: Date; ajustada: boolean } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() > agora) return { data: new Date(agora), ajustada: false };
  if (d.getTime() < agora - 366 * DIA) return { data: new Date(agora), ajustada: true };
  return { data: d, ajustada: false };
}

/** O aparelho envia a fila de 100 em 100. */
export const MAX_OPERACOES_SYNC = 100;
/** Novas tentativas da operação desfeita por conflito entre transações (deadlock, serialização, espera longa). */
const NOVAS_TENTATIVAS = 3;
const FALHA_PASSAGEIRA = 'Falha passageira no servidor: o registro continua no aparelho e vai no próximo envio';
const OUTRA_LOTACAO = 'Registrado em outra lotação: entre pela unidade da lotação em que registrou para enviar';
/** Restrições do banco que a conferência já cobre; se uma escapar, a mensagem diz o que corrigir. */
const MENSAGEM_RESTRICAO: Record<string, string> = {
  vector_visits_contagens: 'As contagens de depósitos não fecham: com foco, eliminados e tratados não podem passar dos inspecionados',
  vector_visits_ubv: 'Local da nebulização (UBV) inválido',
  vector_treatments_quantity_check: 'Quantidade de larvicida de pelo menos 0,001',
  vector_treatments_deposits_check: 'Informe quantos depósitos receberam cada produto',
};
const RESTRICAO_GENERICA = 'O registro tem um valor que o banco de dados não aceita: confira os números e corrija';

/**
 * Trabalho de campo do agente de combate às endemias (VIG-3a): o pacote que o aparelho leva sem internet (zona,
 * ordens de bloqueio designadas, imóveis com a situação no ciclo, larvicidas com saldo) e a sincronização idempotente do
 * que foi registrado (imóvel novo e visita). Cada operação grava a entidade, o registro de idempotência e os efeitos (baixa
 * do larvicida, posição do imóvel, início da ordem) numa transação só: o reenvio, mesmo simultâneo, volta como DUPLICADA.
 */
@Injectable()
export class CampoAceService {
  private readonly logger = new Logger(CampoAceService.name);

  constructor(
    private readonly audit: AuditService,
    private readonly localizador: LocalizadorService,
    private readonly territorio: TerritorioService,
    private readonly estoque: EstoqueVetorialService,
  ) {}

  async pacote(ctx: RequestContext) {
    const userId = ctx.session.userId;
    const hoje = localDateString(new Date(), ctx.tenant.timeZone);
    const ciclo = cicloBimestral(hoje);
    const [zonas, ordens] = await Promise.all([
      ctx.db.vectorZone.findMany({ where: { aceId: userId, active: true }, include: { blocks: true }, orderBy: { name: 'asc' } }),
      ctx.db.blockingOrder.findMany({
        where: { status: { in: ['ABERTA', 'EM_CAMPO'] }, assignees: { some: { userId } } },
        include: { blocks: true, cases: { where: { active: true }, select: { blockId: true } } },
        orderBy: { openedAt: 'asc' },
      }),
    ]);
    const blockIds = [...new Set([...zonas.flatMap((z) => z.blocks.map((b) => b.blockId)), ...ordens.flatMap((o) => o.blocks.map((b) => b.blockId))])];
    const blocos = await ctx.db.block.findMany({
      where: { id: { in: blockIds } },
      select: { id: true, number: true, localityId: true, neighborhoodId: true, geometry: true, centerLat: true, centerLng: true, active: true },
    });
    const nomes = new Map((await this.territorio.comNomes(ctx, blocos)).map((b) => [b.id, b]));
    const imoveis = await ctx.db.household.findMany({
      where: { blockId: { in: blockIds }, active: true },
      select: { id: true, street: true, number: true, complement: true, district: true, propertyType: true, blockId: true, rgSequence: true, latitude: true, longitude: true, geoPrecision: true, vectorNotes: true },
    });
    const ordemIds = ordens.map((o) => o.id);
    const visitas = imoveis.length
      ? await ctx.db.vectorVisit.findMany({
          where: { householdId: { in: imoveis.map((i) => i.id) }, OR: [{ cycle: ciclo.chave }, ...(ordemIds.length ? [{ orderId: { in: ordemIds } }] : [])] },
          select: { householdId: true, situation: true, visitedAt: true, orderId: true, cycle: true },
          orderBy: { visitedAt: 'asc' },
        })
      : [];
    const noCiclo = new Map<string, { situacao: string; em: string }>();
    const naOrdem = new Map<string, { situacao: string; em: string }>();
    for (const v of visitas) {
      const r = { situacao: v.situation, em: v.visitedAt.toISOString() };
      if (v.cycle === ciclo.chave) noCiclo.set(v.householdId, r);
      if (v.orderId) naOrdem.set(`${v.orderId}:${v.householdId}`, r);
    }
    const [estoque, produtos] = await Promise.all([this.estoque.lotesDisponiveis(ctx), this.estoque.produtosCampo(ctx)]);
    await this.audit.recordStandalone(ctx, { action: 'endemias.pacote', entityType: 'VectorZone', payload: { zonas: zonas.length, ordens: ordens.length, quarteiroes: blocos.length, imoveis: imoveis.length } });
    return {
      ciclo,
      zonas: zonas.map((z) => ({ id: z.id, nome: z.name, quarteiroes: z.blocks.map((b) => b.blockId) })),
      ordens: ordens.map((o) => ({
        id: o.id,
        numero: `${o.seq}/${o.year}`,
        status: o.status,
        abertaEm: o.openedAt.toISOString(),
        raioM: o.radiusM,
        conferirImovel: o.needsCheck,
        // Sem o ponto nem o agravo do caso (sigilo, Lei 6.259/1975, art. 10): o agente começa pelo quarteirão de ocorrência.
        quarteiroes: o.blocks.map((b) => ({ id: b.blockId, ocorrencia: o.cases.some((c) => c.blockId === b.blockId) })),
        visitados: Object.fromEntries(imoveis.filter((i) => naOrdem.has(`${o.id}:${i.id}`)).map((i) => [i.id, naOrdem.get(`${o.id}:${i.id}`)!])),
      })),
      quarteiroes: blocos.map((b) => {
        const n = nomes.get(b.id);
        return { id: b.id, numero: b.number, localidade: n?.localidade?.name ?? null, bairro: n?.bairro ?? null, centro: { lat: b.centerLat, lng: b.centerLng }, geometria: b.geometry, ativo: b.active };
      }),
      imoveis: imoveis.map((i) => ({
        id: i.id,
        quarteiraoId: i.blockId,
        sequencia: i.rgSequence,
        endereco: [i.street, i.number, i.complement].filter(Boolean).join(', ') || 'Sem endereço',
        tipo: i.propertyType ?? '01',
        tipoLabel: TIPO_IMOVEL[i.propertyType ?? '01'] ?? 'Outros',
        lat: i.latitude,
        lng: i.longitude,
        posicaoAproximada: !i.geoPrecision || !PRECISAO_LIGA_QUARTEIRAO.includes(i.geoPrecision as PrecisaoGeo),
        precisaoLabel: i.geoPrecision ? PRECISAO_INFO[i.geoPrecision as PrecisaoGeo].label : 'Sem posição',
        // Só a observação do controle vetorial: a do cadastro (notes) é da APS e pode ter condição de saúde do morador.
        observacao: i.vectorNotes,
        noCiclo: noCiclo.get(i.id) ?? null,
      })),
      // Catálogo dos insumos (com ou sem saldo) e, à parte, os lotes com saldo no depósito da unidade.
      produtos,
      estoque,
      servidorEm: new Date().toISOString(),
    };
  }

  // ─── Sincronização ─────────────────────────────────────────────────────────

  async sync(ctx: RequestContext, entrada: unknown[]) {
    if (entrada.length > MAX_OPERACOES_SYNC) throw new DomainError('LOTE_GRANDE', `Envie no máximo ${MAX_OPERACOES_SYNC} operações por vez`, HttpStatus.BAD_REQUEST);
    const resultados: ResultadoSyncAce[] = [];
    // Cada operação é validada sozinha: a inválida volta ERRO e não derruba as outras do lote.
    const operacoes: OperacaoAce[] = [];
    for (const bruta of entrada) {
      const v = validarOperacaoAce(bruta);
      if (v.ok) operacoes.push(v.op);
      else resultados.push({ clientId: v.clientId, tipo: v.tipo, status: 'ERRO', id: null, erro: v.erro });
    }
    const refs = new Set<string>();
    for (const op of operacoes) {
      refs.add(op.clientId);
      if (op.tipo === 'VISITA_VETORIAL' && op.householdClientId) refs.add(op.householdClientId);
    }
    const anteriores = refs.size ? await ctx.db.fieldSyncOp.findMany({ where: { clientId: { in: [...refs] } } }) : [];
    const feitas = new Map(anteriores.map((a) => [a.clientId, a]));
    /** clientId do imóvel criado em campo → id no servidor (neste lote ou em sincronizações anteriores). */
    const ids = new Map<string, string>();
    for (const a of anteriores) if (a.entityId) ids.set(a.clientId, a.entityId);
    /** Operações que ficaram para o próximo envio: as visitas de um imóvel novo adiado ficam junto com ele. */
    const adiadas = new Set<string>();
    const noLote = new Set(operacoes.map((op) => op.clientId));
    for (const op of ordenarOperacoesAce(operacoes)) {
      const feita = feitas.get(op.clientId);
      if (feita) {
        resultados.push({ clientId: op.clientId, tipo: op.tipo, status: 'DUPLICADA', id: feita.entityId, erro: null });
        continue;
      }
      // A visita, a baixa do larvicida e a ficha do e-SUS são da unidade em que o registro foi feito.
      if (op.unitId && op.unitId !== ctx.session.unitId) {
        resultados.push({ clientId: op.clientId, tipo: op.tipo, status: 'ERRO', id: null, erro: OUTRA_LOTACAO });
        continue;
      }
      if (op.tipo === 'VISITA_VETORIAL' && op.householdClientId && !ids.has(op.householdClientId)) {
        if (adiadas.has(op.householdClientId)) {
          adiadas.add(op.clientId);
          resultados.push({ clientId: op.clientId, tipo: op.tipo, status: 'TENTAR_DE_NOVO', id: null, erro: 'O imóvel novo desta visita ficou para o próximo envio: a visita vai junto com ele' });
          continue;
        }
        // Fora deste lote, o imóvel novo pode estar sendo gravado agora por outra requisição (outra aba): espera e relê.
        if (!noLote.has(op.householdClientId)) {
          const id = await this.imovelEmGravacao(ctx, op.householdClientId);
          if (id) ids.set(op.householdClientId, id);
        }
      }
      try {
        const r = await this.comNovasTentativas(() => (op.tipo === 'IMOVEL' ? this.aplicarImovel(ctx, op) : this.aplicarVisita(ctx, op, ids)));
        ids.set(op.clientId, r.id);
        resultados.push({ clientId: op.clientId, tipo: op.tipo, status: 'OK', id: r.id, erro: null, ...(r.avisos.length ? { avisos: r.avisos } : {}) });
      } catch (err) {
        // Reenvio simultâneo (outra aba, nova tentativa com a primeira ainda em curso): a outra transação gravou primeiro.
        if (violouUnico(err)) {
          const outra = await ctx.db.fieldSyncOp.findUnique({ where: { clientId: op.clientId } });
          if (outra) {
            if (outra.entityId) ids.set(op.clientId, outra.entityId);
            resultados.push({ clientId: op.clientId, tipo: op.tipo, status: 'DUPLICADA', id: outra.entityId, erro: null });
            continue;
          }
        }
        if (err instanceof DomainError) {
          resultados.push({ clientId: op.clientId, tipo: op.tipo, status: 'ERRO', id: null, erro: err.message });
          continue;
        }
        const restricao = restricaoCheckViolada(err);
        if (restricao != null) {
          resultados.push({ clientId: op.clientId, tipo: op.tipo, status: 'ERRO', id: null, erro: MENSAGEM_RESTRICAO[restricao] ?? RESTRICAO_GENERICA });
          continue;
        }
        // Conflito que sobrou das novas tentativas, banco indisponível ou erro inesperado: o aparelho mantém o registro e
        // reenvia; o detalhe técnico fica só no log do servidor.
        this.logger.error(`Sincronização do ACE: a operação ${op.clientId} (${op.tipo}) ficou para o próximo envio`, err instanceof Error ? err.stack : String(err));
        adiadas.add(op.clientId);
        resultados.push({ clientId: op.clientId, tipo: op.tipo, status: 'TENTAR_DE_NOVO', id: null, erro: FALHA_PASSAGEIRA });
      }
    }
    await this.audit.recordStandalone(ctx, {
      action: 'endemias.sincronizar',
      entityType: 'FieldSync',
      payload: {
        total: entrada.length,
        ok: resultados.filter((r) => r.status === 'OK').length,
        duplicadas: resultados.filter((r) => r.status === 'DUPLICADA').length,
        erros: resultados.filter((r) => r.status === 'ERRO').length,
        adiadas: resultados.filter((r) => r.status === 'TENTAR_DE_NOVO').length,
        avisos: resultados.reduce((s, r) => s + (r.avisos?.length ?? 0), 0),
      },
    });
    return { resultados, sincronizadoEm: new Date().toISOString() };
  }

  /** Id do imóvel novo que outra requisição ainda pode estar gravando (até ~0,5 s); null se não aparecer. */
  private async imovelEmGravacao(ctx: RequestContext, clientId: string): Promise<string | null> {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 120));
      const feita = await ctx.db.fieldSyncOp.findUnique({ where: { clientId }, select: { entityId: true } });
      if (feita?.entityId) return feita.entityId;
    }
    return null;
  }

  /** Repete a operação que o PostgreSQL desfez por conflito com outra transação (deadlock, serialização). */
  private async comNovasTentativas<T>(fn: () => Promise<T>): Promise<T> {
    for (let tentativa = 0; ; tentativa++) {
      try {
        return await fn();
      } catch (err) {
        if (tentativa >= NOVAS_TENTATIVAS || !ehConflitoPassageiro(err)) throw err;
        await new Promise((r) => setTimeout(r, 25 * 2 ** tentativa + Math.random() * 25));
      }
    }
  }

  private gpsBom(lat: number | null | undefined, lng: number | null | undefined, precisao: number | null | undefined) {
    return lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng) && (precisao == null || avaliarGps(precisao) !== 'NOVA_LEITURA');
  }

  private async aplicarImovel(ctx: RequestContext, op: Extract<OperacaoAce, { tipo: 'IMOVEL' }>) {
    const d = op.dados;
    if (!TIPO_IMOVEL[d.propertyType]) throw new DomainError('TIPO_IMOVEL_INVALIDO', 'Tipo de imóvel inválido');
    const erros = conferirImovelCampo(d);
    if (erros.length) throw new DomainError('IMOVEL_INVALIDO', erros.join('; '));
    const bloco = await ctx.db.block.findUnique({ where: { id: d.blockId }, select: { id: true, number: true, active: true, geometry: true, neighborhoodId: true } });
    if (!bloco) throw new DomainError('QUARTEIRAO_NAO_ENCONTRADO', 'O quarteirão do imóvel não existe na malha: escolha outro');
    const avisos: string[] = [];
    // Quarteirão desativado na malha (fusão, divisão) enquanto o agente estava sem rede: o imóvel entra, com as visitas
    // que o referenciam, e a supervisão confere o quarteirão.
    if (!bloco.active) avisos.push(`O quarteirão ${bloco.number} foi desativado na malha: a supervisão confere o quarteirão do imóvel`);
    const gps = this.gpsBom(d.latitude, d.longitude, d.precisaoGps);
    if (gps) {
      const dist = distanciaAteArea([d.longitude!, d.latitude!], bloco.geometry as unknown as Area);
      if (dist > 50) avisos.push(`O GPS ficou a ${Math.round(dist)} m do quarteirão ${bloco.number}: confira o quarteirão do imóvel`);
    }
    const sequencia = d.sequencia?.trim().toUpperCase() || null;
    if (sequencia && (await ctx.db.household.count({ where: { blockId: bloco.id, rgSequence: sequencia, active: true } }))) avisos.push(`Já existe um imóvel com a sequência ${sequencia} no quarteirão ${bloco.number}`);
    const [bairro, unidade] = await Promise.all([
      bloco.neighborhoodId ? ctx.db.neighborhood.findUnique({ where: { id: bloco.neighborhoodId }, select: { name: true } }) : null,
      ctx.db.unit.findUnique({ where: { id: ctx.session.unitId }, select: { ibgeCode: true } }),
    ]);
    const quando = quandoDoImovel(op.registradoEm);
    if (quando.ajustada) avisos.push('A data do aparelho tinha mais de um ano: o imóvel ficou com a data do envio (confira o relógio do aparelho)');
    const registradoEm = quando.data;
    const id = await ctx.db.$transaction(async (tx) => {
      const h = await tx.household.create({
        data: {
          street: d.street?.trim() || null,
          number: d.number?.trim() || null,
          complement: d.complement?.trim() || null,
          district: bairro?.name ?? null,
          ibgeCode: unidade?.ibgeCode ?? null,
          propertyType: d.propertyType,
          blockId: bloco.id,
          rgSequence: sequencia,
          // Observação do controle vetorial, separada da do cadastro da APS (notes).
          vectorNotes: d.observacoes?.trim() || null,
          ...(gps ? { latitude: d.latitude, longitude: d.longitude, geoPrecision: 'GPS_CAMPO' as const, geoSource: 'ace', geoAccuracyM: d.precisaoGps ?? null, geoAt: registradoEm } : {}),
        },
      });
      // Na mesma transação: o reenvio simultâneo esbarra no clientId único e desfaz o imóvel duplicado.
      await tx.fieldSyncOp.create({
        data: { clientId: op.clientId, kind: 'ACE_IMOVEL', userId: ctx.session.userId, unitId: ctx.session.unitId, status: 'OK', entityType: 'Household', entityId: h.id, recordedAt: registradoEm },
      });
      await this.audit.record(ctx, tx, { action: 'endemias.imovel_novo', entityType: 'Household', entityId: h.id, payload: { quarteirao: bloco.number, sequencia, tipo: d.propertyType, clientId: op.clientId } });
      return h.id;
    });
    return { id, avisos };
  }

  private async aplicarVisita(ctx: RequestContext, op: Extract<OperacaoAce, { tipo: 'VISITA_VETORIAL' }>, ids: Map<string, string>) {
    const v = op.visita;
    const householdId = op.householdId ?? (op.householdClientId ? ids.get(op.householdClientId) : undefined) ?? null;
    if (op.householdClientId && !householdId) throw new DomainError('REFERENCIA_NAO_ENCONTRADA', 'O imóvel desta visita não foi cadastrado (a operação do imóvel deu erro)');
    if (!householdId) throw new DomainError('IMOVEL_OBRIGATORIO', 'Informe o imóvel visitado');
    const h = await ctx.db.household.findUnique({ where: { id: householdId }, select: { id: true, active: true, propertyType: true, blockId: true, microArea: true, latitude: true, geoPrecision: true } });
    if (!h) throw notFound('Imóvel');
    const tipo = h.propertyType ?? '01';
    const erros = conferirVisitaVetorial(v, { pontoEstrategico: tipo === '04' });
    if (erros.length) throw new DomainError('VISITA_INVALIDA', erros.join('; '));
    const visitedAt = quandoDoAparelho(op.registradoEm);
    const dataLocal = localDateString(visitedAt, ctx.tenant.timeZone);
    const ciclo = cicloBimestral(dataLocal);
    const turno = turnoDaHora(zonedParts(visitedAt, ctx.tenant.timeZone).hour);
    const avisos: string[] = [];
    if (!h.active) avisos.push('O imóvel está inativo no cadastro: a supervisão confere');

    // Ordem de bloqueio: a informada pelo aparelho, se o imóvel está nela; sem ela, a ordem ativa mais recente do
    // quarteirão (a mais antiga pode ser de outra transmissão, com o quarteirão já trabalhado).
    let ordem: { id: string; status: string; seq: number; year: number } | null = null;
    if (v.ordemId) {
      const o = await ctx.db.blockingOrder.findUnique({ where: { id: v.ordemId }, select: { id: true, status: true, seq: true, year: true } });
      const noRaio = o && h.blockId ? await ctx.db.blockingOrderBlock.findUnique({ where: { orderId_blockId: { orderId: o.id, blockId: h.blockId } } }) : null;
      if (!o) avisos.push('A ordem de bloqueio não existe mais: visita gravada sem a ordem');
      else if (o.status === 'CANCELADA') avisos.push(`A ordem ${o.seq}/${o.year} foi cancelada: visita gravada sem a ordem`);
      else if (!noRaio) avisos.push(`O imóvel não está nos quarteirões da ordem ${o.seq}/${o.year}: visita gravada sem a ordem`);
      else {
        ordem = o;
        if (o.status === 'CONCLUIDA') avisos.push(`A ordem ${o.seq}/${o.year} já estava concluída: a visita entrou nela`);
      }
    } else if (v.atividade === 'BLOQUEIO' && h.blockId) {
      ordem = await ctx.db.blockingOrder.findFirst({
        where: { status: { in: ['ABERTA', 'EM_CAMPO'] }, blocks: { some: { blockId: h.blockId } } },
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        select: { id: true, status: true, seq: true, year: true },
      });
      if (!ordem) avisos.push('Nenhuma ordem de bloqueio ativa neste quarteirão: visita gravada como bloqueio sem ordem');
    }
    const t = totaisDepositos(v.depositos);
    const pendente = SITUACAO_INFO[v.situacao].pendencia;
    const gps = this.gpsBom(v.latitude, v.longitude, v.precisaoGps);
    const posiciona = gps && (await this.posicionaPelaVisita(ctx, h, v, avisos));
    const r = await ctx.db.$transaction(async (tx) => {
      // Uma visita do imóvel por vez: a recuperação depende da ordem em que as visitas dele aconteceram.
      await tx.$executeRaw`SELECT 1 FROM households WHERE id = ${h.id}::uuid FOR NO KEY UPDATE`;
      // Recuperação: o imóvel estava pendente na última visita anterior do mesmo ciclo (ou da mesma ordem).
      const anterior = await tx.vectorVisit.findFirst({
        where: { householdId, visitedAt: { lt: visitedAt }, ...(ordem ? { orderId: ordem.id } : { cycle: ciclo.chave }) },
        orderBy: [{ visitedAt: 'desc' }, { id: 'desc' }],
        select: { situation: true },
      });
      const recuperacao = !!anterior && SITUACAO_INFO[anterior.situation].pendencia;
      const visita = await tx.vectorVisit.create({
        data: {
          clientId: op.clientId,
          userId: ctx.session.userId,
          unitId: ctx.session.unitId,
          cbo: ctx.cbo,
          householdId,
          blockId: h.blockId,
          propertyType: tipo,
          microArea: h.microArea,
          orderId: ordem?.id ?? null,
          activity: v.atividade,
          situation: v.situacao,
          recovery: recuperacao,
          cycle: ciclo.chave,
          visitedAt,
          turno,
          deposits: pendente || !v.depositos ? undefined : (v.depositos as object),
          depositsInspected: t.inspecionados,
          depositsPositive: t.comFoco,
          depositsEliminated: t.eliminados,
          depositsTreated: t.tratados,
          samples: pendente || !v.amostras?.length ? undefined : (v.amostras as object[]),
          samplesCount: pendente ? 0 : (v.amostras?.length ?? 0),
          ubv: pendente ? null : (v.ubv ?? null),
          education: !pendente && !!v.acaoEducativa,
          latitude: gps ? v.latitude : null,
          longitude: gps ? v.longitude : null,
          accuracyM: gps ? (v.precisaoGps ?? null) : null,
          notes: v.observacoes?.trim() || null,
        },
      });
      await tx.fieldSyncOp.create({
        data: { clientId: op.clientId, kind: 'ACE_VISITA', userId: ctx.session.userId, unitId: ctx.session.unitId, status: 'OK', entityType: 'VectorVisit', entityId: visita.id, recordedAt: visitedAt },
      });
      if (!pendente && v.tratamentos?.length) avisos.push(...(await this.estoque.baixarTratamentos(ctx, tx, { visitId: visita.id, linhas: v.tratamentos, dataLocal })));
      let posicionou = false;
      if (posiciona) {
        // SQL direto e condicional: não mexe no updated_at (ficha do e-SUS) nem passa por cima de quem marcou no mapa.
        const n =
          await tx.$executeRaw`UPDATE households SET latitude = ${v.latitude}, longitude = ${v.longitude}, geo_precision = 'GPS_CAMPO', geo_source = 'visita-ace', geo_accuracy_m = ${v.precisaoGps ?? null}, geo_at = ${visitedAt}
          WHERE id = ${h.id}::uuid AND (latitude IS NULL OR geo_precision IS NULL OR geo_precision NOT IN ('GPS_CAMPO', 'MAPA', 'ENDERECO', 'FACE'))`;
        posicionou = n > 0;
        // Só o imóvel sem quarteirão é ligado pelo ponto; o quarteirão escolhido pelo agente não muda pela visita.
        if (posicionou && !h.blockId) await this.localizador.vincularImovel(tx, h.id);
      }
      await this.refazerRecuperacaoSeguinte(tx, { householdId, visitedAt, orderId: ordem?.id ?? null, ciclo: ciclo.chave, pendente });
      if (ordem) {
        // Início em campo: a visita mais antiga da ordem, mesmo a que chega depois (aparelho sem rede).
        await tx.blockingOrder.updateMany({
          where: { id: ordem.id, status: { in: ['ABERTA', 'EM_CAMPO', 'CONCLUIDA'] }, OR: [{ startedAt: null }, { startedAt: { gt: visitedAt } }] },
          data: { startedAt: visitedAt },
        });
        await tx.blockingOrder.updateMany({ where: { id: ordem.id, status: 'ABERTA' }, data: { status: 'EM_CAMPO' } });
      }
      await this.audit.record(ctx, tx, {
        action: 'endemias.visita',
        entityType: 'VectorVisit',
        entityId: visita.id,
        payload: { imovel: householdId, atividade: v.atividade, situacao: v.situacao, ordem: ordem?.id ?? null, focos: t.comFoco, tratados: t.tratados, clientId: op.clientId },
      });
      return { id: visita.id, posicionou };
    });
    // Depois do commit: o GPS confirmado em campo refaz o retrato dos casos dos moradores (ordem de bloqueio).
    if (r.posicionou) await this.territorio.imoveisPosicionados(ctx, [h.id]);
    return { id: r.id, avisos };
  }

  /**
   * O GPS da visita posiciona o imóvel ainda sem posição boa, dentro da zona ou das ordens do agente. Com quarteirão, só
   * se o ponto cair nele ou a até a tolerância da malha (rua, erro do GPS); um ponto mais longe fica só na visita, com
   * aviso, porque gravá-lo no imóvel o tiraria do quarteirão na próxima religação da malha. Sem quarteirão, o ponto
   * posiciona e liga o imóvel, como no app do ACS.
   */
  private async posicionaPelaVisita(ctx: RequestContext, h: { id: string; blockId: string | null; latitude: number | null; geoPrecision: string | null }, v: VisitaVetorialCampo, avisos: string[]): Promise<boolean> {
    if (h.latitude != null && h.geoPrecision && PRECISAO_LIGA_QUARTEIRAO.includes(h.geoPrecision as PrecisaoGeo)) return false;
    if (!(await this.localizador.noEscopoDeCampo(ctx, h.id))) return false;
    if (!h.blockId) return true;
    const bloco = await ctx.db.block.findUnique({ where: { id: h.blockId }, select: { number: true, geometry: true } });
    if (!bloco) return false;
    const dist = distanciaAteArea([v.longitude!, v.latitude!], bloco.geometry as unknown as Area);
    if (dist <= TOLERANCIA_QUARTEIRAO_M) return true;
    avisos.push(`O GPS da visita ficou a ${Math.round(dist)} m do quarteirão ${bloco.number}: a posição do imóvel não foi alterada (a supervisão confere)`);
    return false;
  }

  /**
   * A visita que chega fora de ordem (outro agente sem rede, pendência reenviada) passa a ser a anterior da visita
   * seguinte do imóvel: a seguinte da mesma ordem e a seguinte sem ordem do mesmo ciclo têm a recuperação refeita, como
   * se as visitas tivessem chegado na ordem em que aconteceram.
   */
  private async refazerRecuperacaoSeguinte(tx: Tx, p: { householdId: string; visitedAt: Date; orderId: string | null; ciclo: string; pendente: boolean }) {
    const escopos = [...(p.orderId ? [{ orderId: p.orderId }] : []), { orderId: null, cycle: p.ciclo }];
    for (const escopo of escopos) {
      const seguinte = await tx.vectorVisit.findFirst({
        where: { householdId: p.householdId, visitedAt: { gt: p.visitedAt }, ...escopo },
        orderBy: [{ visitedAt: 'asc' }, { id: 'asc' }],
        select: { id: true, recovery: true },
      });
      if (seguinte && seguinte.recovery !== p.pendente) await tx.vectorVisit.update({ where: { id: seguinte.id }, data: { recovery: p.pendente } });
    }
  }
}
