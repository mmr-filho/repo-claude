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
import { LocalizadorService, PRECISAO_LIGA_QUARTEIRAO } from '../territorio/localizador.service';
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
/** Passos que a visita segue na cadeia de uniões (a ordem que ficou com outra pode ter sido unificada depois). */
const MAX_UNIOES = 5;

type OrdemDaVisita = { id: string; status: string; seq: number; year: number; mergedIntoId: string | null };
const numeroOrdem = (o: { seq: number; year: number }) => `${o.seq}/${o.year}`;

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
    const validadas = entrada.map(validarOperacaoAce);
    const operacoes = validadas.flatMap((v) => (v.ok ? [v.op] : []));
    /** clientIds deste lote, válidos ou não. */
    const noLote = new Set(validadas.flatMap((v) => (v.ok ? [v.op.clientId] : v.clientId ? [v.clientId] : [])));
    const refs = new Set(noLote);
    for (const op of operacoes) if (op.tipo === 'VISITA_VETORIAL' && op.householdClientId) refs.add(op.householdClientId);
    const anteriores = refs.size ? await ctx.db.fieldSyncOp.findMany({ where: { clientId: { in: [...refs] } } }) : [];
    const feitas = new Map(anteriores.map((a) => [a.clientId, a]));
    for (const v of validadas) {
      if (v.ok) continue;
      // Já gravada (reenvio depois de a resposta se perder): sai da fila, mesmo que não passe mais na validação atual.
      const feita = v.clientId ? feitas.get(v.clientId) : undefined;
      resultados.push(feita ? { clientId: v.clientId, tipo: v.tipo, status: 'DUPLICADA', id: feita.entityId, erro: null } : { clientId: v.clientId, tipo: v.tipo, status: 'ERRO', id: null, erro: v.erro });
    }
    /** clientId do imóvel criado em campo → id no servidor (neste lote ou em sincronizações anteriores). */
    const ids = new Map<string, string>();
    for (const a of anteriores) if (a.entityId) ids.set(a.clientId, a.entityId);
    // Imóvel novo de outro envio que outra requisição (outra aba) ainda pode estar gravando: espera por ele uma vez.
    const deFora = [...new Set(operacoes.flatMap((op) => (op.tipo === 'VISITA_VETORIAL' && op.householdClientId && !ids.has(op.householdClientId) && !noLote.has(op.householdClientId) ? [op.householdClientId] : [])))];
    if (deFora.length) for (const [clientId, id] of await this.imoveisEmGravacao(ctx, deFora)) ids.set(clientId, id);
    /** Operações que ficaram para o próximo envio: as visitas de um imóvel novo adiado ficam junto com ele. */
    const adiadas = new Set<string>();
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
      if (op.tipo === 'VISITA_VETORIAL' && op.householdClientId && adiadas.has(op.householdClientId)) {
        adiadas.add(op.clientId);
        resultados.push({ clientId: op.clientId, tipo: op.tipo, status: 'TENTAR_DE_NOVO', id: null, erro: 'O imóvel novo desta visita ficou para o próximo envio: a visita vai junto com ele' });
        continue;
      }
      try {
        const r = await this.comNovasTentativas(() => (op.tipo === 'IMOVEL' ? this.aplicarImovel(ctx, op) : this.aplicarVisita(ctx, op, ids, noLote)));
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

  /** Ids dos imóveis novos que outra requisição ainda pode estar gravando (espera até ~0,5 s); os que não aparecem ficam de fora. */
  private async imoveisEmGravacao(ctx: RequestContext, clientIds: string[]): Promise<Map<string, string>> {
    const achados = new Map<string, string>();
    for (let i = 0; i < 4 && achados.size < clientIds.length; i++) {
      await new Promise((r) => setTimeout(r, 120));
      const feitas = await ctx.db.fieldSyncOp.findMany({ where: { clientId: { in: clientIds.filter((c) => !achados.has(c)) } }, select: { clientId: true, entityId: true } });
      for (const f of feitas) if (f.entityId) achados.set(f.clientId, f.entityId);
    }
    return achados;
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
    const gps = this.gpsBom(d.latitude, d.longitude, d.precisaoGps);
    // O quarteirão escolhido pelo agente manda, como no GPS da visita: o ponto só vira a posição do imóvel quando a malha
    // o liga a esse mesmo quarteirão (dentro dele, ou na rua a até a tolerância e mais perto dele que de outro). Fora
    // disso o imóvel entra no quarteirão escolhido sem posição, que nenhuma religação da malha move nem desliga.
    const daMalha = gps ? await this.localizador.quarteiraoDoPonto(ctx.db, d.latitude!, d.longitude!) : null;
    const posiciona = gps && daMalha?.id === bloco.id;
    // Quarteirão desativado na malha (fusão, divisão) enquanto o agente estava sem rede: o imóvel entra, com as visitas
    // que o referenciam, e a supervisão confere o quarteirão.
    if (!bloco.active) avisos.push(`O quarteirão ${bloco.number} foi desativado na malha: a supervisão confere o quarteirão do imóvel${gps ? ' (a posição do GPS não foi gravada)' : ''}`);
    else if (gps && !posiciona) {
      const dist = Math.round(distanciaAteArea([d.longitude!, d.latitude!], bloco.geometry as unknown as Area));
      const motivo = daMalha ? `O GPS ficou mais perto do quarteirão ${daMalha.number} que do ${bloco.number}, o escolhido (a ${dist} m dele)` : `O GPS ficou a ${dist} m do quarteirão ${bloco.number}`;
      avisos.push(`${motivo}: o imóvel entrou no quarteirão ${bloco.number} sem a posição do GPS (a supervisão confere)`);
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
          ...(posiciona ? { latitude: d.latitude, longitude: d.longitude, geoPrecision: 'GPS_CAMPO' as const, geoSource: 'ace', geoAccuracyM: d.precisaoGps ?? null, geoAt: registradoEm } : {}),
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

  /** `noLote`: clientIds deste envio, para dizer se o imóvel novo da visita deu erro aqui ou ainda não foi aceito. */
  private async aplicarVisita(ctx: RequestContext, op: Extract<OperacaoAce, { tipo: 'VISITA_VETORIAL' }>, ids: Map<string, string>, noLote: ReadonlySet<string> = new Set()) {
    const v = op.visita;
    const householdId = op.householdId ?? (op.householdClientId ? ids.get(op.householdClientId) : undefined) ?? null;
    // Continua ERRO nos dois casos: o aparelho devolve a visita à fila quando o imóvel dela for aceito. Fora deste envio,
    // o servidor não sabe se o imóvel ainda está a caminho (outra aba, fila do aparelho) ou se foi recusado num envio
    // anterior (o aparelho manda a fila de 100 em 100, os imóveis primeiro): o texto não promete que ele vai no próximo.
    if (op.householdClientId && !householdId)
      throw new DomainError(
        'REFERENCIA_NAO_ENCONTRADA',
        noLote.has(op.householdClientId)
          ? 'O imóvel desta visita não foi cadastrado (a operação do imóvel deu erro)'
          : 'O imóvel novo desta visita ainda não foi aceito pelo servidor: a visita vai de novo quando ele for aceito (se ele foi descartado, descarte também a visita)',
      );
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
    const pendente = SITUACAO_INFO[v.situacao].pendencia;
    // Imóvel não trabalhado (fechado, recusado, abandonado) não tem contagem de depósitos.
    const t = totaisDepositos(pendente ? null : v.depositos);
    const gps = this.gpsBom(v.latitude, v.longitude, v.precisaoGps);
    const posiciona = gps && (await this.posicionaPelaVisita(ctx, h, v, avisos));
    const r = await ctx.db.$transaction(async (tx) => {
      // Uma visita do imóvel por vez: a recuperação depende da ordem em que as visitas dele aconteceram.
      await tx.$executeRaw`SELECT 1 FROM households WHERE id = ${h.id}::uuid FOR NO KEY UPDATE`;
      const ordem = await this.ordemDaVisita(tx, h.blockId, v, avisos);
      const escopo = { householdId, visitedAt, orderId: ordem?.id ?? null, cycle: ciclo.chave };
      const recuperacao = await this.anteriorPendente(tx, escopo);
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
      await this.refazerRecuperacaoSeguinte(tx, escopo);
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
   * Ordem de bloqueio da visita: a informada pelo aparelho, se o imóvel está nela. A unificada a outra depois que o
   * aparelho a levou (CANCELADA com mergedIntoId) leva a visita à ordem que ficou, seguindo a cadeia de uniões, se o
   * quarteirão do imóvel está nela; senão a visita fica sem ordem, como na cancelada. Sem ordem informada, a visita de
   * bloqueio vai para a ordem ativa mais recente do quarteirão (a mais antiga pode ser de outra transmissão, com o
   * quarteirão já trabalhado). Cada ordem é lida com a linha travada (ver `ordemTravada`).
   */
  private async ordemDaVisita(tx: Tx, blockId: string | null, v: VisitaVetorialCampo, avisos: string[]): Promise<OrdemDaVisita | null> {
    const temQuarteirao = async (o: OrdemDaVisita) => !!blockId && !!(await tx.blockingOrderBlock.findUnique({ where: { orderId_blockId: { orderId: o.id, blockId } }, select: { orderId: true } }));
    if (v.ordemId) {
      const informada = await this.ordemTravada(tx, v.ordemId);
      if (!informada) {
        avisos.push('A ordem de bloqueio não existe mais: visita gravada sem a ordem');
        return null;
      }
      let o = informada;
      for (let passo = 0; o.status === 'CANCELADA' && o.mergedIntoId && passo < MAX_UNIOES; passo++) {
        const destino = await this.ordemTravada(tx, o.mergedIntoId);
        if (!destino) break;
        o = destino;
      }
      const unificada = o.id !== informada.id;
      const noRaio = o.status !== 'CANCELADA' && (await temQuarteirao(o));
      if (informada.status === 'CANCELADA' && !(unificada && noRaio)) {
        avisos.push(`A ordem ${numeroOrdem(informada)} foi cancelada: visita gravada sem a ordem`);
        return null;
      }
      if (!noRaio) {
        avisos.push(`O imóvel não está nos quarteirões da ordem ${numeroOrdem(o)}: visita gravada sem a ordem`);
        return null;
      }
      // A ordem que ficou já concluída recebe a visita como a informada concluída: o trabalho foi feito para ela.
      if (unificada) avisos.push(`A ordem ${numeroOrdem(informada)} foi unificada à ordem ${numeroOrdem(o)}${o.status === 'CONCLUIDA' ? ', que já estava concluída' : ''}: visita gravada nela`);
      else if (o.status === 'CONCLUIDA') avisos.push(`A ordem ${numeroOrdem(o)} já estava concluída: a visita entrou nela`);
      return o;
    }
    if (v.atividade !== 'BLOQUEIO' || !blockId) return null;
    // Duas tentativas: a ordem achada pode ter sido unificada ou refeita enquanto a visita esperava a linha.
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const achada = await tx.blockingOrder.findFirst({
        where: { status: { in: ['ABERTA', 'EM_CAMPO'] }, blocks: { some: { blockId } } },
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (!achada) break;
      const o = await this.ordemTravada(tx, achada.id);
      if (o && (o.status === 'ABERTA' || o.status === 'EM_CAMPO') && (await temQuarteirao(o))) return o;
    }
    avisos.push('Nenhuma ordem de bloqueio ativa neste quarteirão: visita gravada como bloqueio sem ordem');
    return null;
  }

  /**
   * A ordem lida com a linha travada (FOR KEY SHARE, a mesma trava da chave estrangeira da visita): a união, o recálculo
   * e o desligamento do bloqueio, que travam a linha FOR UPDATE, terminam antes, e a visita vê a situação que ficou (não
   * entra numa ordem cancelada no meio do envio). Duas visitas da mesma ordem não se esperam.
   */
  private async ordemTravada(tx: Tx, id: string): Promise<OrdemDaVisita | null> {
    await tx.$queryRaw`SELECT id FROM blocking_orders WHERE id = ${id}::uuid FOR KEY SHARE`;
    return tx.blockingOrder.findUnique({ where: { id }, select: { id: true, status: true, seq: true, year: true, mergedIntoId: true } });
  }

  /**
   * O GPS da visita posiciona o imóvel ainda sem posição boa, dentro da zona ou das ordens do agente. Com quarteirão, só
   * quando a malha ligaria o ponto a esse mesmo quarteirão (dentro dele, ou na rua a até a tolerância e mais perto dele
   * que de outro): a visita não troca o quarteirão do imóvel, nem agora nem na próxima religação da malha. Um ponto fora
   * disso fica só na visita, com aviso para a supervisão. Sem quarteirão, o ponto posiciona e liga o imóvel.
   */
  private async posicionaPelaVisita(ctx: RequestContext, h: { id: string; blockId: string | null; latitude: number | null; geoPrecision: string | null }, v: VisitaVetorialCampo, avisos: string[]): Promise<boolean> {
    if (h.latitude != null && h.geoPrecision && PRECISAO_LIGA_QUARTEIRAO.includes(h.geoPrecision as PrecisaoGeo)) return false;
    if (!(await this.localizador.noEscopoDeCampo(ctx, h.id))) return false;
    if (!h.blockId) return true;
    const [bloco, daMalha] = await Promise.all([
      ctx.db.block.findUnique({ where: { id: h.blockId }, select: { number: true, geometry: true, active: true } }),
      this.localizador.quarteiraoDoPonto(ctx.db, v.latitude!, v.longitude!),
    ]);
    if (!bloco) return false;
    if (daMalha?.id === h.blockId) return true;
    const dist = Math.round(distanciaAteArea([v.longitude!, v.latitude!], bloco.geometry as unknown as Area));
    const motivo = !bloco.active
      ? `O quarteirão ${bloco.number} do imóvel foi desativado na malha`
      : daMalha
        ? `O GPS da visita ficou mais perto do quarteirão ${daMalha.number} que do ${bloco.number}, o do imóvel (a ${dist} m dele)`
        : `O GPS da visita ficou a ${dist} m do quarteirão ${bloco.number}`;
    avisos.push(`${motivo}: a posição do imóvel não foi alterada (a supervisão confere)`);
    return false;
  }

  /** Recuperação: o imóvel estava pendente na visita anterior do mesmo escopo (a mesma ordem; sem ordem, o mesmo ciclo). */
  private async anteriorPendente(tx: Tx, v: { householdId: string; visitedAt: Date; orderId: string | null; cycle: string }): Promise<boolean> {
    const anterior = await tx.vectorVisit.findFirst({
      where: { householdId: v.householdId, visitedAt: { lt: v.visitedAt }, ...(v.orderId ? { orderId: v.orderId } : { cycle: v.cycle }) },
      orderBy: [{ visitedAt: 'desc' }, { id: 'desc' }],
      select: { situation: true },
    });
    return !!anterior && SITUACAO_INFO[anterior.situation].pendencia;
  }

  /**
   * A visita que chega fora de ordem (outro agente sem rede, pendência reenviada) pode ser a anterior da visita seguinte
   * do imóvel: a seguinte da mesma ordem e a seguinte sem ordem do mesmo ciclo têm a recuperação refeita, como se as
   * visitas tivessem chegado na ordem em que aconteceram.
   */
  private async refazerRecuperacaoSeguinte(tx: Tx, p: { householdId: string; visitedAt: Date; orderId: string | null; cycle: string }) {
    const escopos = [...(p.orderId ? [{ orderId: p.orderId }] : []), { orderId: null, cycle: p.cycle }];
    for (const escopo of escopos) {
      const seguinte = await tx.vectorVisit.findFirst({
        where: { householdId: p.householdId, visitedAt: { gt: p.visitedAt }, ...escopo },
        orderBy: [{ visitedAt: 'asc' }, { id: 'asc' }],
        select: { id: true, recovery: true, householdId: true, visitedAt: true, orderId: true, cycle: true },
      });
      if (!seguinte) continue;
      // Refeita pelo escopo da própria seguinte: entre as duas pode haver visita de outra ordem no mesmo ciclo.
      const recuperacao = await this.anteriorPendente(tx, seguinte);
      if (seguinte.recovery !== recuperacao) await tx.vectorVisit.update({ where: { id: seguinte.id }, data: { recovery: recuperacao } });
    }
  }
}
