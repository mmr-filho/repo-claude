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
  type BairroSemCorrespondencia,
  type CorpoApelidoBairro,
  type CorpoDesvincular,
  type CorpoRejeitarVinculo,
  type CorpoVincular,
  type DivergenciaPar,
  type FiltroConciliacao,
  type ListaBairrosSemCorrespondencia,
  type ListaCandidatasVinculo,
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
import { arquivosCobertos, gruposDoArquivo, gruposDoMesmoAgravo } from './cobertura-importacao';
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
/**
 * Linhas por UPDATE em lote (SQL com um parâmetro JSON, como a gravação da importação): o Prisma 7 guarda os
 * argumentos das últimas chamadas, e um lote pequeno não deixa muita coisa presa.
 */
const LOTE_GRAVACAO = 250;

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
  /** Arquivo de um CNES só: cobre só a unidade com esse CNES (null = todas). */
  cnes: string | null;
  de: string;
  ate: string;
}

/** Tabelas de tradução (JSON) do agravo do Sinan da chave: dos registros e das notificações. */
interface MapasAgravo {
  registros: string;
  notificacoes: string;
}

/** Nome de bairro sem correspondência no território: registros por grafia, o primeiro código e o total. */
interface NomeSemCorrespondencia {
  contagens: Map<string, number>;
  codigo: string | null;
  registros: number;
}

/** Bairro ativo do território com o nome e os apelidos normalizados (`normalizarNome`). */
interface BairroNormalizado {
  id: string;
  nome: string;
  localidade: string | null;
  nomes: string[];
}

/** Ordem dos nomes nas listas (um comparador só, sem refazer a regra do idioma a cada par). */
const ORDEM = new Intl.Collator('pt-BR');

/** Quanto vincular, desvincular e rejeitar esperam pela trava da conciliação (com uma importação aplicando, ela fica ocupada). */
const ESPERA_TRAVA_MS = 3_000;
const INTERVALO_TRAVA_MS = 100;
/** A trava pode ser da importação (a aplicação inteira), da tarefa periódica (o vínculo automático) ou de outra ação. */
const MENSAGEM_OCUPADA = 'A conciliação está sendo atualizada agora (importação ou vínculo automático). Tente de novo em instantes.';

/** Chave das notificações na tabela do agravo do Sinan: grupo, CID, gestante (campo 12) e linha do catálogo. */
const CHAVE_AGRAVO_NOTIFICACAO = raw(`(n.group_key || '|' || COALESCE(n.code, '') || '|' || CASE WHEN COALESCE(n.form->>'CS_GESTANT', '') IN ('1', '2', '3', '4') THEN '1' ELSE '0' END || '|' || n.condition_key)`);
/** Mesmo agravo do Sinan (`mesmoAgravoSinan`): iguais, ou da mesma base quando um deles não tem variante. */
const MESMO_AGRAVO = raw(`(rr.agravo = nn.agravo OR (split_part(rr.agravo, ':', 1) = split_part(nn.agravo, ':', 1) AND (strpos(rr.agravo, ':') = 0 OR strpos(nn.agravo, ':') = 0)))`);
/** Notificação sem registro oficial vinculado (o índice único parcial de official_records.notification_id responde). */
const SEM_VINCULO = raw(`NOT EXISTS (SELECT 1 FROM official_records x WHERE x.notification_id = n.id)`);
/**
 * A notificação `nid` e o registro `rid` (expressões escritas no código) já são duas linhas da planilha do mesmo surto
 * aberto (N6): o vínculo automático pula o par, que fica nas sugestões.
 */
const mesmoSurtoAberto = (nid: string, rid: string) =>
  raw(
    `EXISTS (SELECT 1 FROM outbreak_cases a JOIN outbreak_cases b ON b.outbreak_id = a.outbreak_id AND b.id <> a.id JOIN outbreaks o ON o.id = a.outbreak_id ` +
      `WHERE a.notification_id = ${nid} AND b.official_record_id = ${rid} AND o.status = 'ABERTO')`,
  );

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
   * O nome dos dois lados passa pela mesma normalização (`normalizarNomePessoa` no registro, `sqlNomePessoa` no
   * paciente): a chave do cadastro (`name_key`) vai para maiúsculas antes e muda as letras de ß, ı e das ligaduras.
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
               ${sqlCpfValido('p.cpf')} AS cpf_valido, ${sqlNomePessoa('p.name')} AS nome, p.birth_date, p.sex::text AS sex, ${sqlNomePessoa('p.mother_name')} AS mae, na.a AS agravo
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
   * A gravação é em lotes e pula o par que já são duas linhas da planilha do mesmo surto aberto (N6): ele fica nas
   * sugestões, com o aviso. É o caminho de todo vínculo que não é manual (a tarefa periódica e a aplicação da
   * importação).
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
      const linhas = pares.flatMap((c) => {
        const r = regs.get(c.recordId);
        const n = nots.get(c.notificationId);
        return r && n ? [{ id: r.id, nid: n.id, divergencias: divergenciasDoPar(r, n) }] : [];
      });
      const metodo = degrau === 1 ? 'NUMERO_OFICIAL' : 'IDENTIDADE';
      const agora = new Date().toISOString();
      // Em lotes, com as condições conferidas de novo na gravação: o registro ainda sem vínculo, o par sem rejeição (a
      // gravada depois da leitura dos candidatos também vale) e fora da planilha do mesmo surto aberto (N6).
      for (let i = 0; i < linhas.length; i += LOTE_GRAVACAO)
        total += await db.$executeRaw`
          UPDATE official_records r SET notification_id = x.nid::uuid, match_method = ${metodo}::"RecordMatchMethod", matched_by = NULL,
            matched_at = ${agora}::timestamptz AT TIME ZONE 'UTC', divergences = x.divergencias, updated_at = ${agora}::timestamptz AT TIME ZONE 'UTC'
          FROM jsonb_to_recordset(${JSON.stringify(linhas.slice(i, i + LOTE_GRAVACAO))}::jsonb) AS x(id text, nid text, divergencias jsonb)
          WHERE r.id = x.id::uuid AND r.notification_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM official_record_rejections j WHERE j.record_id = r.id AND j.notification_id = x.nid::uuid)
            AND NOT ${mesmoSurtoAberto('x.nid::uuid', 'r.id')}`;
    }
    return total;
  }

  /**
   * Recalcula as divergências gravadas dos pares vinculados (depois de uma importação mudar o registro), em lotes: uma
   * leitura dos dois lados e um UPDATE por lote (SQL com um parâmetro JSON, como a gravação da importação). Antes era um
   * UPDATE por registro dentro da transação da aplicação: 4.000 alterados vinculados levavam 5 vezes o tempo dos sem
   * vínculo. As datas vêm como texto (AAAA-MM-DD): a comparação é só do dia, como em `divergenciasDoPar`.
   */
  async atualizarDivergencias(db: Db, recordIds: string[]): Promise<void> {
    const comoData = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`) : null);
    for (let i = 0; i < recordIds.length; i += LOTE_GRAVACAO) {
      const lote = recordIds.slice(i, i + LOTE_GRAVACAO);
      const pares = await db.$queryRaw<
        {
          id: string;
          system: string;
          agravo: string | null;
          situation: string;
          evolution: string | null;
          closedOn: string | null;
          status: string;
          finalClass: string | null;
          nEvolution: string | null;
          closedAt: string | null;
        }[]
      >`
        SELECT r.id::text AS id, r.system::text AS system, r.agravo, r.situation, r.evolution, r.closed_on::text AS "closedOn",
               n.status::text AS status, n.final_class AS "finalClass", n.evolution AS "nEvolution", n.closed_at::date::text AS "closedAt"
        FROM official_records r JOIN notifications n ON n.id = r.notification_id
        WHERE r.id = ANY(${lote}::uuid[])`;
      if (!pares.length) continue;
      const linhas = pares.map((p) => ({
        id: p.id,
        divergencias: divergenciasDoPar(
          { system: p.system, agravo: p.agravo, situation: p.situation, evolution: p.evolution, closedOn: comoData(p.closedOn) },
          { status: p.status, finalClass: p.finalClass, evolution: p.nEvolution, closedAt: comoData(p.closedAt) },
        ),
      }));
      const agora = new Date().toISOString();
      await db.$executeRaw`
        UPDATE official_records r SET divergences = x.divergencias, updated_at = ${agora}::timestamptz AT TIME ZONE 'UTC'
        FROM jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) AS x(id text, divergencias jsonb)
        WHERE r.id = x.id::uuid`;
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

  /**
   * Cobertura das importações aplicadas (só a APLICADA: a SUBSTITUIDA, o mesmo arquivo aplicado de novo com outro
   * período, não cobre nada): sistema, grupos, CNES e período de cada arquivo individual, os mesmos da base consolidada
   * (`arquivosCobertos`: o que o arquivo cobre nos ausentes, gravado pela aplicação, só pelas linhas do sistema dele e
   * com o período até a data local do primeiro envio do mesmo arquivo; `gruposDoArquivo`: o DBF do agravo e o CSV do
   * e-SUS Sinan cobrem os agravos que vieram, com os grupos do mesmo agravo do Sinan; o e-SUS Notifica, a ficha; só o
   * NINDINET cobre todos os grupos do Sinan Net; o arquivo de um CNES só cobre essa unidade). Junta os intervalos que se
   * tocam por sistema, grupo e CNES e, para a tela, põe numa linha só os grupos com o mesmo sistema, CNES e período.
   */
  private async cobertura(db: Db, timeZone: string): Promise<Cobertura[]> {
    type Trecho = { sistema: SistemaOficial; grupo: string | null; cnes: string | null; de: string; ate: string };
    const porChave = new Map<string, Trecho[]>();
    for (const a of await arquivosCobertos(db, timeZone)) {
      const sistema = a.fonte.sistema;
      const grupos = gruposDoArquivo(a.fonte);
      if (!sistema || (grupos !== null && !grupos.length)) continue;
      for (const cnes of a.cnes.length ? a.cnes : [null])
        for (const grupo of grupos ?? [null]) {
          const k = `${sistema}|${grupo ?? '*'}|${cnes ?? '*'}`;
          (porChave.get(k) ?? porChave.set(k, []).get(k)!).push({ sistema, grupo, cnes, de: a.de, ate: a.ate });
        }
    }
    const umDia = (a: string, b: string) => Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`) <= 86_400_000;
    const juntos: Trecho[] = [];
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
      const k = `${j.sistema}|${j.de}|${j.ate}|${j.grupo === null ? '*' : ''}|${j.cnes ?? ''}`;
      const l = linhas.get(k);
      if (l) l.grupos!.push(j.grupo!);
      else linhas.set(k, { sistema: j.sistema, grupos: j.grupo === null ? null : [j.grupo], cnes: j.cnes, de: j.de, ate: j.ate });
    }
    return [...linhas.values()]
      .map((l) => ({ ...l, grupos: l.grupos ? [...l.grupos].sort() : null }))
      .sort((a, b) => a.sistema.localeCompare(b.sistema) || a.de.localeCompare(b.de) || (a.grupos?.join(',') ?? '').localeCompare(b.grupos?.join(',') ?? '') || (a.cnes ?? '').localeCompare(b.cnes ?? ''));
  }

  /**
   * CTE `so` das notificações NOTIFICADA/ENCERRADA sem vínculo cujo sistema, grupo, unidade (o CNES, quando o arquivo
   * é de um estabelecimento só) e data (a do Sinan) estão na cobertura de alguma importação aplicada, com os filtros
   * (sistema e grupo da notificação, data, busca).
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
      cob AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(cobertura)}::jsonb) AS c(sistema text, grupos text[], cnes text, de date, ate date)),
      nn AS (
        SELECT n.id, n.official_system::text AS sistema, n.group_key, n.notified_at, ${sqlDataSinan(ctx.tenant.timeZone)} AS data, u.cnes::text AS unidade_cnes
        FROM notifications n JOIN patients p ON p.id = n.patient_id LEFT JOIN units u ON u.id = n.unit_id
        WHERE n.status IN ('NOTIFICADA', 'ENCERRADA') AND n.official_system IS NOT NULL AND ${SEM_VINCULO}
          ${filtros.length ? sql`AND ${join(filtros, ' AND ')}` : empty}
      ),
      so AS (
        SELECT nn.* FROM nn
        WHERE EXISTS (
          SELECT 1 FROM cob WHERE cob.sistema = nn.sistema AND (cob.grupos IS NULL OR nn.group_key = ANY(cob.grupos))
            AND (cob.cnes IS NULL OR cob.cnes = nn.unidade_cnes) AND nn.data BETWEEN cob.de AND cob.ate
        )
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

  /**
   * Pares (registro|notificação) que já são duas linhas da planilha do mesmo surto aberto (N6), com o número do surto:
   * o vínculo automático os pula e a sugestão avisa.
   */
  private async paresNoMesmoSurto(db: Db, pares: { recordId: string; notificationId: string }[]): Promise<Map<string, string>> {
    if (!pares.length) return new Map();
    const linhas = await db.$queryRaw<{ rid: string; nid: string; surto: string }[]>`
      SELECT x.rid, x.nid, min(o.number) AS surto
      FROM jsonb_to_recordset(${JSON.stringify(pares.map((p) => ({ rid: p.recordId, nid: p.notificationId })))}::jsonb) AS x(rid text, nid text)
      JOIN outbreak_cases a ON a.notification_id = x.nid::uuid
      JOIN outbreak_cases b ON b.outbreak_id = a.outbreak_id AND b.id <> a.id AND b.official_record_id = x.rid::uuid
      JOIN outbreaks o ON o.id = a.outbreak_id AND o.status = 'ABERTO'
      GROUP BY x.rid, x.nid`;
    return new Map(linhas.map((l) => [`${l.rid}|${l.nid}`, l.surto]));
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
      this.cobertura(ctx.db, ctx.tenant.timeZone),
      ctx.db.officialImport.findFirst({ where: { status: 'APLICADA' }, orderBy: { appliedAt: 'desc' }, select: { id: true, system: true, appliedAt: true } }),
      // Só a contagem: os bairros parecidos saem na lista, página a página.
      this.nomesSemCorrespondencia(ctx),
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
      bairrosSemCorrespondencia: bairros.nomes.size,
      porSistema: linhas,
      cobertura,
      // A APLICADA sempre tem o sistema (CHECK official_imports_sistema); o nulo é só da leitura em andamento ou que falhou.
      ultimaImportacao: ultima?.appliedAt ? { id: ultima.id, sistema: ultima.system!, aplicadoEm: ultima.appliedAt.toISOString() } : null,
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
    const cobertura = await this.cobertura(ctx.db, ctx.tenant.timeZone);
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

  /**
   * GET /vigilancia/conciliacao/candidatas: as notificações que o diálogo "Vincular…" do registro oferece. As
   * NOTIFICADA/ENCERRADA sem vínculo, com os filtros e a regra de sigilo do "só no OmniSaúde" (a busca por nome, CNS ou
   * CPF só acha a sigilosa para quem tem `notificacao.sensivel`, e o paciente dela só aparece para quem tem), mas sem a
   * cobertura das importações: a notificação do mesmo caso feita em outra unidade (arquivo de um CNES só) ou depois do
   * envio fica fora do "só no OmniSaúde" e continua achável aqui. O grupo vale com os grupos do mesmo agravo do Sinan
   * (o registro do Y09 acha a notificação da violência sexual).
   */
  async candidatas(ctx: RequestContext, filtro: FiltroConciliacao): Promise<ListaCandidatasVinculo> {
    const sensivel = this.pode(ctx, 'notificacao.sensivel');
    const { pagina, offset } = this.paginaDo(filtro);
    const busca = filtro.busca?.trim();
    const filtros: Sql[] = [];
    if (filtro.sistema) filtros.push(sql`n.official_system::text = ${filtro.sistema}`);
    if (filtro.grupo) filtros.push(sql`n.group_key = ANY(${gruposDoMesmoAgravo(filtro.grupo)}::text[])`);
    if (busca) filtros.push(sql`(${join([...this.sqlBuscaNotificacao(busca, sensivel), sql`strpos(COALESCE(n.official_number, ''), ${busca}) > 0`], ' OR ')})`);
    if (filtro.de) filtros.push(sql`${sqlDataSinan(ctx.tenant.timeZone)} >= ${filtro.de}::date`);
    if (filtro.ate) filtros.push(sql`${sqlDataSinan(ctx.tenant.timeZone)} <= ${filtro.ate}::date`);
    const [linha] = await ctx.db.$queryRaw<{ total: number; ids: string[] }[]>`
      WITH c AS (
        SELECT n.id, n.notified_at FROM notifications n JOIN patients p ON p.id = n.patient_id
        WHERE n.status IN ('NOTIFICADA', 'ENCERRADA') AND ${SEM_VINCULO} ${filtros.length ? sql`AND ${join(filtros, ' AND ')}` : empty}
      )
      SELECT (SELECT count(*) FROM c)::int AS total,
             COALESCE((SELECT array_agg(q.id ORDER BY q.i) FROM (SELECT id, row_number() OVER (ORDER BY notified_at NULLS LAST, id) AS i FROM c ORDER BY notified_at NULLS LAST, id LIMIT ${POR_PAGINA} OFFSET ${offset}) q), '{}') AS ids`;
    const nots = await this.notificacoesPorId(ctx.db, linha!.ids);
    await this.auditarLista(
      ctx,
      'candidatas',
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
    const noSurto = await this.paresNoMesmoSurto(
      ctx.db,
      pares.map(({ c }) => c),
    );
    const itens: SugestaoVinculo[] = pares.map(({ c, r, n }) => {
      const surto = noSurto.get(`${c.recordId}|${c.notificationId}`);
      return {
        registro: this.resumoRegistro(r, sensivel),
        notificacao: this.resumoNotificacao(n, sensivel),
        degrau: c.degrau,
        motivo: surto ? `${c.motivo}; as duas linhas estão no surto ${surto}` : c.motivo,
      };
    });
    await this.auditarLista(ctx, 'sugestoes', filtro, itens.length, this.sigilososDosPares(pares, sensivel));
    return { total: linha!.total, pagina, porPagina: POR_PAGINA, itens };
  }

  /**
   * Nomes de bairro (normalizados como os apelidos do território) dos registros de residentes sem correspondência no
   * território, com os registros de cada grafia, e os bairros ativos com os nomes e apelidos já normalizados (uma vez
   * só). Sem calcular os parecidos: o resumo só conta; a lista calcula os da página.
   */
  private async nomesSemCorrespondencia(ctx: RequestContext): Promise<{ nomes: Map<string, NomeSemCorrespondencia>; bairros: BairroNormalizado[] }> {
    const { ibge } = await municipioDoTenant(this.master, ctx.tenant.id);
    const [grupos, ativos] = await Promise.all([
      ctx.db.officialRecord.groupBy({
        by: ['neighborhoodName', 'neighborhoodCode'],
        where: { type: 'INDIVIDUAL', excluded: false, neighborhoodName: { not: null }, residenceIbge: { startsWith: ibge.slice(0, 6) } },
        _count: { _all: true },
      }),
      ctx.db.neighborhood.findMany({ where: { active: true }, select: { id: true, name: true, code: true, aliases: true, locality: { select: { name: true } } } }),
    ]);
    const bairros = ativos.map((b) => ({ id: b.id, nome: b.name, localidade: b.locality?.name ?? null, nomes: [...new Set([b.name, ...b.aliases].map((n) => normalizarNome(n)).filter(Boolean))] }));
    const conhecidos = new Set(bairros.flatMap((b) => b.nomes));
    const codigos = new Set(ativos.map((b) => b.code?.trim()).filter(Boolean));
    const nomes = new Map<string, NomeSemCorrespondencia>();
    for (const g of grupos) {
      const norm = normalizarNome(g.neighborhoodName);
      if (!norm || conhecidos.has(norm) || (g.neighborhoodCode && codigos.has(g.neighborhoodCode.trim()))) continue;
      const atual = nomes.get(norm) ?? { contagens: new Map<string, number>(), codigo: null, registros: 0 };
      atual.contagens.set(g.neighborhoodName!, (atual.contagens.get(g.neighborhoodName!) ?? 0) + g._count._all);
      atual.codigo = atual.codigo ?? g.neighborhoodCode;
      atual.registros += g._count._all;
      nomes.set(norm, atual);
    }
    return { nomes, bairros };
  }

  /**
   * GET /vigilancia/conciliacao/bairros: os nomes sem correspondência, do que tem mais registros para o que tem menos,
   * em páginas de 50, com os bairros parecidos (nome e apelidos) calculados só para a página (`bairrosParecidos`). Num
   * território grande são dezenas de milhares de comparações por nome: o laço de eventos é cedido entre um nome e outro
   * (a API atende os outros pedidos, de todos os municípios, no meio da página).
   */
  async bairros(ctx: RequestContext, filtro: Pick<FiltroConciliacao, 'pagina'> = {}): Promise<ListaBairrosSemCorrespondencia> {
    const { pagina, offset } = this.paginaDo(filtro);
    const { nomes, bairros } = await this.nomesSemCorrespondencia(ctx);
    // A grafia que mais aparece dá o nome mostrado (e o apelido gravado).
    const ordenados = [...nomes].map(([norm, a]) => ({ norm, a, nome: [...a.contagens].sort((x, y) => y[1] - x[1] || ORDEM.compare(x[0], y[0]))[0]![0] }));
    ordenados.sort((x, y) => y.a.registros - x.a.registros || ORDEM.compare(x.nome, y.nome));
    const comparaveis = bairrosComparaveis(bairros);
    const itens: BairroSemCorrespondencia[] = [];
    for (const { norm, a, nome } of ordenados.slice(offset, offset + POR_PAGINA)) {
      if (itens.length) await new Promise<void>((r) => setImmediate(r));
      itens.push({
        nome,
        nomeNormalizado: norm,
        codigo: a.codigo,
        registros: a.registros,
        candidatos: bairrosParecidos(norm, comparaveis).map((b) => ({ neighborhoodId: b.id, nome: b.nome, localidade: b.localidade })),
      });
    }
    return { total: ordenados.length, pagina, porPagina: POR_PAGINA, itens };
  }

  // ───────────────────────────── ações ─────────────────────────────

  /**
   * Gravação das ações da tela (vincular, desvincular, rejeitar) com a trava da conciliação, em transações curtas: cada
   * tentativa abre a transação e tenta a trava (pg_try_advisory_xact_lock); com ela, grava e faz commit na mesma
   * transação; sem ela, sai da transação (a conexão volta para o pool) e espera 100 ms fora dela, por até 3 s no total;
   * depois, 409 CONCILIACAO_OCUPADA. A trava fica com a importação durante a aplicação inteira (pega logo depois da trava
   * da importação), com a tarefa durante o vínculo automático e, por instantes, com outra ação. Esperar com a transação
   * aberta prendia uma conexão do pool por pedido: com a importação aplicando, 4 cliques esgotavam o pool do município
   * (5 conexões em produção) e as outras telas esperavam ou caíam.
   */
  private async comTrava<T>(ctx: RequestContext, gravar: (tx: Db) => Promise<T>): Promise<T> {
    const limite = Date.now() + ESPERA_TRAVA_MS;
    for (;;) {
      const tentativa = await ctx.db.$transaction(async (tx) => {
        const [trava] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('vigilancia:conciliacao')) AS ok`;
        return trava?.ok ? { valor: await gravar(tx) } : null;
      }, this.opcoesDaAcao);
      if (tentativa) return tentativa.valor;
      if (Date.now() >= limite) throw new DomainError('CONCILIACAO_OCUPADA', MENSAGEM_OCUPADA, HttpStatus.CONFLICT);
      await new Promise((r) => setTimeout(r, INTERVALO_TRAVA_MS));
    }
  }

  /** Transação de cada tentativa das ações da tela: a trava (sem esperar) e a gravação. */
  private readonly opcoesDaAcao = { maxWait: 5_000, timeout: 15_000 };

  /**
   * N6: a notificação e o registro que já são duas linhas da planilha do mesmo surto aberto não se vinculam (o caso
   * ficaria duas vezes na planilha e na exportação para o Sinan). Sob a trava da conciliação, pega as travas
   * 'surto-caso:<id>' dos surtos que têm a notificação ou o registro, em ordem crescente de id (a ordem das travas é
   * importação, conciliação, surtos; quem segura a de um surto nunca pede a da conciliação), e só então confere: a
   * inclusão da outra linha ao mesmo tempo espera ou é vista. Surto encerrado ou descartado não conta: a planilha dele
   * não muda mais, e o vínculo é que tira a dupla contagem da base consolidada.
   */
  private async conferirSurtos(tx: Db, r: { id: string; number: string }, n: { id: string }): Promise<void> {
    const surtos = await tx.$queryRaw<{ id: string }[]>`
      SELECT s.id::text AS id FROM (SELECT DISTINCT outbreak_id AS id FROM outbreak_cases WHERE notification_id = ${n.id}::uuid OR official_record_id = ${r.id}::uuid) s ORDER BY s.id`;
    for (const s of surtos) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`surto-caso:${s.id}`}))`;
    const [dupla] = await tx.$queryRaw<{ surto: string; a: number; b: number }[]>`
      SELECT o.number AS surto, a.case_number AS a, b.case_number AS b
      FROM outbreak_cases a JOIN outbreak_cases b ON b.outbreak_id = a.outbreak_id AND b.id <> a.id JOIN outbreaks o ON o.id = a.outbreak_id
      WHERE a.notification_id = ${n.id}::uuid AND b.official_record_id = ${r.id}::uuid AND o.status = 'ABERTO'
      ORDER BY o.number, a.case_number, b.case_number LIMIT 1`;
    if (dupla)
      throw new DomainError(
        'CASO_DUPLICADO_NO_SURTO',
        `A notificação e o registro ${r.number} são linhas do surto ${dupla.surto} (casos ${dupla.a} e ${dupla.b}). Retire uma das linhas da planilha antes de vincular.`,
        HttpStatus.CONFLICT,
      );
  }

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
      // Com uma importação aplicando, o 409 vem antes de mexer na notificação (o número não fica sem o vínculo): a
      // sonda pega a trava numa transação curta e a solta no commit.
      await this.comTrava(ctx, async () => undefined);
      // A regra do endpoint notificacoes/:id/numero-oficial (formato, número repetido, fila), sem duplicar.
      await this.notificacoes().informarNumero(ctx, n.id, { numero: r.number, lote: null });
      preenchido = true;
    }
    const divergencias = divergenciasDoPar(r, n);
    try {
      await this.comTrava(ctx, async (tx) => {
        await this.conferirSurtos(tx, r, n);
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
    await this.comTrava(ctx, async (tx) => {
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

  /**
   * POST /vigilancia/conciliacao/rejeitar ("não é o mesmo caso"). Com a trava da conciliação, como o vincular: o
   * vínculo automático não grava o par no meio da rejeição (e confere a rejeição de novo ao gravar).
   */
  async rejeitar(ctx: RequestContext, corpo: CorpoRejeitarVinculo): Promise<RespostaOk> {
    const [r, n] = await Promise.all([
      ctx.db.officialRecord.findUnique({ where: { id: corpo.recordId }, select: { id: true, number: true, notificationId: true } }),
      ctx.db.notification.findUnique({ where: { id: corpo.notificationId }, select: { id: true, number: true } }),
    ]);
    if (!r) throw notFound('Registro oficial');
    if (!n) throw notFound('Notificação');
    if (r.notificationId === n.id) throw conflict('O par está vinculado: use "desvincular"');
    await this.comTrava(ctx, async (tx) => {
      // Relido com a trava: o vínculo automático pode ter gravado o par enquanto o pedido esperava.
      const relido = await tx.officialRecord.findUnique({ where: { id: r.id }, select: { notificationId: true } });
      if (relido?.notificationId === n.id) throw conflict('O par está vinculado: use "desvincular"');
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

// ───────────────────────────── bairros parecidos ─────────────────────────────

/** Nota mínima (0 a 1) para um bairro do território ser parecido com o nome sem correspondência. */
const NOTA_PARECIDO = 0.5;
/** Bairros parecidos mostrados por nome. */
const PARECIDOS_POR_NOME = 5;

/** Nome normalizado pronto para comparar: o texto e as palavras distintas (calculadas uma vez por pedido). */
interface NomeComparavel {
  texto: string;
  palavras: Set<string>;
}

/** Bairro do território com o nome e os apelidos prontos para comparar. */
export interface BairroComparavel {
  id: string;
  nome: string;
  localidade: string | null;
  nomes: NomeComparavel[];
}

const comparavel = (texto: string): NomeComparavel => ({ texto, palavras: new Set(texto.split(' ')) });

/** Os bairros ativos (nome e apelidos já normalizados) prontos para `bairrosParecidos`. */
export function bairrosComparaveis(bairros: readonly { id: string; nome: string; localidade: string | null; nomes: readonly string[] }[]): BairroComparavel[] {
  return bairros.map((b) => ({ id: b.id, nome: b.nome, localidade: b.localidade, nomes: b.nomes.map(comparavel) }));
}

/**
 * Bairros parecidos com o nome sem correspondência (normalizado), do mais para o menos parecido, até 5: a nota do
 * bairro é a maior semelhança entre o nome e o nome ou os apelidos dele (palavras em comum e distância de edição), e
 * entram os de nota 0,5 ou mais, com o nome do bairro desempatando. Os candidatos e a ordem são os da conta direta de
 * todos os pares; a conta só pula o que não muda o resultado (`semelhancaAcimaDoLimiar`).
 */
export function bairrosParecidos(norm: string, bairros: readonly BairroComparavel[]): BairroComparavel[] {
  const nome = comparavel(norm);
  const notas: { b: BairroComparavel; nota: number }[] = [];
  for (const b of bairros) {
    let nota = 0;
    for (const n of b.nomes) {
      const s = semelhancaAcimaDoLimiar(nome, n);
      if (s > nota) nota = s;
    }
    if (nota >= NOTA_PARECIDO) notas.push({ b, nota });
  }
  return notas
    .sort((x, y) => y.nota - x.nota || ORDEM.compare(x.b.nome, y.b.nome))
    .slice(0, PARECIDOS_POR_NOME)
    .map((x) => x.b);
}

/**
 * Semelhança entre dois nomes normalizados (0 a 1): 1 se iguais; 0,8 se um contém o outro; senão, a maior entre a das
 * palavras em comum (Jaccard) e a da distância de edição (1 - distância / maior comprimento). Exata sempre que chega a
 * 0,5; abaixo disso pode sair menor (o bairro fica fora do mesmo jeito). A distância só conta quando leva a nota acima
 * do limiar (0,5, ou a das palavras, quando é maior): o teto é a maior distância que ainda faz isso. Pré-filtro barato:
 * a distância é pelo menos a diferença de comprimento, e acima do teto a conta fica de fora; dentro, a distância de
 * edição para assim que passa do teto (`distanciaDeEdicao`). As palavras em comum não servem de filtro: "CENTRO" e
 * "CENTRU" não têm nenhuma e são parecidos pela distância.
 */
function semelhancaAcimaDoLimiar(a: NomeComparavel, b: NomeComparavel): number {
  const x = a.texto;
  const y = b.texto;
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < y.length ? y.includes(x) : x.length > y.length && x.includes(y)) return 0.8;
  let comuns = 0;
  for (const p of a.palavras) if (b.palavras.has(p)) comuns++;
  const jaccard = comuns / (a.palavras.size + b.palavras.size - comuns);
  const maior = Math.max(x.length, y.length);
  // 1 - d / maior >= limiar  <=>  d <= (1 - limiar) * maior (com folga para o arredondamento: o teto nunca fica abaixo
  // da distância que alcança o limiar; acima do teto, a nota da distância fica abaixo dele e não muda o resultado).
  const teto = Math.floor((1 - Math.max(jaccard, NOTA_PARECIDO)) * maior + 1e-9);
  if (Math.abs(x.length - y.length) > teto) return jaccard;
  const d = distanciaDeEdicao(x, y, teto);
  return d > teto ? jaccard : Math.max(jaccard, 1 - d / maior);
}

/** Máscaras de bits do padrão no algoritmo de Myers, por código de caractere (abaixo de 128), zeradas depois de cada conta. */
const MASCARAS = new Int32Array(128);

/**
 * Distância de edição (Levenshtein: inserção, remoção e troca custam 1), a mesma da conta por programação dinâmica,
 * com teto: a conta para assim que a distância com certeza passa do teto e devolve teto + 1 (sem teto, sempre a
 * exata). Com o menor dos dois de até 32 caracteres (abaixo do código 128), pelo algoritmo de vetores de bits de Myers
 * (1999), na formulação de Hyyrö: uma passada pelo maior, com operações de 32 bits, em vez da tabela inteira; senão, a
 * tabela linha a linha só na faixa do teto em volta da diagonal.
 */
export function distanciaDeEdicao(a: string, b: string, teto = Number.POSITIVE_INFINITY): number {
  let p = a;
  let t = b;
  if (b.length < a.length) {
    p = b;
    t = a;
  }
  const m = p.length;
  const n = t.length;
  if (n - m > teto) return teto + 1;
  if (!m) return n;
  if (m > 32) return levenshteinComTeto(p, t, teto);
  for (let i = 0; i < m; i++) {
    const c = p.charCodeAt(i);
    if (c >= 128) {
      for (let k = 0; k < i; k++) MASCARAS[p.charCodeAt(k)] = 0;
      return levenshteinComTeto(p, t, teto);
    }
    MASCARAS[c] = MASCARAS[c]! | (1 << i);
  }
  const ultimo = 1 << (m - 1);
  let pv = -1;
  let mv = 0;
  let d = m;
  for (let j = 0; j < n; j++) {
    const c = t.charCodeAt(j);
    const eq = c < 128 ? MASCARAS[c]! : 0;
    const xv = eq | mv;
    const xh = (((eq & pv) + pv) ^ pv) | eq;
    let ph = mv | ~(xh | pv);
    let mh = pv & xh;
    if (ph & ultimo) d++;
    else if (mh & ultimo) d--;
    // A última linha muda no máximo 1 por coluna: com o que falta do maior, a distância não desce abaixo disto.
    if (d - (n - 1 - j) > teto) {
      d = teto + 1;
      break;
    }
    ph = (ph << 1) | 1;
    mh <<= 1;
    pv = mh | ~(xv | ph);
    mv = ph & xv;
  }
  for (let i = 0; i < m; i++) MASCARAS[p.charCodeAt(i)] = 0;
  return d;
}

/**
 * Distância de edição pela tabela de programação dinâmica, linha a linha, só na faixa |i - j| <= teto (fora dela a
 * distância passa do teto), parando quando a linha inteira passa do teto (para o nome de mais de 32 caracteres ou fora
 * do ASCII). `a` é o menor.
 */
function levenshteinComTeto(a: string, b: string, teto: number): number {
  const fora = Number.isFinite(teto) ? teto + 1 : Number.POSITIVE_INFINITY;
  const linha = Array.from({ length: b.length + 1 }, (_, j) => (j > teto ? fora : j));
  for (let i = 1; i <= a.length; i++) {
    const de = Math.max(1, i - teto);
    const ate = Math.min(b.length, i + teto);
    let anterior = linha[de - 1]!;
    linha[de - 1] = de - 1 === 0 ? (i > teto ? fora : i) : fora;
    let menor = linha[de - 1]!;
    for (let j = de; j <= ate; j++) {
      const atual = linha[j]!;
      linha[j] = Math.min(linha[j]! + 1, linha[j - 1]! + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1), fora);
      anterior = atual;
      if (linha[j]! < menor) menor = linha[j]!;
    }
    if (ate < b.length) linha[ate + 1] = fora;
    if (menor > teto) return fora;
  }
  return linha[b.length]!;
}
