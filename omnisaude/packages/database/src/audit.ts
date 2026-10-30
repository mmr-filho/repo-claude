import { createHash } from 'node:crypto';
import type { PrismaClient as TenantClient } from './generated/tenant/client';

export const GENESIS_HASH = '0'.repeat(64);

/** JSON canônico (chaves ordenadas) para que o mesmo conteúdo gere sempre o mesmo hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    }
    if (typeof v === 'bigint') return v.toString();
    return v;
  });
}

export function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export interface AuditInput {
  userId?: string | null;
  unitId?: string | null;
  role?: string | null;
  ip?: string | null;
  /** Segundo fator confirmado na sessão do operador. */
  mfa: boolean;
  action: string;
  entityType: string;
  entityId?: string | null;
  /** Conteúdo clínico/operacional registrado: entra no hash, não é guardado na trilha. */
  payload: unknown;
}

interface ChainFields {
  prevHash: string;
  payloadHash: string;
  at: Date;
  ip?: string | null;
  userId?: string | null;
  mfa: boolean;
  action: string;
  entityType: string;
  entityId?: string | null;
}

/** hash = SHA-256(hash anterior | hash do conteúdo | instante UTC | IP | operador | 2FA | ação | entidade). */
export function chainHash(f: ChainFields): string {
  return sha256(
    [f.prevHash, f.payloadHash, f.at.toISOString(), f.ip ?? '', f.userId ?? '', f.mfa ? '1' : '0', f.action, f.entityType, f.entityId ?? ''].join('|'),
  );
}

type Tx = Pick<TenantClient, '$executeRaw' | 'auditEntry'>;

/**
 * Acrescenta uma entrada à trilha. Deve rodar dentro da mesma transação do registro auditado;
 * o advisory lock transacional serializa os escritores para manter a cadeia linear.
 */
export async function appendAudit(tx: Tx, input: AuditInput): Promise<{ hash: string; seq: bigint }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('omnisaude_audit_chain'))`;
  const last = await tx.auditEntry.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
  const prevHash = last?.hash ?? GENESIS_HASH;
  const payloadHash = sha256(canonicalJson(input.payload));
  const at = new Date();
  const hash = chainHash({ ...input, prevHash, payloadHash, at });
  const row = await tx.auditEntry.create({
    data: {
      at,
      userId: input.userId ?? null,
      unitId: input.unitId ?? null,
      role: input.role ?? null,
      ip: input.ip ?? null,
      mfa: input.mfa,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      payloadHash,
      prevHash,
      hash,
    },
    select: { seq: true },
  });
  return { hash, seq: row.seq };
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  brokenAt?: bigint;
  reason?: string;
}

/** Recalcula a cadeia inteira (ou a partir de um ponto) e aponta a primeira entrada adulterada. */
export async function verifyAuditChain(client: Pick<TenantClient, 'auditEntry'>, batchSize = 1000): Promise<ChainVerification> {
  let prevHash = GENESIS_HASH;
  let cursor: bigint | undefined;
  let checked = 0;
  for (;;) {
    const rows = await client.auditEntry.findMany({
      where: cursor === undefined ? {} : { seq: { gt: cursor } },
      orderBy: { seq: 'asc' },
      take: batchSize,
    });
    if (rows.length === 0) return { ok: true, checked };
    for (const r of rows) {
      if (r.prevHash !== prevHash) return { ok: false, checked, brokenAt: r.seq, reason: 'Encadeamento interrompido' };
      if (chainHash({ ...r, prevHash }) !== r.hash) return { ok: false, checked, brokenAt: r.seq, reason: 'Hash não confere' };
      prevHash = r.hash;
      checked++;
      cursor = r.seq;
    }
  }
}

/** Confere se um conteúdo corresponde ao hash registrado na trilha (ex.: prontuário assinado). */
export function payloadMatches(payload: unknown, payloadHash: string): boolean {
  return sha256(canonicalJson(payload)) === payloadHash;
}
