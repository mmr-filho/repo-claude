import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { TenantPrisma } from '@omnisaude/database';
import { casosAgrupam, localDateString, ORDEM_ATIVA, PRECISAO_INFO, progresso, SITUACAO_INFO, STATUS_ORDEM_LABEL, type CasoParaAgrupar, type PrecisaoGeo, type StatusOrdem } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { conflict, DomainError, notFound } from '../../core/errors';
import { RealtimeService } from '../../core/realtime.service';
import { JobsService } from '../integrations/jobs.service';
import type { SystemContext } from '../integrations/messaging.service';
import { LocalizadorService } from '../territorio/localizador.service';
import { TerritorioService } from '../territorio/territorio.service';
import { MapaCasosService } from '../vigilancia/mapa.service';
import { NotificacaoService } from '../vigilancia/notificacao.service';

type Tx = TenantPrisma.TransactionClient;

/** Caso com início dos sintomas há mais que isso não abre ordem automática (parâmetro de projeto; ver docs/ENDEMIAS.md). */
export const IDADE_MAXIMA_CASO_DIAS = 30;

const TRAVA_BLOQUEIO = 'endemias:bloqueio';
const DIA = 86_400_000;

interface CasoAvaliado extends CasoParaAgrupar {
  precisao: PrecisaoGeo | null;
  blockId: string | null;
  groupKey: string;
  conditionKey: string;
}

const numeroOrdem = (o: { seq: number; year: number }) => `${o.seq}/${o.year}`;

/**
 * Ordem de bloqueio de transmissão (VIG-3a). Cada notificação de dengue, chikungunya ou Zika entra numa ordem: a ordem
 * ativa com algum caso a até duas vezes o raio e até 7 dias de diferença (Diretrizes de 2025, p. 52: agrupar casos do
 * mesmo período e da mesma área) ou uma nova. A ordem cobre a união dos quarteirões no raio de cada residência (150 m,
 * medidos até a borda), é designada aos ACE titulares das zonas atingidas e acompanha o trabalho de campo. Uma trava
 * consultiva serializa as decisões, então duas notificações simultâneas não abrem duas ordens. Sem nome do paciente.
 */
@Injectable()
export class BloqueioService implements OnModuleInit {
  private readonly logger = new Logger('Endemias');

  constructor(
    private readonly notificacoes: NotificacaoService,
    private readonly mapa: MapaCasosService,
    private readonly localizador: LocalizadorService,
    private readonly territorio: TerritorioService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit() {
    this.notificacoes.aoMudarNotificacao((sys, id) => this.avaliar(sys, id));
    this.jobs.register('endemias', (sys) => this.varredura(sys));
  }

  // ─── Gatilho: notificação → ordem ─────────────────────────────────────────

  private motivoInelegivel(n: { groupKey: string; status: string; finalClass: string | null; outOfMunicipality: boolean; condition: { context: string } }, grupos: string[]): string | null {
    if (!grupos.includes(n.groupKey)) return 'Agravo fora dos grupos do bloqueio';
    if (n.condition.context === 'ANOMALIA_CONGENITA') return 'Anomalia congênita não abre bloqueio';
    if (n.status === 'DESCARTADA') return 'Notificação descartada';
    if (n.status === 'ENCERRADA' && n.finalClass === '2') return 'Caso encerrado como descartado';
    if (n.outOfMunicipality) return 'Residência fora do município';
    return null;
  }

  /** Avalia uma notificação (depois de criada ou alterada): abre, amplia, une ou desliga a ordem. Idempotente. */
  async avaliar(sys: SystemContext, notificationId: string, agora = new Date()) {
    const cfg = sys.tenant.settings.endemias;
    const raioM = sys.tenant.settings.territorio.raioBloqueioM;
    const n = await sys.db.notification.findUnique({
      where: { id: notificationId },
      select: {
        id: true,
        patientId: true,
        groupKey: true,
        conditionKey: true,
        status: true,
        finalClass: true,
        outOfMunicipality: true,
        knownAt: true,
        symptomsOnset: true,
        residenceLat: true,
        residenceLng: true,
        residencePrecision: true,
        condition: { select: { context: true } },
      },
    });
    if (!n) return;
    const ligacao = await sys.db.blockingOrderCase.findUnique({ where: { notificationId }, select: { active: true } });
    const motivo = this.motivoInelegivel(n, cfg.gruposBloqueio);
    if (motivo && !ligacao?.active) return;
    const dataReferencia = n.symptomsOnset ? localDateString(n.symptomsOnset, 'UTC') : localDateString(n.knownAt, sys.tenant.timeZone);
    if (!motivo && !ligacao?.active) {
      if (!cfg.bloqueioAutomatico) return;
      if (agora.getTime() - Date.parse(`${dataReferencia}T12:00:00Z`) > IDADE_MAXIMA_CASO_DIAS * DIA) return;
    }
    let caso: CasoAvaliado | null = null;
    if (!motivo) {
      const r = (await this.mapa.residencias(sys.db, [n])).get(n.id) ?? null;
      // Posição que pede confirmação em campo (rua sem número, centro do bairro, CEP) não define o raio.
      const usa = !!r && PRECISAO_INFO[r.precisao].bloqueio !== 'CONFIRMAR_EM_CAMPO';
      caso = {
        lat: usa ? r!.lat : null,
        lng: usa ? r!.lng : null,
        precisao: r?.precisao ?? null,
        householdId: r?.householdId ?? null,
        patientId: n.patientId,
        dataReferencia,
        blockId: usa ? (r!.blockId ?? (await this.localizador.quarteiraoDoPonto(sys.db, r!.lat, r!.lng))?.id ?? null) : null,
        groupKey: n.groupKey,
        conditionKey: n.conditionKey,
      };
    }
    let alteradas: string[];
    try {
      alteradas = await sys.db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRAVA_BLOQUEIO}))`;
        return this.decidir(tx, sys, notificationId, caso, motivo, raioM, cfg.janelaAgrupamentoDias);
      });
    } catch (err) {
      // Trava ocupada ou falha: a varredura periódica tenta de novo em até 5 minutos.
      this.logger.warn(`Bloqueio da notificação ${notificationId}: ${(err as Error).message}`);
      throw err;
    }
    for (const id of alteradas) this.realtime.emitToTenant(sys.tenant.id, 'endemias:ordem', { id });
  }

  private async decidir(tx: Tx, sys: SystemContext, notificationId: string, caso: CasoAvaliado | null, motivo: string | null, raioM: number, janela: number): Promise<string[]> {
    const atual = await tx.blockingOrderCase.findUnique({ where: { notificationId }, include: { order: { select: { id: true, status: true } } } });
    if (motivo || !caso) return atual?.active ? this.desligar(tx, atual, motivo ?? 'Fora do bloqueio') : [];
    const retrato = {
      householdId: caso.householdId,
      groupKey: caso.groupKey,
      conditionKey: caso.conditionKey,
      lat: caso.lat,
      lng: caso.lng,
      precision: caso.precisao,
      blockId: caso.blockId,
      referenceDate: new Date(`${caso.dataReferencia}T00:00:00Z`),
    };
    if (atual?.active) {
      if (!ORDEM_ATIVA.includes(atual.order.status as StatusOrdem)) return [];
      const igual =
        atual.lat === caso.lat &&
        atual.lng === caso.lng &&
        atual.precision === caso.precisao &&
        atual.blockId === caso.blockId &&
        localDateString(atual.referenceDate, 'UTC') === caso.dataReferencia &&
        atual.householdId === caso.householdId &&
        atual.groupKey === caso.groupKey;
      if (igual) return [];
      await tx.blockingOrderCase.update({ where: { id: atual.id }, data: retrato });
      // Caso que ganhou posição numa ordem que só esperava por ela: pode pertencer a outra ordem ativa vizinha.
      if (atual.order.status === 'AGUARDANDO_LOCALIZACAO' && caso.lat != null) {
        const alvo = await this.ordemQueAgrupa(tx, caso, raioM, janela, atual.orderId);
        const sozinho = (await tx.blockingOrderCase.count({ where: { orderId: atual.orderId, active: true } })) === 1;
        if (alvo && sozinho) {
          await tx.blockingOrderCase.update({ where: { id: atual.id }, data: { orderId: alvo } });
          await tx.blockingOrder.update({
            where: { id: atual.orderId },
            data: { status: 'CANCELADA', cancelledAt: new Date(), cancelReason: 'Unificada a outra ordem: o caso foi localizado perto dela', mergedIntoId: alvo },
          });
          await this.recalcular(tx, alvo);
          return [alvo, atual.orderId];
        }
      }
      await this.recalcular(tx, atual.orderId);
      return [atual.orderId];
    }
    const alvo = await this.ordemQueAgrupa(tx, caso, raioM, janela);
    const orderId = alvo ?? (await this.criarOrdem(tx, sys, caso, raioM));
    if (atual) await tx.blockingOrderCase.update({ where: { id: atual.id }, data: { ...retrato, orderId, active: true, linkedAt: new Date(), unlinkedAt: null, unlinkReason: null } });
    else {
      const n = await tx.notification.findUniqueOrThrow({ where: { id: notificationId }, select: { patientId: true } });
      await tx.blockingOrderCase.create({ data: { ...retrato, orderId, notificationId, patientId: n.patientId } });
    }
    await this.recalcular(tx, orderId);
    return [orderId];
  }

  /** A ordem ativa mais antiga com algum caso que agrupa com este (mesmo imóvel, mesma pessoa, ou área e período). */
  private async ordemQueAgrupa(tx: Tx, caso: CasoAvaliado, raioM: number, janela: number, exceto?: string): Promise<string | null> {
    const ativos = await tx.blockingOrderCase.findMany({
      where: { active: true, order: { status: { in: [...ORDEM_ATIVA] } }, ...(exceto ? { orderId: { not: exceto } } : {}) },
      select: { orderId: true, lat: true, lng: true, householdId: true, patientId: true, referenceDate: true, order: { select: { openedAt: true } } },
    });
    const candidatos = ativos
      .filter((c) => casosAgrupam(caso, { lat: c.lat, lng: c.lng, householdId: c.householdId, patientId: c.patientId, dataReferencia: localDateString(c.referenceDate, 'UTC') }, raioM, janela))
      .sort((a, b) => a.order.openedAt.getTime() - b.order.openedAt.getTime());
    return candidatos[0]?.orderId ?? null;
  }

  private async criarOrdem(tx: Tx, sys: SystemContext, caso: CasoAvaliado, raioM: number): Promise<string> {
    const year = Number(localDateString(new Date(), sys.tenant.timeZone).slice(0, 4));
    const ultima = await tx.blockingOrder.aggregate({ where: { year }, _max: { seq: true } });
    const o = await tx.blockingOrder.create({ data: { year, seq: (ultima._max.seq ?? 0) + 1, status: caso.lat != null ? 'ABERTA' : 'AGUARDANDO_LOCALIZACAO', radiusM: raioM, groups: [caso.groupKey] } });
    return o.id;
  }

  /**
   * Refaz a lista de quarteirões (união dos raios das residências ativas), designa os titulares das zonas atingidas e
   * acerta a situação. Antes do campo a lista acompanha os casos; depois de começar, só cresce (o trabalho fica).
   */
  async recalcular(tx: Tx, orderId: string) {
    const o = await tx.blockingOrder.findUniqueOrThrow({ where: { id: orderId }, include: { cases: { where: { active: true } }, blocks: true, assignees: true } });
    const comPosicao = o.cases.filter((c) => c.lat != null && c.lng != null);
    const uniao = new Map<string, number>();
    for (const c of comPosicao) for (const b of await this.localizador.quarteiroesNoRaio(tx, c.lat!, c.lng!, o.radiusM)) uniao.set(b.id, Math.min(uniao.get(b.id) ?? Infinity, b.distanciaM));
    const emCampo = o.status === 'EM_CAMPO' || o.status === 'CONCLUIDA';
    if (!emCampo) {
      const remover = o.blocks.filter((b) => !uniao.has(b.blockId)).map((b) => b.blockId);
      if (remover.length) await tx.blockingOrderBlock.deleteMany({ where: { orderId, blockId: { in: remover } } });
    }
    for (const [blockId, distanceM] of uniao) await tx.blockingOrderBlock.upsert({ where: { orderId_blockId: { orderId, blockId } }, create: { orderId, blockId, distanceM }, update: { distanceM } });
    const titulares = await tx.vectorZoneBlock.findMany({ where: { blockId: { in: [...uniao.keys()] }, zone: { active: true, aceId: { not: null } } }, select: { zone: { select: { aceId: true } } } });
    const novos = [...new Set(titulares.map((t) => t.zone.aceId!))].filter((u) => !o.assignees.some((a) => a.userId === u));
    if (novos.length) await tx.blockingOrderAssignee.createMany({ data: novos.map((userId) => ({ orderId, userId })), skipDuplicates: true });
    const status: StatusOrdem =
      o.status === 'AGUARDANDO_LOCALIZACAO' && comPosicao.length ? 'ABERTA' : o.status === 'ABERTA' && !comPosicao.length && o.cases.length ? 'AGUARDANDO_LOCALIZACAO' : (o.status as StatusOrdem);
    await tx.blockingOrder.update({
      where: { id: orderId },
      data: {
        status,
        groups: [...new Set(o.cases.map((c) => c.groupKey))].sort(),
        needsCheck: o.cases.some((c) => !!c.precision && PRECISAO_INFO[c.precision as PrecisaoGeo].bloqueio === 'COM_AVISO'),
      },
    });
  }

  /** Caso descartado (ou fora do bloqueio): sai da ordem; ordem sem caso e sem trabalho de campo é cancelada. */
  private async desligar(tx: Tx, ligacao: { id: string; orderId: string; order: { id: string; status: string } }, motivo: string): Promise<string[]> {
    await tx.blockingOrderCase.update({ where: { id: ligacao.id }, data: { active: false, unlinkedAt: new Date(), unlinkReason: motivo } });
    if (!ORDEM_ATIVA.includes(ligacao.order.status as StatusOrdem)) return [ligacao.orderId];
    const restantes = await tx.blockingOrderCase.count({ where: { orderId: ligacao.orderId, active: true } });
    if (!restantes && !(await tx.vectorVisit.count({ where: { orderId: ligacao.orderId } }))) {
      await tx.blockingOrder.update({ where: { id: ligacao.orderId }, data: { status: 'CANCELADA', cancelledAt: new Date(), cancelReason: `Sem caso ativo antes do trabalho de campo (${motivo.toLowerCase()})` } });
      return [ligacao.orderId];
    }
    if (restantes) await this.recalcular(tx, ligacao.orderId);
    return [ligacao.orderId];
  }

  /**
   * Varredura periódica (5 min): notificação elegível sem ordem (o gatilho falhou ou a configuração mudou), caso que
   * ficou descartado, residência localizada depois e ordem sem quarteirão (malha importada depois).
   */
  async varredura(sys: SystemContext, agora = new Date()) {
    const cfg = sys.tenant.settings.endemias;
    const desde = new Date(agora.getTime() - (IDADE_MAXIMA_CASO_DIAS + 15) * DIA);
    const grupos = cfg.gruposBloqueio;
    const semOrdem = cfg.bloqueioAutomatico
      ? await sys.db.$queryRaw<{ id: string }[]>`
          SELECT n.id FROM notifications n LEFT JOIN blocking_order_cases c ON c.notification_id = n.id
          WHERE n.group_key = ANY(${grupos}::text[]) AND n.status IN ('RASCUNHO', 'NOTIFICADA', 'ENCERRADA')
            AND (n.final_class IS NULL OR n.final_class <> '2') AND NOT n.out_of_municipality AND n.known_at >= ${desde}
            AND (c.id IS NULL OR NOT c.active)
          ORDER BY n.known_at LIMIT 500`
      : [];
    const inelegiveis = await sys.db.$queryRaw<{ id: string }[]>`
      SELECT n.id FROM blocking_order_cases c JOIN notifications n ON n.id = c.notification_id
      WHERE c.active AND (n.status = 'DESCARTADA' OR (n.status = 'ENCERRADA' AND n.final_class = '2') OR n.out_of_municipality OR NOT (n.group_key = ANY(${grupos}::text[])))
      LIMIT 500`;
    const aRever = await sys.db.blockingOrderCase.findMany({ where: { active: true, order: { status: { in: ['AGUARDANDO_LOCALIZACAO', 'ABERTA'] } } }, select: { notificationId: true }, take: 1000 });
    const ids = [...new Set([...inelegiveis.map((r) => r.id), ...semOrdem.map((r) => r.id), ...aRever.map((r) => r.notificationId)])];
    let erros = 0;
    for (const id of ids)
      try {
        await this.avaliar(sys, id, agora);
      } catch {
        erros++;
      }
    // Ordem aberta sem quarteirões: a malha pode ter chegado depois.
    const semQuarteirao = await sys.db.blockingOrder.findMany({ where: { status: 'ABERTA', blocks: { none: {} } }, select: { id: true }, take: 200 });
    for (const o of semQuarteirao)
      try {
        await sys.db.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRAVA_BLOQUEIO}))`;
          await this.recalcular(tx, o.id);
        });
      } catch {
        erros++;
      }
    return { avaliadas: ids.length, semQuarteirao: semQuarteirao.length, erros };
  }

  // ─── Supervisão ───────────────────────────────────────────────────────────

  /** Progresso por ordem e por quarteirão: imóveis ativos, trabalhados e pendentes pela última visita da ordem. */
  private async progressos(db: RequestContext['db'], ordens: { id: string; blocks: { blockId: string }[] }[]) {
    const blockIds = [...new Set(ordens.flatMap((o) => o.blocks.map((b) => b.blockId)))];
    const [contagem, visitas] = await Promise.all([
      blockIds.length ? db.household.groupBy({ by: ['blockId'], where: { blockId: { in: blockIds }, active: true }, _count: { _all: true } }) : [],
      ordens.length
        ? db.vectorVisit.findMany({ where: { orderId: { in: ordens.map((o) => o.id) } }, select: { orderId: true, householdId: true, blockId: true, situation: true, visitedAt: true }, orderBy: { visitedAt: 'asc' } })
        : [],
    ]);
    const imoveisDoBloco = new Map(contagem.map((c) => [c.blockId!, c._count._all]));
    const ultima = new Map<string, { blockId: string | null; situation: string }>();
    for (const v of visitas) ultima.set(`${v.orderId}|${v.householdId}`, { blockId: v.blockId, situation: v.situation });
    return new Map(
      ordens.map((o) => {
        const porBloco = new Map<string, { trabalhados: number; pendentes: number }>();
        for (const [chave, v] of ultima) {
          if (!chave.startsWith(`${o.id}|`) || !v.blockId) continue;
          const p = porBloco.get(v.blockId) ?? { trabalhados: 0, pendentes: 0 };
          if (SITUACAO_INFO[v.situation as keyof typeof SITUACAO_INFO].pendencia) p.pendentes++;
          else p.trabalhados++;
          porBloco.set(v.blockId, p);
        }
        const blocos = o.blocks.map((b) => {
          const p = porBloco.get(b.blockId) ?? { trabalhados: 0, pendentes: 0 };
          return { blockId: b.blockId, ...progresso(Math.max(imoveisDoBloco.get(b.blockId) ?? 0, p.trabalhados + p.pendentes), p.trabalhados, p.pendentes) };
        });
        const total = blocos.reduce((s, b) => ({ i: s.i + b.imoveis, t: s.t + b.trabalhados, p: s.p + b.pendentes }), { i: 0, t: 0, p: 0 });
        return [o.id, { total: progresso(total.i, total.t, total.p), blocos }];
      }),
    );
  }

  private atrasada(o: { status: string; openedAt: Date }, dias: number, agora = Date.now()) {
    return o.status === 'ABERTA' && agora - o.openedAt.getTime() > dias * DIA;
  }

  async listar(ctx: RequestContext, q: { situacao?: 'ATIVAS' | 'ENCERRADAS' | 'TODAS' }) {
    const situacao = q.situacao ?? 'ATIVAS';
    const ordens = await ctx.db.blockingOrder.findMany({
      where: situacao === 'ATIVAS' ? { status: { in: [...ORDEM_ATIVA] } } : situacao === 'ENCERRADAS' ? { status: { in: ['CONCLUIDA', 'CANCELADA'] } } : {},
      include: { blocks: { select: { blockId: true } }, assignees: true, cases: { select: { active: true, groupKey: true } } },
      orderBy: [{ openedAt: 'desc' }],
      take: 300,
    });
    const prog = await this.progressos(ctx.db, ordens);
    const nomes = await ctx.db.user.findMany({ where: { id: { in: [...new Set(ordens.flatMap((o) => o.assignees.map((a) => a.userId)))] } }, select: { id: true, name: true } });
    const dias = ctx.tenant.settings.endemias.alertaSemInicioDias;
    return ordens.map((o) => ({
      id: o.id,
      numero: numeroOrdem(o),
      status: o.status,
      statusLabel: STATUS_ORDEM_LABEL[o.status as StatusOrdem],
      abertaEm: o.openedAt.toISOString(),
      iniciadaEm: o.startedAt?.toISOString() ?? null,
      concluidaEm: o.concludedAt?.toISOString() ?? null,
      raioM: o.radiusM,
      grupos: o.groups,
      casos: o.cases.filter((c) => c.active).length,
      casosDescartados: o.cases.filter((c) => !c.active).length,
      conferirImovel: o.needsCheck,
      atrasada: this.atrasada(o, dias),
      quarteiroes: o.blocks.length,
      agentes: o.assignees.map((a) => ({ id: a.userId, nome: nomes.find((n) => n.id === a.userId)?.name ?? null })),
      progresso: prog.get(o.id)!.total,
    }));
  }

  async detalhe(ctx: RequestContext, id: string) {
    const o = await ctx.db.blockingOrder.findUnique({ where: { id }, include: { blocks: true, assignees: true, cases: { orderBy: { linkedAt: 'asc' } } } });
    if (!o) throw notFound('Ordem de bloqueio');
    const prog = (await this.progressos(ctx.db, [o])).get(o.id)!;
    const blocos = await ctx.db.block.findMany({
      where: { id: { in: o.blocks.map((b) => b.blockId) } },
      select: { id: true, number: true, localityId: true, neighborhoodId: true, geometry: true, centerLat: true, centerLng: true },
    });
    const nomes = new Map((await this.territorio.comNomes(ctx, blocos)).map((b) => [b.id, b]));
    const usuarios = await ctx.db.user.findMany({ where: { id: { in: [...o.assignees.map((a) => a.userId), ...[o.concludedBy, o.cancelledBy].filter((x): x is string => !!x)] } }, select: { id: true, name: true } });
    const nome = (uid: string | null) => (uid ? (usuarios.find((u) => u.id === uid)?.name ?? null) : null);
    const ocorrencia = new Set(o.cases.filter((c) => c.active && c.blockId).map((c) => c.blockId!));
    return {
      id: o.id,
      numero: numeroOrdem(o),
      status: o.status,
      statusLabel: STATUS_ORDEM_LABEL[o.status as StatusOrdem],
      abertaEm: o.openedAt.toISOString(),
      abertaPor: o.openedBy ? 'manual' : 'notificacao',
      iniciadaEm: o.startedAt?.toISOString() ?? null,
      concluidaEm: o.concludedAt?.toISOString() ?? null,
      concluidaPor: nome(o.concludedBy),
      conclusao: o.conclusionNote,
      canceladaEm: o.cancelledAt?.toISOString() ?? null,
      canceladaPor: nome(o.cancelledBy),
      motivoCancelamento: o.cancelReason,
      unificadaEm: o.mergedIntoId,
      raioM: o.radiusM,
      grupos: o.groups,
      conferirImovel: o.needsCheck,
      atrasada: this.atrasada(o, ctx.tenant.settings.endemias.alertaSemInicioDias),
      // Casos só como contagem e período: o nome e o endereço ficam na notificação (sigilo, Lei 6.259/1975, art. 10).
      casos: {
        ativos: o.cases.filter((c) => c.active).length,
        semPosicao: o.cases.filter((c) => c.active && c.lat == null).length,
        descartados: o.cases.filter((c) => !c.active).map((c) => ({ motivo: c.unlinkReason, em: c.unlinkedAt?.toISOString() ?? null })),
        primeiraData: o.cases.length ? o.cases.map((c) => localDateString(c.referenceDate, 'UTC')).sort()[0] : null,
        ultimaData: o.cases.length
          ? o.cases
              .map((c) => localDateString(c.referenceDate, 'UTC'))
              .sort()
              .at(-1)
          : null,
      },
      agentes: o.assignees.map((a) => ({ id: a.userId, nome: nome(a.userId), designadoEm: a.assignedAt.toISOString() })),
      progresso: prog.total,
      quarteiroes: o.blocks
        .map((b) => {
          const n = nomes.get(b.blockId);
          const bl = blocos.find((x) => x.id === b.blockId);
          return {
            id: b.blockId,
            numero: bl?.number ?? '?',
            localidade: n?.localidade?.name ?? null,
            bairro: n?.bairro ?? null,
            distanciaM: b.distanceM,
            ocorrencia: ocorrencia.has(b.blockId),
            geometria: bl?.geometry ?? null,
            centro: bl ? { lat: bl.centerLat, lng: bl.centerLng } : null,
            progresso: prog.blocos.find((x) => x.blockId === b.blockId)!,
          };
        })
        .sort((a, b) => Number(b.ocorrencia) - Number(a.ocorrencia) || a.distanciaM - b.distanciaM),
    };
  }

  /** Cartão da ficha da notificação: a ordem em que o caso está (para a vigilância). */
  async daNotificacao(ctx: RequestContext, notificationId: string) {
    const c = await ctx.db.blockingOrderCase.findUnique({ where: { notificationId }, select: { orderId: true, active: true, unlinkReason: true, lat: true } });
    if (!c) return { ordem: null, caso: null };
    return { ordem: await this.detalhe(ctx, c.orderId), caso: { ativo: c.active, motivoDesligamento: c.unlinkReason, semPosicao: c.lat == null } };
  }

  private async exigirOrdem(ctx: RequestContext, id: string) {
    const o = await ctx.db.blockingOrder.findUnique({ where: { id } });
    if (!o) throw notFound('Ordem de bloqueio');
    return o;
  }

  /** Agentes que executam a ordem: ACE ou supervisor de campo com lotação ativa. */
  async designar(ctx: RequestContext, id: string, userIds: string[]) {
    const o = await this.exigirOrdem(ctx, id);
    if (!ORDEM_ATIVA.includes(o.status as StatusOrdem)) throw conflict('Ordem encerrada: reabra antes de mudar os agentes');
    const validos = await ctx.db.userAssignment.findMany({ where: { userId: { in: userIds }, active: true, role: { in: ['ACE', 'SUPERVISOR_ENDEMIAS'] } }, select: { userId: true } });
    const ok = new Set(validos.map((v) => v.userId));
    const fora = userIds.filter((u) => !ok.has(u));
    if (fora.length) throw new DomainError('AGENTE_INVALIDO', 'Só agentes de endemias ou supervisores de campo com lotação ativa podem ser designados', HttpStatus.BAD_REQUEST);
    await ctx.db.$transaction(async (tx) => {
      await tx.blockingOrderAssignee.deleteMany({ where: { orderId: id, userId: { notIn: userIds } } });
      await tx.blockingOrderAssignee.createMany({ data: userIds.map((userId) => ({ orderId: id, userId, assignedBy: ctx.session.userId })), skipDuplicates: true });
      await this.audit.record(ctx, tx, { action: 'endemias.ordem_designar', entityType: 'BlockingOrder', entityId: id, payload: { agentes: userIds } });
    });
    this.realtime.emitToTenant(ctx.tenant.id, 'endemias:ordem', { id });
    return this.detalhe(ctx, id);
  }

  async concluir(ctx: RequestContext, id: string, nota?: string | null) {
    const o = await this.exigirOrdem(ctx, id);
    if (o.status !== 'ABERTA' && o.status !== 'EM_CAMPO') throw conflict(`A ordem está ${STATUS_ORDEM_LABEL[o.status as StatusOrdem].toLowerCase()}`);
    const p = (await this.progressos(ctx.db, [{ id, blocks: await ctx.db.blockingOrderBlock.findMany({ where: { orderId: id }, select: { blockId: true } }) }])).get(id)!.total;
    const texto = nota?.trim() ?? '';
    if ((p.semVisita > 0 || p.pendentes > 0) && texto.length < 10)
      throw new DomainError('JUSTIFICATIVA', `Ficaram ${p.semVisita} imóvel(is) sem visita e ${p.pendentes} pendente(s): justifique a conclusão (mínimo de 10 caracteres)`, HttpStatus.UNPROCESSABLE_ENTITY);
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.blockingOrder.updateMany({
        where: { id, status: { in: ['ABERTA', 'EM_CAMPO'] } },
        data: { status: 'CONCLUIDA', concludedAt: new Date(), concludedBy: ctx.session.userId, conclusionNote: texto || null },
      });
      if (count !== 1) throw conflict('A ordem mudou enquanto você concluía; abra de novo');
      await this.audit.record(ctx, tx, { action: 'endemias.ordem_concluir', entityType: 'BlockingOrder', entityId: id, payload: { numero: numeroOrdem(o), progresso: p, nota: texto || null } });
    });
    this.realtime.emitToTenant(ctx.tenant.id, 'endemias:ordem', { id });
    return this.detalhe(ctx, id);
  }

  async reabrir(ctx: RequestContext, id: string, motivo: string) {
    const o = await this.exigirOrdem(ctx, id);
    if (o.status !== 'CONCLUIDA') throw conflict('Só ordem concluída pode ser reaberta');
    const comVisita = (await ctx.db.vectorVisit.count({ where: { orderId: id } })) > 0;
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.blockingOrder.updateMany({ where: { id, status: 'CONCLUIDA' }, data: { status: comVisita ? 'EM_CAMPO' : 'ABERTA', concludedAt: null, concludedBy: null } });
      if (count !== 1) throw conflict('A ordem mudou enquanto você reabria; abra de novo');
      await this.audit.record(ctx, tx, { action: 'endemias.ordem_reabrir', entityType: 'BlockingOrder', entityId: id, payload: { numero: numeroOrdem(o), motivo: motivo.trim() } });
    });
    this.realtime.emitToTenant(ctx.tenant.id, 'endemias:ordem', { id });
    return this.detalhe(ctx, id);
  }

  /** Cancelar é decisão da coordenação (ex.: epidemia, com a ação passando a ser por área). */
  async cancelar(ctx: RequestContext, id: string, motivo: string) {
    const o = await this.exigirOrdem(ctx, id);
    if (!ORDEM_ATIVA.includes(o.status as StatusOrdem)) throw conflict('A ordem já está encerrada');
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.blockingOrder.updateMany({
        where: { id, status: { in: [...ORDEM_ATIVA] } },
        data: { status: 'CANCELADA', cancelledAt: new Date(), cancelledBy: ctx.session.userId, cancelReason: motivo.trim() },
      });
      if (count !== 1) throw conflict('A ordem mudou enquanto você cancelava; abra de novo');
      await this.audit.record(ctx, tx, { action: 'endemias.ordem_cancelar', entityType: 'BlockingOrder', entityId: id, payload: { numero: numeroOrdem(o), motivo: motivo.trim() } });
    });
    this.realtime.emitToTenant(ctx.tenant.id, 'endemias:ordem', { id });
    return this.detalhe(ctx, id);
  }

  /** Refaz os quarteirões (a malha mudou) e reavalia os casos, sob a mesma trava do gatilho. */
  async recalcularManual(ctx: RequestContext, id: string) {
    await this.exigirOrdem(ctx, id);
    const casos = await ctx.db.blockingOrderCase.findMany({ where: { orderId: id }, select: { notificationId: true } });
    for (const c of casos) await this.avaliar(ctx, c.notificationId);
    await ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRAVA_BLOQUEIO}))`;
      const o = await tx.blockingOrder.findUniqueOrThrow({ where: { id } });
      if (ORDEM_ATIVA.includes(o.status as StatusOrdem)) await this.recalcular(tx, id);
      await this.audit.record(ctx, tx, { action: 'endemias.ordem_recalcular', entityType: 'BlockingOrder', entityId: id, payload: { numero: numeroOrdem(o) } });
    });
    return this.detalhe(ctx, id);
  }
}
