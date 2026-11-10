import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TenantPrisma, type MasterClient } from '@omnisaude/database';
import {
  localDateString,
  roleHasPermission,
  type AmostraAlteracao,
  type AmostraRegistro,
  type ArquivoDetectado,
  type ConsultaEnvioImportacao,
  type ContagensImportacao,
  type DetalheImportacao,
  type ListaImportacoes,
  type PreviaImportacao,
  type RespostaEnvioImportacao,
  type ResultadoAplicacao,
  type ResultadoDescarte,
  type ResumoImportacao,
  type SistemaOficial,
  type SituacaoCaso,
  type StatusImportacao,
  type TipoRegistroOficial,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { MASTER_DB } from '../../core/database';
import { conflict, DomainError, notFound } from '../../core/errors';
import { ConciliacaoService } from './conciliacao.service';
import { gruposSigilosos, grupoDoCidFabrica, municipioDoTenant, municipiosPorNome } from './importacao/apoio';
import { ErroArquivo } from './importacao/dbf';
import { chaveDoEnvio, coberturaDoEnvio, lerEnvio, MAX_AMOSTRAS, type Cobertura, type RegistroDoEnvio } from './importacao/leitura';
import { aplicarParte, CAMPOS_IDENTIFICACAO, colunasDoEstado, diferencas, estadoDoBanco, estadoVazio, hashDoEstado, mesmasFontes, SELECT_ESTADO, type EstadoRegistro, type LinhaEstado } from './importacao/mescla';
import { situacaoDoRegistro } from './importacao/normalizar';
import { gravarPayload, lerPayload, type PayloadImportacao } from './importacao/payload';
import { NegativaService } from './negativa.service';

/**
 * Importação das exportações oficiais (VIG-1c, §4.1; frente F2): lê, detecta, normaliza e grava a PREVIA com as
 * contagens e o payload; aplicar refaz a comparação na transação (upsert pela chave, mescla por campo, ausentes,
 * unidades pelo CNES), roda a conciliação automática e reconcilia a negativa das unidades e semanas tocadas.
 */

type Db = TenantPrisma.TransactionClient;
const HORA = 3_600_000;
/** Registros por comando nas gravações em lote. */
const LOTE = 500;

/** Registro do banco com o estado e os campos que a prévia e as listas usam. */
type LinhaBanco = LinhaEstado & { system: string; type: string; naturalKey: string; contentHash: string; absentSince: Date | null; notificationId: string | null };

interface Comparado {
  r: RegistroDoEnvio;
  antes: EstadoRegistro;
  depois: EstadoRegistro;
  hash: string;
  linha: LinhaBanco | null;
}

const dia = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const txt = (v: unknown) => (typeof v === 'string' && v ? v : null);

@Injectable()
export class ImportacaoService {
  private readonly logger = new Logger('Importacao');

  constructor(
    private readonly audit: AuditService,
    private readonly conciliacao: ConciliacaoService,
    private readonly moduleRef: ModuleRef,
    @Inject(MASTER_DB) private readonly master: MasterClient,
  ) {}

  /** O NegativaService pela referência do módulo (sem ciclo de injeção com o job 'vigilancia'). */
  private negativas(): NegativaService {
    return this.moduleRef.get(NegativaService, { strict: false });
  }

  // ───────────────────────────── comparação com o banco ─────────────────────────────

  /** Registros do banco com a mesma chave (sistema, tipo e chave natural) dos registros do envio. */
  private async existentes(db: Db, registros: RegistroDoEnvio[]): Promise<Map<string, LinhaBanco>> {
    const porGrupo = new Map<string, { sistema: SistemaOficial; tipo: TipoRegistroOficial; chaves: string[] }>();
    for (const r of registros) {
      const k = `${r.sistema}|${r.tipo}`;
      const g = porGrupo.get(k) ?? { sistema: r.sistema, tipo: r.tipo, chaves: [] };
      g.chaves.push(r.chave);
      porGrupo.set(k, g);
    }
    const mapa = new Map<string, LinhaBanco>();
    for (const g of porGrupo.values())
      for (let i = 0; i < g.chaves.length; i += 2000) {
        const rows = await db.officialRecord.findMany({ where: { system: g.sistema, type: g.tipo, naturalKey: { in: g.chaves.slice(i, i + 2000) } }, select: SELECT_ESTADO });
        for (const row of rows) mapa.set(chaveDoEnvio(row.system, row.type, row.naturalKey), row as LinhaBanco);
      }
    return mapa;
  }

  /** Estado de cada registro do envio depois da mescla, com o estado anterior do banco. */
  private comparar(registros: RegistroDoEnvio[], existentes: Map<string, LinhaBanco>): Comparado[] {
    return registros.map((r) => {
      const linha = existentes.get(chaveDoEnvio(r.sistema, r.tipo, r.chave)) ?? null;
      const antes = linha ? estadoDoBanco(linha) : estadoVazio();
      const depois = r.partes.reduce(aplicarParte, antes);
      return { r, antes, depois, hash: hashDoEstado(r.sistema, r.tipo, depois), linha };
    });
  }

  /** Registros do banco dentro da cobertura do envio que não vieram nele (e ainda não estavam ausentes). */
  private async ausentes(db: Db, cobertura: Cobertura[], chaves: Set<string>) {
    const out: {
      id: string;
      system: string;
      type: string;
      naturalKey: string;
      number: string;
      notifiedOn: Date;
      agravo: string | null;
      groupKey: string | null;
      unitCnes: string | null;
      situation: string;
      patientName: string | null;
      sensitive: boolean;
    }[] = [];
    for (const c of cobertura) {
      const agravos = c.agravos.filter((a): a is string => !!a);
      const rows = await db.officialRecord.findMany({
        where: {
          system: c.sistema,
          type: c.tipo,
          absentSince: null,
          notifiedOn: { gte: new Date(`${c.de}T00:00:00Z`), lte: new Date(`${c.ate}T00:00:00Z`) },
          AND: [
            { OR: [...(agravos.length ? [{ agravo: { in: agravos } }] : []), ...(c.agravos.includes(null) ? [{ agravo: null }] : [])] },
            { OR: [...c.municipios.map((m) => ({ municipalityIbge: { startsWith: m } })), ...(c.municipioNulo ? [{ municipalityIbge: null }] : [])] },
          ],
        },
        select: { id: true, system: true, type: true, naturalKey: true, number: true, notifiedOn: true, agravo: true, groupKey: true, unitCnes: true, situation: true, patientName: true, sensitive: true },
      });
      for (const row of rows) if (!chaves.has(chaveDoEnvio(row.system, row.type, row.naturalKey))) out.push(row);
    }
    return out;
  }

  private amostra(c: Comparado): AmostraRegistro {
    const v = c.depois.valores;
    const agravo = txt(v.agravo);
    return {
      chave: c.r.chave,
      tipo: c.r.tipo,
      numero: txt(v.numero) ?? c.r.partes[0]!.numero,
      notificadoEm: txt(v.notificadoEm) ?? c.r.partes[0]!.notificadoEm,
      agravo,
      grupo: txt(v.grupo),
      cnes: txt(v.cnes),
      situacao: situacaoDoRegistro(c.r.sistema, agravo, txt(v.classificacao), txt(v.criterio)),
      paciente: txt(v.nome),
      sigiloso: c.r.partes.some((p) => p.sigiloso),
    };
  }

  // ───────────────────────────── envio ─────────────────────────────

  /** POST /vigilancia/importacoes (corpo cru). Mesmo SHA-256 já aplicado: `{ jaImportado }`, sem criar nada. */
  async enviar(ctx: RequestContext, arquivo: Buffer, consulta: ConsultaEnvioImportacao): Promise<RespostaEnvioImportacao> {
    if (!arquivo.length) throw new DomainError('ARQUIVO_VAZIO', 'Arquivo vazio', HttpStatus.BAD_REQUEST);
    if (!!consulta.de !== !!consulta.ate) throw new DomainError('PERIODO_INVALIDO', 'Informe o início e o fim do período, ou nenhum dos dois', HttpStatus.BAD_REQUEST);
    if (consulta.de && consulta.ate && consulta.de > consulta.ate) throw new DomainError('PERIODO_INVALIDO', 'O início do período vem depois do fim', HttpStatus.BAD_REQUEST);
    const sha256 = createHash('sha256').update(arquivo).digest('hex');
    const aplicada = await ctx.db.officialImport.findFirst({ where: { sha256, status: 'APLICADA' }, select: { id: true, appliedAt: true } });
    if (aplicada) return { jaImportado: { id: aplicada.id, aplicadoEm: (aplicada.appliedAt ?? new Date()).toISOString() } };

    const { ibge } = await municipioDoTenant(this.master, ctx.tenant.id);
    const [sensiveis, grupoDoCid, porNome] = await Promise.all([gruposSigilosos(ctx.db), grupoDoCidFabrica(ctx.db), municipiosPorNome(ctx.db)]);
    const hoje = localDateString(new Date(), ctx.tenant.timeZone);
    let leitura: ReturnType<typeof lerEnvio>;
    try {
      leitura = lerEnvio(consulta.nome, new Uint8Array(arquivo.buffer, arquivo.byteOffset, arquivo.byteLength), {
        codificacao: consulta.codificacao,
        hoje,
        municipio: ibge,
        sensiveis,
        grupoDoCid,
        municipiosPorNome: porNome,
      });
    } catch (e) {
      if (e instanceof ErroArquivo) throw new DomainError('ARQUIVO_RECUSADO', e.message, HttpStatus.UNPROCESSABLE_ENTITY);
      throw e;
    }
    const validos = leitura.arquivos.filter((a) => !a.ignorado);
    if (!validos.length) throw new DomainError('SEM_REGISTROS', `Nenhum arquivo com notificações reconhecidas. ${leitura.avisos.join(' ')}`.trim(), HttpStatus.UNPROCESSABLE_ENTITY, { arquivos: leitura.arquivos });
    if (!leitura.registros.length)
      throw new DomainError('SEM_REGISTROS', `Nenhum registro válido no envio (${leitura.recusados} recusado(s)).`, HttpStatus.UNPROCESSABLE_ENTITY, {
        arquivos: leitura.arquivos,
        motivosRecusa: leitura.motivosRecusa,
      });

    const declarado = consulta.de && consulta.ate ? { de: consulta.de, ate: consulta.ate } : null;
    const cobertura = coberturaDoEnvio(leitura.registros, declarado, ibge);
    const comparados = this.comparar(leitura.registros, await this.existentes(ctx.db, leitura.registros));
    const chaves = new Set(leitura.registros.map((r) => chaveDoEnvio(r.sistema, r.tipo, r.chave)));
    const ausentes = await this.ausentes(ctx.db, cobertura, chaves);

    const novos = comparados.filter((c) => !c.linha);
    const alterados = comparados.filter((c) => c.linha && c.hash !== c.linha.contentHash);
    const porTipo: ContagensImportacao['porTipo'] = {};
    for (const r of leitura.registros) porTipo[r.tipo] = (porTipo[r.tipo] ?? 0) + 1;
    const contagens: ContagensImportacao = {
      lidos: leitura.lidos,
      novos: novos.length,
      alterados: alterados.length,
      iguais: comparados.length - novos.length - alterados.length,
      recusados: leitura.recusados,
      duplicadosNoArquivo: leitura.duplicadosNoArquivo,
      ausentesPrevistos: ausentes.length,
      motivosRecusa: leitura.motivosRecusa,
      porTipo,
    };
    const previa: PreviaImportacao = {
      novos: novos.slice(0, MAX_AMOSTRAS).map((c) => this.amostra(c)),
      alterados: alterados.slice(0, MAX_AMOSTRAS).map((c) => ({ ...this.amostra(c), campos: diferencas(c.antes, c.depois) })),
      recusados: leitura.recusas,
      duplicados: leitura.duplicados,
      ausentes: ausentes.slice(0, MAX_AMOSTRAS).map((a) => ({
        chave: a.naturalKey,
        tipo: a.type as TipoRegistroOficial,
        numero: a.number,
        notificadoEm: dia(a.notifiedOn)!,
        agravo: a.agravo,
        grupo: a.groupKey,
        cnes: a.unitCnes,
        situacao: a.situation as SituacaoCaso,
        paciente: a.patientName,
        sigiloso: a.sensitive,
      })),
    };

    // Sistema predominante, período e avisos do envio.
    const contagemSistema = new Map<SistemaOficial, number>();
    for (const r of leitura.registros) contagemSistema.set(r.sistema, (contagemSistema.get(r.sistema) ?? 0) + 1);
    const sistema = [...contagemSistema].sort((a, b) => b[1] - a[1])[0]![0];
    const datas = validos.flatMap((a) => (a.periodo ? [a.periodo.de, a.periodo.ate] : [])).sort();
    const periodo = declarado ?? (datas.length ? { de: datas[0]!, ate: datas[datas.length - 1]! } : null);
    const avisos = [...leitura.avisos];
    if (declarado) {
      const fora = leitura.registros.filter((r) => {
        const d = r.partes[r.partes.length - 1]!.notificadoEm;
        return d < declarado.de || d > declarado.ate;
      }).length;
      if (fora) avisos.push(`${fora} registro(s) com data da notificação fora do período declarado: entram, mas o período declarado é que define os ausentes.`);
    }
    if (validos.some((a) => a.tipo === 'ESUS_NOTIFICA_CSV'))
      avisos.push('e-SUS Notifica: exporte com o perfil de gestor municipal (o autocadastro só traz as notificações do próprio CNES) e um arquivo por ano de notificação.');
    if (validos.some((a) => a.sistema === 'SINAN_ONLINE')) avisos.push('Sinan Online: a mesma solicitação em menos de 24 horas devolve o mesmo arquivo, e o período não cruza o ano.');

    // JSON e gzip fora da transação (trabalho de CPU sem segurar a conexão).
    const payload = gravarPayload({ versao: 1, registros: leitura.registros, cobertura } satisfies PayloadImportacao);
    const agora = new Date();
    const imp = await ctx.db.$transaction(async (tx) => {
      // A prévia anterior do mesmo arquivo (troca de codificação, reenvio) é descartada.
      await tx.officialImport.updateMany({
        where: { sha256, status: 'PREVIA' },
        data: { status: 'DESCARTADA', payload: null, preview: TenantPrisma.DbNull, discardedBy: ctx.session.userId, discardedAt: agora },
      });
      const criada = await tx.officialImport.create({
        data: {
          system: sistema,
          fileName: consulta.nome.slice(0, 255),
          sha256,
          sizeBytes: arquivo.length,
          files: leitura.arquivos as unknown as TenantPrisma.InputJsonValue,
          periodFrom: periodo ? new Date(`${periodo.de}T00:00:00Z`) : null,
          periodTo: periodo ? new Date(`${periodo.ate}T00:00:00Z`) : null,
          declaredPeriod: !!declarado,
          identified: validos.some((a) => a.identificado),
          counts: contagens as unknown as TenantPrisma.InputJsonValue,
          preview: previa as unknown as TenantPrisma.InputJsonValue,
          payload,
          warnings: avisos,
          createdBy: ctx.session.userId,
        },
        select: { id: true },
      });
      await this.audit.record(ctx, tx, {
        action: 'vigilancia.importacao_previa',
        entityType: 'OfficialImport',
        entityId: criada.id,
        payload: {
          arquivo: consulta.nome,
          sha256,
          tamanho: arquivo.length,
          sistema,
          arquivos: leitura.arquivos.map((a) => ({ nome: a.nome, tipo: a.tipo, registros: a.registros, identificado: a.identificado })),
          contagens: { ...contagens, motivosRecusa: undefined },
        },
      });
      return criada;
    });
    return this.detalhe(ctx, imp.id, { auditar: false });
  }

  // ───────────────────────────── consultas ─────────────────────────────

  private async nomes(ctx: RequestContext, ids: (string | null)[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unicos.length) return new Map();
    const users = await ctx.db.user.findMany({ where: { id: { in: unicos } }, select: { id: true, name: true, socialName: true } });
    return new Map(users.map((u) => [u.id, u.socialName ?? u.name]));
  }

  private resumo(
    imp: {
      id: string;
      system: SistemaOficial;
      status: StatusImportacao;
      fileName: string;
      sizeBytes: number;
      periodFrom: Date | null;
      periodTo: Date | null;
      declaredPeriod: boolean;
      identified: boolean;
      counts: unknown;
      createdAt: Date;
      createdBy: string;
      appliedAt: Date | null;
      appliedBy: string | null;
      discardedAt: Date | null;
      discardedBy: string | null;
    },
    nomes: Map<string, string>,
  ): ResumoImportacao {
    return {
      id: imp.id,
      sistema: imp.system,
      status: imp.status,
      arquivo: imp.fileName,
      tamanhoBytes: imp.sizeBytes,
      periodo: imp.periodFrom && imp.periodTo ? { de: dia(imp.periodFrom)!, ate: dia(imp.periodTo)! } : null,
      periodoDeclarado: imp.declaredPeriod,
      identificado: imp.identified,
      contagens: imp.counts as ContagensImportacao,
      criadoEm: imp.createdAt.toISOString(),
      criadoPor: nomes.get(imp.createdBy) ?? null,
      aplicadoEm: imp.appliedAt?.toISOString() ?? null,
      aplicadoPor: imp.appliedBy ? (nomes.get(imp.appliedBy) ?? null) : null,
      descartadoEm: imp.discardedAt?.toISOString() ?? null,
      descartadoPor: imp.discardedBy ? (nomes.get(imp.discardedBy) ?? null) : null,
      expirada: imp.status === 'DESCARTADA' && !imp.discardedBy,
    };
  }

  private readonly selectResumo = {
    id: true,
    system: true,
    status: true,
    fileName: true,
    sizeBytes: true,
    periodFrom: true,
    periodTo: true,
    declaredPeriod: true,
    identified: true,
    counts: true,
    createdAt: true,
    createdBy: true,
    appliedAt: true,
    appliedBy: true,
    discardedAt: true,
    discardedBy: true,
  } as const;

  /** GET /vigilancia/importacoes. */
  async listar(ctx: RequestContext): Promise<ListaImportacoes> {
    const rows = await ctx.db.officialImport.findMany({ orderBy: { createdAt: 'desc' }, take: 200, select: this.selectResumo });
    const nomes = await this.nomes(
      ctx,
      rows.flatMap((r) => [r.createdBy, r.appliedBy, r.discardedBy]),
    );
    return rows.map((r) => this.resumo(r, nomes));
  }

  /** GET /vigilancia/importacoes/:id. Sem `notificacao.sensivel`, o nome do registro sigiloso não aparece na prévia. */
  async detalhe(ctx: RequestContext, id: string, opts: { auditar?: boolean } = {}): Promise<DetalheImportacao> {
    const imp = await ctx.db.officialImport.findUnique({ where: { id }, select: { ...this.selectResumo, sha256: true, files: true, preview: true, warnings: true } });
    if (!imp) throw notFound('Importação');
    const nomes = await this.nomes(ctx, [imp.createdBy, imp.appliedBy, imp.discardedBy]);
    const sensivel = roleHasPermission(ctx.session.role, 'notificacao.sensivel');
    const bruta = imp.preview as PreviaImportacao | null;
    const mascarar = <T extends AmostraRegistro>(a: T): T => (a.sigiloso && !sensivel ? { ...a, paciente: null } : a);
    const previa: PreviaImportacao | null = bruta
      ? {
          novos: bruta.novos.map(mascarar),
          alterados: bruta.alterados.map((a): AmostraAlteracao => {
            const m = mascarar(a);
            return a.sigiloso && !sensivel ? { ...m, campos: m.campos.filter((c) => !(CAMPOS_IDENTIFICACAO as readonly string[]).includes(c.campo)) } : m;
          }),
          recusados: bruta.recusados,
          duplicados: bruta.duplicados,
          ausentes: bruta.ausentes.map(mascarar),
        }
      : null;
    // A prévia é uma lista nominal: quem a abre fica na trilha (como na exportação CSV).
    const nominais = previa ? [...previa.novos, ...previa.alterados, ...previa.ausentes].filter((a) => a.paciente) : [];
    if (opts.auditar !== false && nominais.length)
      await this.audit.recordStandalone(ctx, {
        action: 'vigilancia.importacao_ver_previa',
        entityType: 'OfficialImport',
        entityId: id,
        payload: { nominais: nominais.length, sigilosos: nominais.filter((a) => a.sigiloso).length },
      });
    const horas = ctx.tenant.settings.vigilancia.consolidacao.expiraPreviaHoras;
    return {
      ...this.resumo(imp, nomes),
      sha256: imp.sha256,
      arquivos: imp.files as unknown as ArquivoDetectado[],
      previa,
      avisos: (imp.warnings ?? []) as string[],
      expiraEm: imp.status === 'PREVIA' ? new Date(imp.createdAt.getTime() + horas * HORA).toISOString() : null,
    };
  }

  // ───────────────────────────── aplicação ─────────────────────────────

  /** POST /vigilancia/importacoes/:id/aplicar. */
  async aplicar(ctx: RequestContext, id: string): Promise<ResultadoAplicacao> {
    const imp = await ctx.db.officialImport.findUnique({
      where: { id },
      select: { id: true, status: true, sha256: true, payload: true, counts: true, createdAt: true, discardedBy: true, fileName: true, warnings: true },
    });
    if (!imp) throw notFound('Importação');
    if (imp.status === 'APLICADA') throw conflict('A importação já foi aplicada');
    if (imp.status === 'DESCARTADA') throw conflict(imp.discardedBy ? 'A prévia foi descartada' : 'A prévia expirou: envie o arquivo de novo');
    const horas = ctx.tenant.settings.vigilancia.consolidacao.expiraPreviaHoras;
    if (imp.createdAt.getTime() + horas * HORA < Date.now()) {
      await this.expirarPrevias(ctx.db, new Date(), horas);
      throw conflict('A prévia expirou: envie o arquivo de novo');
    }
    if (!imp.payload) throw conflict('A prévia não tem mais os registros: envie o arquivo de novo');
    const dados = lerPayload(imp.payload);
    const sensiveis = await gruposSigilosos(ctx.db);
    const agora = new Date();
    const avisos: string[] = [];

    const resultado = await ctx.db
      .$transaction(
        async (tx) => {
          // Uma aplicação por vez (a mesma chave pode vir em dois envios ao mesmo tempo).
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('vigilancia:importacao'))`;
          const atual = await tx.officialImport.findUnique({ where: { id }, select: { status: true } });
          if (atual?.status !== 'PREVIA') throw conflict('A importação mudou: abra de novo');
          if (await tx.officialImport.findFirst({ where: { sha256: imp.sha256, status: 'APLICADA' }, select: { id: true } })) throw conflict('Este arquivo já foi aplicado');

          const comparados = this.comparar(dados.registros, await this.existentes(tx, dados.registros));
          let novos = 0;
          let alterados = 0;
          let iguais = 0;
          let voltaram = 0;
          const vinculadosAlterados: string[] = [];
          const criar: Comparado[] = [];
          const tocar: string[] = [];
          for (const c of comparados) {
            if (!c.linha) {
              criar.push(c);
              continue;
            }
            if (c.linha.absentSince) voltaram++;
            if (c.hash !== c.linha.contentHash) {
              alterados++;
              if (c.linha.notificationId) vinculadosAlterados.push(c.linha.id);
              await tx.officialRecord.update({
                where: { id: c.linha.id },
                data: { ...colunasDoEstado(c.r.sistema, c.depois, sensiveis), contentHash: c.hash, lastImportId: id, lastSeenAt: agora, absentSince: null },
              });
            } else {
              iguais++;
              if (!mesmasFontes(c.antes.fontes, c.depois.fontes))
                await tx.officialRecord.update({ where: { id: c.linha.id }, data: { data: colunasDoEstado(c.r.sistema, c.depois, sensiveis).data, lastImportId: id, lastSeenAt: agora, absentSince: null } });
              else tocar.push(c.linha.id);
            }
          }
          for (let i = 0; i < tocar.length; i += 5000) await tx.officialRecord.updateMany({ where: { id: { in: tocar.slice(i, i + 5000) } }, data: { lastImportId: id, lastSeenAt: agora, absentSince: null } });
          for (let i = 0; i < criar.length; i += LOTE) {
            const lote = criar.slice(i, i + LOTE);
            await tx.officialRecord.createMany({
              data: lote.map((c) => ({
                system: c.r.sistema,
                type: c.r.tipo,
                naturalKey: c.r.chave,
                ...colunasDoEstado(c.r.sistema, c.depois, sensiveis),
                contentHash: c.hash,
                firstImportId: id,
                lastImportId: id,
                lastSeenAt: agora,
              })),
            });
            novos += lote.length;
          }

          // Ausentes: só dentro da cobertura do envio (sistema, tipo, agravos, período e municípios). Nunca apaga.
          const chaves = new Set(dados.registros.map((r) => chaveDoEnvio(r.sistema, r.tipo, r.chave)));
          const ausentes = await this.ausentes(tx, dados.cobertura, chaves);
          for (let i = 0; i < ausentes.length; i += 5000) await tx.officialRecord.updateMany({ where: { id: { in: ausentes.slice(i, i + 5000).map((a) => a.id) } }, data: { absentSince: agora } });

          // Unidades pelo CNES.
          const ligadas = await tx.$executeRaw`
            UPDATE official_records r SET unit_id = u.id FROM units u
            WHERE r.last_import_id = ${id}::uuid AND u.cnes = r.unit_cnes AND r.unit_id IS DISTINCT FROM u.id`;
          await tx.$executeRaw`
            UPDATE official_records r SET unit_id = NULL
            WHERE r.last_import_id = ${id}::uuid AND r.unit_id IS NOT NULL
              AND (r.unit_cnes IS NULL OR NOT EXISTS (SELECT 1 FROM units u WHERE u.cnes = r.unit_cnes))`;

          // Conciliação automática (degraus 1 e 2) e divergências dos pares que mudaram.
          const tocados = await tx.officialRecord.findMany({ where: { lastImportId: id }, select: { id: true, unitId: true, epiWeekNotified: true } });
          const vinculados = await this.conciliacao.conciliarAutomatico(tx, { recordIds: tocados.map((t) => t.id), timeZone: ctx.tenant.timeZone });
          await this.conciliacao.atualizarDivergencias(tx, vinculadosAlterados);

          const anteriores = imp.counts as unknown as ContagensImportacao;
          const contagens: ContagensImportacao = { ...anteriores, novos, alterados, iguais, ausentesPrevistos: ausentes.length };
          const { count } = await tx.officialImport.updateMany({
            where: { id, status: 'PREVIA' },
            data: { status: 'APLICADA', appliedBy: ctx.session.userId, appliedAt: agora, payload: null, preview: TenantPrisma.DbNull, counts: contagens as unknown as TenantPrisma.InputJsonValue },
          });
          if (count !== 1) throw conflict('A importação mudou: abra de novo');
          await this.audit.record(ctx, tx, {
            action: 'vigilancia.importacao_aplicada',
            entityType: 'OfficialImport',
            entityId: id,
            payload: { arquivo: imp.fileName, sha256: imp.sha256, contagens: { ...contagens, motivosRecusa: undefined }, ausentesMarcados: ausentes.length, voltaram, unidadesLigadas: ligadas, vinculados },
          });
          const unidades = [...new Set(tocados.map((t) => t.unitId).filter((u): u is string => !!u))];
          const semanas = [...new Set(tocados.map((t) => t.epiWeekNotified?.trim()).filter((s): s is string => !!s))];
          return { contagens, ausentesMarcados: ausentes.length, voltaram, unidadesLigadas: ligadas, vinculados, unidades, semanas };
        },
        { timeout: 600_000, maxWait: 30_000 },
      )
      .catch((e: unknown) => {
        if ((e as { code?: string }).code === 'P2002') throw conflict('Este arquivo (ou um registro dele) acabou de ser aplicado por outra pessoa: abra de novo');
        throw e;
      });

    // A reconciliação da negativa fica fora da transação: se falhar, a importação vale e o job tenta de novo.
    let negativasCanceladas = 0;
    if (resultado.unidades.length) {
      try {
        negativasCanceladas = await this.negativas().reconciliar(ctx.db, { unitIds: resultado.unidades, semanas: resultado.semanas });
      } catch (e) {
        this.logger.error(`Reconciliação da negativa depois da importação ${id}: ${(e as Error).message}`);
        avisos.push('A reconciliação da notificação negativa não rodou agora; o job da vigilância tenta de novo em alguns minutos.');
      }
    }
    return {
      id,
      aplicadoEm: agora.toISOString(),
      contagens: resultado.contagens,
      ausentesMarcados: resultado.ausentesMarcados,
      voltaram: resultado.voltaram,
      unidadesLigadas: resultado.unidadesLigadas,
      vinculadosAutomaticamente: resultado.vinculados,
      negativasCanceladas,
      avisos,
    };
  }

  /** POST /vigilancia/importacoes/:id/descartar. */
  async descartar(ctx: RequestContext, id: string): Promise<ResultadoDescarte> {
    const agora = new Date();
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.officialImport.updateMany({
        where: { id, status: 'PREVIA' },
        data: { status: 'DESCARTADA', payload: null, preview: TenantPrisma.DbNull, discardedBy: ctx.session.userId, discardedAt: agora },
      });
      if (count !== 1) {
        const imp = await tx.officialImport.findUnique({ where: { id }, select: { status: true } });
        if (!imp) throw notFound('Importação');
        throw conflict(imp.status === 'APLICADA' ? 'A importação já foi aplicada' : 'A prévia já foi descartada');
      }
      await this.audit.record(ctx, tx, { action: 'vigilancia.importacao_descartada', entityType: 'OfficialImport', entityId: id, payload: {} });
    });
    return { id, status: 'DESCARTADA', descartadoEm: agora.toISOString() };
  }

  /**
   * Job 'vigilancia': a PREVIA com mais de `horas` vira DESCARTADA e perde o payload. Devolve quantas expiraram.
   * `horas` é obrigatório: o job passa `sys.tenant.settings.vigilancia.consolidacao.expiraPreviaHoras` (com um padrão
   * fixo aqui, a configuração do tenant seria ignorada sem aviso).
   */
  async expirarPrevias(db: TenantPrisma.TransactionClient, agora: Date, horas: number): Promise<number> {
    const { count } = await db.officialImport.updateMany({
      where: { status: 'PREVIA', createdAt: { lt: new Date(agora.getTime() - horas * HORA) } },
      data: { status: 'DESCARTADA', payload: null, preview: TenantPrisma.DbNull, discardedAt: agora },
    });
    return count;
  }
}
