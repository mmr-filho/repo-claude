import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { tenantSettings, type EndemiasSettings, type MasterClient } from '@omnisaude/database';
import { ATIVIDADE_INFO, cicloBimestral, fromZonedParts, indicesLarvarios, localDateString, progresso, SITUACAO_INFO, TIPO_IMOVEL, type AtividadeVetorial, type Depositos, type SituacaoVisita } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { MASTER_DB, TenantsService } from '../../core/database';
import { conflict, DomainError, notFound } from '../../core/errors';
import { TerritorioService } from '../territorio/territorio.service';

const DIA = 86_400_000;
const inicioDoDia = (iso: string, tz: string) => fromZonedParts({ year: +iso.slice(0, 4), month: +iso.slice(5, 7), day: +iso.slice(8, 10), hour: 0, minute: 0, second: 0 }, tz);
const diaSeguinte = (iso: string) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + 1)).toISOString().slice(0, 10);
const endereco = (h: { street: string | null; number: string | null; complement?: string | null } | undefined) => (h ? [h.street, h.number, h.complement].filter(Boolean).join(', ') || 'Sem endereço' : null);

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
    if (input.aceId && !(await ctx.db.userAssignment.count({ where: { userId: input.aceId, active: true, role: { in: ['ACE', 'SUPERVISOR_ENDEMIAS'] } } })))
      throw new DomainError('AGENTE_INVALIDO', 'O titular da zona precisa ser agente de endemias (ou supervisor de campo) com lotação ativa', HttpStatus.BAD_REQUEST);
    if (blocos.length && (await ctx.db.block.count({ where: { id: { in: blocos }, active: true } })) !== blocos.length)
      throw new DomainError('QUARTEIRAO_INVALIDO', 'Algum quarteirão não existe ou foi desativado', HttpStatus.BAD_REQUEST);
    const atual = id ? await ctx.db.vectorZone.findUnique({ where: { id } }) : null;
    if (id && !atual) throw notFound('Zona');
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
   * as tentativas. Duas tentativas em dias e turnos diferentes em até 10 dias documentam a "ausência" da Lei 13.301/2016
   * (art. 1º, § 2º, II), que só autoriza o ingresso forçado com emergência declarada (ESPIN); fora dela, vale o código de
   * posturas do município.
   */
  async pendencias(ctx: RequestContext) {
    const ciclo = cicloBimestral(localDateString(new Date(), ctx.tenant.timeZone));
    const ativas = await ctx.db.blockingOrder.findMany({ where: { status: { in: ['ABERTA', 'EM_CAMPO'] } }, select: { id: true } });
    const visitas = await ctx.db.vectorVisit.findMany({
      where: { OR: [{ cycle: ciclo.chave }, ...(ativas.length ? [{ orderId: { in: ativas.map((a) => a.id) } }] : [])] },
      select: { householdId: true, situation: true, visitedAt: true, turno: true, userId: true, blockId: true, orderId: true },
      orderBy: { visitedAt: 'asc' },
      take: 20_000,
    });
    const porImovel = new Map<string, typeof visitas>();
    for (const v of visitas) porImovel.set(v.householdId, [...(porImovel.get(v.householdId) ?? []), v]);
    const pendentes = [...porImovel.entries()].filter(([, vs]) => SITUACAO_INFO[vs.at(-1)!.situation].pendencia);
    const [imoveis, agentes, blocos] = await Promise.all([
      ctx.db.household.findMany({ where: { id: { in: pendentes.map(([id]) => id) } }, select: { id: true, street: true, number: true, complement: true, propertyType: true, rgSequence: true } }),
      ctx.db.user.findMany({ where: { id: { in: [...new Set(pendentes.flatMap(([, vs]) => vs.map((v) => v.userId)))] } }, select: { id: true, name: true } }),
      ctx.db.block.findMany({ where: { id: { in: [...new Set(pendentes.map(([, vs]) => vs.at(-1)!.blockId).filter((x): x is string => !!x))] } }, select: { id: true, number: true } }),
    ]);
    const tz = ctx.tenant.timeZone;
    return pendentes
      .map(([id, vs]) => {
        const ultima = vs.at(-1)!;
        const tentativas = vs.filter((v) => SITUACAO_INFO[v.situation].pendencia && v.situation !== 'ABANDONADO');
        const recentes = tentativas.filter((v) => ultima.visitedAt.getTime() - v.visitedAt.getTime() <= 10 * DIA);
        const dias = new Set(recentes.map((v) => localDateString(v.visitedAt, tz)));
        const turnos = new Set(recentes.map((v) => v.turno));
        const h = imoveis.find((i) => i.id === id);
        return {
          imovelId: id,
          imovel: endereco(h),
          sequencia: h?.rgSequence ?? null,
          tipo: TIPO_IMOVEL[h?.propertyType ?? '01'] ?? 'Outros',
          quarteirao: blocos.find((b) => b.id === ultima.blockId)?.number ?? null,
          situacao: ultima.situation,
          situacaoLabel: SITUACAO_INFO[ultima.situation].label,
          ultimaEm: ultima.visitedAt.toISOString(),
          agente: agentes.find((a) => a.id === ultima.userId)?.name ?? null,
          tentativas: vs.filter((v) => SITUACAO_INFO[v.situation].pendencia).length,
          naOrdem: !!ultima.orderId,
          ausenciaDocumentada: ultima.situation !== 'ABANDONADO' && dias.size >= 2 && turnos.size >= 2,
        };
      })
      .sort((a, b) => b.tentativas - a.tentativas || a.ultimaEm.localeCompare(b.ultimaEm));
  }

  // ─── Produção e índices ────────────────────────────────────────────────────

  async producao(ctx: RequestContext, q: { de: string; ate: string }) {
    const tz = ctx.tenant.timeZone;
    const rows = await ctx.db.vectorVisit.findMany({
      where: { visitedAt: { gte: inicioDoDia(q.de, tz), lt: inicioDoDia(diaSeguinte(q.ate), tz) } },
      select: {
        id: true,
        userId: true,
        householdId: true,
        blockId: true,
        situation: true,
        recovery: true,
        deposits: true,
        depositsInspected: true,
        depositsPositive: true,
        depositsEliminated: true,
        depositsTreated: true,
        samplesCount: true,
        ubv: true,
        visitedAt: true,
      },
      orderBy: { visitedAt: 'asc' },
      take: 50_000,
    });
    const [agentes, tratamentos, blocos] = await Promise.all([
      ctx.db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, name: true } }),
      rows.length
        ? ctx.db.vectorTreatment.findMany({
            where: { visitId: { in: rows.map((r) => r.id) }, stockStatus: { not: 'CANCELADO' } },
            select: { visitId: true, quantity: true, product: { select: { id: true, description: true, unit: true } } },
          })
        : [],
      ctx.db.block.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.blockId).filter((x): x is string => !!x))] } }, select: { id: true, localityId: true } }),
    ]);
    const porAgente = new Map<string, typeof rows>();
    for (const r of rows) porAgente.set(r.userId, [...(porAgente.get(r.userId) ?? []), r]);
    const larvicida = (vs: Set<string>) => {
      const m = new Map<string, { produto: string; unidade: string; quantidade: number }>();
      for (const t of tratamentos)
        if (vs.has(t.visitId)) {
          const a = m.get(t.product.id) ?? { produto: t.product.description, unidade: t.product.unit, quantidade: 0 };
          a.quantidade = Math.round((a.quantidade + Number(t.quantity)) * 1000) / 1000;
          m.set(t.product.id, a);
        }
      return [...m.values()];
    };
    const resumo = (vs: typeof rows) => ({
      visitas: vs.length,
      trabalhados: vs.filter((v) => v.situation === 'TRABALHADO').length,
      fechados: vs.filter((v) => v.situation === 'FECHADO').length,
      recusados: vs.filter((v) => v.situation === 'RECUSADO').length,
      abandonados: vs.filter((v) => v.situation === 'ABANDONADO').length,
      recuperados: vs.filter((v) => v.recovery && v.situation === 'TRABALHADO').length,
      imoveisComFoco: new Set(vs.filter((v) => v.depositsPositive > 0).map((v) => v.householdId)).size,
      depositosInspecionados: vs.reduce((s, v) => s + v.depositsInspected, 0),
      depositosComFoco: vs.reduce((s, v) => s + v.depositsPositive, 0),
      depositosEliminados: vs.reduce((s, v) => s + v.depositsEliminated, 0),
      depositosTratados: vs.reduce((s, v) => s + v.depositsTreated, 0),
      amostras: vs.reduce((s, v) => s + v.samplesCount, 0),
      nebulizados: vs.filter((v) => !!v.ubv).length,
      larvicida: larvicida(new Set(vs.map((v) => v.id))),
    });
    const indice = (vs: typeof rows) => indicesLarvarios(vs.map((v) => ({ imovelId: v.householdId, situacao: v.situation, depositos: v.deposits as Depositos | null })));
    const localidadeDoBloco = new Map(blocos.map((b) => [b.id, b.localityId]));
    const localidades = await ctx.db.locality.findMany({ where: { id: { in: [...new Set(blocos.map((b) => b.localityId))] } }, select: { id: true, code: true, name: true } });
    return {
      periodo: { de: q.de, ate: q.ate },
      total: { ...resumo(rows), indices: indice(rows) },
      agentes: [...porAgente.entries()].map(([id, vs]) => ({ id, nome: agentes.find((a) => a.id === id)?.name ?? null, ...resumo(vs) })).sort((a, b) => b.trabalhados - a.trabalhados),
      localidades: localidades
        .map((l) => {
          const vs = rows.filter((r) => r.blockId && localidadeDoBloco.get(r.blockId) === l.id);
          return { id: l.id, codigo: l.code, nome: l.name, visitas: vs.length, indices: indice(vs) };
        })
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
