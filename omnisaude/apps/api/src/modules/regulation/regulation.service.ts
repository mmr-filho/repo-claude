import { HttpStatus, Injectable } from '@nestjs/common';
import {
  criteriosDe,
  diasEmFila,
  ESPECIALIDADE_POR_CODIGO,
  ESPECIALIDADES,
  numeroProtocolo,
  ordenarFila,
  prazoMeta,
  PRIORIDADES,
  PROCEDIMENTO_POR_CODIGO,
  PROCEDIMENTOS_REGULADOS,
  roleHasPermission,
  STATUS_NA_FILA,
  STATUS_SOLICITACAO,
  verificarProtocolo,
  type ExameDisponivel,
  type PrioridadeRegulacao,
  type StatusSolicitacao,
  type TipoSolicitacao,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { conflict, DomainError, forbidden, notFound } from '../../core/errors';
import { RealtimeService } from '../../core/realtime.service';
import { MessagingService } from '../integrations/messaging.service';
import { patientSummary } from '../patients/patients.service';

const DIA = 86_400_000;

export interface SolicitarInput {
  patientId: string;
  encounterId?: string | null;
  kind: TipoSolicitacao;
  specialty: string;
  priority: PrioridadeRegulacao;
  priorityJustification?: string | null;
  clinicalSummary: string;
  criteria: string[];
  cid?: string | null;
  attachmentIds?: string[];
}

export interface ComplementarInput {
  notes: string;
  priority?: PrioridadeRegulacao;
  priorityJustification?: string | null;
  clinicalSummary?: string;
  criteria?: string[];
  attachmentIds?: string[];
}

export interface FiltroSolicitacoes {
  status?: StatusSolicitacao;
  unitId?: string;
  patientId?: string;
  encounterId?: string;
  specialty?: string;
  priority?: PrioridadeRegulacao;
  kind?: TipoSolicitacao;
  /** 'central' lista todas as unidades (quem regula); o padrão é a unidade do contexto. */
  escopo?: 'unidade' | 'central';
}

const ABERTAS: StatusSolicitacao[] = ['PENDENTE', 'EM_ANALISE', 'DEVOLVIDA', 'AUTORIZADA', 'AGENDADA'];

const requestInclude = {
  patient: { select: { id: true, name: true, socialName: true, cns: true, cpf: true, birthDate: true, sex: true, motherName: true, phone: true, whatsappOptIn: true } },
} as const;

/**
 * Regulação ambulatorial: solicitações de consulta especializada, exame e procedimento feitas a partir do
 * atendimento, verificadas contra o protocolo de encaminhamento, classificadas por prioridade e reguladas
 * numa fila única, com devolutiva ao solicitante (tempo real) e ao cidadão (WhatsApp).
 */
@Injectable()
export class RegulationService {
  constructor(
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly messaging: MessagingService,
  ) {}

  protocolos() {
    return { especialidades: ESPECIALIDADES, procedimentos: PROCEDIMENTOS_REGULADOS, prioridades: PRIORIDADES, status: STATUS_SOLICITACAO };
  }

  private definicao(kind: TipoSolicitacao, specialty: string): { nome: string; sigtapCode: string } {
    if (kind === 'CONSULTA') {
      const e = ESPECIALIDADE_POR_CODIGO[specialty];
      if (!e) throw new DomainError('ESPECIALIDADE_INVALIDA', 'Especialidade sem protocolo de encaminhamento', HttpStatus.UNPROCESSABLE_ENTITY);
      return { nome: `Consulta com ${e.nome}`, sigtapCode: e.sigtapCode };
    }
    const p = PROCEDIMENTO_POR_CODIGO[specialty];
    if (!p || p.tipo !== kind) throw new DomainError('PROCEDIMENTO_INVALIDO', 'Exame ou procedimento fora da lista regulada', HttpStatus.UNPROCESSABLE_ENTITY);
    return { nome: p.nome, sigtapCode: p.sigtapCode };
  }

  /** Exames solicitados ou com resultado nos últimos 12 meses, para a verificação do protocolo. */
  private async examesDoPaciente(ctx: RequestContext, patientId: string): Promise<ExameDisponivel[]> {
    const rows = await ctx.db.examRequest.findMany({
      where: { patientId, status: { not: 'CANCELADO' }, requestedAt: { gte: new Date(Date.now() - 366 * DIA) } },
      select: { sigtapCode: true, analyte: true, requestedAt: true, resultAt: true },
    });
    return rows.map((r) => ({ sigtapCode: r.sigtapCode, analito: r.analyte, at: r.resultAt ?? r.requestedAt }));
  }

  /** Prévia para a tela: pendências do protocolo e exames do prontuário que atendem o protocolo. */
  async verificar(ctx: RequestContext, input: { patientId: string; kind: TipoSolicitacao; specialty: string; criteria: string[]; priority: PrioridadeRegulacao; priorityJustification?: string | null }) {
    this.definicao(input.kind, input.specialty);
    const exames = await this.examesDoPaciente(ctx, input.patientId);
    return verificarProtocolo({ tipo: input.kind, codigo: input.specialty, criterios: input.criteria, prioridade: input.priority, justificativa: input.priorityJustification }, exames);
  }

  private validarCriterios(kind: TipoSolicitacao, specialty: string, criteria: string[]) {
    const validos = new Set(criteriosDe(kind, specialty).map((c) => c.codigo));
    const invalido = criteria.find((c) => !validos.has(c));
    if (invalido) throw new DomainError('CRITERIO_INVALIDO', `Critério desconhecido para este protocolo: ${invalido}`, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private async validarAnexos(ctx: RequestContext, patientId: string, ids: string[]) {
    if (!ids.length) return;
    const docs = await ctx.db.patientDocument.count({ where: { id: { in: ids }, patientId } });
    if (docs !== new Set(ids).size) throw new DomainError('ANEXO_INVALIDO', 'Anexo não pertence ao paciente', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private async proximoProtocolo(ctx: RequestContext): Promise<string> {
    const ano = new Date().getUTCFullYear();
    const total = await ctx.db.regulationRequest.count({ where: { protocol: { startsWith: `REG-${ano}-` } } });
    for (let i = 1; i <= 50; i++) {
      const candidato = numeroProtocolo(ano, total + i);
      if (!(await ctx.db.regulationRequest.findUnique({ where: { protocol: candidato }, select: { id: true } }))) return candidato;
    }
    throw new DomainError('PROTOCOLO_INDISPONIVEL', 'Não foi possível gerar o número de protocolo');
  }

  async solicitar(ctx: RequestContext, input: SolicitarInput) {
    const patient = await ctx.db.patient.findUnique({ where: { id: input.patientId }, select: { id: true, mergedIntoId: true } });
    if (!patient || patient.mergedIntoId) throw notFound('Paciente');
    if (input.encounterId) {
      const e = await ctx.db.encounter.findUnique({ where: { id: input.encounterId }, select: { patientId: true } });
      if (!e || e.patientId !== input.patientId) throw notFound('Atendimento');
    }
    const def = this.definicao(input.kind, input.specialty);
    this.validarCriterios(input.kind, input.specialty, input.criteria);
    if (PRIORIDADES[input.priority].exigeJustificativa && !(input.priorityJustification ?? '').trim()) {
      throw new DomainError('JUSTIFICATIVA_OBRIGATORIA', `Prioridade ${PRIORIDADES[input.priority].label.toLowerCase()} exige justificativa clínica`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const aberta = await ctx.db.regulationRequest.findFirst({ where: { patientId: input.patientId, kind: input.kind, specialty: input.specialty, status: { in: ABERTAS } }, select: { protocol: true, status: true } });
    if (aberta) throw conflict(`Já existe solicitação aberta de ${def.nome.toLowerCase()} para esta pessoa (${aberta.protocol}, ${STATUS_SOLICITACAO[aberta.status].toLowerCase()})`, { protocol: aberta.protocol });
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    await this.validarAnexos(ctx, input.patientId, attachmentIds);
    const verificacao = verificarProtocolo(
      { tipo: input.kind, codigo: input.specialty, criterios: input.criteria, prioridade: input.priority, justificativa: input.priorityJustification },
      await this.examesDoPaciente(ctx, input.patientId),
    );
    const protocol = await this.proximoProtocolo(ctx);
    const created = await ctx.db.$transaction(async (tx) => {
      const r = await tx.regulationRequest.create({
        data: {
          protocol,
          kind: input.kind,
          specialty: input.specialty,
          procedureCode: def.sigtapCode,
          procedureName: def.nome,
          patientId: input.patientId,
          encounterId: input.encounterId ?? null,
          unitId: ctx.session.unitId,
          requesterId: ctx.session.userId,
          requesterCbo: ctx.cbo,
          priority: input.priority,
          requestedPriority: input.priority,
          priorityJustification: input.priorityJustification?.trim() || null,
          clinicalSummary: input.clinicalSummary.trim(),
          criteria: input.criteria,
          cid: input.cid?.toUpperCase().replace('.', '') || null,
          protocolIssues: verificacao.pendencias,
          events: {
            create: {
              kind: 'CRIADA',
              toStatus: 'PENDENTE',
              userId: ctx.session.userId,
              role: ctx.session.role,
              notes: verificacao.pendencias.length ? `Pendências do protocolo: ${verificacao.pendencias.join('; ')}` : null,
            },
          },
          attachments: { create: attachmentIds.map((documentId) => ({ documentId })) },
        },
      });
      await this.audit.record(ctx, tx, {
        action: 'regulacao.solicitar',
        entityType: 'RegulationRequest',
        entityId: r.id,
        payload: { protocol, kind: input.kind, specialty: input.specialty, priority: input.priority, patientId: input.patientId, pendencias: verificacao.pendencias },
      });
      return r;
    });
    this.realtime.emitToUnit(ctx.tenant.id, ctx.session.unitId, 'regulacao.atualizada', { id: created.id, status: created.status });
    return this.detalhe(ctx, created.id);
  }

  async listar(ctx: RequestContext, q: FiltroSolicitacoes) {
    const regula = roleHasPermission(ctx.session.role, 'regulacao.regular');
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.specialty ? { specialty: q.specialty } : {}),
      ...(q.priority ? { priority: q.priority } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.encounterId ? { encounterId: q.encounterId } : {}),
      ...(q.patientId || q.encounterId || (regula && q.escopo === 'central') ? {} : { unitId: q.unitId ?? ctx.session.unitId }),
    };
    const rows = await ctx.db.regulationRequest.findMany({ where, include: requestInclude, orderBy: { createdAt: 'desc' }, take: 500 });
    const nomes = await this.nomes(ctx, rows);
    return rows.map((r) => this.view(r, nomes));
  }

  /** Fila única regulada: pendentes e em análise, por prioridade e ordem de chegada, com posição e atraso. */
  async fila(ctx: RequestContext, q: { specialty?: string; priority?: PrioridadeRegulacao; kind?: TipoSolicitacao }) {
    const rows = await ctx.db.regulationRequest.findMany({ where: { status: { in: STATUS_NA_FILA } }, include: requestInclude });
    const hoje = new Date();
    const ordenada = ordenarFila(rows.map((r) => ({ ...r, prioridade: r.priority })));
    const posicao = new Map(ordenada.map((r, i) => [r.id, i + 1]));
    const filtrada = ordenada.filter((r) => (!q.specialty || r.specialty === q.specialty) && (!q.priority || r.priority === q.priority) && (!q.kind || r.kind === q.kind));
    const nomes = await this.nomes(ctx, filtrada);
    const porPrioridade = { VERMELHA: 0, AMARELA: 0, VERDE: 0, AZUL: 0 } as Record<PrioridadeRegulacao, number>;
    const porEspecialidade = new Map<string, { codigo: string; nome: string; total: number; atrasadas: number }>();
    let atrasadas = 0;
    let dias = 0;
    for (const r of ordenada) {
      porPrioridade[r.priority]++;
      const atrasada = prazoMeta(r.priority, r.createdAt).getTime() < hoje.getTime();
      if (atrasada) atrasadas++;
      dias += diasEmFila(r.createdAt, hoje);
      const e = porEspecialidade.get(r.specialty) ?? { codigo: r.specialty, nome: r.procedureName, total: 0, atrasadas: 0 };
      e.total++;
      if (atrasada) e.atrasadas++;
      porEspecialidade.set(r.specialty, e);
    }
    return {
      total: ordenada.length,
      atrasadas,
      tempoMedioDias: ordenada.length ? Math.round(dias / ordenada.length) : 0,
      porPrioridade,
      porEspecialidade: [...porEspecialidade.values()].sort((a, b) => b.total - a.total),
      itens: filtrada.map((r) => ({ ...this.view(r, nomes, hoje), posicao: posicao.get(r.id) ?? null })),
    };
  }

  /** Painel da unidade (e da central, para quem regula): totais por situação e atrasos. */
  async painel(ctx: RequestContext, unitId?: string) {
    const regula = roleHasPermission(ctx.session.role, 'regulacao.regular');
    const uid = unitId ?? ctx.session.unitId;
    const porStatus = async (where: object) => {
      const g = await ctx.db.regulationRequest.groupBy({ by: ['status'], where, _count: { _all: true } });
      return Object.fromEntries(Object.keys(STATUS_SOLICITACAO).map((s) => [s, g.find((x) => x.status === s)?._count._all ?? 0])) as Record<StatusSolicitacao, number>;
    };
    const hoje = new Date();
    const abertas = await ctx.db.regulationRequest.findMany({ where: { unitId: uid, status: { in: STATUS_NA_FILA } }, select: { priority: true, createdAt: true } });
    return {
      unidade: { unitId: uid, porStatus: await porStatus({ unitId: uid }), atrasadas: abertas.filter((r) => prazoMeta(r.priority, r.createdAt).getTime() < hoje.getTime()).length },
      central: regula ? { porStatus: await porStatus({}), naFila: await ctx.db.regulationRequest.count({ where: { status: { in: STATUS_NA_FILA } } }) } : null,
    };
  }

  async detalhe(ctx: RequestContext, id: string) {
    const r = await ctx.db.regulationRequest.findUnique({ where: { id }, include: { ...requestInclude, events: { orderBy: { at: 'asc' } }, attachments: true } });
    if (!r) throw notFound('Solicitação');
    const regula = roleHasPermission(ctx.session.role, 'regulacao.regular');
    if (!regula && r.unitId !== ctx.session.unitId && !(await this.pacienteDaUnidade(ctx, r.patientId))) throw forbidden('Solicitação de outra unidade');
    const nomes = await this.nomes(
      ctx,
      [r],
      r.events.map((e) => e.userId),
    );
    const docs = r.attachments.length
      ? await ctx.db.patientDocument.findMany({ where: { id: { in: r.attachments.map((a) => a.documentId) } }, select: { id: true, kind: true, mimeType: true, sizeBytes: true, createdAt: true } })
      : [];
    await this.audit.recordStandalone(ctx, { action: 'regulacao.visualizar', entityType: 'RegulationRequest', entityId: id, payload: { protocol: r.protocol } });
    return {
      ...this.view(r, nomes),
      eventos: r.events.map((e) => ({ id: e.id, kind: e.kind, fromStatus: e.fromStatus, toStatus: e.toStatus, notes: e.notes, at: e.at.toISOString(), usuario: nomes.users.get(e.userId) ?? null, role: e.role })),
      anexos: r.attachments.map((a) => {
        const d = docs.find((x) => x.id === a.documentId);
        return { id: a.id, documentId: a.documentId, label: a.label, kind: d?.kind ?? null, mimeType: d?.mimeType ?? null, sizeBytes: d?.sizeBytes ?? null, createdAt: d?.createdAt.toISOString() ?? null };
      }),
      protocolo: this.protocoloDe(r.kind, r.specialty),
    };
  }

  private async pacienteDaUnidade(ctx: RequestContext, patientId: string) {
    // Quem acompanha o cidadão (recepção, equipe) vê a solicitação mesmo feita noutra unidade da rede.
    return (await ctx.db.encounter.count({ where: { patientId, unitId: ctx.session.unitId } })) > 0;
  }

  private protocoloDe(kind: TipoSolicitacao, specialty: string) {
    return kind === 'CONSULTA' ? (ESPECIALIDADE_POR_CODIGO[specialty] ?? null) : (PROCEDIMENTO_POR_CODIGO[specialty] ?? null);
  }

  // ─── Transições ──────────────────────────────────────────────────────────────

  private async carregar(ctx: RequestContext, id: string) {
    const r = await ctx.db.regulationRequest.findUnique({ where: { id }, include: requestInclude });
    if (!r) throw notFound('Solicitação');
    return r;
  }

  private exigir(r: { status: StatusSolicitacao }, permitidos: StatusSolicitacao[], acao: string) {
    if (!permitidos.includes(r.status)) throw new DomainError('SITUACAO_INVALIDA', `Não é possível ${acao} uma solicitação ${STATUS_SOLICITACAO[r.status].toLowerCase()}`, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private exigirSolicitante(ctx: RequestContext, r: { unitId: string }) {
    if (r.unitId !== ctx.session.unitId && !roleHasPermission(ctx.session.role, 'regulacao.regular')) throw forbidden('Só a unidade solicitante (ou a regulação) altera esta solicitação');
  }

  private async transicao(ctx: RequestContext, id: string, to: StatusSolicitacao, kind: string, data: Record<string, unknown>, notes: string | null, audit: string) {
    const r = await this.carregar(ctx, id);
    await ctx.db.$transaction(async (tx) => {
      await tx.regulationRequest.update({ where: { id }, data: { status: to, ...data } });
      await tx.regulationEvent.create({ data: { requestId: id, kind, fromStatus: r.status, toStatus: to, userId: ctx.session.userId, role: ctx.session.role, notes } });
      await this.audit.record(ctx, tx, { action: audit, entityType: 'RegulationRequest', entityId: id, payload: { protocol: r.protocol, from: r.status, to, notes } });
    });
    this.realtime.emitToUnit(ctx.tenant.id, r.unitId, 'regulacao.atualizada', { id, protocol: r.protocol, status: to });
    return r;
  }

  /** O regulador assume a análise (sai de pendente, continua na fila). */
  async analisar(ctx: RequestContext, id: string) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, ['PENDENTE'], 'analisar');
    await this.transicao(ctx, id, 'EM_ANALISE', 'EM_ANALISE', { regulatorId: ctx.session.userId }, null, 'regulacao.analisar');
    return this.detalhe(ctx, id);
  }

  async autorizar(ctx: RequestContext, id: string, input: { priority?: PrioridadeRegulacao; providerUnitId?: string | null; notes?: string | null }) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, ['PENDENTE', 'EM_ANALISE'], 'autorizar');
    let providerName: string | null = null;
    if (input.providerUnitId) {
      const u = await ctx.db.unit.findUnique({ where: { id: input.providerUnitId }, select: { name: true } });
      if (!u) throw notFound('Unidade executante');
      providerName = u.name;
    }
    const priority = input.priority ?? r.priority;
    const notas =
      [
        input.priority && input.priority !== r.priority ? `Prioridade reclassificada de ${PRIORIDADES[r.priority].label.toLowerCase()} para ${PRIORIDADES[priority].label.toLowerCase()}` : null,
        providerName ? `Unidade executante: ${providerName}` : null,
        input.notes?.trim() || null,
      ]
        .filter(Boolean)
        .join('. ') || null;
    await this.transicao(
      ctx,
      id,
      'AUTORIZADA',
      'AUTORIZADA',
      { priority, regulatorId: ctx.session.userId, decisionAt: new Date(), decisionReason: input.notes?.trim() || null, providerUnitId: input.providerUnitId ?? null },
      notas,
      'regulacao.autorizar',
    );
    await this.devolutivaCidadao(ctx, r, 'AUTORIZADA', providerName ? `Unidade: ${providerName}. Aguarde o agendamento.` : 'Aguarde o agendamento.');
    return this.detalhe(ctx, id);
  }

  async devolver(ctx: RequestContext, id: string, reason: string) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, ['PENDENTE', 'EM_ANALISE'], 'devolver');
    await this.transicao(
      ctx,
      id,
      'DEVOLVIDA',
      'DEVOLVIDA',
      { regulatorId: ctx.session.userId, decisionAt: new Date(), decisionReason: reason.trim(), returnedCount: { increment: 1 } },
      reason.trim(),
      'regulacao.devolver',
    );
    return this.detalhe(ctx, id);
  }

  async negar(ctx: RequestContext, id: string, reason: string) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, ['PENDENTE', 'EM_ANALISE', 'DEVOLVIDA'], 'negar');
    await this.transicao(ctx, id, 'NEGADA', 'NEGADA', { regulatorId: ctx.session.userId, decisionAt: new Date(), decisionReason: reason.trim(), closedAt: new Date() }, reason.trim(), 'regulacao.negar');
    await this.devolutivaCidadao(ctx, r, 'NEGADA', 'Sua unidade de saúde explica o motivo e as alternativas.');
    return this.detalhe(ctx, id);
  }

  /** A unidade solicitante responde à devolução: complementa e a solicitação volta à fila na posição original. */
  async complementar(ctx: RequestContext, id: string, input: ComplementarInput) {
    const r = await this.carregar(ctx, id);
    this.exigirSolicitante(ctx, r);
    this.exigir(r, ['DEVOLVIDA'], 'complementar');
    const priority = input.priority ?? r.priority;
    const justificativa = input.priorityJustification === undefined ? r.priorityJustification : input.priorityJustification?.trim() || null;
    if (PRIORIDADES[priority].exigeJustificativa && !justificativa)
      throw new DomainError('JUSTIFICATIVA_OBRIGATORIA', `Prioridade ${PRIORIDADES[priority].label.toLowerCase()} exige justificativa clínica`, HttpStatus.UNPROCESSABLE_ENTITY);
    const criteria = input.criteria ?? r.criteria;
    this.validarCriterios(r.kind, r.specialty, criteria);
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    await this.validarAnexos(ctx, r.patientId, attachmentIds);
    const clinicalSummary = input.clinicalSummary?.trim() || r.clinicalSummary;
    const verificacao = verificarProtocolo({ tipo: r.kind, codigo: r.specialty, criterios: criteria, prioridade: priority, justificativa }, await this.examesDoPaciente(ctx, r.patientId));
    await ctx.db.$transaction(async (tx) => {
      await tx.regulationRequest.update({
        where: { id },
        data: { status: 'PENDENTE', priority, requestedPriority: priority, priorityJustification: justificativa, clinicalSummary, criteria, protocolIssues: verificacao.pendencias, decisionReason: null },
      });
      for (const documentId of attachmentIds) await tx.regulationAttachment.upsert({ where: { requestId_documentId: { requestId: id, documentId } }, create: { requestId: id, documentId }, update: {} });
      await tx.regulationEvent.create({ data: { requestId: id, kind: 'COMPLEMENTADA', fromStatus: 'DEVOLVIDA', toStatus: 'PENDENTE', userId: ctx.session.userId, role: ctx.session.role, notes: input.notes.trim() } });
      await this.audit.record(ctx, tx, {
        action: 'regulacao.complementar',
        entityType: 'RegulationRequest',
        entityId: id,
        payload: { protocol: r.protocol, anexos: attachmentIds.length, pendencias: verificacao.pendencias },
      });
    });
    this.realtime.emitToUnit(ctx.tenant.id, r.unitId, 'regulacao.atualizada', { id, protocol: r.protocol, status: 'PENDENTE' });
    return this.detalhe(ctx, id);
  }

  async cancelar(ctx: RequestContext, id: string, reason: string) {
    const r = await this.carregar(ctx, id);
    this.exigirSolicitante(ctx, r);
    this.exigir(r, ['PENDENTE', 'EM_ANALISE', 'DEVOLVIDA', 'AUTORIZADA', 'AGENDADA'], 'cancelar');
    await this.transicao(ctx, id, 'CANCELADA', 'CANCELADA', { closedAt: new Date(), decisionReason: reason.trim() }, reason.trim(), 'regulacao.cancelar');
    if (r.status === 'AUTORIZADA' || r.status === 'AGENDADA') await this.devolutivaCidadao(ctx, r, 'CANCELADA', null);
    return this.detalhe(ctx, id);
  }

  /** Mensagem entre a unidade solicitante e a regulação, sem mudar a situação. */
  async mensagem(ctx: RequestContext, id: string, notes: string) {
    const r = await this.carregar(ctx, id);
    const regula = roleHasPermission(ctx.session.role, 'regulacao.regular');
    if (!regula) this.exigirSolicitante(ctx, r);
    await ctx.db.regulationEvent.create({ data: { requestId: id, kind: 'MENSAGEM', userId: ctx.session.userId, role: ctx.session.role, notes: notes.trim() } });
    await this.audit.recordStandalone(ctx, { action: 'regulacao.mensagem', entityType: 'RegulationRequest', entityId: id, payload: { protocol: r.protocol } });
    this.realtime.emitToUnit(ctx.tenant.id, r.unitId, 'regulacao.atualizada', { id, protocol: r.protocol, status: r.status, mensagem: true });
    return this.detalhe(ctx, id);
  }

  private async devolutivaCidadao(ctx: RequestContext, r: { id: string; patientId: string; protocol: string; procedureName: string }, status: 'AUTORIZADA' | 'NEGADA' | 'CANCELADA' | 'AGENDADA', detail: string | null) {
    try {
      await this.messaging.scheduleRegulationUpdate({ tenant: ctx.tenant, db: ctx.db }, { patientId: r.patientId, refId: r.id, protocol: r.protocol, procedureName: r.procedureName.toLowerCase(), status, detail });
    } catch {
      // A devolutiva ao cidadão é acessória: a decisão fica registrada mesmo sem WhatsApp.
    }
  }

  // ─── Apresentação ─────────────────────────────────────────────────────────────

  private async nomes(ctx: RequestContext, rows: { requesterId: string; regulatorId: string | null; unitId: string; providerUnitId: string | null }[], extraUsers: string[] = []) {
    const userIds = new Set<string>(extraUsers);
    const unitIds = new Set<string>();
    for (const r of rows) {
      userIds.add(r.requesterId);
      if (r.regulatorId) userIds.add(r.regulatorId);
      unitIds.add(r.unitId);
      if (r.providerUnitId) unitIds.add(r.providerUnitId);
    }
    const [users, units] = await Promise.all([
      ctx.db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }),
      ctx.db.unit.findMany({ where: { id: { in: [...unitIds] } }, select: { id: true, name: true } }),
    ]);
    return { users: new Map(users.map((u) => [u.id, u.name])), units: new Map(units.map((u) => [u.id, u.name])) };
  }

  private view(
    r: {
      id: string;
      protocol: string;
      kind: TipoSolicitacao;
      specialty: string;
      procedureCode: string;
      procedureName: string;
      patientId: string;
      encounterId: string | null;
      unitId: string;
      requesterId: string;
      requesterCbo: string;
      priority: PrioridadeRegulacao;
      requestedPriority: PrioridadeRegulacao;
      priorityJustification: string | null;
      clinicalSummary: string;
      criteria: string[];
      cid: string | null;
      protocolIssues: string[];
      status: StatusSolicitacao;
      regulatorId: string | null;
      decisionAt: Date | null;
      decisionReason: string | null;
      providerUnitId: string | null;
      appointmentId: string | null;
      returnedCount: number;
      createdAt: Date;
      updatedAt: Date;
      closedAt: Date | null;
      patient: Parameters<typeof patientSummary>[0] & { phone: string | null; whatsappOptIn: boolean };
    },
    nomes: { users: Map<string, string>; units: Map<string, string> },
    hoje = new Date(),
  ) {
    const naFila = (STATUS_NA_FILA as string[]).includes(r.status);
    const prazo = prazoMeta(r.priority, r.createdAt);
    const criterios = criteriosDe(r.kind, r.specialty);
    return {
      id: r.id,
      protocol: r.protocol,
      kind: r.kind,
      specialty: r.specialty,
      procedureCode: r.procedureCode,
      procedureName: r.procedureName,
      status: r.status,
      statusLabel: STATUS_SOLICITACAO[r.status],
      priority: r.priority,
      priorityLabel: PRIORIDADES[r.priority].label,
      requestedPriority: r.requestedPriority,
      priorityJustification: r.priorityJustification,
      clinicalSummary: r.clinicalSummary,
      criteria: r.criteria.map((c) => ({ codigo: c, descricao: criterios.find((x) => x.codigo === c)?.descricao ?? c })),
      cid: r.cid,
      protocolIssues: r.protocolIssues,
      patient: { ...patientSummary(r.patient), phone: r.patient.phone, whatsappOptIn: r.patient.whatsappOptIn },
      encounterId: r.encounterId,
      unit: { id: r.unitId, name: nomes.units.get(r.unitId) ?? null },
      requester: { id: r.requesterId, name: nomes.users.get(r.requesterId) ?? null, cbo: r.requesterCbo },
      regulator: r.regulatorId ? { id: r.regulatorId, name: nomes.users.get(r.regulatorId) ?? null } : null,
      providerUnit: r.providerUnitId ? { id: r.providerUnitId, name: nomes.units.get(r.providerUnitId) ?? null } : null,
      decisionAt: r.decisionAt?.toISOString() ?? null,
      decisionReason: r.decisionReason,
      appointmentId: r.appointmentId,
      returnedCount: r.returnedCount,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      closedAt: r.closedAt?.toISOString() ?? null,
      prazoMeta: prazo.toISOString(),
      diasEmFila: naFila ? diasEmFila(r.createdAt, hoje) : null,
      atrasada: naFila && prazo.getTime() < hoje.getTime(),
    };
  }
}
