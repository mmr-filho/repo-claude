import { Injectable } from '@nestjs/common';
import type { TenantPrisma } from '@omnisaude/database';

export type OutboxKind = 'RNDS_RAC' | 'RNDS_IMUNIZACAO' | 'RNDS_DISPENSACAO' | 'RNDS_SUMARIO_ALTA';

/**
 * Outbox transacional para a RNDS: grave a mensagem na MESMA transação do registro clínico.
 * O envio (FHIR + mTLS) é feito depois pelo job de integração, com novas tentativas.
 */
@Injectable()
export class OutboxService {
  enqueue(tx: TenantPrisma.TransactionClient, kind: OutboxKind, aggregateId: string, payload: Record<string, unknown> = {}) {
    return tx.outboxMessage.create({ data: { kind, aggregateId, payload: payload as object } });
  }
}
