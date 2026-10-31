import { HttpStatus, Injectable } from '@nestjs/common';
import { onlyDigits } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { patientSummary } from './patients.service';

export interface HouseholdInput {
  cep?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  district?: string | null;
  city?: string | null;
  uf?: string | null;
  ibgeCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  propertyType?: string | null;
  dwellingType?: string | null;
  tenure?: string | null;
  wallMaterial?: string | null;
  waterSupply?: string | null;
  waterTreatment?: string | null;
  sewage?: string | null;
  garbage?: string | null;
  electricity?: boolean | null;
  rooms?: number | null;
  animals?: string | null;
  microArea?: string | null;
  unitId?: string | null;
  teamId?: string | null;
  notes?: string | null;
}

export interface FamilyInput {
  responsibleId?: string | null;
  recordNumber?: string | null;
  incomeBracket?: string | null;
}

const familyInclude = {
  responsible: true,
  members: { where: { mergedIntoId: null }, orderBy: { birthDate: 'asc' as const } },
};
const householdInclude = { families: { where: { active: true }, include: familyInclude }, unit: { select: { id: true, name: true } }, team: { select: { id: true, ine: true, name: true } } };

/** Domicílios e famílias: um paciente pertence a uma família, que vive num domicílio (base do cadastro domiciliar do e-SUS). */
@Injectable()
export class HouseholdsService {
  constructor(private readonly audit: AuditService) {}

  async search(ctx: RequestContext, q: string) {
    const term = q.trim();
    const digits = onlyDigits(term);
    const rows = await ctx.db.household.findMany({
      where: {
        active: true,
        ...(digits.length === 8 ? { cep: digits } : term ? { OR: [{ street: { contains: term, mode: 'insensitive' } }, { district: { contains: term, mode: 'insensitive' } }] } : {}),
      },
      include: householdInclude,
      orderBy: [{ street: 'asc' }, { number: 'asc' }],
      take: 30,
    });
    return rows.map((h) => this.view(h));
  }

  async get(ctx: RequestContext, id: string) {
    const h = await ctx.db.household.findUnique({ where: { id }, include: householdInclude });
    if (!h) throw notFound('Domicílio');
    return this.view(h);
  }

  async create(ctx: RequestContext, input: HouseholdInput & { family?: FamilyInput | null }) {
    return ctx.db.$transaction(async (tx) => {
      const h = await tx.household.create({ data: { ...this.data(input), unitId: input.unitId ?? ctx.session.unitId ?? null } });
      if (input.family) await this.newFamily(ctx, tx, h.id, input.family);
      await this.audit.record(ctx, tx, { action: 'domicilio.cadastrar', entityType: 'Household', entityId: h.id, payload: input });
      const full = await tx.household.findUniqueOrThrow({ where: { id: h.id }, include: householdInclude });
      return this.view(full);
    });
  }

  async update(ctx: RequestContext, id: string, input: HouseholdInput) {
    const h = await ctx.db.household.findUnique({ where: { id } });
    if (!h) throw notFound('Domicílio');
    return ctx.db.$transaction(async (tx) => {
      await tx.household.update({ where: { id }, data: this.data(input) });
      await this.audit.record(ctx, tx, { action: 'domicilio.atualizar', entityType: 'Household', entityId: id, payload: input });
      return this.view(await tx.household.findUniqueOrThrow({ where: { id }, include: householdInclude }));
    });
  }

  async createFamily(ctx: RequestContext, householdId: string, input: FamilyInput) {
    const h = await ctx.db.household.findUnique({ where: { id: householdId } });
    if (!h) throw notFound('Domicílio');
    return ctx.db.$transaction(async (tx) => {
      const f = await this.newFamily(ctx, tx, householdId, input);
      return this.familyView(await tx.family.findUniqueOrThrow({ where: { id: f.id }, include: familyInclude }));
    });
  }

  async updateFamily(ctx: RequestContext, id: string, input: FamilyInput) {
    const f = await ctx.db.family.findUnique({ where: { id } });
    if (!f) throw notFound('Família');
    return ctx.db.$transaction(async (tx) => {
      await tx.family.update({ where: { id }, data: { recordNumber: input.recordNumber ?? undefined, incomeBracket: input.incomeBracket ?? undefined } });
      if (input.responsibleId) await this.setResponsible(tx, id, input.responsibleId);
      await this.audit.record(ctx, tx, { action: 'familia.atualizar', entityType: 'Family', entityId: id, payload: input });
      return this.familyView(await tx.family.findUniqueOrThrow({ where: { id }, include: familyInclude }));
    });
  }

  /** Inclui um paciente na família (ele sai de qualquer outra); parentesco "00" o torna responsável. */
  async addMember(ctx: RequestContext, familyId: string, patientId: string, kinship: string) {
    const f = await ctx.db.family.findUnique({ where: { id: familyId } });
    if (!f) throw notFound('Família');
    const p = await ctx.db.patient.findUnique({ where: { id: patientId } });
    if (!p || p.mergedIntoId) throw notFound('Paciente');
    return ctx.db.$transaction(async (tx) => {
      await tx.patient.update({ where: { id: patientId }, data: { familyId, kinship } });
      if (kinship === '00') await this.setResponsible(tx, familyId, patientId);
      await this.audit.record(ctx, tx, { action: 'familia.incluir_membro', entityType: 'Family', entityId: familyId, payload: { patientId, kinship } });
      return this.familyView(await tx.family.findUniqueOrThrow({ where: { id: familyId }, include: familyInclude }));
    });
  }

  async removeMember(ctx: RequestContext, familyId: string, patientId: string) {
    const f = await ctx.db.family.findUnique({ where: { id: familyId } });
    if (!f) throw notFound('Família');
    return ctx.db.$transaction(async (tx) => {
      await tx.patient.updateMany({ where: { id: patientId, familyId }, data: { familyId: null, kinship: null } });
      if (f.responsibleId === patientId) await tx.family.update({ where: { id: familyId }, data: { responsibleId: null } });
      await this.audit.record(ctx, tx, { action: 'familia.remover_membro', entityType: 'Family', entityId: familyId, payload: { patientId } });
      return this.familyView(await tx.family.findUniqueOrThrow({ where: { id: familyId }, include: familyInclude }));
    });
  }

  private async newFamily(ctx: RequestContext, tx: Parameters<AuditService['record']>[1], householdId: string, input: FamilyInput) {
    const f = await tx.family.create({ data: { householdId, recordNumber: input.recordNumber ?? null, incomeBracket: input.incomeBracket ?? null } });
    if (input.responsibleId) await this.setResponsible(tx, f.id, input.responsibleId);
    await this.audit.record(ctx, tx, { action: 'familia.cadastrar', entityType: 'Family', entityId: f.id, payload: input });
    return f;
  }

  private async setResponsible(tx: Parameters<AuditService['record']>[1], familyId: string, patientId: string) {
    const p = await tx.patient.findUnique({ where: { id: patientId } });
    if (!p || p.mergedIntoId) throw notFound('Paciente responsável');
    const family = await tx.family.findUniqueOrThrow({ where: { id: familyId } });
    // Quem era responsável continua na família como "outro parente" até ser reclassificado.
    if (family.responsibleId && family.responsibleId !== patientId) {
      await tx.patient.updateMany({ where: { id: family.responsibleId, familyId, kinship: '00' }, data: { kinship: '09' } });
    }
    await tx.patient.update({ where: { id: patientId }, data: { familyId, kinship: '00' } });
    await tx.family.update({ where: { id: familyId }, data: { responsibleId: patientId } });
  }

  private data(input: HouseholdInput) {
    const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
    return {
      cep: input.cep === undefined ? undefined : input.cep ? onlyDigits(input.cep) : null,
      street: clean(input.street),
      number: clean(input.number),
      complement: clean(input.complement),
      district: clean(input.district),
      city: clean(input.city),
      uf: input.uf === undefined ? undefined : input.uf?.toUpperCase() || null,
      ibgeCode: input.ibgeCode === undefined ? undefined : input.ibgeCode ? onlyDigits(input.ibgeCode) : null,
      latitude: input.latitude,
      longitude: input.longitude,
      propertyType: clean(input.propertyType),
      dwellingType: clean(input.dwellingType),
      tenure: clean(input.tenure),
      wallMaterial: clean(input.wallMaterial),
      waterSupply: clean(input.waterSupply),
      waterTreatment: clean(input.waterTreatment),
      sewage: clean(input.sewage),
      garbage: clean(input.garbage),
      electricity: input.electricity,
      rooms: input.rooms,
      animals: clean(input.animals),
      microArea: clean(input.microArea),
      unitId: input.unitId,
      teamId: input.teamId,
      notes: clean(input.notes),
    };
  }

  private view(h: {
    id: string;
    cep: string | null;
    street: string | null;
    number: string | null;
    complement: string | null;
    district: string | null;
    city: string | null;
    uf: string | null;
    ibgeCode: string | null;
    latitude: number | null;
    longitude: number | null;
    propertyType: string | null;
    dwellingType: string | null;
    tenure: string | null;
    wallMaterial: string | null;
    waterSupply: string | null;
    waterTreatment: string | null;
    sewage: string | null;
    garbage: string | null;
    electricity: boolean | null;
    rooms: number | null;
    animals: string | null;
    microArea: string | null;
    notes: string | null;
    active: boolean;
    unit: { id: string; name: string } | null;
    team: { id: string; ine: string; name: string } | null;
    families: Parameters<HouseholdsService['familyView']>[0][];
  }) {
    const { families, unit, team, ...rest } = h;
    return {
      ...rest,
      addressLine: [h.street, h.number, h.complement, h.district].filter(Boolean).join(', ') || null,
      unit,
      team,
      families: families.map((f) => this.familyView(f)),
    };
  }

  private familyView(f: {
    id: string;
    householdId: string;
    responsibleId: string | null;
    recordNumber: string | null;
    incomeBracket: string | null;
    active: boolean;
    responsible: Parameters<typeof patientSummary>[0] | null;
    members: (Parameters<typeof patientSummary>[0] & { kinship: string | null })[];
  }) {
    return {
      id: f.id,
      householdId: f.householdId,
      recordNumber: f.recordNumber,
      incomeBracket: f.incomeBracket,
      responsible: f.responsible ? patientSummary(f.responsible) : null,
      members: f.members.map((m) => ({ ...patientSummary(m), kinship: m.kinship })),
    };
  }
}

export function assertKinship(code: string) {
  if (!/^\d{2}$/.test(code)) throw new DomainError('PARENTESCO_INVALIDO', 'Parentesco inválido', HttpStatus.UNPROCESSABLE_ENTITY);
}
