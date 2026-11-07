import type { TenantClient, TenantPrisma } from '@omnisaude/database';
import {
  buildAtendimentoIndividual,
  buildAtendimentoOdontologico,
  buildCadastroDomiciliar,
  buildCadastroIndividual,
  buildProcedimentos,
  buildVacinacao,
  buildVisitaDomiciliar,
  CBO_POR_MODELO,
  DOSE_VACINA,
  FABRICANTE_RNDS,
  lediUuid,
  TIPO_DADO,
  turnoFromDate,
  type AtendimentoIndividualInput,
  type AtendimentoOdontologicoInput,
  type Cidadao,
  type LediObject,
  type Lotacao,
  type Medicoes,
  type ProcedimentoAtendimentoInput,
  type VacinacaoAtendimentoInput,
  type VisitaDomiciliarInput,
} from '@omnisaude/esus';
import { motivosEsusVisitaVetorial, SITUACAO_INFO, type Depositos, type LocalUbv, type PrecisaoGeo } from '@omnisaude/shared';
import { PRECISAO_LIGA_QUARTEIRAO } from '../territorio/localizador.service';

/**
 * Fontes das fichas do e-SUS APS nos registros do sistema. Cada fonte devolve fichas prontas para serializar,
 * com a origem (tipo/id do registro) para rastrear glosas e reprocessar.
 */

export interface FichaGerada {
  kind: number;
  uuid: string;
  sourceType: string;
  sourceId: string;
  patientId: string | null;
  ine: string | null;
  ficha: LediObject;
  summary: Record<string, unknown>;
  /** Registros de origem que entraram na ficha (esus_record_items); vazio nos cadastros, que são atualizações. */
  itens: string[];
}

export interface FonteContexto {
  db: TenantClient;
  unit: { id: string; cnes: string; ibgeCode: string; type: string };
  codigoIbge: string;
  timeZone: string;
  from: Date;
  to: Date;
  /** Lotação usada no cabeçalho das fichas de cadastro (quem gera o lote). */
  cadastroLotacao: Lotacao;
  /** Ficha anterior (uuid) por origem, para marcar atualizações de cadastro. */
  previousUuid: (sourceType: string, sourceId: string) => string | undefined;
  /**
   * Reprocessamento: só os registros das fichas reprocessadas (ids por tipo de origem), sem o filtro do período nem do
   * que já foi exportado. Cada ficha nova junta registros de uma só ficha antiga (`fichaDe`) e leva o uuid dela.
   */
  reprocesso?: { ids: ReadonlyMap<string, readonly string[]>; fichaDe: (kind: number, sourceType: string, sourceId: string) => { id: string; uuid: string } | undefined };
  /** Registros do período que ficaram de fora por já estarem numa ficha de algum lote. */
  estatistica: { jaExportados: number };
}

type Db = TenantClient;

const LOCAL_UBS = 1;
const LOCAL_DOMICILIO = 4;
/** Condutas do atendimento individual a partir do desfecho do atendimento. */
const CONDUTA_POR_DESFECHO: Record<string, number> = { ALTA: 9, ENCAMINHAMENTO: 4, INTERNACAO: 6, TRANSFERENCIA: 7, OBITO: 9, EVASAO: 9 };
/** Justificativa padrão quando o cidadão não tem CPF no cadastro: 8 = pessoa indocumentada. */
const JUSTIFICATIVA_SEM_CPF_PADRAO = 8;

/** Início e fim do atendimento: nunca invertidos nem no futuro (o PEC recusa data posterior à atual). */
function janela(inicio: Date, fim: Date): { inicio: Date; fim: Date } {
  const now = Date.now();
  const a = Math.min(inicio.getTime(), fim.getTime(), now);
  const b = Math.min(Math.max(inicio.getTime(), fim.getTime(), a + 60_000), now);
  return { inicio: new Date(Math.min(a, b - 60_000)), fim: new Date(b) };
}

export function localDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function cidadao(p: { name: string; socialName: string | null; birthDate: Date; sex: string; cpf: string | null; cns: string | null; homeless?: boolean }): Cidadao {
  return { name: p.name, socialName: p.socialName, birthDate: p.birthDate, sex: p.sex, cpf: p.cpf, cns: p.cns, justificativaSemCpf: p.cpf ? null : p.homeless ? 5 : JUSTIFICATIVA_SEM_CPF_PADRAO };
}

/** Ids por consulta: o PostgreSQL aceita no máximo 32.767 parâmetros, e um IN com dezenas de milhares de ids passa disso. */
export const LOTE_IDS = 5_000;

/** Consulta por ids em lotes de até LOTE_IDS. */
export async function emLotes<T>(ids: readonly string[], fn: (lote: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += LOTE_IDS) out.push(...(await fn(ids.slice(i, i + LOTE_IDS))));
  return out;
}

/** Profissional na unidade: lotações ativas (papel e CBO) e participações ativas em equipes ativas (CBO e INE). */
interface Profissional {
  name: string;
  cns: string;
  lotacoes: { role: string; cbo: string }[];
  equipes: { teamId: string; cbo: string; ine: string | null }[];
}

async function profissionais(db: Db, unitId: string, userIds: string[]): Promise<Map<string, Profissional>> {
  const users = await emLotes(userIds, (lote) =>
    db.user.findMany({
      where: { id: { in: lote } },
      include: { assignments: { where: { unitId, active: true } }, teamMembers: { where: { active: true, team: { unitId, active: true } }, include: { team: true } } },
    }),
  );
  return new Map(
    users.map((u) => [
      u.id,
      { name: u.name, cns: u.cns ?? '', lotacoes: u.assignments.map((a) => ({ role: a.role, cbo: a.cbo })), equipes: u.teamMembers.map((m) => ({ teamId: m.teamId, cbo: m.cbo, ine: m.team.ine })) },
    ]),
  );
}

/** Cabeçalho das fichas de atendimento, procedimentos e vacina: a CBO da lotação na unidade e a equipe dessa CBO (sem ela, a primeira equipe do profissional na unidade). */
function lotacaoAtendimento(p: Profissional | undefined, cnes: string): Lotacao {
  const cbo = p?.lotacoes[0]?.cbo ?? '';
  const equipe = p?.equipes.find((e) => e.cbo === cbo) ?? p?.equipes[0];
  return { cns: p?.cns ?? '', cbo, cnes, ine: equipe?.ine ?? null };
}

/** Papéis da lotação de cada visita: o ACS na visita domiciliar; o agente de endemias (ou o supervisor de campo) na vetorial. */
const PAPEIS_DA_VISITA: Record<'HomeVisit' | 'VectorVisit', readonly string[]> = { HomeVisit: ['ACS'], VectorVisit: ['ACE', 'SUPERVISOR_ENDEMIAS'] };

/**
 * Cabeçalho da ficha de visita, resolvido na exportação: a CBO gravada na visita quando o modelo a aceita; senão a da
 * lotação ativa do profissional na unidade no papel daquela visita, para a correção da lotação valer no reprocessamento.
 * O INE é o da equipe em que o profissional está com essa CBO (com mais de uma, a das visitas); sem equipe com essa CBO,
 * a ficha vai sem INE, para a produção não ser creditada a uma equipe em que ele não atua com essa ocupação.
 */
function lotacaoVisita(p: Profissional | undefined, sourceType: 'HomeVisit' | 'VectorVisit', cboDaVisita: string, cnes: string, equipesDasVisitas: (string | null)[]): Lotacao {
  const aceita = (cbo: string) => CBO_POR_MODELO.VISITA_DOMICILIAR.includes(cbo);
  const papeis = PAPEIS_DA_VISITA[sourceType];
  const doPapel = (p?.lotacoes ?? []).filter((l) => papeis.includes(l.role)).sort((a, b) => papeis.indexOf(a.role) - papeis.indexOf(b.role));
  const cbo = aceita(cboDaVisita) ? cboDaVisita : ((doPapel.find((l) => aceita(l.cbo)) ?? doPapel[0])?.cbo ?? cboDaVisita);
  const comCbo = (p?.equipes ?? []).filter((e) => e.cbo === cbo);
  const vezes = (teamId: string) => equipesDasVisitas.filter((t) => t === teamId).length;
  const equipe = comCbo.length > 1 ? [...comCbo].sort((a, b) => vezes(b.teamId) - vezes(a.teamId))[0] : comCbo[0];
  return { cns: p?.cns ?? '', cbo, cnes, ine: equipe?.ine ?? null };
}

/** Linhas da fonte: no lote, as do período; no reprocessamento, só as das fichas regeradas (pelos ids, sem o período). */
async function linhas<T extends { id: string }>(ctx: FonteContexto, sourceType: string, doPeriodo: () => Promise<T[]>, dosIds: (ids: string[]) => Promise<T[]>, momento: (r: T) => Date): Promise<T[]> {
  if (!ctx.reprocesso) return doPeriodo();
  const ids = ctx.reprocesso.ids.get(sourceType) ?? [];
  const rows = ids.length ? await emLotes(ids, dosIds) : [];
  return rows.sort((a, b) => momento(a).getTime() - momento(b).getTime() || a.id.localeCompare(b.id));
}

/**
 * Tira os registros que já estão numa ficha deste tipo, de qualquer lote e em qualquer situação (esus_record_items): o
 * lote novo do mesmo período leva só o que faltou, como a visita sincronizada depois do envio, sem repetir o resto.
 */
async function naoExportados<T extends { id: string }>(ctx: FonteContexto, kind: number, sourceType: string, rows: T[]): Promise<T[]> {
  if (ctx.reprocesso || !rows.length) return rows;
  const itens = await emLotes(
    rows.map((r) => r.id),
    (lote) => ctx.db.esusRecordItem.findMany({ where: { kind, sourceType, sourceId: { in: lote } }, select: { sourceId: true } }),
  );
  if (!itens.length) return rows;
  const ja = new Set(itens.map((i) => i.sourceId));
  ctx.estatistica.jaExportados += ja.size;
  return rows.filter((r) => !ja.has(r.id));
}

/** Uuid da ficha: novo no lote; no reprocessamento, o da ficha regerada, dentro do arquivo e no DadoTransporte. */
function uuidDa(ctx: FonteContexto, kind: number, sourceType: string, sourceId: string): string {
  return ctx.reprocesso?.fichaDe(kind, sourceType, sourceId)?.uuid ?? lediUuid(ctx.unit.cnes);
}

function medicoesFromTriage(
  t:
    | {
        systolic: number | null;
        diastolic: number | null;
        heartRate: number | null;
        respiratoryRate: number | null;
        temperature: unknown;
        spo2: number | null;
        glucose: number | null;
        weightKg: unknown;
        heightCm: number | null;
      }
    | null
    | undefined,
): Medicoes | null {
  if (!t) return null;
  return {
    systolic: t.systolic,
    diastolic: t.diastolic,
    heartRate: t.heartRate,
    respiratoryRate: t.respiratoryRate,
    temperature: t.temperature === null || t.temperature === undefined ? null : Number(t.temperature),
    spo2: t.spo2,
    glucose: t.glucose,
    weightKg: t.weightKg === null || t.weightKg === undefined ? null : Number(t.weightKg),
    heightCm: t.heightCm,
  };
}

function problemas(codes: string[]): { ciap?: string; cid10?: string }[] {
  const out: { ciap?: string; cid10?: string }[] = [];
  for (const c of codes) {
    const [system, code] = c.includes(':') ? c.split(':', 2) : ['CID10', c];
    if (!code) continue;
    out.push(system === 'CIAP2' ? { ciap: code } : { cid10: code });
  }
  return out;
}

/**
 * Agrupa por profissional (e CBO, nas visitas) e dia local: uma ficha por grupo, até 99 registros. No reprocessamento,
 * também pela ficha antiga, para registros de fichas diferentes nunca se misturarem.
 */
function agrupar<T extends { id: string }>(
  ctx: FonteContexto,
  kind: number,
  sourceType: string,
  items: T[],
  key: (i: T) => { userId: string; cbo?: string; at: Date },
): { userId: string; cbo: string; day: string; items: T[] }[] {
  const groups = new Map<string, { userId: string; cbo: string; day: string; items: T[] }>();
  for (const item of items) {
    const k = key(item);
    const day = localDate(k.at, ctx.timeZone);
    const id = [k.userId, k.cbo ?? '', day, ctx.reprocesso?.fichaDe(kind, sourceType, item.id)?.id ?? ''].join('|');
    const g = groups.get(id) ?? { userId: k.userId, cbo: k.cbo ?? '', day, items: [] };
    g.items.push(item);
    groups.set(id, g);
  }
  return [...groups.values()];
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function dayStart(day: string, timeZone: string): Date {
  // Meia-noite local do dia (aproximada pelo deslocamento do fuso no meio-dia).
  const noon = new Date(`${day}T12:00:00Z`);
  const local = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(noon);
  const offsetHours = 12 - (Number(local) % 24);
  return new Date(noon.getTime() + (offsetHours - 12) * 3_600_000);
}

// ─── Atendimento individual e odontológico ───────────────────────────────────

export async function fichasAtendimento(ctx: FonteContexto): Promise<FichaGerada[]> {
  const { db, unit, timeZone } = ctx;
  const where = { status: 'ASSINADO', kind: { in: ['SOAP', 'EVOLUCAO', 'ODONTOGRAMA'] }, encounter: { unitId: unit.id, status: 'ENCERRADO' } } satisfies TenantPrisma.ClinicalNoteWhereInput;
  const include = { encounter: { include: { patient: true, triages: { orderBy: { classifiedAt: 'desc' }, take: 1 }, examRequests: true } } } satisfies TenantPrisma.ClinicalNoteInclude;
  const notes = await linhas(
    ctx,
    'ClinicalNote',
    () => db.clinicalNote.findMany({ where: { ...where, signedAt: { gte: ctx.from, lte: ctx.to } }, include, orderBy: { signedAt: 'asc' } }),
    (ids) => db.clinicalNote.findMany({ where: { ...where, id: { in: ids } }, include }),
    (n) => n.signedAt ?? new Date(0),
  );
  const clinical = await naoExportados(
    ctx,
    TIPO_DADO.ATENDIMENTO_INDIVIDUAL,
    'ClinicalNote',
    notes.filter((n) => n.kind !== 'ODONTOGRAMA'),
  );
  const odonto = await naoExportados(
    ctx,
    TIPO_DADO.ATENDIMENTO_ODONTOLOGICO,
    'ClinicalNote',
    notes.filter((n) => n.kind === 'ODONTOGRAMA'),
  );
  const profs = await profissionais(db, unit.id, [...new Set([...clinical, ...odonto].map((n) => n.authorId))]);
  const out: FichaGerada[] = [];

  for (const g of agrupar(ctx, TIPO_DADO.ATENDIMENTO_INDIVIDUAL, 'ClinicalNote', clinical, (n) => ({ userId: n.authorId, at: n.signedAt! }))) {
    const prof = profs.get(g.userId);
    const lot = lotacaoAtendimento(prof, unit.cnes);
    for (const part of chunks(g.items, 99)) {
      const atendimentos: AtendimentoIndividualInput[] = part.map((n) => {
        const e = n.encounter;
        const start = e.startedAt;
        const end = e.endedAt ?? n.signedAt ?? start;
        return {
          cidadao: cidadao(e.patient),
          localAtendimento: e.kind === 'DOMICILIAR' ? LOCAL_DOMICILIO : LOCAL_UBS,
          turno: turnoFromDate(start, timeZone),
          tipoAtendimento: e.kind === 'URGENCIA' ? 6 : e.kind === 'DOMICILIAR' ? 7 : e.appointmentId ? 2 : 5,
          inicio: start,
          fim: end > start ? end : new Date(start.getTime() + 60_000),
          medicoes: medicoesFromTriage(e.triages[0]),
          problemas: problemas(n.codes),
          condutas: [(e.outcome && CONDUTA_POR_DESFECHO[e.outcome]) || 1],
          exames: e.examRequests.map((x) => ({ codigo: x.sigtapCode, solicitado: true, avaliado: x.status === 'RESULTADO' })),
        };
      });
      const first = part[0]!;
      const uuid = uuidDa(ctx, TIPO_DADO.ATENDIMENTO_INDIVIDUAL, 'ClinicalNote', first.id);
      out.push({
        kind: TIPO_DADO.ATENDIMENTO_INDIVIDUAL,
        uuid,
        sourceType: 'ClinicalNote',
        sourceId: first.id,
        patientId: part.length === 1 ? first.encounter.patientId : null,
        ine: lot.ine ?? null,
        ficha: buildAtendimentoIndividual({
          uuid,
          header: { principal: lot, dataAtendimento: dayStart(g.day, timeZone), codigoIbge: ctx.codigoIbge },
          atendimentos,
        }),
        summary: { profissional: prof?.name ?? g.userId, dia: g.day, atendimentos: part.length, registros: part.map((n) => n.id) },
        itens: part.map((n) => n.id),
      });
    }
  }

  for (const g of agrupar(ctx, TIPO_DADO.ATENDIMENTO_ODONTOLOGICO, 'ClinicalNote', odonto, (n) => ({ userId: n.authorId, at: n.signedAt! }))) {
    const prof = profs.get(g.userId);
    const lot = lotacaoAtendimento(prof, unit.cnes);
    for (const part of chunks(g.items, 99)) {
      const atendimentos: AtendimentoOdontologicoInput[] = part.map((n) => {
        const e = n.encounter;
        const data = (n.data ?? {}) as Record<string, unknown>;
        const start = e.startedAt;
        const end = e.endedAt ?? n.signedAt ?? start;
        const procs = Array.isArray(data.procedimentos)
          ? (data.procedimentos as { codigo: string; quantidade?: number }[]).filter((p) => typeof p?.codigo === 'string').map((p) => ({ codigo: p.codigo.replace(/\D/g, ''), quantidade: p.quantidade ?? 1 }))
          : [];
        return {
          cidadao: cidadao(e.patient),
          localAtendimento: LOCAL_UBS,
          tipoAtendimento: e.appointmentId ? 2 : 5,
          turno: turnoFromDate(start, timeZone),
          inicio: start,
          fim: end > start ? end : new Date(start.getTime() + 60_000),
          condutas: [e.outcome === 'ENCAMINHAMENTO' ? 12 : 16],
          vigilancia: [99],
          tipoConsulta: typeof data.tipoConsulta === 'number' ? data.tipoConsulta : 1,
          procedimentos: procs,
          problemas: problemas(n.codes),
          medicoes: medicoesFromTriage(e.triages[0]),
        };
      });
      const first = part[0]!;
      const uuid = uuidDa(ctx, TIPO_DADO.ATENDIMENTO_ODONTOLOGICO, 'ClinicalNote', first.id);
      out.push({
        kind: TIPO_DADO.ATENDIMENTO_ODONTOLOGICO,
        uuid,
        sourceType: 'ClinicalNote',
        sourceId: first.id,
        patientId: part.length === 1 ? first.encounter.patientId : null,
        ine: lot.ine ?? null,
        ficha: buildAtendimentoOdontologico({
          uuid,
          header: { principal: lot, dataAtendimento: dayStart(g.day, timeZone), codigoIbge: ctx.codigoIbge },
          atendimentos,
        }),
        summary: { profissional: prof?.name ?? g.userId, dia: g.day, atendimentos: part.length, registros: part.map((n) => n.id) },
        itens: part.map((n) => n.id),
      });
    }
  }
  return out;
}

// ─── Procedimentos (aferições da classificação de risco / acolhimento) ───────

export async function fichasProcedimentos(ctx: FonteContexto): Promise<FichaGerada[]> {
  const { db, unit, timeZone } = ctx;
  const where = { encounter: { unitId: unit.id } } satisfies TenantPrisma.TriageWhereInput;
  const include = { encounter: { include: { patient: true } } } satisfies TenantPrisma.TriageInclude;
  const triages = await naoExportados(
    ctx,
    TIPO_DADO.PROCEDIMENTOS,
    'Triage',
    await linhas(
      ctx,
      'Triage',
      () => db.triage.findMany({ where: { ...where, classifiedAt: { gte: ctx.from, lte: ctx.to } }, include, orderBy: { classifiedAt: 'asc' } }),
      (ids) => db.triage.findMany({ where: { ...where, id: { in: ids } }, include }),
      (t) => t.classifiedAt,
    ),
  );
  const profs = await profissionais(db, unit.id, [...new Set(triages.map((t) => t.nurseId))]);
  const out: FichaGerada[] = [];
  for (const g of agrupar(ctx, TIPO_DADO.PROCEDIMENTOS, 'Triage', triages, (t) => ({ userId: t.nurseId, at: t.classifiedAt }))) {
    const prof = profs.get(g.userId);
    const lot = lotacaoAtendimento(prof, unit.cnes);
    for (const part of chunks(g.items, 99)) {
      const atendimentos: ProcedimentoAtendimentoInput[] = part.map((t) => ({
        cidadao: cidadao(t.encounter.patient),
        localAtendimento: LOCAL_UBS,
        turno: turnoFromDate(t.classifiedAt, timeZone),
        ...janela(new Date(t.classifiedAt.getTime() - 5 * 60_000), t.classifiedAt),
        procedimentos: [],
        medicoes: medicoesFromTriage(t),
        escutaInicial: true,
      }));
      const totais = {
        afericaoPa: part.filter((t) => t.systolic).length,
        glicemiaCapilar: part.filter((t) => t.glucose).length,
        afericaoTemperatura: part.filter((t) => t.temperature !== null).length,
        medicaoPeso: part.filter((t) => t.weightKg !== null).length,
        medicaoAltura: part.filter((t) => t.heightCm !== null).length,
      };
      const uuid = uuidDa(ctx, TIPO_DADO.PROCEDIMENTOS, 'Triage', part[0]!.id);
      out.push({
        kind: TIPO_DADO.PROCEDIMENTOS,
        uuid,
        sourceType: 'Triage',
        sourceId: part[0]!.id,
        patientId: part.length === 1 ? part[0]!.encounter.patientId : null,
        ine: lot.ine ?? null,
        ficha: buildProcedimentos({
          uuid,
          header: { ...lot, dataAtendimento: dayStart(g.day, timeZone), codigoIbge: ctx.codigoIbge },
          atendimentos,
          totais,
        }),
        summary: { profissional: prof?.name ?? g.userId, dia: g.day, atendimentos: part.length, registros: part.map((t) => t.id) },
        itens: part.map((t) => t.id),
      });
    }
  }
  return out;
}

// ─── Vacinação ───────────────────────────────────────────────────────────────

const DOSE_POR_TEXTO: [RegExp, number][] = [
  [/^(1|1ª|primeira)/i, 1],
  [/^(2|2ª|segunda)/i, 2],
  [/^(3|3ª|terceira)/i, 3],
  [/^(4|4ª|quarta)/i, 4],
  [/^(5|5ª|quinta)/i, 5],
  [/refor[cç]o 2|2º refor/i, 7],
  [/refor/i, 6],
  [/[uú]nica/i, 9],
  [/revacina/i, 10],
];
const VIA_POR_TEXTO: [RegExp, number][] = [
  [/oral|vo\b/i, 0],
  [/intrad[eé]rmica|\bid\b/i, 13],
  [/intramuscular|\bim\b/i, 14],
  [/intravenosa|endovenosa|\bev\b|\biv\b/i, 17],
  [/subcut[aâ]nea|\bsc\b/i, 23],
  [/nasal/i, 19],
];
const LOCAL_POR_TEXTO: [RegExp, number][] = [
  [/delt[oó]ide.*esq/i, 3],
  [/delt[oó]ide/i, 2],
  [/vasto.*esq|coxa.*esq/i, 19],
  [/vasto|coxa/i, 18],
  [/gl[uú]teo.*esq/i, 5],
  [/gl[uú]teo/i, 4],
  [/boca|oral/i, 1],
  [/ven/i, 17],
];
const match = (table: [RegExp, number][], text: string | null | undefined) => table.find(([re]) => re.test(text ?? ''))?.[1];

function fabricanteRnds(name: string): string | undefined {
  const key = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const hit = Object.entries(FABRICANTE_RNDS).find(([, label]) => key.includes(label.split(/[ -]/)[0]!) || label.includes(key));
  return hit?.[0];
}

export async function fichasVacinacao(ctx: FonteContexto): Promise<FichaGerada[]> {
  const { db, unit, timeZone } = ctx;
  const rows = await naoExportados(
    ctx,
    TIPO_DADO.VACINACAO,
    'Vaccination',
    await linhas(
      ctx,
      'Vaccination',
      () => db.vaccination.findMany({ where: { unitId: unit.id, appliedAt: { gte: ctx.from, lte: ctx.to } }, include: { patient: true }, orderBy: { appliedAt: 'asc' } }),
      (ids) => db.vaccination.findMany({ where: { unitId: unit.id, id: { in: ids } }, include: { patient: true } }),
      (v) => v.appliedAt,
    ),
  );
  const profs = await profissionais(db, unit.id, [...new Set(rows.map((v) => v.professionalId))]);
  const out: FichaGerada[] = [];
  for (const g of agrupar(ctx, TIPO_DADO.VACINACAO, 'Vaccination', rows, (v) => ({ userId: v.professionalId, at: v.appliedAt }))) {
    const prof = profs.get(g.userId);
    const lot = lotacaoAtendimento(prof, unit.cnes);
    for (const part of chunks(g.items, 99)) {
      const atendimentos: VacinacaoAtendimentoInput[] = part.map((v) => ({
        cidadao: cidadao(v.patient),
        turno: turnoFromDate(v.appliedAt, timeZone),
        localAtendimento: LOCAL_UBS,
        ...janela(new Date(v.appliedAt.getTime() - 5 * 60_000), v.appliedAt),
        vacinas: [
          {
            imunobiologico: Number(v.vaccineCode.replace(/\D/g, '')) || 0,
            estrategia: 1,
            dose: DOSE_VACINA[v.dose] ? Number(v.dose) : (match(DOSE_POR_TEXTO, v.dose) ?? 8),
            lote: v.lot,
            fabricanteRnds: fabricanteRnds(v.manufacturer),
            viaAdministracao: match(VIA_POR_TEXTO, v.route) ?? 14,
            localAplicacao: match(LOCAL_POR_TEXTO, v.site) ?? (match(VIA_POR_TEXTO, v.route) === 0 ? 1 : 2),
          },
        ],
      }));
      const uuid = uuidDa(ctx, TIPO_DADO.VACINACAO, 'Vaccination', part[0]!.id);
      out.push({
        kind: TIPO_DADO.VACINACAO,
        uuid,
        sourceType: 'Vaccination',
        sourceId: part[0]!.id,
        patientId: part.length === 1 ? part[0]!.patientId : null,
        ine: lot.ine ?? null,
        ficha: buildVacinacao({ uuid, header: { ...lot, dataAtendimento: dayStart(g.day, timeZone), codigoIbge: ctx.codigoIbge }, atendimentos }),
        summary: { profissional: prof?.name ?? g.userId, dia: g.day, atendimentos: part.length, registros: part.map((v) => v.id) },
        itens: part.map((v) => v.id),
      });
    }
  }
  return out;
}

// ─── Visita domiciliar e territorial (app do ACS) ───────────────────────────

const dec = (x: unknown) => (x === null || x === undefined ? null : Number(x));

export async function fichasVisitaDomiciliar(ctx: FonteContexto): Promise<FichaGerada[]> {
  const { db, unit, timeZone } = ctx;
  const rows = await naoExportados(
    ctx,
    TIPO_DADO.VISITA_DOMICILIAR,
    'HomeVisit',
    await linhas(
      ctx,
      'HomeVisit',
      () => db.homeVisit.findMany({ where: { unitId: unit.id, visitedAt: { gte: ctx.from, lte: ctx.to } }, include: { patient: true }, orderBy: { visitedAt: 'asc' } }),
      (ids) => db.homeVisit.findMany({ where: { unitId: unit.id, id: { in: ids } }, include: { patient: true } }),
      (v) => v.visitedAt,
    ),
  );
  const profs = await profissionais(db, unit.id, [...new Set(rows.map((v) => v.professionalId))]);
  const out: FichaGerada[] = [];
  // Uma ficha por profissional, CBO e dia: quem tem duas lotações na unidade (ACS e ACE) não mistura as ocupações.
  for (const g of agrupar(ctx, TIPO_DADO.VISITA_DOMICILIAR, 'HomeVisit', rows, (v) => ({ userId: v.professionalId, cbo: v.cbo ?? '', at: v.visitedAt }))) {
    const prof = profs.get(g.userId);
    for (const part of chunks(g.items, 99)) {
      const lot = lotacaoVisita(
        prof,
        'HomeVisit',
        g.cbo,
        unit.cnes,
        part.map((v) => v.teamId),
      );
      const visitas: VisitaDomiciliarInput[] = part.map((v) => ({
        turno: (v.turno as 1 | 2 | 3) ?? turnoFromDate(v.visitedAt, timeZone),
        cidadao: v.patient ? cidadao(v.patient) : null,
        compartilhada: v.shared,
        motivos: v.reasons.map(Number).filter((n) => Number.isFinite(n)),
        desfecho: Number(v.outcome) as 1 | 2 | 3,
        microArea: v.microArea,
        foraDaArea: v.outOfArea,
        tipoImovel: v.propertyType,
        pesoKg: dec(v.weightKg),
        alturaCm: v.heightCm,
        sistolica: v.systolic,
        diastolica: v.diastolic,
        temperatura: dec(v.temperature),
        glicemia: v.glucose,
        tipoGlicemia: v.glucoseType,
        latitude: v.latitude,
        longitude: v.longitude,
      }));
      const uuid = uuidDa(ctx, TIPO_DADO.VISITA_DOMICILIAR, 'HomeVisit', part[0]!.id);
      out.push({
        kind: TIPO_DADO.VISITA_DOMICILIAR,
        uuid,
        sourceType: 'HomeVisit',
        sourceId: part[0]!.id,
        patientId: part.length === 1 ? (part[0]!.patientId ?? null) : null,
        ine: lot.ine ?? null,
        ficha: buildVisitaDomiciliar({ uuid, header: { ...lot, dataAtendimento: dayStart(g.day, timeZone), codigoIbge: ctx.codigoIbge }, visitas }),
        summary: { profissional: prof?.name ?? g.userId, dia: g.day, visitas: part.length, registros: part.map((v) => v.id) },
        itens: part.map((v) => v.id),
      });
    }
  }
  return out;
}

// ─── Visita do agente de combate às endemias (controle vetorial, VIG-3a) ─────

/** Tipos de imóvel que seguem a regra do domicílio no LEDI (domicílio, abrigo, ILPI, prisional, socioeducativa, delegacia, outros). */
const TIPOS_COMO_DOMICILIO = new Set(['01', '07', '08', '09', '10', '11', '99']);

/**
 * Ficha de visita domiciliar e territorial (tipo 8) das visitas do ACE (CBO 515140): motivos do grupo de controle
 * ambiental e vetorial (34 a 37), desfecho pela situação do imóvel (fechado e abandonado = ausente, recusado), tipo do
 * imóvel e posição. No domicílio, o cidadão é o responsável pela família, como pede o LEDI para a visita de controle
 * vetorial; sem família cadastrada, vai sem pessoa. Sem microárea no imóvel, a visita vai como fora de área.
 */
export async function fichasVisitaVetorial(ctx: FonteContexto): Promise<FichaGerada[]> {
  const { db, unit, timeZone } = ctx;
  const rows = await naoExportados(
    ctx,
    TIPO_DADO.VISITA_DOMICILIAR,
    'VectorVisit',
    await linhas(
      ctx,
      'VectorVisit',
      () => db.vectorVisit.findMany({ where: { unitId: unit.id, visitedAt: { gte: ctx.from, lte: ctx.to } }, orderBy: { visitedAt: 'asc' } }),
      (ids) => db.vectorVisit.findMany({ where: { unitId: unit.id, id: { in: ids } } }),
      (v) => v.visitedAt,
    ),
  );
  if (!rows.length) return [];
  const profs = await profissionais(db, unit.id, [...new Set(rows.map((v) => v.userId))]);
  const domicilios = [...new Set(rows.filter((v) => TIPOS_COMO_DOMICILIO.has(v.propertyType) && v.situation === 'TRABALHADO').map((v) => v.householdId))];
  const familias = await emLotes(domicilios, (lote) =>
    db.family.findMany({ where: { householdId: { in: lote }, active: true, responsibleId: { not: null } }, include: { responsible: true }, orderBy: { createdAt: 'asc' } }),
  );
  // Com várias famílias no domicílio, o responsável da mais antiga (os lotes de ids não mudam a ordem dentro do domicílio).
  familias.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const responsavel = new Map<string, NonNullable<(typeof familias)[number]['responsible']>>();
  for (const f of familias) if (f.responsible && !f.responsible.mergedIntoId && !responsavel.has(f.householdId)) responsavel.set(f.householdId, f.responsible);
  const out: FichaGerada[] = [];
  for (const g of agrupar(ctx, TIPO_DADO.VISITA_DOMICILIAR, 'VectorVisit', rows, (v) => ({ userId: v.userId, cbo: v.cbo, at: v.visitedAt }))) {
    const prof = profs.get(g.userId);
    const lot = lotacaoVisita(prof, 'VectorVisit', g.cbo, unit.cnes, []);
    for (const part of chunks(g.items, 99)) {
      const visitas: VisitaDomiciliarInput[] = part.map((v) => {
        const p = TIPOS_COMO_DOMICILIO.has(v.propertyType) && v.situation === 'TRABALHADO' ? responsavel.get(v.householdId) : undefined;
        const microArea = v.microArea && /^\d{2}$/.test(v.microArea) ? v.microArea : null;
        return {
          turno: (v.turno as 1 | 2 | 3) ?? turnoFromDate(v.visitedAt, timeZone),
          cidadao: p ? cidadao(p) : null,
          motivos: motivosEsusVisitaVetorial({ situacao: v.situation, acaoEducativa: v.education, depositos: v.deposits as Depositos | null, ubv: v.ubv as LocalUbv | null }).map(Number),
          desfecho: Number(SITUACAO_INFO[v.situation].desfechoEsus) as 1 | 2 | 3,
          microArea,
          foraDaArea: !microArea,
          tipoImovel: v.propertyType,
          latitude: v.latitude,
          longitude: v.longitude,
        };
      });
      const uuid = uuidDa(ctx, TIPO_DADO.VISITA_DOMICILIAR, 'VectorVisit', part[0]!.id);
      out.push({
        kind: TIPO_DADO.VISITA_DOMICILIAR,
        uuid,
        sourceType: 'VectorVisit',
        sourceId: part[0]!.id,
        patientId: null,
        ine: lot.ine ?? null,
        ficha: buildVisitaDomiciliar({ uuid, header: { ...lot, dataAtendimento: dayStart(g.day, timeZone), codigoIbge: ctx.codigoIbge }, visitas }),
        summary: { profissional: prof?.name ?? g.userId, dia: g.day, visitas: part.length, registros: part.map((v) => v.id) },
        itens: part.map((v) => v.id),
      });
    }
  }
  return out;
}

// ─── Cadastro individual e domiciliar ────────────────────────────────────────

const CID_HIPERTENSAO = /^I1[0-5]/;
const CID_DIABETES = /^E1[0-4]/;
const CID_RESPIRATORIA = /^J4[0-7]/;
const CID_CANCER = /^C/;
const CID_AVC = /^I6[0-9]/;
const CID_INFARTO = /^I2[1-2]/;
const CID_CARDIACA = /^I[0-5]/;
const CID_RINS = /^N1[7-9]/;
const CID_HANSENIASE = /^A30/;
const CID_TUBERCULOSE = /^A1[5-9]/;
const CID_MENTAL = /^F/;

export async function fichasCadastroIndividual(ctx: FonteContexto): Promise<FichaGerada[]> {
  const { db, unit } = ctx;
  const where = { mergedIntoId: null, OR: [{ family: { household: { unitId: unit.id } } }, { encounters: { some: { unitId: unit.id } } }] } satisfies TenantPrisma.PatientWhereInput;
  const include = { family: { include: { responsible: true, household: true } }, conditions: { where: { active: true } } } satisfies TenantPrisma.PatientInclude;
  // O cadastro é atualização (vai de novo quando muda): não entra no registro do que já foi exportado.
  const patients = await linhas(
    ctx,
    'Patient',
    () => db.patient.findMany({ where: { ...where, updatedAt: { gte: ctx.from, lte: ctx.to } }, include, orderBy: { updatedAt: 'asc' } }),
    (ids) => db.patient.findMany({ where: { ...where, id: { in: ids } }, include }),
    (p) => p.updatedAt,
  );
  const out: FichaGerada[] = [];
  for (const p of patients) {
    const previous = ctx.previousUuid('Patient', p.id);
    const uuid = uuidDa(ctx, TIPO_DADO.CADASTRO_INDIVIDUAL, 'Patient', p.id);
    const responsible = p.family?.responsibleId === p.id || p.kinship === '00';
    const resp = p.family?.responsible && !responsible ? p.family.responsible : null;
    const cids = p.conditions.filter((c) => c.system === 'CID10').map((c) => c.code.toUpperCase());
    const has = (re: RegExp) => cids.some((c) => re.test(c));
    out.push({
      kind: TIPO_DADO.CADASTRO_INDIVIDUAL,
      uuid,
      sourceType: 'Patient',
      sourceId: p.id,
      patientId: p.id,
      ine: p.family?.household?.teamId ? ((await db.team.findUnique({ where: { id: p.family.household.teamId }, select: { ine: true } }))?.ine ?? null) : null,
      ficha: buildCadastroIndividual({
        uuid,
        header: { ...ctx.cadastroLotacao, dataAtendimento: p.updatedAt, codigoIbge: ctx.codigoIbge },
        atualizada: !!previous,
        uuidOriginadora: previous,
        cidadao: {
          ...cidadao(p),
          racaCor: p.racaCor,
          etnia: p.etnia,
          nationality: p.nationality,
          motherName: p.motherName,
          fatherName: p.fatherName,
          phone: p.phone,
          email: p.email,
          nis: p.nis,
          birthIbgeCode: p.birthIbgeCode,
          education: p.education,
          workSituation: p.workSituation,
          occupationCbo: p.occupationCbo,
          kinship: responsible ? '00' : p.kinship,
          responsibleCns: resp?.cns ?? null,
          responsibleCpf: resp?.cns ? null : (resp?.cpf ?? null),
          homeless: p.homeless,
          microArea: p.family?.household?.microArea ?? null,
          deceasedAt: p.deceasedAt,
        },
        condicoes: cids.length
          ? {
              hipertensao: has(CID_HIPERTENSAO),
              diabetes: has(CID_DIABETES),
              doencaRespiratoria: has(CID_RESPIRATORIA),
              cancer: has(CID_CANCER),
              avc: has(CID_AVC),
              infarto: has(CID_INFARTO),
              doencaCardiaca: has(CID_CARDIACA),
              doencaRins: has(CID_RINS),
              hanseniase: has(CID_HANSENIASE),
              tuberculose: has(CID_TUBERCULOSE),
              saudeMental: has(CID_MENTAL),
            }
          : undefined,
      }),
      summary: { cidadao: p.socialName ?? p.name, atualizacao: !!previous, dia: localDate(p.updatedAt, ctx.timeZone) },
      itens: [],
    });
  }
  return out;
}

/** Posição que é do imóvel (e não do endereço aproximado): a mesma regra dos geo campos da ficha do Sinan. */
const posicaoDoImovel = (h: { geoPrecision: string | null }) => !!h.geoPrecision && PRECISAO_LIGA_QUARTEIRAO.includes(h.geoPrecision as PrecisaoGeo);

export async function fichasCadastroDomiciliar(ctx: FonteContexto): Promise<FichaGerada[]> {
  const { db, unit } = ctx;
  const where = { active: true, unitId: unit.id } satisfies TenantPrisma.HouseholdWhereInput;
  const include = { team: true, families: { where: { active: true }, include: { responsible: true, members: { where: { mergedIntoId: null }, select: { id: true } } } } } satisfies TenantPrisma.HouseholdInclude;
  const households = await linhas(
    ctx,
    'Household',
    () => db.household.findMany({ where: { ...where, updatedAt: { gte: ctx.from, lte: ctx.to } }, include, orderBy: { updatedAt: 'asc' } }),
    (ids) => db.household.findMany({ where: { ...where, id: { in: ids } }, include }),
    (h) => h.updatedAt,
  );
  const out: FichaGerada[] = [];
  for (const h of households) {
    const previous = ctx.previousUuid('Household', h.id);
    const uuid = uuidDa(ctx, TIPO_DADO.CADASTRO_DOMICILIAR, 'Household', h.id);
    out.push({
      kind: TIPO_DADO.CADASTRO_DOMICILIAR,
      uuid,
      sourceType: 'Household',
      sourceId: h.id,
      patientId: null,
      ine: h.team?.ine ?? null,
      ficha: buildCadastroDomiciliar({
        uuid,
        header: { ...ctx.cadastroLotacao, dataAtendimento: h.updatedAt, codigoIbge: ctx.codigoIbge },
        atualizada: !!previous,
        uuidOriginadora: previous,
        endereco: { street: h.street, number: h.number, complement: h.complement, district: h.district, cep: h.cep, ibgeCode: h.ibgeCode ?? unit.ibgeCode, uf: h.uf, microArea: h.microArea },
        moradia: {
          propertyType: h.propertyType,
          dwellingType: h.dwellingType,
          tenure: h.tenure,
          wallMaterial: h.wallMaterial,
          waterSupply: h.waterSupply,
          waterTreatment: h.waterTreatment,
          sewage: h.sewage,
          garbage: h.garbage,
          electricity: h.electricity,
          rooms: h.rooms,
          residents: h.families.reduce((s, f) => s + f.members.length, 0) || null,
        },
        familias: h.families.map((f) => ({
          responsavel: { cns: f.responsible?.cns ?? null, cpf: f.responsible?.cns ? null : (f.responsible?.cpf ?? null), birthDate: f.responsible?.birthDate ?? null },
          membros: f.members.length,
          numeroProntuario: f.recordNumber,
          renda: f.incomeBracket,
          resideDesde: f.createdAt,
        })),
        // Ao SISAB só vai a posição do imóvel (GPS, mapa, endereço ou face de quadra da base do IBGE): o centro de rua
        // ou de bairro da geocodificação não é a localização do domicílio.
        latitude: posicaoDoImovel(h) ? h.latitude : null,
        longitude: posicaoDoImovel(h) ? h.longitude : null,
      }),
      summary: { domicilio: [h.street, h.number, h.district].filter(Boolean).join(', '), familias: h.families.length, atualizacao: !!previous, dia: localDate(h.updatedAt, ctx.timeZone) },
      itens: [],
    });
  }
  return out;
}

/** CBO do gerador do lote aceita no cadastro individual/domiciliar? */
export function cboAceitaCadastro(cbo: string): boolean {
  return CBO_POR_MODELO.CADASTRO_INDIVIDUAL.includes(cbo) && CBO_POR_MODELO.CADASTRO_DOMICILIAR.includes(cbo);
}
