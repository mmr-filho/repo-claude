import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ageInYears,
  DESFECHO_VISITA,
  MOTIVO_VISITA_LABEL,
  ordenarOperacoes,
  resumirVisitas,
  TIPO_IMOVEL,
  turnoDaHora,
  zonedParts,
  type DomicilioCampo,
  type OperacaoCampo,
  type PessoaCampo,
  type ResultadoSync,
  type VisitaCampo,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { HouseholdsService } from '../patients/households.service';
import type { PatientInput } from '../patients/patients.schemas';
import { PatientsService, patientSummary } from '../patients/patients.service';

const DIA = 86_400_000;

export interface EscopoTerritorio {
  unitId?: string;
  teamId?: string;
  microArea?: string;
}

export interface FiltroVisitas extends EscopoTerritorio {
  from?: string;
  to?: string;
  patientId?: string;
  householdId?: string;
  professionalId?: string;
}

interface Lotacao {
  teamId: string;
  teamName: string;
  ine: string;
  microArea: string | null;
}

type Prioridade = 'GESTANTE' | 'CRIANCA' | 'IDOSO' | 'HIPERTENSAO' | 'DIABETES' | 'TB_HANSENIASE' | 'BOLSA_FAMILIA';

const pessoaSelect = {
  id: true,
  name: true,
  socialName: true,
  cns: true,
  cpf: true,
  birthDate: true,
  sex: true,
  motherName: true,
  phone: true,
  kinship: true,
  bolsaFamilia: true,
  conditions: { where: { active: true }, select: { lineOfCare: true, code: true } },
} as const;

/**
 * Trabalho de campo do ACS: território (domicílios, famílias e pessoas da microárea), visitas domiciliares,
 * sincronização idempotente do que foi registrado sem internet e produtividade por agente.
 */
@Injectable()
export class AcsService {
  constructor(
    private readonly audit: AuditService,
    private readonly patients: PatientsService,
    private readonly households: HouseholdsService,
  ) {}

  /** Vínculo de campo do profissional na unidade do contexto: equipe (INE) e microárea. */
  private async lotacao(ctx: RequestContext, userId = ctx.session.userId): Promise<Lotacao | null> {
    const m = await ctx.db.teamMember.findFirst({
      where: { userId, active: true, team: { unitId: ctx.session.unitId, active: true } },
      include: { team: true },
      orderBy: [{ microArea: 'asc' }],
    });
    return m ? { teamId: m.teamId, teamName: m.team.name, ine: m.team.ine, microArea: m.microArea } : null;
  }

  private async escopo(ctx: RequestContext, q: EscopoTerritorio) {
    if (ctx.session.role === 'ACS') {
      const l = await this.lotacao(ctx);
      if (!l) {
        throw new DomainError('SEM_EQUIPE', 'Você ainda não está vinculado a uma equipe e microárea nesta unidade. Peça à gestão para incluir sua lotação em Administração › Equipes.', HttpStatus.UNPROCESSABLE_ENTITY);
      }
      return { ...l, unitId: ctx.session.unitId, nome: `${l.teamName} · microárea ${l.microArea ?? 'toda a área'}` };
    }
    if (q.teamId) {
      const team = await ctx.db.team.findUnique({ where: { id: q.teamId } });
      if (!team) throw notFound('Equipe');
      return { teamId: team.id, teamName: team.name, ine: team.ine, microArea: q.microArea ?? null, unitId: team.unitId, nome: `${team.name}${q.microArea ? ` · microárea ${q.microArea}` : ''}` };
    }
    const unitId = q.unitId ?? ctx.session.unitId;
    const unit = await ctx.db.unit.findUnique({ where: { id: unitId } });
    if (!unit) throw notFound('Unidade');
    return { teamId: null, teamName: null, ine: null, microArea: q.microArea ?? null, unitId, nome: `${unit.name}${q.microArea ? ` · microárea ${q.microArea}` : ''}` };
  }

  private domicilioWhere(e: { teamId: string | null; unitId: string; microArea: string | null }) {
    return {
      active: true,
      ...(e.teamId ? { teamId: e.teamId } : { OR: [{ unitId: e.unitId }, { team: { unitId: e.unitId, active: true } }] }),
      ...(e.microArea ? { microArea: e.microArea } : {}),
    };
  }

  private prioridades(p: { birthDate: Date; bolsaFamilia: boolean; conditions: { lineOfCare: string | null; code: string }[] }, hoje: Date): Prioridade[] {
    const out = new Set<Prioridade>();
    const idade = ageInYears(p.birthDate, hoje);
    if (idade < 2) out.add('CRIANCA');
    if (idade >= 60) out.add('IDOSO');
    if (p.bolsaFamilia) out.add('BOLSA_FAMILIA');
    for (const c of p.conditions) {
      if (c.lineOfCare === 'GESTANTE') out.add('GESTANTE');
      if (c.lineOfCare === 'HIPERTENSAO') out.add('HIPERTENSAO');
      if (c.lineOfCare === 'DIABETES') out.add('DIABETES');
      if (/^A1[5-9]|^A30/.test(c.code.toUpperCase())) out.add('TB_HANSENIASE');
    }
    return [...out];
  }

  /** Território do agente (ou de uma equipe/microárea para quem acompanha): domicílios, famílias, pessoas e última visita. */
  async territorio(ctx: RequestContext, q: EscopoTerritorio) {
    const e = await this.escopo(ctx, q);
    const hoje = new Date();
    const rows = await ctx.db.household.findMany({
      where: this.domicilioWhere(e),
      include: {
        team: { select: { id: true, name: true, ine: true } },
        families: {
          where: { active: true },
          include: { members: { where: { mergedIntoId: null, deceasedAt: null }, select: pessoaSelect, orderBy: { birthDate: 'asc' } } },
        },
        visits: { orderBy: { visitedAt: 'desc' }, take: 1, select: { visitedAt: true, outcome: true, professionalId: true } },
      },
      orderBy: [{ street: 'asc' }, { number: 'asc' }],
    });
    const ids = rows.flatMap((h) => h.families.flatMap((f) => f.members.map((m) => m.id)));
    const ultimas = new Map<string, Date>();
    for (let i = 0; i < ids.length; i += 5000) {
      const g = await ctx.db.homeVisit.groupBy({ by: ['patientId'], where: { patientId: { in: ids.slice(i, i + 5000) }, outcome: '1' }, _max: { visitedAt: true } });
      for (const r of g) if (r.patientId && r._max.visitedAt) ultimas.set(r.patientId, r._max.visitedAt);
    }
    const resumo = { domicilios: rows.length, familias: 0, pessoas: 0, visitados30d: 0, semVisita90d: 0, gestantes: 0, criancas: 0, idosos: 0, cronicos: 0 };
    const domicilios = rows.map((h) => {
      const ultima = h.visits[0] ?? null;
      const dias = ultima ? Math.floor((hoje.getTime() - ultima.visitedAt.getTime()) / DIA) : null;
      if (dias !== null && dias <= 30 && ultima?.outcome === '1') resumo.visitados30d++;
      if (dias === null || dias > 90) resumo.semVisita90d++;
      const familias = h.families.map((f) => {
        resumo.familias++;
        return {
          id: f.id,
          recordNumber: f.recordNumber,
          incomeBracket: f.incomeBracket,
          responsibleId: f.responsibleId,
          membros: f.members.map((m) => {
            resumo.pessoas++;
            const prioridades = this.prioridades(m, hoje);
            if (prioridades.includes('GESTANTE')) resumo.gestantes++;
            if (prioridades.includes('CRIANCA')) resumo.criancas++;
            if (prioridades.includes('IDOSO')) resumo.idosos++;
            if (prioridades.includes('HIPERTENSAO') || prioridades.includes('DIABETES')) resumo.cronicos++;
            return { ...patientSummary(m), kinship: m.kinship, phone: m.phone, prioridades, ultimaVisita: ultimas.get(m.id)?.toISOString() ?? null };
          }),
        };
      });
      return {
        id: h.id,
        addressLine: [h.street, h.number, h.complement, h.district].filter(Boolean).join(', ') || null,
        cep: h.cep,
        street: h.street,
        number: h.number,
        complement: h.complement,
        district: h.district,
        city: h.city,
        uf: h.uf,
        latitude: h.latitude,
        longitude: h.longitude,
        microArea: h.microArea,
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
        animals: h.animals,
        notes: h.notes,
        teamId: h.teamId,
        unitId: h.unitId,
        updatedAt: h.updatedAt.toISOString(),
        ultimaVisita: ultima ? { at: ultima.visitedAt.toISOString(), desfecho: ultima.outcome, desfechoLabel: DESFECHO_VISITA[ultima.outcome] ?? ultima.outcome, dias } : null,
        familias,
      };
    });
    await this.audit.record(ctx, ctx.db, { action: 'acs.territorio', entityType: 'Team', entityId: e.teamId ?? undefined, payload: { escopo: e.nome, domicilios: rows.length, pessoas: resumo.pessoas } });
    return {
      agente: { teamId: e.teamId, teamName: e.teamName, ine: e.ine, microArea: e.microArea, unitId: e.unitId },
      escopo: e.nome,
      serverTime: hoje.toISOString(),
      resumo,
      domicilios,
    };
  }

  /** Visitas registradas (as do próprio agente, no papel ACS; por equipe/unidade para quem acompanha). */
  async visitas(ctx: RequestContext, q: FiltroVisitas) {
    const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(Date.now() - 30 * DIA);
    const to = q.to ? new Date(`${q.to}T23:59:59.999Z`) : new Date(Date.now() + DIA);
    const where = {
      visitedAt: { gte: from, lte: to },
      ...(ctx.session.role === 'ACS' ? { professionalId: ctx.session.userId } : q.professionalId ? { professionalId: q.professionalId } : {}),
      ...(q.teamId ? { teamId: q.teamId } : ctx.session.role === 'ACS' ? {} : { unitId: q.unitId ?? ctx.session.unitId }),
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.householdId ? { householdId: q.householdId } : {}),
    };
    const rows = await ctx.db.homeVisit.findMany({
      where,
      include: {
        patient: { select: { id: true, name: true, socialName: true, cns: true, cpf: true, birthDate: true, sex: true, motherName: true } },
        household: { select: { id: true, street: true, number: true, complement: true, district: true } },
      },
      orderBy: { visitedAt: 'desc' },
      take: 500,
    });
    const users = new Map((await ctx.db.user.findMany({ where: { id: { in: [...new Set(rows.map((v) => v.professionalId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return rows.map((v) => this.visitaView(v, users.get(v.professionalId) ?? null));
  }

  private visitaView(
    v: {
      id: string;
      clientId: string | null;
      visitedAt: Date;
      recordedAt: Date;
      syncedAt: Date;
      turno: number;
      outcome: string;
      reasons: string[];
      shared: boolean;
      outOfArea: boolean;
      microArea: string | null;
      propertyType: string;
      weightKg: unknown;
      heightCm: number | null;
      systolic: number | null;
      diastolic: number | null;
      temperature: unknown;
      glucose: number | null;
      glucoseType: number | null;
      latitude: number | null;
      longitude: number | null;
      notes: string | null;
      professionalId: string;
      cbo: string;
      patient: Parameters<typeof patientSummary>[0] | null;
      household: { id: string; street: string | null; number: string | null; complement: string | null; district: string | null } | null;
    },
    profissional: string | null,
  ) {
    const dec = (x: unknown) => (x === null || x === undefined ? null : Number(x));
    return {
      id: v.id,
      clientId: v.clientId,
      visitedAt: v.visitedAt.toISOString(),
      recordedAt: v.recordedAt.toISOString(),
      syncedAt: v.syncedAt.toISOString(),
      turno: v.turno,
      desfecho: v.outcome,
      desfechoLabel: DESFECHO_VISITA[v.outcome] ?? v.outcome,
      motivos: v.reasons.map((r) => ({ codigo: r, descricao: MOTIVO_VISITA_LABEL[r] ?? r })),
      compartilhada: v.shared,
      foraDaArea: v.outOfArea,
      microArea: v.microArea,
      tipoImovel: v.propertyType,
      tipoImovelLabel: TIPO_IMOVEL[v.propertyType] ?? v.propertyType,
      medicoes: { pesoKg: dec(v.weightKg), alturaCm: v.heightCm, sistolica: v.systolic, diastolica: v.diastolic, temperatura: dec(v.temperature), glicemia: v.glucose, tipoGlicemia: v.glucoseType },
      latitude: v.latitude,
      longitude: v.longitude,
      observacoes: v.notes,
      profissional: { id: v.professionalId, nome: profissional, cbo: v.cbo },
      pessoa: v.patient ? patientSummary(v.patient) : null,
      domicilio: v.household ? { id: v.household.id, addressLine: [v.household.street, v.household.number, v.household.complement, v.household.district].filter(Boolean).join(', ') || null } : null,
    };
  }

  // ─── Sincronização do que foi registrado no aparelho ───────────────────────

  /**
   * Aplica as operações registradas em campo (pessoas, domicílios e visitas), na ordem certa, de forma
   * idempotente: a mesma operação (clientId) reenviada volta como DUPLICADA com o id criado da primeira vez.
   */
  async sync(ctx: RequestContext, operacoes: OperacaoCampo[]) {
    if (operacoes.length > 500) throw new DomainError('LOTE_GRANDE', 'Envie no máximo 500 operações por vez');
    const lot = await this.lotacao(ctx);
    const refs = new Set<string>();
    for (const op of operacoes) {
      refs.add(op.clientId);
      if (op.tipo === 'PESSOA' && op.familiaClientId) refs.add(op.familiaClientId);
      if (op.tipo === 'DOMICILIO' && op.familia?.responsavelClientId) refs.add(op.familia.responsavelClientId);
      if (op.tipo === 'VISITA') {
        if (op.householdClientId) refs.add(op.householdClientId);
        if (op.patientClientId) refs.add(op.patientClientId);
      }
    }
    const anteriores = await ctx.db.fieldSyncOp.findMany({ where: { clientId: { in: [...refs] } } });
    const feitas = new Map(anteriores.map((a) => [a.clientId, a]));
    /** clientId → id no servidor (pessoas e domicílios criados agora ou em sincronizações anteriores). */
    const ids = new Map<string, string>();
    /** clientId do domicílio → id da família criada com ele. */
    const familias = new Map<string, string>();
    for (const a of anteriores) if (a.entityId) ids.set(a.clientId, a.entityId);
    for (const a of anteriores) {
      if (a.kind === 'DOMICILIO' && a.entityId) {
        const f = await ctx.db.family.findFirst({ where: { householdId: a.entityId, active: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
        if (f) familias.set(a.clientId, f.id);
      }
    }
    /** Membros de famílias que ainda serão criadas neste lote. */
    const membrosPendentes: { familiaClientId: string; patientId: string; kinship: string }[] = [];
    const resultados: ResultadoSync[] = [];
    for (const op of ordenarOperacoes(operacoes)) {
      const feita = feitas.get(op.clientId);
      if (feita) {
        resultados.push({ clientId: op.clientId, tipo: op.tipo, status: 'DUPLICADA', id: feita.entityId, erro: null });
        continue;
      }
      try {
        const r = await this.aplicar(ctx, op, { ids, familias, membrosPendentes, lot });
        ids.set(op.clientId, r.id);
        await ctx.db.fieldSyncOp.create({
          data: { clientId: op.clientId, kind: op.tipo, userId: ctx.session.userId, unitId: ctx.session.unitId, status: 'OK', entityType: r.entityType, entityId: r.id, recordedAt: this.quando(op.registradoEm) },
        });
        resultados.push({ clientId: op.clientId, tipo: op.tipo, status: 'OK', id: r.id, erro: null });
      } catch (err) {
        const msg = err instanceof DomainError ? this.mensagemErro(err) : err instanceof Error ? err.message : String(err);
        resultados.push({ clientId: op.clientId, tipo: op.tipo, status: 'ERRO', id: null, erro: msg });
      }
    }
    const ok = resultados.filter((r) => r.status === 'OK').length;
    await this.audit.record(ctx, ctx.db, {
      action: 'acs.sincronizar',
      entityType: 'FieldSync',
      entityId: undefined,
      payload: { total: operacoes.length, ok, duplicadas: resultados.filter((r) => r.status === 'DUPLICADA').length, erros: resultados.filter((r) => r.status === 'ERRO').length },
    });
    return { resultados, sincronizadoEm: new Date().toISOString() };
  }

  private mensagemErro(err: DomainError): string {
    const d = err.details as { duplicates?: { name?: string; reason?: string }[]; needsConfirmation?: boolean } | undefined;
    if (d?.duplicates?.length) return `${err.message}: ${d.duplicates.map((x) => x.name ?? x.reason).join(', ')}${d.needsConfirmation ? '. Se for outra pessoa, marque "não é a mesma pessoa" e envie de novo.' : ''}`;
    return err.message;
  }

  /** Data informada pelo aparelho, nunca no futuro (relógio errado) nem antes de 1 ano. */
  private quando(iso: string): Date {
    const d = new Date(iso);
    const now = Date.now();
    if (Number.isNaN(d.getTime()) || d.getTime() > now) return new Date(now);
    if (d.getTime() < now - 366 * DIA) throw new DomainError('DATA_INVALIDA', 'Registro com mais de um ano: confira a data do aparelho');
    return d;
  }

  private async aplicar(
    ctx: RequestContext,
    op: OperacaoCampo,
    ref: { ids: Map<string, string>; familias: Map<string, string>; membrosPendentes: { familiaClientId: string; patientId: string; kinship: string }[]; lot: Lotacao | null },
  ): Promise<{ entityType: string; id: string }> {
    switch (op.tipo) {
      case 'PESSOA':
        return { entityType: 'Patient', id: await this.aplicarPessoa(ctx, op, ref) };
      case 'DOMICILIO':
        return { entityType: 'Household', id: await this.aplicarDomicilio(ctx, op, ref) };
      case 'VISITA':
        return { entityType: 'HomeVisit', id: await this.aplicarVisita(ctx, op, ref) };
    }
  }

  private pessoaInput(d: PessoaCampo): PatientInput {
    return {
      name: d.name,
      birthDate: d.birthDate,
      sex: d.sex,
      cpf: d.cpf ?? null,
      cns: d.cns ?? null,
      motherName: d.motherName ?? null,
      phone: d.phone ?? null,
      racaCor: (d.racaCor ?? null) as PatientInput['racaCor'],
      education: (d.education ?? null) as PatientInput['education'],
      nis: d.nis ?? null,
      bolsaFamilia: d.bolsaFamilia ?? null,
      address: d.endereco ? { ...d.endereco, uf: (d.endereco.uf ?? null) as PatientInput['address'] extends infer A ? (A extends { uf?: infer U } ? U : never) : never } : null,
      confirmNotDuplicate: d.confirmarNaoDuplicado ?? false,
    };
  }

  private async aplicarPessoa(ctx: RequestContext, op: Extract<OperacaoCampo, { tipo: 'PESSOA' }>, ref: Parameters<AcsService['aplicar']>[2]): Promise<string> {
    let patientId: string;
    if (op.patientId) {
      await this.patients.update(ctx, op.patientId, this.pessoaInput(op.dados));
      patientId = op.patientId;
    } else {
      patientId = (await this.patients.create(ctx, this.pessoaInput(op.dados))).id;
    }
    const kinship = op.kinship ?? '09';
    const familyId = op.familyId ?? (op.familiaClientId ? ref.familias.get(op.familiaClientId) : undefined);
    if (familyId) await this.households.addMember(ctx, familyId, patientId, kinship);
    else if (op.familiaClientId) ref.membrosPendentes.push({ familiaClientId: op.familiaClientId, patientId, kinship });
    return patientId;
  }

  private domicilioInput(d: DomicilioCampo) {
    const { latitude, longitude, ...rest } = d;
    return { ...rest, latitude: latitude ?? undefined, longitude: longitude ?? undefined };
  }

  private async aplicarDomicilio(ctx: RequestContext, op: Extract<OperacaoCampo, { tipo: 'DOMICILIO' }>, ref: Parameters<AcsService['aplicar']>[2]): Promise<string> {
    if (op.householdId) {
      await this.households.update(ctx, op.householdId, this.domicilioInput(op.dados));
      return op.householdId;
    }
    const responsavelId = op.familia?.responsavelId ?? (op.familia?.responsavelClientId ? ref.ids.get(op.familia.responsavelClientId) : undefined);
    if (op.familia?.responsavelClientId && !responsavelId) throw new DomainError('RESPONSAVEL_NAO_ENCONTRADO', 'O responsável da família não foi cadastrado (operação anterior com erro)');
    const h = await this.households.create(ctx, {
      ...this.domicilioInput(op.dados),
      unitId: ctx.session.unitId,
      teamId: ref.lot?.teamId ?? null,
      microArea: op.dados.microArea ?? ref.lot?.microArea ?? null,
      family: op.familia ? { responsibleId: responsavelId ?? null, incomeBracket: op.familia.incomeBracket ?? null, recordNumber: op.familia.recordNumber ?? null } : null,
    });
    const family = h.families[0];
    if (family) {
      ref.familias.set(op.clientId, family.id);
      for (const m of ref.membrosPendentes.filter((x) => x.familiaClientId === op.clientId)) {
        if (m.patientId !== responsavelId) await this.households.addMember(ctx, family.id, m.patientId, m.kinship);
      }
    }
    return h.id;
  }

  private async aplicarVisita(ctx: RequestContext, op: Extract<OperacaoCampo, { tipo: 'VISITA' }>, ref: Parameters<AcsService['aplicar']>[2]): Promise<string> {
    const v: VisitaCampo = op.visita;
    const householdId = op.householdId ?? (op.householdClientId ? ref.ids.get(op.householdClientId) : undefined) ?? null;
    const patientId = op.patientId ?? (op.patientClientId ? ref.ids.get(op.patientClientId) : undefined) ?? null;
    if ((op.householdClientId && !householdId) || (op.patientClientId && !patientId))
      throw new DomainError('REFERENCIA_NAO_ENCONTRADA', 'O domicílio ou a pessoa desta visita não foi cadastrado (operação anterior com erro)');
    const household = householdId ? await ctx.db.household.findUnique({ where: { id: householdId } }) : null;
    if (householdId && !household) throw notFound('Domicílio');
    const patient = patientId ? await ctx.db.patient.findUnique({ where: { id: patientId }, select: { id: true, mergedIntoId: true } }) : null;
    if (patientId && (!patient || patient.mergedIntoId)) throw notFound('Pessoa');
    if (!DESFECHO_VISITA[v.desfecho]) throw new DomainError('DESFECHO_INVALIDO', 'Desfecho da visita inválido');
    const motivos = [...new Set(v.motivos)];
    if (!motivos.length) throw new DomainError('SEM_MOTIVO', 'Informe ao menos um motivo da visita');
    const invalido = motivos.find((m) => !MOTIVO_VISITA_LABEL[m]);
    if (invalido) throw new DomainError('MOTIVO_INVALIDO', `Motivo de visita desconhecido: ${invalido}`);
    const tipoImovel = v.tipoImovel ?? household?.propertyType ?? '01';
    if (!TIPO_IMOVEL[tipoImovel]) throw new DomainError('TIPO_IMOVEL_INVALIDO', 'Tipo de imóvel inválido');
    if (!patientId && tipoImovel === '01' && v.desfecho === '1') throw new DomainError('PESSOA_OBRIGATORIA', 'Visita realizada a um domicílio precisa informar a pessoa visitada');
    const visitedAt = this.quando(op.registradoEm);
    const turno = v.turno ?? turnoDaHora(zonedParts(visitedAt, ctx.tenant.timeZone).hour);
    const microArea = v.microArea ?? household?.microArea ?? ref.lot?.microArea ?? null;
    const dec = (x: number | null | undefined) => (x === null || x === undefined ? null : x);
    return ctx.db.$transaction(async (tx) => {
      const visit = await tx.homeVisit.create({
        data: {
          clientId: op.clientId,
          unitId: ctx.session.unitId,
          teamId: household?.teamId ?? ref.lot?.teamId ?? null,
          professionalId: ctx.session.userId,
          cbo: ctx.cbo,
          householdId,
          patientId,
          visitedAt,
          recordedAt: visitedAt,
          turno,
          outcome: v.desfecho,
          reasons: motivos,
          shared: v.compartilhada ?? false,
          outOfArea: v.foraDaArea ?? false,
          microArea: v.foraDaArea ? null : microArea,
          propertyType: tipoImovel,
          weightKg: dec(v.pesoKg),
          heightCm: dec(v.alturaCm),
          systolic: dec(v.sistolica),
          diastolic: dec(v.diastolica),
          temperature: dec(v.temperatura),
          glucose: dec(v.glicemia),
          glucoseType: v.glicemia !== null && v.glicemia !== undefined ? Number(v.tipoGlicemia ?? 4) : null,
          latitude: dec(v.latitude),
          longitude: dec(v.longitude),
          notes: v.observacoes?.trim() || null,
        },
      });
      if (household && household.latitude === null && v.latitude !== null && v.latitude !== undefined && v.longitude !== null && v.longitude !== undefined) {
        await tx.household.update({ where: { id: household.id }, data: { latitude: v.latitude, longitude: v.longitude } });
      }
      if (patientId && v.desfecho === '1') await tx.activeSearchCase.updateMany({ where: { patientId, status: { not: 'ENCERRADO' } }, data: { lastVisitAt: visitedAt } });
      await this.audit.record(ctx, tx, {
        action: 'acs.visita',
        entityType: 'HomeVisit',
        entityId: visit.id,
        payload: { householdId, patientId, desfecho: v.desfecho, motivos, visitedAt: visitedAt.toISOString(), clientId: op.clientId },
      });
      return visit.id;
    });
  }

  // ─── Produtividade ──────────────────────────────────────────────────────────

  async produtividade(ctx: RequestContext, q: EscopoTerritorio & { from: string; to: string }) {
    const e = await this.escopo(ctx, q);
    const from = new Date(`${q.from}T00:00:00Z`);
    const to = new Date(`${q.to}T23:59:59.999Z`);
    if (to < from) throw new DomainError('PERIODO_INVALIDO', 'A data final é anterior à inicial');
    const where = {
      visitedAt: { gte: from, lte: to },
      ...(e.teamId ? { teamId: e.teamId } : { unitId: e.unitId }),
      ...(ctx.session.role === 'ACS' ? { professionalId: ctx.session.userId } : {}),
    };
    const visitas = await ctx.db.homeVisit.findMany({ where, select: { professionalId: true, outcome: true, householdId: true, patientId: true, reasons: true } });
    // Agentes do escopo: membros de equipe com CBO de ACS/TACS mais quem registrou visita no período.
    const membros = await ctx.db.teamMember.findMany({
      where: { active: true, userId: { not: null }, cbo: { startsWith: '5151' }, team: e.teamId ? { id: e.teamId } : { unitId: e.unitId, active: true } },
      include: { team: { select: { id: true, name: true } }, user: { select: { id: true, name: true } } },
    });
    const agenteIds = new Set<string>([...membros.map((m) => m.userId as string), ...visitas.map((v) => v.professionalId)]);
    if (ctx.session.role === 'ACS') for (const id of [...agenteIds]) if (id !== ctx.session.userId) agenteIds.delete(id);
    const nomes = new Map((await ctx.db.user.findMany({ where: { id: { in: [...agenteIds] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const territorio = new Map<string, number>();
    for (const m of membros) {
      if (!m.userId || !agenteIds.has(m.userId)) continue;
      const n = await ctx.db.household.count({ where: { active: true, teamId: m.teamId, ...(m.microArea ? { microArea: m.microArea } : {}) } });
      territorio.set(m.userId, (territorio.get(m.userId) ?? 0) + n);
    }
    const cadastros = await ctx.db.fieldSyncOp.groupBy({
      by: ['userId', 'kind'],
      where: { status: 'OK', userId: { in: [...agenteIds] }, kind: { in: ['PESSOA', 'DOMICILIO'] }, recordedAt: { gte: from, lte: to } },
      _count: { _all: true },
    });
    const ultimaSync = await ctx.db.fieldSyncOp.groupBy({ by: ['userId'], where: { userId: { in: [...agenteIds] } }, _max: { receivedAt: true } });
    const resumos = new Map(
      resumirVisitas(
        visitas.filter((v) => agenteIds.has(v.professionalId)).map((v) => ({ professionalId: v.professionalId, desfecho: v.outcome, householdId: v.householdId, patientId: v.patientId, motivos: v.reasons })),
        territorio,
      ).map((r) => [r.professionalId, r]),
    );
    const agentes = [...agenteIds]
      .map((id) => {
        const m = membros.find((x) => x.userId === id);
        const r = resumos.get(id) ?? {
          professionalId: id,
          visitas: 0,
          realizadas: 0,
          recusadas: 0,
          ausentes: 0,
          domiciliosVisitados: 0,
          pessoasVisitadas: 0,
          cobertura: territorio.get(id) ? 0 : null,
          motivosFrequentes: [],
        };
        return {
          ...r,
          nome: nomes.get(id) ?? id,
          cbo: m?.cbo ?? null,
          equipe: m?.team.name ?? null,
          microArea: m?.microArea ?? null,
          domiciliosTerritorio: territorio.get(id) ?? null,
          cadastros: {
            pessoas: cadastros.find((c) => c.userId === id && c.kind === 'PESSOA')?._count._all ?? 0,
            domicilios: cadastros.find((c) => c.userId === id && c.kind === 'DOMICILIO')?._count._all ?? 0,
          },
          ultimaSincronizacao: ultimaSync.find((u) => u.userId === id)?._max.receivedAt?.toISOString() ?? null,
        };
      })
      .sort((a, b) => b.realizadas - a.realizadas || a.nome.localeCompare(b.nome));
    const totais = agentes.reduce(
      (acc, a) => ({
        visitas: acc.visitas + a.visitas,
        realizadas: acc.realizadas + a.realizadas,
        recusadas: acc.recusadas + a.recusadas,
        ausentes: acc.ausentes + a.ausentes,
        cadastrosPessoas: acc.cadastrosPessoas + a.cadastros.pessoas,
        cadastrosDomicilios: acc.cadastrosDomicilios + a.cadastros.domicilios,
      }),
      { visitas: 0, realizadas: 0, recusadas: 0, ausentes: 0, cadastrosPessoas: 0, cadastrosDomicilios: 0 },
    );
    return { escopo: e.nome, from: q.from, to: q.to, agentes, totais };
  }
}
