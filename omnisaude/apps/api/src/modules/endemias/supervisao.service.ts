import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { tenantSettings, type EndemiasSettings, type MasterClient } from '@omnisaude/database';
import {
  ATIVIDADE_INFO,
  ATIVIDADES_INDICE,
  ATIVIDADES_VETORIAIS,
  cicloBimestral,
  fromZonedParts,
  indicesDaContagem,
  localDateString,
  positividadeAtividade,
  progresso,
  SITUACAO_INFO,
  TIPO_IMOVEL,
  TIPOS_DEPOSITO,
  type AtividadeVetorial,
  type ContagemIndices,
  type Depositos,
  type SituacaoVisita,
  type TipoDeposito,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { MASTER_DB, TenantsService } from '../../core/database';
import { conflict, DomainError, notFound } from '../../core/errors';
import { TerritorioService } from '../territorio/territorio.service';

const DIA = 86_400_000;
const inicioDoDia = (iso: string, tz: string) => fromZonedParts({ year: +iso.slice(0, 4), month: +iso.slice(5, 7), day: +iso.slice(8, 10), hour: 0, minute: 0, second: 0 }, tz);
const diaSeguinte = (iso: string) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + 1)).toISOString().slice(0, 10);
const endereco = (h: { street: string | null; number: string | null; complement?: string | null } | undefined) => (h ? [h.street, h.number, h.complement].filter(Boolean).join(', ') || 'Sem endereço' : null);
/** Dias de calendário entre duas datas AAAA-MM-DD. */
const diasEntre = (a: string, b: string) => Math.abs(Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / DIA;

/** Teto da lista de pendências: os imóveis com a última visita mais recente. */
export const MAX_PENDENCIAS = 2000;

/**
 * "Ausência" da Lei 13.301/2016 (art. 1º, § 2º, II): duas visitas com o imóvel fechado, em dias e períodos (turnos)
 * alternados, dentro do intervalo de dez dias. Recusa (§ 2º, III) e abandono (§ 2º, I) são outras hipóteses e não
 * contam. A lei pede visitas "devidamente comunicadas": o aviso prévio não é registrado aqui e fica a cargo da equipe.
 */
function ausenciaComprovada(fechamentos: { dia: string; turno: number }[]) {
  return fechamentos.some((a, i) => fechamentos.slice(i + 1).some((b) => a.dia !== b.dia && a.turno !== b.turno && diasEntre(a.dia, b.dia) <= 10));
}

interface LinhaPendencia {
  imovelId: string;
  situacao: SituacaoVisita;
  ultimaEm: string;
  ordemId: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  tipoImovel: string | null;
  sequencia: string | null;
  quarteirao: string | null;
  agente: string | null;
  tentativas: number;
  fechados: number;
  recusas: number;
  diasFechado: string[] | null;
  turnosFechado: number[] | null;
}

interface LinhaResumo {
  agenteId: string | null;
  total: boolean;
  visitas: number;
  trabalhados: number;
  fechados: number;
  recusados: number;
  abandonados: number;
  recuperados: number;
  imoveisComFoco: number;
  depositosInspecionados: number;
  depositosComFoco: number;
  depositosEliminados: number;
  depositosTratados: number;
  amostras: number;
  nebulizados: number;
}

type LinhaIndice = { localidadeId: string | null; total: boolean; imoveisInspecionados: number; imoveisComFoco: number; depositosInspecionados: number; depositosComFoco: number } & Record<TipoDeposito, number>;

/**
 * Supervisão de campo das endemias (VIG-3a): zonas de trabalho dos ACE (conjunto de quarteirões), visitas registradas,
 * pendências dos imóveis (fechados, recusados, abandonados) com as tentativas, produção por agente com os índices
 * larvários preliminares e a configuração do bloqueio.
 */
@Injectable()
export class SupervisaoEndemiasService {
  constructor(
    private readonly audit: AuditService,
    private readonly territorio: TerritorioService,
    @Inject(MASTER_DB) private readonly master: MasterClient,
    private readonly tenants: TenantsService,
  ) {}

  /** ACE e supervisores de campo com lotação ativa (para designar zonas e ordens). */
  async agentes(ctx: RequestContext) {
    const lot = await ctx.db.userAssignment.findMany({
      where: { active: true, role: { in: ['ACE', 'SUPERVISOR_ENDEMIAS'] }, user: { active: true } },
      include: { user: { select: { id: true, name: true } }, unit: { select: { name: true } } },
      orderBy: { user: { name: 'asc' } },
    });
    const vistos = new Map<string, { id: string; nome: string; papeis: string[]; unidades: string[] }>();
    for (const l of lot) {
      const a = vistos.get(l.userId) ?? { id: l.userId, nome: l.user.name, papeis: [], unidades: [] };
      if (!a.papeis.includes(l.role)) a.papeis.push(l.role);
      if (!a.unidades.includes(l.unit.name)) a.unidades.push(l.unit.name);
      vistos.set(l.userId, a);
    }
    return [...vistos.values()];
  }

  // ─── Zonas ─────────────────────────────────────────────────────────────────

  async zonas(ctx: RequestContext) {
    const ciclo = cicloBimestral(localDateString(new Date(), ctx.tenant.timeZone));
    const zonas = await ctx.db.vectorZone.findMany({ include: { blocks: true }, orderBy: [{ active: 'desc' }, { name: 'asc' }] });
    const blockIds = zonas.flatMap((z) => z.blocks.map((b) => b.blockId));
    const [contagem, visitas, blocos, ace] = await Promise.all([
      blockIds.length ? ctx.db.household.groupBy({ by: ['blockId'], where: { blockId: { in: blockIds }, active: true }, _count: { _all: true } }) : [],
      blockIds.length ? ctx.db.vectorVisit.findMany({ where: { blockId: { in: blockIds }, cycle: ciclo.chave }, select: { householdId: true, blockId: true, situation: true }, orderBy: { visitedAt: 'asc' } }) : [],
      ctx.db.block.findMany({ where: { id: { in: blockIds } }, select: { id: true, number: true, active: true } }),
      ctx.db.user.findMany({ where: { id: { in: zonas.map((z) => z.aceId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    ]);
    const ultima = new Map<string, { blockId: string | null; situation: SituacaoVisita }>();
    for (const v of visitas) ultima.set(v.householdId, { blockId: v.blockId, situation: v.situation });
    return {
      ciclo,
      zonas: zonas.map((z) => {
        const ids = new Set(z.blocks.map((b) => b.blockId));
        const imoveis = contagem.filter((c) => ids.has(c.blockId!)).reduce((s, c) => s + c._count._all, 0);
        const doCiclo = [...ultima.values()].filter((v) => v.blockId && ids.has(v.blockId));
        const pendentes = doCiclo.filter((v) => SITUACAO_INFO[v.situation].pendencia).length;
        return {
          id: z.id,
          nome: z.name,
          ativa: z.active,
          observacao: z.notes,
          agente: z.aceId ? { id: z.aceId, nome: ace.find((a) => a.id === z.aceId)?.name ?? null } : null,
          quarteiroes: blocos.filter((b) => ids.has(b.id)).map((b) => ({ id: b.id, numero: b.number, ativo: b.active })),
          progressoCiclo: progresso(Math.max(imoveis, doCiclo.length), doCiclo.length - pendentes, pendentes),
        };
      }),
    };
  }

  /** Quarteirões ativos sem zona (para montar as zonas). */
  async quarteiroesLivres(ctx: RequestContext) {
    const blocos = await ctx.db.block.findMany({
      where: { active: true, NOT: { id: { in: (await ctx.db.vectorZoneBlock.findMany({ select: { blockId: true } })).map((b) => b.blockId) } } },
      select: { id: true, number: true, localityId: true, neighborhoodId: true },
      take: 5000,
    });
    return (await this.territorio.comNomes(ctx, blocos))
      .map((b) => ({ id: b.id, numero: b.number, localidade: b.localidade?.name ?? null, bairro: b.bairro, imoveis: b.imoveis }))
      .sort((a, b) => (a.localidade ?? '').localeCompare(b.localidade ?? '') || a.numero.localeCompare(b.numero, 'pt-BR', { numeric: true }));
  }

  async salvarZona(ctx: RequestContext, id: string | null, input: { nome: string; aceId?: string | null; quarteiroes: string[]; ativa?: boolean; observacao?: string | null }) {
    const nome = input.nome.trim();
    const blocos = [...new Set(input.quarteiroes)];
    const atual = id ? await ctx.db.vectorZone.findUnique({ where: { id } }) : null;
    if (id && !atual) throw notFound('Zona');
    // Só o titular novo precisa estar apto (usuário ativo com lotação de campo ativa). O atual, mesmo sem lotação, fica
    // até a supervisão trocá-lo: editar o nome ou os quarteirões não obriga a trocar o titular na hora.
    if (input.aceId && input.aceId !== atual?.aceId && !(await ctx.db.userAssignment.count({ where: { userId: input.aceId, active: true, role: { in: ['ACE', 'SUPERVISOR_ENDEMIAS'] }, user: { active: true } } })))
      throw new DomainError('AGENTE_INVALIDO', 'O titular da zona precisa ser agente de endemias (ou supervisor de campo) ativo, com lotação ativa', HttpStatus.BAD_REQUEST);
    // Como o titular, só o quarteirão que ENTRA na zona é conferido (existe e está ativo na malha). O que já estava nela e
    // foi desativado depois fica até a supervisão tirá-lo (a lista das zonas o mostra como desativado), como ficaria sem
    // a edição: renomear a zona ou mexer nos outros quarteirões não obriga a tirá-lo, e o que sai não volta desativado.
    const jaNaZona = atual ? new Set((await ctx.db.vectorZoneBlock.findMany({ where: { zoneId: atual.id }, select: { blockId: true } })).map((b) => b.blockId)) : new Set<string>();
    const entram = blocos.filter((b) => !jaNaZona.has(b));
    if (entram.length && (await ctx.db.block.count({ where: { id: { in: entram }, active: true } })) !== entram.length)
      throw new DomainError('QUARTEIRAO_INVALIDO', 'Algum quarteirão não existe ou foi desativado', HttpStatus.BAD_REQUEST);
    const ocupados = await ctx.db.vectorZoneBlock.findMany({ where: { blockId: { in: blocos }, ...(id ? { zoneId: { not: id } } : {}) }, include: { zone: { select: { name: true } } } });
    if (ocupados.length) {
      const numeros = await ctx.db.block.findMany({ where: { id: { in: ocupados.map((o) => o.blockId) } }, select: { id: true, number: true } });
      throw conflict(`Quarteirão já em outra zona: ${ocupados.map((o) => `${numeros.find((n) => n.id === o.blockId)?.number ?? '?'} (${o.zone.name})`).join(', ')}`);
    }
    try {
      const zona = await ctx.db.$transaction(async (tx) => {
        const z = atual
          ? await tx.vectorZone.update({ where: { id: atual.id }, data: { name: nome, aceId: input.aceId ?? null, active: input.ativa ?? atual.active, notes: input.observacao?.trim() || null } })
          : await tx.vectorZone.create({ data: { unitId: ctx.session.unitId, name: nome, aceId: input.aceId ?? null, notes: input.observacao?.trim() || null, createdBy: ctx.session.userId } });
        await tx.vectorZoneBlock.deleteMany({ where: { zoneId: z.id, blockId: { notIn: blocos } } });
        await tx.vectorZoneBlock.createMany({ data: blocos.map((blockId) => ({ zoneId: z.id, blockId })), skipDuplicates: true });
        await this.audit.record(ctx, tx, {
          action: atual ? 'endemias.zona_alterar' : 'endemias.zona_criar',
          entityType: 'VectorZone',
          entityId: z.id,
          payload: { nome, agente: input.aceId ?? null, quarteiroes: blocos.length },
        });
        return z;
      });
      return { id: zona.id };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw conflict(`Já existe uma zona ativa com o nome ${nome}`);
      throw err;
    }
  }

  // ─── Visitas e pendências ──────────────────────────────────────────────────

  async visitas(ctx: RequestContext, q: { de: string; ate: string; agenteId?: string; situacao?: SituacaoVisita; ordemId?: string; quarteiraoId?: string }) {
    const tz = ctx.tenant.timeZone;
    const rows = await ctx.db.vectorVisit.findMany({
      where: {
        visitedAt: { gte: inicioDoDia(q.de, tz), lt: inicioDoDia(diaSeguinte(q.ate), tz) },
        ...(q.agenteId ? { userId: q.agenteId } : {}),
        ...(q.situacao ? { situation: q.situacao } : {}),
        ...(q.ordemId ? { orderId: q.ordemId } : {}),
        ...(q.quarteiraoId ? { blockId: q.quarteiraoId } : {}),
      },
      include: { treatments: { include: { product: { select: { description: true, unit: true } } } }, order: { select: { seq: true, year: true } } },
      orderBy: { visitedAt: 'desc' },
      take: 500,
    });
    const [imoveis, agentes, blocos] = await Promise.all([
      ctx.db.household.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.householdId))] } }, select: { id: true, street: true, number: true, complement: true, rgSequence: true } }),
      ctx.db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, name: true } }),
      ctx.db.block.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.blockId).filter((x): x is string => !!x))] } }, select: { id: true, number: true } }),
    ]);
    return rows.map((r) => ({
      id: r.id,
      visitadaEm: r.visitedAt.toISOString(),
      sincronizadaEm: r.syncedAt.toISOString(),
      agente: agentes.find((a) => a.id === r.userId)?.name ?? null,
      agenteId: r.userId,
      imovelId: r.householdId,
      imovel: endereco(imoveis.find((i) => i.id === r.householdId)),
      sequencia: imoveis.find((i) => i.id === r.householdId)?.rgSequence ?? null,
      quarteirao: blocos.find((b) => b.id === r.blockId)?.number ?? null,
      tipo: TIPO_IMOVEL[r.propertyType] ?? r.propertyType,
      atividade: r.activity,
      atividadeLabel: ATIVIDADE_INFO[r.activity as AtividadeVetorial].sigla,
      situacao: r.situation,
      situacaoLabel: SITUACAO_INFO[r.situation].label,
      recuperacao: r.recovery,
      ordem: r.order ? `${r.order.seq}/${r.order.year}` : null,
      depositos: r.deposits as Depositos | null,
      inspecionados: r.depositsInspected,
      comFoco: r.depositsPositive,
      eliminados: r.depositsEliminated,
      tratados: r.depositsTreated,
      amostras: r.samplesCount,
      ubv: r.ubv,
      acaoEducativa: r.education,
      observacao: r.notes,
      tratamentos: r.treatments.map((t) => ({
        produto: t.product.description,
        unidade: t.product.unit,
        lote: t.lotNumber,
        quantidade: Number(t.quantity),
        depositos: t.deposits,
        estoque: t.stockStatus,
        vencido: t.expiredAtUse,
      })),
    }));
  }

  /**
   * Imóveis com pendência no ciclo atual ou numa ordem ativa (a última visita foi fechado, recusado ou abandonado), com
   * as tentativas desde a última visita trabalhada. A conta é toda no banco, sobre todas as visitas do ciclo e das ordens
   * ativas; a saída traz até MAX_PENDENCIAS imóveis, os de última visita mais recente primeiro. A "ausência" da Lei
   * 13.301/2016 (art. 1º, § 2º, II) só autoriza o ingresso forçado com emergência declarada (ESPIN); fora dela, vale o
   * código de posturas do município.
   */
  async pendencias(ctx: RequestContext) {
    const tz = ctx.tenant.timeZone;
    const ciclo = cicloBimestral(localDateString(new Date(), tz));
    const ativas = (await ctx.db.blockingOrder.findMany({ where: { status: { in: ['ABERTA', 'EM_CAMPO'] } }, select: { id: true } })).map((o) => o.id);
    const linhas = await ctx.db.$queryRaw<LinhaPendencia[]>`
      WITH v0 AS (
        -- ordem 1 é a última visita do imóvel.
        SELECT id, household_id, situation::text AS situacao, visited_at, turno, user_id, block_id, order_id,
          row_number() OVER (PARTITION BY household_id ORDER BY visited_at DESC, id DESC) AS ordem
        FROM vector_visits
        WHERE cycle = ${ciclo.chave} OR order_id = ANY(${ativas}::uuid[])
      ),
      v AS (
        SELECT *, min(ordem) FILTER (WHERE situacao = 'TRABALHADO') OVER (PARTITION BY household_id) AS ordem_trabalhado
        FROM v0
      ),
      pendentes AS (
        SELECT household_id, situacao, visited_at, user_id, block_id, order_id
        FROM v WHERE ordem = 1 AND situacao <> 'TRABALHADO'
        ORDER BY visited_at DESC, household_id LIMIT ${MAX_PENDENCIAS}
      ),
      tentativas AS (
        SELECT household_id, count(*)::int AS tentativas,
          (count(*) FILTER (WHERE situacao = 'FECHADO'))::int AS fechados,
          (count(*) FILTER (WHERE situacao = 'RECUSADO'))::int AS recusas,
          array_agg(((visited_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz})::date::text ORDER BY visited_at) FILTER (WHERE situacao = 'FECHADO') AS "diasFechado",
          array_agg(turno ORDER BY visited_at) FILTER (WHERE situacao = 'FECHADO') AS "turnosFechado"
        FROM v
        WHERE situacao <> 'TRABALHADO' AND (ordem_trabalhado IS NULL OR ordem < ordem_trabalhado) AND household_id IN (SELECT household_id FROM pendentes)
        GROUP BY household_id
      )
      SELECT p.household_id AS "imovelId", p.situacao, to_char(p.visited_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "ultimaEm", p.order_id AS "ordemId",
        h.street, h.number, h.complement, h.property_type AS "tipoImovel", h.rg_sequence AS sequencia, b.number AS quarteirao, u.name AS agente,
        t.tentativas, t.fechados, t.recusas, t."diasFechado", t."turnosFechado"
      FROM pendentes p
      JOIN tentativas t ON t.household_id = p.household_id
      LEFT JOIN households h ON h.id = p.household_id
      LEFT JOIN blocks b ON b.id = p.block_id
      LEFT JOIN users u ON u.id = p.user_id
      ORDER BY p.visited_at DESC, p.household_id`;
    return linhas.map((l) => {
      const dias = l.diasFechado ?? [];
      const turnos = l.turnosFechado ?? [];
      return {
        imovelId: l.imovelId,
        imovel: endereco(l),
        sequencia: l.sequencia,
        tipo: TIPO_IMOVEL[l.tipoImovel ?? '01'] ?? 'Outros',
        quarteirao: l.quarteirao,
        situacao: l.situacao,
        situacaoLabel: SITUACAO_INFO[l.situacao].label,
        ultimaEm: l.ultimaEm,
        agente: l.agente,
        tentativas: l.tentativas,
        fechados: l.fechados,
        recusas: l.recusas,
        naOrdem: !!l.ordemId,
        // Só com o imóvel ainda fechado: se depois alguém foi achado e recusou, a hipótese passa a ser a recusa.
        ausenciaDocumentada: l.situacao === 'FECHADO' && ausenciaComprovada(dias.map((dia, i) => ({ dia, turno: Number(turnos[i]) }))),
      };
    });
  }

  // ─── Produção e índices ────────────────────────────────────────────────────

  /**
   * Produção do período por agente e por localidade, toda agregada no banco (sem limite de visitas). O resumo conta as
   * visitas de todas as atividades, como os boletins de campo; "imóveis com foco" são imóveis distintos com foco em
   * qualquer atividade. Os índices (IIP, IB, IR, ITR) são só do levantamento, LI e LI+T: de cada imóvel, a última visita
   * trabalhada dessas atividades no período. As outras atividades com visita no período têm a positividade à parte.
   */
  async producao(ctx: RequestContext, q: { de: string; ate: string }) {
    const tz = ctx.tenant.timeZone;
    // visited_at é timestamp sem fuso, gravado em UTC: o texto ISO convertido em timestamp não depende do fuso da sessão.
    const de = inicioDoDia(q.de, tz).toISOString();
    const ate = inicioDoDia(diaSeguinte(q.ate), tz).toISOString();
    const levantamento = [...ATIVIDADES_INDICE];
    const [resumos, larvicidas, contagens, outras, visitasPorLocalidade] = await Promise.all([
      ctx.db.$queryRaw<LinhaResumo[]>`
        SELECT user_id AS "agenteId", GROUPING(user_id) = 1 AS total, count(*)::int AS visitas,
          (count(*) FILTER (WHERE situation = 'TRABALHADO'))::int AS trabalhados,
          (count(*) FILTER (WHERE situation = 'FECHADO'))::int AS fechados,
          (count(*) FILTER (WHERE situation = 'RECUSADO'))::int AS recusados,
          (count(*) FILTER (WHERE situation = 'ABANDONADO'))::int AS abandonados,
          (count(*) FILTER (WHERE recovery AND situation = 'TRABALHADO'))::int AS recuperados,
          (count(DISTINCT household_id) FILTER (WHERE deposits_positive > 0))::int AS "imoveisComFoco",
          coalesce(sum(deposits_inspected), 0)::int AS "depositosInspecionados",
          coalesce(sum(deposits_positive), 0)::int AS "depositosComFoco",
          coalesce(sum(deposits_eliminated), 0)::int AS "depositosEliminados",
          coalesce(sum(deposits_treated), 0)::int AS "depositosTratados",
          coalesce(sum(samples_count), 0)::int AS amostras,
          (count(*) FILTER (WHERE coalesce(ubv, '') <> ''))::int AS nebulizados
        FROM vector_visits
        WHERE visited_at >= ${de}::timestamp AND visited_at < ${ate}::timestamp
        GROUP BY GROUPING SETS ((user_id), ())`,
      ctx.db.$queryRaw<{ agenteId: string | null; total: boolean; produtoId: string; quantidade: number }[]>`
        SELECT v.user_id AS "agenteId", GROUPING(v.user_id) = 1 AS total, t.product_id AS "produtoId", sum(t.quantity)::float8 AS quantidade
        FROM vector_treatments t JOIN vector_visits v ON v.id = t.visit_id
        WHERE v.visited_at >= ${de}::timestamp AND v.visited_at < ${ate}::timestamp AND t.stock_status <> 'CANCELADO'
        GROUP BY GROUPING SETS ((v.user_id, t.product_id), (t.product_id))`,
      ctx.db.$queryRaw<LinhaIndice[]>`
        WITH ultima AS (
          SELECT DISTINCT ON (household_id) household_id, block_id, deposits, deposits_inspected, deposits_positive
          FROM vector_visits
          WHERE visited_at >= ${de}::timestamp AND visited_at < ${ate}::timestamp AND situation = 'TRABALHADO' AND activity::text = ANY(${levantamento}::text[])
          ORDER BY household_id, visited_at DESC, id DESC
        )
        SELECT b.locality_id AS "localidadeId", GROUPING(b.locality_id) = 1 AS total, count(*)::int AS "imoveisInspecionados",
          (count(*) FILTER (WHERE u.deposits_positive > 0))::int AS "imoveisComFoco",
          coalesce(sum(u.deposits_inspected), 0)::int AS "depositosInspecionados",
          coalesce(sum(u.deposits_positive), 0)::int AS "depositosComFoco",
          coalesce(sum((u.deposits->'A1'->>'comFoco')::int), 0)::int AS "A1",
          coalesce(sum((u.deposits->'A2'->>'comFoco')::int), 0)::int AS "A2",
          coalesce(sum((u.deposits->'B'->>'comFoco')::int), 0)::int AS "B",
          coalesce(sum((u.deposits->'C'->>'comFoco')::int), 0)::int AS "C",
          coalesce(sum((u.deposits->'D1'->>'comFoco')::int), 0)::int AS "D1",
          coalesce(sum((u.deposits->'D2'->>'comFoco')::int), 0)::int AS "D2",
          coalesce(sum((u.deposits->'E'->>'comFoco')::int), 0)::int AS "E"
        FROM ultima u LEFT JOIN blocks b ON b.id = u.block_id
        GROUP BY GROUPING SETS ((b.locality_id), ())`,
      ctx.db.$queryRaw<{ atividade: AtividadeVetorial; inspecionados: number; comFoco: number }[]>`
        SELECT activity::text AS atividade,
          (count(DISTINCT household_id) FILTER (WHERE situation = 'TRABALHADO'))::int AS inspecionados,
          (count(DISTINCT household_id) FILTER (WHERE situation = 'TRABALHADO' AND deposits_positive > 0))::int AS "comFoco"
        FROM vector_visits
        WHERE visited_at >= ${de}::timestamp AND visited_at < ${ate}::timestamp AND NOT (activity::text = ANY(${levantamento}::text[]))
        GROUP BY activity`,
      ctx.db.$queryRaw<{ localidadeId: string; visitas: number }[]>`
        SELECT b.locality_id AS "localidadeId", count(*)::int AS visitas
        FROM vector_visits v JOIN blocks b ON b.id = v.block_id
        WHERE v.visited_at >= ${de}::timestamp AND v.visited_at < ${ate}::timestamp
        GROUP BY b.locality_id`,
    ]);
    const unicos = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
    const [agentes, produtos, localidades] = await Promise.all([
      ctx.db.user.findMany({ where: { id: { in: unicos(resumos.map((r) => r.agenteId)) } }, select: { id: true, name: true } }),
      ctx.db.product.findMany({ where: { id: { in: unicos(larvicidas.map((l) => l.produtoId)) } }, select: { id: true, description: true, unit: true } }),
      ctx.db.locality.findMany({ where: { id: { in: unicos(visitasPorLocalidade.map((l) => l.localidadeId)) } }, select: { id: true, code: true, name: true } }),
    ]);
    const larvicida = (agenteId: string | null) =>
      larvicidas
        .filter((l) => (agenteId === null ? l.total : !l.total && l.agenteId === agenteId))
        .map((l) => {
          const p = produtos.find((x) => x.id === l.produtoId);
          return { produto: p?.description ?? '—', unidade: p?.unit ?? '', quantidade: Math.round(Number(l.quantidade) * 1000) / 1000 };
        })
        .sort((a, b) => a.produto.localeCompare(b.produto, 'pt-BR'));
    const resumo = (r: LinhaResumo | undefined, agenteId: string | null) => ({
      visitas: r?.visitas ?? 0,
      trabalhados: r?.trabalhados ?? 0,
      fechados: r?.fechados ?? 0,
      recusados: r?.recusados ?? 0,
      abandonados: r?.abandonados ?? 0,
      recuperados: r?.recuperados ?? 0,
      imoveisComFoco: r?.imoveisComFoco ?? 0,
      depositosInspecionados: r?.depositosInspecionados ?? 0,
      depositosComFoco: r?.depositosComFoco ?? 0,
      depositosEliminados: r?.depositosEliminados ?? 0,
      depositosTratados: r?.depositosTratados ?? 0,
      amostras: r?.amostras ?? 0,
      nebulizados: r?.nebulizados ?? 0,
      larvicida: larvicida(agenteId),
    });
    const contagem = (l: LinhaIndice | undefined): ContagemIndices => ({
      imoveisInspecionados: l?.imoveisInspecionados ?? 0,
      imoveisComFoco: l?.imoveisComFoco ?? 0,
      depositosInspecionados: l?.depositosInspecionados ?? 0,
      depositosComFoco: l?.depositosComFoco ?? 0,
      focoPorTipo: Object.fromEntries(TIPOS_DEPOSITO.map((t) => [t, l?.[t] ?? 0])),
    });
    // Na ordem das atividades (T, bloqueio, PE, DF, PVE), só as que tiveram visita no período.
    const positividade = ATIVIDADES_VETORIAIS.flatMap((a) => {
      const o = ATIVIDADES_INDICE.includes(a) ? undefined : outras.find((x) => x.atividade === a);
      return o ? [positividadeAtividade(a, o.inspecionados, o.comFoco)] : [];
    });
    return {
      periodo: { de: q.de, ate: q.ate },
      total: {
        ...resumo(
          resumos.find((r) => r.total),
          null,
        ),
        indices: indicesDaContagem(contagem(contagens.find((c) => c.total))),
        positividade,
      },
      agentes: resumos
        .filter((r): r is LinhaResumo & { agenteId: string } => !r.total && !!r.agenteId)
        .map((r) => ({ id: r.agenteId, nome: agentes.find((a) => a.id === r.agenteId)?.name ?? null, ...resumo(r, r.agenteId) }))
        .sort((a, b) => b.trabalhados - a.trabalhados || (a.nome ?? '').localeCompare(b.nome ?? '', 'pt-BR')),
      localidades: localidades
        .map((l) => ({
          id: l.id,
          codigo: l.code,
          nome: l.name,
          visitas: visitasPorLocalidade.find((x) => x.localidadeId === l.id)?.visitas ?? 0,
          indices: indicesDaContagem(contagem(contagens.find((c) => !c.total && c.localidadeId === l.id))),
        }))
        .sort((a, b) => a.codigo.localeCompare(b.codigo, 'pt-BR', { numeric: true })),
    };
  }

  // ─── Configuração ─────────────────────────────────────────────────────────

  config(ctx: RequestContext) {
    return { ...ctx.tenant.settings.endemias, raioBloqueioM: ctx.tenant.settings.territorio.raioBloqueioM };
  }

  async salvarConfig(ctx: RequestContext, input: Partial<EndemiasSettings>) {
    const t = await this.master.tenant.findUniqueOrThrow({ where: { id: ctx.tenant.id } });
    const atual = tenantSettings(t.settings).endemias;
    const endemias: EndemiasSettings = {
      bloqueioAutomatico: input.bloqueioAutomatico ?? atual.bloqueioAutomatico,
      janelaAgrupamentoDias: input.janelaAgrupamentoDias ?? atual.janelaAgrupamentoDias,
      gruposBloqueio: input.gruposBloqueio ?? atual.gruposBloqueio,
      alertaSemInicioDias: input.alertaSemInicioDias ?? atual.alertaSemInicioDias,
    };
    if (!endemias.gruposBloqueio.length) throw new DomainError('SEM_GRUPO', 'Escolha ao menos um agravo para o bloqueio', HttpStatus.BAD_REQUEST);
    await this.master.$executeRaw`UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{endemias}', ${JSON.stringify(endemias)}::jsonb) WHERE id = ${ctx.tenant.id}::uuid`;
    this.tenants.connections.invalidate(ctx.tenant.slug);
    this.tenants.connections.invalidate(ctx.tenant.id);
    await this.audit.recordStandalone(ctx, { action: 'endemias.configuracoes', entityType: 'Tenant', entityId: ctx.tenant.id, payload: endemias });
    return { ...endemias, raioBloqueioM: ctx.tenant.settings.territorio.raioBloqueioM };
  }
}
