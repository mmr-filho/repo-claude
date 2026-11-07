import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { appendAudit, type TenantClient, type TenantPrisma } from '@omnisaude/database';
import {
  casosAgrupam,
  localDateString,
  ORDEM_ATIVA,
  PRECISAO_INFO,
  progresso,
  roleHasPermission,
  SITUACAO_INFO,
  SITUACOES_VISITA,
  STATUS_ORDEM_LABEL,
  type CasoParaAgrupar,
  type PrecisaoGeo,
  type StatusOrdem,
} from '@omnisaude/shared';
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
/** O que a análise do caso lê (o cliente do tenant fora da trava ou a transação dentro dela). */
type Leitor = Pick<TenantClient, 'notification' | 'blockingOrderCase' | 'patient' | 'block' | 'household' | '$executeRaw'>;

/** Caso com início dos sintomas há mais que isso não abre ordem automática (parâmetro de projeto; ver docs/ENDEMIAS.md). */
export const IDADE_MAXIMA_CASO_DIAS = 30;

const TRAVA_BLOQUEIO = 'endemias:bloqueio';
const DIA = 86_400_000;
/** Esperas entre as tentativas de pegar a trava das ordens, fora da transação (sem segurar conexão do pool). */
const ESPERAS_TRAVA_MS = [50, 100, 200, 400, 800];
/** Situações da visita que contam o imóvel como trabalhado; as demais são pendência (fechado, recusado, abandonado). */
const TRABALHADAS: string[] = SITUACOES_VISITA.filter((s) => !SITUACAO_INFO[s].pendencia);
/** Teto da lista de ordens (a tela avisa quando vem cheia). */
const LIMITE_LISTA = 500;

interface CasoAvaliado extends CasoParaAgrupar {
  patientId: string;
  precisao: PrecisaoGeo | null;
  blockId: string | null;
  groupKey: string;
  conditionKey: string;
}

interface Ligacao {
  id: string;
  orderId: string;
  active: boolean;
  householdId: string | null;
  groupKey: string;
  conditionKey: string;
  lat: number | null;
  lng: number | null;
  precision: string | null;
  blockId: string | null;
  referenceDate: Date;
  order: { id: string; status: string };
}

interface Analise {
  notificationId: string;
  /** Nada a fazer: inelegível sem ligação ativa, bloqueio automático desligado ou caso antigo sem ordem. */
  ignorar: boolean;
  motivo: string | null;
  caso: CasoAvaliado | null;
  ligacao: Ligacao | null;
}

const numeroOrdem = (o: { seq: number; year: number }) => `${o.seq}/${o.year}`;
const ativa = (status: string) => ORDEM_ATIVA.includes(status as StatusOrdem);
const dataUtc = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
/** Dias de `b` até `a` (negativo quando `a` vem antes). */
const diasDepois = (a: string, b: string) => (dataUtc(a) - dataUtc(b)) / DIA;
/** O caso ainda abre ordem automática: a data de referência (ao meio-dia) é de até 30 dias atrás. */
const recente = (dataReferencia: string, agora: Date) => agora.getTime() - Date.parse(`${dataReferencia}T12:00:00Z`) <= IDADE_MAXIMA_CASO_DIAS * DIA;

/** Menor data de referência que ainda abre ordem automática (a regra de `recente`, para o SQL da varredura). */
function dataDeCorte(agora: Date) {
  let d = new Date(agora.getTime() - (IDADE_MAXIMA_CASO_DIAS + 2) * DIA).toISOString().slice(0, 10);
  while (!recente(d, agora)) d = new Date(dataUtc(d) + DIA).toISOString().slice(0, 10);
  return d;
}

/**
 * Ordem de bloqueio de transmissão (VIG-3a). Cada notificação de dengue, chikungunya ou Zika entra numa ordem: a ordem
 * ativa com algum caso do mesmo período (até 7 dias, contados também da primeira data da ordem, sem cadeia) e da mesma
 * área (até duas vezes o raio), ou do mesmo imóvel ou pessoa no período (Diretrizes de 2025, p. 52), ou uma nova. A
 * ordem cobre a união dos quarteirões no raio de cada residência (150 m, medidos até a borda), é designada aos ACE
 * titulares das zonas atingidas e acompanha o trabalho de campo. Uma trava consultiva serializa as decisões, então duas
 * notificações simultâneas não abrem duas ordens. Sem nome do paciente.
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
    this.territorio.aoMudarPosicaoImovel((ctx, ids) => this.reavaliarImovel(ctx, ids));
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

  /** Lê a notificação e a ligação e monta o retrato do caso: o mesmo cálculo fora da trava e, de novo, dentro dela. */
  private async analisar(db: Leitor, sys: SystemContext, notificationId: string, agora: Date): Promise<Analise | null> {
    const cfg = sys.tenant.settings.endemias;
    const n = await db.notification.findUnique({
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
    if (!n) return null;
    const ligacao = await db.blockingOrderCase.findUnique({ where: { notificationId }, include: { order: { select: { id: true, status: true } } } });
    const motivo = this.motivoInelegivel(n, cfg.gruposBloqueio);
    if (motivo) return { notificationId, motivo, ligacao, caso: null, ignorar: !ligacao?.active };
    const dataReferencia = n.symptomsOnset ? localDateString(n.symptomsOnset, 'UTC') : localDateString(n.knownAt, sys.tenant.timeZone);
    if (!ligacao?.active && (!cfg.bloqueioAutomatico || !recente(dataReferencia, agora))) return { notificationId, motivo: null, ligacao, caso: null, ignorar: true };
    const r = (await this.mapa.residencias(db, [n])).get(n.id) ?? null;
    // Posição que pede confirmação em campo (rua sem número, centro do bairro, CEP) não define o raio.
    const usa = !!r && PRECISAO_INFO[r.precisao].bloqueio !== 'CONFIRMAR_EM_CAMPO';
    // Sem posição nenhuma, o caso ainda agrupa pelo imóvel (moradores da mesma casa) e pela pessoa.
    const householdId = r ? r.householdId : ((await this.mapa.domicilios(db, [n.patientId])).get(n.patientId) ?? null);
    const caso: CasoAvaliado = {
      lat: usa ? r!.lat : null,
      lng: usa ? r!.lng : null,
      precisao: r?.precisao ?? null,
      householdId,
      patientId: n.patientId,
      dataReferencia,
      blockId: usa ? (r!.blockId ?? (await this.localizador.quarteiraoDoPonto(db, r!.lat, r!.lng))?.id ?? null) : null,
      groupKey: n.groupKey,
      conditionKey: n.conditionKey,
    };
    return { notificationId, motivo: null, ligacao, caso, ignorar: false };
  }

  private mesmoRetrato(l: Ligacao, c: CasoAvaliado) {
    return (
      l.lat === c.lat &&
      l.lng === c.lng &&
      l.precision === c.precisao &&
      l.blockId === c.blockId &&
      localDateString(l.referenceDate, 'UTC') === c.dataReferencia &&
      l.householdId === c.householdId &&
      l.groupKey === c.groupKey &&
      l.conditionKey === c.conditionKey
    );
  }

  /** Há o que gravar? Retrato igual numa ordem ativa, ou caso ligado a ordem já encerrada, não muda nada. */
  private precisaMudar(a: Analise): boolean {
    if (a.ignorar) return false;
    const l = a.ligacao;
    if (a.motivo || !a.caso) return !!l?.active;
    if (!l?.active) return true;
    return ativa(l.order.status) && !this.mesmoRetrato(l, a.caso);
  }

  /**
   * Executa sob a trava das ordens. Com a trava ocupada, tenta de novo algumas vezes, esperando fora da transação (sem
   * segurar conexão do pool); sem conseguir, desiste com erro (a varredura periódica refaz).
   */
  private async comTrava<T>(db: TenantClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let tentativa = 0; ; tentativa++) {
      const r = await db.$transaction(
        async (tx) => {
          const [trava] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${TRAVA_BLOQUEIO})) AS ok`;
          if (!trava?.ok) return { ok: false as const };
          // Travas de linha (a visita do ACE gravando na mesma ordem) esperam pouco.
          await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
          return { ok: true as const, valor: await fn(tx) };
        },
        { timeout: 20_000 },
      );
      if (r.ok) return r.valor;
      const espera = ESPERAS_TRAVA_MS[tentativa];
      if (espera === undefined) throw new DomainError('BLOQUEIO_OCUPADO', 'Outra atualização das ordens de bloqueio está em andamento: tente de novo em instantes', HttpStatus.CONFLICT);
      await new Promise((ok) => setTimeout(ok, espera));
    }
  }

  /** Avalia uma notificação (depois de criada ou alterada): abre, amplia, une ou desliga a ordem. Idempotente. */
  async avaliar(sys: SystemContext, notificationId: string, agora = new Date()) {
    // Fora da trava: a maioria das chamadas (edição sem efeito na ordem, varredura) não muda nada e sai sem transação.
    const previa = await this.analisar(sys.db, sys, notificationId, agora);
    if (!previa || !this.precisaMudar(previa)) return;
    let alteradas: string[];
    try {
      alteradas = await this.comTrava(sys.db, async (tx) => {
        // Relidas dentro da trava: o descarte, o encerramento ou outra decisão podem ter entrado no intervalo.
        const a = await this.analisar(tx, sys, notificationId, agora);
        return a && this.precisaMudar(a) ? this.decidir(tx, sys, a) : [];
      });
    } catch (err) {
      // Trava ocupada ou falha: a varredura periódica tenta de novo em até 5 minutos.
      this.logger.warn(`Bloqueio da notificação ${notificationId}: ${(err as Error).message}`);
      throw err;
    }
    for (const id of alteradas) this.realtime.emitToEndemias(sys.tenant.id, 'endemias:ordem', { id });
  }

  /**
   * Imóveis que mudaram de posição ou de quarteirão (contrato com o território): reavalia os casos ativos dos moradores
   * e os que guardam o imóvel no retrato, também em ordem em campo (lá a lista só cresce). Nunca lança.
   */
  async reavaliarImovel(sys: SystemContext, householdIds: string | string[]) {
    const ids = [...new Set(typeof householdIds === 'string' ? [householdIds] : householdIds)];
    for (let i = 0; i < ids.length; i += 1000)
      try {
        const lote = ids.slice(i, i + 1000);
        const casos = await sys.db.$queryRaw<{ id: string }[]>`
          SELECT DISTINCT c.notification_id AS id FROM blocking_order_cases c
          JOIN blocking_orders o ON o.id = c.order_id
          LEFT JOIN patients p ON p.id = c.patient_id
          LEFT JOIN patients s ON s.id = p.merged_into_id
          LEFT JOIN families f ON f.id = COALESCE(p.family_id, s.family_id)
          WHERE c.active AND o.status IN ('AGUARDANDO_LOCALIZACAO', 'ABERTA', 'EM_CAMPO')
            AND (f.household_id = ANY(${lote}::uuid[]) OR c.household_id = ANY(${lote}::uuid[]))`;
        for (const c of casos)
          try {
            await this.avaliar(sys, c.id);
          } catch {
            // Já registrado em avaliar; a varredura periódica refaz.
          }
      } catch (err) {
        this.logger.error(`Reavaliação dos casos de ${ids.length} imóvel(is): ${(err as Error).message}`);
      }
  }

  private retrato(c: CasoAvaliado) {
    return {
      householdId: c.householdId ?? null,
      groupKey: c.groupKey,
      conditionKey: c.conditionKey,
      lat: c.lat,
      lng: c.lng,
      precision: c.precisao,
      blockId: c.blockId,
      referenceDate: new Date(`${c.dataReferencia}T00:00:00Z`),
    };
  }

  private async decidir(tx: Tx, sys: SystemContext, a: Analise): Promise<string[]> {
    const atual = a.ligacao;
    if (a.motivo || !a.caso) return atual?.active ? this.desligar(tx, atual, a.motivo ?? 'Fora do bloqueio') : [];
    const caso = a.caso;
    const religar = { active: true, linkedAt: new Date(), unlinkedAt: null, unlinkReason: null };
    if (atual?.active) {
      await tx.blockingOrderCase.update({ where: { id: atual.id }, data: this.retrato(caso) });
      return this.acomodar(tx, sys, atual.orderId, caso);
    }
    // Caso que volta (descarte desfeito, encerramento reaberto): à própria ordem, se ela continua ativa; o trabalho de
    // campo dela vale para ele.
    if (atual && ativa(atual.order.status)) {
      await tx.blockingOrderCase.update({ where: { id: atual.id }, data: { ...this.retrato(caso), ...religar } });
      return this.acomodar(tx, sys, atual.orderId, caso);
    }
    const alvo = await this.ordemQueAgrupa(tx, sys, caso);
    const orderId = alvo ?? (await this.criarOrdem(tx, sys, caso));
    if (atual) await tx.blockingOrderCase.update({ where: { id: atual.id }, data: { ...this.retrato(caso), orderId, ...religar } });
    else await tx.blockingOrderCase.create({ data: { ...this.retrato(caso), orderId, notificationId: a.notificationId, patientId: caso.patientId } });
    await this.recalcular(tx, orderId);
    return [orderId];
  }

  /**
   * O caso mudou (posição, data, imóvel) ou voltou à ordem. Se agora agrupa com outra ordem ativa e uma das duas ainda
   * não tem trabalho de campo, viram uma só (a sem campo vai para a outra); senão, refaz os quarteirões da própria ordem.
   */
  private async acomodar(tx: Tx, sys: SystemContext, orderId: string, caso: CasoAvaliado): Promise<string[]> {
    const campo = await this.temTrabalhoDeCampo(tx, orderId);
    let tentativas = 0;
    for (const outra of await this.ordensQueAgrupam(tx, sys, caso, orderId)) {
      // Duas ordens com trabalho de campo não se unem (cada uma guarda o seu); a união confere de novo, com as linhas travadas.
      if (campo && (await this.temTrabalhoDeCampo(tx, outra))) continue;
      const unidas = await this.unir(tx, sys, orderId, outra);
      if (unidas) return unidas;
      if (++tentativas === 3) break;
    }
    await this.recalcular(tx, orderId);
    return [orderId];
  }

  private async temTrabalhoDeCampo(tx: Tx, orderId: string) {
    return (await tx.vectorVisit.count({ where: { orderId } })) > 0;
  }

  /**
   * Une duas ordens ativas (rotina única): a sem trabalho de campo vai para a outra; se nenhuma tem, a mais nova vai para
   * a mais antiga. Os casos ativos e os agentes designados à mão passam ao destino, e a de origem é cancelada com a
   * referência da unificação. Não une (null) se as duas já têm campo ou se a ordem unida passaria da janela.
   */
  private async unir(tx: Tx, sys: SystemContext, a: string, b: string): Promise<string[] | null> {
    // As duas linhas travadas, em ordem fixa: a visita que chega agora a uma delas espera o fim da união.
    await tx.$queryRaw`SELECT id FROM blocking_orders WHERE id = ANY(${[a, b].sort()}::uuid[]) ORDER BY id FOR UPDATE`;
    const ordens = await tx.blockingOrder.findMany({
      where: { id: { in: [a, b] } },
      select: { id: true, status: true, openedAt: true, startedAt: true, _count: { select: { visits: true } }, cases: { where: { active: true }, select: { referenceDate: true } } },
    });
    const oa = ordens.find((o) => o.id === a);
    const ob = ordens.find((o) => o.id === b);
    if (!oa || !ob || !ativa(oa.status) || !ativa(ob.status)) return null;
    const campoA = oa._count.visits > 0;
    const campoB = ob._count.visits > 0;
    if (campoA && campoB) return null;
    const [origem, destino] = campoA ? [ob, oa] : campoB ? [oa, ob] : oa.openedAt <= ob.openedAt ? [ob, oa] : [oa, ob];
    // Sem cadeia: os casos da ordem unida continuam do mesmo período (e do período do campo, se o destino já começou).
    const datas = [...origem.cases, ...destino.cases].map((c) => localDateString(c.referenceDate, 'UTC')).sort();
    const janela = sys.tenant.settings.endemias.janelaAgrupamentoDias;
    if (datas.length && diasDepois(datas.at(-1)!, datas[0]!) > janela) return null;
    if (destino.startedAt) {
      const inicio = localDateString(destino.startedAt, sys.tenant.timeZone);
      if (origem.cases.some((c) => diasDepois(localDateString(c.referenceDate, 'UTC'), inicio) > janela)) return null;
    }
    await tx.blockingOrderCase.updateMany({ where: { orderId: origem.id, active: true }, data: { orderId: destino.id } });
    const manuais = await tx.blockingOrderAssignee.findMany({ where: { orderId: origem.id, assignedBy: { not: null } } });
    if (manuais.length) await tx.blockingOrderAssignee.createMany({ data: manuais.map((m) => ({ orderId: destino.id, userId: m.userId, assignedBy: m.assignedBy })), skipDuplicates: true });
    await tx.blockingOrder.update({
      where: { id: origem.id },
      data: { status: 'CANCELADA', cancelledAt: new Date(), cancelReason: 'Unificada a outra ordem: os casos ficaram na mesma área e no mesmo período', mergedIntoId: destino.id },
    });
    await this.recalcular(tx, destino.id);
    return [destino.id, origem.id];
  }

  /** A ordem ativa mais antiga em que o caso entra (ver `ordensQueAgrupam`). */
  private async ordemQueAgrupa(tx: Tx, sys: SystemContext, caso: CasoAvaliado): Promise<string | null> {
    return (await this.ordensQueAgrupam(tx, sys, caso))[0] ?? null;
  }

  /**
   * As ordens ativas em que o caso entra, da mais antiga para a mais nova. Algum caso ativo dela agrupa com ele (mesmo
   * imóvel ou pessoa, ou área, no mesmo período) e, sem cadeia, com ele a ordem continua num período só (todas as datas
   * de referência a até a janela da menor) e o caso não começou mais que a janela depois do início do campo. A ordem em
   * campo também recebe o caso pela identidade de um caso que saiu dela (reclassificação) ou por morar num quarteirão que
   * ela já cobre.
   */
  private async ordensQueAgrupam(tx: Tx, sys: SystemContext, caso: CasoAvaliado, exceto?: string): Promise<string[]> {
    const raioM = sys.tenant.settings.territorio.raioBloqueioM;
    const janela = sys.tenant.settings.endemias.janelaAgrupamentoDias;
    const semExceto = exceto ? { id: { not: exceto } } : {};
    const ativos = await tx.blockingOrderCase.findMany({
      where: { active: true, order: { status: { in: [...ORDEM_ATIVA] }, ...semExceto } },
      select: { orderId: true, lat: true, lng: true, householdId: true, patientId: true, referenceDate: true },
    });
    const identidade = [{ patientId: caso.patientId }, ...(caso.householdId ? [{ householdId: caso.householdId }] : [])];
    const emCampo = await tx.blockingOrder.findMany({
      where: { status: 'EM_CAMPO', ...semExceto, OR: [{ cases: { some: { active: false, OR: identidade } } }, ...(caso.blockId ? [{ blocks: { some: { blockId: caso.blockId } } }] : [])] },
      select: { id: true, cases: { where: { active: false, OR: identidade }, select: { referenceDate: true } }, blocks: caso.blockId ? { where: { blockId: caso.blockId }, select: { blockId: true } } : false },
    });
    // Período de cada ordem: a menor e a maior data de referência dos casos ativos.
    const periodo = new Map<string, { de: string; ate: string }>();
    const candidatas = new Set<string>();
    for (const c of ativos) {
      const data = localDateString(c.referenceDate, 'UTC');
      const p = periodo.get(c.orderId);
      periodo.set(c.orderId, { de: !p || data < p.de ? data : p.de, ate: !p || data > p.ate ? data : p.ate });
      if (casosAgrupam(caso, { lat: c.lat, lng: c.lng, householdId: c.householdId, patientId: c.patientId, dataReferencia: data }, raioM, janela)) candidatas.add(c.orderId);
    }
    for (const o of emCampo) {
      const pelaIdentidade = o.cases.some((c) => Math.abs(diasDepois(caso.dataReferencia, localDateString(c.referenceDate, 'UTC'))) <= janela);
      if (pelaIdentidade || (o.blocks?.length ?? 0) > 0) candidatas.add(o.id);
    }
    if (!candidatas.size) return [];
    const ordens = await tx.blockingOrder.findMany({ where: { id: { in: [...candidatas] } }, select: { id: true, openedAt: true, startedAt: true } });
    const validas = ordens.filter((o) => {
      const p = periodo.get(o.id);
      if (p && (diasDepois(caso.dataReferencia, p.de) > janela || diasDepois(p.ate, caso.dataReferencia) > janela)) return false;
      // Campo iniciado antes do começo do caso além da janela: o trabalho feito não serve a ele.
      return !o.startedAt || diasDepois(caso.dataReferencia, localDateString(o.startedAt, sys.tenant.timeZone)) <= janela;
    });
    validas.sort((x, y) => x.openedAt.getTime() - y.openedAt.getTime() || x.id.localeCompare(y.id));
    return validas.map((o) => o.id);
  }

  private async criarOrdem(tx: Tx, sys: SystemContext, caso: CasoAvaliado): Promise<string> {
    const year = Number(localDateString(new Date(), sys.tenant.timeZone).slice(0, 4));
    const ultima = await tx.blockingOrder.aggregate({ where: { year }, _max: { seq: true } });
    const o = await tx.blockingOrder.create({
      data: { year, seq: (ultima._max.seq ?? 0) + 1, status: caso.lat != null ? 'ABERTA' : 'AGUARDANDO_LOCALIZACAO', radiusM: sys.tenant.settings.territorio.raioBloqueioM, groups: [caso.groupKey] },
    });
    return o.id;
  }

  /** ACE ou supervisor de campo com lotação ativa e usuário ativo (os mesmos da lista de agentes da supervisão). */
  private async elegiveis(db: Pick<TenantClient, 'userAssignment'>, userIds: string[]): Promise<string[]> {
    if (!userIds.length) return [];
    const ok = new Set(
      (await db.userAssignment.findMany({ where: { userId: { in: userIds }, active: true, role: { in: ['ACE', 'SUPERVISOR_ENDEMIAS'] }, user: { active: true } }, select: { userId: true } })).map((a) => a.userId),
    );
    return userIds.filter((u) => ok.has(u));
  }

  /**
   * Refaz a lista de quarteirões (união dos raios das residências ativas), designa os titulares das zonas dos
   * quarteirões que entraram agora e acerta a situação. Antes do campo a lista acompanha os casos; depois de começar,
   * só cresce (o trabalho fica). A linha da ordem fica travada até o fim: a visita, a conclusão e o cancelamento que
   * chegam no meio esperam e reavaliam a situação, e esta gravação não os desfaz.
   */
  async recalcular(tx: Tx, orderId: string) {
    await tx.$queryRaw`SELECT id FROM blocking_orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const o = await tx.blockingOrder.findUnique({ where: { id: orderId }, include: { cases: { where: { active: true } }, blocks: true, assignees: true } });
    if (!o || !ativa(o.status)) return;
    const comPosicao = o.cases.filter((c) => c.lat != null && c.lng != null);
    const uniao = new Map<string, number>();
    for (const c of comPosicao) for (const b of await this.localizador.quarteiroesNoRaio(tx, c.lat!, c.lng!, o.radiusM)) uniao.set(b.id, Math.min(uniao.get(b.id) ?? Infinity, b.distanciaM));
    const emCampo = o.status === 'EM_CAMPO' || (await this.temTrabalhoDeCampo(tx, orderId));
    if (!emCampo) {
      const remover = o.blocks.filter((b) => !uniao.has(b.blockId)).map((b) => b.blockId);
      if (remover.length) await tx.blockingOrderBlock.deleteMany({ where: { orderId, blockId: { in: remover } } });
    }
    for (const [blockId, distanceM] of uniao) await tx.blockingOrderBlock.upsert({ where: { orderId_blockId: { orderId, blockId } }, create: { orderId, blockId, distanceM }, update: { distanceM } });
    // Designação automática só dos titulares (elegíveis) das zonas dos quarteirões que entraram agora: quem a supervisão
    // tirou da ordem não volta sozinho.
    const antes = new Set(o.blocks.map((b) => b.blockId));
    const entraram = [...uniao.keys()].filter((b) => !antes.has(b));
    if (entraram.length) {
      const titulares = await tx.vectorZoneBlock.findMany({ where: { blockId: { in: entraram }, zone: { active: true, aceId: { not: null } } }, select: { zone: { select: { aceId: true } } } });
      const agentes = await this.elegiveis(
        tx,
        [...new Set(titulares.map((t) => t.zone.aceId!))].filter((u) => !o.assignees.some((a) => a.userId === u)),
      );
      if (agentes.length) {
        await tx.blockingOrderAssignee.createMany({ data: agentes.map((userId) => ({ orderId, userId })), skipDuplicates: true });
        await appendAudit(tx, { mfa: false, action: 'endemias.ordem_designar_auto', entityType: 'BlockingOrder', entityId: orderId, payload: { numero: numeroOrdem(o), agentes, quarteiroes: entraram.length } });
      }
    }
    // Situação: só as passagens entre aguardar a localização e aberta; o campo, a conclusão e o cancelamento são de quem
    // os faz (com a linha travada, a leitura acima é a atual).
    const status: StatusOrdem | null = o.status === 'AGUARDANDO_LOCALIZACAO' && comPosicao.length ? 'ABERTA' : o.status === 'ABERTA' && !emCampo && !comPosicao.length && o.cases.length ? 'AGUARDANDO_LOCALIZACAO' : null;
    if (status) await tx.blockingOrder.updateMany({ where: { id: orderId, status: o.status }, data: { status } });
    await tx.blockingOrder.update({
      where: { id: orderId },
      data: {
        groups: [...new Set(o.cases.map((c) => c.groupKey))].sort(),
        needsCheck: o.cases.some((c) => !!c.precision && PRECISAO_INFO[c.precision as PrecisaoGeo].bloqueio === 'COM_AVISO'),
      },
    });
  }

  /** Caso descartado (ou fora do bloqueio): sai da ordem; ordem sem caso e sem trabalho de campo é cancelada. */
  private async desligar(tx: Tx, ligacao: { id: string; orderId: string }, motivo: string): Promise<string[]> {
    await tx.blockingOrderCase.update({ where: { id: ligacao.id }, data: { active: false, unlinkedAt: new Date(), unlinkReason: motivo } });
    // Linha travada: a visita que chega agora espera, e a contagem de visitas abaixo a vê.
    await tx.$queryRaw`SELECT id FROM blocking_orders WHERE id = ${ligacao.orderId}::uuid FOR UPDATE`;
    const o = await tx.blockingOrder.findUnique({ where: { id: ligacao.orderId }, select: { status: true } });
    if (!o || !ativa(o.status)) return [ligacao.orderId];
    const restantes = await tx.blockingOrderCase.count({ where: { orderId: ligacao.orderId, active: true } });
    if (!restantes && !(await this.temTrabalhoDeCampo(tx, ligacao.orderId))) {
      await tx.blockingOrder.updateMany({
        where: { id: ligacao.orderId, status: { in: [...ORDEM_ATIVA] } },
        data: { status: 'CANCELADA', cancelledAt: new Date(), cancelReason: `Sem caso ativo antes do trabalho de campo (${motivo.toLowerCase()})` },
      });
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
    const tz = sys.tenant.timeZone;
    const desde = new Date(agora.getTime() - (IDADE_MAXIMA_CASO_DIAS + 15) * DIA);
    const grupos = cfg.gruposBloqueio;
    // As mesmas regras de `avaliar` (idade do caso, anomalia congênita), das mais recentes para as mais antigas: o que
    // avaliar recusaria não ocupa o lote.
    const semOrdem = cfg.bloqueioAutomatico
      ? await sys.db.$queryRaw<{ id: string }[]>`
          SELECT n.id FROM notifications n
          JOIN notifiable_conditions nc ON nc.id = n.condition_id
          LEFT JOIN blocking_order_cases c ON c.notification_id = n.id
          WHERE n.group_key = ANY(${grupos}::text[]) AND n.status IN ('RASCUNHO', 'NOTIFICADA', 'ENCERRADA')
            AND (n.final_class IS NULL OR n.final_class <> '2') AND NOT n.out_of_municipality
            AND nc.context <> 'ANOMALIA_CONGENITA'
            AND n.known_at >= ${desde}
            AND COALESCE(n.symptoms_onset, (n.known_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date) >= ${dataDeCorte(agora)}::date
            AND (c.id IS NULL OR NOT c.active)
          ORDER BY n.known_at DESC LIMIT 500`
      : [];
    const inelegiveis = await sys.db.$queryRaw<{ id: string }[]>`
      SELECT n.id FROM blocking_order_cases c JOIN notifications n ON n.id = c.notification_id
      WHERE c.active AND (n.status = 'DESCARTADA' OR (n.status = 'ENCERRADA' AND n.final_class = '2') OR n.out_of_municipality OR NOT (n.group_key = ANY(${grupos}::text[])))
      LIMIT 500`;
    // Casos a rever: primeiro os que aguardam a localização, depois os de imóvel com posição mais nova que a ligação
    // (também com a ordem em campo, onde só acrescenta quarteirões) e, por fim, os mais recentes.
    const aRever = await sys.db.$queryRaw<{ id: string }[]>`
      SELECT c.notification_id AS id FROM blocking_order_cases c
      JOIN blocking_orders o ON o.id = c.order_id
      LEFT JOIN patients p ON p.id = c.patient_id
      LEFT JOIN families f ON f.id = p.family_id
      LEFT JOIN households h ON h.id = f.household_id
      WHERE c.active AND o.status IN ('AGUARDANDO_LOCALIZACAO', 'ABERTA', 'EM_CAMPO')
        AND (o.status <> 'EM_CAMPO' OR (h.geo_at > c.linked_at AND (h.latitude IS DISTINCT FROM c.lat OR h.longitude IS DISTINCT FROM c.lng)))
      ORDER BY (o.status = 'AGUARDANDO_LOCALIZACAO') DESC,
        (h.geo_at > c.linked_at AND (h.latitude IS DISTINCT FROM c.lat OR h.longitude IS DISTINCT FROM c.lng)) DESC NULLS LAST,
        c.linked_at DESC
      LIMIT 1000`;
    const ids = [...new Set([...inelegiveis.map((r) => r.id), ...semOrdem.map((r) => r.id), ...aRever.map((r) => r.id)])];
    let erros = 0;
    for (const id of ids)
      try {
        await this.avaliar(sys, id, agora);
      } catch {
        erros++;
      }
    // Ordem aberta sem quarteirões: a malha pode ter chegado depois (as mais novas primeiro).
    const semQuarteirao = await sys.db.blockingOrder.findMany({ where: { status: 'ABERTA', blocks: { none: {} } }, select: { id: true }, orderBy: { openedAt: 'desc' }, take: 200 });
    for (const o of semQuarteirao)
      try {
        await this.comTrava(sys.db, (tx) => this.recalcular(tx, o.id));
      } catch {
        erros++;
      }
    return { avaliadas: ids.length, semQuarteirao: semQuarteirao.length, erros };
  }

  // ─── Supervisão ───────────────────────────────────────────────────────────

  /**
   * Progresso por ordem e por quarteirão: os imóveis ativos que estão hoje no quarteirão e, de cada um, a última visita
   * da ordem (trabalhado ou pendente). Visita a imóvel que saiu do quarteirão ou foi inativado não conta por outro.
   */
  private async progressos(db: Pick<TenantClient, '$queryRaw'>, ordens: { id: string; blocks: { blockId: string }[] }[]) {
    const ids = ordens.map((o) => o.id);
    const linhas = ids.length
      ? await db.$queryRaw<{ orderId: string; blockId: string; imoveis: number; trabalhados: number; pendentes: number }[]>`
          WITH ultima AS (
            SELECT DISTINCT ON (v.order_id, v.household_id) v.order_id, v.household_id, v.situation::text AS situacao
            FROM vector_visits v WHERE v.order_id = ANY(${ids}::uuid[])
            ORDER BY v.order_id, v.household_id, v.visited_at DESC, v.id DESC
          )
          SELECT ob.order_id AS "orderId", ob.block_id AS "blockId", count(h.id)::int AS imoveis,
            (count(u.household_id) FILTER (WHERE u.situacao = ANY(${TRABALHADAS}::text[])))::int AS trabalhados,
            (count(u.household_id) FILTER (WHERE NOT (u.situacao = ANY(${TRABALHADAS}::text[]))))::int AS pendentes
          FROM blocking_order_blocks ob
          JOIN households h ON h.block_id = ob.block_id AND h.active
          LEFT JOIN ultima u ON u.order_id = ob.order_id AND u.household_id = h.id
          WHERE ob.order_id = ANY(${ids}::uuid[])
          GROUP BY ob.order_id, ob.block_id`
      : [];
    const porBloco = new Map(linhas.map((l) => [`${l.orderId}|${l.blockId}`, l]));
    return new Map(
      ordens.map((o) => {
        const blocos = o.blocks.map((b) => {
          const l = porBloco.get(`${o.id}|${b.blockId}`);
          return { blockId: b.blockId, ...progresso(l?.imoveis ?? 0, l?.trabalhados ?? 0, l?.pendentes ?? 0) };
        });
        const total = blocos.reduce((s, b) => ({ i: s.i + b.imoveis, t: s.t + b.trabalhados, p: s.p + b.pendentes }), { i: 0, t: 0, p: 0 });
        return [o.id, { total: progresso(total.i, total.t, total.p), blocos }];
      }),
    );
  }

  private atrasada(o: { status: string; openedAt: Date }, dias: number, agora = Date.now()) {
    return o.status === 'ABERTA' && agora - o.openedAt.getTime() > dias * DIA;
  }

  /**
   * O que deriva do ponto do caso (a distância de cada quarteirão até a residência) e o agravo só vão para quem vê o mapa
   * de casos (a vigilância): a distância até as bordas devolve o ponto, e daí o imóvel (Lei 6.259/1975, art. 10; LGPD).
   */
  private veCaso(ctx: RequestContext) {
    return roleHasPermission(ctx.session.role, 'vigilancia.mapa');
  }

  async listar(ctx: RequestContext, q: { situacao?: 'ATIVAS' | 'ENCERRADAS' | 'TODAS' }) {
    const situacao = q.situacao ?? 'ATIVAS';
    const dias = ctx.tenant.settings.endemias.alertaSemInicioDias;
    const include = { blocks: { select: { blockId: true } }, assignees: true, cases: { select: { active: true } } } as const;
    let ordens;
    if (situacao === 'ATIVAS') {
      // As atrasadas (abertas sem início em campo além do prazo) primeiro; depois da mais antiga para a mais nova.
      const atrasadaDesde = new Date(Date.now() - dias * DIA);
      const atrasadas = await ctx.db.blockingOrder.findMany({ where: { status: 'ABERTA', openedAt: { lt: atrasadaDesde } }, include, orderBy: [{ openedAt: 'asc' }, { id: 'asc' }], take: LIMITE_LISTA });
      const demais =
        atrasadas.length < LIMITE_LISTA
          ? await ctx.db.blockingOrder.findMany({
              where: { status: { in: [...ORDEM_ATIVA] }, NOT: { status: 'ABERTA', openedAt: { lt: atrasadaDesde } } },
              include,
              orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
              take: LIMITE_LISTA - atrasadas.length,
            })
          : [];
      ordens = [...atrasadas, ...demais];
    } else
      ordens = await ctx.db.blockingOrder.findMany({
        where: situacao === 'ENCERRADAS' ? { status: { in: ['CONCLUIDA', 'CANCELADA'] } } : {},
        include,
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        take: LIMITE_LISTA,
      });
    const prog = await this.progressos(ctx.db, ordens);
    const nomes = await ctx.db.user.findMany({ where: { id: { in: [...new Set(ordens.flatMap((o) => o.assignees.map((a) => a.userId)))] } }, select: { id: true, name: true } });
    const veCaso = this.veCaso(ctx);
    return ordens.map((o) => ({
      id: o.id,
      numero: numeroOrdem(o),
      status: o.status,
      statusLabel: STATUS_ORDEM_LABEL[o.status as StatusOrdem],
      abertaEm: o.openedAt.toISOString(),
      iniciadaEm: o.startedAt?.toISOString() ?? null,
      concluidaEm: o.concludedAt?.toISOString() ?? null,
      raioM: o.radiusM,
      grupos: veCaso ? o.groups : [],
      casos: o.cases.filter((c) => c.active).length,
      casosDescartados: o.cases.filter((c) => !c.active).length,
      conferirImovel: o.needsCheck,
      atrasada: this.atrasada(o, dias),
      quarteiroes: o.blocks.length,
      agentes: o.assignees.map((a) => ({ id: a.userId, nome: nomes.find((n) => n.id === a.userId)?.name ?? null })),
      progresso: prog.get(o.id)!.total,
    }));
  }

  /** Detalhe da ordem (tela da supervisão e da gestão). Fora da vigilância, a leitura fica na trilha. */
  async detalhe(ctx: RequestContext, id: string) {
    const d = await this.montar(ctx, id);
    if (!this.veCaso(ctx)) await this.audit.recordStandalone(ctx, { action: 'endemias.ordem_ler', entityType: 'BlockingOrder', entityId: id, payload: { numero: d.numero } });
    return d;
  }

  private async montar(ctx: RequestContext, id: string) {
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
    const veCaso = this.veCaso(ctx);
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
      grupos: veCaso ? o.groups : [],
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
            distanciaM: veCaso ? b.distanceM : null,
            ocorrencia: ocorrencia.has(b.blockId),
            geometria: bl?.geometry ?? null,
            centro: bl ? { lat: bl.centerLat, lng: bl.centerLng } : null,
            progresso: prog.blocos.find((x) => x.blockId === b.blockId)!,
          };
        })
        // Fora da vigilância, sem a distância: a ordem também não pode segui-la (entregaria o ranking).
        .sort(
          (a, b) =>
            Number(b.ocorrencia) - Number(a.ocorrencia) ||
            (veCaso ? a.distanciaM! - b.distanciaM! : 0) ||
            a.numero.localeCompare(b.numero, 'pt-BR', { numeric: true }) ||
            (a.localidade ?? '').localeCompare(b.localidade ?? '', 'pt-BR'),
        ),
    };
  }

  /** Cartão da ficha da notificação: a ordem em que o caso está (para quem abre a notificação, com o mesmo sigilo). */
  async daNotificacao(ctx: RequestContext, notificationId: string) {
    await this.notificacoes.acessar(ctx, notificationId, { leitura: true });
    const c = await ctx.db.blockingOrderCase.findUnique({ where: { notificationId }, select: { orderId: true, active: true, unlinkReason: true, lat: true } });
    if (!c) return { ordem: null, caso: null };
    return { ordem: await this.montar(ctx, c.orderId), caso: { ativo: c.active, motivoDesligamento: c.unlinkReason, semPosicao: c.lat == null } };
  }

  private async exigirOrdem(ctx: RequestContext, id: string) {
    const o = await ctx.db.blockingOrder.findUnique({ where: { id } });
    if (!o) throw notFound('Ordem de bloqueio');
    return o;
  }

  /**
   * Agentes que executam a ordem. Só quem entra precisa ser elegível (ACE ou supervisor de campo com lotação ativa e
   * usuário ativo); tirar quem já estava é sempre aceito, mesmo que tenha perdido a lotação.
   */
  async designar(ctx: RequestContext, id: string, userIds: string[]) {
    const agentes = [...new Set(userIds)];
    const o = await this.exigirOrdem(ctx, id);
    if (!ativa(o.status)) throw conflict('Ordem encerrada: reabra antes de mudar os agentes');
    const atuais = new Set((await ctx.db.blockingOrderAssignee.findMany({ where: { orderId: id }, select: { userId: true } })).map((a) => a.userId));
    const entram = agentes.filter((u) => !atuais.has(u));
    const saem = [...atuais].filter((u) => !agentes.includes(u));
    const validos = new Set(await this.elegiveis(ctx.db, entram));
    if (entram.some((u) => !validos.has(u))) throw new DomainError('AGENTE_INVALIDO', 'Só agentes de endemias ou supervisores de campo com lotação ativa (e usuário ativo) podem ser designados', HttpStatus.BAD_REQUEST);
    await ctx.db.$transaction(async (tx) => {
      await tx.blockingOrderAssignee.deleteMany({ where: { orderId: id, userId: { notIn: agentes } } });
      if (entram.length) await tx.blockingOrderAssignee.createMany({ data: entram.map((userId) => ({ orderId: id, userId, assignedBy: ctx.session.userId })), skipDuplicates: true });
      await this.audit.record(ctx, tx, { action: 'endemias.ordem_designar', entityType: 'BlockingOrder', entityId: id, payload: { agentes, entram, saem } });
    });
    this.realtime.emitToEndemias(ctx.tenant.id, 'endemias:ordem', { id });
    return this.montar(ctx, id);
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
    this.realtime.emitToEndemias(ctx.tenant.id, 'endemias:ordem', { id });
    return this.montar(ctx, id);
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
    this.realtime.emitToEndemias(ctx.tenant.id, 'endemias:ordem', { id });
    return this.montar(ctx, id);
  }

  /** Cancelar é decisão da coordenação (ex.: epidemia, com a ação passando a ser por área). */
  async cancelar(ctx: RequestContext, id: string, motivo: string) {
    const o = await this.exigirOrdem(ctx, id);
    if (!ativa(o.status)) throw conflict('A ordem já está encerrada');
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.blockingOrder.updateMany({
        where: { id, status: { in: [...ORDEM_ATIVA] } },
        data: { status: 'CANCELADA', cancelledAt: new Date(), cancelledBy: ctx.session.userId, cancelReason: motivo.trim() },
      });
      if (count !== 1) throw conflict('A ordem mudou enquanto você cancelava; abra de novo');
      await this.audit.record(ctx, tx, { action: 'endemias.ordem_cancelar', entityType: 'BlockingOrder', entityId: id, payload: { numero: numeroOrdem(o), motivo: motivo.trim() } });
    });
    this.realtime.emitToEndemias(ctx.tenant.id, 'endemias:ordem', { id });
    return this.montar(ctx, id);
  }

  /** Refaz os quarteirões (a malha mudou) e reavalia os casos, sob a mesma trava do gatilho. */
  async recalcularManual(ctx: RequestContext, id: string) {
    await this.exigirOrdem(ctx, id);
    const casos = await ctx.db.blockingOrderCase.findMany({ where: { orderId: id }, select: { notificationId: true } });
    for (const c of casos) await this.avaliar(ctx, c.notificationId);
    await this.comTrava(ctx.db, async (tx) => {
      const o = await tx.blockingOrder.findUniqueOrThrow({ where: { id } });
      if (ativa(o.status)) await this.recalcular(tx, id);
      await this.audit.record(ctx, tx, { action: 'endemias.ordem_recalcular', entityType: 'BlockingOrder', entityId: id, payload: { numero: numeroOrdem(o) } });
    });
    this.realtime.emitToEndemias(ctx.tenant.id, 'endemias:ordem', { id });
    return this.montar(ctx, id);
  }
}
