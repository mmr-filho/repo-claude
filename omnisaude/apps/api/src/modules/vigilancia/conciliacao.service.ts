import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TenantPrisma, type MasterClient } from '@omnisaude/database';
import {
  agravoSinanDaChave,
  evolucaoPadraoSinan,
  infoAgravoSinan,
  normalizarNome,
  normalizarNomePessoa,
  onlyDigits,
  personNameKey,
  roleHasPermission,
  situacaoOmni,
  type ArquivoDetectado,
  type BairroSemCorrespondencia,
  type CorpoApelidoBairro,
  type CorpoDesvincular,
  type CorpoRejeitarVinculo,
  type CorpoVincular,
  type DivergenciaPar,
  type FiltroConciliacao,
  type ListaBairrosSemCorrespondencia,
  type ListaDivergentes,
  type ListaSoOficial,
  type ListaSoOmnisaude,
  type ListaSugestoesVinculo,
  type ListaVinculados,
  type MetodoVinculo,
  type NotificacaoParaConciliar,
  type Permission,
  type RegistroOficialResumo,
  type RespostaApelidoBairro,
  type RespostaOk,
  type RespostaVincular,
  type ResumoConciliacao,
  type SistemaOficial,
  type SituacaoCaso,
  type SugestaoVinculo,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { MASTER_DB } from '../../core/database';
import { conflict, DomainError, forbidden, notFound } from '../../core/errors';
import { gruposDoArquivo } from './cobertura-importacao';
import { sqlCnsValido, sqlCpfValido, sqlDataSinan, sqlNomePessoa, sqlSemZeros } from './conciliacao-sql';
import { municipioDoTenant, NOME_DO_GRUPO } from './importacao/apoio';
import { NotificacaoService } from './notificacao.service';

/**
 * Conciliação dos registros oficiais com as notificações do OmniSaúde (VIG-1c, §4.1; frente F2), em degraus: (1)
 * número oficial, (2) CNS ou CPF + mesmo agravo do Sinan + datas a até 7 dias, automáticos só com candidato único;
 * (3) nome, nascimento e sexo, só sugestão; (4) sem identificador, só nas contagens. O número oficial preenchido no
 * vínculo usa a regra do NotificacaoService (sem duplicar a validação).
 *
 * Os pares candidatos, as listas e as contagens saem de consultas SQL paginadas (junção por número, CNS/CPF e nome +
 * nascimento + sexo): nada carrega a base inteira por requisição. As regras do shared que o SQL não sabe (agravo do
 * Sinan da chave, tradução da evolução pela ficha, situação da notificação) entram como tabelas de tradução pequenas,
 * calculadas pelas próprias funções do shared sobre as combinações distintas que existem no banco.
 */

type Db = TenantPrisma.TransactionClient;
type Sql = TenantPrisma.Sql;
const { sql, join, empty, raw } = TenantPrisma;

/** Janela dos degraus 1 (desempate e Sinan Net/Online) e 2 (datas da notificação ou dos sintomas). */
const JANELA_DIAS = 7;
/** Janela do degrau 3 (sugestão por nome, nascimento e sexo): datas a até 30 dias. */
const JANELA_SUGESTAO_DIAS = 30;
const POR_PAGINA = 50;
/** Ids por consulta (o Postgres aceita até 65.535 parâmetros por comando). */
const LOTE_IDS = 5000;

const dia = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
/** Código de classificação ou evolução sem espaço nem zero à esquerda ('02' e ' 2' viram '2'). */
const codigo = (v: string | null | undefined) => {
  const t = (v ?? '').trim();
  return /^\d+$/.test(t) ? String(Number(t)) : t;
};

/** Consulta em lotes de ids, juntando o resultado. */
async function emLotes<R>(ids: string[], consulta: (lote: string[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < ids.length; i += LOTE_IDS) out.push(...(await consulta(ids.slice(i, i + LOTE_IDS))));
  return out;
}

/**
 * Colunas do registro oficial usadas na conciliação. Sem relações: dentro da transação o Prisma busca as relações em
 * paralelo na mesma conexão (o pg avisa que isso deixa de funcionar na versão 9).
 */
const SELECT_REGISTRO_BASE = {
  id: true,
  system: true,
  type: true,
  number: true,
  notifiedOn: true,
  epiWeekNotified: true,
  agravo: true,
  groupKey: true,
  unitId: true,
  unitCnes: true,
  symptomsOnset: true,
  situation: true,
  severity: true,
  evolution: true,
  closedOn: true,
  excluded: true,
  sensitive: true,
  patientName: true,
  patientNameNorm: true,
  birthDate: true,
  sex: true,
  motherNameNorm: true,
  cns: true,
  cpf: true,
  absentSince: true,
  notificationId: true,
  matchMethod: true,
  matchedAt: true,
} as const;
/** Colunas do registro oficial nas listas (fora de transação): com o nome da unidade e o número da notificação. */
const SELECT_REGISTRO = { ...SELECT_REGISTRO_BASE, unit: { select: { name: true } }, notification: { select: { number: true } } } as const;

/** Colunas da notificação usadas nas listas (paciente, agravo e unidade vêm depois, sem relação). */
const SELECT_NOTIFICACAO = {
  id: true,
  number: true,
  status: true,
  groupKey: true,
  conditionKey: true,
  code: true,
  notifiedAt: true,
  symptomsOnset: true,
  unitId: true,
  officialSystem: true,
  officialNumber: true,
  finalClass: true,
  evolution: true,
  closedAt: true,
  sensitive: true,
  patientId: true,
  conditionId: true,
} as const;

type LinhaRegistro = {
  id: string;
  system: SistemaOficial;
  type: string;
  number: string;
  notifiedOn: Date;
  epiWeekNotified: string | null;
  agravo: string | null;
  groupKey: string | null;
  unitId: string | null;
  unitCnes: string | null;
  symptomsOnset: Date | null;
  situation: string;
  severity: string | null;
  evolution: string | null;
  closedOn: Date | null;
  excluded: boolean;
  sensitive: boolean;
  patientName: string | null;
  patientNameNorm: string | null;
  birthDate: Date | null;
  sex: string | null;
  motherNameNorm: string | null;
  cns: string | null;
  cpf: string | null;
  absentSince: Date | null;
  notificationId: string | null;
  matchMethod: string | null;
  matchedAt: Date | null;
  unit?: { name: string } | null;
  notification?: { number: string } | null;
};

type LinhaNotificacao = {
  id: string;
  number: string;
  status: string;
  groupKey: string;
  conditionKey: string;
  code: string | null;
  notifiedAt: Date | null;
  symptomsOnset: Date | null;
  unitId: string;
  officialSystem: SistemaOficial | null;
  officialNumber: string | null;
  finalClass: string | null;
  evolution: string | null;
  closedAt: Date | null;
  sensitive: boolean;
  condition: { name: string };
  unit: { id: string; name: string };
  patient: { name: string; socialName: string | null; birthDate: Date; sex: string };
};

// ───────────────────────────── divergências ─────────────────────────────

/** e-SUS Notifica: 1 cura, 2 óbito, 6 ignorado; 3 a 5 (tratamento, internação) são caso aberto e 7 é a ficha cancelada. */
const EVOLUCAO_ESUS_NOTIFICA: Record<string, string> = { '1': '1', '2': '2', '6': '9' };

/**
 * Evolução do registro oficial na numeração da ficha do OmniSaúde (EVOLUCAO_CASO: 1 cura, 2 óbito pelo agravo, 3 óbito
 * por outras causas, 9 ignorado), traduzida pela ficha de origem antes de comparar; null = sem desfecho comparável.
 * e-SUS Notifica: a numeração de lá. Ficha com a numeração própria na tabela do Sinan (`evolucaoPadrao`; Mpox no e-SUS
 * Sinan: 1 óbito, 2 cura): `evolucaoPadraoSinan`. Ficha do Sinan Net com o óbito pelo agravo em outro código
 * (tuberculose 3, doenças do trabalho 6...): esse código vira 2, e só a cura (1) e o ignorado (9) têm par; o resto da
 * numeração da ficha não é comparável (não aparece com o rótulo errado).
 */
export function evolucaoComparavel(r: { system: string; agravo: string | null; evolution: string | null }): string | null {
  const e = codigo(r.evolution);
  if (!e) return null;
  if (r.system === 'ESUS_NOTIFICA') return EVOLUCAO_ESUS_NOTIFICA[e] ?? null;
  const info = infoAgravoSinan(r.agravo);
  if (info?.evolucaoPadrao) return evolucaoPadraoSinan(r.agravo, e);
  const obito = info?.obitoAgravo ?? ['2'];
  if (obito.includes(e)) return '2';
  if (obito.includes('2')) return e;
  return e === '1' || e === '9' ? e : null;
}

/**
 * Diferenças do par: situação (a do registro já vem da classificação traduzida pela ficha do agravo, na importação),
 * evolução (traduzida pela ficha antes de comparar) e data de encerramento.
 */
export function divergenciasDoPar(
  r: { system: string; agravo: string | null; situation: string; evolution: string | null; closedOn: Date | null },
  n: { status: string; finalClass: string | null; evolution: string | null; closedAt: Date | null },
): DivergenciaPar[] {
  const out: DivergenciaPar[] = [];
  const so = r.situation;
  const sn = situacaoOmni(n);
  if (so !== sn) out.push({ campo: 'situacao', oficial: so, omnisaude: sn });
  const eo = evolucaoComparavel(r);
  const en = n.evolution ?? null;
  if (eo !== en) out.push({ campo: 'evolucao', oficial: eo, omnisaude: en });
  const co = dia(r.closedOn);
  const cn = dia(n.closedAt);
  if (co !== cn) out.push({ campo: 'encerramento', oficial: co, omnisaude: cn });
  return out;
}

/** Par candidato dos degraus 1 a 3 (para o vínculo automático e para as sugestões). */
interface Candidato {
  recordId: string;
  notificationId: string;
  degrau: 1 | 2 | 3;
  distancia: number;
  motivo: string;
}

interface Cobertura {
  sistema: SistemaOficial;
  grupos: string[] | null;
  de: string;
  ate: string;
}

/** Tabelas de tradução (JSON) do agravo do Sinan da chave: dos registros e das notificações. */
interface MapasAgravo {
  registros: string;
  notificacoes: string;
}

/** Chave das notificações na tabela do agravo do Sinan: grupo, CID, gestante (campo 12) e linha do catálogo. */
const CHAVE_AGRAVO_NOTIFICACAO = raw(`(n.group_key || '|' || COALESCE(n.code, '') || '|' || CASE WHEN COALESCE(n.form->>'CS_GESTANT', '') IN ('1', '2', '3', '4') THEN '1' ELSE '0' END || '|' || n.condition_key)`);
/** Mesmo agravo do Sinan (`mesmoAgravoSinan`): iguais, ou da mesma base quando um deles não tem variante. */
const MESMO_AGRAVO = raw(`(rr.agravo = nn.agravo OR (split_part(rr.agravo, ':', 1) = split_part(nn.agravo, ':', 1) AND (strpos(rr.agravo, ':') = 0 OR strpos(nn.agravo, ':') = 0)))`);
/** Notificação sem registro oficial vinculado (o índice único parcial de official_records.notification_id responde). */
const SEM_VINCULO = raw(`NOT EXISTS (SELECT 1 FROM official_records x WHERE x.notification_id = n.id)`);

@Injectable()
export class ConciliacaoService {
  constructor(
    private readonly audit: AuditService,
    private readonly moduleRef: ModuleRef,
    @Inject(MASTER_DB) private readonly master: MasterClient,
  ) {}

  /** O NotificacaoService pela referência do módulo (evita ciclo de injeção com o job 'vigilancia'). */
  private notificacoes(): NotificacaoService {
    return this.moduleRef.get(NotificacaoService, { strict: false });
  }

  private pode(ctx: RequestContext, p: Permission) {
    return roleHasPermission(ctx.session.role, p);
  }

  /** Notificações com o paciente, o agravo e a unidade, em consultas seguidas (seguras dentro da transação). */
  private async carregarNotificacoes(db: Db, ids: string[]): Promise<LinhaNotificacao[]> {
    const rows = await emLotes(ids, (lote) => db.notification.findMany({ where: { id: { in: lote } }, select: SELECT_NOTIFICACAO }));
    if (!rows.length) return [];
    const unicos = (xs: string[]) => [...new Set(xs)];
    const pacientes = new Map(
      (await emLotes(unicos(rows.map((r) => r.patientId)), (lote) => db.patient.findMany({ where: { id: { in: lote } }, select: { id: true, name: true, socialName: true, birthDate: true, sex: true } }))).map((p) => [
        p.id,
        p,
      ]),
    );
    const condicoes = new Map(
      (await emLotes(unicos(rows.map((r) => r.conditionId)), (lote) => db.notifiableCondition.findMany({ where: { id: { in: lote } }, select: { id: true, name: true } }))).map((c) => [c.id, c.name]),
    );
    const unidades = new Map((await emLotes(unicos(rows.map((r) => r.unitId)), (lote) => db.unit.findMany({ where: { id: { in: lote } }, select: { id: true, name: true } }))).map((u) => [u.id, u.name]));
    return rows.map((r) => ({ ...r, condition: { name: condicoes.get(r.conditionId) ?? '' }, unit: { id: r.unitId, name: unidades.get(r.unitId) ?? '' }, patient: pacientes.get(r.patientId)! }));
  }

  // ───────────────────────────── candidatos ─────────────────────────────

  /**
   * Agravo do Sinan da chave (`agravoSinanDaChave`) para as combinações que existem no banco: dos registros sem
   * vínculo (grupo e agravo) e das notificações notificadas ou encerradas sem vínculo (grupo, CID, gestante e linha).
   */
  private async mapasAgravo(db: Db): Promise<MapasAgravo> {
    const rs = await db.$queryRaw<{ g: string; ag: string | null }[]>`
      SELECT DISTINCT group_key AS g, agravo AS ag FROM official_records
      WHERE type = 'INDIVIDUAL' AND NOT excluded AND notification_id IS NULL AND group_key IS NOT NULL`;
    const ns = await db.$queryRaw<{ g: string; c: string | null; ge: boolean; k: string }[]>`
      SELECT DISTINCT n.group_key AS g, n.code AS c, (COALESCE(n.form->>'CS_GESTANT', '') IN ('1', '2', '3', '4')) AS ge, n.condition_key AS k
      FROM notifications n WHERE n.status IN ('NOTIFICADA', 'ENCERRADA') AND ${SEM_VINCULO}`;
    return {
      registros: JSON.stringify(rs.map((r) => ({ k: `${r.g}|${r.ag ?? ''}`, a: agravoSinanDaChave(r.g, r.ag) }))),
      notificacoes: JSON.stringify(ns.map((n) => ({ k: `${n.g}|${n.c ?? ''}|${n.ge ? '1' : '0'}|${n.k}`, a: agravoSinanDaChave(n.g, n.c, n.ge, n.k) }))),
    };
  }

  /**
   * CTEs dos pares candidatos entre registros sem vínculo e notificações notificadas ou encerradas sem vínculo, sem os
   * pares rejeitados, cada par uma vez, no menor degrau (`cand`: rid, nid, degrau, dist, motivo). Degrau 1: mesmo
   * sistema, número sem zeros à esquerda e agravo do Sinan; no Sinan Net e no Sinan Online (número da unidade) também a
   * data a até 7 dias. Degrau 2: CNS ou CPF válido, mesmo agravo do Sinan e data da notificação ou dos sintomas a até
   * 7 dias. Degrau 3: nome normalizado, nascimento e sexo (e a mãe, quando os dois lados têm), mesmo agravo do Sinan,
   * datas a até 30 dias. O agravo do Sinan (não o grupo) põe a violência sexual e a tentativa de suicídio com o Y09.
   * `registros` e `notificacoes`: filtros a mais nos registros (alias r) e nas notificações (alias n).
   */
  private sqlCandidatos(o: { tz: string; mapas: MapasAgravo; degraus: readonly (1 | 2 | 3)[]; registros?: Sql; notificacoes?: Sql }): Sql {
    const dNot = raw('abs(rr.notified_on - nn.data)');
    const menor = raw('LEAST(abs(rr.notified_on - nn.data), abs(rr.symptoms_onset - nn.symptoms_onset))');
    const partes: Sql[] = [];
    if (o.degraus.includes(1))
      partes.push(sql`
        SELECT rr.id AS rid, nn.id AS nid, 1 AS degrau, ${dNot} AS dist, 0 AS ordem, 'mesmo número oficial' AS motivo
        FROM rr JOIN nn ON nn.sistema = rr.sistema AND nn.numero_oficial = rr.numero
        WHERE ${MESMO_AGRAVO} AND (rr.sistema NOT IN ('SINAN_NET', 'SINAN_ONLINE') OR ${dNot} <= ${JANELA_DIAS})`);
    if (o.degraus.includes(2))
      partes.push(
        sql`
        SELECT rr.id AS rid, nn.id AS nid, 2 AS degrau, ${menor} AS dist, 0 AS ordem, 'mesmo CNS, mesmo agravo e datas próximas' AS motivo
        FROM rr JOIN nn ON nn.cns = rr.cns
        WHERE nn.cns_valido AND ${MESMO_AGRAVO} AND ${menor} <= ${JANELA_DIAS}`,
        sql`
        SELECT rr.id AS rid, nn.id AS nid, 2 AS degrau, ${menor} AS dist, 1 AS ordem, 'mesmo CPF, mesmo agravo e datas próximas' AS motivo
        FROM rr JOIN nn ON nn.cpf = rr.cpf
        WHERE nn.cpf_valido AND ${MESMO_AGRAVO} AND ${menor} <= ${JANELA_DIAS}`,
      );
    if (o.degraus.includes(3))
      partes.push(sql`
        SELECT rr.id AS rid, nn.id AS nid, 3 AS degrau, ${menor} AS dist, 0 AS ordem,
               CASE WHEN COALESCE(rr.mother_name_norm, '') <> '' AND nn.mae <> '' THEN 'mesmo nome, nascimento, sexo e mãe' ELSE 'mesmo nome, nascimento e sexo' END AS motivo
        FROM rr JOIN nn ON nn.nome = rr.patient_name_norm AND nn.birth_date = rr.birth_date AND nn.sex = rr.sex
        WHERE ${MESMO_AGRAVO} AND (COALESCE(rr.mother_name_norm, '') = '' OR nn.mae = '' OR rr.mother_name_norm = nn.mae) AND ${menor} <= ${JANELA_SUGESTAO_DIAS}`);
    return sql`
      ra AS (SELECT * FROM jsonb_to_recordset(${o.mapas.registros}::jsonb) AS x(k text, a text)),
      na AS (SELECT * FROM jsonb_to_recordset(${o.mapas.notificacoes}::jsonb) AS x(k text, a text)),
      rr AS (
        SELECT r.id, r.system::text AS sistema, ${sqlSemZeros('r.number')} AS numero, r.notified_on, r.symptoms_onset, r.cns, r.cpf,
               r.patient_name_norm, r.birth_date, r.sex::text AS sex, r.mother_name_norm, ra.a AS agravo
        FROM official_records r JOIN ra ON ra.k = r.group_key || '|' || COALESCE(r.agravo, '')
        WHERE r.type = 'INDIVIDUAL' AND NOT r.excluded AND r.notification_id IS NULL ${o.registros ?? empty}
      ),
      nn AS (
        SELECT n.id, n.official_system::text AS sistema, CASE WHEN n.official_number IS NOT NULL THEN ${sqlSemZeros('n.official_number')} END AS numero_oficial,
               n.symptoms_onset, ${sqlDataSinan(o.tz)} AS data, p.cns::text AS cns, ${sqlCnsValido('p.cns')} AS cns_valido, p.cpf::text AS cpf,
               ${sqlCpfValido('p.cpf')} AS cpf_valido, lower(p.name_key) AS nome, p.birth_date, p.sex::text AS sex, ${sqlNomePessoa('p.mother_name')} AS mae, na.a AS agravo
        FROM notifications n JOIN patients p ON p.id = n.patient_id JOIN na ON na.k = ${CHAVE_AGRAVO_NOTIFICACAO}
        WHERE n.status IN ('NOTIFICADA', 'ENCERRADA') AND ${SEM_VINCULO} ${o.notificacoes ?? empty}
      ),
      c AS (${join(partes, ' UNION ALL ')}),
      cand AS (
        SELECT DISTINCT ON (c.rid, c.nid) c.rid, c.nid, c.degrau, c.dist, c.motivo FROM c
        WHERE NOT EXISTS (SELECT 1 FROM official_record_rejections x WHERE x.record_id = c.rid AND x.notification_id = c.nid)
        ORDER BY c.rid, c.nid, c.degrau, c.ordem
      )`;
  }

  /** Pares candidatos do degrau (linhas leves: ids, degrau e distância), para o vínculo automático. */
  private async candidatosDoDegrau(db: Db, degrau: 1 | 2, tz: string, mapas: MapasAgravo, filtro: { registros?: Sql; notificacoes?: Sql } = {}): Promise<Candidato[]> {
    return db.$queryRaw<Candidato[]>`
      WITH ${this.sqlCandidatos({ tz, mapas, degraus: [degrau], ...filtro })}
      SELECT rid AS "recordId", nid AS "notificationId", degrau, dist AS distancia, motivo FROM cand`;
  }

  /**
   * Par único dos dois lados num degrau. No degrau 1, com mais de um candidato, desempata a data da notificação mais
   * próxima, até 7 dias (empate = ambíguo). No degrau 2, só o candidato único (sem desempate).
   */
  private unicos(candidatos: Candidato[], desempate: boolean): Candidato[] {
    const escolher = (lista: Candidato[]) => {
      if (lista.length === 1) return lista[0]!;
      if (!desempate) return null;
      const perto = lista.filter((c) => c.distancia <= JANELA_DIAS);
      if (!perto.length) return null;
      const min = Math.min(...perto.map((c) => c.distancia));
      const melhores = perto.filter((c) => c.distancia === min);
      return melhores.length === 1 ? melhores[0]! : null;
    };
    const porRegistro = new Map<string, Candidato[]>();
    const porNotificacao = new Map<string, Candidato[]>();
    for (const c of candidatos) {
      (porRegistro.get(c.recordId) ?? porRegistro.set(c.recordId, []).get(c.recordId)!).push(c);
      (porNotificacao.get(c.notificationId) ?? porNotificacao.set(c.notificationId, []).get(c.notificationId)!).push(c);
    }
    const out: Candidato[] = [];
    for (const lista of porRegistro.values()) {
      const c = escolher(lista);
      if (!c) continue;
      const volta = escolher(porNotificacao.get(c.notificationId)!);
      if (volta && volta.recordId === c.recordId) out.push(c);
    }
    return out;
  }

  /**
   * Degraus 1 e 2 sobre os registros indicados (sem filtro: todos sem vínculo). Devolve quantos foram vinculados. Os
   * concorrentes (o "único dos dois lados") são todos os registros e notificações sem vínculo, não só os indicados:
   * primeiro as notificações que casam com os indicados (consulta pequena), depois todos os pares dessas notificações.
   * Roda dentro de uma transação (o advisory lock é da transação); o fuso é o do tenant (padrão: America/Sao_Paulo).
   */
  async conciliarAutomatico(db: Db, filtro?: { recordIds?: string[]; timeZone?: string }): Promise<number> {
    const tz = filtro?.timeZone ?? 'America/Sao_Paulo';
    const indicados = filtro?.recordIds ? [...new Set(filtro.recordIds)] : null;
    if (indicados && !indicados.length) return 0;
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('vigilancia:conciliacao'))`;
    const mapas = await this.mapasAgravo(db);
    const doFiltro = indicados ? new Set(indicados) : null;
    let total = 0;
    for (const degrau of [1, 2] as const) {
      let candidatos: Candidato[];
      if (indicados) {
        const alvo = [...new Set((await this.candidatosDoDegrau(db, degrau, tz, mapas, { registros: sql`AND r.id = ANY(${indicados}::uuid[])` })).map((c) => c.notificationId))];
        if (!alvo.length) continue;
        candidatos = await this.candidatosDoDegrau(db, degrau, tz, mapas, { notificacoes: sql`AND n.id = ANY(${alvo}::uuid[])` });
      } else candidatos = await this.candidatosDoDegrau(db, degrau, tz, mapas);
      const pares = this.unicos(candidatos, degrau === 1).filter((c) => !doFiltro || doFiltro.has(c.recordId));
      if (!pares.length) continue;
      const regs = new Map(
        (
          await emLotes(
            pares.map((c) => c.recordId),
            (lote) => db.officialRecord.findMany({ where: { id: { in: lote } }, select: { id: true, system: true, agravo: true, situation: true, evolution: true, closedOn: true } }),
          )
        ).map((r) => [r.id, r]),
      );
      const nots = new Map(
        (
          await emLotes(
            pares.map((c) => c.notificationId),
            (lote) => db.notification.findMany({ where: { id: { in: lote } }, select: { id: true, status: true, finalClass: true, evolution: true, closedAt: true } }),
          )
        ).map((n) => [n.id, n]),
      );
      const agora = new Date();
      for (const c of pares) {
        const r = regs.get(c.recordId);
        const n = nots.get(c.notificationId);
        if (!r || !n) continue;
        const { count } = await db.officialRecord.updateMany({
          where: { id: r.id, notificationId: null },
          data: { notificationId: n.id, matchMethod: degrau === 1 ? 'NUMERO_OFICIAL' : 'IDENTIDADE', matchedBy: null, matchedAt: agora, divergences: divergenciasDoPar(r, n) as object[] },
        });
        total += count;
      }
    }
    return total;
  }

  /** Recalcula as divergências gravadas dos pares vinculados (depois de uma importação mudar o registro). */
  async atualizarDivergencias(db: Db, recordIds: string[]): Promise<void> {
    for (let i = 0; i < recordIds.length; i += 1000) {
      const regs = await db.officialRecord.findMany({
        where: { id: { in: recordIds.slice(i, i + 1000) }, notificationId: { not: null } },
        select: { id: true, system: true, agravo: true, situation: true, evolution: true, closedOn: true, notificationId: true },
      });
      const nots = new Map(
        (
          await db.notification.findMany({
            where: { id: { in: regs.map((r) => r.notificationId!) } },
            select: { id: true, status: true, finalClass: true, evolution: true, closedAt: true },
          })
        ).map((n) => [n.id, n]),
      );
      for (const r of regs) {
        const n = nots.get(r.notificationId!);
        if (n) await db.officialRecord.update({ where: { id: r.id }, data: { divergences: divergenciasDoPar(r, n) as object[] } });
      }
    }
  }

  // ───────────────────────────── listas ─────────────────────────────

  private resumoRegistro(r: LinhaRegistro, sensivel: boolean): RegistroOficialResumo {
    const identificado = !!(r.patientName || r.birthDate || r.sex);
    return {
      id: r.id,
      sistema: r.system,
      tipo: r.type as RegistroOficialResumo['tipo'],
      numero: r.number,
      notificadoEm: dia(r.notifiedOn)!,
      semanaNotificacao: r.epiWeekNotified,
      agravo: r.agravo,
      grupo: r.groupKey,
      agravoNome: infoAgravoSinan(r.agravo)?.nome ?? (r.groupKey ? (NOME_DO_GRUPO.get(r.groupKey) ?? null) : null),
      unidade: { id: r.unitId, cnes: r.unitCnes, nome: r.unit?.name ?? null },
      situacao: r.situation as SituacaoCaso,
      gravidade: r.severity as RegistroOficialResumo['gravidade'],
      evolucao: r.evolution,
      encerradoEm: dia(r.closedOn),
      paciente: identificado && (!r.sensitive || sensivel) ? { nome: r.patientName, nascimento: dia(r.birthDate), sexo: r.sex } : null,
      sigiloso: r.sensitive,
      excluido: r.excluded,
      ausenteDesde: r.absentSince?.toISOString() ?? null,
      vinculo: r.notificationId ? { notificationId: r.notificationId, numero: r.notification?.number ?? '', metodo: r.matchMethod as MetodoVinculo, em: r.matchedAt?.toISOString() ?? null } : null,
    };
  }

  private resumoNotificacao(n: LinhaNotificacao, sensivel: boolean): NotificacaoParaConciliar {
    return {
      id: n.id,
      numero: n.number,
      status: n.status,
      grupo: n.groupKey,
      agravo: n.condition.name,
      notificadaEm: n.notifiedAt?.toISOString() ?? null,
      inicioSintomas: dia(n.symptomsOnset),
      unidade: { id: n.unit.id, nome: n.unit.name },
      paciente: !n.sensitive || sensivel ? { nome: n.patient.socialName ?? n.patient.name, nascimento: dia(n.patient.birthDate), sexo: n.patient.sex } : null,
      sigilosa: n.sensitive,
      sistemaOficial: n.officialSystem,
      numeroOficial: n.officialNumber,
      situacao: situacaoOmni(n),
    };
  }

  /** Lista nominal auditada como a exportação CSV: uma entrada pela lista e uma por registro sigiloso mostrado com nome. */
  private async auditarLista(ctx: RequestContext, lista: string, filtro: object, linhas: number, sigilosos: { tipo: 'OfficialRecord' | 'Notification'; id: string }[]) {
    if (!linhas) return;
    await ctx.db.$transaction(async (tx) => {
      await this.audit.record(ctx, tx, { action: 'vigilancia.conciliacao_lista', entityType: 'OfficialRecord', payload: { lista, filtro, linhas, sigilosos: sigilosos.length } });
      if (sigilosos.length)
        await this.audit.recordMany(
          ctx,
          tx,
          sigilosos.map((s) => ({ action: 'vigilancia.conciliacao_ver_sensivel', entityType: s.tipo, entityId: s.id, payload: { lista } })),
        );
    });
  }

  /** Registros oficiais pelos ids, na ordem pedida (com o nome da unidade e o número da notificação). */
  private async registrosPorId(db: Db, ids: string[]): Promise<LinhaRegistro[]> {
    const porId = new Map(((await db.officialRecord.findMany({ where: { id: { in: ids } }, select: SELECT_REGISTRO })) as LinhaRegistro[]).map((r) => [r.id, r]));
    return ids.map((id) => porId.get(id)).filter((r): r is LinhaRegistro => !!r);
  }

  /** Notificações pelos ids, na ordem pedida. */
  private async notificacoesPorId(db: Db, ids: string[]): Promise<LinhaNotificacao[]> {
    const porId = new Map((await this.carregarNotificacoes(db, ids)).map((n) => [n.id, n]));
    return ids.map((id) => porId.get(id)).filter((n): n is LinhaNotificacao => !!n);
  }

  /**
   * Filtro dos registros (alias r): sistema, data da notificação e busca por número, nome, CNS ou CPF (nome e
   * documentos só nos não sigilosos para quem não tem `notificacao.sensivel`). `outros`: alternativas a mais da busca.
   */
  private sqlFiltroRegistro(f: FiltroConciliacao, sensivel: boolean, outros: (busca: string, nome: string) => Sql[] = () => []): Sql {
    const partes: Sql[] = [];
    if (f.sistema) partes.push(sql`r.system::text = ${f.sistema}`);
    if (f.de) partes.push(sql`r.notified_on >= ${f.de}::date`);
    if (f.ate) partes.push(sql`r.notified_on <= ${f.ate}::date`);
    const busca = f.busca?.trim();
    if (busca) {
      const nome = normalizarNomePessoa(busca);
      const digitos = onlyDigits(busca);
      const sigilo = sensivel ? empty : sql` AND NOT r.sensitive`;
      const ou: Sql[] = [sql`strpos(r.number, ${busca}) > 0`];
      if (nome) ou.push(sql`(strpos(COALESCE(r.patient_name_norm, ''), ${nome}) > 0${sigilo})`);
      if (digitos.length === 15) ou.push(sql`(r.cns = ${digitos}${sigilo})`);
      if (digitos.length === 11) ou.push(sql`(r.cpf = ${digitos}${sigilo})`);
      ou.push(...outros(busca, nome));
      partes.push(sql`(${join(ou, ' OR ')})`);
    }
    return partes.length ? sql`AND ${join(partes, ' AND ')}` : empty;
  }

  /** Alternativas da busca pelo lado da notificação (alias n, paciente p): número, nome e documentos. */
  private sqlBuscaNotificacao(busca: string, sensivel: boolean): Sql[] {
    const nome = personNameKey(busca);
    const digitos = onlyDigits(busca);
    const sigilo = sensivel ? empty : sql` AND NOT n.sensitive`;
    const ou: Sql[] = [sql`strpos(n.number, ${busca}) > 0`];
    if (nome) ou.push(sql`(strpos(p.name_key, ${nome}) > 0${sigilo})`);
    if (digitos.length === 15) ou.push(sql`(p.cns = ${digitos}${sigilo})`);
    if (digitos.length === 11) ou.push(sql`(p.cpf = ${digitos}${sigilo})`);
    return ou;
  }

  private paginaDo(f: FiltroConciliacao) {
    const pagina = Math.max(1, f.pagina ?? 1);
    return { pagina, offset: (pagina - 1) * POR_PAGINA };
  }

  /** Grupos dos registros que cada importação do e-SUS Notifica gravou (para o arquivo sem `grupos`). */
  private async gruposGravados(db: Db, importacoes: string[]): Promise<Map<string, string[]>> {
    if (!importacoes.length) return new Map();
    const linhas = await db.$queryRaw<{ imp: string; grupos: string[] }[]>`
      SELECT imp, array_agg(DISTINCT g ORDER BY g) AS grupos FROM (
        SELECT first_import_id AS imp, group_key AS g FROM official_records
        WHERE system = 'ESUS_NOTIFICA' AND type = 'INDIVIDUAL' AND group_key IS NOT NULL AND first_import_id = ANY(${importacoes}::uuid[])
        UNION ALL
        SELECT last_import_id AS imp, group_key AS g FROM official_records
        WHERE system = 'ESUS_NOTIFICA' AND type = 'INDIVIDUAL' AND group_key IS NOT NULL AND last_import_id = ANY(${importacoes}::uuid[])
      ) x GROUP BY imp`;
    return new Map(linhas.map((l) => [l.imp, l.grupos]));
  }

  /**
   * Cobertura das importações aplicadas: sistema, grupos e período de cada arquivo individual (`gruposDoArquivo`: o
   * DBF do agravo e o CSV do e-SUS Sinan cobrem os agravos que vieram; o e-SUS Notifica, a ficha; só o NINDINET cobre
   * todos os grupos do Sinan Net). Junta os intervalos que se tocam por sistema e grupo e, para a tela, põe numa linha
   * só os grupos com o mesmo sistema e período.
   */
  private async cobertura(db: Db): Promise<Cobertura[]> {
    const imps = await db.officialImport.findMany({ where: { status: 'APLICADA' }, select: { id: true, files: true, periodFrom: true, periodTo: true, declaredPeriod: true } });
    const arquivos = (imp: (typeof imps)[number]) => (Array.isArray(imp.files) ? (imp.files as unknown as ArquivoDetectado[]) : []);
    const gravados = await this.gruposGravados(
      db,
      imps.filter((i) => arquivos(i).some((a) => a.tipo === 'ESUS_NOTIFICA_CSV' && !a.grupos)).map((i) => i.id),
    );
    const porChave = new Map<string, { sistema: SistemaOficial; grupo: string | null; de: string; ate: string }[]>();
    for (const imp of imps) {
      for (const a of arquivos(imp)) {
        const grupos = gruposDoArquivo(a, gravados.get(imp.id));
        if (!a.sistema || (grupos !== null && !grupos.length)) continue;
        const periodo = imp.declaredPeriod && imp.periodFrom && imp.periodTo ? { de: dia(imp.periodFrom)!, ate: dia(imp.periodTo)! } : a.periodo;
        if (!periodo) continue;
        for (const grupo of grupos ?? [null]) {
          const k = `${a.sistema}|${grupo ?? '*'}`;
          (porChave.get(k) ?? porChave.set(k, []).get(k)!).push({ sistema: a.sistema, grupo, de: periodo.de, ate: periodo.ate });
        }
      }
    }
    const umDia = (a: string, b: string) => Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`) <= 86_400_000;
    const juntos: { sistema: SistemaOficial; grupo: string | null; de: string; ate: string }[] = [];
    for (const lista of porChave.values()) {
      lista.sort((a, b) => a.de.localeCompare(b.de));
      let atual = { ...lista[0]! };
      for (const c of lista.slice(1)) {
        if (c.de <= atual.ate || umDia(c.de, atual.ate)) atual.ate = c.ate > atual.ate ? c.ate : atual.ate;
        else {
          juntos.push(atual);
          atual = { ...c };
        }
      }
      juntos.push(atual);
    }
    const linhas = new Map<string, Cobertura>();
    for (const j of juntos) {
      const k = `${j.sistema}|${j.de}|${j.ate}|${j.grupo === null ? '*' : ''}`;
      const l = linhas.get(k);
      if (l) l.grupos!.push(j.grupo!);
      else linhas.set(k, { sistema: j.sistema, grupos: j.grupo === null ? null : [j.grupo], de: j.de, ate: j.ate });
    }
    return [...linhas.values()]
      .map((l) => ({ ...l, grupos: l.grupos ? [...l.grupos].sort() : null }))
      .sort((a, b) => a.sistema.localeCompare(b.sistema) || a.de.localeCompare(b.de) || (a.grupos?.join(',') ?? '').localeCompare(b.grupos?.join(',') ?? ''));
  }

  /**
   * CTE `so` das notificações NOTIFICADA/ENCERRADA sem vínculo cujo sistema, grupo e data (a do Sinan) estão na
   * cobertura de alguma importação aplicada, com os filtros (sistema e grupo da notificação, data, busca).
   */
  private sqlSoOmnisaude(ctx: RequestContext, f: FiltroConciliacao, cobertura: Cobertura[]): Sql {
    const sensivel = this.pode(ctx, 'notificacao.sensivel');
    const busca = f.busca?.trim();
    const filtros: Sql[] = [];
    if (f.sistema) filtros.push(sql`n.official_system::text = ${f.sistema}`);
    if (f.grupo) filtros.push(sql`n.group_key = ${f.grupo}`);
    if (busca) filtros.push(sql`(${join([...this.sqlBuscaNotificacao(busca, sensivel), sql`strpos(COALESCE(n.official_number, ''), ${busca}) > 0`], ' OR ')})`);
    const datas: Sql[] = [];
    if (f.de) datas.push(sql`AND nn.data >= ${f.de}::date`);
    if (f.ate) datas.push(sql`AND nn.data <= ${f.ate}::date`);
    return sql`
      cob AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(cobertura)}::jsonb) AS c(sistema text, grupos text[], de date, ate date)),
      nn AS (
        SELECT n.id, n.official_system::text AS sistema, n.group_key, n.notified_at, ${sqlDataSinan(ctx.tenant.timeZone)} AS data
        FROM notifications n JOIN patients p ON p.id = n.patient_id
        WHERE n.status IN ('NOTIFICADA', 'ENCERRADA') AND n.official_system IS NOT NULL AND ${SEM_VINCULO}
          ${filtros.length ? sql`AND ${join(filtros, ' AND ')}` : empty}
      ),
      so AS (
        SELECT nn.* FROM nn
        WHERE EXISTS (SELECT 1 FROM cob WHERE cob.sistema = nn.sistema AND (cob.grupos IS NULL OR nn.group_key = ANY(cob.grupos)) AND nn.data BETWEEN cob.de AND cob.ate)
          ${datas.length ? join(datas, ' ') : empty}
      )`;
  }

  /** Quantas notificações "só no OmniSaúde" por sistema (sem filtro), para o resumo. */
  private async contarSoOmnisaude(ctx: RequestContext, cobertura: Cobertura[]): Promise<Map<SistemaOficial, number>> {
    if (!cobertura.length) return new Map();
    const linhas = await ctx.db.$queryRaw<{ sistema: SistemaOficial; n: number }[]>`
      WITH ${this.sqlSoOmnisaude(ctx, {}, cobertura)} SELECT sistema, count(*)::int AS n FROM so GROUP BY sistema`;
    return new Map(linhas.map((l) => [l.sistema, l.n]));
  }

  /**
   * Tabelas de tradução dos pares vinculados: a evolução do registro na numeração da ficha do OmniSaúde
   * (`evolucaoComparavel`) e a situação da notificação (`situacaoOmni`), pelas combinações que existem no banco.
   */
  private async mapasDivergencia(db: Db): Promise<{ evolucao: string; situacao: string }> {
    const ev = await db.$queryRaw<{ s: string; ag: string | null; e: string | null }[]>`
      SELECT DISTINCT system::text AS s, agravo AS ag, evolution AS e FROM official_records WHERE notification_id IS NOT NULL`;
    const st = await db.$queryRaw<{ st: string; fc: string | null }[]>`
      SELECT DISTINCT n.status::text AS st, n.final_class AS fc FROM notifications n WHERE EXISTS (SELECT 1 FROM official_records r WHERE r.notification_id = n.id)`;
    return {
      evolucao: JSON.stringify(ev.map((x) => ({ k: `${x.s}|${x.ag ?? ''}|${x.e ?? ''}`, v: evolucaoComparavel({ system: x.s, agravo: x.ag, evolution: x.e }) }))),
      situacao: JSON.stringify(st.map((x) => ({ k: `${x.st}|${x.fc ?? ''}`, v: situacaoOmni({ status: x.st, finalClass: x.fc }) }))),
    };
  }

  /**
   * CTE `pares` dos pares vinculados (registro r, notificação n, paciente p) com a marca `diverge` (situação, evolução
   * traduzida pela ficha ou encerramento diferentes), com os filtros: os do registro, o grupo de qualquer um dos lados,
   * a busca também pela notificação e o método do vínculo. `excluidos`: com os registros que o sistema oficial excluiu.
   */
  private async sqlPares(ctx: RequestContext, f: FiltroConciliacao, excluidos: boolean): Promise<Sql> {
    const sensivel = this.pode(ctx, 'notificacao.sensivel');
    const mapas = await this.mapasDivergencia(ctx.db);
    const filtroRegistro = this.sqlFiltroRegistro(f, sensivel, (busca) => this.sqlBuscaNotificacao(busca, sensivel));
    return sql`
      ev AS (SELECT * FROM jsonb_to_recordset(${mapas.evolucao}::jsonb) AS x(k text, v text)),
      sn AS (SELECT * FROM jsonb_to_recordset(${mapas.situacao}::jsonb) AS x(k text, v text)),
      pares AS (
        SELECT r.id, r.notified_on, r.number, r.matched_at,
               (r.situation IS DISTINCT FROM sn.v OR ev.v IS DISTINCT FROM n.evolution OR r.closed_on IS DISTINCT FROM n.closed_at) AS diverge
        FROM official_records r JOIN notifications n ON n.id = r.notification_id JOIN patients p ON p.id = n.patient_id
        LEFT JOIN ev ON ev.k = r.system::text || '|' || COALESCE(r.agravo, '') || '|' || COALESCE(r.evolution, '')
        LEFT JOIN sn ON sn.k = n.status::text || '|' || COALESCE(n.final_class, '')
        WHERE r.type = 'INDIVIDUAL' AND r.notification_id IS NOT NULL ${excluidos ? empty : sql`AND NOT r.excluded`}
          ${filtroRegistro}
          ${f.grupo ? sql`AND (r.group_key = ${f.grupo} OR n.group_key = ${f.grupo})` : empty}
          ${f.metodo ? sql`AND r.match_method::text = ${f.metodo}` : empty}
      )`;
  }

  /** Pares vinculados da página (com os dois lados e as diferenças), auditados como lista nominal. */
  private async listaDePares(ctx: RequestContext, lista: 'divergentes' | 'vinculados', filtro: FiltroConciliacao) {
    const sensivel = this.pode(ctx, 'notificacao.sensivel');
    const { pagina, offset } = this.paginaDo(filtro);
    const divergentes = lista === 'divergentes';
    const ordem = divergentes ? raw('notified_on, number, id') : raw('matched_at DESC NULLS LAST, notified_on, id');
    const [linha] = await ctx.db.$queryRaw<{ total: number; ids: string[] }[]>`
      WITH ${await this.sqlPares(ctx, filtro, !divergentes)}, f AS (SELECT * FROM pares ${divergentes ? sql`WHERE diverge` : empty})
      SELECT (SELECT count(*) FROM f)::int AS total,
             COALESCE((SELECT array_agg(q.id ORDER BY q.i) FROM (SELECT id, row_number() OVER (ORDER BY ${ordem}) AS i FROM f ORDER BY ${ordem} LIMIT ${POR_PAGINA} OFFSET ${offset}) q), '{}') AS ids`;
    const regs = await this.registrosPorId(ctx.db, linha!.ids);
    const nots = new Map(
      (
        await this.notificacoesPorId(
          ctx.db,
          regs.map((r) => r.notificationId!),
        )
      ).map((n) => [n.id, n]),
    );
    const pares = regs.flatMap((r) => {
      const n = nots.get(r.notificationId!);
      return n ? [{ r, n }] : [];
    });
    await this.auditarLista(ctx, lista, filtro, pares.length, this.sigilososDosPares(pares, sensivel));
    return {
      total: linha!.total,
      pagina,
      porPagina: POR_PAGINA,
      itens: pares.map(({ r, n }) => ({ registro: this.resumoRegistro(r, sensivel), notificacao: this.resumoNotificacao(n, sensivel), divergencias: divergenciasDoPar(r, n) })),
    };
  }

  /** Lados sigilosos mostrados com identificação (para a auditoria). */
  private sigilososDosPares(pares: { r: { id: string; sensitive: boolean }; n: { id: string; sensitive: boolean } }[], sensivel: boolean) {
    if (!sensivel) return [];
    return pares.flatMap(({ r, n }) => [...(r.sensitive ? [{ tipo: 'OfficialRecord' as const, id: r.id }] : []), ...(n.sensitive ? [{ tipo: 'Notification' as const, id: n.id }] : [])]);
  }

  /**
   * CTE `f` das sugestões (degraus 1 e 2 sem par único e degrau 3), sem os pares rejeitados, com os filtros: os do
   * registro (sistema e data), o grupo de qualquer um dos lados e a busca pelos números e pelos nomes (o nome não
   * serve de busca nos pares sigilosos para quem não tem `notificacao.sensivel`, nem para saber que existem).
   */
  private async sqlSugestoes(ctx: RequestContext, f: FiltroConciliacao): Promise<Sql> {
    const sensivel = this.pode(ctx, 'notificacao.sensivel');
    const mapas = await this.mapasAgravo(ctx.db);
    const registros = this.sqlFiltroRegistro({ sistema: f.sistema, de: f.de, ate: f.ate }, sensivel);
    const filtros: Sql[] = [];
    if (f.grupo) filtros.push(sql`(r.group_key = ${f.grupo} OR n.group_key = ${f.grupo})`);
    const busca = f.busca?.trim();
    if (busca) {
      const nome = normalizarNomePessoa(busca);
      const ou: Sql[] = [sql`strpos(r.number, ${busca}) > 0`, sql`strpos(n.number, ${busca}) > 0`];
      if (nome) ou.push(sql`((strpos(COALESCE(r.patient_name_norm, ''), ${nome}) > 0 OR strpos(lower(p.name_key), ${nome}) > 0)${sensivel ? empty : sql` AND NOT r.sensitive AND NOT n.sensitive`})`);
      filtros.push(sql`(${join(ou, ' OR ')})`);
    }
    return sql`
      ${this.sqlCandidatos({ tz: ctx.tenant.timeZone, mapas, degraus: [1, 2, 3], registros })},
      f AS (
        SELECT cand.* FROM cand JOIN official_records r ON r.id = cand.rid JOIN notifications n ON n.id = cand.nid JOIN patients p ON p.id = n.patient_id
        ${filtros.length ? sql`WHERE ${join(filtros, ' AND ')}` : empty}
      )`;
  }

  /** GET /vigilancia/conciliacao/resumo: contagens por SQL, sem carregar as listas. */
  async resumo(ctx: RequestContext): Promise<ResumoConciliacao> {
    const base = { type: 'INDIVIDUAL' as const, excluded: false };
    const [porSistema, vinculadosPorSistema, cobertura, ultima, bairros] = await Promise.all([
      ctx.db.officialRecord.groupBy({ by: ['system'], where: base, _count: { _all: true } }),
      ctx.db.officialRecord.groupBy({ by: ['system'], where: { ...base, notificationId: { not: null } }, _count: { _all: true } }),
      this.cobertura(ctx.db),
      ctx.db.officialImport.findFirst({ where: { status: 'APLICADA' }, orderBy: { appliedAt: 'desc' }, select: { id: true, system: true, appliedAt: true } }),
      this.bairrosSemCorrespondencia(ctx),
    ]);
    const [soOmni, [divergentes], [sugestoes]] = await Promise.all([
      this.contarSoOmnisaude(ctx, cobertura),
      this.sqlPares(ctx, {}, false).then((p) => ctx.db.$queryRaw<{ n: number }[]>`WITH ${p} SELECT count(*)::int AS n FROM pares WHERE diverge`),
      this.sqlSugestoes(ctx, {}).then((s) => ctx.db.$queryRaw<{ n: number }[]>`WITH ${s} SELECT count(*)::int AS n FROM f`),
    ]);
    const vinc = new Map(vinculadosPorSistema.map((v) => [v.system, v._count._all]));
    const sistemas = [...new Set([...porSistema.map((p) => p.system), ...soOmni.keys()])];
    const linhas = sistemas.map((s) => {
      const registros = porSistema.find((p) => p.system === s)?._count._all ?? 0;
      const vinculados = vinc.get(s) ?? 0;
      return { sistema: s as SistemaOficial, registros, vinculados, soOficial: registros - vinculados, soOmnisaude: soOmni.get(s) ?? 0 };
    });
    const registros = linhas.reduce((a, l) => a + l.registros, 0);
    const vinculados = linhas.reduce((a, l) => a + l.vinculados, 0);
    return {
      registros,
      vinculados,
      soOficial: registros - vinculados,
      soOmnisaude: linhas.reduce((a, l) => a + l.soOmnisaude, 0),
      divergentes: divergentes!.n,
      sugestoes: sugestoes!.n,
      bairrosSemCorrespondencia: bairros.length,
      porSistema: linhas,
      cobertura,
      ultimaImportacao: ultima?.appliedAt ? { id: ultima.id, sistema: ultima.system, aplicadoEm: ultima.appliedAt.toISOString() } : null,
    };
  }

  /** GET /vigilancia/conciliacao/so-oficial. */
  async soOficial(ctx: RequestContext, filtro: FiltroConciliacao): Promise<ListaSoOficial> {
    const sensivel = this.pode(ctx, 'notificacao.sensivel');
    const { pagina, offset } = this.paginaDo(filtro);
    const [linha] = await ctx.db.$queryRaw<{ total: number; ids: string[] }[]>`
      WITH f AS (
        SELECT r.id, r.notified_on, r.number FROM official_records r
        WHERE r.type = 'INDIVIDUAL' AND NOT r.excluded AND r.notification_id IS NULL
          ${this.sqlFiltroRegistro(filtro, sensivel)} ${filtro.grupo ? sql`AND r.group_key = ${filtro.grupo}` : empty}
      )
      SELECT (SELECT count(*) FROM f)::int AS total,
             COALESCE((SELECT array_agg(q.id ORDER BY q.i) FROM (SELECT id, row_number() OVER (ORDER BY notified_on, number, id) AS i FROM f ORDER BY notified_on, number, id LIMIT ${POR_PAGINA} OFFSET ${offset}) q), '{}') AS ids`;
    const rows = await this.registrosPorId(ctx.db, linha!.ids);
    const itens = rows.map((r) => this.resumoRegistro(r, sensivel));
    await this.auditarLista(
      ctx,
      'so-oficial',
      filtro,
      itens.filter((i) => i.paciente).length,
      rows.filter((r) => r.sensitive && sensivel && r.patientName).map((r) => ({ tipo: 'OfficialRecord' as const, id: r.id })),
    );
    return { total: linha!.total, pagina, porPagina: POR_PAGINA, itens };
  }

  /** GET /vigilancia/conciliacao/so-omnisaude: notificações de sistema, grupo e período cobertos, sem registro oficial vinculado. */
  async soOmnisaude(ctx: RequestContext, filtro: FiltroConciliacao): Promise<ListaSoOmnisaude> {
    const sensivel = this.pode(ctx, 'notificacao.sensivel');
    const { pagina, offset } = this.paginaDo(filtro);
    const cobertura = await this.cobertura(ctx.db);
    if (!cobertura.length) return { total: 0, pagina, porPagina: POR_PAGINA, itens: [] };
    const [linha] = await ctx.db.$queryRaw<{ total: number; ids: string[] }[]>`
      WITH ${this.sqlSoOmnisaude(ctx, filtro, cobertura)}
      SELECT (SELECT count(*) FROM so)::int AS total,
             COALESCE((SELECT array_agg(q.id ORDER BY q.i) FROM (SELECT id, row_number() OVER (ORDER BY notified_at NULLS LAST, id) AS i FROM so ORDER BY notified_at NULLS LAST, id LIMIT ${POR_PAGINA} OFFSET ${offset}) q), '{}') AS ids`;
    const nots = await this.notificacoesPorId(ctx.db, linha!.ids);
    await this.auditarLista(
      ctx,
      'so-omnisaude',
      filtro,
      nots.length,
      nots.filter((n) => n.sensitive && sensivel).map((n) => ({ tipo: 'Notification' as const, id: n.id })),
    );
    return { total: linha!.total, pagina, porPagina: POR_PAGINA, itens: nots.map((n) => this.resumoNotificacao(n, sensivel)) };
  }

  /** GET /vigilancia/conciliacao/divergentes: pares vinculados com diferença (calculada com os dados atuais dos dois lados). */
  async divergentes(ctx: RequestContext, filtro: FiltroConciliacao): Promise<ListaDivergentes> {
    return this.listaDePares(ctx, 'divergentes', filtro);
  }

  /** GET /vigilancia/conciliacao/vinculados: todos os pares vinculados, do vínculo mais recente ao mais antigo. */
  async vinculados(ctx: RequestContext, filtro: FiltroConciliacao): Promise<ListaVinculados> {
    return this.listaDePares(ctx, 'vinculados', filtro);
  }

  /** GET /vigilancia/conciliacao/sugestoes: pares sugeridos, do menor degrau e da menor distância para o maior. */
  async sugestoes(ctx: RequestContext, filtro: FiltroConciliacao): Promise<ListaSugestoesVinculo> {
    const sensivel = this.pode(ctx, 'notificacao.sensivel');
    const { pagina, offset } = this.paginaDo(filtro);
    const [linha] = await ctx.db.$queryRaw<{ total: number; itens: Candidato[] }[]>`
      WITH ${await this.sqlSugestoes(ctx, filtro)}
      SELECT (SELECT count(*) FROM f)::int AS total,
             COALESCE((SELECT json_agg(json_build_object('recordId', q.rid, 'notificationId', q.nid, 'degrau', q.degrau, 'distancia', q.dist, 'motivo', q.motivo) ORDER BY q.degrau, q.dist, q.rid, q.nid)
                       FROM (SELECT * FROM f ORDER BY degrau, dist, rid, nid LIMIT ${POR_PAGINA} OFFSET ${offset}) q), '[]'::json) AS itens`;
    const candidatos = linha!.itens;
    const regs = new Map((await this.registrosPorId(ctx.db, [...new Set(candidatos.map((c) => c.recordId))])).map((r) => [r.id, r]));
    const nots = new Map((await this.notificacoesPorId(ctx.db, [...new Set(candidatos.map((c) => c.notificationId))])).map((n) => [n.id, n]));
    const pares = candidatos.flatMap((c) => {
      const r = regs.get(c.recordId);
      const n = nots.get(c.notificationId);
      return r && n ? [{ c, r, n }] : [];
    });
    const itens: SugestaoVinculo[] = pares.map(({ c, r, n }) => ({ registro: this.resumoRegistro(r, sensivel), notificacao: this.resumoNotificacao(n, sensivel), degrau: c.degrau, motivo: c.motivo }));
    await this.auditarLista(ctx, 'sugestoes', filtro, itens.length, this.sigilososDosPares(pares, sensivel));
    return { total: linha!.total, pagina, porPagina: POR_PAGINA, itens };
  }

  /** Nomes de bairro (normalizados como os apelidos do território) dos registros de residentes, sem correspondência. */
  private async bairrosSemCorrespondencia(ctx: RequestContext): Promise<BairroSemCorrespondencia[]> {
    const { ibge } = await municipioDoTenant(this.master, ctx.tenant.id);
    const [grupos, bairros] = await Promise.all([
      ctx.db.officialRecord.groupBy({
        by: ['neighborhoodName', 'neighborhoodCode'],
        where: { type: 'INDIVIDUAL', excluded: false, neighborhoodName: { not: null }, residenceIbge: { startsWith: ibge.slice(0, 6) } },
        _count: { _all: true },
      }),
      ctx.db.neighborhood.findMany({ where: { active: true }, select: { id: true, name: true, code: true, aliases: true, locality: { select: { name: true } } } }),
    ]);
    const nomes = new Set(bairros.flatMap((b) => [b.name, ...b.aliases].map((n) => normalizarNome(n))));
    const codigos = new Set(bairros.map((b) => b.code?.trim()).filter(Boolean));
    const porNome = new Map<string, { contagens: Map<string, number>; codigo: string | null; registros: number }>();
    for (const g of grupos) {
      const norm = normalizarNome(g.neighborhoodName);
      if (!norm || nomes.has(norm) || (g.neighborhoodCode && codigos.has(g.neighborhoodCode.trim()))) continue;
      const atual = porNome.get(norm) ?? { contagens: new Map<string, number>(), codigo: null, registros: 0 };
      atual.contagens.set(g.neighborhoodName!, (atual.contagens.get(g.neighborhoodName!) ?? 0) + g._count._all);
      atual.codigo = atual.codigo ?? g.neighborhoodCode;
      atual.registros += g._count._all;
      porNome.set(norm, atual);
    }
    const out: BairroSemCorrespondencia[] = [];
    for (const [norm, a] of porNome) {
      const nome = [...a.contagens].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]![0];
      const candidatos = bairros
        .map((b) => ({ b, nota: Math.max(...[b.name, ...b.aliases].map((n) => semelhanca(norm, normalizarNome(n)))) }))
        .filter((x) => x.nota >= 0.5)
        .sort((x, y) => y.nota - x.nota || x.b.name.localeCompare(y.b.name))
        .slice(0, 5)
        .map((x) => ({ neighborhoodId: x.b.id, nome: x.b.name, localidade: x.b.locality?.name ?? null }));
      out.push({ nome, nomeNormalizado: norm, codigo: a.codigo, registros: a.registros, candidatos });
    }
    return out.sort((x, y) => y.registros - x.registros || x.nome.localeCompare(y.nome));
  }

  /** GET /vigilancia/conciliacao/bairros. */
  async bairros(ctx: RequestContext): Promise<ListaBairrosSemCorrespondencia> {
    return this.bairrosSemCorrespondencia(ctx);
  }

  // ───────────────────────────── ações ─────────────────────────────

  /** POST /vigilancia/conciliacao/vincular. */
  async vincular(ctx: RequestContext, corpo: CorpoVincular): Promise<RespostaVincular> {
    const r = await ctx.db.officialRecord.findUnique({
      where: { id: corpo.recordId },
      select: { id: true, type: true, system: true, number: true, agravo: true, notificationId: true, situation: true, evolution: true, closedOn: true },
    });
    if (!r) throw notFound('Registro oficial');
    if (r.type !== 'INDIVIDUAL') throw new DomainError('TIPO_REGISTRO', 'Só o registro individual se vincula a uma notificação', HttpStatus.UNPROCESSABLE_ENTITY);
    if (r.notificationId) throw conflict(r.notificationId === corpo.notificationId ? 'O par já está vinculado' : 'O registro já está vinculado a outra notificação: desvincule antes');
    const n = await ctx.db.notification.findUnique({
      where: { id: corpo.notificationId },
      select: { id: true, number: true, status: true, officialSystem: true, officialNumber: true, entryStatus: true, finalClass: true, evolution: true, closedAt: true, officialRecords: { select: { id: true } } },
    });
    if (!n) throw notFound('Notificação');
    if (n.status === 'RASCUNHO') throw new DomainError('RASCUNHO', 'Rascunho não se vincula: confirme ou descarte a notificação antes', HttpStatus.UNPROCESSABLE_ENTITY);
    if (n.officialRecords.length) throw conflict('A notificação já está vinculada a outro registro oficial');
    let preenchido = false;
    if (corpo.preencherNumeroOficial && n.entryStatus === 'PENDENTE' && n.officialSystem === r.system && !n.officialNumber) {
      if (!this.pode(ctx, 'vigilancia.digitar')) throw forbidden('Preencher o número oficial exige a permissão de digitação');
      // A regra do endpoint notificacoes/:id/numero-oficial (formato, número repetido, fila), sem duplicar.
      await this.notificacoes().informarNumero(ctx, n.id, { numero: r.number, lote: null });
      preenchido = true;
    }
    const divergencias = divergenciasDoPar(r, n);
    try {
      await ctx.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('vigilancia:conciliacao'))`;
        const { count } = await tx.officialRecord.updateMany({
          where: { id: r.id, notificationId: null },
          data: { notificationId: n.id, matchMethod: 'MANUAL', matchedBy: ctx.session.userId, matchedAt: new Date(), divergences: divergencias as object[] },
        });
        if (count !== 1) throw conflict('O registro mudou desde a leitura: abra de novo');
        await tx.officialRecordRejection.deleteMany({ where: { recordId: r.id, notificationId: n.id } });
        await this.audit.record(ctx, tx, {
          action: 'vigilancia.conciliacao_vincular',
          entityType: 'OfficialRecord',
          entityId: r.id,
          payload: { notificationId: n.id, notificacao: n.number, sistema: r.system, numero: r.number, motivo: corpo.motivo?.trim() || null, numeroOficialPreenchido: preenchido },
        });
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw conflict('A notificação já está vinculada a outro registro oficial');
      throw e;
    }
    return { recordId: r.id, notificationId: n.id, metodo: 'MANUAL', numeroOficialPreenchido: preenchido, divergencias };
  }

  /** POST /vigilancia/conciliacao/desvincular: o par vira rejeição (não volta no próximo vínculo automático). */
  async desvincular(ctx: RequestContext, corpo: CorpoDesvincular): Promise<RespostaOk> {
    const r = await ctx.db.officialRecord.findUnique({ where: { id: corpo.recordId }, select: { id: true, number: true, notificationId: true, matchMethod: true } });
    if (!r) throw notFound('Registro oficial');
    if (!r.notificationId) throw conflict('O registro não está vinculado');
    const notificationId = r.notificationId;
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.officialRecord.updateMany({
        where: { id: r.id, notificationId },
        data: { notificationId: null, matchMethod: null, matchedBy: null, matchedAt: null, divergences: TenantPrisma.DbNull },
      });
      if (count !== 1) throw conflict('O registro mudou desde a leitura: abra de novo');
      await tx.officialRecordRejection.upsert({
        where: { recordId_notificationId: { recordId: r.id, notificationId } },
        create: { recordId: r.id, notificationId, reason: corpo.motivo.trim(), rejectedBy: ctx.session.userId },
        update: { reason: corpo.motivo.trim(), rejectedBy: ctx.session.userId, rejectedAt: new Date() },
      });
      await this.audit.record(ctx, tx, {
        action: 'vigilancia.conciliacao_desvincular',
        entityType: 'OfficialRecord',
        entityId: r.id,
        payload: { notificationId, numero: r.number, metodoAnterior: r.matchMethod, motivo: corpo.motivo.trim() },
      });
    });
    return { ok: true };
  }

  /** POST /vigilancia/conciliacao/rejeitar ("não é o mesmo caso"). */
  async rejeitar(ctx: RequestContext, corpo: CorpoRejeitarVinculo): Promise<RespostaOk> {
    const [r, n] = await Promise.all([
      ctx.db.officialRecord.findUnique({ where: { id: corpo.recordId }, select: { id: true, number: true, notificationId: true } }),
      ctx.db.notification.findUnique({ where: { id: corpo.notificationId }, select: { id: true, number: true } }),
    ]);
    if (!r) throw notFound('Registro oficial');
    if (!n) throw notFound('Notificação');
    if (r.notificationId === n.id) throw conflict('O par está vinculado: use "desvincular"');
    await ctx.db.$transaction(async (tx) => {
      await tx.officialRecordRejection.upsert({
        where: { recordId_notificationId: { recordId: r.id, notificationId: n.id } },
        create: { recordId: r.id, notificationId: n.id, reason: corpo.motivo.trim(), rejectedBy: ctx.session.userId },
        update: { reason: corpo.motivo.trim(), rejectedBy: ctx.session.userId, rejectedAt: new Date() },
      });
      await this.audit.record(ctx, tx, {
        action: 'vigilancia.conciliacao_rejeitar',
        entityType: 'OfficialRecord',
        entityId: r.id,
        payload: { notificationId: n.id, notificacao: n.number, numero: r.number, motivo: corpo.motivo.trim() },
      });
    });
    return { ok: true };
  }

  /** POST /vigilancia/conciliacao/bairros/apelido (exige também `territorio.editar`). */
  async apelidoBairro(ctx: RequestContext, corpo: CorpoApelidoBairro): Promise<RespostaApelidoBairro> {
    if (!this.pode(ctx, 'territorio.editar')) throw forbidden('Acrescentar apelido de bairro exige a permissão de editar o território');
    const nome = corpo.nome.trim();
    const norm = normalizarNome(nome);
    if (!norm) throw new DomainError('VALIDACAO', 'Informe o nome do bairro', HttpStatus.BAD_REQUEST);
    const b = await ctx.db.neighborhood.findUnique({ where: { id: corpo.neighborhoodId }, select: { id: true, name: true, aliases: true, active: true } });
    if (!b) throw notFound('Bairro');
    if (!b.active) throw new DomainError('BAIRRO_INATIVO', 'O bairro está inativo', HttpStatus.UNPROCESSABLE_ENTITY);
    let apelidos = b.aliases;
    if (![b.name, ...b.aliases].some((n) => normalizarNome(n) === norm)) {
      const outros = await ctx.db.neighborhood.findMany({ where: { active: true, id: { not: b.id } }, select: { name: true, aliases: true } });
      const dono = outros.find((o) => [o.name, ...o.aliases].some((n) => normalizarNome(n) === norm));
      if (dono) throw conflict(`O nome "${nome}" já é do bairro ${dono.name}`);
      apelidos = [...b.aliases, nome];
      await ctx.db.$transaction(async (tx) => {
        const { count } = await tx.neighborhood.updateMany({ where: { id: b.id, aliases: { equals: b.aliases } }, data: { aliases: apelidos } });
        if (count !== 1) throw conflict('O bairro mudou desde a leitura: abra de novo');
        await this.audit.record(ctx, tx, { action: 'territorio.apelido_bairro', entityType: 'Neighborhood', entityId: b.id, payload: { bairro: b.name, apelido: nome, origem: 'conciliacao' } });
      });
    }
    const { ibge } = await municipioDoTenant(this.master, ctx.tenant.id);
    const grupos = await ctx.db.officialRecord.groupBy({
      by: ['neighborhoodName'],
      where: { type: 'INDIVIDUAL', excluded: false, neighborhoodName: { not: null }, residenceIbge: { startsWith: ibge.slice(0, 6) } },
      _count: { _all: true },
    });
    const registros = grupos.filter((g) => normalizarNome(g.neighborhoodName) === norm).reduce((a, g) => a + g._count._all, 0);
    return { neighborhoodId: b.id, apelidos, registros };
  }
}

/** Semelhança entre dois nomes normalizados (0 a 1): palavras em comum e distância de edição. */
function semelhanca(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const pa = new Set(a.split(' '));
  const pb = new Set(b.split(' '));
  const comuns = [...pa].filter((p) => pb.has(p)).length;
  const jaccard = comuns / new Set([...pa, ...pb]).size;
  return Math.max(jaccard, 1 - levenshtein(a, b) / Math.max(a.length, b.length));
}

function levenshtein(a: string, b: string): number {
  const linha = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let anterior = linha[0]!;
    linha[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const atual = linha[j]!;
      linha[j] = Math.min(linha[j]! + 1, linha[j - 1]! + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
      anterior = atual;
    }
  }
  return linha[b.length]!;
}
