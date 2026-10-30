import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { AuthService } from '../auth/auth.service';

export interface ChecklistItem {
  id: string;
  text: string;
  required: boolean;
}

@Injectable()
export class PopsService {
  constructor(
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async list(ctx: RequestContext, filter: { kind?: 'HARD' | 'SOFT'; trigger?: string }) {
    const rows = await ctx.db.pop.findMany({
      where: { active: true, ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.trigger ? { trigger: filter.trigger } : {}) },
      orderBy: [{ kind: 'asc' }, { code: 'asc' }],
    });
    return rows.map(({ content: _content, ...p }) => p);
  }

  /** Consulta a um POP. Para os guias consultivos (soft gates), o acesso fica na trilha de auditoria. */
  async get(ctx: RequestContext, id: string) {
    const pop = await ctx.db.pop.findUnique({ where: { id } });
    if (!pop || !pop.active) throw notFound('POP');
    if (pop.kind === 'SOFT') {
      await this.audit.recordStandalone(ctx, { action: 'pop.consultar', entityType: 'Pop', entityId: pop.id, payload: { code: pop.code, version: pop.version } });
    }
    return pop;
  }

  /**
   * Execução de POP bloqueante (hard gate): todos os itens obrigatórios marcados e, quando exigido,
   * a dupla checagem por outro profissional com a própria credencial. Devolve o id usado na administração.
   */
  async execute(
    ctx: RequestContext,
    id: string,
    input: { answers: Record<string, boolean>; patientId?: string; doubleCheck?: { cpf: string; password: string } },
  ) {
    const pop = await ctx.db.pop.findUnique({ where: { id } });
    if (!pop || !pop.active) throw notFound('POP');
    if (pop.kind !== 'HARD') throw new DomainError('POP_CONSULTIVO', 'POPs consultivos não têm execução com checklist');
    const checklist = (pop.checklist as unknown as ChecklistItem[]) ?? [];
    const missing = checklist.filter((c) => c.required && input.answers[c.id] !== true);
    if (missing.length) {
      throw new DomainError('CHECKLIST_INCOMPLETO', 'Itens obrigatórios do checklist não confirmados', HttpStatus.UNPROCESSABLE_ENTITY, {
        missing: missing.map((m) => ({ id: m.id, text: m.text })),
      });
    }
    if (input.patientId) {
      const patient = await ctx.db.patient.findUnique({ where: { id: input.patientId }, select: { id: true } });
      if (!patient) throw notFound('Paciente');
    }
    let colleague: { userId: string; name: string } | null = null;
    if (pop.requiresDoubleCheck && !input.doubleCheck) {
      throw new DomainError('DUPLA_CHECAGEM_OBRIGATORIA', 'Este POP exige dupla checagem por outro profissional', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (input.doubleCheck) colleague = await this.auth.verifyColleague(ctx, input.doubleCheck.cpf, input.doubleCheck.password);

    const answers = Object.fromEntries(checklist.map((c) => [c.id, input.answers[c.id] === true]));
    const execution = await ctx.db.$transaction(async (tx) => {
      const e = await tx.popExecution.create({
        data: { popId: pop.id, userId: ctx.session.userId, patientId: input.patientId ?? null, answers, doubleCheckUserId: colleague?.userId ?? null },
      });
      await this.audit.record(ctx, tx, {
        action: 'pop.executar',
        entityType: 'PopExecution',
        entityId: e.id,
        payload: { pop: pop.code, version: pop.version, answers, patientId: input.patientId, doubleCheckUserId: colleague?.userId },
      });
      return e;
    });
    return {
      id: execution.id,
      popId: pop.id,
      code: pop.code,
      trigger: pop.trigger,
      completedAt: execution.completedAt,
      doubleCheckBy: colleague ? { id: colleague.userId, name: colleague.name } : null,
    };
  }

  async executions(ctx: RequestContext, patientId?: string) {
    return ctx.db.popExecution.findMany({
      where: patientId ? { patientId } : { userId: ctx.session.userId },
      include: { pop: { select: { code: true, title: true, trigger: true } } },
      orderBy: { completedAt: 'desc' },
      take: 100,
    });
  }
}
