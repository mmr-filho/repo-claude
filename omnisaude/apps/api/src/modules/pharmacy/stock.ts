import { HttpStatus } from '@nestjs/common';
import type { TenantPrisma } from '@omnisaude/database';
import { DomainError } from '../../core/errors';

type Tx = TenantPrisma.TransactionClient;

export type MovementKind =
  | 'ENTRADA_NFE'
  | 'TRANSFERENCIA_SAIDA'
  | 'TRANSFERENCIA_ENTRADA'
  | 'DISPENSACAO'
  | 'ADMINISTRACAO'
  | 'DEVOLUCAO'
  | 'UNITARIZACAO_SAIDA'
  | 'UNITARIZACAO_ENTRADA'
  | 'AJUSTE'
  | 'PERDA';

export interface MovementRef {
  kind: MovementKind;
  userId: string;
  refType?: string;
  refId?: string;
  patientId?: string;
}

/**
 * Baixa atômica: só debita se houver saldo (o UPDATE condicional evita saldo negativo
 * mesmo com duas baixas simultâneas). Toda alteração de saldo gera um movimento.
 */
export async function debit(tx: Tx, locationId: string, lotId: string, quantity: number, ref: MovementRef) {
  if (!(quantity > 0)) throw new DomainError('QUANTIDADE_INVALIDA', 'A quantidade deve ser positiva');
  const { count } = await tx.stockBalance.updateMany({
    where: { locationId, lotId, quantity: { gte: quantity } },
    data: { quantity: { decrement: quantity } },
  });
  if (count !== 1) {
    const lot = await tx.stockLot.findUnique({ where: { id: lotId }, include: { product: true } });
    throw new DomainError(
      'SALDO_INSUFICIENTE',
      `Saldo insuficiente de ${lot?.product.description ?? 'produto'} (lote ${lot?.lotNumber ?? lotId})`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      { locationId, lotId, requested: quantity },
    );
  }
  await tx.stockMovement.create({
    data: { kind: ref.kind, locationId, lotId, quantity: -quantity, refType: ref.refType, refId: ref.refId, patientId: ref.patientId, userId: ref.userId },
  });
}

export async function credit(tx: Tx, locationId: string, lotId: string, quantity: number, ref: MovementRef) {
  if (!(quantity > 0)) throw new DomainError('QUANTIDADE_INVALIDA', 'A quantidade deve ser positiva');
  await tx.stockBalance.upsert({
    where: { locationId_lotId: { locationId, lotId } },
    update: { quantity: { increment: quantity } },
    create: { locationId, lotId, quantity },
  });
  await tx.stockMovement.create({
    data: { kind: ref.kind, locationId, lotId, quantity, refType: ref.refType, refId: ref.refId, patientId: ref.patientId, userId: ref.userId },
  });
}

export const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

/** Início do dia (UTC) para comparar validades guardadas como DATE. */
export function startOfDay(d: Date): Date {
  return new Date(`${dateOnly(d)}T00:00:00.000Z`);
}

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
