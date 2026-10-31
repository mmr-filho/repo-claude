import { HttpStatus, Injectable } from '@nestjs/common';
import {
  competenciaRegulacao,
  consumirCotas,
  criteriosDe,
  diasEmFila,
  escolherCota,
  ESPECIALIDADE_POR_CODIGO,
  ESPECIALIDADES,
  localDateString,
  numeroProtocolo,
  ordenarFila,
  prazoMeta,
  PRIORIDADES,
  PROCEDIMENTO_POR_CODIGO,
  PROCEDIMENTOS_REGULADOS,
  roleHasPermission,
  STATUS_CONSOME_COTA,
  STATUS_NA_FILA,
  STATUS_SOLICITACAO,
  tempoMedioDias,
  TIPO_PRESTADOR,
  verificarProtocolo,
  zonedParts,
  type ExameDisponivel,
  type PrioridadeRegulacao,
  type StatusSolicitacao,
  type TipoPrestador,
  type TipoSolicitacao,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { conflict, DomainError, forbidden, notFound } from '../../core/errors';
import { RealtimeService } from '../../core/realtime.service';
import { MessagingService } from '../integrations/messaging.service';
import { patientSummary } from '../patients/patients.service';
import { SchedulingService } from '../scheduling/scheduling.service';

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
  provider: { select: { id: true, name: true, kind: true, unitId: true } },
} as const;

export interface PrestadorInput {
  name: string;
  kind: TipoPrestador;
  unitId?: string | null;
  cnes?: string | null;
  cnpj?: string | null;
  contractNumber?: string | null;
  contractStart?: string | null;
  contractEnd?: string | null;
  physicalCeiling?: number | null;
  financialCeiling?: number | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  active?: boolean;
}

export interface CotaInput {
  id?: string | null;
  kind: TipoSolicitacao;
  specialty: string;
  quantity: number;
  unitValue?: number | null;
  originUnitId?: string | null;
  notes?: string | null;
}

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
    private readonly scheduling: SchedulingService,
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
    await this.reconciliar(ctx, rows);
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

  /** Painel da unidade (e da central, para quem regula): totais por situação, atrasos e tempos médios. */
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
      central: regula ? { porStatus: await porStatus({}), naFila: await ctx.db.regulationRequest.count({ where: { status: { in: STATUS_NA_FILA } } }), ...(await this.tempos(ctx, hoje)) } : null,
    };
  }

  /** Tempos médios (últimos 90 dias): da solicitação à decisão e ao agendamento, no total e por prestador. */
  private async tempos(ctx: RequestContext, hoje: Date) {
    const desde = new Date(hoje.getTime() - 90 * DIA);
    const rows = await ctx.db.regulationRequest.findMany({
      where: { createdAt: { gte: desde } },
      select: { id: true, createdAt: true, decisionAt: true, status: true, providerId: true, noShowCount: true, events: { where: { kind: 'AGENDADA' }, orderBy: { at: 'asc' }, take: 1, select: { at: true } } },
    });
    const decididas = rows.filter((r) => r.decisionAt && ['AUTORIZADA', 'AGENDADA', 'REALIZADA', 'NEGADA'].includes(r.status));
    const agendadas = rows.filter((r) => r.events[0]);
    const prestadores = await ctx.db.regulationProvider.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.providerId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
    return {
      tempoMedio: {
        ateDecisaoDias: tempoMedioDias(decididas.map((r) => ({ inicio: r.createdAt, fim: r.decisionAt as Date }))),
        ateAgendamentoDias: tempoMedioDias(agendadas.map((r) => ({ inicio: r.createdAt, fim: r.events[0]!.at }))),
        porPrestador: prestadores
          .map((p) => {
            const mine = rows.filter((r) => r.providerId === p.id);
            return {
              providerId: p.id,
              nome: p.name,
              autorizadas: mine.length,
              agendadas: mine.filter((r) => r.status === 'AGENDADA' || r.status === 'REALIZADA').length,
              realizadas: mine.filter((r) => r.status === 'REALIZADA').length,
              faltas: mine.reduce((s, r) => s + r.noShowCount, 0),
              tempoMedioAgendamentoDias: tempoMedioDias(mine.filter((r) => r.events[0]).map((r) => ({ inicio: r.createdAt, fim: r.events[0]!.at }))),
            };
          })
          .sort((a, b) => b.autorizadas - a.autorizadas),
      },
    };
  }

  async detalhe(ctx: RequestContext, id: string) {
    const buscar = () => ctx.db.regulationRequest.findUnique({ where: { id }, include: { ...requestInclude, events: { orderBy: { at: 'asc' } }, attachments: true } });
    let r = await buscar();
    if (!r) throw notFound('Solicitação');
    // O agendamento pode ter mudado na agenda (chegada, falta, cancelamento): reflete antes de mostrar.
    if (await this.reconciliar(ctx, [r])) r = (await buscar()) ?? r;
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
      agendamento: await this.agendamentoDe(ctx, r.appointmentId),
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

  async autorizar(ctx: RequestContext, id: string, input: { priority?: PrioridadeRegulacao; providerId?: string | null; providerUnitId?: string | null; notes?: string | null }) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, ['PENDENTE', 'EM_ANALISE'], 'autorizar');
    const competencia = competenciaRegulacao(new Date(), ctx.tenant.timeZone);
    let providerName: string | null = null;
    let providerUnitId: string | null = input.providerUnitId ?? null;
    let quotaId: string | null = null;
    if (input.providerId) {
      const provider = await ctx.db.regulationProvider.findUnique({ where: { id: input.providerId } });
      if (!provider || !provider.active) throw notFound('Prestador');
      providerName = provider.name;
      providerUnitId = provider.unitId ?? providerUnitId;
      const cotas = await this.cotasConsumo(ctx, provider.id, competencia, r.kind, r.specialty);
      if (cotas.length) {
        const cota = escolherCota(cotas, r.unitId);
        if (!cota)
          throw new DomainError(
            'COTA_ESGOTADA',
            `${provider.name}: cota de ${r.procedureName.toLowerCase()} esgotada em ${competencia} (${cotas.map((c) => `${c.used}/${c.quantity}`).join(', ')})`,
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        quotaId = cota.id;
      }
      await this.conferirTetos(ctx, provider, competencia, quotaId);
    } else if (providerUnitId) {
      const u = await ctx.db.unit.findUnique({ where: { id: providerUnitId }, select: { name: true } });
      if (!u) throw notFound('Unidade executante');
      providerName = u.name;
    }
    const priority = input.priority ?? r.priority;
    const notas =
      [
        input.priority && input.priority !== r.priority ? `Prioridade reclassificada de ${PRIORIDADES[r.priority].label.toLowerCase()} para ${PRIORIDADES[priority].label.toLowerCase()}` : null,
        providerName ? `Unidade executante: ${providerName}${quotaId ? ' (cota consumida)' : ''}` : null,
        input.notes?.trim() || null,
      ]
        .filter(Boolean)
        .join('. ') || null;
    await this.transicao(
      ctx,
      id,
      'AUTORIZADA',
      'AUTORIZADA',
      { priority, regulatorId: ctx.session.userId, decisionAt: new Date(), decisionReason: input.notes?.trim() || null, providerUnitId, providerId: input.providerId ?? null, quotaId, competencia },
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

  // ─── Prestadores, cotas (REG-3) ──────────────────────────────────────────────

  private async cotasConsumo(ctx: RequestContext, providerId: string, competencia: string, kind: TipoSolicitacao, specialty: string) {
    const cotas = await ctx.db.regulationQuota.findMany({ where: { providerId, competencia, kind, specialty } });
    if (!cotas.length) return [];
    const usos = await ctx.db.regulationRequest.findMany({ where: { quotaId: { in: cotas.map((c) => c.id) }, status: { in: STATUS_CONSOME_COTA } }, select: { quotaId: true } });
    return consumirCotas(
      cotas.map((c) => ({
        id: c.id,
        providerId: c.providerId,
        competencia: c.competencia,
        kind: c.kind,
        specialty: c.specialty,
        quantity: c.quantity,
        unitValue: c.unitValue === null ? null : Number(c.unitValue),
        originUnitId: c.originUnitId,
      })),
      usos,
    );
  }

  /** Tetos físico e financeiro do contrato na competência (contando a autorização que está sendo feita). */
  private async conferirTetos(ctx: RequestContext, provider: { id: string; name: string; physicalCeiling: number | null; financialCeiling: unknown }, competencia: string, quotaId: string | null) {
    if (provider.physicalCeiling === null && provider.financialCeiling === null) return;
    const usadas = await ctx.db.regulationRequest.findMany({ where: { providerId: provider.id, competencia, status: { in: STATUS_CONSOME_COTA } }, select: { quotaId: true } });
    if (provider.physicalCeiling !== null && usadas.length + 1 > provider.physicalCeiling) {
      throw new DomainError('TETO_FISICO', `${provider.name}: teto físico de ${provider.physicalCeiling} procedimentos atingido em ${competencia}`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (provider.financialCeiling !== null) {
      const cotas = await ctx.db.regulationQuota.findMany({ where: { providerId: provider.id, competencia }, select: { id: true, unitValue: true } });
      const valor = (id: string | null) => Number(cotas.find((c) => c.id === id)?.unitValue ?? 0);
      const total = usadas.reduce((s, u) => s + valor(u.quotaId), 0) + valor(quotaId);
      if (total > Number(provider.financialCeiling))
        throw new DomainError('TETO_FINANCEIRO', `${provider.name}: teto financeiro de R$ ${Number(provider.financialCeiling).toFixed(2)} seria ultrapassado em ${competencia}`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
  }

  async listarPrestadores(ctx: RequestContext, competencia?: string) {
    const comp = competencia ?? competenciaRegulacao(new Date(), ctx.tenant.timeZone);
    const rows = await ctx.db.regulationProvider.findMany({ include: { quotas: { where: { competencia: comp } } }, orderBy: [{ active: 'desc' }, { name: 'asc' }] });
    const unitIds = rows.map((r) => r.unitId).filter((x): x is string => !!x);
    const [units, agendas, usos] = await Promise.all([
      ctx.db.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, name: true } }),
      unitIds.length ? ctx.db.schedule.groupBy({ by: ['unitId'], where: { unitId: { in: unitIds }, active: true }, _count: { _all: true } }) : [],
      ctx.db.regulationRequest.findMany({ where: { providerId: { in: rows.map((r) => r.id) }, competencia: comp, status: { in: STATUS_CONSOME_COTA } }, select: { providerId: true, quotaId: true } }),
    ]);
    const unitName = new Map(units.map((u) => [u.id, u.name]));
    return rows.map((p) => {
      const usosDoPrestador = usos.filter((u) => u.providerId === p.id);
      const consumo = consumirCotas(
        p.quotas.map((c) => ({
          id: c.id,
          providerId: c.providerId,
          competencia: c.competencia,
          kind: c.kind,
          specialty: c.specialty,
          quantity: c.quantity,
          unitValue: c.unitValue === null ? null : Number(c.unitValue),
          originUnitId: c.originUnitId,
        })),
        usosDoPrestador,
      );
      const valorUsado = Math.round(consumo.reduce((s, c) => s + c.valorUsado, 0) * 100) / 100;
      return {
        ...this.prestadorView(p, unitName),
        agendas: p.unitId ? (agendas.find((a) => a.unitId === p.unitId)?._count._all ?? 0) : 0,
        resumo: {
          cotas: p.quotas.length,
          quantidade: p.quotas.reduce((s, c) => s + c.quantity, 0),
          usadas: usosDoPrestador.length,
          valorUsado,
          tetoFisicoUsadoPct: p.physicalCeiling ? Math.round((usosDoPrestador.length / p.physicalCeiling) * 100) : null,
          tetoFinanceiroUsadoPct: p.financialCeiling ? Math.round((valorUsado / Number(p.financialCeiling)) * 100) : null,
        },
      };
    });
  }

  private prestadorView(
    p: {
      id: string;
      name: string;
      kind: TipoPrestador;
      unitId: string | null;
      cnes: string | null;
      cnpj: string | null;
      contractNumber: string | null;
      contractStart: Date | null;
      contractEnd: Date | null;
      physicalCeiling: number | null;
      financialCeiling: unknown;
      phone: string | null;
      address: string | null;
      notes: string | null;
      active: boolean;
    },
    unitName: Map<string, string>,
  ) {
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      kindLabel: TIPO_PRESTADOR[p.kind],
      unit: p.unitId ? { id: p.unitId, name: unitName.get(p.unitId) ?? null } : null,
      cnes: p.cnes,
      cnpj: p.cnpj,
      contractNumber: p.contractNumber,
      contractStart: p.contractStart?.toISOString() ?? null,
      contractEnd: p.contractEnd?.toISOString() ?? null,
      physicalCeiling: p.physicalCeiling,
      financialCeiling: p.financialCeiling === null || p.financialCeiling === undefined ? null : Number(p.financialCeiling),
      phone: p.phone,
      address: p.address,
      notes: p.notes,
      active: p.active,
    };
  }

  private prestadorData(input: PrestadorInput) {
    const dia = (v: string | null | undefined) => (v === undefined ? undefined : v ? new Date(`${v}T12:00:00Z`) : null);
    return {
      name: input.name.trim(),
      kind: input.kind,
      unitId: input.unitId ?? null,
      cnes: input.cnes?.trim() || null,
      cnpj: input.cnpj?.replace(/\D/g, '') || null,
      contractNumber: input.contractNumber?.trim() || null,
      contractStart: dia(input.contractStart),
      contractEnd: dia(input.contractEnd),
      physicalCeiling: input.physicalCeiling ?? null,
      financialCeiling: input.financialCeiling ?? null,
      phone: input.phone?.trim() || null,
      address: input.address?.trim() || null,
      notes: input.notes?.trim() || null,
      ...(input.active === undefined ? {} : { active: input.active }),
    };
  }

  async criarPrestador(ctx: RequestContext, input: PrestadorInput) {
    if (input.unitId && !(await ctx.db.unit.findUnique({ where: { id: input.unitId }, select: { id: true } }))) throw notFound('Unidade');
    const p = await ctx.db.regulationProvider.create({ data: this.prestadorData(input) });
    await this.audit.recordStandalone(ctx, { action: 'regulacao.prestador.criar', entityType: 'RegulationProvider', entityId: p.id, payload: input });
    return (await this.listarPrestadores(ctx)).find((x) => x.id === p.id);
  }

  async atualizarPrestador(ctx: RequestContext, id: string, input: PrestadorInput) {
    if (!(await ctx.db.regulationProvider.findUnique({ where: { id }, select: { id: true } }))) throw notFound('Prestador');
    if (input.unitId && !(await ctx.db.unit.findUnique({ where: { id: input.unitId }, select: { id: true } }))) throw notFound('Unidade');
    await ctx.db.regulationProvider.update({ where: { id }, data: this.prestadorData(input) });
    await this.audit.recordStandalone(ctx, { action: 'regulacao.prestador.atualizar', entityType: 'RegulationProvider', entityId: id, payload: input });
    return (await this.listarPrestadores(ctx)).find((x) => x.id === id);
  }

  async cotasDoPrestador(ctx: RequestContext, providerId: string, competencia?: string) {
    const comp = competencia ?? competenciaRegulacao(new Date(), ctx.tenant.timeZone);
    if (!(await ctx.db.regulationProvider.findUnique({ where: { id: providerId }, select: { id: true } }))) throw notFound('Prestador');
    const cotas = await ctx.db.regulationQuota.findMany({ where: { providerId, competencia: comp }, orderBy: [{ kind: 'asc' }, { specialty: 'asc' }] });
    const usos = await ctx.db.regulationRequest.findMany({ where: { quotaId: { in: cotas.map((c) => c.id) }, status: { in: STATUS_CONSOME_COTA } }, select: { quotaId: true } });
    const units = new Map((await ctx.db.unit.findMany({ where: { id: { in: cotas.map((c) => c.originUnitId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return consumirCotas(
      cotas.map((c) => ({
        id: c.id,
        providerId: c.providerId,
        competencia: c.competencia,
        kind: c.kind,
        specialty: c.specialty,
        quantity: c.quantity,
        unitValue: c.unitValue === null ? null : Number(c.unitValue),
        originUnitId: c.originUnitId,
      })),
      usos,
    ).map((c) => ({ ...c, specialtyLabel: this.nomeDe(c.kind, c.specialty), originUnitName: c.originUnitId ? (units.get(c.originUnitId) ?? null) : null, notes: cotas.find((x) => x.id === c.id)?.notes ?? null }));
  }

  private nomeDe(kind: TipoSolicitacao, specialty: string) {
    return kind === 'CONSULTA' ? `Consulta com ${ESPECIALIDADE_POR_CODIGO[specialty]?.nome ?? specialty}` : (PROCEDIMENTO_POR_CODIGO[specialty]?.nome ?? specialty);
  }

  /** Substitui as cotas do prestador na competência: mantém as com uso, cria/atualiza as enviadas e remove as demais. */
  async definirCotas(ctx: RequestContext, providerId: string, competencia: string, cotas: CotaInput[]) {
    if (!(await ctx.db.regulationProvider.findUnique({ where: { id: providerId }, select: { id: true } }))) throw notFound('Prestador');
    for (const c of cotas) this.definicao(c.kind, c.specialty);
    const atuais = await ctx.db.regulationQuota.findMany({ where: { providerId, competencia } });
    const enviadas = new Set(cotas.map((c) => c.id).filter((x): x is string => !!x));
    await ctx.db.$transaction(async (tx) => {
      for (const a of atuais) {
        if (enviadas.has(a.id)) continue;
        const usos = await tx.regulationRequest.count({ where: { quotaId: a.id, status: { in: STATUS_CONSOME_COTA } } });
        if (usos > 0)
          throw new DomainError('COTA_EM_USO', `A cota de ${this.nomeDe(a.kind, a.specialty).toLowerCase()} já tem ${usos} autorização(ões); reduza a quantidade em vez de removê-la`, HttpStatus.UNPROCESSABLE_ENTITY);
        await tx.regulationQuota.delete({ where: { id: a.id } });
      }
      for (const c of cotas) {
        const data = { kind: c.kind, specialty: c.specialty, quantity: c.quantity, unitValue: c.unitValue ?? null, originUnitId: c.originUnitId ?? null, notes: c.notes?.trim() || null };
        if (c.id && atuais.some((a) => a.id === c.id)) await tx.regulationQuota.update({ where: { id: c.id }, data });
        else await tx.regulationQuota.create({ data: { ...data, providerId, competencia } });
      }
      await this.audit.record(ctx, tx, { action: 'regulacao.cotas.definir', entityType: 'RegulationProvider', entityId: providerId, payload: { competencia, cotas } });
    });
    return this.cotasDoPrestador(ctx, providerId, competencia);
  }

  /** Prestadores que podem receber a autorização: com cota disponível na competência ou sem cota configurada (ilimitado). */
  async ofertas(ctx: RequestContext, q: { kind: TipoSolicitacao; specialty: string; unitId?: string; competencia?: string }) {
    const comp = q.competencia ?? competenciaRegulacao(new Date(), ctx.tenant.timeZone);
    const prestadores = await ctx.db.regulationProvider.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, kind: true, unitId: true } });
    const out = [];
    for (const p of prestadores) {
      const cotas = await this.cotasConsumo(ctx, p.id, comp, q.kind, q.specialty);
      const escolhida = cotas.length ? escolherCota(cotas, q.unitId ?? ctx.session.unitId) : null;
      out.push({
        id: p.id,
        name: p.name,
        kind: p.kind,
        kindLabel: TIPO_PRESTADOR[p.kind],
        unitId: p.unitId,
        semCota: cotas.length === 0,
        disponivel: cotas.length === 0 || !!escolhida,
        cotas: cotas.map((c) => ({ id: c.id, quantity: c.quantity, used: c.used, available: c.available, originUnitId: c.originUnitId })),
      });
    }
    return { competencia: comp, prestadores: out };
  }

  /** Agendas do prestador (unidade da rede) com os próximos horários livres, para o agendamento regulado. */
  async agendasDoPrestador(ctx: RequestContext, providerId: string) {
    const p = await ctx.db.regulationProvider.findUnique({ where: { id: providerId } });
    if (!p) throw notFound('Prestador');
    if (!p.unitId) return { providerId, unitId: null, agendas: [] };
    return { providerId, unitId: p.unitId, agendas: await this.agendasDaUnidade(ctx, p.unitId) };
  }

  private async agendasDaUnidade(ctx: RequestContext, unitId: string) {
    const schedules = await ctx.db.schedule.findMany({ where: { unitId, active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, cbo: true, slotMinutes: true, professionalId: true } });
    const users = new Map((await ctx.db.user.findMany({ where: { id: { in: schedules.map((s) => s.professionalId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const sys = { tenant: ctx.tenant, db: ctx.db, session: ctx.session };
    const out = [];
    for (const s of schedules) {
      const proximos = await this.scheduling.nextFreeSlots(sys, s.id, 3);
      out.push({
        id: s.id,
        name: s.name,
        cbo: s.cbo,
        slotMinutes: s.slotMinutes,
        profissional: users.get(s.professionalId) ?? null,
        proximos: proximos.map((x) => ({ id: x.id, startsAt: x.startsAt.toISOString(), endsAt: x.endsAt.toISOString() })),
      });
    }
    return out;
  }

  // ─── Agendamento regulado (REG-4) ───────────────────────────────────────────

  private exigirExecutante(ctx: RequestContext, r: { providerUnitId: string | null }, unitId: string) {
    const regula = roleHasPermission(ctx.session.role, 'regulacao.regular');
    if (regula) return;
    if (!roleHasPermission(ctx.session.role, 'agenda.marcar') || ctx.session.unitId !== unitId) throw forbidden('Só a regulação ou a unidade executante agenda esta solicitação');
    if (r.providerUnitId && r.providerUnitId !== unitId) throw forbidden('A agenda não é da unidade executante autorizada');
  }

  private async agendamentoDe(ctx: RequestContext, appointmentId: string | null) {
    if (!appointmentId) return null;
    const a = await ctx.db.appointment.findUnique({ where: { id: appointmentId }, include: { schedule: { select: { id: true, name: true, unitId: true } } } });
    if (!a) return null;
    const unit = await ctx.db.unit.findUnique({ where: { id: a.unitId }, select: { name: true } });
    return {
      id: a.id,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      status: a.status,
      confirmedAt: a.confirmedAt?.toISOString() ?? null,
      schedule: { id: a.schedule.id, name: a.schedule.name },
      unit: { id: a.unitId, name: unit?.name ?? null },
    };
  }

  private quando(d: Date, ctx: RequestContext) {
    const p = zonedParts(d, ctx.tenant.timeZone);
    return `${localDateString(d, ctx.tenant.timeZone).split('-').reverse().join('/')} às ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  }

  async agendar(ctx: RequestContext, id: string, input: { scheduleId: string; startsAt: string }) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, ['AUTORIZADA'], 'agendar');
    const schedule = await ctx.db.schedule.findUnique({ where: { id: input.scheduleId }, select: { id: true, name: true, unitId: true } });
    if (!schedule) throw notFound('Agenda');
    this.exigirExecutante(ctx, r, schedule.unitId);
    if (r.providerUnitId && r.providerUnitId !== schedule.unitId) throw new DomainError('AGENDA_DE_OUTRA_UNIDADE', 'A agenda escolhida não é da unidade executante autorizada', HttpStatus.UNPROCESSABLE_ENTITY);
    const sys = { tenant: ctx.tenant, db: ctx.db, session: ctx.session };
    const appt = await this.scheduling.book(
      sys,
      { scheduleId: schedule.id, patientId: r.patientId, startsAt: input.startsAt, kind: 'PRIMEIRA_CONSULTA', notes: `Regulação ${r.protocol} · ${r.procedureName}` },
      ctx.session.userId,
    );
    const unit = await ctx.db.unit.findUnique({ where: { id: schedule.unitId }, select: { name: true } });
    const texto = `${this.quando(appt.startsAt, ctx)} · ${schedule.name} · ${unit?.name ?? ''}`;
    await this.transicao(ctx, id, 'AGENDADA', 'AGENDADA', { appointmentId: appt.id, scheduledAt: appt.startsAt, providerUnitId: r.providerUnitId ?? schedule.unitId }, texto, 'regulacao.agendar');
    await this.devolutivaCidadao(ctx, r, 'AGENDADA', `${this.quando(appt.startsAt, ctx)}, ${unit?.name ?? 'unidade executante'}.`);
    return this.detalhe(ctx, id);
  }

  async remarcar(ctx: RequestContext, id: string, input: { startsAt: string }) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, ['AGENDADA'], 'remarcar');
    if (!r.appointmentId) throw new DomainError('SEM_AGENDAMENTO', 'Solicitação sem agendamento vinculado');
    const atual = await ctx.db.appointment.findUnique({ where: { id: r.appointmentId }, include: { schedule: { select: { name: true, unitId: true } } } });
    if (!atual) throw notFound('Agendamento');
    this.exigirExecutante(ctx, r, atual.unitId);
    const sys = { tenant: ctx.tenant, db: ctx.db, session: ctx.session };
    const novo = await this.scheduling.reschedule(sys, atual.id, input.startsAt, ctx.session.userId);
    await ctx.db.$transaction(async (tx) => {
      await tx.regulationRequest.update({ where: { id }, data: { appointmentId: novo.id, scheduledAt: novo.startsAt } });
      await tx.regulationEvent.create({
        data: { requestId: id, kind: 'REMARCADA', userId: ctx.session.userId, role: ctx.session.role, notes: `${this.quando(atual.startsAt, ctx)} → ${this.quando(novo.startsAt, ctx)} · ${atual.schedule.name}` },
      });
      await this.audit.record(ctx, tx, { action: 'regulacao.remarcar', entityType: 'RegulationRequest', entityId: id, payload: { protocol: r.protocol, de: atual.id, para: novo.id } });
    });
    this.realtime.emitToUnit(ctx.tenant.id, r.unitId, 'regulacao.atualizada', { id, protocol: r.protocol, status: 'AGENDADA' });
    await this.devolutivaCidadao(ctx, r, 'AGENDADA', `Nova data: ${this.quando(novo.startsAt, ctx)}.`);
    return this.detalhe(ctx, id);
  }

  /** Desmarca pela regulação ou pela unidade executante: a vaga volta à agenda e a solicitação volta a autorizada. */
  async desmarcar(ctx: RequestContext, id: string, reason: string) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, ['AGENDADA'], 'desmarcar');
    if (!r.appointmentId) throw new DomainError('SEM_AGENDAMENTO', 'Solicitação sem agendamento vinculado');
    const atual = await ctx.db.appointment.findUnique({ where: { id: r.appointmentId } });
    if (!atual) throw notFound('Agendamento');
    this.exigirExecutante(ctx, r, atual.unitId);
    if (atual.status === 'AGENDADO' || atual.status === 'CONFIRMADO') await this.scheduling.cancel({ tenant: ctx.tenant, db: ctx.db }, atual.id, reason.trim());
    await this.transicao(ctx, id, 'AUTORIZADA', 'AGENDAMENTO_CANCELADO', { appointmentId: null, scheduledAt: null }, reason.trim(), 'regulacao.desmarcar');
    return this.detalhe(ctx, id);
  }

  /** Falta ao agendamento: registra o não comparecimento e devolve a solicitação a autorizada para reagendar. */
  async falta(ctx: RequestContext, id: string) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, ['AGENDADA'], 'registrar falta em');
    if (!r.appointmentId) throw new DomainError('SEM_AGENDAMENTO', 'Solicitação sem agendamento vinculado');
    const atual = await ctx.db.appointment.findUnique({ where: { id: r.appointmentId } });
    if (!atual) throw notFound('Agendamento');
    this.exigirExecutante(ctx, r, atual.unitId);
    if (atual.status !== 'FALTOU') await this.scheduling.noShow(ctx, atual.id);
    await this.transicao(ctx, id, 'AUTORIZADA', 'FALTOU', { appointmentId: null, scheduledAt: null, noShowCount: { increment: 1 } }, `Não compareceu em ${this.quando(atual.startsAt, ctx)}`, 'regulacao.falta');
    return this.detalhe(ctx, id);
  }

  async realizar(ctx: RequestContext, id: string, notes?: string | null) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, ['AGENDADA', 'AUTORIZADA'], 'concluir');
    const regula = roleHasPermission(ctx.session.role, 'regulacao.regular');
    if (!regula && ctx.session.unitId !== (r.providerUnitId ?? '')) throw forbidden('Só a regulação ou a unidade executante conclui a solicitação');
    await this.transicao(ctx, id, 'REALIZADA', 'REALIZADA', { closedAt: new Date() }, notes?.trim() || null, 'regulacao.realizar');
    return this.detalhe(ctx, id);
  }

  /**
   * Acompanha o agendamento feito na agenda (chegada, falta, cancelamento ou remarcação pelo WhatsApp) e
   * reflete na solicitação; devolve true quando algo mudou.
   */
  private async reconciliar(ctx: RequestContext, rows: { id: string; status: StatusSolicitacao; appointmentId: string | null; protocol: string; unitId: string }[]) {
    const agendadas = rows.filter((r) => r.status === 'AGENDADA' && r.appointmentId);
    if (!agendadas.length) return false;
    const appts = await ctx.db.appointment.findMany({ where: { id: { in: agendadas.map((r) => r.appointmentId as string) } } });
    let mudou = false;
    for (const r of agendadas) {
      const a = appts.find((x) => x.id === r.appointmentId);
      if (!a) continue;
      if (a.status === 'ATENDIDO') {
        await this.transicaoSistema(ctx, r, 'REALIZADA', 'REALIZADA', { closedAt: new Date() }, 'Paciente atendido na unidade executante');
        mudou = true;
      } else if (a.status === 'FALTOU') {
        await this.transicaoSistema(ctx, r, 'AUTORIZADA', 'FALTOU', { appointmentId: null, scheduledAt: null, noShowCount: { increment: 1 } }, `Não compareceu em ${this.quando(a.startsAt, ctx)}`);
        mudou = true;
      } else if (a.status === 'CANCELADO') {
        await this.transicaoSistema(ctx, r, 'AUTORIZADA', 'AGENDAMENTO_CANCELADO', { appointmentId: null, scheduledAt: null }, a.cancelReason ?? 'Agendamento cancelado');
        mudou = true;
      } else if (a.status === 'REMARCADO') {
        const novo = await ctx.db.appointment.findFirst({ where: { rescheduledFromId: a.id }, orderBy: { createdAt: 'desc' } });
        if (novo) {
          await ctx.db.regulationRequest.update({ where: { id: r.id }, data: { appointmentId: novo.id, scheduledAt: novo.startsAt } });
          await ctx.db.regulationEvent.create({
            data: { requestId: r.id, kind: 'REMARCADA', userId: ctx.session.userId, role: ctx.session.role, notes: `${this.quando(a.startsAt, ctx)} → ${this.quando(novo.startsAt, ctx)} (remarcado pela agenda)` },
          });
          mudou = true;
        }
      }
    }
    return mudou;
  }

  private async transicaoSistema(ctx: RequestContext, r: { id: string; status: StatusSolicitacao; protocol: string; unitId: string }, to: StatusSolicitacao, kind: string, data: Record<string, unknown>, notes: string) {
    await ctx.db.$transaction(async (tx) => {
      await tx.regulationRequest.update({ where: { id: r.id }, data: { status: to, ...data } });
      await tx.regulationEvent.create({ data: { requestId: r.id, kind, fromStatus: r.status, toStatus: to, userId: ctx.session.userId, role: ctx.session.role, notes } });
    });
    this.realtime.emitToUnit(ctx.tenant.id, r.unitId, 'regulacao.atualizada', { id: r.id, protocol: r.protocol, status: to });
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
      providerId: string | null;
      quotaId: string | null;
      competencia: string | null;
      appointmentId: string | null;
      scheduledAt: Date | null;
      noShowCount: number;
      returnedCount: number;
      provider: { id: string; name: string; kind: TipoPrestador; unitId: string | null } | null;
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
      provider: r.provider ? { id: r.provider.id, name: r.provider.name, kind: r.provider.kind, kindLabel: TIPO_PRESTADOR[r.provider.kind], unitId: r.provider.unitId } : null,
      quotaId: r.quotaId,
      competencia: r.competencia,
      scheduledAt: r.scheduledAt?.toISOString() ?? null,
      noShowCount: r.noShowCount,
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
