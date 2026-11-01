import { HttpStatus, Injectable } from '@nestjs/common';
import {
  horasEmFila,
  news2,
  numeroProtocoloLeito,
  ordenarFilaLeitos,
  prazoMetaLeito,
  PRIORIDADE_LEITO,
  prioridadeLeitoSugerida,
  ROLE_LABELS,
  roleHasPermission,
  STATUS_LEITO_ABERTOS,
  STATUS_LEITO_NA_FILA,
  STATUS_SOLICITACAO_LEITO,
  TIPO_LEITO,
  TRANSPORTE_TRANSFERENCIA,
  type PrioridadeRegulacao,
  type SinaisVitais,
  type StatusSolicitacaoLeito,
  type Suporte,
  type TipoLeito,
  type TransporteTransferencia,
} from '@omnisaude/shared';
import { TenantPrisma as Prisma } from '@omnisaude/database';
import { AuditService } from '../../core/audit.service';
import { OutboxService } from '../../core/outbox.service';
import type { RequestContext } from '../../core/context';
import { DomainError, forbidden, notFound } from '../../core/errors';
import { anoDoProtocolo, gravarComProtocolo } from '../../core/protocolo';
import { RealtimeService } from '../../core/realtime.service';
import { BedsService } from '../beds/beds.service';
import { patientSummary } from '../patients/patients.service';
import { formatDateTime, renderDocument, type DocumentModel } from '../signatures/pdf';

type Isolation = 'NENHUM' | 'CONTATO' | 'GOTICULAS' | 'AEROSSOIS';

export interface SolicitacaoInput {
  patientId: string;
  encounterId?: string | null;
  bedKind: TipoLeito;
  specialty: string;
  priority?: PrioridadeRegulacao | null;
  cid?: string | null;
  clinicalSummary: string;
  vitals?: SinaisVitais | null;
  support?: Suporte | null;
  isolation?: Isolation;
  elective?: boolean;
  /** Procedimento SIGTAP da internação (exigido pelo MIRA para o envio à RNDS). */
  procedureCode?: string | null;
  /** Código no SISREG / e-SUS Regulação, quando também registrada lá. */
  externalCode?: string | null;
}

export interface AutorizacaoInput {
  destinationUnitId: string;
  destinationKind: TipoLeito;
  bedId?: string | null;
  transport?: TransporteTransferencia | null;
  priority?: PrioridadeRegulacao | null;
  notes: string;
}

const include = {
  patient: { select: { id: true, name: true, socialName: true, cns: true, cpf: true, birthDate: true, sex: true, motherName: true, phone: true } },
  events: { orderBy: { at: 'asc' as const } },
  reservedBed: { select: { id: true, code: true, ward: { select: { name: true, kind: true } } } },
};
type Row = Prisma.BedRequestGetPayload<{ include: typeof include }>;

/** Central de leitos da rede: solicitação de vaga, fila por prioridade, avaliação do regulador, reserva de leito, transferência e internação. */
@Injectable()
export class BedRegulationService {
  constructor(
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly beds: BedsService,
    private readonly outbox: OutboxService,
  ) {}

  /** Registro de Regulação Assistencial para a RNDS (Portaria GM/MS 6.656/2025): um documento por mudança de situação. */
  private async rnds(ctx: RequestContext, tx: Prisma.TransactionClient, id: string, status: StatusSolicitacaoLeito, evento: string | null) {
    const sequencia = (await tx.outboxMessage.count({ where: { kind: 'RNDS_REGULACAO', aggregateId: id } })) + 1;
    await this.outbox.enqueue(tx, 'RNDS_REGULACAO', id, { fonte: 'LEITO', status, evento, at: new Date().toISOString(), unitId: ctx.session.unitId, sequencia });
  }

  private async proximoProtocolo(ctx: RequestContext, ano: number, salto = 0) {
    const total = await ctx.db.bedRequest.count({ where: { protocol: { startsWith: `LEI-${ano}-` } } });
    for (let i = 1 + salto; i <= 50 + salto; i++) {
      const candidato = numeroProtocoloLeito(ano, total + i);
      if (!(await ctx.db.bedRequest.findUnique({ where: { protocol: candidato }, select: { id: true } }))) return candidato;
    }
    throw new DomainError('PROTOCOLO_INDISPONIVEL', 'Não foi possível gerar o número da solicitação');
  }

  private avaliar(input: SolicitacaoInput) {
    const vit = input.vitals && Object.values(input.vitals).some((v) => v !== null && v !== undefined) ? input.vitals : null;
    const n = vit ? news2(vit) : null;
    const suporte: Suporte = { ventilacaoMecanica: !!input.support?.ventilacaoMecanica, drogaVasoativa: !!input.support?.drogaVasoativa, oxigenio: !!input.support?.oxigenio, dialise: !!input.support?.dialise };
    const sugerida = prioridadeLeitoSugerida(n, suporte, input.bedKind, !!input.elective);
    return { vitals: vit, news: n, suporte, sugerida };
  }

  /** Solicitação de vaga a partir da unidade de origem (UPA, UBS, hospital sem o serviço). */
  async solicitar(ctx: RequestContext, input: SolicitacaoInput) {
    const patient = await ctx.db.patient.findUnique({ where: { id: input.patientId }, select: { id: true, mergedIntoId: true } });
    if (!patient || patient.mergedIntoId) throw notFound('Paciente');
    if (input.encounterId) {
      const e = await ctx.db.encounter.findUnique({ where: { id: input.encounterId }, select: { patientId: true } });
      if (!e || e.patientId !== input.patientId) throw notFound('Atendimento');
    }
    const aberta = await ctx.db.bedRequest.findFirst({ where: { patientId: input.patientId, status: { in: STATUS_LEITO_ABERTOS } }, select: { protocol: true } });
    if (aberta) throw new DomainError('SOLICITACAO_ABERTA', `Esta pessoa já tem uma solicitação de vaga em andamento (${aberta.protocol})`, HttpStatus.CONFLICT);
    const internado = await ctx.db.admission.findFirst({ where: { patientId: input.patientId, dischargedAt: null }, select: { id: true } });
    if (internado && !input.elective) {
      const leito = await ctx.db.admission.findUnique({ where: { id: internado.id }, select: { bed: { select: { ward: { select: { unitId: true } } } } } });
      if (leito?.bed?.ward.unitId !== ctx.session.unitId) throw new DomainError('JA_INTERNADO', 'A pessoa já está internada em outra unidade da rede', HttpStatus.CONFLICT);
    }
    const { vitals, news, suporte, sugerida } = this.avaliar(input);
    const priority = input.priority ?? sugerida;
    const gravar = (protocol: string) =>
      ctx.db.$transaction(async (tx) => {
        const created = await tx.bedRequest.create({
          data: {
            protocol,
            patientId: input.patientId,
            encounterId: input.encounterId ?? null,
            originUnitId: ctx.session.unitId,
            requesterId: ctx.session.userId,
            requesterCbo: ctx.cbo,
            bedKind: input.bedKind,
            specialty: input.specialty.trim(),
            priority,
            requestedPriority: priority,
            cid: input.cid?.toUpperCase().replace('.', '') || null,
            clinicalSummary: input.clinicalSummary.trim(),
            vitals: vitals ? (vitals as object) : undefined,
            support: suporte as object,
            news2: news?.pontos ?? null,
            isolation: input.isolation ?? 'NENHUM',
            elective: !!input.elective,
            procedureCode: input.procedureCode?.replace(/\D/g, '') || null,
            externalCode: input.externalCode?.trim() || null,
          },
        });
        await tx.bedRequestEvent.create({
          data: {
            requestId: created.id,
            kind: 'CRIADA',
            toStatus: 'PENDENTE',
            userId: ctx.session.userId,
            role: ctx.session.role,
            notes: `${TIPO_LEITO[input.bedKind]} · ${input.specialty.trim()} · ${PRIORIDADE_LEITO[priority].label}${news ? ` · NEWS2 ${news.pontos}` : ''}`,
          },
        });
        await this.audit.record(ctx, tx, { action: 'leitos_rede.solicitar', entityType: 'BedRequest', entityId: created.id, payload: { protocol, bedKind: input.bedKind, priority, news2: news?.pontos ?? null } });
        await this.rnds(ctx, tx, created.id, 'PENDENTE', 'CRIADA');
        return created;
      });
    // Dois pedidos ao mesmo tempo podem disputar o mesmo número: tenta o seguinte quando o índice único recusa.
    const ano = anoDoProtocolo(ctx.tenant.timeZone);
    const r = await gravarComProtocolo((salto) => this.proximoProtocolo(ctx, ano, salto), gravar, {
      mensagem: 'Não foi possível gerar o número da solicitação; tente de novo',
    });
    this.realtime.emitToTenant(ctx.tenant.id, 'leitos_rede.fila', { id: r.id, protocol: r.protocol, priority });
    return this.detalhe(ctx, r.id);
  }

  /** Complementação após devolução: volta para a fila mantendo a data original. */
  async complementar(ctx: RequestContext, id: string, input: Partial<SolicitacaoInput> & { notes?: string | null }) {
    const r = await this.carregar(ctx, id);
    this.exigirSolicitante(ctx, r);
    if (r.status !== 'DEVOLVIDA' && r.status !== 'PENDENTE')
      throw new DomainError('SITUACAO_INVALIDA', `Não é possível alterar uma solicitação ${STATUS_SOLICITACAO_LEITO[r.status].toLowerCase()}`, HttpStatus.UNPROCESSABLE_ENTITY);
    const base: SolicitacaoInput = {
      patientId: r.patientId,
      bedKind: (input.bedKind ?? r.bedKind) as TipoLeito,
      specialty: input.specialty ?? r.specialty,
      cid: input.cid ?? r.cid,
      clinicalSummary: input.clinicalSummary ?? r.clinicalSummary,
      vitals: input.vitals === undefined ? (r.vitals as SinaisVitais | null) : input.vitals,
      support: input.support === undefined ? (r.support as Suporte) : input.support,
      isolation: (input.isolation ?? r.isolation) as Isolation,
      elective: input.elective ?? r.elective,
      priority: input.priority ?? null,
    };
    const { vitals, news, suporte, sugerida } = this.avaliar(base);
    const priority = input.priority ?? (r.status === 'DEVOLVIDA' ? sugerida : r.priority);
    await ctx.db.$transaction(async (tx) => {
      await tx.bedRequest.update({
        where: { id },
        data: {
          bedKind: base.bedKind,
          specialty: base.specialty.trim(),
          cid: base.cid?.toUpperCase().replace('.', '') || null,
          clinicalSummary: base.clinicalSummary.trim(),
          vitals: vitals ? (vitals as object) : Prisma.JsonNull,
          support: suporte as object,
          news2: news?.pontos ?? null,
          isolation: base.isolation,
          elective: !!base.elective,
          priority,
          requestedPriority: priority,
          status: 'PENDENTE',
          decisionReason: null,
          ...(input.procedureCode !== undefined ? { procedureCode: input.procedureCode?.replace(/\D/g, '') || null } : {}),
          ...(input.externalCode !== undefined ? { externalCode: input.externalCode?.trim() || null } : {}),
        },
      });
      await tx.bedRequestEvent.create({
        data: {
          requestId: id,
          kind: r.status === 'DEVOLVIDA' ? 'COMPLEMENTADA' : 'ATUALIZADA',
          fromStatus: r.status,
          toStatus: 'PENDENTE',
          userId: ctx.session.userId,
          role: ctx.session.role,
          notes: input.notes?.trim() || (news ? `NEWS2 ${news.pontos}` : null),
        },
      });
      await this.audit.record(ctx, tx, { action: 'leitos_rede.complementar', entityType: 'BedRequest', entityId: id, payload: { protocol: r.protocol } });
      await this.rnds(ctx, tx, id, 'PENDENTE', r.status === 'DEVOLVIDA' ? 'COMPLEMENTADA' : 'ATUALIZADA');
    });
    this.realtime.emitToTenant(ctx.tenant.id, 'leitos_rede.fila', { id, protocol: r.protocol, priority });
    return this.detalhe(ctx, id);
  }

  private async carregar(ctx: RequestContext, id: string) {
    const r = await ctx.db.bedRequest.findUnique({ where: { id } });
    if (!r) throw notFound('Solicitação de vaga');
    return r;
  }

  private exigirSolicitante(ctx: RequestContext, r: { originUnitId: string }) {
    if (r.originUnitId !== ctx.session.unitId && !roleHasPermission(ctx.session.role, 'leitos_rede.regular')) throw forbidden('A solicitação pertence a outra unidade');
  }

  private exigir(r: { status: StatusSolicitacaoLeito }, permitidos: StatusSolicitacaoLeito[], acao: string) {
    if (!permitidos.includes(r.status)) throw new DomainError('SITUACAO_INVALIDA', `Não é possível ${acao} uma solicitação ${STATUS_SOLICITACAO_LEITO[r.status].toLowerCase()}`, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private async transicao(
    ctx: RequestContext,
    r: { id: string; protocol: string; status: StatusSolicitacaoLeito; originUnitId: string; destinationUnitId: string | null },
    to: StatusSolicitacaoLeito,
    kind: string,
    data: Prisma.BedRequestUncheckedUpdateInput,
    notes: string | null,
    audit: string,
    tx?: Prisma.TransactionClient,
  ) {
    const run = async (t: Prisma.TransactionClient) => {
      await t.bedRequest.update({ where: { id: r.id }, data: { status: to, ...data } });
      await t.bedRequestEvent.create({ data: { requestId: r.id, kind, fromStatus: r.status, toStatus: to, userId: ctx.session.userId, role: ctx.session.role, notes } });
      await this.audit.record(ctx, t, { action: audit, entityType: 'BedRequest', entityId: r.id, payload: { protocol: r.protocol, from: r.status, to, notes } });
      if (to !== r.status || kind === 'AUTORIZADA') await this.rnds(ctx, t, r.id, to, kind);
    };
    if (tx) await run(tx);
    else await ctx.db.$transaction(run);
    const payload = { id: r.id, protocol: r.protocol, status: to };
    this.realtime.emitToUnit(ctx.tenant.id, r.originUnitId, 'leitos_rede.atualizado', payload);
    const dest = (data.destinationUnitId as string | undefined) ?? r.destinationUnitId;
    if (dest && dest !== r.originUnitId) this.realtime.emitToUnit(ctx.tenant.id, dest, 'leitos_rede.atualizado', payload);
    this.realtime.emitToTenant(ctx.tenant.id, 'leitos_rede.fila', payload);
  }

  /** Regulador assume a análise (tira da fila "pendente" sem decidir). */
  async analisar(ctx: RequestContext, id: string) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, ['PENDENTE'], 'analisar');
    await this.transicao(ctx, r, 'EM_ANALISE', 'EM_ANALISE', { regulatorId: ctx.session.userId }, null, 'leitos_rede.analisar');
    return this.detalhe(ctx, id);
  }

  /** Devolve à origem com pendência (exames, dados clínicos, estabilização). */
  async devolver(ctx: RequestContext, id: string, reason: string) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, STATUS_LEITO_NA_FILA, 'devolver');
    await this.transicao(
      ctx,
      r,
      'DEVOLVIDA',
      'DEVOLVIDA',
      { regulatorId: ctx.session.userId, decisionAt: new Date(), decisionReason: reason.trim(), returnedCount: { increment: 1 } },
      reason.trim(),
      'leitos_rede.devolver',
    );
    return this.detalhe(ctx, id);
  }

  /** Pedido de segunda avaliação a outro regulador (fica registrado; a decisão continua liberada). */
  async pedirSegundaAvaliacao(ctx: RequestContext, id: string, notes: string) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, STATUS_LEITO_NA_FILA, 'pedir segunda avaliação em');
    await this.transicao(
      ctx,
      r,
      'EM_ANALISE',
      'SEGUNDA_AVALIACAO_PEDIDA',
      { regulatorId: ctx.session.userId, secondOpinionAt: null, secondOpinionBy: null, secondOpinionNotes: null },
      notes.trim(),
      'leitos_rede.segunda_avaliacao.pedir',
    );
    return this.detalhe(ctx, id);
  }

  async segundaAvaliacao(ctx: RequestContext, id: string, notes: string, prioridade?: PrioridadeRegulacao | null) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, STATUS_LEITO_NA_FILA, 'registrar segunda avaliação em');
    if (r.regulatorId === ctx.session.userId) throw new DomainError('MESMO_REGULADOR', 'A segunda avaliação deve ser de outro regulador', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.transicao(
      ctx,
      r,
      r.status,
      'SEGUNDA_AVALIACAO',
      { secondOpinionAt: new Date(), secondOpinionBy: ctx.session.userId, secondOpinionNotes: notes.trim(), ...(prioridade ? { priority: prioridade } : {}) },
      `${notes.trim()}${prioridade && prioridade !== r.priority ? ` · prioridade ${PRIORIDADE_LEITO[r.priority].label} → ${PRIORIDADE_LEITO[prioridade].label}` : ''}`,
      'leitos_rede.segunda_avaliacao',
    );
    return this.detalhe(ctx, id);
  }

  /** Autoriza a vaga: unidade e tipo de leito de destino, leito reservado (opcional), transporte e reclassificação. */
  async autorizar(ctx: RequestContext, id: string, input: AutorizacaoInput) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, [...STATUS_LEITO_NA_FILA, 'AUTORIZADA'], 'autorizar');
    const unit = await ctx.db.unit.findUnique({ where: { id: input.destinationUnitId }, select: { id: true, name: true, type: true } });
    if (!unit) throw notFound('Unidade de destino');
    if (unit.type !== 'HOSPITAL' && unit.type !== 'UPA') throw new DomainError('DESTINO_INVALIDO', 'O destino precisa ser um hospital ou UPA com leitos', HttpStatus.UNPROCESSABLE_ENTITY);
    if (input.bedId) {
      const bed = await ctx.db.bed.findUnique({ where: { id: input.bedId }, include: { ward: true } });
      if (!bed) throw notFound('Leito');
      if (bed.ward.unitId !== unit.id) throw new DomainError('LEITO_DE_OUTRA_UNIDADE', 'O leito não pertence à unidade de destino', HttpStatus.UNPROCESSABLE_ENTITY);
      if (bed.isolation !== 'NENHUM' && bed.isolation !== r.isolation) throw new DomainError('ISOLAMENTO_INCOMPATIVEL', `Leito em isolamento por ${bed.isolation.toLowerCase()}`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const priority = input.priority ?? r.priority;
    const censo: { unitId: string; code: string }[] = [];
    await ctx.db.$transaction(async (tx) => {
      if (r.reservedBedId && r.reservedBedId !== input.bedId) {
        const lib = await this.beds.liberarReserva(tx, ctx, r.reservedBedId, `Reserva trocada (${r.protocol})`);
        if (lib) censo.push(lib);
      }
      if (input.bedId && input.bedId !== r.reservedBedId) censo.push(await this.beds.reservar(tx, ctx, input.bedId, `Reserva ${r.protocol} (${TIPO_LEITO[input.destinationKind]})`));
      await this.transicao(
        ctx,
        r,
        'AUTORIZADA',
        'AUTORIZADA',
        {
          regulatorId: ctx.session.userId,
          decisionAt: new Date(),
          decisionReason: input.notes.trim(),
          destinationUnitId: unit.id,
          destinationKind: input.destinationKind,
          reservedBedId: input.bedId ?? null,
          transport: input.transport ?? null,
          priority,
        },
        `${unit.name} · ${TIPO_LEITO[input.destinationKind]}${input.bedId ? ' · leito reservado' : ''}${input.transport ? ` · ${TRANSPORTE_TRANSFERENCIA[input.transport]}` : ''}${priority !== r.priority ? ` · prioridade ${PRIORIDADE_LEITO[r.priority].label} → ${PRIORIDADE_LEITO[priority].label}` : ''} · ${input.notes.trim()}`,
        'leitos_rede.autorizar',
        tx,
      );
    });
    for (const c of censo) this.beds.notificarCenso(ctx, c.unitId, { code: c.code, reserva: r.protocol });
    return this.detalhe(ctx, id);
  }

  async negar(ctx: RequestContext, id: string, reason: string) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, STATUS_LEITO_NA_FILA, 'negar');
    await this.transicao(ctx, r, 'NEGADA', 'NEGADA', { regulatorId: ctx.session.userId, decisionAt: new Date(), decisionReason: reason.trim(), closedAt: new Date() }, reason.trim(), 'leitos_rede.negar');
    return this.detalhe(ctx, id);
  }

  /** Origem (ou central) registra a saída do paciente: transporte, horário e observações. */
  async transferir(ctx: RequestContext, id: string, input: { transport: TransporteTransferencia; transferAt?: string | null; notes?: string | null }) {
    const r = await this.carregar(ctx, id);
    this.exigirSolicitante(ctx, r);
    this.exigir(r, ['AUTORIZADA'], 'transferir');
    const quando = input.transferAt ? new Date(input.transferAt) : new Date();
    await this.transicao(
      ctx,
      r,
      'EM_TRANSFERENCIA',
      'EM_TRANSFERENCIA',
      { transport: input.transport, transferAt: quando, transferNotes: input.notes?.trim() || null },
      `${TRANSPORTE_TRANSFERENCIA[input.transport]} · saída ${formatDateTime(quando, ctx.tenant.timeZone)}${input.notes ? ` · ${input.notes.trim()}` : ''}`,
      'leitos_rede.transferir',
    );
    return this.detalhe(ctx, id);
  }

  /** Destino interna o paciente no leito (reservado ou outro vago da unidade autorizada). */
  async internar(ctx: RequestContext, id: string, input: { bedId?: string | null; mainCid?: string | null; isolation?: Isolation | null }) {
    const r = await this.carregar(ctx, id);
    this.exigir(r, ['AUTORIZADA', 'EM_TRANSFERENCIA'], 'internar');
    if (r.destinationUnitId !== ctx.session.unitId && !roleHasPermission(ctx.session.role, 'leitos_rede.regular')) throw forbidden('A internação é registrada pela unidade de destino');
    const bedId = input.bedId ?? r.reservedBedId;
    if (!bedId) throw new DomainError('LEITO_OBRIGATORIO', 'Escolha o leito da internação', HttpStatus.UNPROCESSABLE_ENTITY);
    const mainCid = (input.mainCid ?? r.cid ?? '').toUpperCase().replace('.', '');
    if (mainCid.length < 3) throw new DomainError('CID_OBRIGATORIO', 'Informe o CID principal da internação', HttpStatus.UNPROCESSABLE_ENTITY);
    const admission = await this.beds.admit(ctx, { patientId: r.patientId, bedId, mainCid, isolation: (input.isolation ?? r.isolation) as Isolation, bedRequestId: r.id });
    if (r.reservedBedId && r.reservedBedId !== bedId) {
      await ctx.db.$transaction(async (tx) => {
        const lib = await this.beds.liberarReserva(tx, ctx, r.reservedBedId!, `Internação em outro leito (${r.protocol})`);
        if (lib) this.beds.notificarCenso(ctx, lib.unitId, { code: lib.code, reserva: null });
      });
    }
    return { admissionId: admission.id, solicitacao: await this.detalhe(ctx, id) };
  }

  async cancelar(ctx: RequestContext, id: string, reason: string) {
    const r = await this.carregar(ctx, id);
    this.exigirSolicitante(ctx, r);
    this.exigir(r, STATUS_LEITO_ABERTOS, 'cancelar');
    const libs: { unitId: string; code: string }[] = [];
    await ctx.db.$transaction(async (tx) => {
      if (r.reservedBedId) {
        const lib = await this.beds.liberarReserva(tx, ctx, r.reservedBedId, `Solicitação cancelada (${r.protocol})`);
        if (lib) libs.push(lib);
      }
      await this.transicao(ctx, r, 'CANCELADA', 'CANCELADA', { closedAt: new Date(), reservedBedId: null }, reason.trim(), 'leitos_rede.cancelar', tx);
    });
    for (const lib of libs) this.beds.notificarCenso(ctx, lib.unitId, { code: lib.code, reserva: null });
    return this.detalhe(ctx, id);
  }

  /** Código da mesma solicitação no SISREG / e-SUS Regulação (conciliação quando o município usa os dois). */
  async codigoExterno(ctx: RequestContext, id: string, externalCode: string | null) {
    const r = await this.carregar(ctx, id);
    await ctx.db.bedRequest.update({ where: { id }, data: { externalCode: externalCode?.trim() || null } });
    await this.audit.recordStandalone(ctx, { action: 'leitos_rede.codigo_externo', entityType: 'BedRequest', entityId: id, payload: { protocol: r.protocol, externalCode } });
    return this.detalhe(ctx, id);
  }

  async mensagem(ctx: RequestContext, id: string, notes: string) {
    const r = await this.carregar(ctx, id);
    this.exigirSolicitante(ctx, r);
    await ctx.db.bedRequestEvent.create({ data: { requestId: id, kind: 'MENSAGEM', userId: ctx.session.userId, role: ctx.session.role, notes: notes.trim() } });
    await this.audit.recordStandalone(ctx, { action: 'leitos_rede.mensagem', entityType: 'BedRequest', entityId: id, payload: { protocol: r.protocol } });
    this.realtime.emitToUnit(ctx.tenant.id, r.originUnitId, 'leitos_rede.atualizado', { id, protocol: r.protocol, status: r.status, mensagem: true });
    return this.detalhe(ctx, id);
  }

  // ───────────────────────────── Consultas ─────────────────────────────

  private async nomes(
    ctx: RequestContext,
    rows: { originUnitId: string; destinationUnitId: string | null; requesterId: string; regulatorId: string | null; secondOpinionBy: string | null; events?: { userId: string }[] }[],
  ) {
    const unitIds = new Set<string>();
    const userIds = new Set<string>();
    for (const r of rows) {
      unitIds.add(r.originUnitId);
      if (r.destinationUnitId) unitIds.add(r.destinationUnitId);
      userIds.add(r.requesterId);
      if (r.regulatorId) userIds.add(r.regulatorId);
      if (r.secondOpinionBy) userIds.add(r.secondOpinionBy);
      for (const e of r.events ?? []) userIds.add(e.userId);
    }
    const [units, users] = await Promise.all([
      ctx.db.unit.findMany({ where: { id: { in: [...unitIds] } }, select: { id: true, name: true, type: true } }),
      ctx.db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, socialName: true } }),
    ]);
    return { units: new Map(units.map((u) => [u.id, u])), users: new Map(users.map((u) => [u.id, u.socialName ?? u.name])) };
  }

  private view(r: Row, nomes: Awaited<ReturnType<BedRegulationService['nomes']>>, agora = new Date()) {
    const naFila = STATUS_LEITO_NA_FILA.includes(r.status);
    const prazo = prazoMetaLeito(r.priority, r.createdAt);
    const vitals = (r.vitals ?? null) as SinaisVitais | null;
    return {
      id: r.id,
      protocol: r.protocol,
      status: r.status,
      statusLabel: STATUS_SOLICITACAO_LEITO[r.status],
      patient: { ...patientSummary(r.patient), phone: r.patient.phone },
      encounterId: r.encounterId,
      originUnit: { id: r.originUnitId, name: nomes.units.get(r.originUnitId)?.name ?? null },
      requester: { id: r.requesterId, name: nomes.users.get(r.requesterId) ?? null, cbo: r.requesterCbo },
      bedKind: r.bedKind,
      bedKindLabel: TIPO_LEITO[r.bedKind as TipoLeito],
      specialty: r.specialty,
      priority: r.priority,
      priorityLabel: PRIORIDADE_LEITO[r.priority].label,
      requestedPriority: r.requestedPriority,
      cid: r.cid,
      clinicalSummary: r.clinicalSummary,
      vitals,
      news2: vitals ? news2(vitals) : null,
      support: r.support as Suporte,
      isolation: r.isolation,
      elective: r.elective,
      prazoMeta: prazo.toISOString(),
      horasEmFila: horasEmFila(r.createdAt, naFila ? agora : (r.decisionAt ?? r.closedAt ?? r.updatedAt)),
      atrasada: naFila && prazo.getTime() < agora.getTime(),
      regulator: r.regulatorId ? { id: r.regulatorId, name: nomes.users.get(r.regulatorId) ?? null } : null,
      decision: r.decisionAt ? { at: r.decisionAt.toISOString(), reason: r.decisionReason } : null,
      secondOpinion: r.secondOpinionAt
        ? { at: r.secondOpinionAt.toISOString(), by: r.secondOpinionBy ? (nomes.users.get(r.secondOpinionBy) ?? null) : null, notes: r.secondOpinionNotes }
        : r.events.some((e) => e.kind === 'SEGUNDA_AVALIACAO_PEDIDA') && naFila
          ? { at: null, by: null, notes: null }
          : null,
      destination: r.destinationUnitId
        ? {
            unitId: r.destinationUnitId,
            unitName: nomes.units.get(r.destinationUnitId)?.name ?? null,
            kind: r.destinationKind,
            kindLabel: r.destinationKind ? TIPO_LEITO[r.destinationKind as TipoLeito] : null,
            bed: r.reservedBed ? { id: r.reservedBed.id, code: r.reservedBed.code, ward: r.reservedBed.ward.name } : null,
          }
        : null,
      transport: r.transport,
      transportLabel: r.transport ? (TRANSPORTE_TRANSFERENCIA[r.transport as TransporteTransferencia] ?? r.transport) : null,
      transferAt: r.transferAt?.toISOString() ?? null,
      transferNotes: r.transferNotes,
      admissionId: r.admissionId,
      procedureCode: r.procedureCode,
      externalCode: r.externalCode,
      returnedCount: r.returnedCount,
      createdAt: r.createdAt.toISOString(),
      closedAt: r.closedAt?.toISOString() ?? null,
      eventos: r.events.map((e) => ({
        id: e.id,
        kind: e.kind,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        notes: e.notes,
        at: e.at.toISOString(),
        usuario: nomes.users.get(e.userId) ?? null,
        role: e.role,
        roleLabel: ROLE_LABELS[e.role],
      })),
    };
  }

  async detalhe(ctx: RequestContext, id: string) {
    const r = await ctx.db.bedRequest.findUnique({ where: { id }, include });
    if (!r) throw notFound('Solicitação de vaga');
    const regula = roleHasPermission(ctx.session.role, 'leitos_rede.regular');
    if (!regula && r.originUnitId !== ctx.session.unitId && r.destinationUnitId !== ctx.session.unitId && !roleHasPermission(ctx.session.role, 'prontuario.ler')) throw forbidden('Solicitação de outra unidade');
    return this.view(r, await this.nomes(ctx, [r]));
  }

  async listar(ctx: RequestContext, q: { status?: StatusSolicitacaoLeito; patientId?: string; unitId?: string; escopo?: 'unidade' | 'central' }) {
    const regula = roleHasPermission(ctx.session.role, 'leitos_rede.regular');
    const unitId = q.unitId ?? ctx.session.unitId;
    const where: Prisma.BedRequestWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.patientId ? { patientId: q.patientId } : {}),
      ...(q.patientId || (regula && q.escopo !== 'unidade') ? {} : { OR: [{ originUnitId: unitId }, { destinationUnitId: unitId }] }),
    };
    const rows = await ctx.db.bedRequest.findMany({ where, include, orderBy: [{ createdAt: 'desc' }], take: 300 });
    const nomes = await this.nomes(ctx, rows);
    return rows.map((r) => this.view(r, nomes));
  }

  /** Fila da central: solicitações pendentes/em análise, por prioridade e tempo de espera. */
  async fila(ctx: RequestContext, q: { bedKind?: TipoLeito; priority?: PrioridadeRegulacao }) {
    const rows = await ctx.db.bedRequest.findMany({ where: { status: { in: STATUS_LEITO_NA_FILA }, ...(q.bedKind ? { bedKind: q.bedKind } : {}), ...(q.priority ? { priority: q.priority } : {}) }, include });
    const nomes = await this.nomes(ctx, rows);
    const itens = ordenarFilaLeitos(rows).map((r) => this.view(r, nomes));
    const porPrioridade = { VERMELHA: 0, AMARELA: 0, VERDE: 0, AZUL: 0 } as Record<PrioridadeRegulacao, number>;
    for (const i of itens) porPrioridade[i.priority]++;
    return { itens, total: itens.length, porPrioridade, atrasadas: itens.filter((i) => i.atrasada).length };
  }

  /** Mapa de leitos da rede: por hospital/UPA, totais por situação e vagos por tipo de leito. */
  async mapa(ctx: RequestContext) {
    const units = await ctx.db.unit.findMany({ where: { active: true, type: { in: ['HOSPITAL', 'UPA'] } }, orderBy: { name: 'asc' }, select: { id: true, name: true, type: true, cnes: true } });
    const pendentesDestino = await ctx.db.bedRequest.groupBy({ by: ['destinationUnitId'], where: { status: { in: ['AUTORIZADA', 'EM_TRANSFERENCIA'] } }, _count: { _all: true } });
    const aCaminho = new Map(pendentesDestino.map((p) => [p.destinationUnitId, p._count._all]));
    const unidades = [];
    for (const u of units) {
      const censo = await this.beds.census(ctx, u.id);
      const porTipo: Record<string, { tipo: string; label: string; total: number; vagos: number; ocupados: number; reservados: number; higienizacao: number; bloqueados: number }> = {};
      for (const w of censo.wards) {
        const t = (porTipo[w.kind] ??= { tipo: w.kind, label: TIPO_LEITO[w.kind as TipoLeito] ?? w.kind, total: 0, vagos: 0, ocupados: 0, reservados: 0, higienizacao: 0, bloqueados: 0 });
        for (const b of w.beds) {
          t.total++;
          if (b.status === 'VAGO') t.vagos++;
          else if (b.status === 'OCUPADO') t.ocupados++;
          else if (b.status === 'RESERVADO') t.reservados++;
          else if (b.status === 'HIGIENIZACAO') t.higienizacao++;
          else t.bloqueados++;
        }
      }
      unidades.push({
        unit: { id: u.id, name: u.name, type: u.type, cnes: u.cnes },
        totals: censo.totals,
        occupancyRate: censo.occupancyRate,
        porTipo: Object.values(porTipo),
        aCaminho: aCaminho.get(u.id) ?? 0,
        leitosVagos: censo.wards.flatMap((w) => w.beds.filter((b) => b.status === 'VAGO').map((b) => ({ id: b.id, code: b.code, ward: w.name, kind: w.kind, isolation: b.isolation }))),
      });
    }
    const totais = unidades.reduce(
      (a, u) => ({
        total: a.total + u.totals.total,
        vagos: a.vagos + u.totals.VAGO,
        ocupados: a.ocupados + u.totals.OCUPADO,
        reservados: a.reservados + u.totals.RESERVADO,
        bloqueados: a.bloqueados + u.totals.BLOQUEADO,
        higienizacao: a.higienizacao + u.totals.HIGIENIZACAO,
      }),
      { total: 0, vagos: 0, ocupados: 0, reservados: 0, bloqueados: 0, higienizacao: 0 },
    );
    const operacionais = totais.total - totais.bloqueados;
    return { unidades, totais: { ...totais, ocupacao: operacionais > 0 ? Math.round((totais.ocupados / operacionais) * 1000) / 10 : 0 } };
  }

  /** Painel: fila, decisões do mês, tempo médio até a autorização e até a internação. */
  async painel(ctx: RequestContext) {
    const desde = new Date(Date.now() - 30 * 86_400_000);
    const [porStatus, decididas, internadas] = await Promise.all([
      ctx.db.bedRequest.groupBy({ by: ['status'], _count: { _all: true } }),
      ctx.db.bedRequest.findMany({ where: { decisionAt: { gte: desde }, status: { in: ['AUTORIZADA', 'EM_TRANSFERENCIA', 'INTERNADA', 'NEGADA'] } }, select: { createdAt: true, decisionAt: true, status: true } }),
      ctx.db.bedRequest.findMany({ where: { status: 'INTERNADA', closedAt: { gte: desde } }, select: { createdAt: true, closedAt: true } }),
    ]);
    const contagem = Object.fromEntries(Object.keys(STATUS_SOLICITACAO_LEITO).map((k) => [k, 0])) as Record<StatusSolicitacaoLeito, number>;
    for (const p of porStatus) contagem[p.status] = p._count._all;
    const media = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    return {
      porStatus: contagem,
      naFila: STATUS_LEITO_NA_FILA.reduce((s, k) => s + contagem[k], 0),
      ultimos30Dias: {
        autorizadas: decididas.filter((d) => d.status !== 'NEGADA').length,
        negadas: decididas.filter((d) => d.status === 'NEGADA').length,
        internadas: internadas.length,
        horasAteDecisao: media(decididas.map((d) => horasEmFila(d.createdAt, d.decisionAt!))),
        horasAteInternacao: media(internadas.map((d) => horasEmFila(d.createdAt, d.closedAt!))),
      },
    };
  }

  /** Ficha de solicitação/transferência para acompanhar o paciente (impressa na origem ou na central). */
  async fichaPdf(ctx: RequestContext, id: string): Promise<{ data: Buffer; fileName: string }> {
    const r = await this.detalhe(ctx, id);
    const [unit, requester, assignment, signer, patient] = await Promise.all([
      ctx.db.unit.findUniqueOrThrow({ where: { id: r.originUnit.id } }),
      ctx.db.user.findUniqueOrThrow({ where: { id: r.requester.id }, select: { name: true, socialName: true } }),
      ctx.db.userAssignment.findFirst({ where: { userId: r.requester.id, unitId: r.originUnit.id }, select: { council: true, role: true } }),
      ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId }, select: { name: true, cpf: true } }),
      ctx.db.patient.findUniqueOrThrow({ where: { id: r.patient.id } }),
    ]);
    const v = r.vitals;
    const vit = v
      ? [
          v.pas != null ? `PA ${v.pas}/${v.pad ?? '—'}` : null,
          v.fc != null ? `FC ${v.fc}` : null,
          v.fr != null ? `FR ${v.fr}` : null,
          v.sato2 != null ? `SatO2 ${v.sato2}%` : null,
          v.temp != null ? `T ${v.temp}°C` : null,
          v.consciencia ? `consciência: ${v.consciencia.toLowerCase()}` : null,
          v.oxigenio ? 'em O2' : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : 'Não informados';
    const sup = Object.entries(r.support)
      .filter(([, on]) => on)
      .map(([k]) => ({ ventilacaoMecanica: 'ventilação mecânica', drogaVasoativa: 'droga vasoativa', oxigenio: 'oxigênio', dialise: 'diálise' })[k] ?? k);
    const model: DocumentModel = {
      title: 'Solicitação de vaga / transferência (central de leitos)',
      unit: { name: unit.name, cnes: unit.cnes, address: unit.address },
      patient: { name: patient.socialName ?? patient.name, cpf: patient.cpf, cns: patient.cns, birthDate: patient.birthDate },
      professional: { name: requester.socialName ?? requester.name, council: assignment?.council ?? null, cbo: r.requester.cbo, roleLabel: ROLE_LABELS[assignment?.role ?? 'MEDICO'] },
      issuedAt: new Date(),
      timeZone: ctx.tenant.timeZone,
      sections: [
        {
          heading: 'Solicitação',
          paragraphs: [`${r.protocol} · ${r.bedKindLabel} · ${r.specialty} · prioridade ${r.priorityLabel} (${PRIORIDADE_LEITO[r.priority].prazoHoras} h)${r.elective ? ' · eletiva' : ''}`, `Situação: ${r.statusLabel}`],
        },
        {
          heading: 'Quadro clínico',
          paragraphs: [
            `${r.cid ? `CID-10 ${r.cid} · ` : ''}${r.clinicalSummary}`,
            `Sinais vitais: ${vit}${r.news2 ? ` · NEWS2 ${r.news2.pontos} (${r.news2.risco.toLowerCase().replace('_', '-')})` : ''}`,
            `Suporte: ${sup.length ? sup.join(', ') : 'nenhum'} · isolamento: ${r.isolation.toLowerCase()}`,
          ],
        },
        {
          heading: 'Regulação',
          paragraphs: r.decision
            ? [
                `${formatDateTime(new Date(r.decision.at), ctx.tenant.timeZone)}${r.regulator?.name ? ` · ${r.regulator.name}` : ''}: ${r.decision.reason ?? ''}`,
                ...(r.secondOpinion?.at ? [`Segunda avaliação (${r.secondOpinion.by ?? ''}): ${r.secondOpinion.notes ?? ''}`] : []),
              ]
            : ['Aguardando a central de leitos.'],
        },
        {
          heading: 'Destino e transporte',
          paragraphs: r.destination
            ? [
                `${r.destination.unitName ?? ''} · ${r.destination.kindLabel ?? ''}${r.destination.bed ? ` · leito ${r.destination.bed.code} (${r.destination.bed.ward})` : ''}`,
                `${r.transportLabel ?? 'Transporte a definir'}${r.transferAt ? ` · saída ${formatDateTime(new Date(r.transferAt), ctx.tenant.timeZone)}` : ''}${r.transferNotes ? ` · ${r.transferNotes}` : ''}`,
              ]
            : ['Sem destino definido.'],
        },
      ],
      footer: [`Solicitação ${r.protocol} · emitida em ${formatDateTime(new Date(), ctx.tenant.timeZone)} por ${signer.name}`],
      signer: { name: signer.name, cpf: signer.cpf },
    };
    const data = await renderDocument(model);
    await this.audit.recordStandalone(ctx, { action: 'leitos_rede.ficha_pdf', entityType: 'BedRequest', entityId: id, payload: { protocol: r.protocol } });
    return { data, fileName: `vaga-${r.protocol}.pdf` };
  }
}
