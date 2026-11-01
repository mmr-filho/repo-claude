import { HttpStatus, Injectable } from '@nestjs/common';
import {
  numeroProcessoTfd,
  ROLE_LABELS,
  STATUS_TFD,
  STATUS_TFD_ABERTOS,
  TIPO_AJUDA_CUSTO,
  TIPO_VEICULO,
  totalAjudaCusto,
  TRANSPORTE_TFD,
  zonedParts,
  type AjudaCustoItem,
  type StatusTfd,
  type TransporteTfd,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, forbidden, notFound } from '../../core/errors';
import { anoDoProtocolo, gravarComProtocolo } from '../../core/protocolo';
import { RealtimeService } from '../../core/realtime.service';
import { patientSummary } from '../patients/patients.service';
import { formatDate, formatDateTime, maskCpf, renderDocument, type DocumentModel } from '../signatures/pdf';
import { MessagingService } from '../integrations/messaging.service';
import { TransportService } from '../transport/transport.service';

export interface LaudoInput {
  patientId: string;
  requestId?: string | null;
  cid?: string | null;
  diagnosis: string;
  procedureName: string;
  procedureCode?: string | null;
  clinicalSummary: string;
  justification: string;
  urgency?: boolean;
  destinationCity: string;
  destinationUf: string;
  destinationIbge?: string | null;
  destinationUnit?: string | null;
  transport: TransporteTfd;
  needsCompanion?: boolean;
  companionName?: string | null;
  companionCpf?: string | null;
  companionRelation?: string | null;
  accommodation?: boolean;
}

const include = { patient: { select: { id: true, name: true, socialName: true, cns: true, cpf: true, birthDate: true, sex: true, motherName: true, phone: true } }, events: { orderBy: { at: 'asc' as const } } };

/** TFD: laudo, processo com protocolo, envio à regional, parecer, agendamento, ajuda de custo, viagem e impressão. */
@Injectable()
export class TfdService {
  constructor(
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly transport: TransportService,
    private readonly messaging: MessagingService,
  ) {}

  /** Devolutiva ao cidadão por WhatsApp (mesmo modelo aprovado da regulação); acessória, nunca bloqueia a decisão. */
  private async avisarCidadao(ctx: RequestContext, p: { id: string; patientId: string; protocol: string; procedureName: string }, status: 'AUTORIZADA' | 'NEGADA' | 'AGENDADA' | 'CANCELADA', detail: string | null) {
    try {
      await this.messaging.scheduleRegulationUpdate(
        { tenant: ctx.tenant, db: ctx.db },
        { patientId: p.patientId, refId: p.id, protocol: p.protocol, procedureName: `TFD · ${p.procedureName.toLowerCase()}`, status, detail },
      );
    } catch {
      // Sem WhatsApp configurado a decisão fica registrada mesmo assim.
    }
  }

  private laudoData(input: LaudoInput) {
    if (input.needsCompanion && !input.companionName?.trim()) throw new DomainError('ACOMPANHANTE_SEM_NOME', 'Informe o nome do acompanhante', HttpStatus.UNPROCESSABLE_ENTITY);
    return {
      cid: input.cid?.toUpperCase().replace('.', '') || null,
      diagnosis: input.diagnosis.trim(),
      procedureName: input.procedureName.trim(),
      procedureCode: input.procedureCode?.replace(/\D/g, '') || null,
      clinicalSummary: input.clinicalSummary.trim(),
      justification: input.justification.trim(),
      urgency: input.urgency ?? false,
      destinationCity: input.destinationCity.trim(),
      destinationUf: input.destinationUf.toUpperCase(),
      destinationIbge: input.destinationIbge?.replace(/\D/g, '') || null,
      destinationUnit: input.destinationUnit?.trim() || null,
      transport: input.transport,
      needsCompanion: input.needsCompanion ?? false,
      companionName: input.needsCompanion ? input.companionName?.trim() || null : null,
      companionCpf: input.needsCompanion ? input.companionCpf?.replace(/\D/g, '') || null : null,
      companionRelation: input.needsCompanion ? input.companionRelation?.trim() || null : null,
      accommodation: input.accommodation ?? false,
    };
  }

  private async proximoProtocolo(ctx: RequestContext, ano: number, salto = 0) {
    const total = await ctx.db.tfdProcess.count({ where: { protocol: { startsWith: `TFD-${ano}-` } } });
    for (let i = 1 + salto; i <= 50 + salto; i++) {
      const candidato = numeroProcessoTfd(ano, total + i);
      if (!(await ctx.db.tfdProcess.findUnique({ where: { protocol: candidato }, select: { id: true } }))) return candidato;
    }
    throw new DomainError('PROTOCOLO_INDISPONIVEL', 'Não foi possível gerar o número do processo');
  }

  async abrir(ctx: RequestContext, input: LaudoInput) {
    const patient = await ctx.db.patient.findUnique({ where: { id: input.patientId }, select: { id: true, mergedIntoId: true } });
    if (!patient || patient.mergedIntoId) throw notFound('Paciente');
    if (input.requestId) {
      const r = await ctx.db.regulationRequest.findUnique({ where: { id: input.requestId }, select: { patientId: true } });
      if (!r || r.patientId !== input.patientId) throw notFound('Solicitação de regulação');
    }
    const aberto = await ctx.db.tfdProcess.findFirst({ where: { patientId: input.patientId, status: { in: STATUS_TFD_ABERTOS } }, select: { protocol: true } });
    if (aberto) throw new DomainError('TFD_ABERTO', `Esta pessoa já tem um processo de TFD em andamento (${aberto.protocol})`, HttpStatus.CONFLICT);
    const gravar = (protocol: string) =>
      ctx.db.$transaction(async (tx) => {
        const created = await tx.tfdProcess.create({
          data: {
            ...this.laudoData(input),
            protocol,
            patientId: input.patientId,
            requestId: input.requestId ?? null,
            unitId: ctx.session.unitId,
            requesterId: ctx.session.userId,
            requesterCbo: ctx.cbo,
            events: { create: { kind: 'ABERTO', toStatus: 'ABERTO', userId: ctx.session.userId, role: ctx.session.role } },
          },
        });
        await this.audit.record(ctx, tx, {
          action: 'tfd.abrir',
          entityType: 'TfdProcess',
          entityId: created.id,
          payload: { protocol, patientId: input.patientId, destino: `${input.destinationCity}/${input.destinationUf}` },
        });
        return created;
      });
    // Dois pedidos ao mesmo tempo podem disputar o mesmo número: tenta o seguinte quando o índice único recusa.
    const ano = anoDoProtocolo(ctx.tenant.timeZone);
    const p = await gravarComProtocolo((salto) => this.proximoProtocolo(ctx, ano, salto), gravar, {
      mensagem: 'Não foi possível gerar o número do processo; tente de novo',
    });
    return this.detalhe(ctx, p.id);
  }

  async atualizarLaudo(ctx: RequestContext, id: string, input: LaudoInput) {
    const p = await this.carregar(ctx, id);
    if (p.status !== 'ABERTO' && p.status !== 'INDEFERIDO') throw new DomainError('SITUACAO_INVALIDA', 'O laudo só pode ser alterado antes do envio', HttpStatus.UNPROCESSABLE_ENTITY);
    await ctx.db.$transaction(async (tx) => {
      await tx.tfdProcess.update({ where: { id }, data: { ...this.laudoData(input), status: 'ABERTO', closedAt: null } });
      await tx.tfdEvent.create({ data: { processId: id, kind: 'LAUDO_ATUALIZADO', fromStatus: p.status, toStatus: 'ABERTO', userId: ctx.session.userId, role: ctx.session.role } });
      await this.audit.record(ctx, tx, { action: 'tfd.laudo', entityType: 'TfdProcess', entityId: id, payload: { protocol: p.protocol } });
    });
    return this.detalhe(ctx, id);
  }

  private async carregar(ctx: RequestContext, id: string) {
    const p = await ctx.db.tfdProcess.findUnique({ where: { id } });
    if (!p) throw notFound('Processo de TFD');
    return p;
  }

  private exigir(p: { status: StatusTfd }, permitidos: StatusTfd[], acao: string) {
    if (!permitidos.includes(p.status)) throw new DomainError('SITUACAO_INVALIDA', `Não é possível ${acao} um processo ${STATUS_TFD[p.status].toLowerCase()}`, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private async transicao(ctx: RequestContext, id: string, to: StatusTfd, kind: string, data: Record<string, unknown>, notes: string | null, audit: string) {
    const p = await this.carregar(ctx, id);
    await ctx.db.$transaction(async (tx) => {
      await tx.tfdProcess.update({ where: { id }, data: { status: to, ...data } });
      await tx.tfdEvent.create({ data: { processId: id, kind, fromStatus: p.status, toStatus: to, userId: ctx.session.userId, role: ctx.session.role, notes } });
      await this.audit.record(ctx, tx, { action: audit, entityType: 'TfdProcess', entityId: id, payload: { protocol: p.protocol, from: p.status, to, notes } });
    });
    this.realtime.emitToUnit(ctx.tenant.id, p.unitId, 'tfd.atualizado', { id, protocol: p.protocol, status: to });
    return p;
  }

  async enviar(ctx: RequestContext, id: string, notes?: string | null) {
    const p = await this.carregar(ctx, id);
    this.exigir(p, ['ABERTO'], 'enviar');
    await this.transicao(ctx, id, 'ENVIADO', 'ENVIADO', { sentAt: new Date() }, notes?.trim() || 'Processo enviado à regional / estado', 'tfd.enviar');
    return this.detalhe(ctx, id);
  }

  /** Parecer da regional/estado registrado por quem acompanha o processo. */
  async parecer(ctx: RequestContext, id: string, input: { deferido: boolean; notes: string; allowanceApproved?: boolean; transport?: TransporteTfd | null }) {
    const p = await this.carregar(ctx, id);
    this.exigir(p, ['ENVIADO'], 'registrar parecer em');
    const to: StatusTfd = input.deferido ? 'DEFERIDO' : 'INDEFERIDO';
    await this.transicao(
      ctx,
      id,
      to,
      to,
      {
        opinionAt: new Date(),
        opinionBy: ctx.session.userId,
        opinionNotes: input.notes.trim(),
        allowanceApproved: input.deferido ? (input.allowanceApproved ?? p.allowanceApproved) : false,
        ...(input.transport ? { transport: input.transport } : {}),
        ...(input.deferido ? {} : { closedAt: new Date() }),
      },
      input.notes.trim(),
      'tfd.parecer',
    );
    await this.avisarCidadao(ctx, p, input.deferido ? 'AUTORIZADA' : 'NEGADA', input.deferido ? `Destino: ${p.destinationCity}/${p.destinationUf}. A unidade avisará a data do atendimento.` : input.notes.trim());
    return this.detalhe(ctx, id);
  }

  async agendar(ctx: RequestContext, id: string, input: { appointmentAt: string; appointmentPlace: string; notes?: string | null }) {
    const p = await this.carregar(ctx, id);
    this.exigir(p, ['DEFERIDO', 'AGENDADO'], 'agendar');
    const quando = new Date(input.appointmentAt);
    await this.transicao(
      ctx,
      id,
      'AGENDADO',
      'AGENDADO',
      { appointmentAt: quando, appointmentPlace: input.appointmentPlace.trim(), appointmentNotes: input.notes?.trim() || null },
      `${this.quando(quando, ctx)} · ${input.appointmentPlace.trim()}${input.notes ? ` · ${input.notes.trim()}` : ''}`,
      'tfd.agendar',
    );
    await this.avisarCidadao(ctx, p, 'AGENDADA', `${this.quando(quando, ctx)} em ${input.appointmentPlace.trim()}, ${p.destinationCity}/${p.destinationUf}${input.notes ? `. ${input.notes.trim()}` : ''}`);
    return this.detalhe(ctx, id);
  }

  async ajudaCusto(ctx: RequestContext, id: string, itens: AjudaCustoItem[]) {
    const p = await this.carregar(ctx, id);
    this.exigir(p, ['DEFERIDO', 'AGENDADO'], 'lançar ajuda de custo em');
    if (!p.allowanceApproved) throw new DomainError('AJUDA_NAO_APROVADA', 'A ajuda de custo não foi aprovada no parecer', HttpStatus.UNPROCESSABLE_ENTITY);
    if (itens.some((i) => i.beneficiario === 'ACOMPANHANTE') && !p.needsCompanion) throw new DomainError('SEM_ACOMPANHANTE', 'O processo não prevê acompanhante', HttpStatus.UNPROCESSABLE_ENTITY);
    const { total } = totalAjudaCusto(itens);
    await ctx.db.$transaction(async (tx) => {
      await tx.tfdProcess.update({ where: { id }, data: { allowance: itens as object[], allowanceTotal: total, allowancePaidAt: null } });
      await tx.tfdEvent.create({ data: { processId: id, kind: 'AJUDA_CUSTO', userId: ctx.session.userId, role: ctx.session.role, notes: `${itens.length} item(ns), total R$ ${total.toFixed(2)}` } });
      await this.audit.record(ctx, tx, { action: 'tfd.ajuda_custo', entityType: 'TfdProcess', entityId: id, payload: { protocol: p.protocol, itens, total } });
    });
    return this.detalhe(ctx, id);
  }

  async pagarAjuda(ctx: RequestContext, id: string) {
    const p = await this.carregar(ctx, id);
    if (Number(p.allowanceTotal) <= 0) throw new DomainError('SEM_AJUDA', 'Não há ajuda de custo lançada', HttpStatus.UNPROCESSABLE_ENTITY);
    await ctx.db.$transaction(async (tx) => {
      await tx.tfdProcess.update({ where: { id }, data: { allowancePaidAt: new Date() } });
      await tx.tfdEvent.create({ data: { processId: id, kind: 'AJUDA_PAGA', userId: ctx.session.userId, role: ctx.session.role, notes: `R$ ${Number(p.allowanceTotal).toFixed(2)}` } });
      await this.audit.record(ctx, tx, { action: 'tfd.ajuda_paga', entityType: 'TfdProcess', entityId: id, payload: { protocol: p.protocol, total: Number(p.allowanceTotal) } });
    });
    return this.detalhe(ctx, id);
  }

  /** Reserva o lugar na viagem do transporte sanitário (paciente e, se houver, acompanhante). */
  async vincularViagem(ctx: RequestContext, id: string, input: { tripId: string; pickupAddress?: string | null; wheelchair?: boolean }) {
    const p = await this.carregar(ctx, id);
    this.exigir(p, ['DEFERIDO', 'AGENDADO'], 'reservar transporte em');
    if (p.tripId) throw new DomainError('VIAGEM_JA_VINCULADA', 'O processo já tem viagem reservada; cancele a anterior antes', HttpStatus.UNPROCESSABLE_ENTITY);
    const { viagem } = await this.transport.adicionarPassageiro(ctx, input.tripId, {
      patientId: p.patientId,
      companionName: p.needsCompanion ? p.companionName : null,
      pickupAddress: input.pickupAddress,
      appointmentAt: p.appointmentAt?.toISOString() ?? null,
      appointmentPlace: p.appointmentPlace,
      wheelchair: input.wheelchair ?? false,
      tfdId: id,
    });
    await ctx.db.$transaction(async (tx) => {
      await tx.tfdProcess.update({ where: { id }, data: { tripId: input.tripId, transport: 'VEICULO_SANITARIO' } });
      await tx.tfdEvent.create({
        data: {
          processId: id,
          kind: 'VIAGEM',
          userId: ctx.session.userId,
          role: ctx.session.role,
          notes: `${viagem.date.split('-').reverse().join('/')} ${viagem.departureTime} · ${viagem.vehicle.plate} · ${viagem.destinationCity}/${viagem.destinationUf}`,
        },
      });
      await this.audit.record(ctx, tx, { action: 'tfd.viagem', entityType: 'TfdProcess', entityId: id, payload: { protocol: p.protocol, tripId: input.tripId } });
    });
    return this.detalhe(ctx, id);
  }

  async desvincularViagem(ctx: RequestContext, id: string) {
    const p = await this.carregar(ctx, id);
    if (!p.tripId) throw new DomainError('SEM_VIAGEM', 'O processo não tem viagem reservada', HttpStatus.UNPROCESSABLE_ENTITY);
    const passageiro = await ctx.db.transportPassenger.findFirst({ where: { tripId: p.tripId, tfdId: id, status: { in: ['AGENDADO', 'EMBARCOU'] } } });
    if (passageiro) await this.transport.statusPassageiro(ctx, passageiro.id, 'CANCELADO', 'Reserva cancelada pelo TFD');
    await ctx.db.$transaction(async (tx) => {
      await tx.tfdProcess.update({ where: { id }, data: { tripId: null } });
      await tx.tfdEvent.create({ data: { processId: id, kind: 'VIAGEM_CANCELADA', userId: ctx.session.userId, role: ctx.session.role } });
      await this.audit.record(ctx, tx, { action: 'tfd.viagem_cancelar', entityType: 'TfdProcess', entityId: id, payload: { protocol: p.protocol } });
    });
    return this.detalhe(ctx, id);
  }

  async concluir(ctx: RequestContext, id: string, notes?: string | null) {
    const p = await this.carregar(ctx, id);
    this.exigir(p, ['DEFERIDO', 'AGENDADO'], 'concluir');
    await this.transicao(ctx, id, 'CONCLUIDO', 'CONCLUIDO', { closedAt: new Date() }, notes?.trim() || null, 'tfd.concluir');
    return this.detalhe(ctx, id);
  }

  async cancelar(ctx: RequestContext, id: string, reason: string) {
    const p = await this.carregar(ctx, id);
    this.exigir(p, STATUS_TFD_ABERTOS, 'cancelar');
    if (p.tripId) await this.desvincularViagem(ctx, id).catch(() => undefined);
    await this.transicao(ctx, id, 'CANCELADO', 'CANCELADO', { closedAt: new Date() }, reason.trim(), 'tfd.cancelar');
    await this.avisarCidadao(ctx, p, 'CANCELADA', reason.trim());
    return this.detalhe(ctx, id);
  }

  async mensagem(ctx: RequestContext, id: string, notes: string) {
    const p = await this.carregar(ctx, id);
    await ctx.db.tfdEvent.create({ data: { processId: id, kind: 'MENSAGEM', userId: ctx.session.userId, role: ctx.session.role, notes: notes.trim() } });
    await this.audit.recordStandalone(ctx, { action: 'tfd.mensagem', entityType: 'TfdProcess', entityId: id, payload: { protocol: p.protocol } });
    return this.detalhe(ctx, id);
  }

  // ─── Consulta ─────────────────────────────────────────────────────────────────

  async listar(ctx: RequestContext, q: { status?: StatusTfd; patientId?: string; unitId?: string; escopo?: 'unidade' | 'central' }) {
    const where = { ...(q.status ? { status: q.status } : {}), ...(q.patientId ? { patientId: q.patientId } : {}), ...(q.patientId || q.escopo === 'central' ? {} : { unitId: q.unitId ?? ctx.session.unitId }) };
    const rows = await ctx.db.tfdProcess.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: 500 });
    const nomes = await this.nomes(ctx, rows);
    return rows.map((p) => this.view(p, nomes));
  }

  async painel(ctx: RequestContext) {
    const g = await ctx.db.tfdProcess.groupBy({ by: ['status'], _count: { _all: true } });
    const porStatus = Object.fromEntries(Object.keys(STATUS_TFD).map((s) => [s, g.find((x) => x.status === s)?._count._all ?? 0])) as Record<StatusTfd, number>;
    const ajuda = await ctx.db.tfdProcess.aggregate({ _sum: { allowanceTotal: true }, where: { status: { in: ['DEFERIDO', 'AGENDADO', 'CONCLUIDO'] }, createdAt: { gte: new Date(Date.now() - 365 * 86_400_000) } } });
    return { porStatus, abertos: STATUS_TFD_ABERTOS.reduce((s, k) => s + porStatus[k], 0), ajudaCustoAno: Number(ajuda._sum.allowanceTotal ?? 0) };
  }

  async detalhe(ctx: RequestContext, id: string) {
    const p = await ctx.db.tfdProcess.findUnique({ where: { id }, include });
    if (!p) throw notFound('Processo de TFD');
    const nomes = await this.nomes(
      ctx,
      [p],
      p.events.map((e) => e.userId),
    );
    const viagem = p.tripId ? await this.transport.viagem(ctx, p.tripId).catch(() => null) : null;
    const request = p.requestId ? await ctx.db.regulationRequest.findUnique({ where: { id: p.requestId }, select: { id: true, protocol: true, procedureName: true, status: true } }) : null;
    await this.audit.recordStandalone(ctx, { action: 'tfd.visualizar', entityType: 'TfdProcess', entityId: id, payload: { protocol: p.protocol } });
    return {
      ...this.view(p, nomes),
      eventos: p.events.map((e) => ({ id: e.id, kind: e.kind, fromStatus: e.fromStatus, toStatus: e.toStatus, notes: e.notes, at: e.at.toISOString(), usuario: nomes.users.get(e.userId) ?? null, role: e.role })),
      viagem: viagem
        ? {
            id: viagem.id,
            date: viagem.date,
            departureTime: viagem.departureTime,
            destinationCity: viagem.destinationCity,
            destinationUf: viagem.destinationUf,
            destinationPlace: viagem.destinationPlace,
            status: viagem.status,
            statusLabel: viagem.statusLabel,
            vehicle: viagem.vehicle,
            driver: viagem.driver,
            passageiro: viagem.passageiros.find((x) => x.tfdId === id) ?? null,
          }
        : null,
      solicitacao: request,
    };
  }

  private async nomes(ctx: RequestContext, rows: { requesterId: string; opinionBy: string | null; unitId: string }[], extra: string[] = []) {
    const userIds = new Set<string>(extra);
    const unitIds = new Set<string>();
    for (const r of rows) {
      userIds.add(r.requesterId);
      if (r.opinionBy) userIds.add(r.opinionBy);
      unitIds.add(r.unitId);
    }
    const [users, units] = await Promise.all([
      ctx.db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }),
      ctx.db.unit.findMany({ where: { id: { in: [...unitIds] } }, select: { id: true, name: true } }),
    ]);
    return { users: new Map(users.map((u) => [u.id, u.name])), units: new Map(units.map((u) => [u.id, u.name])) };
  }

  private view(
    p: {
      id: string;
      protocol: string;
      patientId: string;
      requestId: string | null;
      unitId: string;
      requesterId: string;
      requesterCbo: string;
      cid: string | null;
      diagnosis: string;
      procedureName: string;
      procedureCode: string | null;
      clinicalSummary: string;
      justification: string;
      urgency: boolean;
      destinationCity: string;
      destinationUf: string;
      destinationIbge: string | null;
      destinationUnit: string | null;
      transport: string;
      needsCompanion: boolean;
      companionName: string | null;
      companionCpf: string | null;
      companionRelation: string | null;
      accommodation: boolean;
      status: StatusTfd;
      sentAt: Date | null;
      opinionAt: Date | null;
      opinionBy: string | null;
      opinionNotes: string | null;
      allowanceApproved: boolean;
      appointmentAt: Date | null;
      appointmentPlace: string | null;
      appointmentNotes: string | null;
      allowance: unknown;
      allowanceTotal: unknown;
      allowancePaidAt: Date | null;
      tripId: string | null;
      closedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
      patient: Parameters<typeof patientSummary>[0] & { phone: string | null };
    },
    nomes: { users: Map<string, string>; units: Map<string, string> },
  ) {
    const itens = (Array.isArray(p.allowance) ? p.allowance : []) as AjudaCustoItem[];
    return {
      id: p.id,
      protocol: p.protocol,
      status: p.status,
      statusLabel: STATUS_TFD[p.status],
      patient: { ...patientSummary(p.patient), phone: p.patient.phone },
      requestId: p.requestId,
      unit: { id: p.unitId, name: nomes.units.get(p.unitId) ?? null },
      requester: { id: p.requesterId, name: nomes.users.get(p.requesterId) ?? null, cbo: p.requesterCbo },
      cid: p.cid,
      diagnosis: p.diagnosis,
      procedureName: p.procedureName,
      procedureCode: p.procedureCode,
      clinicalSummary: p.clinicalSummary,
      justification: p.justification,
      urgency: p.urgency,
      destination: { city: p.destinationCity, uf: p.destinationUf, ibge: p.destinationIbge, unit: p.destinationUnit },
      transport: p.transport,
      transportLabel: TRANSPORTE_TFD[p.transport as TransporteTfd] ?? p.transport,
      companion: p.needsCompanion ? { name: p.companionName, cpf: p.companionCpf, relation: p.companionRelation } : null,
      accommodation: p.accommodation,
      sentAt: p.sentAt?.toISOString() ?? null,
      opinion: p.opinionAt ? { at: p.opinionAt.toISOString(), by: p.opinionBy ? (nomes.users.get(p.opinionBy) ?? null) : null, notes: p.opinionNotes, allowanceApproved: p.allowanceApproved } : null,
      appointment: p.appointmentAt ? { at: p.appointmentAt.toISOString(), place: p.appointmentPlace, notes: p.appointmentNotes } : null,
      allowance: {
        itens: itens.map((i) => ({ ...i, tipoLabel: TIPO_AJUDA_CUSTO[i.tipo] ?? i.tipo, total: Math.round(i.quantidade * i.valorUnitario * 100) / 100 })),
        total: Number(p.allowanceTotal),
        paidAt: p.allowancePaidAt?.toISOString() ?? null,
        approved: p.allowanceApproved,
      },
      tripId: p.tripId,
      closedAt: p.closedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  private quando(d: Date, ctx: RequestContext) {
    const z = zonedParts(d, ctx.tenant.timeZone);
    return `${String(z.day).padStart(2, '0')}/${String(z.month).padStart(2, '0')}/${z.year} às ${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
  }

  // ─── Impressão ────────────────────────────────────────────────────────────────

  private async modelo(ctx: RequestContext, id: string, titulo: string): Promise<{ model: DocumentModel; p: Awaited<ReturnType<TfdService['detalhe']>> }> {
    const p = await this.detalhe(ctx, id);
    const [unit, requester, assignment, signer] = await Promise.all([
      ctx.db.unit.findUniqueOrThrow({ where: { id: p.unit.id } }),
      ctx.db.user.findUniqueOrThrow({ where: { id: p.requester.id }, select: { name: true, socialName: true, cpf: true } }),
      ctx.db.userAssignment.findFirst({ where: { userId: p.requester.id, unitId: p.unit.id }, select: { council: true, role: true } }),
      ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId }, select: { name: true, cpf: true } }),
    ]);
    const patient = await ctx.db.patient.findUniqueOrThrow({ where: { id: p.patient.id } });
    const model: DocumentModel = {
      title: titulo,
      unit: { name: unit.name, cnes: unit.cnes, address: unit.address },
      patient: { name: patient.socialName ?? patient.name, cpf: patient.cpf, cns: patient.cns, birthDate: patient.birthDate },
      professional: { name: requester.socialName ?? requester.name, council: assignment?.council ?? null, cbo: p.requester.cbo, roleLabel: ROLE_LABELS[assignment?.role ?? 'MEDICO'] },
      issuedAt: new Date(),
      timeZone: ctx.tenant.timeZone,
      sections: [],
      footer: [`Processo ${p.protocol} · ${STATUS_TFD[p.status]} · emitido em ${formatDateTime(new Date(), ctx.tenant.timeZone)} por ${signer.name}`],
      signer: { name: signer.name, cpf: signer.cpf },
    };
    return { model, p };
  }

  /** Laudo médico para TFD (anexo da Portaria SAS/MS 55/1999). */
  async laudoPdf(ctx: RequestContext, id: string): Promise<{ data: Buffer; fileName: string }> {
    const { model, p } = await this.modelo(ctx, id, 'Laudo médico para Tratamento Fora do Domicílio (TFD)');
    model.sections = [
      { heading: 'Destino', paragraphs: [`${p.destination.city}/${p.destination.uf}${p.destination.unit ? ` · ${p.destination.unit}` : ''}${p.destination.ibge ? ` · IBGE ${p.destination.ibge}` : ''}`] },
      { heading: 'Diagnóstico', paragraphs: [`${p.diagnosis}${p.cid ? ` (CID-10 ${p.cid})` : ''}`, p.clinicalSummary] },
      { heading: 'Procedimento solicitado', paragraphs: [`${p.procedureName}${p.procedureCode ? ` · SIGTAP ${p.procedureCode}` : ''}${p.urgency ? ' · caráter de urgência' : ''}`] },
      { heading: 'Justificativa (indisponibilidade no município)', paragraphs: [p.justification] },
      {
        heading: 'Transporte e acompanhante',
        paragraphs: [
          `Transporte: ${p.transportLabel}${p.accommodation ? ' · necessita pernoite' : ''}`,
          p.companion ? `Acompanhante: ${p.companion.name ?? ''}${p.companion.cpf ? ` (CPF ${maskCpf(p.companion.cpf)})` : ''}${p.companion.relation ? ` · ${p.companion.relation}` : ''}` : 'Sem acompanhante',
        ],
      },
      {
        heading: 'Parecer',
        paragraphs: p.opinion
          ? [
              `${p.status === 'INDEFERIDO' ? 'Indeferido' : 'Deferido'} em ${formatDate(new Date(p.opinion.at), ctx.tenant.timeZone)}${p.opinion.by ? ` por ${p.opinion.by}` : ''}: ${p.opinion.notes ?? ''}`,
              `Ajuda de custo: ${p.opinion.allowanceApproved ? 'aprovada' : 'não aprovada'}`,
            ]
          : ['Aguardando parecer da regional / estado.'],
      },
    ];
    const data = await renderDocument(model, { reason: 'Laudo de TFD', location: model.unit.name, contactInfo: ctx.tenant.name });
    await this.audit.recordStandalone(ctx, { action: 'tfd.laudo_pdf', entityType: 'TfdProcess', entityId: id, payload: { protocol: p.protocol } });
    return { data, fileName: `tfd-laudo-${p.protocol}.pdf` };
  }

  /** Guia de viagem e ajuda de custo: data, local, transporte, acompanhante e valores. */
  async guiaPdf(ctx: RequestContext, id: string): Promise<{ data: Buffer; fileName: string }> {
    const { model, p } = await this.modelo(ctx, id, 'Guia de viagem e ajuda de custo (TFD)');
    const linhas = p.allowance.itens.map(
      (i) => `${i.tipoLabel} · ${i.beneficiario === 'PACIENTE' ? 'paciente' : 'acompanhante'} · ${i.quantidade} × R$ ${i.valorUnitario.toFixed(2)} = R$ ${i.total.toFixed(2)}${i.descricao ? ` (${i.descricao})` : ''}`,
    );
    model.sections = [
      {
        heading: 'Atendimento no destino',
        paragraphs: [
          p.appointment ? `${this.quando(new Date(p.appointment.at), ctx)} · ${p.appointment.place ?? ''}${p.appointment.notes ? ` · ${p.appointment.notes}` : ''}` : 'Ainda sem data agendada',
          `${p.destination.city}/${p.destination.uf}${p.destination.unit ? ` · ${p.destination.unit}` : ''}`,
          `Procedimento: ${p.procedureName}`,
        ],
      },
      {
        heading: 'Transporte',
        paragraphs: p.viagem
          ? [
              `${p.viagem.date.split('-').reverse().join('/')} às ${p.viagem.departureTime} · ${p.viagem.vehicle.model} (${p.viagem.vehicle.plate}, ${TIPO_VEICULO[p.viagem.vehicle.kind].label}) · motorista ${p.viagem.driver.name}${p.viagem.driver.phone ? ` (${p.viagem.driver.phone})` : ''}`,
              p.viagem.passageiro?.pickupAddress ? `Embarque: ${p.viagem.passageiro.pickupAddress}` : '',
            ].filter(Boolean)
          : [p.transportLabel],
      },
      {
        heading: 'Acompanhante',
        paragraphs: [p.companion ? `${p.companion.name ?? ''}${p.companion.cpf ? ` · CPF ${maskCpf(p.companion.cpf)}` : ''}${p.companion.relation ? ` · ${p.companion.relation}` : ''}` : 'Sem acompanhante'],
      },
      {
        heading: `Ajuda de custo${p.allowance.approved ? '' : ' (não aprovada)'}`,
        paragraphs: linhas.length
          ? [...linhas, `Total: R$ ${p.allowance.total.toFixed(2)}${p.allowance.paidAt ? ` · paga em ${formatDate(new Date(p.allowance.paidAt), ctx.tenant.timeZone)}` : ' · a pagar'}`]
          : ['Sem ajuda de custo lançada.'],
      },
      {
        heading: 'Declaração',
        paragraphs: ['Declaro ter recebido as orientações sobre a viagem, o atendimento e a ajuda de custo acima.', 'Assinatura do paciente ou responsável: ______________________________    Data: ____/____/______'],
      },
    ];
    const data = await renderDocument(model, { reason: 'Guia de viagem de TFD', location: model.unit.name, contactInfo: ctx.tenant.name });
    await this.audit.recordStandalone(ctx, { action: 'tfd.guia_pdf', entityType: 'TfdProcess', entityId: id, payload: { protocol: p.protocol } });
    return { data, fileName: `tfd-guia-${p.protocol}.pdf` };
  }

  /** Quem gere o TFD edita processos de qualquer unidade; quem só lê vê os da sua unidade ou dos seus pacientes. */
  exigirAcesso(ctx: RequestContext, p: { unitId: string }, gere: boolean) {
    if (!gere && p.unitId !== ctx.session.unitId) throw forbidden('Processo de outra unidade');
  }
}
