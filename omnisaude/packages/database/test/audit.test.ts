import { describe, expect, it } from 'vitest';
import { canonicalJson, chainHash, GENESIS_HASH, payloadMatches, sha256, verifyAuditChain } from '@omnisaude/database';

function buildChain(n: number) {
  const rows = [];
  let prevHash = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const base = {
      seq: BigInt(i),
      at: new Date(Date.UTC(2026, 0, 1, 12, i)),
      userId: 'u1',
      ip: '10.0.0.1',
      mfa: i % 2 === 0,
      action: 'prontuario.assinar',
      entityType: 'ClinicalNote',
      entityId: `n${i}`,
      payloadHash: sha256(canonicalJson({ i })),
      prevHash,
    };
    const hash = chainHash(base);
    rows.push({ ...base, hash });
    prevHash = hash;
  }
  return rows;
}

function fakeClient(rows: ReturnType<typeof buildChain>) {
  return {
    auditEntry: {
      findMany: async ({ where, take }: { where: { seq?: { gt: bigint } }; take: number }) =>
        rows.filter((r) => !where.seq || r.seq > where.seq.gt).slice(0, take),
    },
  } as never;
}

describe('trilha de auditoria', () => {
  it('gera JSON canônico independente da ordem das chaves', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(payloadMatches({ x: 1, y: [1, 2] }, sha256('{"x":1,"y":[1,2]}'))).toBe(true);
  });

  it('verifica uma cadeia íntegra em lotes', async () => {
    const result = await verifyAuditChain(fakeClient(buildChain(25)), 10);
    expect(result).toEqual({ ok: true, checked: 25 });
  });

  it('aponta a primeira entrada adulterada', async () => {
    const rows = buildChain(10);
    rows[6] = { ...rows[6]!, ip: '200.1.1.1' };
    const result = await verifyAuditChain(fakeClient(rows));
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(7n);
  });

  it('o hash muda quando o 2FA do operador muda', () => {
    const [row] = buildChain(1);
    expect(chainHash({ ...row!, mfa: !row!.mfa })).not.toBe(row!.hash);
  });
});
