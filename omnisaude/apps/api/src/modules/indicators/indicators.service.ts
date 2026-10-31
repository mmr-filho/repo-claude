import { Injectable } from '@nestjs/common';
import type { TenantClient, TenantPrisma } from '@omnisaude/database';
import {
  blocoDaEquipe,
  classificacaoNotaFinal,
  componentesDaVacina,
  CONCEITO_LABEL,
  CONCEITO_PONTOS,
  conceitoDoIndicador,
  fromZonedParts,
  INDICADORES_APS,
  indicadoresDoBloco,
  localDateString,
  mediaQuadrimestre,
  MESES_POR_QUADRIMESTRE,
  MODALIDADE_LABEL,
  modalidadePadrao,
  quadrimestreDe,
  teamTypeLabel,
  VALOR_QUALIDADE,
  type BlocoIndicador,
  type CodigoIndicador,
  type Conceito,
  type ModalidadeEquipe,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { apurarMes, pendencias, type Consulta, type DadosEquipe, type Mes, type Pendencia, type ResultadoMes } from './indicators-calc';

const TIPOS_AVALIADOS = ['70', '76', '71', '72'];
const ORDEM_CONCEITO: Conceito[] = ['REGULAR', 'SUFICIENTE', 'BOM', 'OTIMO'];

export interface AvaliacaoIndicador {
  codigo: CodigoIndicador;
  titulo: string;
  peso: number;
  unidade: '%' | 'média';
  fonteApp: { situacao: string; descricao: string };
  meses: ResultadoMes[];
  resultado: number | null;
  conceito: Conceito | null;
  nota: number;
}

export interface AvaliacaoEquipe {
  team: { id: string; ine: string; name: string; typeCode: string; typeLabel: string; unitId: string; unitName: string; modality: ModalidadeEquipe | null; modalityLabel: string | null };
  bloco: BlocoIndicador;
  pessoasVinculadas: number;
  membros: number;
  indicadores: AvaliacaoIndicador[];
  /** Indicadores sem resultado no quadrimestre (sem população ou sem fonte). */
  semResultado: CodigoIndicador[];
  notaFinal: number;
  /** Nota reescalada para 10 quando há indicadores sem resultado. */
  notaEstimada: number;
  classificacao: Conceito;
  valorMensal: number | null;
  repasseQuadrimestre: number | null;
  proximoNivel: { classificacao: Conceito; valorMensal: number; diferencaMensal: number } | null;
}

/** Painel dos indicadores do componente de qualidade da APS por equipe e competência. */
@Injectable()
export class IndicatorsService {
  constructor(private readonly audit: AuditService) {}

  fichas() {
    return {
      indicadores: INDICADORES_APS,
      pontuacaoConceito: CONCEITO_PONTOS,
      conceitos: CONCEITO_LABEL,
      classificacaoNotaFinal: [
        { classificacao: 'OTIMO', regra: 'nota final > 7,5' },
        { classificacao: 'BOM', regra: 'nota final ≥ 5 e ≤ 7,5' },
        { classificacao: 'SUFICIENTE', regra: 'nota final > 2,5 e < 5' },
        { classificacao: 'REGULAR', regra: 'nota final ≤ 2,5' },
      ],
      valores: VALOR_QUALIDADE,
      modalidades: MODALIDADE_LABEL,
      referencias: [
        { titulo: 'Portaria GM/MS nº 3.493, de 10 de abril de 2024', url: 'https://bvsms.saude.gov.br/bvs/saudelegis/gm/2024/prt3493_11_04_2024.html' },
        { titulo: 'Portaria GM/MS nº 6.907, de 29 de abril de 2025', url: 'https://bvsms.saude.gov.br/bvs/saudelegis/gm/2025/prt6907_08_05_2025.html' },
        { titulo: 'Portaria GM/MS nº 7.799, de 20 de agosto de 2025 (valores do componente de qualidade)', url: 'https://bvsms.saude.gov.br/bvs/saudelegis/gm/2025/prt7799_21_08_2025.html' },
        {
          titulo: 'Nota Técnica nº 8/2026-DEAPS/SAPS/MS (metodologia do desempenho quadrimestral)',
          url: 'https://www.gov.br/saude/pt-br/composicao/saps/publicacoes/fichas-tecnicas/equipe-de-atencao-primaria-e-saude-da-familia/nota-tecnica-no-8-2026-deaps-saps-ms',
        },
        { titulo: 'Notas metodológicas dos indicadores (fichas técnicas da SAPS)', url: 'https://www.gov.br/saude/pt-br/composicao/saps/publicacoes/fichas-tecnicas' },
      ],
    };
  }

  async painel(ctx: RequestContext, q: { competencia?: string; unitId?: string }) {
    const now = new Date();
    const tz = ctx.tenant.timeZone;
    const competencia = q.competencia ?? localDateString(now, tz).slice(0, 7);
    const quadrimestre = quadrimestreDe(competencia);
    const meses = mesesDoQuadrimestre(competencia, tz, now);
    if (!meses.length) throw new DomainError('COMPETENCIA_FUTURA', 'A competência ainda não começou', 400);
    const teams = await ctx.db.team.findMany({
      where: { active: true, typeCode: { in: TIPOS_AVALIADOS }, ...(q.unitId ? { unitId: q.unitId } : {}) },
      include: { unit: { select: { name: true } }, members: { where: { active: true, userId: { not: null } }, select: { userId: true } } },
      orderBy: [{ unit: { name: 'asc' } }, { typeCode: 'asc' }, { name: 'asc' }],
    });
    const equipes: AvaliacaoEquipe[] = [];
    for (const team of teams) {
      const bloco = blocoDaEquipe(team.typeCode);
      if (!bloco) continue;
      const membros = new Set(team.members.map((m) => m.userId as string));
      const dados = await carregarDadosEquipe(ctx.db, { id: team.id, typeCode: team.typeCode, name: team.name, unitId: team.unitId }, membros, meses[meses.length - 1]!.asOf);
      const indicadores: AvaliacaoIndicador[] = indicadoresDoBloco(bloco).map((ind) => {
        const porMes = meses.map((m) => apurarMes(ind.codigo, dados, m));
        const resultado = mediaQuadrimestre(porMes.map((m) => m.valor));
        const conceito = conceitoDoIndicador(ind.codigo, resultado);
        return {
          codigo: ind.codigo,
          titulo: ind.titulo,
          peso: ind.peso,
          unidade: ind.unidade,
          fonteApp: ind.fonteApp,
          meses: porMes,
          resultado,
          conceito,
          nota: conceito ? Math.round(CONCEITO_PONTOS[conceito] * ind.peso * 100) / 100 : 0,
        };
      });
      const semResultado = indicadores.filter((i) => i.conceito === null).map((i) => i.codigo);
      const pesoAvaliado = indicadores.filter((i) => i.conceito !== null).reduce((s, i) => s + i.peso, 0);
      const nota = Math.round(indicadores.reduce((s, i) => s + i.nota, 0) * 100) / 100;
      const notaEstimada = pesoAvaliado ? Math.round(((nota * 10) / pesoAvaliado) * 100) / 100 : 0;
      const classificacao = classificacaoNotaFinal(notaEstimada);
      const modality = (team.modality as ModalidadeEquipe | null) ?? modalidadePadrao(team.typeCode);
      const valores = modality ? VALOR_QUALIDADE[modality] : null;
      const valorMensal = valores ? valores[classificacao] : null;
      const proximo = ORDEM_CONCEITO[ORDEM_CONCEITO.indexOf(classificacao) + 1];
      equipes.push({
        team: {
          id: team.id,
          ine: team.ine,
          name: team.name,
          typeCode: team.typeCode,
          typeLabel: teamTypeLabel(team.typeCode),
          unitId: team.unitId,
          unitName: team.unit.name,
          modality,
          modalityLabel: modality ? MODALIDADE_LABEL[modality] : null,
        },
        bloco,
        pessoasVinculadas: dados.pessoas.length,
        membros: membros.size,
        indicadores,
        semResultado,
        notaFinal: nota,
        notaEstimada,
        classificacao,
        valorMensal,
        repasseQuadrimestre: valorMensal !== null ? valorMensal * MESES_POR_QUADRIMESTRE : null,
        proximoNivel: proximo && valores ? { classificacao: proximo, valorMensal: valores[proximo], diferencaMensal: valores[proximo] - (valorMensal ?? 0) } : null,
      });
    }
    const porClassificacao: Record<Conceito, number> = { OTIMO: 0, BOM: 0, SUFICIENTE: 0, REGULAR: 0 };
    for (const e of equipes) porClassificacao[e.classificacao]++;
    const soma = (f: (e: AvaliacaoEquipe) => number | null) => Math.round(equipes.reduce((s, e) => s + (f(e) ?? 0), 0) * 100) / 100;
    return {
      competencia,
      quadrimestre: {
        numero: quadrimestre.numero,
        ano: quadrimestre.ano,
        rotulo: quadrimestre.rotulo,
        meses: meses.map((m) => ({ competencia: m.competencia, ate: m.asOf.toISOString(), parcial: m.asOf.getTime() < m.fim.getTime() - 1 })),
      },
      geradoEm: now.toISOString(),
      equipes,
      totais: {
        equipes: equipes.length,
        porClassificacao,
        valorMensal: soma((e) => e.valorMensal),
        repasseQuadrimestre: soma((e) => e.repasseQuadrimestre),
        valorMensalSeProximoNivel: soma((e) => (e.proximoNivel ? e.proximoNivel.valorMensal : e.valorMensal)),
      },
    };
  }

  /** Lista nominal de quem está em acompanhamento e o que falta para pontuar (acesso registrado na auditoria). */
  async pendencias(ctx: RequestContext, q: { teamId: string; codigo: CodigoIndicador; competencia?: string }) {
    const now = new Date();
    const tz = ctx.tenant.timeZone;
    const competencia = q.competencia ?? localDateString(now, tz).slice(0, 7);
    const meses = mesesDoQuadrimestre(competencia, tz, now);
    const mes = meses.find((m) => m.competencia === competencia) ?? meses[meses.length - 1];
    if (!mes) throw new DomainError('COMPETENCIA_FUTURA', 'A competência ainda não começou', 400);
    const team = await ctx.db.team.findUnique({ where: { id: q.teamId }, include: { unit: { select: { name: true } }, members: { where: { active: true, userId: { not: null } }, select: { userId: true } } } });
    if (!team) throw notFound('Equipe');
    const membros = new Set(team.members.map((m) => m.userId as string));
    const dados = await carregarDadosEquipe(ctx.db, { id: team.id, typeCode: team.typeCode, name: team.name, unitId: team.unitId }, membros, mes.asOf);
    const lista: Pendencia[] = pendencias(q.codigo, dados, mes.asOf, mes.asOfLocal);
    await this.audit.record(ctx, ctx.db, { action: 'indicadores.lista_nominal', entityType: 'Team', entityId: team.id, payload: { codigo: q.codigo, competencia, pessoas: lista.length } });
    const resultadoMes = apurarMes(q.codigo, dados, mes);
    return { competencia, ate: mes.asOf.toISOString(), team: { id: team.id, name: team.name, ine: team.ine, unitName: team.unit.name }, codigo: q.codigo, mes: resultadoMes, pessoas: lista };
  }
}

/** Meses do quadrimestre já iniciados, até a competência pedida, com corte no fim do mês (ou agora). */
export function mesesDoQuadrimestre(competencia: string, tz: string, now: Date): Mes[] {
  return quadrimestreDe(competencia)
    .meses.filter((m) => m <= competencia)
    .map((m) => {
      const [y, mo] = m.split('-').map(Number) as [number, number];
      const inicio = fromZonedParts({ year: y, month: mo, day: 1, hour: 0, minute: 0, second: 0 }, tz);
      const fim = fromZonedParts({ year: mo === 12 ? y + 1 : y, month: mo === 12 ? 1 : mo + 1, day: 1, hour: 0, minute: 0, second: 0 }, tz);
      const asOf = fim.getTime() <= now.getTime() ? new Date(fim.getTime() - 1) : now;
      return { competencia: m, inicio, fim, asOf, asOfLocal: localDateString(asOf, tz) };
    })
    .filter((m) => m.inicio.getTime() <= now.getTime());
}

const MES_MS = 30.4375 * 86_400_000;

/** Carrega os registros de uma equipe: pessoas vinculadas (domicílio da equipe) e produção dos membros. */
export function carregarDadosEquipe(db: TenantClient, team: { id: string; typeCode: string; name: string; unitId: string }, membros: Set<string>, asOf: Date): Promise<DadosEquipe> {
  return carregarDados(db, team, membros, asOf, { mergedIntoId: null, deceasedAt: null, family: { household: { teamId: team.id, active: true } } });
}

/** Carrega os registros de uma unidade: pessoas de domicílios da unidade ou das suas equipes (programas da APS). */
export function carregarDadosUnidade(db: TenantClient, unit: { id: string; name: string }, asOf: Date): Promise<DadosEquipe> {
  return carregarDados(db, { id: unit.id, typeCode: '00', name: unit.name, unitId: unit.id }, new Set(), asOf, {
    mergedIntoId: null,
    deceasedAt: null,
    family: { household: { active: true, OR: [{ unitId: unit.id }, { team: { unitId: unit.id, active: true } }] } },
  });
}

type Vinculo = TenantPrisma.PatientWhereInput;

async function carregarDados(db: TenantClient, team: { id: string; typeCode: string; name: string; unitId: string }, membros: Set<string>, asOf: Date, vinculo: Vinculo): Promise<DadosEquipe> {
  const desde = new Date(asOf.getTime() - 61 * MES_MS);
  const membroIds = [...membros];
  const pessoas = await db.patient.findMany({ where: vinculo, select: { id: true, name: true, socialName: true, birthDate: true, sex: true, createdAt: true, bolsaFamilia: true }, orderBy: { name: 'asc' } });
  const ids = pessoas.map((p) => p.id);
  const [notes, triages, exams, vaccinations, conditions, visitas] = await Promise.all([
    db.clinicalNote.findMany({
      where: {
        status: 'ASSINADO',
        kind: { in: ['SOAP', 'EVOLUCAO', 'ODONTOGRAMA'] },
        createdAt: { gte: desde },
        OR: [{ encounter: { patient: vinculo } }, ...(membroIds.length ? [{ authorId: { in: membroIds } }, { encounter: { notes: { some: { status: 'ASSINADO' as const, authorId: { in: membroIds } } } } }] : [])],
      },
      select: { encounterId: true, authorId: true, cbo: true, kind: true, codes: true, signedAt: true, createdAt: true, data: true, encounter: { select: { patientId: true, appointmentId: true } } },
    }),
    db.triage.findMany({
      where: { classifiedAt: { gte: desde }, encounter: { patient: vinculo } },
      select: { classifiedAt: true, systolic: true, diastolic: true, weightKg: true, heightCm: true, encounter: { select: { patientId: true } } },
    }),
    db.examRequest.findMany({
      where: { patient: vinculo, OR: [{ requestedAt: { gte: desde } }, { resultAt: { gte: desde } }] },
      select: { patientId: true, sigtapCode: true, analyte: true, requestedAt: true, resultAt: true },
    }),
    db.vaccination.findMany({ where: { patient: vinculo }, select: { patientId: true, vaccineCode: true, vaccineName: true, appliedAt: true } }),
    db.patientCondition.findMany({ where: { patient: vinculo }, select: { patientId: true, system: true, code: true, lineOfCare: true, onsetAt: true, recordedAt: true, active: true, resolvedAt: true } }),
    // Visitas domiciliares realizadas por ACS/TACS (CBO 5151) registradas no app do ACS.
    db.homeVisit.findMany({ where: { outcome: '1', cbo: { startsWith: '5151' }, visitedAt: { gte: desde }, patient: vinculo }, select: { patientId: true, visitedAt: true } }),
  ]);
  const producao: DadosEquipe['procedimentos'] = [];
  const lotes = [...chunk(ids, 5000).map((c) => ({ patientId: { in: c } })), ...(membroIds.length ? [{ professionalId: { in: membroIds } }] : [])];
  for (const where of lotes) {
    const rows = await db.productionRecord.findMany({
      where: { performedAt: { gte: desde }, ...where },
      select: { patientId: true, professionalId: true, cbo: true, procedureCode: true, quantity: true, performedAt: true },
    });
    for (const r of rows) producao.push({ patientId: r.patientId, professionalId: r.professionalId, cbo: r.cbo, code: r.procedureCode, quantity: r.quantity, at: r.performedAt });
  }
  const referencia = { total: 0, criancas6a12: 0 };
  if (team.typeCode === '71') {
    const ref = await db.patient.findMany({
      where: { mergedIntoId: null, deceasedAt: null, family: { household: { active: true, team: { unitId: team.unitId, typeCode: { in: ['70', '76'] }, active: true } } } },
      select: { birthDate: true },
    });
    referencia.total = ref.length;
    referencia.criancas6a12 = ref.filter((p) => {
      const anos = (asOf.getTime() - p.birthDate.getTime()) / (365.25 * 86_400_000);
      return anos >= 6 && anos < 13;
    }).length;
  }
  const coautores = new Map<string, Set<string>>();
  const consultas: Consulta[] = [];
  for (const n of notes) {
    const autores = coautores.get(n.encounterId) ?? new Set<string>();
    autores.add(n.authorId);
    coautores.set(n.encounterId, autores);
    const data = (n.data ?? {}) as { conduta?: string };
    consultas.push({
      patientId: n.encounter.patientId,
      encounterId: n.encounterId,
      authorId: n.authorId,
      cbo: n.cbo,
      at: n.signedAt ?? n.createdAt,
      codes: n.codes,
      kind: n.kind,
      programada: n.encounter.appointmentId !== null,
      conduta: typeof data.conduta === 'string' ? data.conduta : null,
    });
  }
  return {
    team: { id: team.id, typeCode: team.typeCode, name: team.name },
    membros,
    pessoas: pessoas.map((p) => ({ id: p.id, name: p.socialName ?? p.name, birthDate: p.birthDate, sex: p.sex, cadastradoEm: p.createdAt, bolsaFamilia: p.bolsaFamilia })),
    consultas,
    medicoes: triages.map((t) => ({
      patientId: t.encounter.patientId,
      at: t.classifiedAt,
      pa: t.systolic !== null && t.diastolic !== null,
      pesoAltura: t.weightKg !== null && t.heightCm !== null,
      peso: t.weightKg === null ? null : Number(t.weightKg),
      altura: t.heightCm,
    })),
    exames: exams.map((e) => ({ patientId: e.patientId, code: e.sigtapCode, analyte: e.analyte, requestedAt: e.requestedAt, resultAt: e.resultAt })),
    vacinas: vaccinations.map((v) => ({ patientId: v.patientId, componentes: componentesDaVacina(v.vaccineCode, v.vaccineName), at: v.appliedAt })),
    procedimentos: producao,
    condicoes: conditions.map((c) => ({ patientId: c.patientId, system: c.system, code: c.code, lineOfCare: c.lineOfCare, onsetAt: c.onsetAt, recordedAt: c.recordedAt, active: c.active, resolvedAt: c.resolvedAt })),
    visitas: visitas.filter((v) => v.patientId !== null).map((v) => ({ patientId: v.patientId as string, at: v.visitedAt })),
    coautores,
    referencia,
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
