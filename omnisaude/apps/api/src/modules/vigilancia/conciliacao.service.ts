import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TenantPrisma, type MasterClient } from '@omnisaude/database';
import {
  agravoSinanDaChave,
  infoAgravoSinan,
  isValidCns,
  isValidCpf,
  localDateString,
  mesmoAgravoSinan,
  normalizarNome,
  normalizarNomePessoa,
  onlyDigits,
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
import { municipioDoTenant, NOME_DO_GRUPO } from './importacao/apoio';
import { NotificacaoService } from './notificacao.service';

/**
 * Conciliação dos registros oficiais com as notificações do OmniSaúde (VIG-1c, §4.1; frente F2), em degraus: (1)
 * número oficial, (2) CNS ou CPF + mesmo grupo + datas a até 7 dias, automáticos só com candidato único; (3) nome,
 * nascimento e sexo, só sugestão; (4) sem identificador, só nas contagens. O número oficial preenchido no vínculo usa a
 * regra do NotificacaoService (sem duplicar a validação).
 */

type Db = TenantPrisma.TransactionClient;
const DIA = 86_400_000;
/** Janela dos degraus 1 (desempate) e 2 (datas da notificação ou dos sintomas). */
const JANELA_DIAS = 7;
/** Janela do degrau 3 (sugestão por nome, nascimento e sexo): mesmo grupo e datas a até 30 dias. */
const JANELA_SUGESTAO_DIAS = 30;
const POR_PAGINA = 50;
/** Sistemas em que o número é da unidade e se repete (a data entra na regra mesmo com candidato único). */
const NUMERO_DA_UNIDADE: readonly SistemaOficial[] = ['SINAN_NET', 'SINAN_ONLINE'];
const NOTIFICADAS = ['NOTIFICADA', 'ENCERRADA'] as const;

const semZeros = (s: string) => s.trim().replace(/^0+(?=\d)/, '');
const dia = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const dias = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DIA;
const par = (recordId: string, notificationId: string) => `${recordId}|${notificationId}`;
/** Ids por consulta (o Postgres aceita até 65.535 parâmetros por comando). */
const LOTE_IDS = 5000;

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

/** Colunas da notificação usadas na conciliação e nas listas (paciente, agravo e unidade vêm depois, sem relação). */
const SELECT_NOTIFICACAO = {
  id: true,
  number: true,
  status: true,
  groupKey: true,
  conditionKey: true,
  code: true,
  form: true,
  notifiedAt: true,
  knownAt: true,
  symptomsOnset: true,
  unitId: true,
  officialSystem: true,
  officialNumber: true,
  entryStatus: true,
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
  form: unknown;
  notifiedAt: Date | null;
  knownAt: Date;
  symptomsOnset: Date | null;
  unitId: string;
  officialSystem: SistemaOficial | null;
  officialNumber: string | null;
  entryStatus: string | null;
  finalClass: string | null;
  evolution: string | null;
  closedAt: Date | null;
  sensitive: boolean;
  condition: { name: string };
  unit: { id: string; name: string };
  patient: { name: string; socialName: string | null; birthDate: Date; sex: string; motherName: string | null; cns: string | null; cpf: string | null };
};

/** Data da notificação como o Sinan a vê: DT_NOTIFIC da ficha ou a data local da notificação. */
function dataSinan(n: Pick<LinhaNotificacao, 'form' | 'notifiedAt' | 'knownAt'>, timeZone: string): string {
  const f = (n.form ?? {}) as { DT_NOTIFIC?: string | null };
  return f.DT_NOTIFIC && /^\d{4}-\d{2}-\d{2}$/.test(f.DT_NOTIFIC) ? f.DT_NOTIFIC : localDateString(n.notifiedAt ?? n.knownAt, timeZone);
}

function agravoSinanDaNotificacao(n: Pick<LinhaNotificacao, 'form' | 'groupKey' | 'code' | 'conditionKey'>): string {
  const f = (n.form ?? {}) as { CS_GESTANT?: string | null };
  return agravoSinanDaChave(n.groupKey, n.code, ['1', '2', '3', '4'].includes(f.CS_GESTANT ?? ''), n.conditionKey);
}

const agravoSinanDoRegistro = (r: { groupKey: string | null; agravo: string | null }) => (r.groupKey ? agravoSinanDaChave(r.groupKey, r.agravo) : '');

/** Evolução do registro na numeração do Sinan (o e-SUS Notifica tem a sua: 1 cura, 2 óbito, 6 ignorado; o resto é caso aberto). */
function evolucaoComparavel(sistema: string, evolucao: string | null): string | null {
  if (!evolucao) return null;
  if (sistema !== 'ESUS_NOTIFICA') return evolucao;
  return ({ '1': '1', '2': '2', '6': '9' } as Record<string, string>)[evolucao] ?? null;
}

/** Diferenças do par: situação, evolução e data de encerramento. */
export function divergenciasDoPar(
  r: { system: string; situation: string; evolution: string | null; closedOn: Date | null },
  n: { status: string; finalClass: string | null; evolution: string | null; closedAt: Date | null },
): DivergenciaPar[] {
  const out: DivergenciaPar[] = [];
  const so = r.situation;
  const sn = situacaoOmni(n);
  if (so !== sn) out.push({ campo: 'situacao', oficial: so, omnisaude: sn });
  const eo = evolucaoComparavel(r.system, r.evolution);
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
  private async carregarNotificacoes(db: Db, where: TenantPrisma.NotificationWhereInput, orderBy?: TenantPrisma.NotificationOrderByWithRelationInput): Promise<LinhaNotificacao[]> {
    const rows = await db.notification.findMany({ where, select: SELECT_NOTIFICACAO, ...(orderBy ? { orderBy } : {}) });
    if (!rows.length) return [];
    const unicos = (xs: string[]) => [...new Set(xs)];
    const pacientes = new Map(
      (
        await emLotes(unicos(rows.map((r) => r.patientId)), (lote) =>
          db.patient.findMany({ where: { id: { in: lote } }, select: { id: true, name: true, socialName: true, birthDate: true, sex: true, motherName: true, cns: true, cpf: true } }),
        )
      ).map((p) => [p.id, p]),
    );
    const condicoes = new Map(
      (await emLotes(unicos(rows.map((r) => r.conditionId)), (lote) => db.notifiableCondition.findMany({ where: { id: { in: lote } }, select: { id: true, name: true } }))).map((c) => [c.id, c.name]),
    );
    const unidades = new Map((await emLotes(unicos(rows.map((r) => r.unitId)), (lote) => db.unit.findMany({ where: { id: { in: lote } }, select: { id: true, name: true } }))).map((u) => [u.id, u.name]));
    return rows.map((r) => ({ ...r, condition: { name: condicoes.get(r.conditionId) ?? '' }, unit: { id: r.unitId, name: unidades.get(r.unitId) ?? '' }, patient: pacientes.get(r.patientId)! }));
  }

  private async notificacoesPorId(db: Db, ids: string[]): Promise<LinhaNotificacao[]> {
    return emLotes(ids, (lote) => this.carregarNotificacoes(db, { id: { in: lote } }));
  }

  // ───────────────────────────── candidatos ─────────────────────────────

  /** Notificações que podem casar com algum registro: notificadas, sem vínculo, com número, documento ou nome parecido. */
  private async notificacoesCandidatas(db: Db, opts: { numeros?: string[]; sistemas?: SistemaOficial[]; cns?: string[]; cpf?: string[]; grupos?: string[] }) {
    const ids = new Set<string>();
    if (opts.numeros?.length && opts.sistemas?.length) {
      const rows = await db.$queryRaw<{ id: string }[]>`
        SELECT n.id FROM notifications n
        WHERE n.official_system::text = ANY(${opts.sistemas}::text[]) AND n.status IN ('NOTIFICADA', 'ENCERRADA')
          AND n.official_number IS NOT NULL AND ltrim(n.official_number, '0') = ANY(${opts.numeros.map((x) => x.replace(/^0+/, ''))}::text[])
          AND NOT EXISTS (SELECT 1 FROM official_records r WHERE r.notification_id = n.id)`;
      for (const r of rows) ids.add(r.id);
    }
    if ((opts.cns?.length || opts.cpf?.length) && opts.grupos?.length) {
      const rows = await db.$queryRaw<{ id: string }[]>`
        SELECT n.id FROM notifications n JOIN patients p ON p.id = n.patient_id
        WHERE n.status IN ('NOTIFICADA', 'ENCERRADA') AND n.group_key = ANY(${opts.grupos}::text[])
          AND (p.cns = ANY(${opts.cns ?? []}::text[]) OR p.cpf = ANY(${opts.cpf ?? []}::text[]))
          AND NOT EXISTS (SELECT 1 FROM official_records r WHERE r.notification_id = n.id)`;
      for (const r of rows) ids.add(r.id);
    }
    return this.notificacoesPorId(db, [...ids]);
  }

  /**
   * Pares candidatos entre registros e notificações sem vínculo, por degrau. Degrau 1: mesmo sistema, número sem zeros
   * à esquerda e agravo do Sinan; no Sinan Net e no Sinan Online (número da unidade) também a data a até 7 dias.
   * Degrau 2: CNS ou CPF válido, mesmo grupo e data da notificação ou dos sintomas a até 7 dias. Degrau 3: nome
   * normalizado, nascimento e sexo (e a mãe, quando os dois lados têm), mesmo grupo, datas a até 30 dias.
   */
  private candidatos(registros: LinhaRegistro[], notificacoes: LinhaNotificacao[], rejeitados: Set<string>, timeZone: string, degraus: (1 | 2 | 3)[]): Candidato[] {
    const out: Candidato[] = [];
    const porNumero = new Map<string, LinhaNotificacao[]>();
    const porDocumento = new Map<string, LinhaNotificacao[]>();
    const porPessoa = new Map<string, LinhaNotificacao[]>();
    const add = (m: Map<string, LinhaNotificacao[]>, k: string, n: LinhaNotificacao) => {
      const l = m.get(k);
      if (l) l.push(n);
      else m.set(k, [n]);
    };
    const datas = new Map(notificacoes.map((n) => [n.id, dataSinan(n, timeZone)]));
    for (const n of notificacoes) {
      if (n.officialSystem && n.officialNumber) add(porNumero, `${n.officialSystem}|${semZeros(n.officialNumber)}`, n);
      if (n.patient.cns && isValidCns(n.patient.cns)) add(porDocumento, `cns|${n.patient.cns}`, n);
      if (n.patient.cpf && isValidCpf(n.patient.cpf)) add(porDocumento, `cpf|${n.patient.cpf}`, n);
      add(porPessoa, `${normalizarNomePessoa(n.patient.name)}|${dia(n.patient.birthDate)}|${n.patient.sex}`, n);
    }
    for (const r of registros) {
      const dr = dia(r.notifiedOn)!;
      const sr = dia(r.symptomsOnset);
      const vistos = new Set<string>();
      const incluir = (n: LinhaNotificacao, degrau: 1 | 2 | 3, distancia: number, motivo: string) => {
        if (vistos.has(n.id) || rejeitados.has(par(r.id, n.id))) return;
        vistos.add(n.id);
        out.push({ recordId: r.id, notificationId: n.id, degrau, distancia, motivo });
      };
      const distancias = (n: LinhaNotificacao) => {
        const dn = datas.get(n.id)!;
        const ds = sr && n.symptomsOnset ? dias(sr, dia(n.symptomsOnset)!) : Infinity;
        return { notificacao: dias(dr, dn), sintomas: ds };
      };
      if (degraus.includes(1)) {
        const agravo = agravoSinanDoRegistro(r);
        for (const n of porNumero.get(`${r.system}|${semZeros(r.number)}`) ?? []) {
          if (!agravo || !mesmoAgravoSinan(agravoSinanDaNotificacao(n), agravo)) continue;
          const d = distancias(n).notificacao;
          if (NUMERO_DA_UNIDADE.includes(r.system) && d > JANELA_DIAS) continue;
          incluir(n, 1, d, 'mesmo número oficial');
        }
      }
      if (degraus.includes(2) && r.groupKey) {
        const docs = [r.cns && isValidCns(r.cns) ? `cns|${r.cns}` : null, r.cpf && isValidCpf(r.cpf) ? `cpf|${r.cpf}` : null].filter(Boolean) as string[];
        for (const k of docs)
          for (const n of porDocumento.get(k) ?? []) {
            if (n.groupKey !== r.groupKey) continue;
            const d = distancias(n);
            const menor = Math.min(d.notificacao, d.sintomas);
            if (menor > JANELA_DIAS) continue;
            incluir(n, 2, menor, k.startsWith('cns') ? 'mesmo CNS, mesmo agravo e datas próximas' : 'mesmo CPF, mesmo agravo e datas próximas');
          }
      }
      if (degraus.includes(3) && r.groupKey && r.patientNameNorm && r.birthDate && r.sex) {
        for (const n of porPessoa.get(`${r.patientNameNorm}|${dia(r.birthDate)}|${r.sex}`) ?? []) {
          if (n.groupKey !== r.groupKey) continue;
          const mae = normalizarNomePessoa(n.patient.motherName);
          if (r.motherNameNorm && mae && r.motherNameNorm !== mae) continue;
          const d = distancias(n);
          const menor = Math.min(d.notificacao, d.sintomas);
          if (menor > JANELA_SUGESTAO_DIAS) continue;
          incluir(n, 3, menor, r.motherNameNorm && mae ? 'mesmo nome, nascimento, sexo e mãe' : 'mesmo nome, nascimento e sexo');
        }
      }
    }
    return out;
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
      porRegistro.set(c.recordId, [...(porRegistro.get(c.recordId) ?? []), c]);
      porNotificacao.set(c.notificationId, [...(porNotificacao.get(c.notificationId) ?? []), c]);
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

  private async rejeicoes(db: Db, recordIds: string[]): Promise<Set<string>> {
    const linhas = await emLotes(recordIds, (lote) => db.officialRecordRejection.findMany({ where: { recordId: { in: lote } }, select: { recordId: true, notificationId: true } }));
    return new Set(linhas.map((r) => par(r.recordId, r.notificationId)));
  }

  /** Registros sem vínculo que casam com as notificações candidatas (para conferir o "único dos dois lados"). */
  private async registrosDasNotificacoes(db: Db, notificacoes: LinhaNotificacao[]): Promise<LinhaRegistro[]> {
    const numeros = [...new Set(notificacoes.filter((n) => n.officialNumber).map((n) => semZeros(n.officialNumber!).replace(/^0+/, '')))];
    const cns = [...new Set(notificacoes.map((n) => n.patient.cns).filter((x): x is string => !!x && isValidCns(x)))];
    const cpf = [...new Set(notificacoes.map((n) => n.patient.cpf).filter((x): x is string => !!x && isValidCpf(x)))];
    const ids = new Set<string>();
    if (numeros.length) {
      for (const r of await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM official_records WHERE type = 'INDIVIDUAL' AND notification_id IS NULL AND NOT excluded AND ltrim(number, '0') = ANY(${numeros}::text[])`)
        ids.add(r.id);
    }
    if (cns.length || cpf.length) {
      for (const r of await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM official_records WHERE type = 'INDIVIDUAL' AND notification_id IS NULL AND NOT excluded
          AND (cns = ANY(${cns}::text[]) OR cpf = ANY(${cpf}::text[]))`)
        ids.add(r.id);
    }
    return emLotes([...ids], async (lote) => (await db.officialRecord.findMany({ where: { id: { in: lote } }, select: SELECT_REGISTRO_BASE })) as LinhaRegistro[]);
  }

  /**
   * Degraus 1 e 2 sobre os registros indicados (sem filtro: todos sem vínculo). Devolve quantos foram vinculados. Roda
   * dentro da transação da aplicação; o fuso é o do tenant (padrão: America/Sao_Paulo).
   */
  async conciliarAutomatico(db: Db, filtro?: { recordIds?: string[]; timeZone?: string }): Promise<number> {
    const tz = filtro?.timeZone ?? 'America/Sao_Paulo';
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('vigilancia:conciliacao'))`;
    // Em lotes: o "único dos dois lados" consulta todos os concorrentes no banco, não só os do lote.
    const ids = filtro?.recordIds ?? (await db.officialRecord.findMany({ where: { type: 'INDIVIDUAL', notificationId: null, excluded: false }, select: { id: true } })).map((r) => r.id);
    let total = 0;
    for (let i = 0; i < ids.length; i += LOTE_IDS) total += await this.conciliarLote(db, ids.slice(i, i + LOTE_IDS), tz);
    return total;
  }

  private async conciliarLote(db: Db, recordIds: string[], tz: string): Promise<number> {
    let total = 0;
    for (const degrau of [1, 2] as const) {
      const lote = (await db.officialRecord.findMany({
        where: { type: 'INDIVIDUAL', notificationId: null, excluded: false, id: { in: recordIds } },
        select: SELECT_REGISTRO_BASE,
      })) as LinhaRegistro[];
      if (!lote.length) break;
      const notificacoes = await this.notificacoesCandidatas(
        db,
        degrau === 1
          ? { numeros: [...new Set(lote.map((r) => semZeros(r.number)))], sistemas: [...new Set(lote.map((r) => r.system))] }
          : {
              cns: [...new Set(lote.map((r) => r.cns).filter((x): x is string => !!x && isValidCns(x)))],
              cpf: [...new Set(lote.map((r) => r.cpf).filter((x): x is string => !!x && isValidCpf(x)))],
              grupos: [...new Set(lote.map((r) => r.groupKey).filter((x): x is string => !!x))],
            },
      );
      if (!notificacoes.length) continue;
      // Todos os registros sem vínculo que podem disputar as mesmas notificações (não só os do lote).
      const doLote = new Set(lote.map((r) => r.id));
      const outros = (await this.registrosDasNotificacoes(db, notificacoes)).filter((r) => !doLote.has(r.id));
      const todos = [...lote, ...outros];
      const rejeitados = await this.rejeicoes(
        db,
        todos.map((r) => r.id),
      );
      const pares = this.unicos(this.candidatos(todos, notificacoes, rejeitados, tz, [degrau]), degrau === 1).filter((c) => doLote.has(c.recordId));
      const notifPorId = new Map(notificacoes.map((n) => [n.id, n]));
      const regPorId = new Map(todos.map((r) => [r.id, r]));
      const agora = new Date();
      for (const c of pares) {
        const r = regPorId.get(c.recordId)!;
        const n = notifPorId.get(c.notificationId)!;
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
        select: { id: true, system: true, situation: true, evolution: true, closedOn: true, notificationId: true },
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

  private filtroRegistros(ctx: RequestContext, f: FiltroConciliacao) {
    const sensivel = this.pode(ctx, 'notificacao.sensivel');
    const busca = f.busca?.trim();
    const nome = normalizarNomePessoa(busca);
    const digitos = onlyDigits(busca ?? '');
    return {
      type: 'INDIVIDUAL' as const,
      excluded: false,
      ...(f.sistema ? { system: f.sistema } : {}),
      ...(f.grupo ? { groupKey: f.grupo } : {}),
      ...(f.de || f.ate ? { notifiedOn: { ...(f.de ? { gte: new Date(`${f.de}T00:00:00Z`) } : {}), ...(f.ate ? { lte: new Date(`${f.ate}T00:00:00Z`) } : {}) } } : {}),
      ...(busca
        ? {
            OR: [
              { number: { contains: busca } },
              ...(nome ? [{ patientNameNorm: { contains: nome }, ...(sensivel ? {} : { sensitive: false }) }] : []),
              ...(digitos.length === 15 ? [{ cns: digitos, ...(sensivel ? {} : { sensitive: false }) }] : []),
              ...(digitos.length === 11 ? [{ cpf: digitos, ...(sensivel ? {} : { sensitive: false }) }] : []),
            ],
          }
        : {}),
    };
  }

  /** Cobertura das importações aplicadas: sistema, grupos (Sinan Online: só os que vieram) e período. */
  private async cobertura(db: Db): Promise<Cobertura[]> {
    const imps = await db.officialImport.findMany({ where: { status: 'APLICADA' }, select: { files: true, periodFrom: true, periodTo: true, declaredPeriod: true } });
    const brutas: Cobertura[] = [];
    for (const imp of imps) {
      for (const a of (imp.files ?? []) as unknown as ArquivoDetectado[]) {
        if (a.ignorado || !a.sistema || a.tipoRegistro !== 'INDIVIDUAL') continue;
        const periodo = imp.declaredPeriod && imp.periodFrom && imp.periodTo ? { de: dia(imp.periodFrom)!, ate: dia(imp.periodTo)! } : a.periodo;
        if (!periodo) continue;
        const grupos = a.sistema === 'SINAN_ONLINE' ? [...new Set(a.agravos.map((x) => infoAgravoSinan(x)?.grupo).filter((g): g is string => !!g))].sort() : null;
        brutas.push({ sistema: a.sistema, grupos, de: periodo.de, ate: periodo.ate });
      }
    }
    // Junta os intervalos que se tocam, por sistema e grupos.
    const porChave = new Map<string, Cobertura[]>();
    for (const c of brutas) {
      const k = `${c.sistema}|${c.grupos?.join(',') ?? '*'}`;
      porChave.set(k, [...(porChave.get(k) ?? []), c]);
    }
    const out: Cobertura[] = [];
    for (const lista of porChave.values()) {
      lista.sort((a, b) => a.de.localeCompare(b.de));
      let atual = { ...lista[0]! };
      for (const c of lista.slice(1)) {
        if (dias(c.de, atual.ate) <= 1 || c.de <= atual.ate) atual.ate = c.ate > atual.ate ? c.ate : atual.ate;
        else {
          out.push(atual);
          atual = { ...c };
        }
      }
      out.push(atual);
    }
    return out;
  }

  /** Notificações NOTIFICADA/ENCERRADA, sem vínculo, de sistema, grupo e período cobertos por importação aplicada. */
  private async soOmnisaudeTodas(ctx: RequestContext, f: FiltroConciliacao): Promise<LinhaNotificacao[]> {
    const cobertura = await this.cobertura(ctx.db);
    if (!cobertura.length) return [];
    const sistemas = [...new Set(cobertura.map((c) => c.sistema))].filter((s) => !f.sistema || s === f.sistema);
    if (!sistemas.length) return [];
    const busca = f.busca?.trim();
    const sensivel = this.pode(ctx, 'notificacao.sensivel');
    const nome = normalizarNome(busca);
    const digitos = onlyDigits(busca ?? '');
    const rows = await this.carregarNotificacoes(
      ctx.db,
      {
        status: { in: [...NOTIFICADAS] },
        officialSystem: { in: sistemas },
        officialRecords: { none: {} },
        ...(f.grupo ? { groupKey: f.grupo } : {}),
        ...(busca
          ? {
              OR: [
                { number: { contains: busca } },
                { officialNumber: { contains: busca } },
                ...(nome ? [{ patient: { nameKey: { contains: nome } }, ...(sensivel ? {} : { sensitive: false }) }] : []),
                ...(digitos.length === 15 ? [{ patient: { cns: digitos }, ...(sensivel ? {} : { sensitive: false }) }] : []),
              ],
            }
          : {}),
      },
      { notifiedAt: 'asc' },
    );
    const tz = ctx.tenant.timeZone;
    return rows.filter((n) => {
      const d = dataSinan(n, tz);
      if ((f.de && d < f.de) || (f.ate && d > f.ate)) return false;
      return cobertura.some((c) => c.sistema === n.officialSystem && (!c.grupos || c.grupos.includes(n.groupKey)) && c.de <= d && d <= c.ate);
    });
  }

  /** Sugestões (degraus 1 e 2 sem par único e degrau 3), sem os pares rejeitados. */
  private async sugestoesTodas(ctx: RequestContext, f: FiltroConciliacao): Promise<{ sugestoes: Candidato[]; registros: Map<string, LinhaRegistro>; notificacoes: Map<string, LinhaNotificacao> }> {
    const registros = (await ctx.db.officialRecord.findMany({ where: { ...this.filtroRegistros(ctx, { ...f, busca: undefined }), notificationId: null }, select: SELECT_REGISTRO })) as LinhaRegistro[];
    const notificacoes = await this.carregarNotificacoes(ctx.db, { status: { in: [...NOTIFICADAS] }, officialRecords: { none: {} }, ...(f.grupo ? { groupKey: f.grupo } : {}) });
    const rejeitados = await this.rejeicoes(
      ctx.db,
      registros.map((r) => r.id),
    );
    const todos = this.candidatos(registros, notificacoes, rejeitados, ctx.tenant.timeZone, [1, 2, 3]);
    // Um par só uma vez, no menor degrau.
    const melhor = new Map<string, Candidato>();
    for (const c of todos) {
      const k = par(c.recordId, c.notificationId);
      const atual = melhor.get(k);
      if (!atual || c.degrau < atual.degrau) melhor.set(k, c);
    }
    const busca = normalizarNomePessoa(f.busca);
    const regs = new Map(registros.map((r) => [r.id, r]));
    const nots = new Map(notificacoes.map((n) => [n.id, n]));
    let sugestoes = [...melhor.values()];
    if (f.busca?.trim()) {
      const b = f.busca.trim();
      // Sem `notificacao.sensivel`, o nome não serve de busca nos pares sigilosos (nem para saber que existem).
      const sensivel = this.pode(ctx, 'notificacao.sensivel');
      sugestoes = sugestoes.filter((c) => {
        const r = regs.get(c.recordId)!;
        const n = nots.get(c.notificationId)!;
        const porNome = !!busca && (sensivel || (!r.sensitive && !n.sensitive)) && ((r.patientNameNorm ?? '').includes(busca) || normalizarNomePessoa(n.patient.name).includes(busca));
        return r.number.includes(b) || n.number.includes(b) || porNome;
      });
    }
    sugestoes.sort((a, b) => a.degrau - b.degrau || a.distancia - b.distancia || a.recordId.localeCompare(b.recordId));
    return { sugestoes, registros: regs, notificacoes: nots };
  }

  /** Pares vinculados com divergência (calculada na hora, com os dados atuais dos dois lados). */
  private async divergentesTodos(ctx: RequestContext, f: FiltroConciliacao) {
    const regs = (await ctx.db.officialRecord.findMany({ where: { ...this.filtroRegistros(ctx, f), notificationId: { not: null } }, select: SELECT_REGISTRO, orderBy: { notifiedOn: 'asc' } })) as LinhaRegistro[];
    if (!regs.length) return [];
    const nots = new Map(
      (
        await this.notificacoesPorId(
          ctx.db,
          regs.map((r) => r.notificationId!),
        )
      ).map((n) => [n.id, n]),
    );
    return regs.flatMap((r) => {
      const n = nots.get(r.notificationId!);
      if (!n) return [];
      const d = divergenciasDoPar(r, n);
      return d.length ? [{ r, n, d }] : [];
    });
  }

  /** GET /vigilancia/conciliacao/resumo. */
  async resumo(ctx: RequestContext): Promise<ResumoConciliacao> {
    const base = { type: 'INDIVIDUAL' as const, excluded: false };
    const [porSistema, vinculadosPorSistema, cobertura, ultima, soOmni, divergentes, sugestoes, bairros] = await Promise.all([
      ctx.db.officialRecord.groupBy({ by: ['system'], where: base, _count: { _all: true } }),
      ctx.db.officialRecord.groupBy({ by: ['system'], where: { ...base, notificationId: { not: null } }, _count: { _all: true } }),
      this.cobertura(ctx.db),
      ctx.db.officialImport.findFirst({ where: { status: 'APLICADA' }, orderBy: { appliedAt: 'desc' }, select: { id: true, system: true, appliedAt: true } }),
      this.soOmnisaudeTodas(ctx, {}),
      this.divergentesTodos(ctx, {}),
      this.sugestoesTodas(ctx, {}),
      this.bairrosSemCorrespondencia(ctx),
    ]);
    const vinc = new Map(vinculadosPorSistema.map((v) => [v.system, v._count._all]));
    const sistemas = [...new Set([...porSistema.map((p) => p.system), ...soOmni.map((n) => n.officialSystem!)])];
    const linhas = sistemas.map((s) => {
      const registros = porSistema.find((p) => p.system === s)?._count._all ?? 0;
      const vinculados = vinc.get(s) ?? 0;
      return { sistema: s as SistemaOficial, registros, vinculados, soOficial: registros - vinculados, soOmnisaude: soOmni.filter((n) => n.officialSystem === s).length };
    });
    const registros = linhas.reduce((a, l) => a + l.registros, 0);
    const vinculados = linhas.reduce((a, l) => a + l.vinculados, 0);
    return {
      registros,
      vinculados,
      soOficial: registros - vinculados,
      soOmnisaude: soOmni.length,
      divergentes: divergentes.length,
      sugestoes: sugestoes.sugestoes.length,
      bairrosSemCorrespondencia: bairros.length,
      porSistema: linhas,
      cobertura,
      ultimaImportacao: ultima?.appliedAt ? { id: ultima.id, sistema: ultima.system, aplicadoEm: ultima.appliedAt.toISOString() } : null,
    };
  }

  private pagina<T>(itens: T[], f: FiltroConciliacao) {
    const pagina = Math.max(1, f.pagina ?? 1);
    return { total: itens.length, pagina, itens: itens.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA) };
  }

  /** GET /vigilancia/conciliacao/so-oficial. */
  async soOficial(ctx: RequestContext, filtro: FiltroConciliacao): Promise<ListaSoOficial> {
    const sensivel = this.pode(ctx, 'notificacao.sensivel');
    const where = { ...this.filtroRegistros(ctx, filtro), notificationId: null };
    const pagina = Math.max(1, filtro.pagina ?? 1);
    const [total, rows] = await Promise.all([
      ctx.db.officialRecord.count({ where }),
      ctx.db.officialRecord.findMany({ where, select: SELECT_REGISTRO, orderBy: [{ notifiedOn: 'asc' }, { number: 'asc' }], skip: (pagina - 1) * POR_PAGINA, take: POR_PAGINA }),
    ]);
    const itens = (rows as LinhaRegistro[]).map((r) => this.resumoRegistro(r, sensivel));
    await this.auditarLista(
      ctx,
      'so-oficial',
      filtro,
      itens.filter((i) => i.paciente).length,
      (rows as LinhaRegistro[]).filter((r) => r.sensitive && sensivel && r.patientName).map((r) => ({ tipo: 'OfficialRecord' as const, id: r.id })),
    );
    return { total, pagina, itens };
  }

  /** GET /vigilancia/conciliacao/so-omnisaude. */
  async soOmnisaude(ctx: RequestContext, filtro: FiltroConciliacao): Promise<ListaSoOmnisaude> {
    const sensivel = this.pode(ctx, 'notificacao.sensivel');
    const todas = await this.soOmnisaudeTodas(ctx, filtro);
    const pagina = this.pagina(todas, filtro);
    await this.auditarLista(
      ctx,
      'so-omnisaude',
      filtro,
      pagina.itens.length,
      pagina.itens.filter((n) => n.sensitive && sensivel).map((n) => ({ tipo: 'Notification' as const, id: n.id })),
    );
    return { ...pagina, itens: pagina.itens.map((n) => this.resumoNotificacao(n, sensivel)) };
  }

  /** GET /vigilancia/conciliacao/divergentes. */
  async divergentes(ctx: RequestContext, filtro: FiltroConciliacao): Promise<ListaDivergentes> {
    const sensivel = this.pode(ctx, 'notificacao.sensivel');
    const pagina = this.pagina(await this.divergentesTodos(ctx, filtro), filtro);
    await this.auditarLista(
      ctx,
      'divergentes',
      filtro,
      pagina.itens.length,
      pagina.itens.filter((p) => p.r.sensitive && sensivel).map((p) => ({ tipo: 'OfficialRecord' as const, id: p.r.id })),
    );
    return { ...pagina, itens: pagina.itens.map((p) => ({ registro: this.resumoRegistro(p.r, sensivel), notificacao: this.resumoNotificacao(p.n, sensivel), divergencias: p.d })) };
  }

  /** GET /vigilancia/conciliacao/sugestoes. */
  async sugestoes(ctx: RequestContext, filtro: FiltroConciliacao): Promise<ListaSugestoesVinculo> {
    const sensivel = this.pode(ctx, 'notificacao.sensivel');
    const { sugestoes, registros, notificacoes } = await this.sugestoesTodas(ctx, filtro);
    const pagina = this.pagina(sugestoes, filtro);
    const itens: SugestaoVinculo[] = pagina.itens.map((c) => ({
      registro: this.resumoRegistro(registros.get(c.recordId)!, sensivel),
      notificacao: this.resumoNotificacao(notificacoes.get(c.notificationId)!, sensivel),
      degrau: c.degrau,
      motivo: c.motivo,
    }));
    await this.auditarLista(
      ctx,
      'sugestoes',
      filtro,
      itens.length,
      pagina.itens.filter((c) => registros.get(c.recordId)!.sensitive && sensivel).map((c) => ({ tipo: 'OfficialRecord' as const, id: c.recordId })),
    );
    return { ...pagina, itens };
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
      select: { id: true, type: true, system: true, number: true, notificationId: true, situation: true, evolution: true, closedOn: true },
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
