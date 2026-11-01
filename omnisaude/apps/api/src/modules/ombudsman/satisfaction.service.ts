import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ESCALA_SATISFACAO, resumoSatisfacao, roleHasPermission, VALIDADE_PESQUISA_DIAS } from '@omnisaude/shared';
import { buildSatisfactionSurveyTemplate, normalizeBrazilPhone } from '@omnisaude/messaging';
import type { CitizenContext, RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { MessagingService, type SystemContext } from '../integrations/messaging.service';

const DIA = 86_400_000;
const HORA = 3_600_000;

/** Pesquisa de satisfação depois do atendimento: criada no encerramento, enviada pelo WhatsApp (2 h depois, fora da janela de silêncio) e disponível no app por 7 dias. */
@Injectable()
export class SatisfactionService {
  private readonly logger = new Logger(SatisfactionService.name);

  constructor(private readonly messaging: MessagingService) {}

  /** Chamado ao encerrar um atendimento (não em óbito nem evasão). */
  async afterEncounterClosed(sys: SystemContext, encounterId: string) {
    try {
      const e = await sys.db.encounter.findUnique({
        where: { id: encounterId },
        include: { patient: { select: { id: true, name: true, socialName: true, phone: true, whatsappOptIn: true } }, unit: { select: { name: true } } },
      });
      if (!e || e.status !== 'ENCERRADO') return null;
      if (await sys.db.satisfactionSurvey.findUnique({ where: { encounterId } })) return null;
      const nota = await sys.db.clinicalNote.findFirst({ where: { encounterId, status: 'ASSINADO' }, orderBy: { signedAt: 'desc' }, select: { authorId: true } });
      const survey = await sys.db.satisfactionSurvey.create({
        data: { patientId: e.patientId, encounterId, unitId: e.unitId, professionalId: nota?.authorId ?? null, expiresAt: new Date(Date.now() + VALIDADE_PESQUISA_DIAS * DIA) },
      });
      const phone = e.patient.phone ? normalizeBrazilPhone(e.patient.phone) : null;
      // Os botões da pesquisa são lidos pelo assistente do WhatsApp: sem ele ligado, a resposta se perderia.
      // Nesse caso a pesquisa fica só no app do cidadão.
      if (sys.tenant.settings.whatsappEnabled && sys.tenant.settings.assistantEnabled && e.patient.whatsappOptIn && phone) {
        const dia = new Intl.DateTimeFormat('pt-BR', { timeZone: sys.tenant.timeZone, day: '2-digit', month: '2-digit' }).format(e.startedAt);
        const template = buildSatisfactionSurveyTemplate({
          surveyId: survey.id,
          patientName: e.patient.socialName ?? e.patient.name,
          service: `${e.kind === 'URGENCIA' ? 'urgência' : 'consulta'} do dia ${dia}`,
          unitName: e.unit.name,
        });
        await this.messaging.scheduleTemplate(sys, { patientId: e.patientId, phone, template, refId: survey.id, at: new Date(Date.now() + 2 * HORA) });
        await sys.db.satisfactionSurvey.update({ where: { id: survey.id }, data: { sentAt: new Date() } });
      }
      return survey;
    } catch (err) {
      this.logger.warn(`Pesquisa de satisfação não criada para ${encounterId}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Resposta por qualquer canal (botão do WhatsApp ou app). */
  async responder(sys: SystemContext, id: string, input: { score: number; recommend?: number | null; comment?: string | null; channel: 'WHATSAPP' | 'APP'; patientId?: string }) {
    const s = await sys.db.satisfactionSurvey.findUnique({ where: { id } });
    if (!s || (input.patientId && s.patientId !== input.patientId)) throw notFound('Pesquisa');
    if (s.status === 'RESPONDIDA') throw new DomainError('JA_RESPONDIDA', 'Esta pesquisa já foi respondida', HttpStatus.UNPROCESSABLE_ENTITY);
    if (s.expiresAt.getTime() < Date.now()) throw new DomainError('PESQUISA_EXPIRADA', 'O prazo desta pesquisa terminou', HttpStatus.UNPROCESSABLE_ENTITY);
    // Condicional: duas respostas simultâneas (botão e app) não se sobrescrevem.
    const r = await sys.db.satisfactionSurvey.updateMany({
      where: { id, status: 'PENDENTE' },
      data: { status: 'RESPONDIDA', score: input.score, recommend: input.recommend ?? null, comment: input.comment?.trim() || null, channel: input.channel, answeredAt: new Date() },
    });
    if (r.count === 0) throw new DomainError('JA_RESPONDIDA', 'Esta pesquisa já foi respondida', HttpStatus.UNPROCESSABLE_ENTITY);
    // Respondida pelo app antes do envio: o WhatsApp agendado não sai mais.
    await this.messaging.cancelScheduled(sys, id);
    return sys.db.satisfactionSurvey.findUniqueOrThrow({ where: { id } });
  }

  /** Comentário livre enviado depois da nota (WhatsApp). */
  async comentar(sys: SystemContext, id: string, comment: string) {
    const s = await sys.db.satisfactionSurvey.findUnique({ where: { id } });
    if (!s || s.status !== 'RESPONDIDA') return null;
    return sys.db.satisfactionSurvey.update({ where: { id }, data: { comment: [s.comment, comment.trim()].filter(Boolean).join(' ').slice(0, 2000) } });
  }

  async pendentesDoCidadao(c: CitizenContext) {
    const rows = await c.db.satisfactionSurvey.findMany({
      where: { patientId: c.patientId, OR: [{ status: 'PENDENTE', expiresAt: { gte: new Date() } }, { status: 'RESPONDIDA' }] },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { unit: { select: { name: true } }, encounter: { select: { startedAt: true, kind: true } } },
    });
    const profs = new Map(
      (await c.db.user.findMany({ where: { id: { in: rows.map((r) => r.professionalId).filter((x): x is string => !!x) } }, select: { id: true, name: true, socialName: true } })).map((u) => [
        u.id,
        u.socialName ?? u.name,
      ]),
    );
    return rows.map((r) => ({
      id: r.id,
      unidade: r.unit.name,
      profissional: r.professionalId ? (profs.get(r.professionalId) ?? null) : null,
      atendimentoEm: r.encounter?.startedAt.toISOString() ?? r.createdAt.toISOString(),
      status: r.status,
      nota: r.score,
      notaLabel: r.score ? ESCALA_SATISFACAO[r.score] : null,
      recomendaria: r.recommend,
      comentario: r.comment,
      validaAte: r.expiresAt.toISOString(),
    }));
  }

  async responderPeloCidadao(c: CitizenContext, id: string, input: { nota: number; recomendaria?: number | null; comentario?: string | null }) {
    await this.responder({ tenant: c.tenant, db: c.db }, id, { score: input.nota, recommend: input.recomendaria, comment: input.comentario, channel: 'APP', patientId: c.patientId });
    return this.pendentesDoCidadao(c);
  }

  /** Painel da gestão: por período e unidade; por profissional só para quem gere a ouvidoria. */
  async painel(ctx: RequestContext, q: { unitId?: string; de?: string; ate?: string }) {
    const de = q.de ? new Date(`${q.de}T00:00:00Z`) : new Date(Date.now() - 90 * DIA);
    const ate = q.ate ? new Date(`${q.ate}T23:59:59Z`) : new Date();
    const rows = await ctx.db.satisfactionSurvey.findMany({
      where: { createdAt: { gte: de, lte: ate }, ...(q.unitId ? { unitId: q.unitId } : {}) },
      include: { unit: { select: { id: true, name: true } } },
      orderBy: { answeredAt: 'desc' },
    });
    const porUnidade = new Map<string, { unidade: string; itens: typeof rows }>();
    for (const r of rows) {
      const g = porUnidade.get(r.unitId) ?? { unidade: r.unit.name, itens: [] };
      g.itens.push(r);
      porUnidade.set(r.unitId, g);
    }
    const porProfissional = new Map<string, typeof rows>();
    for (const r of rows) if (r.professionalId) porProfissional.set(r.professionalId, [...(porProfissional.get(r.professionalId) ?? []), r]);
    const profs = new Map((await ctx.db.user.findMany({ where: { id: { in: [...porProfissional.keys()] } }, select: { id: true, name: true, socialName: true } })).map((u) => [u.id, u.socialName ?? u.name]));
    const gerir = roleHasPermission(ctx.session.role, 'ouvidoria.gerir');
    return {
      periodo: { de: de.toISOString(), ate: ate.toISOString() },
      geral: resumoSatisfacao(rows),
      porCanal: { whatsapp: rows.filter((r) => r.channel === 'WHATSAPP').length, app: rows.filter((r) => r.channel === 'APP').length },
      porUnidade: [...porUnidade.entries()].map(([unitId, g]) => ({ unitId, unidade: g.unidade, ...resumoSatisfacao(g.itens) })).sort((a, b) => (b.media ?? 0) - (a.media ?? 0)),
      porProfissional: gerir
        ? [...porProfissional.entries()]
            .map(([id, itens]) => ({ id, nome: profs.get(id) ?? '—', ...resumoSatisfacao(itens) }))
            .filter((p) => p.respondidas > 0)
            .sort((a, b) => (b.media ?? 0) - (a.media ?? 0))
        : [],
      totalComentarios: rows.filter((r) => r.comment).length,
      comentarios: rows
        .filter((r) => r.comment)
        .slice(0, 20)
        .map((r) => ({ id: r.id, unidade: r.unit.name, nota: r.score, comentario: r.comment, em: r.answeredAt?.toISOString() ?? null })),
    };
  }
}
