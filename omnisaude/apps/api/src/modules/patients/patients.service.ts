import { Injectable } from '@nestjs/common';
import {
  ageInYears,
  isValidCns,
  isValidCpf,
  normalizePersonName,
  onlyDigits,
  personNameKey,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { conflict, DomainError, notFound } from '../../core/errors';
import type { PatientInput } from './patients.schemas';

export function patientSummary(p: { id: string; name: string; socialName: string | null; cns: string | null; cpf: string | null; birthDate: Date; sex: string; motherName: string | null }) {
  return {
    id: p.id,
    name: p.socialName ?? p.name,
    civilName: p.name,
    cns: p.cns,
    cpf: p.cpf,
    birthDate: p.birthDate.toISOString().slice(0, 10),
    age: ageInYears(p.birthDate),
    sex: p.sex,
    motherName: p.motherName,
  };
}

const ENCOUNTER_STATUS: Record<string, string> = {
  ABERTO: 'aguardando',
  TRIADO: 'classificado',
  EM_ATENDIMENTO: 'em atendimento',
  ENCERRADO: 'encerrado',
  CANCELADO: 'cancelado',
  EVADIU: 'evasão',
};
const APPOINTMENT_STATUS: Record<string, string> = {
  AGENDADO: 'agendado',
  CONFIRMADO: 'confirmado',
  CANCELADO: 'cancelado',
  FALTOU: 'faltou',
  ATENDIDO: 'atendido',
  REMARCADO: 'remarcado',
};

@Injectable()
export class PatientsService {
  constructor(private readonly audit: AuditService) {}

  async search(ctx: RequestContext, q: string, limit = 20) {
    const digits = onlyDigits(q);
    const where =
      digits.length === 11
        ? { cpf: digits }
        : digits.length === 15
          ? { cns: digits }
          : { nameKey: { contains: personNameKey(q) } };
    const rows = await ctx.db.patient.findMany({ where, take: limit, orderBy: { name: 'asc' } });
    return rows.map(patientSummary);
  }

  async get(ctx: RequestContext, id: string) {
    const p = await ctx.db.patient.findUnique({
      where: { id },
      include: { allergies: true, conditions: { where: { active: true } } },
    });
    if (!p) throw notFound('Paciente');
    return {
      ...patientSummary(p),
      fatherName: p.fatherName,
      racaCor: p.racaCor,
      phone: p.phone,
      whatsappOptIn: p.whatsappOptIn,
      email: p.email,
      address: { cep: p.cep, street: p.street, number: p.number, complement: p.complement, district: p.district, ibgeCode: p.ibgeCode },
      cadsusSyncedAt: p.cadsusSyncedAt,
      allergies: p.allergies.map((a) => ({ id: a.id, substance: a.substance, reaction: a.reaction, severity: a.severity })),
      conditions: p.conditions.map((c) => ({ id: c.id, system: c.system, code: c.code, description: c.description, lineOfCare: c.lineOfCare })),
    };
  }

  /** Possíveis duplicidades: mesmo CPF/CNS, ou mesmo nome + data de nascimento (+ mãe, quando informada). */
  async findDuplicates(ctx: RequestContext, input: { cpf?: string | null; cns?: string | null; name: string; birthDate: string; motherName?: string | null }, excludeId?: string) {
    const or: object[] = [{ nameKey: personNameKey(input.name), birthDate: new Date(input.birthDate) }];
    if (input.cpf) or.push({ cpf: onlyDigits(input.cpf) });
    if (input.cns) or.push({ cns: onlyDigits(input.cns) });
    const rows = await ctx.db.patient.findMany({ where: { OR: or, ...(excludeId ? { id: { not: excludeId } } : {}) }, take: 10 });
    return rows.map((r) => ({
      ...patientSummary(r),
      reason:
        input.cpf && r.cpf === onlyDigits(input.cpf)
          ? 'CPF'
          : input.cns && r.cns === onlyDigits(input.cns)
            ? 'CNS'
            : 'NOME_NASCIMENTO',
    }));
  }

  private normalize(input: PatientInput) {
    const cpf = input.cpf ? onlyDigits(input.cpf) : null;
    const cns = input.cns ? onlyDigits(input.cns) : null;
    if (cpf && !isValidCpf(cpf)) throw new DomainError('CPF_INVALIDO', 'CPF inválido');
    if (cns && !isValidCns(cns)) throw new DomainError('CNS_INVALIDO', 'CNS inválido');
    const birth = new Date(input.birthDate);
    if (Number.isNaN(birth.getTime()) || birth > new Date()) throw new DomainError('NASCIMENTO_INVALIDO', 'Data de nascimento inválida');
    const name = normalizePersonName(input.name);
    return {
      cpf,
      cns,
      name,
      nameKey: personNameKey(name),
      socialName: input.socialName ? normalizePersonName(input.socialName) : null,
      motherName: input.motherName ? normalizePersonName(input.motherName) : null,
      fatherName: input.fatherName ? normalizePersonName(input.fatherName) : null,
      birthDate: birth,
      sex: input.sex,
      racaCor: input.racaCor ?? '99',
      phone: input.phone ? onlyDigits(input.phone) : null,
      whatsappOptIn: input.whatsappOptIn ?? false,
      email: input.email ?? null,
      cep: input.address?.cep ? onlyDigits(input.address.cep) : null,
      street: input.address?.street ?? null,
      number: input.address?.number ?? null,
      complement: input.address?.complement ?? null,
      district: input.address?.district ?? null,
      ibgeCode: input.address?.ibgeCode ?? null,
    };
  }

  async create(ctx: RequestContext, input: PatientInput) {
    const data = this.normalize(input);
    const duplicates = await this.findDuplicates(ctx, { ...data, birthDate: input.birthDate });
    const hard = duplicates.filter((d) => d.reason !== 'NOME_NASCIMENTO');
    if (hard.length) throw conflict('Já existe paciente com este CPF/CNS', { duplicates: hard });
    if (duplicates.length && !input.confirmNotDuplicate) {
      throw conflict('Possível duplicidade: confirme que é outra pessoa', { duplicates, needsConfirmation: true });
    }
    return ctx.db.$transaction(async (tx) => {
      const p = await tx.patient.create({ data: { ...data, cadsusSyncedAt: input.cadsusValidated ? new Date() : null } });
      await this.audit.record(ctx, tx, { action: 'paciente.cadastrar', entityType: 'Patient', entityId: p.id, payload: data });
      return patientSummary(p);
    });
  }

  async update(ctx: RequestContext, id: string, input: Partial<PatientInput>) {
    const current = await ctx.db.patient.findUnique({ where: { id } });
    if (!current) throw notFound('Paciente');
    const merged = this.normalize({
      ...{
        name: current.name,
        birthDate: current.birthDate.toISOString().slice(0, 10),
        sex: current.sex,
        cpf: current.cpf,
        cns: current.cns,
        motherName: current.motherName,
        fatherName: current.fatherName,
        socialName: current.socialName,
        racaCor: current.racaCor,
        phone: current.phone,
        whatsappOptIn: current.whatsappOptIn,
        email: current.email,
        address: { cep: current.cep, street: current.street, number: current.number, complement: current.complement, district: current.district, ibgeCode: current.ibgeCode },
      },
      ...input,
    } as PatientInput);
    const dupes = (await this.findDuplicates(ctx, { ...merged, birthDate: merged.birthDate.toISOString().slice(0, 10) }, id)).filter((d) => d.reason !== 'NOME_NASCIMENTO');
    if (dupes.length) throw conflict('CPF/CNS já pertence a outro paciente', { duplicates: dupes });
    return ctx.db.$transaction(async (tx) => {
      const p = await tx.patient.update({ where: { id }, data: merged });
      await this.audit.record(ctx, tx, { action: 'paciente.atualizar', entityType: 'Patient', entityId: id, payload: merged });
      return patientSummary(p);
    });
  }

  async addAllergy(ctx: RequestContext, patientId: string, input: { substance: string; reaction?: string; severity?: string }) {
    await this.ensure(ctx, patientId);
    return ctx.db.patientAllergy.create({ data: { patientId, substance: input.substance.trim().toLowerCase(), reaction: input.reaction, severity: input.severity, recordedBy: ctx.session.userId } });
  }

  async addCondition(ctx: RequestContext, patientId: string, input: { system: 'CID10' | 'CID11' | 'CIAP2'; code: string; description: string; lineOfCare?: string }) {
    await this.ensure(ctx, patientId);
    return ctx.db.patientCondition.create({
      data: { patientId, system: input.system, code: input.code.toUpperCase(), description: input.description, lineOfCare: (input.lineOfCare as never) ?? null },
    });
  }

  /**
   * Linha do tempo única do paciente em toda a rede do tenant (UBS, UPA, hospital, farmácia).
   * O acesso é registrado na trilha de auditoria (LGPD).
   */
  async timeline(ctx: RequestContext, patientId: string) {
    await this.ensure(ctx, patientId);
    const db = ctx.db;
    const [encounters, prescriptions, dispensations, exams, vaccinations, appointments] = await Promise.all([
      db.encounter.findMany({
        where: { patientId },
        orderBy: { startedAt: 'desc' },
        take: 100,
        include: { unit: true, triages: { orderBy: { classifiedAt: 'desc' }, take: 1 }, notes: { where: { status: 'ASSINADO' }, orderBy: { signedAt: 'asc' } } },
      }),
      db.prescription.findMany({ where: { patientId }, orderBy: { signedAt: 'desc' }, take: 50, include: { items: true } }),
      db.dispensation.findMany({ where: { patientId }, orderBy: { dispensedAt: 'desc' }, take: 50, include: { items: true } }),
      db.examRequest.findMany({ where: { patientId }, orderBy: { requestedAt: 'desc' }, take: 50 }),
      db.vaccination.findMany({ where: { patientId }, orderBy: { appliedAt: 'desc' } }),
      db.appointment.findMany({ where: { patientId }, orderBy: { startsAt: 'desc' }, take: 30, include: { schedule: true } }),
    ]);
    const units = new Map((await db.unit.findMany()).map((u) => [u.id, u.name]));
    const users = new Map((await db.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const productIds = [...new Set(dispensations.flatMap((d) => d.items.map((i) => i.productId)))];
    const products = new Map((await db.product.findMany({ where: { id: { in: productIds } } })).map((p) => [p.id, p.description]));

    type Event = { at: Date; type: string; unit?: string; title: string; detail?: unknown; id: string };
    const events: Event[] = [];
    for (const e of encounters) {
      events.push({
        at: e.startedAt,
        type: 'ATENDIMENTO',
        id: e.id,
        unit: e.unit.name,
        title: `${e.kind === 'URGENCIA' ? 'Atendimento de urgência' : e.kind === 'INTERNACAO' ? 'Internação' : e.kind === 'ODONTOLOGICO' ? 'Atendimento odontológico' : 'Atendimento'} – ${ENCOUNTER_STATUS[e.status] ?? e.status}`,
        detail: {
          kind: e.kind,
          status: e.status,
          mainCid: e.mainCid,
          outcome: e.outcome,
          riskColor: e.triages[0]?.riskColor ?? null,
          notes: e.notes.map((n) => ({
            id: n.id,
            kind: n.kind,
            author: users.get(n.authorId),
            role: n.role,
            signedAt: n.signedAt,
            subjective: n.subjective,
            objective: n.objective,
            assessment: n.assessment,
            plan: n.plan,
            auditHash: n.auditHash,
          })),
        },
      });
    }
    for (const p of prescriptions) {
      events.push({
        at: p.signedAt,
        type: 'PRESCRICAO',
        id: p.id,
        title: `Prescrição ${p.kind.toLowerCase()} (${p.items.length} itens)`,
        detail: { prescriber: users.get(p.prescriberId), status: p.status, items: p.items.map((i) => ({ description: i.description, dose: i.dose, doseUnit: i.doseUnit, route: i.route, frequencyHours: i.frequencyHours, durationDays: i.durationDays })) },
      });
    }
    for (const d of dispensations) {
      events.push({
        at: d.dispensedAt,
        type: 'DISPENSACAO',
        id: d.id,
        unit: units.get(d.unitId),
        title: 'Dispensação de medicamentos',
        detail: { items: d.items.map((i) => ({ product: products.get(i.productId), quantity: i.quantity })) },
      });
    }
    for (const x of exams) {
      events.push({ at: x.resultAt ?? x.requestedAt, type: 'EXAME', id: x.id, title: x.name, detail: { status: x.status, result: x.resultValue, unit: x.resultUnit, text: x.resultText } });
    }
    for (const v of vaccinations) {
      events.push({ at: v.appliedAt, type: 'VACINA', id: v.id, unit: units.get(v.unitId), title: `${v.vaccineName} (${v.dose})`, detail: { lot: v.lot } });
    }
    for (const a of appointments) {
      events.push({ at: a.startsAt, type: 'AGENDAMENTO', id: a.id, unit: units.get(a.unitId), title: `${a.schedule.name} – ${APPOINTMENT_STATUS[a.status] ?? a.status}`, detail: { kind: a.kind, status: a.status } });
    }
    events.sort((a, b) => b.at.getTime() - a.at.getTime());
    await this.audit.recordStandalone(ctx, { action: 'paciente.prontuario.visualizar', entityType: 'Patient', entityId: patientId, payload: { events: events.length } });
    return { patient: await this.get(ctx, patientId), events };
  }

  /** Dados da pulseira de identificação (nome, nascimento, CNS, mãe, alergias) e o código lido à beira do leito. */
  async wristband(ctx: RequestContext, patientId: string) {
    const p = await this.get(ctx, patientId);
    return {
      name: p.name,
      birthDate: p.birthDate,
      cns: p.cns,
      motherName: p.motherName,
      allergies: p.allergies.map((a) => a.substance),
      code: `PAC:${p.id}`,
    };
  }

  async ensure(ctx: RequestContext, id: string) {
    const p = await ctx.db.patient.findUnique({ where: { id }, select: { id: true } });
    if (!p) throw notFound('Paciente');
  }
}
