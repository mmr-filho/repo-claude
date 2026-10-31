import { HttpStatus, Injectable } from '@nestjs/common';
import { STATUS_MIRA, statusMiraAmbulatorial, statusMiraLeito, type FonteRegulacao, type StatusMira } from '@omnisaude/shared';
import { validateRndsBundle } from '@omnisaude/fhir';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { OutboxService } from '../../core/outbox.service';
import { IntegrationConfigService } from '../integrations/integration-config.service';
import { RndsService } from '../integrations/rnds.service';
import type { RegulacaoOutboxPayload } from '../integrations/rnds-regulacao';

const DIA = 86_400_000;

/**
 * Conferência do envio da regulação à RNDS (Portaria GM/MS 6.656/2025): painel, documentos gerados por
 * solicitação, pré-visualização do FHIR, reenvio e enfileiramento manual.
 */
@Injectable()
export class RegulationRndsService {
  constructor(
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly rnds: RndsService,
    private readonly integrations: IntegrationConfigService,
  ) {}

  private statusMira(payload: RegulacaoOutboxPayload): StatusMira {
    return payload.fonte === 'LEITO' ? statusMiraLeito(payload.status as never) : statusMiraAmbulatorial(payload.status as never, payload.evento);
  }

  /** Painel: fila por situação, atrasos frente à obrigação diária, último envio e configuração. */
  async painel(ctx: RequestContext) {
    const [grupos, ultimo, atrasados, cfg] = await Promise.all([
      ctx.db.outboxMessage.groupBy({ by: ['status'], _count: { _all: true }, where: { kind: 'RNDS_REGULACAO' } }),
      ctx.db.outboxMessage.findFirst({ where: { kind: 'RNDS_REGULACAO', status: 'ENVIADO' }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } }),
      ctx.db.outboxMessage.count({ where: { kind: 'RNDS_REGULACAO', status: { in: ['PENDENTE', 'ERRO'] }, createdAt: { lt: new Date(Date.now() - DIA) } } }),
      this.integrations.rnds(ctx.tenant.id),
    ]);
    const porStatus = { PENDENTE: 0, ENVIADO: 0, ERRO: 0, DESCARTADO: 0 } as Record<string, number>;
    for (const g of grupos) porStatus[g.status] = g._count._all;
    const [ambulatorial, leito] = await Promise.all([ctx.db.regulationRequest.count(), ctx.db.bedRequest.count()]);
    return {
      habilitado: ctx.tenant.settings.rndsEnabled,
      configurado: !!cfg,
      ambiente: cfg?.environment ?? null,
      regulatorCnes: cfg?.regulatorCnes ?? null,
      porStatus,
      atrasados,
      ultimoEnvio: ultimo?.sentAt?.toISOString() ?? null,
      solicitacoes: { ambulatorial, leito },
    };
  }

  /** Documentos gerados (um por mudança de situação), com a solicitação de origem. */
  async documentos(ctx: RequestContext, q: { status?: string; fonte?: FonteRegulacao; requestId?: string }) {
    const rows = await ctx.db.outboxMessage.findMany({
      where: { kind: 'RNDS_REGULACAO', ...(q.status ? { status: q.status as never } : {}), ...(q.requestId ? { aggregateId: q.requestId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const itens = rows.map((m) => ({ ...m, payload: m.payload as unknown as RegulacaoOutboxPayload })).filter((m) => !q.fonte || m.payload.fonte === q.fonte);
    const ambIds = itens.filter((m) => m.payload.fonte === 'AMBULATORIAL').map((m) => m.aggregateId);
    const leitoIds = itens.filter((m) => m.payload.fonte === 'LEITO').map((m) => m.aggregateId);
    const [amb, leitos] = await Promise.all([
      ambIds.length
        ? ctx.db.regulationRequest.findMany({
            where: { id: { in: ambIds } },
            select: { id: true, protocol: true, procedureName: true, status: true, patient: { select: { name: true, socialName: true, cpf: true, cns: true } } },
          })
        : [],
      leitoIds.length
        ? ctx.db.bedRequest.findMany({
            where: { id: { in: leitoIds } },
            select: { id: true, protocol: true, specialty: true, status: true, procedureCode: true, patient: { select: { name: true, socialName: true, cpf: true, cns: true } } },
          })
        : [],
    ]);
    const porId = new Map<string, { protocol: string; descricao: string; status: string; paciente: string; identificado: boolean }>();
    for (const r of amb) porId.set(r.id, { protocol: r.protocol, descricao: r.procedureName, status: r.status, paciente: r.patient.socialName ?? r.patient.name, identificado: !!(r.patient.cpf || r.patient.cns) });
    for (const r of leitos)
      porId.set(r.id, {
        protocol: r.protocol,
        descricao: `Vaga de leito · ${r.specialty}${r.procedureCode ? '' : ' · sem SIGTAP'}`,
        status: r.status,
        paciente: r.patient.socialName ?? r.patient.name,
        identificado: !!(r.patient.cpf || r.patient.cns),
      });
    return itens.map((m) => {
      const mira = this.statusMira(m.payload);
      return {
        id: m.id,
        requestId: m.aggregateId,
        fonte: m.payload.fonte,
        sequencia: m.payload.sequencia ?? null,
        statusLocal: m.payload.status,
        evento: m.payload.evento ?? null,
        statusMira: mira,
        statusMiraLabel: STATUS_MIRA[mira],
        alteradoEm: m.payload.at,
        envio: {
          status: m.status,
          attempts: m.attempts,
          lastError: m.lastError,
          externalId: m.externalId,
          sentAt: m.sentAt?.toISOString() ?? null,
          notBefore: m.notBefore.toISOString(),
          createdAt: m.createdAt.toISOString(),
        },
        solicitacao: porId.get(m.aggregateId) ?? null,
      };
    });
  }

  /** Monta e valida o documento FHIR sem enviar (conferência). */
  async previa(ctx: RequestContext, outboxId: string) {
    const m = await ctx.db.outboxMessage.findUnique({ where: { id: outboxId } });
    if (!m || m.kind !== 'RNDS_REGULACAO') throw notFound('Documento de regulação');
    const cfg = await this.integrations.rnds(ctx.tenant.id);
    try {
      const bundle = await this.rnds.buildBundle({ tenant: ctx.tenant, db: ctx.db }, m.kind, m.aggregateId, m.payload as Record<string, unknown>, cfg?.requesterId ?? ctx.tenant.id, m.id, cfg ?? undefined);
      return { ok: true, validacao: validateRndsBundle(bundle), bundle };
    } catch (err) {
      return { ok: false, erro: (err as Error).message, validacao: null, bundle: null };
    }
  }

  /** Recoloca na fila um documento com erro ou descartado (ex.: depois de completar o CPF ou o SIGTAP). */
  async reenviar(ctx: RequestContext, outboxId: string) {
    const m = await ctx.db.outboxMessage.findUnique({ where: { id: outboxId } });
    if (!m || m.kind !== 'RNDS_REGULACAO') throw notFound('Documento de regulação');
    if (m.status === 'ENVIADO') throw new DomainError('JA_ENVIADO', 'Documento já aceito pela RNDS; gere um novo a partir da solicitação', HttpStatus.UNPROCESSABLE_ENTITY);
    const updated = await ctx.db.outboxMessage.update({ where: { id: outboxId }, data: { status: 'PENDENTE', notBefore: new Date(), lastError: null } });
    await this.audit.recordStandalone(ctx, { action: 'regulacao.rnds.reenviar', entityType: 'OutboxMessage', entityId: outboxId, payload: { aggregateId: m.aggregateId } });
    return { id: updated.id, status: updated.status };
  }

  /** Gera um documento com a situação atual da solicitação (reenvio integral ou carga inicial). */
  async enfileirar(ctx: RequestContext, fonte: FonteRegulacao, requestId: string) {
    const r =
      fonte === 'LEITO'
        ? await ctx.db.bedRequest.findUnique({ where: { id: requestId }, select: { id: true, status: true, protocol: true } })
        : await ctx.db.regulationRequest.findUnique({ where: { id: requestId }, select: { id: true, status: true, protocol: true } });
    if (!r) throw notFound('Solicitação');
    const sequencia = (await ctx.db.outboxMessage.count({ where: { kind: 'RNDS_REGULACAO', aggregateId: requestId } })) + 1;
    const payload: RegulacaoOutboxPayload = { fonte, status: r.status, evento: 'REENVIO', at: new Date().toISOString(), unitId: ctx.session.unitId, sequencia };
    const m = await ctx.db.$transaction((tx) => this.outbox.enqueue(tx, 'RNDS_REGULACAO', requestId, payload as unknown as Record<string, unknown>));
    await this.audit.recordStandalone(ctx, { action: 'regulacao.rnds.enfileirar', entityType: 'OutboxMessage', entityId: m.id, payload: { protocol: r.protocol, fonte } });
    return { id: m.id, status: m.status };
  }

  /** Carga inicial: enfileira todas as solicitações que ainda não têm documento (Portaria 6.656: todos os registros). */
  async cargaInicial(ctx: RequestContext) {
    const existentes = new Set((await ctx.db.outboxMessage.findMany({ where: { kind: 'RNDS_REGULACAO' }, select: { aggregateId: true }, distinct: ['aggregateId'] })).map((m) => m.aggregateId));
    const [amb, leitos] = await Promise.all([ctx.db.regulationRequest.findMany({ select: { id: true, status: true } }), ctx.db.bedRequest.findMany({ select: { id: true, status: true } })]);
    let total = 0;
    await ctx.db.$transaction(async (tx) => {
      for (const r of amb.filter((x) => !existentes.has(x.id))) {
        await this.outbox.enqueue(tx, 'RNDS_REGULACAO', r.id, { fonte: 'AMBULATORIAL', status: r.status, evento: 'CARGA_INICIAL', at: new Date().toISOString(), unitId: ctx.session.unitId, sequencia: 1 });
        total++;
      }
      for (const r of leitos.filter((x) => !existentes.has(x.id))) {
        await this.outbox.enqueue(tx, 'RNDS_REGULACAO', r.id, { fonte: 'LEITO', status: r.status, evento: 'CARGA_INICIAL', at: new Date().toISOString(), unitId: ctx.session.unitId, sequencia: 1 });
        total++;
      }
    });
    await this.audit.recordStandalone(ctx, { action: 'regulacao.rnds.carga_inicial', entityType: 'OutboxMessage', entityId: ctx.tenant.id, payload: { total } });
    return { enfileirados: total };
  }

  /** Código da solicitação ambulatorial no SISREG / e-SUS Regulação. */
  async codigoExterno(ctx: RequestContext, id: string, externalCode: string | null) {
    const r = await ctx.db.regulationRequest.findUnique({ where: { id }, select: { id: true, protocol: true } });
    if (!r) throw notFound('Solicitação');
    await ctx.db.regulationRequest.update({ where: { id }, data: { externalCode: externalCode?.trim() || null } });
    await this.audit.recordStandalone(ctx, { action: 'regulacao.codigo_externo', entityType: 'RegulationRequest', entityId: id, payload: { protocol: r.protocol, externalCode } });
    return { id, externalCode: externalCode?.trim() || null };
  }
}
