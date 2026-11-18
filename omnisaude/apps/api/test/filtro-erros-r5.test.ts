import type { ArgumentsHost } from '@nestjs/common';
import { TenantPrisma } from '@omnisaude/database';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AllExceptionsFilter, DomainError } from '../src/core/errors';
import { pgAvailable, startTestApp, TEST_PG, type TestApp } from './harness';

/**
 * Semana 27, quinta rodada (R5-12 e R5-5): o filtro global converte o impasse (40P01) e a falha de serialização
 * (40001) do Postgres em 409 OPERACAO_SIMULTANEA "tente de novo", e o texto com caractere que o Postgres não aceita
 * (22021, o NUL num text; 22P05, o mesmo NUL num jsonb) em 400 VALIDACAO, em vez de 500 "Erro interno". As formas do
 * erro são as do Prisma 7 com o adaptador do pg (P2010 na consulta crua, P2034 e P2039 na do modelo, com o código do
 * Postgres em meta.driverAdapterError.cause.originalCode), as do Prisma com o motor antigo (P2010 com meta.code) e a do
 * pg puro (code). A parte com banco provoca cada erro de verdade e passa o erro ao filtro; e, pela API, o impasse da
 * desativação da unidade e a busca de profissionais com NUL.
 */
const enabled = await pgAvailable();

const MSG_SIMULTANEA = 'Outra operação alterou os mesmos dados ao mesmo tempo. Tente de novo em instantes.';
const MSG_TEXTO = 'O pedido tem texto com caractere inválido (como o caractere nulo, U+0000). Corrija e envie de novo.';
const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** O que o filtro responde ao erro, com uma resposta HTTP de mentira. */
function responder(e: unknown): { status: number; corpo: Record<string, unknown> } {
  let status = 0;
  let corpo: Record<string, unknown> = {};
  const res = {
    status(s: number) {
      status = s;
      return res;
    },
    json(b: Record<string, unknown>) {
      corpo = b;
      return res;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(e, host);
  return { status, corpo };
}

/** O erro do adaptador do pg (DriverAdapterError), como o Prisma 7 o põe em meta.driverAdapterError. */
const erroDoAdaptador = (cause: Record<string, unknown>) => Object.assign(new Error(String(cause.kind)), { name: 'DriverAdapterError', cause });
const doPrisma = (code: string, meta: Record<string, unknown>, mensagem = 'erro') => new TenantPrisma.PrismaClientKnownRequestError(mensagem, { code, clientVersion: '7.10.1', meta });
const doPg = (code: string, message: string) => Object.assign(new Error(message), { code, severity: 'ERROR', detail: undefined });

/** Para o registro: a forma do erro real (classe, código do Prisma e o que veio do adaptador). */
function forma(e: unknown) {
  const x = e as { constructor?: { name?: string }; code?: unknown; meta?: Record<string, unknown>; message?: string };
  const dae = x.meta?.driverAdapterError as { name?: string; cause?: unknown } | undefined;
  return {
    classe: x.constructor?.name,
    code: x.code,
    metaChaves: x.meta ? Object.keys(x.meta) : null,
    adaptador: dae ? { name: dae.name, cause: dae.cause } : null,
    mensagem: String(x.message ?? '')
      .split('\n')
      .filter(Boolean)
      .pop(),
  };
}

describe('filtro global de erros: impasse, serialização e caractere inválido', () => {
  it('impasse e falha de serialização em qualquer forma: 409 OPERACAO_SIMULTANEA', () => {
    const casos: [string, unknown][] = [
      ['P2010 do adaptador (consulta crua), 40P01', doPrisma('P2010', { driverAdapterError: erroDoAdaptador({ kind: 'TransactionWriteConflict', originalCode: '40P01', originalMessage: 'deadlock detected' }) })],
      [
        'P2010 do adaptador (consulta crua), 40001',
        doPrisma('P2010', {
          driverAdapterError: erroDoAdaptador({ kind: 'TransactionWriteConflict', originalCode: '40001', originalMessage: 'could not serialize access due to concurrent update' }),
        }),
      ],
      ['P2034 (consulta do modelo)', doPrisma('P2034', { driverAdapterError: erroDoAdaptador({ kind: 'TransactionWriteConflict', originalCode: '40P01' }) })],
      ['P2034 sem meta', doPrisma('P2034', {})],
      ['P2010 do motor antigo (meta.code)', doPrisma('P2010', { code: '40P01', message: 'deadlock detected' })],
      ['P2010 do motor antigo, 40001', doPrisma('P2010', { code: '40001', message: 'could not serialize access due to read/write dependencies among transactions' })],
      ['erro do adaptador solto', erroDoAdaptador({ kind: 'TransactionWriteConflict', originalCode: '40P01', originalMessage: 'deadlock detected' })],
      ['erro do adaptador sem o código original', doPrisma('P2010', { driverAdapterError: erroDoAdaptador({ kind: 'TransactionWriteConflict' }) })],
      ['pg puro, 40P01', doPg('40P01', 'deadlock detected')],
      ['pg puro, 40001', doPg('40001', 'could not serialize access due to concurrent update')],
    ];
    for (const [nome, e] of casos) expect([nome, responder(e)]).toEqual([nome, { status: 409, corpo: { statusCode: 409, code: 'OPERACAO_SIMULTANEA', message: MSG_SIMULTANEA } }]);
  });

  it('texto com caractere que o Postgres não aceita (22021 e 22P05) em qualquer forma: 400 VALIDACAO', () => {
    const nul = { kind: 'postgres', code: '22021', originalCode: '22021', originalMessage: 'invalid byte sequence for encoding "UTF8": 0x00', severity: 'ERROR' };
    const casos: [string, unknown][] = [
      ['P2010 do adaptador (consulta crua)', doPrisma('P2010', { driverAdapterError: erroDoAdaptador(nul) })],
      ['P2039 do adaptador (consulta do modelo)', doPrisma('P2039', { driverAdapterError: erroDoAdaptador(nul) })],
      ['P2010 do motor antigo (meta.code)', doPrisma('P2010', { code: '22021', message: 'invalid byte sequence for encoding "UTF8": 0x00' })],
      ['pg puro', doPg('22021', 'invalid byte sequence for encoding "UTF8": 0x00')],
      ['NUL num jsonb (22P05)', doPrisma('P2010', { driverAdapterError: erroDoAdaptador({ kind: 'postgres', code: '22P05', originalCode: '22P05', originalMessage: 'unsupported Unicode escape sequence' }) })],
    ];
    for (const [nome, e] of casos) expect([nome, responder(e)]).toEqual([nome, { status: 400, corpo: { statusCode: 400, code: 'VALIDACAO', message: MSG_TEXTO } }]);
  });

  it('o resto não muda: regra de negócio, duplicado, não encontrado e outros erros do banco (500)', () => {
    expect(responder(new DomainError('CONFLITO', 'O plano já está em vigor', 409)).corpo).toEqual({ statusCode: 409, message: 'O plano já está em vigor', code: 'CONFLITO', details: undefined });
    expect(responder(doPrisma('P2002', {}))).toEqual({ status: 409, corpo: { statusCode: 409, message: 'Registro duplicado', code: 'DUPLICADO' } });
    expect(responder(doPrisma('P2025', {}))).toEqual({ status: 404, corpo: { statusCode: 404, message: 'Registro não encontrado', code: 'NAO_ENCONTRADO' } });
    const outros: unknown[] = [
      doPrisma('P2010', { driverAdapterError: erroDoAdaptador({ kind: 'postgres', code: '42601', originalCode: '42601', originalMessage: 'syntax error' }) }),
      doPrisma('P2010', { code: '23514', message: 'check violation' }),
      doPg('57014', 'canceling statement due to statement timeout'),
      new Error('qualquer'),
      'texto',
      null,
    ];
    for (const e of outros) expect(responder(e)).toEqual({ status: 500, corpo: { statusCode: 500, message: 'Erro interno' } });
  });
});

describe.runIf(enabled)('filtro global de erros: os erros de verdade do Prisma 7 com o adaptador do pg', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let gestora = '';
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

  /** Outra conexão (superusuário) ao banco da instituição, para segurar travas como uma transação concorrente. */
  const outraConexao = async () => {
    const url = new URL(TEST_PG);
    url.pathname = `/tenant_db_${t.slug.replace(/-/g, '_')}`;
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    return c;
  };
  /** Espera (até 5 s) `n` conexões deste banco, fora a que pergunta, paradas numa trava. */
  const esperarTravas = async (c: Client, n: number) => {
    for (let i = 0; i < 100; i++) {
      const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`);
      if (rows[0]!.n >= n) return;
      await esperar(50);
    }
    throw new Error(`Não chegaram ${n} pedidos parados numa trava`);
  };
  const sinal = () => {
    let soltar!: () => void;
    const p = new Promise<void>((r) => (soltar = r));
    return { p, soltar };
  };

  /**
   * Duas transações pegam o recurso 0 e o 1 em ordens opostas, cada uma esperando a outra pegar o primeiro: o banco
   * acusa o impasse numa delas (a outra termina). Devolve o erro da que perdeu.
   */
  async function impasse(pegar: (tx: Tx, recurso: 0 | 1) => Promise<unknown>): Promise<unknown> {
    const a = sinal();
    const b = sinal();
    const r = await Promise.allSettled([
      db.$transaction(
        async (tx) => {
          await pegar(tx, 0);
          a.soltar();
          await b.p;
          await pegar(tx, 1);
        },
        { timeout: 20_000 },
      ),
      db.$transaction(
        async (tx) => {
          await pegar(tx, 1);
          b.soltar();
          await a.p;
          await pegar(tx, 0);
        },
        { timeout: 20_000 },
      ),
    ]);
    const falhas = r.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(falhas).toHaveLength(1);
    return falhas[0]!.reason;
  }

  /**
   * Falha de serialização (40001): a transação REPEATABLE READ lê a linha, outra a altera e confirma, e a primeira tenta
   * alterar a mesma linha. Devolve o erro.
   */
  async function serializacao(alterar: (tx: Tx) => Promise<unknown>, unitId: string): Promise<unknown> {
    const leu = sinal();
    const mudou = sinal();
    const primeira = db.$transaction(
      async (tx) => {
        await tx.unit.findUniqueOrThrow({ where: { id: unitId } });
        leu.soltar();
        await mudou.p;
        await alterar(tx);
      },
      { isolationLevel: TenantPrisma.TransactionIsolationLevel.RepeatableRead, timeout: 20_000 },
    );
    await leu.p;
    await db.unit.update({ where: { id: unitId }, data: { phone: `(11) 3000-${String(Date.now()).slice(-4)}` } });
    mudou.soltar();
    const r = await primeira.then(
      () => null,
      (e: unknown) => e,
    );
    expect(r).not.toBeNull();
    return r;
  }

  beforeAll(async () => {
    t = await startTestApp('filtroerros');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  it('impasse na consulta crua (P2010) e na do modelo (P2034): 409', async () => {
    const [u0, u1] = await db.unit.findMany({ orderBy: { cnes: 'asc' }, take: 2, select: { id: true } });
    const cru = await impasse((tx, i) => tx.$executeRaw`SELECT pg_advisory_xact_lock(${7_270_500 + i})`);
    console.log('R5NEG-FORMA impasse cru', JSON.stringify(forma(cru)));
    expect(responder(cru)).toEqual({ status: 409, corpo: { statusCode: 409, code: 'OPERACAO_SIMULTANEA', message: MSG_SIMULTANEA } });
    const ids = [u0!.id, u1!.id];
    const modelo = await impasse((tx, i) => tx.unit.update({ where: { id: ids[i]! }, data: { phone: `(11) 3000-000${i}` } }));
    console.log('R5NEG-FORMA impasse modelo', JSON.stringify(forma(modelo)));
    expect(responder(modelo)).toEqual({ status: 409, corpo: { statusCode: 409, code: 'OPERACAO_SIMULTANEA', message: MSG_SIMULTANEA } });
  });

  it('falha de serialização (40001) na consulta crua e na do modelo: 409', async () => {
    const u = await db.unit.findFirstOrThrow({ orderBy: { cnes: 'asc' }, select: { id: true } });
    const cru = await serializacao((tx) => tx.$executeRaw`UPDATE units SET phone = ${'(11) 3000-1111'} WHERE id = ${u.id}::uuid`, u.id);
    console.log('R5NEG-FORMA serializacao cru', JSON.stringify(forma(cru)));
    expect(responder(cru)).toEqual({ status: 409, corpo: { statusCode: 409, code: 'OPERACAO_SIMULTANEA', message: MSG_SIMULTANEA } });
    const modelo = await serializacao((tx) => tx.unit.update({ where: { id: u.id }, data: { phone: '(11) 3000-2222' } }), u.id);
    console.log('R5NEG-FORMA serializacao modelo', JSON.stringify(forma(modelo)));
    expect(responder(modelo)).toEqual({ status: 409, corpo: { statusCode: 409, code: 'OPERACAO_SIMULTANEA', message: MSG_SIMULTANEA } });
  });

  it('NUL no texto (22021) na consulta crua e na do modelo, e num jsonb (22P05): 400', async () => {
    const pegar = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => e,
      );
    const cru = await pegar(db.$queryRaw`SELECT strpos(${'a\u0000b'}, ${'b'}) AS p`);
    console.log('R5NEG-FORMA nul cru', JSON.stringify(forma(cru)));
    expect(responder(cru)).toEqual({ status: 400, corpo: { statusCode: 400, code: 'VALIDACAO', message: MSG_TEXTO } });
    const modelo = await pegar(db.unit.findMany({ where: { name: { contains: 'a\u0000b', mode: 'insensitive' } } }));
    console.log('R5NEG-FORMA nul modelo', JSON.stringify(forma(modelo)));
    expect(responder(modelo)).toEqual({ status: 400, corpo: { statusCode: 400, code: 'VALIDACAO', message: MSG_TEXTO } });
    const json = await pegar(db.$queryRaw`SELECT (${JSON.stringify({ nome: 'a\u0000b' })})::jsonb AS j`);
    console.log('R5NEG-FORMA nul jsonb', JSON.stringify(forma(json)));
    expect(responder(json)).toEqual({ status: 400, corpo: { statusCode: 400, code: 'VALIDACAO', message: MSG_TEXTO } });
  });

  it('pela API: a desativação da unidade que perde o impasse responde 409 (não 500) e nada fica gravado', async () => {
    const u = (await t.http().post('/api/admin/units').set(auth(gestora)).send({ name: 'UBS R5 Impasse', type: 'UBS', cnes: '9005971', ibgeCode: '3550308' }).expect(201)).body as { id: string };
    const vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    await t.http().post('/api/vigilancia/unidades-notificantes').set(auth(vig)).send({ unitId: u.id, desde: '2026-01-01' }).expect(201);
    // Três conexões montam o ciclo, com a API fechando-o por último (assim é ela que o banco escolhe para desfazer):
    // `periodos` segura os períodos da unidade; `trilha` (que só acusaria impasse depois de 10 s) segura a trilha. A
    // desativação (que também troca o CNES) prende a linha da unidade e para nos períodos; a `trilha` pede a linha da
    // unidade e para; soltos os períodos, a desativação chega à trilha e fecha o ciclo.
    const periodos = await outraConexao();
    const trilha = await outraConexao();
    let pedido: Promise<{ status: number; body: Record<string, unknown> }> | null = null;
    let chaves: Promise<unknown> | null = null;
    try {
      await periodos.query('BEGIN');
      await periodos.query('SELECT id FROM notifying_units WHERE unit_id = $1 FOR UPDATE', [u.id]);
      await trilha.query('BEGIN');
      await trilha.query(`SET LOCAL deadlock_timeout = '10s'`);
      await trilha.query(`SELECT pg_advisory_xact_lock(hashtext('omnisaude_audit_chain'))`);
      pedido = t
        .http()
        .patch(`/api/admin/units/${u.id}`)
        .set(auth(gestora))
        .send({ active: false, cnes: '9005972' })
        .then((x) => x);
      await esperarTravas(trilha, 1);
      chaves = trilha.query('SELECT id FROM units WHERE id = $1 FOR KEY SHARE', [u.id]);
      await esperarTravas(periodos, 2);
      await periodos.query('COMMIT');
      const r = await pedido;
      console.log('R5NEG-API-IMPASSE', r.status, JSON.stringify(r.body));
      expect([r.status, r.body]).toEqual([409, { statusCode: 409, code: 'OPERACAO_SIMULTANEA', message: MSG_SIMULTANEA }]);
      await chaves;
    } finally {
      await periodos.query('ROLLBACK').catch(() => {});
      await trilha.query('ROLLBACK').catch(() => {});
      await Promise.allSettled([pedido, chaves]);
      await periodos.end();
      await trilha.end();
    }
    // A transação desfeita não deixou nada: a unidade segue ativa, com o CNES e o período de antes.
    expect(await db.unit.findUniqueOrThrow({ where: { id: u.id }, select: { active: true, cnes: true } })).toEqual({ active: true, cnes: '9005971' });
    expect(await db.notifyingUnit.count({ where: { unitId: u.id, until: null } })).toBe(1);
    // De novo, sem a concorrência, passa.
    await t.http().patch(`/api/admin/units/${u.id}`).set(auth(gestora)).send({ active: false, cnes: '9005972' }).expect(200);
  });

  it('pela API: a busca de profissionais com NUL responde 400 (não 500)', async () => {
    const r = await t.http().get('/api/admin/users?q=a%00b').set(auth(gestora));
    console.log('R5NEG-API-NUL', r.status, JSON.stringify(r.body));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDACAO');
    // A busca comum continua.
    await t.http().get('/api/admin/users?q=Bruno').set(auth(gestora)).expect(200);
  });
});
