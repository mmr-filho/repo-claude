import { Injectable } from '@nestjs/common';
import { appendAudit, appendAuditBatch, type TenantPrisma } from '@omnisaude/database';
import type { RequestContext } from './context';

type Tx = TenantPrisma.TransactionClient;

@Injectable()
export class AuditService {
  /**
   * Registra a ação na trilha encadeada, na mesma transação do dado auditado.
   * O hash combina o conteúdo, o instante UTC, o IP e o 2FA do operador.
   */
  record(ctx: RequestContext, tx: Tx, entry: { action: string; entityType: string; entityId?: string; payload: unknown }) {
    return appendAudit(tx, {
      userId: ctx.session.userId,
      unitId: ctx.session.unitId,
      role: ctx.session.role,
      ip: ctx.ip,
      mfa: ctx.session.mfa,
      ...entry,
    });
  }

  /** Várias entradas da mesma ação numa só gravação (mesma cadeia, mesmo operador). */
  recordMany(ctx: RequestContext, tx: Tx, entries: { action: string; entityType: string; entityId?: string; payload: unknown }[]) {
    const quem = { userId: ctx.session.userId, unitId: ctx.session.unitId, role: ctx.session.role, ip: ctx.ip, mfa: ctx.session.mfa };
    return appendAuditBatch(
      tx,
      entries.map((e) => ({ ...quem, ...e })),
    );
  }

  /** Para ações isoladas (ex.: visualização de prontuário, LGPD), abre a própria transação. */
  recordStandalone(ctx: RequestContext, entry: { action: string; entityType: string; entityId?: string; payload: unknown }) {
    return ctx.db.$transaction((tx) => this.record(ctx, tx, entry));
  }
}
