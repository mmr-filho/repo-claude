import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { TenantPrisma, tenantSettings, type MasterClient, type TerritorioSettings } from '@omnisaude/database';
import {
  areaM2,
  areasSobrepoem,
  avaliarGps,
  normalizarNumeroQuarteirao,
  caixaDe,
  centroDe,
  codigoLocalidadeValido,
  GeometriaInvalida,
  normalizarArea,
  normalizarNome,
  numeroQuarteiraoValido,
  PRECISAO_INFO,
  raio95,
  RAIO_BLOQUEIO_PADRAO_M,
  type Area,
  type CategoriaLocalidade,
  type PrecisaoGeo,
  type Zona,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { MASTER_DB, TenantsService } from '../../core/database';
import { conflict, DomainError, notFound } from '../../core/errors';
import { LocalizadorService, PRECISAO_LIGA_QUARTEIRAO } from './localizador.service';

/** Trava transacional das gravações de quarteirões (editor e importação). */
export const TRAVA_QUARTEIROES = 'territorio:quarteiroes';

export const geometriaOuErro = (g: unknown): Area => {
  try {
    return normalizarArea(g);
  } catch (err) {
    if (err instanceof GeometriaInvalida) throw new DomainError('GEOMETRIA_INVALIDA', err.message, HttpStatus.BAD_REQUEST);
    throw err;
  }
};

/** Colunas derivadas da geometria (caixa para o filtro no banco, centro e área). */
export function derivados(a: Area) {
  const [minLng, minLat, maxLng, maxLat] = caixaDe(a);
  const [centerLng, centerLat] = centroDe(a);
  return { geometry: a as object, minLng, minLat, maxLng, maxLat, centerLat, centerLng };
}

@Injectable()
export class TerritorioService {
  constructor(
    private readonly localizador: LocalizadorService,
    private readonly audit: AuditService,
    @Inject(MASTER_DB) private readonly master: MasterClient,
    private readonly tenants: TenantsService,
  ) {}

  config(ctx: RequestContext): TerritorioSettings {
    return ctx.tenant.settings.territorio;
  }

  // ───────────── resumo e pendências ─────────────

  async resumo(ctx: RequestContext) {
    const [localidades, bairros, quarteiroes, imoveis, semPosicao, semQuarteirao, porPrecisao, enderecos, ultimaImportacao] = await Promise.all([
      ctx.db.locality.count({ where: { status: 'ATIVA' } }),
      ctx.db.neighborhood.count({ where: { active: true } }),
      ctx.db.block.count({ where: { active: true } }),
      ctx.db.household.count({ where: { active: true } }),
      ctx.db.household.count({ where: { active: true, OR: [{ latitude: null }, { longitude: null }] } }),
      ctx.db.household.count({ where: { active: true, blockId: null, latitude: { not: null } } }),
      ctx.db.household.groupBy({ by: ['geoPrecision'], where: { active: true }, _count: { _all: true } }),
      ctx.db.addressPoint.count(),
      ctx.db.territoryImport.findFirst({ where: { status: 'APLICADA' }, orderBy: { appliedAt: 'desc' }, select: { kind: true, fileName: true, appliedAt: true } }),
    ]);
    return {
      localidades,
      bairros,
      quarteiroes,
      imoveis,
      semPosicao,
      semQuarteirao,
      porPrecisao: Object.fromEntries(porPrecisao.map((p) => [p.geoPrecision ?? 'SEM_POSICAO', p._count._all])),
      baseDeEnderecos: enderecos,
      ultimaImportacao,
      config: this.config(ctx),
    };
  }

  /** Fila de pendências do território: sem posição, sem quarteirão ou com posição que não serve ao bloqueio. */
  async imoveis(ctx: RequestContext, q: { situacao: 'SEM_POSICAO' | 'SEM_QUARTEIRAO' | 'BAIXA_PRECISAO' | 'QUARTEIRAO'; blockId?: string; take?: number }) {
    const baixa: PrecisaoGeo[] = ['LOGRADOURO', 'QUARTEIRAO', 'LOCALIDADE', 'SETOR', 'CEP', 'MUNICIPIO'];
    const where =
      q.situacao === 'SEM_POSICAO'
        ? { active: true, OR: [{ latitude: null }, { longitude: null }] }
        : q.situacao === 'SEM_QUARTEIRAO'
          ? { active: true, blockId: null, latitude: { not: null } }
          : q.situacao === 'BAIXA_PRECISAO'
            ? { active: true, geoPrecision: { in: baixa } }
            : { active: true, blockId: q.blockId ?? '00000000-0000-0000-0000-000000000000' };
    const rows = await ctx.db.household.findMany({
      where,
      orderBy: q.situacao === 'QUARTEIRAO' ? [{ rgSequence: 'asc' }, { number: 'asc' }] : [{ district: 'asc' }, { street: 'asc' }],
      take: Math.min(q.take ?? 200, 1000),
      select: {
        id: true,
        street: true,
        number: true,
        complement: true,
        district: true,
        cep: true,
        propertyType: true,
        latitude: true,
        longitude: true,
        geoPrecision: true,
        geoSource: true,
        blockId: true,
        rgSequence: true,
        microArea: true,
      },
    });
    return rows.map((h) => ({ ...h, endereco: [h.street, h.number, h.complement].filter(Boolean).join(', '), precisaoLabel: h.geoPrecision ? PRECISAO_INFO[h.geoPrecision as PrecisaoGeo].label : null }));
  }

  // ───────────── mapa ─────────────

  /** Camadas na área visível do mapa: quarteirões e imóveis (sem moradores), localidades e bairros. */
  async mapa(ctx: RequestContext, caixa: [number, number, number, number]) {
    const [x0, y0, x1, y1] = caixa;
    const naCaixa = { minLng: { lte: x1 }, maxLng: { gte: x0 }, minLat: { lte: y1 }, maxLat: { gte: y0 } };
    const [localidades, bairros, quarteiroes, imoveis] = await Promise.all([
      // Poucas por município: todas, com ou sem contorno.
      ctx.db.locality.findMany({ where: { status: 'ATIVA' }, select: { id: true, code: true, name: true, category: true, zone: true, geometry: true, centerLat: true, centerLng: true } }),
      ctx.db.neighborhood.findMany({ where: { active: true, ...naCaixa }, select: { id: true, localityId: true, name: true, official: true, geometry: true, centerLat: true, centerLng: true } }),
      ctx.db.block.findMany({
        where: { active: true, ...naCaixa },
        select: { id: true, localityId: true, neighborhoodId: true, number: true, geometry: true, centerLat: true, centerLng: true, areaM2: true, _count: { select: { households: { where: { active: true } } } } },
        take: 4000,
      }),
      ctx.db.household.findMany({
        where: { active: true, latitude: { gte: y0, lte: y1 }, longitude: { gte: x0, lte: x1 } },
        select: { id: true, latitude: true, longitude: true, geoPrecision: true, blockId: true, rgSequence: true, street: true, number: true, propertyType: true },
        take: 6000,
      }),
    ]);
    return {
      localidades,
      bairros,
      quarteiroes: quarteiroes.map(({ _count, ...b }) => ({ ...b, imoveis: _count.households })),
      imoveis: imoveis.map((h) => ({
        id: h.id,
        lat: h.latitude,
        lng: h.longitude,
        precisao: h.geoPrecision,
        blockId: h.blockId,
        sequencia: h.rgSequence,
        endereco: [h.street, h.number].filter(Boolean).join(', '),
        tipo: h.propertyType,
      })),
      limitado: quarteiroes.length === 4000 || imoveis.length === 6000,
    };
  }

  /** Quarteirões a até `metros` do ponto (padrão: raio do bloqueio da instituição). */
  async raio(ctx: RequestContext, lat: number, lng: number, metros?: number) {
    const r = metros ?? this.config(ctx).raioBloqueioM ?? RAIO_BLOQUEIO_PADRAO_M;
    const lista = await this.localizador.quarteiroesNoRaio(ctx.db, lat, lng, r);
    return { ponto: { lat, lng }, raioM: r, quarteiroes: await this.comNomes(ctx, lista) };
  }

  /** Acrescenta localidade, bairro e contagem de imóveis aos quarteirões do raio. */
  async comNomes<T extends { id: string; localityId: string; neighborhoodId: string | null }>(ctx: RequestContext, lista: T[]) {
    if (!lista.length) return [];
    const [locs, bairros, contagem] = await Promise.all([
      ctx.db.locality.findMany({ where: { id: { in: [...new Set(lista.map((b) => b.localityId))] } }, select: { id: true, code: true, name: true } }),
      ctx.db.neighborhood.findMany({ where: { id: { in: lista.map((b) => b.neighborhoodId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
      ctx.db.household.groupBy({ by: ['blockId'], where: { active: true, blockId: { in: lista.map((b) => b.id) } }, _count: { _all: true } }),
    ]);
    const loc = new Map(locs.map((l) => [l.id, l]));
    const bai = new Map(bairros.map((b) => [b.id, b.name]));
    const cnt = new Map(contagem.map((c) => [c.blockId, c._count._all]));
    return lista.map((b) => ({ ...b, localidade: loc.get(b.localityId) ?? null, bairro: b.neighborhoodId ? (bai.get(b.neighborhoodId) ?? null) : null, imoveis: cnt.get(b.id) ?? 0 }));
  }

  // ───────────── localidades e bairros ─────────────

  localidades(ctx: RequestContext) {
    return ctx.db.locality.findMany({
      orderBy: [{ status: 'asc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        category: true,
        zone: true,
        status: true,
        source: true,
        notes: true,
        centerLat: true,
        centerLng: true,
        _count: { select: { blocks: { where: { active: true } }, neighborhoods: { where: { active: true } } } },
      },
    });
  }

  async salvarLocalidade(
    ctx: RequestContext,
    id: string | null,
    input: { code?: string; name?: string; category?: CategoriaLocalidade; zone?: Zona; status?: 'ATIVA' | 'EXTINTA'; geometry?: unknown | null; notes?: string | null },
  ) {
    if (input.code !== undefined && !codigoLocalidadeValido(input.code)) throw new DomainError('CODIGO_INVALIDO', 'Código da localidade: até 8 dígitos', HttpStatus.BAD_REQUEST);
    const geo =
      input.geometry === undefined
        ? {}
        : input.geometry === null
          ? { geometry: TenantPrisma.DbNull, minLng: null, minLat: null, maxLng: null, maxLat: null, centerLat: null, centerLng: null }
          : derivados(geometriaOuErro(input.geometry));
    const data = {
      ...(input.code !== undefined ? { code: input.code.trim() } : {}),
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.zone ? { zone: input.zone } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
      ...geo,
    };
    try {
      const l = await ctx.db.$transaction(async (tx) => {
        const r = id
          ? await tx.locality.update({ where: { id }, data })
          : await tx.locality.create({ data: { code: input.code!.trim(), name: input.name!.trim(), ...data, source: 'MANUAL', createdBy: ctx.session.userId } });
        await this.audit.record(ctx, tx, {
          action: id ? 'territorio.localidade_editar' : 'territorio.localidade_criar',
          entityType: 'Locality',
          entityId: r.id,
          payload: { code: r.code, name: r.name, status: r.status },
        });
        return r;
      });
      return l;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw conflict(`Já existe localidade ativa com o código ${input.code}`);
      if ((err as { code?: string }).code === 'P2025') throw notFound('Localidade');
      throw err;
    }
  }

  bairros(ctx: RequestContext, localityId?: string) {
    return ctx.db.neighborhood.findMany({
      where: { active: true, ...(localityId ? { localityId } : {}) },
      orderBy: { name: 'asc' },
      select: { id: true, localityId: true, name: true, code: true, official: true, aliases: true, source: true, centerLat: true, centerLng: true, _count: { select: { blocks: { where: { active: true } } } } },
    });
  }

  async salvarBairro(ctx: RequestContext, id: string | null, input: { localityId?: string; name?: string; code?: string | null; official?: boolean; aliases?: string[]; geometry?: unknown | null; active?: boolean }) {
    const geo =
      input.geometry === undefined
        ? {}
        : input.geometry === null
          ? { geometry: TenantPrisma.DbNull, minLng: null, minLat: null, maxLng: null, maxLat: null, centerLat: null, centerLng: null }
          : derivados(geometriaOuErro(input.geometry));
    const aliases = input.aliases ? [...new Set(input.aliases.map((a) => a.trim()).filter(Boolean))] : undefined;
    const data = {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.code !== undefined ? { code: input.code?.trim() || null } : {}),
      ...(input.official !== undefined ? { official: input.official } : {}),
      ...(aliases ? { aliases } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...geo,
    };
    try {
      return await ctx.db.$transaction(async (tx) => {
        if (!id && !(await tx.locality.findUnique({ where: { id: input.localityId! } }))) throw notFound('Localidade');
        const r = id ? await tx.neighborhood.update({ where: { id }, data }) : await tx.neighborhood.create({ data: { localityId: input.localityId!, name: input.name!.trim(), ...data } });
        await this.audit.record(ctx, tx, { action: id ? 'territorio.bairro_editar' : 'territorio.bairro_criar', entityType: 'Neighborhood', entityId: r.id, payload: { name: r.name, official: r.official } });
        return r;
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw conflict(`Já existe bairro ativo com o nome ${input.name} nessa localidade`);
      if ((err as { code?: string }).code === 'P2025') throw notFound('Bairro');
      throw err;
    }
  }

  // ───────────── quarteirões ─────────────

  quarteiroes(ctx: RequestContext, q: { localityId?: string; neighborhoodId?: string }) {
    return ctx.db.block.findMany({
      where: { active: true, ...(q.localityId ? { localityId: q.localityId } : {}), ...(q.neighborhoodId ? { neighborhoodId: q.neighborhoodId } : {}) },
      orderBy: [{ localityId: 'asc' }, { number: 'asc' }],
      select: {
        id: true,
        localityId: true,
        neighborhoodId: true,
        number: true,
        centerLat: true,
        centerLng: true,
        areaM2: true,
        source: true,
        notes: true,
        updatedAt: true,
        _count: { select: { households: { where: { active: true } } } },
      },
      take: 5000,
    });
  }

  async quarteirao(ctx: RequestContext, id: string) {
    const b = await ctx.db.block.findUnique({ where: { id }, include: { locality: { select: { id: true, code: true, name: true } }, neighborhood: { select: { id: true, name: true } } } });
    if (!b) throw notFound('Quarteirão');
    return { ...b, imoveis: await this.imoveis(ctx, { situacao: 'QUARTEIRAO', blockId: id, take: 1000 }) };
  }

  /** Número único na localidade ou no bairro (regra da instituição), entre os quarteirões ativos. */
  private async conferirNumero(tx: Pick<RequestContext['db'], 'block'>, ctx: RequestContext, b: { id?: string; localityId: string; neighborhoodId: string | null; number: string }) {
    const porBairro = this.config(ctx).numeracaoQuarteirao === 'BAIRRO';
    if (porBairro && !b.neighborhoodId) throw new DomainError('BAIRRO_OBRIGATORIO', 'A numeração dos quarteirões é por bairro: informe o bairro', HttpStatus.BAD_REQUEST);
    const repetido = await tx.block.findFirst({
      where: { active: true, localityId: b.localityId, number: b.number, ...(porBairro ? { neighborhoodId: b.neighborhoodId } : {}), ...(b.id ? { id: { not: b.id } } : {}) },
      select: { id: true },
    });
    if (repetido) throw conflict(`Já existe o quarteirão ${b.number} ${porBairro ? 'nesse bairro' : 'nessa localidade'}`);
  }

  /** Quarteirões ativos cujo polígono se sobrepõe ao novo (quarteirões são separados por ruas, rios, estradas). */
  private async sobrepostos(tx: Pick<RequestContext['db'], 'block'>, a: Area, exceto?: string) {
    const [x0, y0, x1, y1] = caixaDe(a);
    const vizinhos = await tx.block.findMany({
      where: { active: true, minLng: { lte: x1 }, maxLng: { gte: x0 }, minLat: { lte: y1 }, maxLat: { gte: y0 }, ...(exceto ? { id: { not: exceto } } : {}) },
      select: { id: true, number: true, geometry: true },
    });
    return vizinhos.filter((v) => areasSobrepoem(a, v.geometry as unknown as Area)).map((v) => v.number);
  }

  async salvarQuarteirao(ctx: RequestContext, id: string | null, input: { localityId?: string; neighborhoodId?: string | null; number?: string; geometry?: unknown; notes?: string | null; versao?: string }) {
    const numero = input.number !== undefined ? normalizarNumeroQuarteirao(input.number) : undefined;
    if (numero !== undefined && !numeroQuarteiraoValido(numero)) throw new DomainError('NUMERO_INVALIDO', 'Número do quarteirão: dígitos, com sufixo opcional (ex.: 12 ou 12-A)', HttpStatus.BAD_REQUEST);
    const area = input.geometry !== undefined ? geometriaOuErro(input.geometry) : null;
    const b = await ctx.db.$transaction(async (tx) => {
      // Uma gravação de quarteirão por vez: número único e sobreposição são conferidos pela aplicação.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRAVA_QUARTEIROES}))`;
      const atual = id ? await tx.block.findUnique({ where: { id } }) : null;
      if (id && (!atual || !atual.active)) throw notFound('Quarteirão');
      // Edição concorrente no editor: a gravação só vale sobre a versão lida.
      if (atual && input.versao && atual.updatedAt.toISOString() !== input.versao) throw conflict('O quarteirão foi alterado por outra pessoa; recarregue o mapa');
      const localityId = input.localityId ?? atual?.localityId;
      if (!localityId) throw new DomainError('LOCALIDADE_OBRIGATORIA', 'Informe a localidade do quarteirão', HttpStatus.BAD_REQUEST);
      if (!(await tx.locality.findFirst({ where: { id: localityId, status: 'ATIVA' } }))) throw notFound('Localidade');
      const neighborhoodId = input.neighborhoodId !== undefined ? input.neighborhoodId : (atual?.neighborhoodId ?? null);
      if (neighborhoodId && !(await tx.neighborhood.findFirst({ where: { id: neighborhoodId, localityId, active: true } })))
        throw new DomainError('BAIRRO_INVALIDO', 'O bairro não é dessa localidade', HttpStatus.BAD_REQUEST);
      const number = numero ?? atual?.number;
      if (!number) throw new DomainError('NUMERO_OBRIGATORIO', 'Informe o número do quarteirão', HttpStatus.BAD_REQUEST);
      if (!area && !atual) throw new DomainError('GEOMETRIA_OBRIGATORIA', 'Desenhe o contorno do quarteirão', HttpStatus.BAD_REQUEST);
      await this.conferirNumero(tx, ctx, { id: id ?? undefined, localityId, neighborhoodId, number });
      if (area) {
        const sobre = await this.sobrepostos(tx, area, id ?? undefined);
        if (sobre.length) throw conflict(`O contorno se sobrepõe ao(s) quarteirão(ões) ${sobre.join(', ')}`, { quarteiroes: sobre });
      }
      const data = {
        localityId,
        neighborhoodId,
        number,
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
        ...(area ? { ...derivados(area), areaM2: Math.round(areaM2(area) * 10) / 10 } : {}),
        updatedBy: ctx.session.userId,
      };
      const r = id
        ? await tx.block.update({ where: { id }, data })
        : await tx.block.create({ data: { ...data, ...derivados(area!), areaM2: Math.round(areaM2(area!) * 10) / 10, source: 'EDITOR', createdBy: ctx.session.userId } });
      await this.audit.record(ctx, tx, { action: id ? 'territorio.quarteirao_editar' : 'territorio.quarteirao_criar', entityType: 'Block', entityId: r.id, payload: { number: r.number, localityId, geometria: !!area } });
      return r;
    });
    // O contorno mudou: religa os imóveis com posição boa (dentro do novo e os que estavam no antigo).
    const religados = area ? await this.religarEntorno(ctx, b.id) : 0;
    return { ...b, religados };
  }

  async desativarQuarteirao(ctx: RequestContext, id: string, motivo: string) {
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.block.updateMany({ where: { id, active: true }, data: { active: false, updatedBy: ctx.session.userId } });
      if (count !== 1) throw notFound('Quarteirão');
      await tx.household.updateMany({ where: { blockId: id }, data: { blockId: null } });
      await this.audit.record(ctx, tx, { action: 'territorio.quarteirao_desativar', entityType: 'Block', entityId: id, payload: { motivo } });
    });
    return { ok: true };
  }

  /** Religa os imóveis na caixa do quarteirão (e os que estavam nele) depois de mudar o contorno. */
  private async religarEntorno(ctx: RequestContext, blockId: string): Promise<number> {
    const b = await ctx.db.block.findUniqueOrThrow({ where: { id: blockId }, select: { minLng: true, minLat: true, maxLng: true, maxLat: true } });
    const d = 0.0003;
    const ids = await ctx.db.household.findMany({
      where: {
        active: true,
        geoPrecision: { in: PRECISAO_LIGA_QUARTEIRAO },
        OR: [{ blockId }, { latitude: { gte: b.minLat - d, lte: b.maxLat + d }, longitude: { gte: b.minLng - d, lte: b.maxLng + d } }],
      },
      select: { id: true, blockId: true },
    });
    let mudou = 0;
    for (const h of ids) if ((await this.localizador.vincularImovel(ctx.db, h.id)) !== h.blockId) mudou++;
    return mudou;
  }

  // ───────────── imóvel ─────────────

  /**
   * Posição do imóvel marcada no mapa ou lida do GPS do aparelho. O GPS guarda o raio normalizado para 95% de
   * confiança e é recusado acima de 50 m (nova leitura). Marcar no mapa vale como precisão "MAPA".
   */
  async posicionarImovel(ctx: RequestContext, id: string, input: { lat: number; lng: number; origem: 'MAPA' | 'GPS'; accuracyM?: number | null; confianca?: 68 | 95; sequencia?: string | null }) {
    const h = await ctx.db.household.findUnique({ where: { id }, select: { id: true, active: true, latitude: true, longitude: true, geoPrecision: true } });
    if (!h || !h.active) throw notFound('Imóvel');
    let acc: number | null = null;
    if (input.origem === 'GPS') {
      if (input.accuracyM == null) throw new DomainError('GPS_SEM_PRECISAO', 'Leitura de GPS sem a precisão do aparelho', HttpStatus.BAD_REQUEST);
      acc = Math.round(raio95(input.accuracyM, input.confianca ?? 95) * 10) / 10;
      if (avaliarGps(acc) === 'NOVA_LEITURA') throw new DomainError('GPS_IMPRECISO', `Precisão do GPS de ${acc} m: faça nova leitura ao ar livre (aceito até 50 m)`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const precisao: PrecisaoGeo = input.origem === 'GPS' ? 'GPS_CAMPO' : 'MAPA';
    await ctx.db.$transaction(async (tx) => {
      await tx.household.update({
        where: { id },
        data: {
          latitude: Math.round(input.lat * 1e6) / 1e6,
          longitude: Math.round(input.lng * 1e6) / 1e6,
          geoPrecision: precisao,
          geoSource: input.origem === 'GPS' ? 'gps' : 'mapa',
          geoAccuracyM: acc,
          geoAt: new Date(),
          ...(input.sequencia !== undefined ? { rgSequence: input.sequencia?.trim().toUpperCase() || null } : {}),
        },
      });
      await this.audit.record(ctx, tx, { action: 'territorio.imovel_posicao', entityType: 'Household', entityId: id, payload: { origem: input.origem, precisaoAnterior: h.geoPrecision, acc } });
    });
    const blockId = await this.localizador.vincularImovel(ctx.db, id);
    return { id, precisao, blockId, alerta: acc != null && avaliarGps(acc) === 'ALERTA' ? `Precisão do GPS de ${acc} m (entre 20 e 50 m): confira no mapa` : null };
  }

  /** Religa todos os imóveis aos quarteirões (depois de importar ou editar a malha). */
  async vincularTodos(ctx: RequestContext) {
    const r = await this.localizador.vincularTodos(ctx.db);
    await this.audit.recordStandalone(ctx, { action: 'territorio.vincular_imoveis', entityType: 'Household', payload: r });
    return r;
  }

  // ───────────── configurações ─────────────

  async salvarConfiguracoes(ctx: RequestContext, input: Partial<TerritorioSettings>) {
    const t = await this.master.tenant.findUniqueOrThrow({ where: { id: ctx.tenant.id } });
    const atual = tenantSettings(t.settings).territorio;
    const raio = input.raioBloqueioM ?? atual.raioBloqueioM;
    if (!Number.isInteger(raio) || raio < 50 || raio > 1000) throw new DomainError('RAIO_INVALIDO', 'Raio do bloqueio entre 50 e 1.000 m', HttpStatus.BAD_REQUEST);
    const numeracao = input.numeracaoQuarteirao ?? atual.numeracaoQuarteirao;
    if (numeracao === 'BAIRRO' && atual.numeracaoQuarteirao !== 'BAIRRO' && (await ctx.db.block.count({ where: { active: true, neighborhoodId: null } })) > 0)
      throw new DomainError('QUARTEIRAO_SEM_BAIRRO', 'Há quarteirões sem bairro: ligue-os a um bairro antes de numerar por bairro', HttpStatus.UNPROCESSABLE_ENTITY);
    if (numeracao === 'LOCALIDADE' && atual.numeracaoQuarteirao === 'BAIRRO') {
      // De volta à numeração por localidade: o mesmo número em dois bairros da localidade passaria a se repetir.
      const repetidos = await ctx.db.block.groupBy({ by: ['localityId', 'number'], where: { active: true }, _count: { _all: true }, having: { number: { _count: { gt: 1 } } } });
      if (repetidos.length)
        throw new DomainError(
          'QUARTEIRAO_REPETIDO',
          `Há ${repetidos.length} número(s) de quarteirão repetido(s) entre bairros da mesma localidade (ex.: ${repetidos[0]!.number}): renumere antes de numerar por localidade`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
    }
    const territorio: TerritorioSettings = { numeracaoQuarteirao: numeracao, raioBloqueioM: raio };
    await this.master.$executeRaw`UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{territorio}', ${JSON.stringify(territorio)}::jsonb) WHERE id = ${ctx.tenant.id}::uuid`;
    this.tenants.connections.invalidate(ctx.tenant.slug);
    this.tenants.connections.invalidate(ctx.tenant.id);
    await this.audit.recordStandalone(ctx, { action: 'territorio.configuracoes', entityType: 'Tenant', entityId: ctx.tenant.id, payload: territorio });
    return territorio;
  }

  /** Nome normalizado para casar bairro do cadastro com o polígono (inclui apelidos). */
  normalizar(nome: string) {
    return normalizarNome(nome);
  }
}
