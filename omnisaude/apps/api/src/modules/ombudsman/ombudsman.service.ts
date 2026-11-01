import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ASSUNTO_MANIFESTACAO,
  mascararTelefone,
  numeroProtocoloOuvidoria,
  prazoResposta,
  PRORROGACAO_DIAS,
  situacaoPrazo,
  STATUS_MANIFESTACAO,
  STATUS_MANIFESTACAO_ABERTA,
  TIPO_MANIFESTACAO,
  CANAL_MANIFESTACAO,
  type CanalManifestacao,
  type StatusManifestacao,
  type TipoManifestacao,
} from '@omnisaude/shared';
import { buildOmbudsmanUpdateTemplate, normalizeBrazilPhone } from '@omnisaude/messaging';
import { AuditService } from '../../core/audit.service';
import type { CitizenContext, RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { RealtimeService } from '../../core/realtime.service';
import { MessagingService, type SystemContext } from '../integrations/messaging.service';

export interface NovaManifestacao {
  kind: TipoManifestacao;
  channel: CanalManifestacao;
  subject: string;
  text: string;
  unitId?: string | null;
  patientId?: string | null;
  anonymous?: boolean;
  contactName?: string | null;
  contactPhone?: string | null;
  createdBy?: string | null;
}

const DIA = 86_400_000;

/**
 * Ouvidoria (Lei 13.460/2017): manifestação com protocolo, prazo de 30 dias prorrogável uma única vez com
 * justificativa, encaminhamento à unidade, resposta conclusiva, avaliação da resposta pelo cidadão e relatório.
 * Manifestações anônimas guardam o cadastro só para o próprio cidadão acompanhar: a equipe não vê a identidade.
 */
@Injectable()
export class OmbudsmanService {
  constructor(
    private readonly audit: AuditService,
    private readonly messaging: MessagingService,
    private readonly realtime: RealtimeService,
  ) {}

  private async proximoProtocolo(sys: SystemContext) {
    const ano = new Date().getFullYear();
    const total = await sys.db.ombudsmanCase.count({ where: { protocol: { startsWith: `OUV-${ano}-` } } });
    for (let i = 1; i <= 50; i++) {
      const candidato = numeroProtocoloOuvidoria(ano, total + i);
      if (!(await sys.db.ombudsmanCase.findUnique({ where: { protocol: candidato }, select: { id: true } }))) return candidato;
    }
    throw new DomainError('PROTOCOLO_INDISPONIVEL', 'Não foi possível gerar o número do protocolo');
  }

  /** Registro por qualquer canal (app, WhatsApp, presencial, telefone). */
  async registrar(sys: SystemContext, input: NovaManifestacao) {
    if (!ASSUNTO_MANIFESTACAO[input.subject]) throw new DomainError('ASSUNTO_INVALIDO', 'Assunto desconhecido');
    const recebidaEm = new Date();
    const c = await sys.db.ombudsmanCase.create({
      data: {
        protocol: await this.proximoProtocolo(sys),
        kind: input.kind,
        channel: input.channel,
        subject: input.subject,
        text: input.text.trim(),
        unitId: input.unitId ?? null,
        patientId: input.patientId ?? null,
        anonymous: input.anonymous ?? false,
        contactName: input.anonymous ? null : (input.contactName ?? null),
        contactPhone: input.anonymous ? null : (input.contactPhone ?? null),
        receivedAt: recebidaEm,
        dueAt: prazoResposta(recebidaEm),
        assignedUnitId: input.unitId ?? null,
        createdBy: input.createdBy ?? null,
        events: { create: { kind: 'RECEBIDA', notes: `Recebida pelo canal ${CANAL_MANIFESTACAO[input.channel].toLowerCase()}`, userId: input.createdBy ?? null } },
      },
    });
    this.realtime.emitToTenant(sys.tenant.id, 'ouvidoria.manifestacao', { id: c.id });
    return c;
  }

  // ───────────────────────────── equipe ─────────────────────────────

  async registrarPelaEquipe(ctx: RequestContext, input: Omit<NovaManifestacao, 'createdBy'>) {
    const c = await this.registrar({ tenant: ctx.tenant, db: ctx.db }, { ...input, createdBy: ctx.session.userId });
    await this.audit.recordStandalone(ctx, { action: 'ouvidoria.registrar', entityType: 'OmbudsmanCase', entityId: c.id, payload: { protocol: c.protocol, kind: c.kind, channel: c.channel } });
    return this.detalhe(ctx, c.id);
  }

  async painel(ctx: RequestContext) {
    const agora = new Date();
    const d30 = new Date(agora.getTime() - 30 * DIA);
    const abertas = await ctx.db.ombudsmanCase.findMany({ where: { status: { in: [...STATUS_MANIFESTACAO_ABERTA] } }, select: { dueAt: true } });
    const prazos = abertas.map((a) => situacaoPrazo(a.dueAt, agora).situacao);
    const [respondidas30, porTipo, porAssunto, porUnidade, avaliacoes] = await Promise.all([
      ctx.db.ombudsmanCase.findMany({ where: { respondedAt: { gte: d30 } }, select: { receivedAt: true, respondedAt: true, dueAt: true } }),
      ctx.db.ombudsmanCase.groupBy({ by: ['kind'], where: { receivedAt: { gte: d30 } }, _count: { _all: true } }),
      ctx.db.ombudsmanCase.groupBy({ by: ['subject'], where: { receivedAt: { gte: d30 } }, _count: { _all: true }, orderBy: { _count: { subject: 'desc' } }, take: 6 }),
      ctx.db.ombudsmanCase.groupBy({ by: ['unitId'], where: { receivedAt: { gte: d30 }, unitId: { not: null } }, _count: { _all: true }, orderBy: { _count: { unitId: 'desc' } }, take: 6 }),
      ctx.db.ombudsmanCase.aggregate({ where: { ratedAt: { gte: d30 }, rating: { not: null } }, _avg: { rating: true }, _count: { rating: true } }),
    ]);
    const unidades = new Map((await ctx.db.unit.findMany({ where: { id: { in: porUnidade.map((u) => u.unitId!).filter(Boolean) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const dias = respondidas30.map((r) => (r.respondedAt!.getTime() - r.receivedAt.getTime()) / DIA);
    return {
      abertas: abertas.length,
      noPrazo: prazos.filter((p) => p === 'NO_PRAZO').length,
      vencendo: prazos.filter((p) => p === 'VENCE_EM_BREVE').length,
      vencidas: prazos.filter((p) => p === 'VENCIDA').length,
      respondidas30d: respondidas30.length,
      respondidasNoPrazo30d: respondidas30.filter((r) => r.respondedAt!.getTime() <= r.dueAt.getTime()).length,
      tempoMedioRespostaDias: dias.length ? Math.round((dias.reduce((a, b) => a + b, 0) / dias.length) * 10) / 10 : null,
      porTipo: porTipo.map((t) => ({ tipo: t.kind, label: TIPO_MANIFESTACAO[t.kind], total: t._count._all })),
      porAssunto: porAssunto.map((a) => ({ assunto: a.subject, label: ASSUNTO_MANIFESTACAO[a.subject] ?? a.subject, total: a._count._all })),
      porUnidade: porUnidade.map((u) => ({ unitId: u.unitId, unidade: unidades.get(u.unitId!) ?? '—', total: u._count._all })),
      avaliacaoMedia: avaliacoes._avg.rating != null ? Math.round(avaliacoes._avg.rating * 10) / 10 : null,
      avaliacoes: avaliacoes._count.rating,
    };
  }

  private publico(ctx: RequestContext, c: { anonymous: boolean; patient: { id: string; name: string; socialName: string | null } | null; contactName: string | null; contactPhone: string | null }) {
    if (c.anonymous) return { identificado: false as const, pessoa: null, contato: null };
    return {
      identificado: true as const,
      pessoa: c.patient ? { id: c.patient.id, nome: c.patient.socialName ?? c.patient.name } : c.contactName ? { id: null, nome: c.contactName } : null,
      contato: c.contactPhone ? mascararTelefone(c.contactPhone.replace(/^55(?=\d{10,11}$)/, '')) : null,
    };
  }

  async listar(ctx: RequestContext, q: { status?: string; kind?: string; unitId?: string; busca?: string; prazo?: string }) {
    const rows = await ctx.db.ombudsmanCase.findMany({
      where: {
        ...(q.status === 'ABERTAS' ? { status: { in: [...STATUS_MANIFESTACAO_ABERTA] } } : q.status ? { status: q.status as StatusManifestacao } : {}),
        ...(q.kind ? { kind: q.kind as TipoManifestacao } : {}),
        ...(q.unitId ? { OR: [{ unitId: q.unitId }, { assignedUnitId: q.unitId }] } : {}),
        ...(q.busca
          ? { OR: [{ protocol: { contains: q.busca.toUpperCase() } }, { text: { contains: q.busca, mode: 'insensitive' } }, { patient: { name: { contains: q.busca, mode: 'insensitive' } }, anonymous: false }] }
          : {}),
      },
      orderBy: [{ dueAt: 'asc' }],
      take: 200,
      include: { patient: { select: { id: true, name: true, socialName: true } }, unit: { select: { id: true, name: true } } },
    });
    const agora = new Date();
    return rows
      .map((c) => ({
        id: c.id,
        protocolo: c.protocol,
        tipo: c.kind,
        tipoLabel: TIPO_MANIFESTACAO[c.kind],
        canal: c.channel,
        assunto: c.subject,
        assuntoLabel: ASSUNTO_MANIFESTACAO[c.subject] ?? c.subject,
        unidade: c.unit ? { id: c.unit.id, nome: c.unit.name } : null,
        status: c.status,
        statusLabel: STATUS_MANIFESTACAO[c.status],
        recebidaEm: c.receivedAt.toISOString(),
        venceEm: c.dueAt.toISOString(),
        prazo: STATUS_MANIFESTACAO_ABERTA.includes(c.status) ? situacaoPrazo(c.dueAt, agora) : null,
        resumo: c.text.slice(0, 160),
        avaliacao: c.rating,
        ...this.publico(ctx, c),
      }))
      .filter((c) => !q.prazo || c.prazo?.situacao === q.prazo);
  }

  async detalhe(ctx: RequestContext, id: string) {
    const c = await ctx.db.ombudsmanCase.findUnique({
      where: { id },
      include: { patient: { select: { id: true, name: true, socialName: true } }, unit: { select: { id: true, name: true } }, events: { orderBy: { at: 'asc' } } },
    });
    if (!c) throw notFound('Manifestação');
    const userIds = [...new Set([...c.events.map((e) => e.userId), c.assignedUserId, c.respondedBy].filter((x): x is string => !!x))];
    const usuarios = new Map((userIds.length ? await ctx.db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
    const unidadeDestino = c.assignedUnitId ? await ctx.db.unit.findUnique({ where: { id: c.assignedUnitId }, select: { id: true, name: true } }) : null;
    return {
      id: c.id,
      protocolo: c.protocol,
      tipo: c.kind,
      tipoLabel: TIPO_MANIFESTACAO[c.kind],
      canal: c.channel,
      canalLabel: CANAL_MANIFESTACAO[c.channel],
      assunto: c.subject,
      assuntoLabel: ASSUNTO_MANIFESTACAO[c.subject] ?? c.subject,
      unidade: c.unit ? { id: c.unit.id, nome: c.unit.name } : null,
      unidadeDestino: unidadeDestino ? { id: unidadeDestino.id, nome: unidadeDestino.name } : null,
      responsavel: c.assignedUserId ? (usuarios.get(c.assignedUserId) ?? null) : null,
      texto: c.text,
      status: c.status,
      statusLabel: STATUS_MANIFESTACAO[c.status],
      recebidaEm: c.receivedAt.toISOString(),
      venceEm: c.dueAt.toISOString(),
      prazo: STATUS_MANIFESTACAO_ABERTA.includes(c.status) ? situacaoPrazo(c.dueAt) : null,
      prorrogada: !!c.extendedAt,
      justificativaProrrogacao: c.extensionReason,
      resposta: c.responseText ? { texto: c.responseText, em: c.respondedAt?.toISOString() ?? null, por: c.respondedBy ? (usuarios.get(c.respondedBy) ?? null) : null } : null,
      avaliacao: c.rating != null ? { nota: c.rating, comentario: c.ratingComment, em: c.ratedAt?.toISOString() ?? null } : null,
      eventos: c.events.map((e) => ({ id: e.id, tipo: e.kind, notas: e.notes, por: e.userId ? (usuarios.get(e.userId) ?? null) : null, em: e.at.toISOString() })),
      ...this.publico(ctx, c),
    };
  }

  private async aberta(ctx: RequestContext, id: string) {
    const c = await ctx.db.ombudsmanCase.findUnique({ where: { id } });
    if (!c) throw notFound('Manifestação');
    if (!STATUS_MANIFESTACAO_ABERTA.includes(c.status)) throw new DomainError('MANIFESTACAO_FECHADA', `Manifestação ${STATUS_MANIFESTACAO[c.status].toLowerCase()}`, HttpStatus.UNPROCESSABLE_ENTITY);
    return c;
  }

  async encaminhar(ctx: RequestContext, id: string, input: { unitId?: string | null; userId?: string | null; notes?: string | null }) {
    const c = await this.aberta(ctx, id);
    const unidade = input.unitId ? await ctx.db.unit.findUnique({ where: { id: input.unitId }, select: { name: true } }) : null;
    await ctx.db.ombudsmanCase.update({
      where: { id },
      data: {
        status: c.status === 'RECEBIDA' ? 'EM_ANALISE' : c.status,
        assignedUnitId: input.unitId ?? c.assignedUnitId,
        assignedUserId: input.userId ?? c.assignedUserId,
        events: { create: { kind: 'ENCAMINHADA', notes: [unidade ? `Encaminhada para ${unidade.name}` : null, input.notes?.trim() || null].filter(Boolean).join('. ') || 'Em análise', userId: ctx.session.userId } },
      },
    });
    await this.audit.recordStandalone(ctx, { action: 'ouvidoria.encaminhar', entityType: 'OmbudsmanCase', entityId: id, payload: input });
    this.realtime.emitToTenant(ctx.tenant.id, 'ouvidoria.manifestacao', { id });
    return this.detalhe(ctx, id);
  }

  /** Prorrogação única de 30 dias, com justificativa (art. 16 da Lei 13.460/2017). */
  async prorrogar(ctx: RequestContext, id: string, reason: string) {
    const c = await this.aberta(ctx, id);
    if (c.extendedAt) throw new DomainError('JA_PRORROGADA', 'O prazo só pode ser prorrogado uma única vez', HttpStatus.UNPROCESSABLE_ENTITY);
    const novoPrazo = new Date(c.dueAt.getTime() + PRORROGACAO_DIAS * DIA);
    await ctx.db.ombudsmanCase.update({
      where: { id },
      data: { status: 'PRORROGADA', dueAt: novoPrazo, extendedAt: new Date(), extensionReason: reason.trim(), events: { create: { kind: 'PRORROGADA', notes: reason.trim(), userId: ctx.session.userId } } },
    });
    await this.notificar({ tenant: ctx.tenant, db: ctx.db }, c, 'PRORROGADA', null);
    await this.audit.recordStandalone(ctx, { action: 'ouvidoria.prorrogar', entityType: 'OmbudsmanCase', entityId: id, payload: { reason, dueAt: novoPrazo } });
    this.realtime.emitToTenant(ctx.tenant.id, 'ouvidoria.manifestacao', { id });
    return this.detalhe(ctx, id);
  }

  /** Resposta conclusiva: encerra o prazo e avisa o cidadão (app e WhatsApp). */
  async responder(ctx: RequestContext, id: string, text: string) {
    const c = await this.aberta(ctx, id);
    await ctx.db.ombudsmanCase.update({
      where: { id },
      data: {
        status: 'RESPONDIDA',
        responseText: text.trim(),
        respondedAt: new Date(),
        respondedBy: ctx.session.userId,
        events: { create: { kind: 'RESPONDIDA', notes: text.trim().slice(0, 300), userId: ctx.session.userId } },
      },
    });
    await this.notificar({ tenant: ctx.tenant, db: ctx.db }, c, 'RESPONDIDA', text);
    await this.audit.recordStandalone(ctx, { action: 'ouvidoria.responder', entityType: 'OmbudsmanCase', entityId: id, payload: { tamanho: text.length } });
    this.realtime.emitToTenant(ctx.tenant.id, 'ouvidoria.manifestacao', { id });
    return this.detalhe(ctx, id);
  }

  async encerrar(ctx: RequestContext, id: string, input: { arquivar?: boolean; notes?: string | null }) {
    const c = await ctx.db.ombudsmanCase.findUnique({ where: { id } });
    if (!c) throw notFound('Manifestação');
    if (c.status === 'ENCERRADA' || c.status === 'ARQUIVADA') throw new DomainError('MANIFESTACAO_FECHADA', 'Manifestação já encerrada', HttpStatus.UNPROCESSABLE_ENTITY);
    if (input.arquivar && !input.notes?.trim()) throw new DomainError('MOTIVO_OBRIGATORIO', 'Informe o motivo do arquivamento');
    if (!input.arquivar && c.status !== 'RESPONDIDA') throw new DomainError('SEM_RESPOSTA', 'Responda a manifestação antes de encerrar (ou arquive com justificativa)', HttpStatus.UNPROCESSABLE_ENTITY);
    await ctx.db.ombudsmanCase.update({
      where: { id },
      data: {
        status: input.arquivar ? 'ARQUIVADA' : 'ENCERRADA',
        closedAt: new Date(),
        events: { create: { kind: input.arquivar ? 'ARQUIVADA' : 'ENCERRADA', notes: input.notes?.trim() || null, userId: ctx.session.userId } },
      },
    });
    await this.audit.recordStandalone(ctx, { action: input.arquivar ? 'ouvidoria.arquivar' : 'ouvidoria.encerrar', entityType: 'OmbudsmanCase', entityId: id, payload: input });
    this.realtime.emitToTenant(ctx.tenant.id, 'ouvidoria.manifestacao', { id });
    return this.detalhe(ctx, id);
  }

  private async notificar(sys: SystemContext, c: { id: string; protocol: string; patientId: string | null; contactPhone: string | null; anonymous: boolean }, status: 'RESPONDIDA' | 'PRORROGADA', texto: string | null) {
    if (!sys.tenant.settings.whatsappEnabled) return;
    let nome = 'cidadão';
    let phone: string | null = null;
    if (c.patientId) {
      const p = await sys.db.patient.findUnique({ where: { id: c.patientId }, select: { name: true, socialName: true, phone: true, whatsappOptIn: true } });
      if (p?.whatsappOptIn && p.phone) {
        phone = normalizeBrazilPhone(p.phone);
        nome = p.socialName ?? p.name;
      }
    } else if (c.contactPhone) phone = normalizeBrazilPhone(c.contactPhone);
    if (!phone) return;
    const template = buildOmbudsmanUpdateTemplate({ patientName: c.anonymous ? 'cidadão' : nome, protocol: c.protocol, status, detail: texto ? texto.slice(0, 160) : null });
    await this.messaging.scheduleTemplate(sys, { patientId: c.anonymous ? null : c.patientId, phone, template, refId: c.id });
  }

  // ───────────────────────────── cidadão ─────────────────────────────

  async minhas(c: CitizenContext) {
    const rows = await c.db.ombudsmanCase.findMany({ where: { patientId: c.patientId }, orderBy: { receivedAt: 'desc' }, take: 50, include: { unit: { select: { name: true } } } });
    return rows.map((m) => ({
      id: m.id,
      protocolo: m.protocol,
      tipo: m.kind,
      tipoLabel: TIPO_MANIFESTACAO[m.kind],
      assunto: m.subject,
      assuntoLabel: ASSUNTO_MANIFESTACAO[m.subject] ?? m.subject,
      unidade: m.unit?.name ?? null,
      anonima: m.anonymous,
      texto: m.text,
      status: m.status,
      statusLabel: STATUS_MANIFESTACAO[m.status],
      recebidaEm: m.receivedAt.toISOString(),
      venceEm: m.dueAt.toISOString(),
      prorrogada: !!m.extendedAt,
      resposta: m.responseText ? { texto: m.responseText, em: m.respondedAt?.toISOString() ?? null } : null,
      avaliacao: m.rating,
      podeAvaliar: m.status === 'RESPONDIDA' && m.rating == null,
    }));
  }

  async registrarPeloCidadao(c: CitizenContext, input: { kind: TipoManifestacao; subject: string; text: string; unitId?: string | null; anonymous?: boolean }) {
    const criada = await this.registrar({ tenant: c.tenant, db: c.db }, { ...input, channel: 'APP', patientId: c.patientId, anonymous: input.anonymous ?? false });
    return (await this.minhas(c)).find((m) => m.id === criada.id)!;
  }

  /** O cidadão avalia a resposta recebida (1 a 5). */
  async avaliar(c: CitizenContext, id: string, input: { nota: number; comentario?: string | null }) {
    const m = await c.db.ombudsmanCase.findUnique({ where: { id } });
    if (!m || m.patientId !== c.patientId) throw notFound('Manifestação');
    if (m.status !== 'RESPONDIDA' && m.status !== 'ENCERRADA') throw new DomainError('SEM_RESPOSTA', 'A manifestação ainda não foi respondida', HttpStatus.UNPROCESSABLE_ENTITY);
    if (m.rating != null) throw new DomainError('JA_AVALIADA', 'A resposta já foi avaliada', HttpStatus.UNPROCESSABLE_ENTITY);
    await c.db.ombudsmanCase.update({
      where: { id },
      data: {
        rating: input.nota,
        ratingComment: input.comentario?.trim() || null,
        ratedAt: new Date(),
        status: 'ENCERRADA',
        closedAt: m.closedAt ?? new Date(),
        events: { create: { kind: 'AVALIADA', notes: `Nota ${input.nota}${input.comentario?.trim() ? `: ${input.comentario.trim().slice(0, 200)}` : ''}` } },
      },
    });
    this.realtime.emitToTenant(c.tenant.id, 'ouvidoria.manifestacao', { id });
    return (await this.minhas(c)).find((x) => x.id === id)!;
  }
}
