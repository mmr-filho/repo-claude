import { HttpStatus, Injectable } from '@nestjs/common';
import { CARATER_INTERNACAO, ESPECIALIDADE_AIH, numeroAih, ROLE_LABELS, roleHasPermission, STATUS_AIH, TIPO_AIH, validadeAih, validarNumeroAih, type StatusAih } from '@omnisaude/shared';
import { TenantPrisma as Prisma } from '@omnisaude/database';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, forbidden, notFound } from '../../core/errors';
import { RealtimeService } from '../../core/realtime.service';
import { patientSummary } from '../patients/patients.service';
import { formatDate, formatDateTime, renderDocument, type DocumentModel } from '../signatures/pdf';

export interface LaudoAihInput {
  patientId: string;
  admissionId?: string | null;
  bedRequestId?: string | null;
  procedureCode: string;
  procedureName?: string | null;
  mainCid: string;
  secondaryCid?: string | null;
  associatedCid?: string | null;
  specialtyCode: string;
  nature: string;
  symptoms: string;
  conditions: string;
  diagnostics: string;
  notes?: string | null;
}

const include = {
  patient: { select: { id: true, name: true, socialName: true, cns: true, cpf: true, birthDate: true, sex: true, motherName: true } },
  admission: { select: { id: true, admittedAt: true, dischargedAt: true, mainCid: true, bed: { select: { code: true, ward: { select: { name: true, unitId: true } } } } } },
  bedRequest: { select: { id: true, protocol: true, status: true } },
  range: { select: { id: true, name: true } },
};
type Row = Prisma.AihRequestGetPayload<{ include: typeof include }>;

/** AIH: laudo médico para internação, autorização com número (faixa do gestor ou manual), negativa, faixas numéricas e impressão. */
@Injectable()
export class AihService {
  constructor(
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  private normalizarCid(v?: string | null) {
    const c = v?.toUpperCase().replace('.', '').trim();
    return c ? c : null;
  }

  private async validar(ctx: RequestContext, input: LaudoAihInput) {
    if (!ESPECIALIDADE_AIH[input.specialtyCode]) throw new DomainError('ESPECIALIDADE_INVALIDA', 'Especialidade do leito inválida', HttpStatus.UNPROCESSABLE_ENTITY);
    if (!CARATER_INTERNACAO[input.nature]) throw new DomainError('CARATER_INVALIDO', 'Caráter de internação inválido', HttpStatus.UNPROCESSABLE_ENTITY);
    const code = input.procedureCode.replace(/\D/g, '');
    if (code.length !== 10) throw new DomainError('PROCEDIMENTO_INVALIDO', 'Informe o procedimento SIGTAP com 10 dígitos', HttpStatus.UNPROCESSABLE_ENTITY);
    const sigtap = await ctx.db.sigtapProcedure.findUnique({ where: { code }, select: { name: true } });
    const procedureName = sigtap?.name ?? input.procedureName?.trim();
    if (!procedureName) throw new DomainError('PROCEDIMENTO_DESCONHECIDO', 'Procedimento não encontrado na SIGTAP: informe o nome', HttpStatus.UNPROCESSABLE_ENTITY);
    const mainCid = this.normalizarCid(input.mainCid);
    if (!mainCid || mainCid.length < 3) throw new DomainError('CID_INVALIDO', 'Informe o CID principal', HttpStatus.UNPROCESSABLE_ENTITY);
    return { code, procedureName, mainCid };
  }

  async criar(ctx: RequestContext, input: LaudoAihInput) {
    const patient = await ctx.db.patient.findUnique({ where: { id: input.patientId }, select: { id: true, mergedIntoId: true } });
    if (!patient || patient.mergedIntoId) throw notFound('Paciente');
    let unitId = ctx.session.unitId;
    if (input.admissionId) {
      const adm = await ctx.db.admission.findUnique({
        where: { id: input.admissionId },
        include: { bed: { select: { ward: { select: { unitId: true } } } }, encounter: { select: { unitId: true } }, aih: { select: { id: true, status: true } } },
      });
      if (!adm || adm.patientId !== input.patientId) throw notFound('Internação');
      if (adm.aih && adm.aih.status !== 'CANCELADA' && adm.aih.status !== 'NEGADA') throw new DomainError('AIH_EXISTENTE', 'Esta internação já tem um laudo de AIH', HttpStatus.CONFLICT);
      unitId = adm.bed?.ward.unitId ?? adm.encounter.unitId;
    }
    if (input.bedRequestId) {
      const r = await ctx.db.bedRequest.findUnique({ where: { id: input.bedRequestId }, select: { patientId: true } });
      if (!r || r.patientId !== input.patientId) throw notFound('Solicitação de vaga');
    }
    const pendente = await ctx.db.aihRequest.findFirst({ where: { patientId: input.patientId, status: 'PENDENTE' }, select: { id: true } });
    if (pendente) throw new DomainError('AIH_PENDENTE', 'Já existe um laudo de AIH aguardando autorização para esta pessoa', HttpStatus.CONFLICT);
    const { code, procedureName, mainCid } = await this.validar(ctx, input);
    const a = await ctx.db.$transaction(async (tx) => {
      const created = await tx.aihRequest.create({
        data: {
          patientId: input.patientId,
          admissionId: input.admissionId && !(await tx.aihRequest.findFirst({ where: { admissionId: input.admissionId, status: { in: ['PENDENTE', 'AUTORIZADA'] } } })) ? input.admissionId : null,
          bedRequestId: input.bedRequestId ?? null,
          unitId,
          requesterId: ctx.session.userId,
          requesterCbo: ctx.cbo,
          procedureCode: code,
          procedureName,
          mainCid,
          secondaryCid: this.normalizarCid(input.secondaryCid),
          associatedCid: this.normalizarCid(input.associatedCid),
          specialtyCode: input.specialtyCode,
          nature: input.nature,
          symptoms: input.symptoms.trim(),
          conditions: input.conditions.trim(),
          diagnostics: input.diagnostics.trim(),
          notes: input.notes?.trim() || null,
        },
      });
      await this.audit.record(ctx, tx, { action: 'aih.laudo', entityType: 'AihRequest', entityId: created.id, payload: { procedureCode: code, mainCid, admissionId: input.admissionId ?? null } });
      return created;
    });
    this.realtime.emitToTenant(ctx.tenant.id, 'aih.atualizada', { id: a.id, status: 'PENDENTE' });
    return this.detalhe(ctx, a.id);
  }

  async atualizar(ctx: RequestContext, id: string, input: LaudoAihInput) {
    const a = await this.carregar(ctx, id);
    if (a.status !== 'PENDENTE') throw new DomainError('SITUACAO_INVALIDA', 'O laudo só pode ser alterado enquanto aguarda autorização', HttpStatus.UNPROCESSABLE_ENTITY);
    if (a.requesterId !== ctx.session.userId && !roleHasPermission(ctx.session.role, 'aih.autorizar')) throw forbidden('O laudo só pode ser alterado por quem o emitiu');
    const { code, procedureName, mainCid } = await this.validar(ctx, { ...input, patientId: a.patientId });
    await ctx.db.$transaction(async (tx) => {
      await tx.aihRequest.update({
        where: { id },
        data: {
          procedureCode: code,
          procedureName,
          mainCid,
          secondaryCid: this.normalizarCid(input.secondaryCid),
          associatedCid: this.normalizarCid(input.associatedCid),
          specialtyCode: input.specialtyCode,
          nature: input.nature,
          symptoms: input.symptoms.trim(),
          conditions: input.conditions.trim(),
          diagnostics: input.diagnostics.trim(),
          notes: input.notes?.trim() || null,
        },
      });
      await this.audit.record(ctx, tx, { action: 'aih.laudo.atualizar', entityType: 'AihRequest', entityId: id, payload: { procedureCode: code, mainCid } });
    });
    return this.detalhe(ctx, id);
  }

  private async carregar(ctx: RequestContext, id: string) {
    const a = await ctx.db.aihRequest.findUnique({ where: { id } });
    if (!a) throw notFound('Laudo de AIH');
    return a;
  }

  /** Autoriza: número vindo da faixa (sequencial seguinte) ou digitado, sempre com o DV conferido. */
  async autorizar(ctx: RequestContext, id: string, input: { aihNumber?: string | null; rangeId?: string | null; aihType?: '1' | '5' | null; validUntil?: string | null; notes?: string | null }) {
    const a = await this.carregar(ctx, id);
    if (a.status !== 'PENDENTE') throw new DomainError('SITUACAO_INVALIDA', `Laudo ${STATUS_AIH[a.status].toLowerCase()}`, HttpStatus.UNPROCESSABLE_ENTITY);
    const tipo = input.aihType ?? '1';
    const resultado = await ctx.db.$transaction(async (tx) => {
      let numero: string;
      let rangeId: string | null = null;
      if (input.aihNumber?.trim()) {
        numero = input.aihNumber.replace(/\D/g, '');
        const v = validarNumeroAih(numero);
        if (!v.ok) throw new DomainError('AIH_NUMERO_INVALIDO', v.motivo ?? 'Número de AIH inválido', HttpStatus.UNPROCESSABLE_ENTITY);
      } else {
        const faixa = input.rangeId
          ? await tx.aihRange.findUnique({ where: { id: input.rangeId } })
          : await tx.aihRange.findFirst({ where: { active: true, aihType: tipo, OR: [{ unitId: a.unitId }, { unitId: null }] }, orderBy: [{ unitId: 'desc' }, { createdAt: 'asc' }] });
        if (!faixa || !faixa.active) throw new DomainError('SEM_FAIXA', 'Não há faixa numérica de AIH ativa: cadastre a faixa do gestor ou informe o número', HttpStatus.UNPROCESSABLE_ENTITY);
        if (faixa.seqNext > faixa.seqEnd) throw new DomainError('FAIXA_ESGOTADA', `A faixa ${faixa.name} está esgotada`, HttpStatus.UNPROCESSABLE_ENTITY);
        const { count } = await tx.aihRange.updateMany({ where: { id: faixa.id, seqNext: faixa.seqNext }, data: { seqNext: { increment: 1 } } });
        if (count !== 1) throw new DomainError('FAIXA_CONCORRENTE', 'Outro usuário acabou de usar o sequencial; tente de novo', HttpStatus.CONFLICT);
        numero = numeroAih(faixa.uf, faixa.year, faixa.aihType as '1' | '5', faixa.seqNext);
        rangeId = faixa.id;
      }
      if (await tx.aihRequest.findUnique({ where: { aihNumber: numero }, select: { id: true } })) throw new DomainError('AIH_DUPLICADA', `O número ${numero} já foi usado`, HttpStatus.CONFLICT);
      const agora = new Date();
      const validade = input.validUntil ? new Date(`${input.validUntil}T12:00:00Z`) : validadeAih(agora);
      await tx.aihRequest.update({
        where: { id },
        data: { status: 'AUTORIZADA', aihNumber: numero, aihType: tipo, rangeId, authorizerId: ctx.session.userId, authorizedAt: agora, validUntil: validade, decisionNotes: input.notes?.trim() || null },
      });
      if (a.admissionId) await tx.admission.update({ where: { id: a.admissionId }, data: { aihNumber: numero } });
      await this.audit.record(ctx, tx, { action: 'aih.autorizar', entityType: 'AihRequest', entityId: id, payload: { aihNumber: numero, rangeId, admissionId: a.admissionId } });
      return numero;
    });
    this.realtime.emitToTenant(ctx.tenant.id, 'aih.atualizada', { id, status: 'AUTORIZADA', aihNumber: resultado });
    return this.detalhe(ctx, id);
  }

  async negar(ctx: RequestContext, id: string, reason: string) {
    const a = await this.carregar(ctx, id);
    if (a.status !== 'PENDENTE') throw new DomainError('SITUACAO_INVALIDA', `Laudo ${STATUS_AIH[a.status].toLowerCase()}`, HttpStatus.UNPROCESSABLE_ENTITY);
    await ctx.db.$transaction(async (tx) => {
      await tx.aihRequest.update({ where: { id }, data: { status: 'NEGADA', authorizerId: ctx.session.userId, authorizedAt: new Date(), decisionNotes: reason.trim() } });
      await this.audit.record(ctx, tx, { action: 'aih.negar', entityType: 'AihRequest', entityId: id, payload: { reason } });
    });
    this.realtime.emitToTenant(ctx.tenant.id, 'aih.atualizada', { id, status: 'NEGADA' });
    return this.detalhe(ctx, id);
  }

  async cancelar(ctx: RequestContext, id: string, reason: string) {
    const a = await this.carregar(ctx, id);
    if (a.status === 'CANCELADA') throw new DomainError('SITUACAO_INVALIDA', 'Laudo já cancelado', HttpStatus.UNPROCESSABLE_ENTITY);
    if (a.status === 'AUTORIZADA' && !roleHasPermission(ctx.session.role, 'aih.autorizar')) throw forbidden('AIH autorizada só pode ser cancelada pelo autorizador');
    await ctx.db.$transaction(async (tx) => {
      await tx.aihRequest.update({ where: { id }, data: { status: 'CANCELADA', decisionNotes: reason.trim() } });
      if (a.admissionId && a.status === 'AUTORIZADA') await tx.admission.update({ where: { id: a.admissionId }, data: { aihNumber: null } });
      await this.audit.record(ctx, tx, { action: 'aih.cancelar', entityType: 'AihRequest', entityId: id, payload: { reason, aihNumber: a.aihNumber } });
    });
    this.realtime.emitToTenant(ctx.tenant.id, 'aih.atualizada', { id, status: 'CANCELADA' });
    return this.detalhe(ctx, id);
  }

  /** Busca na SIGTAP para o laudo (código ou nome), sem exigir permissão de faturamento. */
  async buscarSigtap(ctx: RequestContext, q: string) {
    const termo = q.trim();
    if (termo.length < 3) return [];
    const digits = termo.replace(/\D/g, '');
    const rows = await ctx.db.sigtapProcedure.findMany({
      where: digits.length >= 4 ? { code: { startsWith: digits } } : { name: { contains: termo.toUpperCase() } },
      take: 20,
      orderBy: { code: 'asc' },
      select: { code: true, name: true },
    });
    return rows;
  }

  // ───────────────────────────── Faixas numéricas ─────────────────────────────

  async faixas(ctx: RequestContext) {
    const rows = await ctx.db.aihRange.findMany({ orderBy: [{ active: 'desc' }, { createdAt: 'desc' }] });
    const units = new Map((await ctx.db.unit.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      ...r,
      unitName: r.unitId ? (units.get(r.unitId) ?? null) : null,
      tipoLabel: TIPO_AIH[r.aihType] ?? r.aihType,
      usados: r.seqNext - r.seqStart,
      restantes: Math.max(0, r.seqEnd - r.seqNext + 1),
      exemplo: numeroAih(r.uf, r.year, r.aihType as '1' | '5', Math.min(r.seqNext, r.seqEnd)),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async criarFaixa(ctx: RequestContext, input: { name: string; unitId?: string | null; uf: string; year: number; aihType?: '1' | '5' | null; seqStart: number; seqEnd: number }) {
    if (input.seqEnd < input.seqStart) throw new DomainError('FAIXA_INVALIDA', 'O sequencial final deve ser maior ou igual ao inicial', HttpStatus.UNPROCESSABLE_ENTITY);
    numeroAih(input.uf, input.year, input.aihType ?? '1', input.seqStart);
    const r = await ctx.db.aihRange.create({
      data: { name: input.name.trim(), unitId: input.unitId ?? null, uf: input.uf.toUpperCase(), year: input.year, aihType: input.aihType ?? '1', seqStart: input.seqStart, seqEnd: input.seqEnd, seqNext: input.seqStart },
    });
    await this.audit.recordStandalone(ctx, { action: 'aih.faixa.criar', entityType: 'AihRange', entityId: r.id, payload: input });
    return (await this.faixas(ctx)).find((f) => f.id === r.id);
  }

  async atualizarFaixa(ctx: RequestContext, id: string, input: { name?: string | null; active?: boolean | null; seqEnd?: number | null }) {
    const r = await ctx.db.aihRange.findUnique({ where: { id } });
    if (!r) throw notFound('Faixa de AIH');
    if (input.seqEnd != null && input.seqEnd < r.seqNext - 1) throw new DomainError('FAIXA_INVALIDA', 'O sequencial final não pode ser menor que o último usado', HttpStatus.UNPROCESSABLE_ENTITY);
    await ctx.db.aihRange.update({
      where: { id },
      data: { ...(input.name ? { name: input.name.trim() } : {}), ...(input.active != null ? { active: input.active } : {}), ...(input.seqEnd != null ? { seqEnd: input.seqEnd } : {}) },
    });
    await this.audit.recordStandalone(ctx, { action: 'aih.faixa.atualizar', entityType: 'AihRange', entityId: id, payload: input });
    return (await this.faixas(ctx)).find((f) => f.id === id);
  }

  // ───────────────────────────── Consultas ─────────────────────────────

  private async nomes(ctx: RequestContext, rows: { unitId: string; requesterId: string; authorizerId: string | null }[]) {
    const [units, users] = await Promise.all([
      ctx.db.unit.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.unitId))] } }, select: { id: true, name: true, cnes: true } }),
      ctx.db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.requesterId, r.authorizerId]).filter((x): x is string => !!x))] } }, select: { id: true, name: true, socialName: true } }),
    ]);
    return { units: new Map(units.map((u) => [u.id, u])), users: new Map(users.map((u) => [u.id, u.socialName ?? u.name])) };
  }

  private view(a: Row, nomes: Awaited<ReturnType<AihService['nomes']>>) {
    const hoje = new Date();
    return {
      id: a.id,
      status: a.status,
      statusLabel: STATUS_AIH[a.status],
      patient: patientSummary(a.patient),
      unit: { id: a.unitId, name: nomes.units.get(a.unitId)?.name ?? null, cnes: nomes.units.get(a.unitId)?.cnes ?? null },
      requester: { id: a.requesterId, name: nomes.users.get(a.requesterId) ?? null, cbo: a.requesterCbo },
      admission: a.admission
        ? {
            id: a.admission.id,
            admittedAt: a.admission.admittedAt.toISOString(),
            dischargedAt: a.admission.dischargedAt?.toISOString() ?? null,
            bed: a.admission.bed ? `${a.admission.bed.ward.name} · ${a.admission.bed.code}` : null,
          }
        : null,
      bedRequest: a.bedRequest,
      procedureCode: a.procedureCode,
      procedureName: a.procedureName,
      mainCid: a.mainCid,
      secondaryCid: a.secondaryCid,
      associatedCid: a.associatedCid,
      specialtyCode: a.specialtyCode,
      specialtyLabel: ESPECIALIDADE_AIH[a.specialtyCode] ?? a.specialtyCode,
      nature: a.nature,
      natureLabel: CARATER_INTERNACAO[a.nature] ?? a.nature,
      symptoms: a.symptoms,
      conditions: a.conditions,
      diagnostics: a.diagnostics,
      notes: a.notes,
      aihNumber: a.aihNumber,
      aihType: a.aihType,
      aihTypeLabel: TIPO_AIH[a.aihType] ?? a.aihType,
      range: a.range,
      validUntil: a.validUntil ? a.validUntil.toISOString().slice(0, 10) : null,
      vencida: a.status === 'AUTORIZADA' && !!a.validUntil && !a.admissionId && a.validUntil.getTime() < hoje.getTime(),
      authorizer: a.authorizerId ? { id: a.authorizerId, name: nomes.users.get(a.authorizerId) ?? null } : null,
      authorizedAt: a.authorizedAt?.toISOString() ?? null,
      decisionNotes: a.decisionNotes,
      createdAt: a.createdAt.toISOString(),
    };
  }

  async detalhe(ctx: RequestContext, id: string) {
    const a = await ctx.db.aihRequest.findUnique({ where: { id }, include });
    if (!a) throw notFound('Laudo de AIH');
    return this.view(a, await this.nomes(ctx, [a]));
  }

  async listar(ctx: RequestContext, q: { status?: StatusAih; patientId?: string; unitId?: string; admissionId?: string; escopo?: 'unidade' | 'central' }) {
    const autoriza = roleHasPermission(ctx.session.role, 'aih.autorizar');
    const where: Prisma.AihRequestWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.admissionId ? { admissionId: q.admissionId } : {}),
      ...(q.patientId || q.admissionId || (autoriza && q.escopo !== 'unidade') ? {} : { unitId: q.unitId ?? ctx.session.unitId }),
    };
    const rows = await ctx.db.aihRequest.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: 300 });
    const nomes = await this.nomes(ctx, rows);
    return rows.map((a) => this.view(a, nomes));
  }

  async painel(ctx: RequestContext) {
    const desde = new Date(Date.now() - 30 * 86_400_000);
    const [porStatus, mes, faixas] = await Promise.all([
      ctx.db.aihRequest.groupBy({ by: ['status'], _count: { _all: true } }),
      ctx.db.aihRequest.count({ where: { status: 'AUTORIZADA', authorizedAt: { gte: desde } } }),
      ctx.db.aihRange.findMany({ where: { active: true }, select: { seqNext: true, seqEnd: true } }),
    ]);
    const contagem = Object.fromEntries(Object.keys(STATUS_AIH).map((k) => [k, 0])) as Record<StatusAih, number>;
    for (const p of porStatus) contagem[p.status] = p._count._all;
    return { porStatus: contagem, autorizadas30Dias: mes, numerosDisponiveis: faixas.reduce((s, f) => s + Math.max(0, f.seqEnd - f.seqNext + 1), 0) };
  }

  /** Laudo médico para solicitação/autorização de internação hospitalar (modelo do SIH/SUS). */
  async laudoPdf(ctx: RequestContext, id: string): Promise<{ data: Buffer; fileName: string }> {
    const a = await this.detalhe(ctx, id);
    const [unit, requester, assignment, signer, patient] = await Promise.all([
      ctx.db.unit.findUniqueOrThrow({ where: { id: a.unit.id } }),
      ctx.db.user.findUniqueOrThrow({ where: { id: a.requester.id }, select: { name: true, socialName: true } }),
      ctx.db.userAssignment.findFirst({ where: { userId: a.requester.id, unitId: a.unit.id }, select: { council: true, role: true } }),
      ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId }, select: { name: true, cpf: true } }),
      ctx.db.patient.findUniqueOrThrow({ where: { id: a.patient.id } }),
    ]);
    const model: DocumentModel = {
      title: 'Laudo para solicitação / autorização de internação hospitalar (AIH)',
      unit: { name: unit.name, cnes: unit.cnes, address: unit.address },
      patient: { name: patient.socialName ?? patient.name, cpf: patient.cpf, cns: patient.cns, birthDate: patient.birthDate },
      professional: { name: requester.socialName ?? requester.name, council: assignment?.council ?? null, cbo: a.requester.cbo, roleLabel: ROLE_LABELS[assignment?.role ?? 'MEDICO'] },
      issuedAt: new Date(),
      timeZone: ctx.tenant.timeZone,
      sections: [
        { heading: 'Identificação', paragraphs: [`Nome da mãe: ${patient.motherName ?? '—'}`, `Estabelecimento solicitante/executante: ${unit.name} · CNES ${unit.cnes}`] },
        { heading: 'Principais sinais e sintomas clínicos', paragraphs: [a.symptoms] },
        { heading: 'Condições que justificam a internação', paragraphs: [a.conditions] },
        { heading: 'Principais resultados de provas diagnósticas', paragraphs: [a.diagnostics] },
        {
          heading: 'Diagnóstico e procedimento',
          paragraphs: [
            `Diagnóstico inicial: CID-10 ${a.mainCid}${a.secondaryCid ? ` · secundário ${a.secondaryCid}` : ''}${a.associatedCid ? ` · causas associadas ${a.associatedCid}` : ''}`,
            `Procedimento solicitado: ${a.procedureCode} · ${a.procedureName}`,
            `Especialidade do leito: ${a.specialtyCode} · ${a.specialtyLabel} · Caráter: ${a.nature} · ${a.natureLabel}`,
            ...(a.notes ? [a.notes] : []),
          ],
        },
        {
          heading: 'Autorização',
          paragraphs:
            a.status === 'AUTORIZADA'
              ? [
                  `AIH nº ${a.aihNumber} (${a.aihTypeLabel}) · autorizada em ${formatDateTime(new Date(a.authorizedAt!), ctx.tenant.timeZone)}${a.authorizer?.name ? ` por ${a.authorizer.name}` : ''}${a.validUntil ? ` · válida até ${formatDate(new Date(`${a.validUntil}T12:00:00Z`), ctx.tenant.timeZone)}` : ''}`,
                  ...(a.decisionNotes ? [a.decisionNotes] : []),
                ]
              : a.status === 'NEGADA'
                ? [`Negada${a.authorizer?.name ? ` por ${a.authorizer.name}` : ''}: ${a.decisionNotes ?? ''}`]
                : ['Aguardando o autorizador.'],
        },
      ],
      footer: [`Laudo emitido em ${formatDateTime(new Date(), ctx.tenant.timeZone)} por ${signer.name} · ${a.statusLabel}`],
      signer: { name: signer.name, cpf: signer.cpf },
    };
    const data = await renderDocument(model);
    await this.audit.recordStandalone(ctx, { action: 'aih.laudo_pdf', entityType: 'AihRequest', entityId: id, payload: { aihNumber: a.aihNumber } });
    return { data, fileName: `aih-laudo-${a.aihNumber ?? a.id.slice(0, 8)}.pdf` };
  }
}
