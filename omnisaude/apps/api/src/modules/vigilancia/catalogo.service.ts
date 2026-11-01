import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { TenantClient } from '@omnisaude/database';
import { LNNC_NACIONAL, MAPEAMENTOS_INICIAIS, mapearCodigo, mesclarCatalogo, versaoNaData, type ContextoAgravo } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';

type Sys = { tenant: { id: string; timeZone: string }; db: TenantClient };

const dataIso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const comoData = (iso: string) => new Date(`${iso}T00:00:00Z`);

export interface CondicaoNoRetrato {
  id: string;
  versionId: string;
  key: string;
  groupKey: string;
  /** Igual a groupKey (nome usado pelas funções compartilhadas do catálogo). */
  group: string;
  item: number;
  subitem: string | null;
  name: string;
  context: ContextoAgravo;
  immediateMs: boolean;
  immediateSes: boolean;
  immediateSms: boolean;
  weekly: boolean;
  notifyOn: 'SUSPEITA' | 'CONFIRMACAO';
  deadlineStart: 'ATENDIMENTO' | 'CONHECIMENTO' | 'CONFIRMACAO';
  sensitive: boolean;
  once: boolean;
  normativeStatus: 'VIGENTE' | 'EM_REVISAO';
  normativeNote: string | null;
  sinanCode: string | null;
}

export interface NovaCondicaoLocal {
  key: string;
  groupKey?: string;
  item: number;
  subitem?: string | null;
  name: string;
  context?: ContextoAgravo;
  immediateMs: boolean;
  immediateSes: boolean;
  immediateSms: boolean;
  weekly: boolean;
  notifyOn?: 'SUSPEITA' | 'CONFIRMACAO';
  deadlineStart?: 'ATENDIMENTO' | 'CONHECIMENTO' | 'CONFIRMACAO';
  sensitive?: boolean;
  once?: boolean;
  normativeNote?: string | null;
}

/**
 * Catálogo da Lista de Notificação Compulsória por instituição. As versões nacionais vêm do código (gerado do
 * compilado oficial) e são gravadas no banco na primeira vez; versões estaduais e municipais são criadas pela
 * vigilância. O retrato numa data junta a nacional vigente com as complementares vigentes; a linha local de mesma
 * chave substitui a nacional.
 */
/** Chaves e grupos de todas as versões nacionais gravadas. */
async function chavesNacionais(sys: Sys) {
  const linhas = await sys.db.notifiableCondition.findMany({ where: { version: { scope: 'NACIONAL' } }, select: { key: true, groupKey: true } });
  return { chaves: new Set(linhas.map((l) => l.key)), grupos: new Set(linhas.map((l) => l.groupKey)) };
}

@Injectable()
export class CatalogoVigilanciaService {
  private readonly prontos = new Set<string>();

  constructor(private readonly audit: AuditService) {}

  /**
   * Carrega as versões nacionais, o de-para inicial e o CIEVS Nacional (idempotente). Quando a curadoria do catálogo
   * gerado muda (hash do conteúdo), as linhas nacionais são atualizadas por chave e as que saíram ficam inativas
   * (nunca apagadas: notificações apontam para elas).
   */
  async garantir(sys: Sys) {
    if (this.prontos.has(sys.tenant.id)) return;
    for (const v of LNNC_NACIONAL) {
      const hash = createHash('sha256').update(JSON.stringify(v)).digest('hex');
      let row = await sys.db.notifiableListVersion.findUnique({ where: { nationalId: v.id } });
      if (row?.contentHash === hash) continue;
      const meta = {
        act: v.act,
        publishedIn: v.publishedIn,
        actUrl: v.actUrl,
        sourceUrl: v.sourceUrl,
        sourceSha256: v.sourceSha256,
        consultedAt: comoData(v.consultedAt),
        validFrom: comoData(v.validFrom),
        validTo: v.validTo ? comoData(v.validTo) : null,
        notes: v.notes,
      };
      if (!row) {
        try {
          row = await sys.db.notifiableListVersion.create({ data: { scope: 'NACIONAL', scopeKey: 'NACIONAL', nationalId: v.id, ...meta } });
        } catch (err) {
          if ((err as { code?: string }).code !== 'P2002') throw err;
          row = await sys.db.notifiableListVersion.findUniqueOrThrow({ where: { nationalId: v.id } });
        }
      } else {
        await sys.db.notifiableListVersion.update({ where: { id: row.id }, data: meta });
      }
      const versionId = row.id;
      for (const c of v.conditions) {
        const dados = {
          groupKey: c.group,
          item: c.item,
          subitem: c.subitem,
          name: c.name,
          context: c.context,
          immediateMs: c.immediateMs,
          immediateSes: c.immediateSes,
          immediateSms: c.immediateSms,
          weekly: c.weekly,
          notifyOn: c.notifyOn,
          deadlineStart: c.deadlineStart,
          sensitive: c.sensitive,
          once: c.once,
          normativeStatus: c.normativeStatus,
          normativeNote: c.normativeNote,
          sinanCode: c.sinanCode,
          active: true,
        };
        await sys.db.notifiableCondition.upsert({ where: { versionId_key: { versionId, key: c.key } }, create: { versionId, key: c.key, ...dados }, update: dados });
      }
      await sys.db.notifiableCondition.updateMany({ where: { versionId, key: { notIn: v.conditions.map((c) => c.key) } }, data: { active: false } });
      await sys.db.notifiableListVersion.update({ where: { id: versionId }, data: { contentHash: hash } });
    }
    await sys.db.notifiableCodeMap.createMany({
      data: MAPEAMENTOS_INICIAIS.map((m) => ({
        system: m.system,
        codePrefix: m.codePrefix,
        groupKey: m.group,
        context: m.context ?? null,
        status: m.status,
        source: m.source,
        homologatedAt: m.status === 'HOMOLOGADO' ? new Date() : null,
      })),
      skipDuplicates: true,
    });
    if ((await sys.db.surveillanceContact.count()) === 0) {
      await sys.db.surveillanceContact.create({
        data: {
          sphere: 'MS',
          label: 'CIEVS Nacional (Disque-Notifica)',
          phone: '0800-644-6645',
          email: 'notifica@saude.gov.br',
          formUrl: 'https://www.gov.br/saude/pt-br/composicao/svsa/cievs',
          hours: '24 horas',
          onCall: true,
          sort: 0,
        },
      });
    }
    this.prontos.add(sys.tenant.id);
  }

  /** Esquece o carregamento (testes que recriam o banco). */
  esquecer(tenantId: string) {
    this.prontos.delete(tenantId);
  }

  /** Retrato do catálogo na data AAAA-MM-DD: nacional vigente + estadual + municipal vigentes. */
  async retrato(sys: Sys, dia: string) {
    await this.garantir(sys);
    const versoes = await sys.db.notifiableListVersion.findMany({ orderBy: { validFrom: 'asc' } });
    const comDatas = versoes.map((v) => ({ ...v, validFrom: dataIso(v.validFrom)!, validTo: dataIso(v.validTo) }));
    const nacional = versaoNaData(
      comDatas.filter((v) => v.scope === 'NACIONAL'),
      dia,
    );
    const locais = (escopo: 'ESTADUAL' | 'MUNICIPAL') => comDatas.filter((v) => v.scope === escopo && v.validFrom <= dia && (!v.validTo || dia <= v.validTo));
    const ids = [nacional?.versao.id, ...locais('ESTADUAL').map((v) => v.id), ...locais('MUNICIPAL').map((v) => v.id)].filter((x): x is string => !!x);
    const linhas = (await sys.db.notifiableCondition.findMany({ where: { versionId: { in: ids }, active: true }, orderBy: [{ item: 'asc' }, { subitem: 'asc' }] })).map((l) => ({
      ...l,
      group: l.groupKey,
    })) as CondicaoNoRetrato[];
    const de = (vid?: string) => linhas.filter((l) => l.versionId === vid);
    const catalogo = mesclarCatalogo(
      de(nacional?.versao.id),
      locais('ESTADUAL').flatMap((v) => de(v.id)),
      locais('MUNICIPAL').flatMap((v) => de(v.id)),
    ).sort((a, b) => a.item - b.item || (a.subitem ?? '').localeCompare(b.subitem ?? ''));
    return { catalogo, versaoNacional: nacional?.versao ?? null, anteriorAoCatalogo: nacional?.anteriorAoCatalogo ?? false, locais: [...locais('ESTADUAL'), ...locais('MUNICIPAL')] };
  }

  /** Grupos de agravo de um código (prefixo mais longo entre os mapeamentos ativos). */
  async gruposDoCodigo(sys: Sys, system: 'CID10' | 'CIAP2', code: string) {
    await this.garantir(sys);
    const mapas = await sys.db.notifiableCodeMap.findMany({ where: { system, status: { not: 'INATIVO' } } });
    return mapearCodigo(mapas, system, code);
  }

  // ───────────────────────────── telas ─────────────────────────────

  async versoes(ctx: RequestContext) {
    await this.garantir(ctx);
    const rows = await ctx.db.notifiableListVersion.findMany({ orderBy: [{ scope: 'asc' }, { validFrom: 'desc' }], include: { _count: { select: { conditions: true } } } });
    const hoje = new Date().toISOString().slice(0, 10);
    return rows.map((v) => ({
      id: v.id,
      escopo: v.scope,
      uf: v.uf,
      ibgeCode: v.ibgeCode,
      ato: v.act,
      publicacao: v.publishedIn,
      atoUrl: v.actUrl,
      fonte: v.sourceUrl,
      hashFonte: v.sourceSha256,
      consultadoEm: dataIso(v.consultedAt),
      vigenteDe: dataIso(v.validFrom),
      vigenteAte: dataIso(v.validTo),
      vigente: dataIso(v.validFrom)! <= hoje && (!v.validTo || hoje <= dataIso(v.validTo)!),
      notas: v.notes,
      linhas: v._count.conditions,
    }));
  }

  async condicoesDaVersao(ctx: RequestContext, id: string) {
    const v = await ctx.db.notifiableListVersion.findUnique({ where: { id } });
    if (!v) throw notFound('Versão do catálogo');
    return ctx.db.notifiableCondition.findMany({ where: { versionId: id }, orderBy: [{ item: 'asc' }, { subitem: 'asc' }] });
  }

  async retratoNaData(ctx: RequestContext, dia: string) {
    const r = await this.retrato(ctx, dia);
    return {
      versaoNacional: r.versaoNacional ? { id: r.versaoNacional.id, ato: r.versaoNacional.act } : null,
      anteriorAoCatalogo: r.anteriorAoCatalogo,
      locais: r.locais.map((v) => ({ id: v.id, ato: v.act, escopo: v.scope })),
      condicoes: r.catalogo,
    };
  }

  /** Versão estadual ou municipal: acrescenta agravos ou sobrepõe a regra nacional (mesma chave). */
  async criarVersaoLocal(ctx: RequestContext, input: { scope: 'ESTADUAL' | 'MUNICIPAL'; act: string; validFrom: string; validTo?: string | null; notes?: string | null; conditions: NovaCondicaoLocal[] }) {
    await this.garantir(ctx);
    const unidade = await ctx.db.unit.findUniqueOrThrow({ where: { id: ctx.session.unitId }, select: { ibgeCode: true } });
    const ibge = unidade.ibgeCode;
    const uf = ibge.slice(0, 2);
    const scopeKey = input.scope === 'ESTADUAL' ? `ESTADUAL:${uf}` : `MUNICIPAL:${ibge}`;
    // Lista local acrescenta agravos (art. 2º do Anexo V): não substitui nem afrouxa uma linha nacional, nem entra
    // num grupo nacional (onde a troca de subitem poderia tirar o prazo ou o sigilo).
    const nacionais = await chavesNacionais(ctx);
    for (const c of input.conditions) {
      const imediata = c.immediateMs || c.immediateSes || c.immediateSms;
      if (c.weekly === imediata) throw new DomainError('PERIODICIDADE_INVALIDA', `"${c.name}": marque semanal ou ao menos uma esfera imediata, não os dois`, HttpStatus.BAD_REQUEST);
      if (nacionais.chaves.has(c.key) || nacionais.grupos.has(c.groupKey ?? c.key))
        throw new DomainError('AGRAVO_NACIONAL', `"${c.name}" já está na lista nacional: a lista local só acrescenta agravos`, HttpStatus.BAD_REQUEST);
    }
    const sobrepostas = await ctx.db.notifiableListVersion.findMany({
      where: { scopeKey, OR: [{ validTo: null }, { validTo: { gte: comoData(input.validFrom) } }], ...(input.validTo ? { validFrom: { lte: comoData(input.validTo) } } : {}) },
    });
    if (sobrepostas.length) throw new DomainError('VERSAO_SOBREPOSTA', 'Já existe versão deste escopo vigente nesse período: encerre a anterior antes', HttpStatus.CONFLICT);
    const v = await ctx.db.notifiableListVersion.create({
      data: {
        scope: input.scope,
        scopeKey,
        uf: input.scope === 'ESTADUAL' ? uf : null,
        ibgeCode: input.scope === 'MUNICIPAL' ? ibge : null,
        act: input.act,
        validFrom: comoData(input.validFrom),
        validTo: input.validTo ? comoData(input.validTo) : null,
        notes: input.notes ?? null,
        createdBy: ctx.session.userId,
        conditions: {
          create: input.conditions.map((c) => {
            const imediata = c.immediateMs || c.immediateSes || c.immediateSms;
            return {
              key: c.key,
              groupKey: c.groupKey ?? c.key,
              item: c.item,
              subitem: c.subitem ?? null,
              name: c.name,
              context: c.context ?? 'CASO',
              immediateMs: c.immediateMs,
              immediateSes: c.immediateSes,
              immediateSms: c.immediateSms,
              weekly: c.weekly,
              notifyOn: c.notifyOn ?? 'SUSPEITA',
              deadlineStart: c.deadlineStart ?? (imediata ? 'ATENDIMENTO' : 'CONHECIMENTO'),
              sensitive: c.sensitive ?? false,
              once: c.once ?? false,
              normativeNote: c.normativeNote ?? null,
            };
          }),
        },
      },
    });
    await this.audit.recordStandalone(ctx, {
      action: 'vigilancia.catalogo_local',
      entityType: 'NotifiableListVersion',
      entityId: v.id,
      payload: { scopeKey, act: input.act, validFrom: input.validFrom, linhas: input.conditions.length },
    });
    return (await this.versoes(ctx)).find((x) => x.id === v.id);
  }

  // ───────────────────────────── de-para de códigos ─────────────────────────────

  async codigos(ctx: RequestContext, q: { busca?: string; status?: string }) {
    await this.garantir(ctx);
    const busca = q.busca?.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    return ctx.db.notifiableCodeMap.findMany({
      where: {
        ...(q.status ? { status: q.status as 'PROPOSTO' } : {}),
        ...(busca ? { OR: [{ codePrefix: { startsWith: busca.slice(0, 5) } }, { groupKey: { contains: q.busca!.toLowerCase() } }] } : {}),
      },
      orderBy: [{ groupKey: 'asc' }, { system: 'asc' }, { codePrefix: 'asc' }],
      take: 500,
    });
  }

  async novoCodigo(ctx: RequestContext, input: { system: 'CID10' | 'CIAP2'; codePrefix: string; groupKey: string; context?: ContextoAgravo | null; source: string }) {
    const codePrefix = input.codePrefix.toUpperCase().replace(/\./g, '');
    const existe = await ctx.db.notifiableCondition.findFirst({ where: { groupKey: input.groupKey } });
    if (!existe) throw new DomainError('GRUPO_INEXISTENTE', `Grupo de agravo "${input.groupKey}" não existe no catálogo`, HttpStatus.BAD_REQUEST);
    const m = await ctx.db.notifiableCodeMap.create({
      data: { system: input.system, codePrefix, groupKey: input.groupKey, context: input.context ?? null, source: input.source, status: 'PROPOSTO', createdBy: ctx.session.userId },
    });
    await this.audit.recordStandalone(ctx, { action: 'vigilancia.codigo_novo', entityType: 'NotifiableCodeMap', entityId: m.id, payload: input });
    return m;
  }

  async homologar(ctx: RequestContext, ids: string[]) {
    const r = await ctx.db.notifiableCodeMap.updateMany({ where: { id: { in: ids }, status: 'PROPOSTO' }, data: { status: 'HOMOLOGADO', homologatedBy: ctx.session.userId, homologatedAt: new Date() } });
    await this.audit.recordStandalone(ctx, { action: 'vigilancia.codigo_homologar', entityType: 'NotifiableCodeMap', payload: { ids, homologados: r.count } });
    return { homologados: r.count };
  }

  async alterarCodigo(ctx: RequestContext, id: string, status: 'PROPOSTO' | 'HOMOLOGADO' | 'INATIVO') {
    const m = await ctx.db.notifiableCodeMap.findUnique({ where: { id } });
    if (!m) throw notFound('Mapeamento');
    const r = await ctx.db.notifiableCodeMap.update({ where: { id }, data: { status, ...(status === 'HOMOLOGADO' ? { homologatedBy: ctx.session.userId, homologatedAt: new Date() } : {}) } });
    await this.audit.recordStandalone(ctx, { action: 'vigilancia.codigo_status', entityType: 'NotifiableCodeMap', entityId: id, payload: { de: m.status, para: status } });
    return r;
  }
}
