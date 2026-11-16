import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { AcumuladorCobertura, chaveDoEnvio, lerEnvio, MAX_AMOSTRAS, type Cobertura, type LeituraEnvio, type RegistroDoEnvio } from './importacao/leitura';
import { aplicarParte, CAMPOS_IDENTIFICACAO, colunasDoEstado, diferencas, estadoDoBanco, estadoVazio, hashDoEstado, mesmasFontes, SELECT_ESTADO, type EstadoRegistro, type LinhaEstado } from './importacao/mescla';
import { situacaoDoRegistro } from './importacao/normalizar';
import { EscritorPayload, LeitorPayload } from './importacao/payload';
import { Ritmo } from './importacao/ritmo';
import { NegativaService } from './negativa.service';

/**
 * Importação das exportações oficiais (VIG-1c, §4.1; frente F2): lê, detecta, normaliza e grava a PREVIA com as
 * contagens e o payload; aplicar refaz a comparação na transação (upsert pela chave, mescla por campo, ausentes,
 * unidades pelo CNES), roda a conciliação automática e reconcilia a negativa das unidades e semanas tocadas.
 *
 * Memória (container de 1 GiB): o envio é lido em fluxo e comparado em lotes; o payload vai para um arquivo temporário
 * com gzip e daí para o banco em fatias; a aplicação o lê em fatias e em lotes. Uma prévia ou aplicação por vez neste
 * processo: a outra recebe 409.
 */

type Db = TenantPrisma.TransactionClient;
const HORA = 3_600_000;
/**
 * Registros por INSERT. O Prisma 7 guarda os argumentos das últimas 100 chamadas de `debug()` (mesmo com o DEBUG
 * desligado), inclusive o plano de cada consulta: um `createMany` de 500 linhas deixava uns 2 MB presos por chamada (até
 * ~225 MB). Por isso o INSERT é SQL com um parâmetro JSON só, e em lotes pequenos (uns 100 KB por comando).
 */
const LOTE = 250;
/** Registros comparados com o banco por vez (prévia e aplicação). */
const LOTE_COMPARACAO = 500;
/** Linhas por página na contagem dos ausentes e na conciliação dos registros tocados. */
const PAGINA = 5000;
/** Fatia do payload gravada ou lida por comando no banco. */
const FATIA_PAYLOAD = 4 * 1024 * 1024;
/** Fatia do arquivo enviado no cálculo do SHA-256 (o laço de eventos respira entre elas). */
const FATIA_HASH = 4 * 1024 * 1024;

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
const SINAN: readonly SistemaOficial[] = ['SINAN_NET', 'SINAN_ONLINE'];

/** UUID versão 7 (tempo + aleatório), o mesmo formato que o Prisma gera para o id. */
function uuidv7(): string {
  const b = randomBytes(16);
  const ms = Date.now();
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = Math.floor(ms / 2 ** 24) & 0xff;
  b[3] = Math.floor(ms / 2 ** 16) & 0xff;
  b[4] = Math.floor(ms / 2 ** 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const diaIso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Data de calendário que existe (ida e volta pelo Date.UTC: 2025-13-01 e 2025-02-30 não passam). */
function dataExiste(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(a, mes - 1, d));
  return a >= 1900 && t.getUTCFullYear() === a && t.getUTCMonth() === mes - 1 && t.getUTCDate() === d;
}

/** Uma prévia ou aplicação por vez neste processo (o envio grande ocupa a memória e a CPU do container). */
let ocupado = false;

@Injectable()
export class ImportacaoService {
  /** Fatia do payload por comando no banco (os testes diminuem para passar por várias). */
  static fatiaPayload = FATIA_PAYLOAD;
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

  /** Roda `fn` sozinho neste processo; com outra prévia ou aplicação em andamento, 409. */
  private async exclusivo<T>(fn: () => Promise<T>): Promise<T> {
    if (ocupado) throw new DomainError('IMPORTACAO_OCUPADA', 'Outra importação está sendo processada agora. Tente de novo em alguns minutos.', HttpStatus.CONFLICT);
    ocupado = true;
    try {
      return await fn();
    } finally {
      ocupado = false;
    }
  }

  // ───────────────────────────── comparação com o banco ─────────────────────────────

  /**
   * Registros do banco com a mesma chave (sistema, tipo e chave natural) dos registros do envio. No Sinan, procura a
   * chave nos dois sistemas (Net e Online): o registro gravado no outro sistema é o mesmo e muda de sistema na aplicação.
   * Se a chave estiver nos dois (gravados antes da regra da dengue e da chikungunya), vale o do próprio sistema.
   */
  private async existentes(db: Db, registros: RegistroDoEnvio[]): Promise<{ mapa: Map<string, LinhaBanco>; nosDoisSistemas: number }> {
    const porGrupo = new Map<string, { sistemas: SistemaOficial[]; tipo: TipoRegistroOficial; chaves: string[] }>();
    for (const r of registros) {
      const sinan = SINAN.includes(r.sistema);
      const k = `${sinan ? 'SINAN' : r.sistema}|${r.tipo}`;
      const g = porGrupo.get(k) ?? { sistemas: sinan ? [...SINAN] : [r.sistema], tipo: r.tipo, chaves: [] };
      g.chaves.push(r.chave);
      porGrupo.set(k, g);
    }
    const porChave = new Map<string, LinhaBanco[]>();
    for (const g of porGrupo.values())
      for (let i = 0; i < g.chaves.length; i += 2000) {
        const rows = await db.officialRecord.findMany({ where: { system: { in: g.sistemas }, type: g.tipo, naturalKey: { in: g.chaves.slice(i, i + 2000) } }, select: SELECT_ESTADO });
        for (const row of rows) {
          const k = `${SINAN.includes(row.system) ? 'SINAN' : row.system}|${row.type}|${row.naturalKey}`;
          const lista = porChave.get(k);
          if (lista) lista.push(row as LinhaBanco);
          else porChave.set(k, [row as LinhaBanco]);
        }
      }
    const mapa = new Map<string, LinhaBanco>();
    let nosDoisSistemas = 0;
    for (const r of registros) {
      const linhas = porChave.get(`${SINAN.includes(r.sistema) ? 'SINAN' : r.sistema}|${r.tipo}|${r.chave}`);
      if (!linhas) continue;
      if (linhas.length > 1) nosDoisSistemas++;
      mapa.set(chaveDoEnvio(r.sistema, r.tipo, r.chave), linhas.find((l) => l.system === r.sistema) ?? linhas[0]!);
    }
    return { mapa, nosDoisSistemas };
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

  /** Filtro dos registros do banco dentro de uma cobertura (sistema, tipo, período, agravos, municípios, ficha e CNES). */
  private ondeCobertura(c: Cobertura): TenantPrisma.OfficialRecordWhereInput {
    const agravos = c.agravos.filter((a): a is string => !!a);
    return {
      system: c.sistema,
      type: c.tipo,
      absentSince: null,
      notifiedOn: { gte: new Date(`${c.de}T00:00:00Z`), lte: new Date(`${c.ate}T00:00:00Z`) },
      ...(c.grupos ? { groupKey: { in: c.grupos } } : {}),
      ...(c.cnes ? { unitCnes: { in: c.cnes } } : {}),
      AND: [
        { OR: [...(agravos.length ? [{ agravo: { in: agravos } }] : []), ...(c.agravos.includes(null) ? [{ agravo: null }] : [])] },
        { OR: [...c.municipios.map((m) => ({ municipalityIbge: { startsWith: m } })), ...(c.municipioNulo ? [{ municipalityIbge: null }] : [])] },
      ],
    };
  }

  /** Prévia: quantos registros do banco dentro da cobertura não vieram no envio (em páginas), com a amostra. */
  private async ausentesPrevistos(db: Db, cobertura: Cobertura[], leitura: LeituraEnvio, ritmo: Ritmo): Promise<{ total: number; amostra: AmostraRegistro[] }> {
    let total = 0;
    const amostra: AmostraRegistro[] = [];
    for (const c of cobertura) {
      if (c.grupos && !c.grupos.length) continue;
      let depois: string | null = null;
      for (;;) {
        const rows: {
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
        }[] = await db.officialRecord.findMany({
          where: { ...this.ondeCobertura(c), ...(depois ? { id: { gt: depois } } : {}) },
          orderBy: { id: 'asc' },
          take: PAGINA,
          select: { id: true, system: true, type: true, naturalKey: true, number: true, notifiedOn: true, agravo: true, groupKey: true, unitCnes: true, situation: true, patientName: true, sensitive: true },
        });
        for (const a of rows) {
          if (leitura.tem(chaveDoEnvio(a.system, a.type, a.naturalKey))) continue;
          total++;
          if (amostra.length < MAX_AMOSTRAS)
            amostra.push({
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
            });
        }
        if (rows.length < PAGINA) break;
        depois = rows[rows.length - 1]!.id;
        await ritmo.ceder();
      }
    }
    return { total, amostra };
  }

  /** Aplicação: marca os ausentes da cobertura (os registros que este envio não tocou). Nunca apaga. */
  private async marcarAusentes(tx: Db, cobertura: Cobertura[], id: string, agora: Date): Promise<number> {
    let total = 0;
    for (const c of cobertura) {
      if (c.grupos && !c.grupos.length) continue;
      const { count } = await tx.officialRecord.updateMany({ where: { ...this.ondeCobertura(c), lastImportId: { not: id } }, data: { absentSince: agora } });
      total += count;
    }
    return total;
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

  private async sha256(arquivo: Buffer, ritmo: Ritmo): Promise<string> {
    const h = createHash('sha256');
    for (let i = 0; i < arquivo.length; i += FATIA_HASH) {
      h.update(arquivo.subarray(i, i + FATIA_HASH));
      await ritmo.ceder();
    }
    return h.digest('hex');
  }

  /** POST /vigilancia/importacoes (corpo cru). Mesmo SHA-256 já aplicado: `{ jaImportado }`, sem criar nada. */
  async enviar(ctx: RequestContext, arquivo: Buffer, consulta: ConsultaEnvioImportacao): Promise<RespostaEnvioImportacao> {
    if (!arquivo.length) throw new DomainError('ARQUIVO_VAZIO', 'Arquivo vazio', HttpStatus.BAD_REQUEST);
    if (!!consulta.de !== !!consulta.ate) throw new DomainError('PERIODO_INVALIDO', 'Informe o início e o fim do período, ou nenhum dos dois', HttpStatus.BAD_REQUEST);
    for (const [rotulo, valor] of [
      ['início', consulta.de],
      ['fim', consulta.ate],
    ] as const)
      if (valor !== undefined && !dataExiste(valor)) throw new DomainError('PERIODO_INVALIDO', `O ${rotulo} do período não é uma data válida (${valor}). Use AAAA-MM-DD.`, HttpStatus.BAD_REQUEST);
    if (consulta.de && consulta.ate && consulta.de > consulta.ate) throw new DomainError('PERIODO_INVALIDO', 'O início do período vem depois do fim', HttpStatus.BAD_REQUEST);
    const ritmo = new Ritmo();
    const sha256 = await this.sha256(arquivo, ritmo);
    const aplicada = await ctx.db.officialImport.findFirst({ where: { sha256, status: 'APLICADA' }, select: { id: true, appliedAt: true } });
    if (aplicada) return { jaImportado: { id: aplicada.id, aplicadoEm: (aplicada.appliedAt ?? new Date()).toISOString() } };
    const id = await this.exclusivo(() => this.criarPrevia(ctx, arquivo, consulta, sha256, ritmo));
    return this.detalhe(ctx, id, { auditar: false });
  }

  private async criarPrevia(ctx: RequestContext, arquivo: Buffer, consulta: ConsultaEnvioImportacao, sha256: string, ritmo: Ritmo): Promise<string> {
    const { ibge } = await municipioDoTenant(this.master, ctx.tenant.id);
    const [sensiveis, grupoDoCid, porNome] = await Promise.all([gruposSigilosos(ctx.db), grupoDoCidFabrica(ctx.db), municipiosPorNome(ctx.db)]);
    const hoje = localDateString(new Date(), ctx.tenant.timeZone);
    let leitura: LeituraEnvio;
    try {
      leitura = await lerEnvio(consulta.nome, new Uint8Array(arquivo.buffer, arquivo.byteOffset, arquivo.byteLength), {
        codificacao: consulta.codificacao,
        hoje,
        municipio: ibge,
        sensiveis,
        grupoDoCid,
        municipiosPorNome: porNome,
        ritmo,
      });
    } catch (e) {
      if (e instanceof ErroArquivo) throw new DomainError('ARQUIVO_RECUSADO', e.message, HttpStatus.UNPROCESSABLE_ENTITY);
      throw e;
    }
    let pasta: string | null = null;
    let payload: EscritorPayload | null = null;
    let fechado = false;
    try {
      pasta = mkdtempSync(join(tmpdir(), 'omni-previa-'));
      payload = new EscritorPayload(join(pasta, 'payload.gz'));
      const escritor = payload;
      const validos = leitura.arquivos.filter((a) => !a.ignorado);
      if (!validos.length) throw new DomainError('SEM_REGISTROS', `Nenhum arquivo com notificações reconhecidas. ${leitura.avisos.join(' ')}`.trim(), HttpStatus.UNPROCESSABLE_ENTITY, { arquivos: leitura.arquivos });
      if (!leitura.total)
        throw new DomainError('SEM_REGISTROS', `Nenhum registro válido no envio (${leitura.recusados} recusado(s)).`, HttpStatus.UNPROCESSABLE_ENTITY, {
          arquivos: leitura.arquivos,
          motivosRecusa: leitura.motivosRecusa,
        });

      const declarado = consulta.de && consulta.ate ? { de: consulta.de, ate: consulta.ate } : null;
      const acumulador = new AcumuladorCobertura(declarado, ibge);
      const porTipo: ContagensImportacao['porTipo'] = {};
      const porSistema = new Map<SistemaOficial, number>();
      const novos: AmostraRegistro[] = [];
      const alterados: AmostraAlteracao[] = [];
      let nNovos = 0;
      let nAlterados = 0;
      let nIguais = 0;
      let foraDoPeriodo = 0;
      let nosDoisSistemas = 0;
      for await (const lote of leitura.registros(LOTE_COMPARACAO)) {
        const existentes = await this.existentes(ctx.db, lote);
        nosDoisSistemas += existentes.nosDoisSistemas;
        for (const c of this.comparar(lote, existentes.mapa)) {
          acumulador.somar(c.r);
          porTipo[c.r.tipo] = (porTipo[c.r.tipo] ?? 0) + 1;
          porSistema.set(c.r.sistema, (porSistema.get(c.r.sistema) ?? 0) + 1);
          if (declarado) {
            const d = c.r.partes[c.r.partes.length - 1]!.notificadoEm;
            if (d < declarado.de || d > declarado.ate) foraDoPeriodo++;
          }
          if (!c.linha) {
            nNovos++;
            if (novos.length < MAX_AMOSTRAS) novos.push(this.amostra(c));
          } else if (c.hash !== c.linha.contentHash) {
            nAlterados++;
            if (alterados.length < MAX_AMOSTRAS) {
              const sistema = c.linha.system !== c.r.sistema ? [{ campo: 'sistema', antes: c.linha.system, depois: c.r.sistema }] : [];
              alterados.push({ ...this.amostra(c), campos: [...sistema, ...diferencas(c.antes, c.depois)] });
            }
          } else {
            nIguais++;
          }
        }
        await escritor.escrever(lote);
        await ritmo.ceder();
      }
      const { cobertura, avisos: avisosCobertura } = acumulador.resultado();
      const ausentes = await this.ausentesPrevistos(ctx.db, cobertura, leitura, ritmo);
      const tamanhoPayload = await escritor.fechar(cobertura);
      fechado = true;

      const contagens: ContagensImportacao = {
        lidos: leitura.lidos,
        novos: nNovos,
        alterados: nAlterados,
        iguais: nIguais,
        recusados: leitura.recusados,
        duplicadosNoArquivo: leitura.duplicadosNoArquivo,
        ausentesPrevistos: ausentes.total,
        motivosRecusa: leitura.motivosRecusa,
        porTipo,
      };
      const previa: PreviaImportacao = { novos, alterados, recusados: leitura.recusas, duplicados: leitura.duplicados, ausentes: ausentes.amostra };

      // Sistema predominante, período e avisos do envio.
      const sistema = [...porSistema].sort((a, b) => b[1] - a[1])[0]![0];
      const datas = validos.flatMap((a) => (a.periodo ? [a.periodo.de, a.periodo.ate] : [])).sort();
      const periodo = declarado ?? (datas.length ? { de: datas[0]!, ate: datas[datas.length - 1]! } : null);
      const avisos = [...leitura.avisos, ...avisosCobertura];
      if (foraDoPeriodo) avisos.push(`${foraDoPeriodo} registro(s) com data da notificação fora do período declarado: entram, mas o período declarado é que define os ausentes.`);
      if (nosDoisSistemas) avisos.push(`${nosDoisSistemas} registro(s) gravados antes nos dois sistemas do Sinan (Net e Online) com a mesma chave: vale o do sistema da dengue ou da chikungunya. Confira na conciliação.`);
      if (validos.some((a) => a.tipo === 'ESUS_NOTIFICA_CSV'))
        avisos.push('e-SUS Notifica: exporte com o perfil de gestor municipal (o autocadastro só traz as notificações do próprio CNES) e um arquivo por ano de notificação.');
      if (validos.some((a) => a.sistema === 'SINAN_ONLINE')) avisos.push('Sinan Online: a mesma solicitação em menos de 24 horas devolve o mesmo arquivo, e o período não cruza o ano.');

      const agora = new Date();
      return await ctx.db.$transaction(
        async (tx) => {
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
              warnings: avisos,
              createdBy: ctx.session.userId,
            },
            select: { id: true },
          });
          await this.gravarPayload(tx, criada.id, escritor.caminho, tamanhoPayload);
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
          return criada.id;
        },
        { timeout: 120_000, maxWait: 30_000 },
      );
    } finally {
      if (payload && !fechado) payload.abortar();
      leitura.fechar();
      if (pasta) rmSync(pasta, { recursive: true, force: true });
    }
  }

  /** Registros novos num INSERT só (SQL com um parâmetro JSON: o Prisma não guarda os dados no histórico do debug). */
  private async inserir(tx: Db, novos: Comparado[], sensiveis: ReadonlySet<string>, importacao: string, agora: Date) {
    const linhas = novos.map((c) => {
      const v = colunasDoEstado(c.r.sistema, c.depois, sensiveis);
      return {
        id: uuidv7(),
        system: c.r.sistema,
        type: c.r.tipo,
        natural_key: c.r.chave,
        number: v.number,
        notified_on: diaIso(v.notifiedOn),
        epi_week_notified: v.epiWeekNotified,
        municipality_ibge: v.municipalityIbge,
        unit_cnes: v.unitCnes,
        agravo: v.agravo,
        suspected_type: v.suspectedType,
        group_key: v.groupKey,
        symptoms_onset: diaIso(v.symptomsOnset),
        epi_week_onset: v.epiWeekOnset,
        residence_ibge: v.residenceIbge,
        neighborhood_code: v.neighborhoodCode,
        neighborhood_name: v.neighborhoodName,
        final_class: v.finalClass,
        criterion: v.criterion,
        evolution: v.evolution,
        closed_on: diaIso(v.closedOn),
        death_on: diaIso(v.deathOn),
        situation: v.situation,
        severity: v.severity,
        excluded: v.excluded,
        sensitive: v.sensitive,
        patient_name: v.patientName,
        patient_name_norm: v.patientNameNorm,
        birth_date: diaIso(v.birthDate),
        sex: v.sex,
        mother_name_norm: v.motherNameNorm,
        cns: v.cns,
        cpf: v.cpf,
        data: v.data,
        content_hash: c.hash,
      };
    });
    const quando = agora.toISOString();
    await tx.$executeRaw`
      INSERT INTO official_records (id, system, type, natural_key, number, notified_on, epi_week_notified, municipality_ibge, unit_cnes, agravo,
        suspected_type, group_key, symptoms_onset, epi_week_onset, residence_ibge, neighborhood_code, neighborhood_name, final_class, criterion,
        evolution, closed_on, death_on, situation, severity, excluded, sensitive, patient_name, patient_name_norm, birth_date, sex,
        mother_name_norm, cns, cpf, data, content_hash, first_import_id, last_import_id, last_seen_at, created_at, updated_at)
      SELECT r.id::uuid, r.system::"OfficialSystem", r.type::"OfficialRecordType", r.natural_key, r.number, r.notified_on::date, r.epi_week_notified,
        r.municipality_ibge, r.unit_cnes, r.agravo, r.suspected_type, r.group_key, r.symptoms_onset::date, r.epi_week_onset, r.residence_ibge,
        r.neighborhood_code, r.neighborhood_name, r.final_class, r.criterion, r.evolution, r.closed_on::date, r.death_on::date, r.situation,
        r.severity, r.excluded, r.sensitive, r.patient_name, r.patient_name_norm, r.birth_date::date, r.sex, r.mother_name_norm, r.cns, r.cpf,
        r.data, r.content_hash, ${importacao}::uuid, ${importacao}::uuid, ${quando}::timestamptz AT TIME ZONE 'UTC',
        ${quando}::timestamptz AT TIME ZONE 'UTC', ${quando}::timestamptz AT TIME ZONE 'UTC'
      FROM jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) AS r(id text, system text, type text, natural_key text, number text, notified_on text,
        epi_week_notified text, municipality_ibge text, unit_cnes text, agravo text, suspected_type text, group_key text, symptoms_onset text,
        epi_week_onset text, residence_ibge text, neighborhood_code text, neighborhood_name text, final_class text, criterion text, evolution text,
        closed_on text, death_on text, situation text, severity text, excluded boolean, sensitive boolean, patient_name text, patient_name_norm text,
        birth_date text, sex text, mother_name_norm text, cns text, cpf text, data jsonb, content_hash text)`;
  }

  /** Payload do arquivo temporário para o banco, em fatias (nenhuma cópia inteira dele na memória). */
  private async gravarPayload(tx: Db, id: string, caminho: string, tamanho: number) {
    const fd = openSync(caminho, 'r');
    try {
      const passo = ImportacaoService.fatiaPayload;
      for (let pos = 0; pos < tamanho; pos += passo) {
        const fatia = Buffer.allocUnsafe(Math.min(passo, tamanho - pos));
        for (let lidos = 0; lidos < fatia.length; ) {
          const n = readSync(fd, fatia, lidos, fatia.length - lidos, pos + lidos);
          if (!n) throw new Error('Payload da prévia cortado no disco');
          lidos += n;
        }
        await tx.$executeRaw`UPDATE official_imports SET payload = COALESCE(payload, ''::bytea) || ${fatia} WHERE id = ${id}::uuid`;
      }
    } finally {
      closeSync(fd);
    }
  }

  /** Payload do banco em fatias (para o gunzip em fluxo da aplicação). */
  private async *fatiasDoPayload(db: Db, id: string): AsyncGenerator<Uint8Array> {
    const [linha] = await db.$queryRaw<{ n: number | null }[]>`SELECT octet_length(payload)::int AS n FROM official_imports WHERE id = ${id}::uuid`;
    const tamanho = linha?.n ?? 0;
    const passo = ImportacaoService.fatiaPayload;
    for (let pos = 1; pos <= tamanho; pos += passo) {
      const [f] = await db.$queryRaw<{ parte: Uint8Array }[]>`SELECT substring(payload FROM ${pos}::int FOR ${passo}::int) AS parte FROM official_imports WHERE id = ${id}::uuid`;
      if (!f?.parte) throw new Error('Payload da prévia sumiu durante a aplicação');
      yield f.parte;
    }
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
      select: { id: true, status: true, sha256: true, counts: true, createdAt: true, discardedBy: true, fileName: true },
    });
    if (!imp) throw notFound('Importação');
    if (imp.status === 'APLICADA') throw conflict('A importação já foi aplicada');
    if (imp.status === 'DESCARTADA') throw conflict(imp.discardedBy ? 'A prévia foi descartada' : 'A prévia expirou: envie o arquivo de novo');
    const horas = ctx.tenant.settings.vigilancia.consolidacao.expiraPreviaHoras;
    if (imp.createdAt.getTime() + horas * HORA < Date.now()) {
      await this.expirarPrevias(ctx.db, new Date(), horas);
      throw conflict('A prévia expirou: envie o arquivo de novo');
    }
    const [tem] = await ctx.db.$queryRaw<{ n: number | null }[]>`SELECT octet_length(payload)::int AS n FROM official_imports WHERE id = ${id}::uuid`;
    if (!tem?.n) throw conflict('A prévia não tem mais os registros: envie o arquivo de novo');
    return this.exclusivo(() => this.aplicarPrevia(ctx, imp));
  }

  private async aplicarPrevia(ctx: RequestContext, imp: { id: string; sha256: string; counts: unknown; fileName: string }): Promise<ResultadoAplicacao> {
    const id = imp.id;
    const sensiveis = await gruposSigilosos(ctx.db);
    const agora = new Date();
    const avisos: string[] = [];
    const ritmo = new Ritmo();

    const resultado = await ctx.db
      .$transaction(
        async (tx) => {
          // Uma aplicação por vez (a mesma chave pode vir em dois envios ao mesmo tempo).
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('vigilancia:importacao'))`;
          const atual = await tx.officialImport.findUnique({ where: { id }, select: { status: true } });
          if (atual?.status !== 'PREVIA') throw conflict('A importação mudou: abra de novo');
          if (await tx.officialImport.findFirst({ where: { sha256: imp.sha256, status: 'APLICADA' }, select: { id: true } })) throw conflict('Este arquivo já foi aplicado');

          let novos = 0;
          let alterados = 0;
          let iguais = 0;
          let voltaram = 0;
          const leitor = new LeitorPayload(this.fatiasDoPayload(tx, id), ritmo);
          for await (const lote of leitor.lotes(LOTE_COMPARACAO)) {
            const comparados = this.comparar(lote, (await this.existentes(tx, lote)).mapa);
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
                  data: {
                    // O mesmo registro gravado no outro sistema do Sinan muda de sistema (a chave natural é a mesma).
                    ...(c.linha.system !== c.r.sistema ? { system: c.r.sistema } : {}),
                    ...colunasDoEstado(c.r.sistema, c.depois, sensiveis),
                    contentHash: c.hash,
                    lastImportId: id,
                    lastSeenAt: agora,
                    absentSince: null,
                  },
                });
              } else {
                iguais++;
                if (!mesmasFontes(c.antes.fontes, c.depois.fontes))
                  await tx.officialRecord.update({ where: { id: c.linha.id }, data: { data: colunasDoEstado(c.r.sistema, c.depois, sensiveis).data, lastImportId: id, lastSeenAt: agora, absentSince: null } });
                else tocar.push(c.linha.id);
              }
            }
            if (tocar.length) await tx.officialRecord.updateMany({ where: { id: { in: tocar } }, data: { lastImportId: id, lastSeenAt: agora, absentSince: null } });
            for (let i = 0; i < criar.length; i += LOTE) {
              const parte = criar.slice(i, i + LOTE);
              await this.inserir(tx, parte, sensiveis, id, agora);
              novos += parte.length;
            }
            // Divergências dos pares que já estavam vinculados e mudaram.
            if (vinculadosAlterados.length) await this.conciliacao.atualizarDivergencias(tx, vinculadosAlterados);
            await ritmo.ceder();
          }
          const cobertura = leitor.cobertura!;

          // Ausentes: só dentro da cobertura do envio (sistema, tipo, agravos, período, municípios, ficha e CNES), entre
          // os registros que este envio não tocou. Nunca apaga.
          const ausentesMarcados = await this.marcarAusentes(tx, cobertura, id, agora);

          // Unidades pelo CNES.
          const ligadas = await tx.$executeRaw`
            UPDATE official_records r SET unit_id = u.id FROM units u
            WHERE r.last_import_id = ${id}::uuid AND u.cnes = r.unit_cnes AND r.unit_id IS DISTINCT FROM u.id`;
          await tx.$executeRaw`
            UPDATE official_records r SET unit_id = NULL
            WHERE r.last_import_id = ${id}::uuid AND r.unit_id IS NOT NULL
              AND (r.unit_cnes IS NULL OR NOT EXISTS (SELECT 1 FROM units u WHERE u.cnes = r.unit_cnes))`;

          // Conciliação automática (degraus 1 e 2) dos registros tocados, em páginas (a regra do "único dos dois lados"
          // consulta todos os concorrentes no banco, não só os da página).
          let vinculados = 0;
          for (let depois: string | null = null; ; ) {
            const pagina: { id: string }[] = await tx.officialRecord.findMany({
              where: { lastImportId: id, ...(depois ? { id: { gt: depois } } : {}) },
              orderBy: { id: 'asc' },
              take: PAGINA,
              select: { id: true },
            });
            if (pagina.length) vinculados += await this.conciliacao.conciliarAutomatico(tx, { recordIds: pagina.map((p) => p.id), timeZone: ctx.tenant.timeZone });
            if (pagina.length < PAGINA) break;
            depois = pagina[pagina.length - 1]!.id;
          }

          const anteriores = imp.counts as unknown as ContagensImportacao;
          const contagens: ContagensImportacao = { ...anteriores, novos, alterados, iguais, ausentesPrevistos: ausentesMarcados };
          const { count } = await tx.officialImport.updateMany({
            where: { id, status: 'PREVIA' },
            data: { status: 'APLICADA', appliedBy: ctx.session.userId, appliedAt: agora, payload: null, preview: TenantPrisma.DbNull, counts: contagens as unknown as TenantPrisma.InputJsonValue },
          });
          if (count !== 1) throw conflict('A importação mudou: abra de novo');
          await this.audit.record(ctx, tx, {
            action: 'vigilancia.importacao_aplicada',
            entityType: 'OfficialImport',
            entityId: id,
            payload: { arquivo: imp.fileName, sha256: imp.sha256, contagens: { ...contagens, motivosRecusa: undefined }, ausentesMarcados, voltaram, unidadesLigadas: ligadas, vinculados },
          });
          const unidades = (await tx.$queryRaw<{ u: string }[]>`SELECT DISTINCT unit_id::text AS u FROM official_records WHERE last_import_id = ${id}::uuid AND unit_id IS NOT NULL`).map((r) => r.u);
          const semanas = (await tx.$queryRaw<{ s: string }[]>`SELECT DISTINCT trim(epi_week_notified) AS s FROM official_records WHERE last_import_id = ${id}::uuid AND trim(COALESCE(epi_week_notified, '')) <> ''`).map(
            (r) => r.s,
          );
          return { contagens, ausentesMarcados, voltaram, unidadesLigadas: ligadas, vinculados, unidades, semanas };
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
