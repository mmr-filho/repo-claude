import { Injectable } from '@nestjs/common';
import { TenantPrisma, type TenantClient } from '@omnisaude/database';
import { ampliarCaixa, caixasSeTocam, distanciaAteArea, ORDEM_PRECISAO, pontoNaArea, roleHasPermission, type Area, type Caixa, type PrecisaoGeo, type Posicao } from '@omnisaude/shared';
import type { RequestContext } from '../../core/context';

/** Ponto sobre a rua ou com erro de GPS: até esta distância de um quarteirão, o imóvel é ligado ao mais próximo. */
export const TOLERANCIA_QUARTEIRAO_M = 15;

/** Precisões boas o bastante para ligar o imóvel ao quarteirão pela posição (as demais não dizem em qual está). */
export const PRECISAO_LIGA_QUARTEIRAO: PrecisaoGeo[] = ['GPS_CAMPO', 'MAPA', 'ENDERECO', 'FACE'];

/** Precisões da posição pelo endereço (base do IBGE) que ligam o imóvel ao quarteirão: o quarteirão veio dessa posição. */
export const ENDERECO_LIGA_QUARTEIRAO: PrecisaoGeo[] = ['ENDERECO', 'FACE'];

/**
 * Origens (geo_source) das ações explícitas sobre a posição do imóvel: marcar no mapa ou ler o GPS na tela do território
 * ('mapa', 'gps') e o cadastro do domicílio com posição ('cadastro'). GPS de visita ('visita', 'visita-ace'), GPS do
 * imóvel novo do ACE ('ace') e a geocodificação ('cnefe:...', 'centro-do-...') não são.
 */
const ORIGEM_EXPLICITA = ['mapa', 'gps', 'cadastro'];

/** A posição atual do imóvel veio de uma ação explícita (marcação no mapa, precisão MAPA, ou cadastro com posição). */
export function posicaoExplicita(h: { geoPrecision: string | null; geoSource: string | null }): boolean {
  return h.geoPrecision === 'MAPA' || (!!h.geoSource && ORIGEM_EXPLICITA.includes(h.geoSource));
}

type Db = Pick<TenantClient, 'block' | 'household' | '$executeRaw'>;
/** Para religar: a origem do imóvel (criado pelo ACE em campo) está na sincronização. */
type DbVinculo = Db & Pick<TenantClient, 'fieldSyncOp'>;

interface QuarteiraoGeo {
  id: string;
  number: string;
  localityId: string;
  neighborhoodId: string | null;
  geometry: Area;
  caixa: Caixa;
}

const caixaDoBloco = (b: { minLng: number; minLat: number; maxLng: number; maxLat: number }): Caixa => [b.minLng, b.minLat, b.maxLng, b.maxLat];

/** Grade simples (células de ~550 m) para achar quarteirões candidatos sem PostGIS. */
class Grade {
  private readonly celulas = new Map<string, QuarteiraoGeo[]>();
  constructor(
    blocos: QuarteiraoGeo[],
    private readonly passo = 0.005,
  ) {
    for (const b of blocos) for (const k of this.chaves(b.caixa)) (this.celulas.get(k) ?? this.celulas.set(k, []).get(k)!).push(b);
  }
  private chaves([x0, y0, x1, y1]: Caixa) {
    const out: string[] = [];
    for (let i = Math.floor(x0 / this.passo); i <= Math.floor(x1 / this.passo); i++) for (let j = Math.floor(y0 / this.passo); j <= Math.floor(y1 / this.passo); j++) out.push(`${i}:${j}`);
    return out;
  }
  candidatos(c: Caixa): QuarteiraoGeo[] {
    const vistos = new Set<string>();
    const out: QuarteiraoGeo[] = [];
    for (const k of this.chaves(c))
      for (const b of this.celulas.get(k) ?? [])
        if (!vistos.has(b.id) && caixasSeTocam(b.caixa, c)) {
          vistos.add(b.id);
          out.push(b);
        }
    return out;
  }
}

function escolher(p: Posicao, candidatos: QuarteiraoGeo[]): QuarteiraoGeo | null {
  let melhor: { b: QuarteiraoGeo; d: number } | null = null;
  for (const b of candidatos) {
    if (pontoNaArea(p, b.geometry)) return b;
    const d = distanciaAteArea(p, b.geometry);
    if (d <= TOLERANCIA_QUARTEIRAO_M && (!melhor || d < melhor.d)) melhor = { b, d };
  }
  return melhor?.b ?? null;
}

@Injectable()
export class LocalizadorService {
  /** Quarteirões ativos cuja caixa encosta na caixa dada (filtro no banco pelas colunas indexadas). */
  private async blocosNaCaixa(db: Db, [x0, y0, x1, y1]: Caixa, take = 5000): Promise<QuarteiraoGeo[]> {
    const rows = await db.block.findMany({
      where: { active: true, minLng: { lte: x1 }, maxLng: { gte: x0 }, minLat: { lte: y1 }, maxLat: { gte: y0 } },
      select: { id: true, number: true, localityId: true, neighborhoodId: true, geometry: true, minLng: true, minLat: true, maxLng: true, maxLat: true },
      take,
    });
    return rows.map((r) => ({ ...r, geometry: r.geometry as unknown as Area, caixa: caixaDoBloco(r) }));
  }

  /** Quarteirão que contém o ponto ou, se o ponto cair na rua, o mais próximo até 15 m. */
  async quarteiraoDoPonto(db: Db, lat: number, lng: number): Promise<{ id: string; number: string } | null> {
    const p: Posicao = [lng, lat];
    const caixa = ampliarCaixa([lng, lat, lng, lat], TOLERANCIA_QUARTEIRAO_M);
    const b = escolher(p, await this.blocosNaCaixa(db, caixa, 200));
    return b ? { id: b.id, number: b.number } : null;
  }

  /**
   * Quarteirões atingidos pelo raio (bloqueio de transmissão): o polígono está a até `metros` do ponto, medido até a
   * borda (o quarteirão do próprio caso tem distância zero). Ordem: do mais próximo ao mais distante.
   */
  async quarteiroesNoRaio(db: Db, lat: number, lng: number, metros: number) {
    const p: Posicao = [lng, lat];
    const blocos = await this.blocosNaCaixa(db, ampliarCaixa([lng, lat, lng, lat], metros));
    return blocos
      .map((b) => ({ b, d: distanciaAteArea(p, b.geometry) }))
      .filter((x) => x.d <= metros)
      .sort((a, b) => a.d - b.d)
      .map((x) => ({ id: x.b.id, numero: x.b.number, localityId: x.b.localityId, neighborhoodId: x.b.neighborhoodId, distanciaM: Math.round(x.d * 10) / 10 }));
  }

  /**
   * Imóveis que quem trabalha em campo sem 'territorio.editar' alcança. ACS: os da sua equipe e microárea e os ainda sem
   * equipe da unidade do contexto (cadastrados na recepção). ACE (VIG-3a): os quarteirões da sua zona e os das ordens
   * de bloqueio ativas em que foi designado. Supervisão de campo das endemias: os quarteirões das zonas ativas e das
   * ordens ativas, não o município inteiro. null = todos (quem edita o território e os demais papéis). Para ACE e
   * supervisão o filtro leva a lista de quarteirões, que pode ser a malha toda: numa consulta de imóveis, use
   * `quarteiroesDeCampoSql`, que não monta a lista.
   */
  async escopoDeCampo(ctx: RequestContext) {
    if (roleHasPermission(ctx.session.role, 'territorio.editar')) return null;
    const quarteiroes = await this.quarteiroesDeCampo(ctx);
    if (quarteiroes) return [{ blockId: { in: quarteiroes } }];
    if (ctx.session.role !== 'ACS') return null;
    const lotacoes = await ctx.db.teamMember.findMany({ where: { userId: ctx.session.userId, active: true, team: { unitId: ctx.session.unitId, active: true } }, select: { teamId: true, microArea: true } });
    return [...lotacoes.map((l) => ({ teamId: l.teamId, ...(l.microArea ? { microArea: l.microArea } : {}) })), { teamId: null, unitId: ctx.session.unitId }];
  }

  /** Quarteirões de trabalho do ACE e da supervisão de campo das endemias; null para os demais papéis. */
  async quarteiroesDeCampo(ctx: RequestContext): Promise<string[] | null> {
    if (roleHasPermission(ctx.session.role, 'territorio.editar')) return null;
    if (ctx.session.role === 'ACE') return this.quarteiroesDoAce(ctx.db, ctx.session.userId);
    if (ctx.session.role === 'SUPERVISOR_ENDEMIAS') return this.quarteiroesDasEndemias(ctx.db);
    return null;
  }

  /**
   * Condição SQL "o quarteirão da coluna é de trabalho" do ACE e da supervisão de campo, em subconsultas: a mesma regra
   * de `quarteiroesDoAce` e `quarteiroesDasEndemias` sem montar a lista, que pode ser a malha toda (um IN com um
   * parâmetro por quarteirão passa do limite de 32.767 parâmetros por consulta). null para os demais papéis.
   */
  quarteiroesDeCampoSql(ctx: RequestContext, coluna: TenantPrisma.Sql): TenantPrisma.Sql | null {
    if (roleHasPermission(ctx.session.role, 'territorio.editar')) return null;
    if (ctx.session.role !== 'ACE' && ctx.session.role !== 'SUPERVISOR_ENDEMIAS') return null;
    const { sql, empty } = TenantPrisma;
    const ace = ctx.session.role === 'ACE' ? ctx.session.userId : null;
    return sql`(${coluna} IN (SELECT zb.block_id FROM vector_zone_blocks zb JOIN vector_zones z ON z.id = zb.zone_id
        WHERE z.active${ace ? sql` AND z.ace_id = ${ace}::uuid` : empty})
      OR ${coluna} IN (SELECT ob.block_id FROM blocking_order_blocks ob JOIN blocking_orders o ON o.id = ob.order_id
        WHERE o.status IN ('ABERTA', 'EM_CAMPO')${ace ? sql` AND EXISTS (SELECT 1 FROM blocking_order_assignees a WHERE a.order_id = o.id AND a.user_id = ${ace}::uuid)` : empty}))`;
  }

  /** Quarteirões de trabalho do agente de endemias: zona(s) de que é titular e ordens de bloqueio ativas designadas. */
  async quarteiroesDoAce(db: Pick<TenantClient, 'vectorZoneBlock' | 'blockingOrderBlock'>, userId: string): Promise<string[]> {
    const [zona, ordens] = await Promise.all([
      db.vectorZoneBlock.findMany({ where: { zone: { aceId: userId, active: true } }, select: { blockId: true } }),
      db.blockingOrderBlock.findMany({ where: { order: { status: { in: ['ABERTA', 'EM_CAMPO'] }, assignees: { some: { userId } } } }, select: { blockId: true } }),
    ]);
    return [...new Set([...zona, ...ordens].map((b) => b.blockId))];
  }

  /** Quarteirões de trabalho da supervisão de campo: os de todas as zonas ativas e das ordens de bloqueio ativas. */
  async quarteiroesDasEndemias(db: Pick<TenantClient, 'vectorZoneBlock' | 'blockingOrderBlock'>): Promise<string[]> {
    const [zona, ordens] = await Promise.all([
      db.vectorZoneBlock.findMany({ where: { zone: { active: true } }, select: { blockId: true } }),
      db.blockingOrderBlock.findMany({ where: { order: { status: { in: ['ABERTA', 'EM_CAMPO'] } } }, select: { blockId: true } }),
    ]);
    return [...new Set([...zona, ...ordens].map((b) => b.blockId))];
  }

  /** O imóvel está ao alcance de quem trabalha em campo (sempre verdadeiro para quem edita o território e os demais papéis). */
  async noEscopoDeCampo(ctx: RequestContext, householdId: string) {
    if (roleHasPermission(ctx.session.role, 'territorio.editar')) return true;
    // ACE e supervisão das endemias: pelo quarteirão do imóvel, sem montar a lista (a da supervisão pode ser a malha toda).
    if (ctx.session.role === 'ACE' || ctx.session.role === 'SUPERVISOR_ENDEMIAS') {
      const h = await ctx.db.household.findUnique({ where: { id: householdId }, select: { blockId: true } });
      if (!h?.blockId) return false;
      const ace = ctx.session.role === 'ACE' ? ctx.session.userId : null;
      const [zona, ordem] = await Promise.all([
        ctx.db.vectorZoneBlock.count({ where: { blockId: h.blockId, zone: { active: true, ...(ace ? { aceId: ace } : {}) } } }),
        ctx.db.blockingOrderBlock.count({ where: { blockId: h.blockId, order: { status: { in: ['ABERTA', 'EM_CAMPO'] }, ...(ace ? { assignees: { some: { userId: ace } } } : {}) } } }),
      ]);
      return zona + ordem > 0;
    }
    const escopo = await this.escopoDeCampo(ctx);
    return !escopo || (await ctx.db.household.count({ where: { id: householdId, OR: escopo } })) > 0;
  }

  /**
   * Imóveis criados pelo ACE em campo (operação ACE_IMOVEL da sincronização, que não é apagada) entre os dados, ou todos.
   * A tabela não tem índice pelo imóvel: quem confere muitos imóveis lê o conjunto uma vez.
   */
  async criadosPeloAce(db: Pick<TenantClient, 'fieldSyncOp'>, ids?: string[]): Promise<Set<string>> {
    if (ids && !ids.length) return new Set();
    const ops = await db.fieldSyncOp.findMany({ where: { kind: 'ACE_IMOVEL', entityType: 'Household', entityId: ids ? { in: ids } : { not: null } }, select: { entityId: true } });
    return new Set(ops.map((o) => o.entityId!));
  }

  /**
   * O imóvel fica no quarteirão escolhido pelo ACE em campo: foi criado por ele, tem quarteirão e a posição atual não veio
   * de uma ação explícita (marcar no mapa, cadastro do domicílio com posição). GPS de visita, endereço da base do IBGE e
   * religação da malha não o tiram de lá, qualquer que seja a precisão da posição. `doAce`: os criados pelo ACE, já lidos
   * por quem confere muitos imóveis; sem ele, a sincronização é lida só para este.
   */
  async quarteiraoEscolhidoEmCampo(db: Pick<TenantClient, 'fieldSyncOp'>, h: { id: string; blockId: string | null; geoPrecision: string | null; geoSource: string | null }, doAce?: ReadonlySet<string>): Promise<boolean> {
    if (!h.blockId || posicaoExplicita(h)) return false;
    return (doAce ?? (await this.criadosPeloAce(db, [h.id]))).has(h.id);
  }

  /**
   * Liga um imóvel ao quarteirão pela posição (só com precisão suficiente); devolve o quarteirão gravado. O imóvel no
   * quarteirão escolhido pelo ACE em campo fica nele (`doAce`: os criados pelo ACE, já lidos por quem liga muitos imóveis).
   */
  async vincularImovel(db: DbVinculo, householdId: string, doAce?: ReadonlySet<string>): Promise<string | null> {
    const h = await db.household.findUnique({ where: { id: householdId }, select: { id: true, latitude: true, longitude: true, geoPrecision: true, geoSource: true, blockId: true } });
    if (!h || h.latitude == null || h.longitude == null || !h.geoPrecision) return h?.blockId ?? null;
    if (!PRECISAO_LIGA_QUARTEIRAO.includes(h.geoPrecision as PrecisaoGeo)) return h.blockId;
    const b = await this.quarteiraoDoPonto(db, h.latitude, h.longitude);
    const novo = b?.id ?? null;
    if (novo === h.blockId) return novo;
    // A origem só é consultada quando o quarteirão mudaria.
    if (await this.quarteiraoEscolhidoEmCampo(db, h, doAce)) return h.blockId;
    // SQL direto: ligar ao quarteirão não é alteração do cadastro (não mexe em updated_at, que dispara a ficha do e-SUS).
    await db.$executeRaw`UPDATE households SET block_id = ${novo}::uuid WHERE id = ${householdId}::uuid`;
    return novo;
  }

  /**
   * Religa todos os imóveis com posição boa aos quarteirões (depois de importar ou editar a malha). Imóvel com a
   * posição no centro do quarteirão (precisão QUARTEIRAO) mantém o quarteirão de origem, e o imóvel criado pelo ACE em
   * campo fica no quarteirão escolhido lá até uma ação explícita mudar a posição dele (`foraDoQuarteirao` conta os que
   * ficaram com a posição em outro quarteirão ou fora da malha). `aoAlterar` recebe os imóveis que mudaram de quarteirão
   * (a ordem de bloqueio dos moradores é reavaliada).
   */
  async vincularTodos(db: DbVinculo, aoAlterar?: (ids: string[]) => void): Promise<{ analisados: number; comQuarteirao: number; semQuarteirao: number; alterados: number; foraDoQuarteirao: number }> {
    const todos = await db.block.findMany({ where: { active: true }, select: { id: true, number: true, localityId: true, neighborhoodId: true, geometry: true, minLng: true, minLat: true, maxLng: true, maxLat: true } });
    const grade = new Grade(todos.map((r) => ({ ...r, geometry: r.geometry as unknown as Area, caixa: caixaDoBloco(r) })));
    const doAce = await this.criadosPeloAce(db);
    const r = { analisados: 0, comQuarteirao: 0, semQuarteirao: 0, alterados: 0, foraDoQuarteirao: 0 };
    let cursor: string | undefined;
    for (;;) {
      const lote = await db.household.findMany({
        // "id maior que o último" (e não o cursor do Prisma): o último imóvel pode ter saído do filtro entre um lote e outro.
        where: { active: true, latitude: { not: null }, longitude: { not: null }, geoPrecision: { in: PRECISAO_LIGA_QUARTEIRAO }, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, latitude: true, longitude: true, blockId: true, geoPrecision: true, geoSource: true },
        orderBy: { id: 'asc' },
        take: 1000,
      });
      if (!lote.length) break;
      cursor = lote[lote.length - 1]!.id;
      const mudancas = new Map<string | null, string[]>();
      for (const h of lote) {
        r.analisados++;
        const p: Posicao = [h.longitude!, h.latitude!];
        const b = escolher(p, grade.candidatos(ampliarCaixa([p[0], p[1], p[0], p[1]], TOLERANCIA_QUARTEIRAO_M)));
        let novo = b?.id ?? null;
        // O quarteirão escolhido pelo ACE em campo fica, com a posição em outro (a supervisão confere no mapa).
        if (novo !== h.blockId && h.blockId && doAce.has(h.id) && !posicaoExplicita(h)) {
          novo = h.blockId;
          r.foraDoQuarteirao++;
        }
        if (novo) r.comQuarteirao++;
        else r.semQuarteirao++;
        if (novo !== h.blockId) (mudancas.get(novo) ?? mudancas.set(novo, []).get(novo)!).push(h.id);
      }
      for (const [blockId, ids] of mudancas) {
        await db.$executeRaw`UPDATE households SET block_id = ${blockId}::uuid WHERE id = ANY(${ids}::uuid[])`;
        r.alterados += ids.length;
        aoAlterar?.(ids);
      }
    }
    return r;
  }
}

/** Uma posição nova só substitui a atual se for de precisão melhor ou igual. */
export function posicaoMelhorOuIgual(nova: PrecisaoGeo, atual: PrecisaoGeo | null | undefined): boolean {
  return !atual || ORDEM_PRECISAO[nova] <= ORDEM_PRECISAO[atual];
}
