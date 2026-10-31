import type { TenantClient } from '@omnisaude/database';
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

async function lotacoes(db: Db, unitId: string, userIds: string[]): Promise<Map<string, Lotacao & { name: string }>> {
  const users = await db.user.findMany({ where: { id: { in: userIds } }, include: { assignments: { where: { unitId, active: true } }, teamMembers: { where: { active: true }, include: { team: true } } } });
  const out = new Map<string, Lotacao & { name: string }>();
  for (const u of users) {
    const team = u.teamMembers.find((m) => m.team.unitId === unitId && m.team.active)?.team;
    const assignment = u.assignments[0];
    out.set(u.id, { cns: u.cns ?? '', cbo: assignment?.cbo ?? '', cnes: '', ine: team?.ine ?? null, name: u.name });
  }
  return out;
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

/** Agrupa itens por profissional e dia local: uma ficha por grupo (até 99 atendimentos). */
function groupByProfessionalDay<T>(items: T[], key: (i: T) => { userId: string; at: Date }, timeZone: string): Map<string, { userId: string; day: string; items: T[] }> {
  const groups = new Map<string, { userId: string; day: string; items: T[] }>();
  for (const item of items) {
    const k = key(item);
    const day = localDate(k.at, timeZone);
    const id = `${k.userId}|${day}`;
    const g = groups.get(id) ?? { userId: k.userId, day, items: [] };
    g.items.push(item);
    groups.set(id, g);
  }
  return groups;
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
  const notes = await db.clinicalNote.findMany({
    where: { status: 'ASSINADO', kind: { in: ['SOAP', 'EVOLUCAO', 'ODONTOGRAMA'] }, signedAt: { gte: ctx.from, lte: ctx.to }, encounter: { unitId: unit.id, status: 'ENCERRADO' } },
    include: { encounter: { include: { patient: true, triages: { orderBy: { classifiedAt: 'desc' }, take: 1 }, examRequests: true } } },
    orderBy: { signedAt: 'asc' },
  });
  const lots = await lotacoes(db, unit.id, [...new Set(notes.map((n) => n.authorId))]);
  const out: FichaGerada[] = [];
  const clinical = notes.filter((n) => n.kind !== 'ODONTOGRAMA');
  const odonto = notes.filter((n) => n.kind === 'ODONTOGRAMA');

  for (const g of groupByProfessionalDay(clinical, (n) => ({ userId: n.authorId, at: n.signedAt! }), timeZone).values()) {
    const lot = lots.get(g.userId);
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
      const uuid = lediUuid(unit.cnes);
      const first = part[0]!;
      out.push({
        kind: TIPO_DADO.ATENDIMENTO_INDIVIDUAL,
        uuid,
        sourceType: 'ClinicalNote',
        sourceId: first.id,
        patientId: part.length === 1 ? first.encounter.patientId : null,
        ine: lot?.ine ?? null,
        ficha: buildAtendimentoIndividual({
          uuid,
          header: { principal: { cns: lot?.cns ?? '', cbo: lot?.cbo ?? '', cnes: unit.cnes, ine: lot?.ine }, dataAtendimento: dayStart(g.day, timeZone), codigoIbge: ctx.codigoIbge },
          atendimentos,
        }),
        summary: { profissional: lot?.name ?? g.userId, dia: g.day, atendimentos: part.length, registros: part.map((n) => n.id) },
      });
    }
  }

  for (const g of groupByProfessionalDay(odonto, (n) => ({ userId: n.authorId, at: n.signedAt! }), timeZone).values()) {
    const lot = lots.get(g.userId);
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
      const uuid = lediUuid(unit.cnes);
      const first = part[0]!;
      out.push({
        kind: TIPO_DADO.ATENDIMENTO_ODONTOLOGICO,
        uuid,
        sourceType: 'ClinicalNote',
        sourceId: first.id,
        patientId: part.length === 1 ? first.encounter.patientId : null,
        ine: lot?.ine ?? null,
        ficha: buildAtendimentoOdontologico({
          uuid,
          header: { principal: { cns: lot?.cns ?? '', cbo: lot?.cbo ?? '', cnes: unit.cnes, ine: lot?.ine }, dataAtendimento: dayStart(g.day, timeZone), codigoIbge: ctx.codigoIbge },
          atendimentos,
        }),
        summary: { profissional: lot?.name ?? g.userId, dia: g.day, atendimentos: part.length, registros: part.map((n) => n.id) },
      });
    }
  }
  return out;
}

// ─── Procedimentos (aferições da classificação de risco / acolhimento) ───────

export async function fichasProcedimentos(ctx: FonteContexto): Promise<FichaGerada[]> {
  const { db, unit, timeZone } = ctx;
  const triages = await db.triage.findMany({
    where: { classifiedAt: { gte: ctx.from, lte: ctx.to }, encounter: { unitId: unit.id } },
    include: { encounter: { include: { patient: true } } },
    orderBy: { classifiedAt: 'asc' },
  });
  const lots = await lotacoes(db, unit.id, [...new Set(triages.map((t) => t.nurseId))]);
  const out: FichaGerada[] = [];
  for (const g of groupByProfessionalDay(triages, (t) => ({ userId: t.nurseId, at: t.classifiedAt }), timeZone).values()) {
    const lot = lots.get(g.userId);
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
      const uuid = lediUuid(unit.cnes);
      out.push({
        kind: TIPO_DADO.PROCEDIMENTOS,
        uuid,
        sourceType: 'Triage',
        sourceId: part[0]!.id,
        patientId: part.length === 1 ? part[0]!.encounter.patientId : null,
        ine: lot?.ine ?? null,
        ficha: buildProcedimentos({
          uuid,
          header: { cns: lot?.cns ?? '', cbo: lot?.cbo ?? '', cnes: unit.cnes, ine: lot?.ine, dataAtendimento: dayStart(g.day, timeZone), codigoIbge: ctx.codigoIbge },
          atendimentos,
          totais,
        }),
        summary: { profissional: lot?.name ?? g.userId, dia: g.day, atendimentos: part.length, registros: part.map((t) => t.id) },
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
  const rows = await db.vaccination.findMany({ where: { unitId: unit.id, appliedAt: { gte: ctx.from, lte: ctx.to } }, include: { patient: true }, orderBy: { appliedAt: 'asc' } });
  const lots = await lotacoes(db, unit.id, [...new Set(rows.map((v) => v.professionalId))]);
  const out: FichaGerada[] = [];
  for (const g of groupByProfessionalDay(rows, (v) => ({ userId: v.professionalId, at: v.appliedAt }), timeZone).values()) {
    const lot = lots.get(g.userId);
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
      const uuid = lediUuid(unit.cnes);
      out.push({
        kind: TIPO_DADO.VACINACAO,
        uuid,
        sourceType: 'Vaccination',
        sourceId: part[0]!.id,
        patientId: part.length === 1 ? part[0]!.patientId : null,
        ine: lot?.ine ?? null,
        ficha: buildVacinacao({ uuid, header: { cns: lot?.cns ?? '', cbo: lot?.cbo ?? '', cnes: unit.cnes, ine: lot?.ine, dataAtendimento: dayStart(g.day, timeZone), codigoIbge: ctx.codigoIbge }, atendimentos }),
        summary: { profissional: lot?.name ?? g.userId, dia: g.day, atendimentos: part.length, registros: part.map((v) => v.id) },
      });
    }
  }
  return out;
}

// ─── Visita domiciliar e territorial (app do ACS) ───────────────────────────

const dec = (x: unknown) => (x === null || x === undefined ? null : Number(x));

export async function fichasVisitaDomiciliar(ctx: FonteContexto): Promise<FichaGerada[]> {
  const { db, unit, timeZone } = ctx;
  const rows = await db.homeVisit.findMany({ where: { unitId: unit.id, visitedAt: { gte: ctx.from, lte: ctx.to } }, include: { patient: true }, orderBy: { visitedAt: 'asc' } });
  const lots = await lotacoes(db, unit.id, [...new Set(rows.map((v) => v.professionalId))]);
  const out: FichaGerada[] = [];
  for (const g of groupByProfessionalDay(rows, (v) => ({ userId: v.professionalId, at: v.visitedAt }), timeZone).values()) {
    const lot = lots.get(g.userId);
    for (const part of chunks(g.items, 99)) {
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
      const uuid = lediUuid(unit.cnes);
      out.push({
        kind: TIPO_DADO.VISITA_DOMICILIAR,
        uuid,
        sourceType: 'HomeVisit',
        sourceId: part[0]!.id,
        patientId: part.length === 1 ? (part[0]!.patientId ?? null) : null,
        ine: lot?.ine ?? null,
        ficha: buildVisitaDomiciliar({ uuid, header: { cns: lot?.cns ?? '', cbo: lot?.cbo ?? '', cnes: unit.cnes, ine: lot?.ine, dataAtendimento: dayStart(g.day, timeZone), codigoIbge: ctx.codigoIbge }, visitas }),
        summary: { profissional: lot?.name ?? g.userId, dia: g.day, visitas: part.length, registros: part.map((v) => v.id) },
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
  const patients = await db.patient.findMany({
    where: {
      mergedIntoId: null,
      updatedAt: { gte: ctx.from, lte: ctx.to },
      OR: [{ family: { household: { unitId: unit.id } } }, { encounters: { some: { unitId: unit.id } } }],
    },
    include: { family: { include: { responsible: true, household: true } }, conditions: { where: { active: true } } },
    orderBy: { updatedAt: 'asc' },
  });
  const out: FichaGerada[] = [];
  for (const p of patients) {
    const previous = ctx.previousUuid('Patient', p.id);
    const uuid = lediUuid(unit.cnes);
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
    });
  }
  return out;
}

export async function fichasCadastroDomiciliar(ctx: FonteContexto): Promise<FichaGerada[]> {
  const { db, unit } = ctx;
  const households = await db.household.findMany({
    where: { active: true, unitId: unit.id, updatedAt: { gte: ctx.from, lte: ctx.to } },
    include: { team: true, families: { where: { active: true }, include: { responsible: true, members: { where: { mergedIntoId: null }, select: { id: true } } } } },
    orderBy: { updatedAt: 'asc' },
  });
  const out: FichaGerada[] = [];
  for (const h of households) {
    const previous = ctx.previousUuid('Household', h.id);
    const uuid = lediUuid(unit.cnes);
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
        latitude: h.latitude,
        longitude: h.longitude,
      }),
      summary: { domicilio: [h.street, h.number, h.district].filter(Boolean).join(', '), familias: h.families.length, atualizacao: !!previous, dia: localDate(h.updatedAt, ctx.timeZone) },
    });
  }
  return out;
}

/** CBO do gerador do lote aceita no cadastro individual/domiciliar? */
export function cboAceitaCadastro(cbo: string): boolean {
  return CBO_POR_MODELO.CADASTRO_INDIVIDUAL.includes(cbo) && CBO_POR_MODELO.CADASTRO_DOMICILIAR.includes(cbo);
}
