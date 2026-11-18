import { demoFixtures } from '@omnisaude/database';
import { cnsFromBase, localDateString } from '@omnisaude/shared';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AdminService } from '../src/modules/admin/admin.service';
import { AiService } from '../src/modules/integrations/ai.service';
import { NegativaService } from '../src/modules/vigilancia/negativa.service';
import { pgAvailable, startTestApp, TEST_PG, type TestApp } from './harness';

/**
 * Semana 27, quinta rodada da notificação negativa e do cadastro. R5-11: a célula da grade leva o prazo gravado com o
 * atesto (o que decidiu o "fora do prazo"); o da coluna é o prazo da semana pela regra de agora (r4vneg-4). R5-12: a
 * designação do titular no lugar do titular que não vale grava a trilha no fim, depois da designação nova, e não fecha
 * ciclo com o cadastro que troca o CNES da unidade ou o CNS do usuário designado (r4vcet-2: antes, 40P01 e 500).
 * Relógios fixos na R5-11; dados sintéticos.
 */
const enabled = await pgAvailable();
const at = (iso: string) => new Date(iso);
const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Grade = {
  colunas: { semana: string; prazo: string }[];
  linhas: { unidade: { id: string }; celulas: { semana: string; situacao: string; fontes: { atesto: { id: string; atrasado: boolean; prazo: string } | null } }[] }[];
};

describe.runIf(enabled)('Notificação negativa e cadastro: quinta rodada da semana 27', () => {
  let t: TestApp;
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let admin: AdminService;
  let negativas: NegativaService;
  const tk: Record<string, string> = {};
  const usuario: Record<string, string> = {};
  const auth = (k: string) => ({ authorization: `Bearer ${tk[k]}` });
  const relogio = (d: Date) => {
    admin.agora = () => d;
    negativas.agora = () => d;
  };
  const novaUnidade = async (name: string, cnes: string) =>
    (await t.http().post('/api/admin/units').set(auth('gestora')).send({ name, type: 'UBS', cnes, ibgeCode: '3550308' }).expect(201)).body as { id: string; cnes: string };
  const abrir = (unitId: string, desde: string) => t.http().post('/api/vigilancia/unidades-notificantes').set(auth('vig')).send({ unitId, desde }).expect(201);
  const atestarEmNome = (unitId: string, semana: string) =>
    t
      .http()
      .post('/api/vigilancia/negativas')
      .set(auth('vig'))
      .send({ unitId, semana, emNome: { motivo: 'Negativa informada por telefone pela unidade' } });
  const patchVig = (corpo: Record<string, unknown>) => t.http().patch('/api/vigilancia/configuracoes').set(auth('vig')).send(corpo);
  /** Outra conexão (superusuário) ao banco da instituição, para segurar travas como uma transação concorrente. */
  const outraConexao = async () => {
    const url = new URL(TEST_PG);
    url.pathname = `/tenant_db_${t.slug.replace(/-/g, '_')}`;
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    return c;
  };
  /** Espera (até 5 s) `n` conexões deste banco, fora a que pergunta, paradas numa trava (consultiva ou de linha). */
  const esperarTravas = async (c: Client, n: number) => {
    for (let i = 0; i < 100; i++) {
      const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`);
      if (rows[0]!.n >= n) return;
      await esperar(50);
    }
    throw new Error(`Não chegaram ${n} pedidos parados numa trava`);
  };

  beforeAll(async () => {
    t = await startTestApp('vignegr5');
    t.app.get(AiService).client = null;
    tk.gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    tk.vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    admin = t.app.get(AdminService);
    negativas = t.app.get(NegativaService);
    for (const s of demoFixtures.STAFF) usuario[s.key] = (await db.user.findUniqueOrThrow({ where: { cpf: s.cpf } })).id;
    // Começa sem a configuração da negativa que a semeadura da demonstração tenha gravado.
    for (const tabela of ['negative_reports', 'notifying_unit_responsibles', 'notifying_units']) await db.$executeRawUnsafe(`DELETE FROM ${tabela}`);
  });

  afterEach(() => {
    const agora = () => new Date();
    admin.agora = agora;
    negativas.agora = agora;
  });

  afterAll(async () => {
    await t?.close();
  });

  it('R5-11: a célula leva o prazo gravado de cada atesto; a coluna, o prazo da semana pela regra de agora', async () => {
    await patchVig({ negativa: { prazoDiaSemana: 1, prazoHora: '14:00' } }).expect(200);
    relogio(at('2026-06-17T15:00:00Z'));
    const atrasada = await novaUnidade('UBS R5 Prazo Gravado', '9005911');
    const noPrazo = await novaUnidade('UBS R5 Prazo Antigo', '9005912');
    const depois = await novaUnidade('UBS R5 Prazo Novo', '9005913');
    for (const u of [atrasada, noPrazo, depois]) await abrir(u.id, '2026-01-01');
    // Segunda 22/06 (Brasília): às 13h30 uma unidade atesta a SE 24 no prazo das 14h; às 14h30 a outra, fora dele.
    relogio(at('2026-06-22T16:30:00Z'));
    const a1 = (await atestarEmNome(noPrazo.id, '202624').expect(201)).body as { id: string; atrasado: boolean };
    relogio(at('2026-06-22T17:30:00Z'));
    const a2 = (await atestarEmNome(atrasada.id, '202624').expect(201)).body as { id: string; atrasado: boolean; atestadoEm: string };
    expect([a1.atrasado, a2.atrasado]).toEqual([false, true]);
    // A vigilância estende o prazo para as 18h; às 17h50 a terceira atesta, no prazo da regra nova.
    await patchVig({ negativa: { prazoHora: '18:00' } }).expect(200);
    relogio(at('2026-06-22T20:50:00Z'));
    const a3 = (await atestarEmNome(depois.id, '202624').expect(201)).body as { id: string; atrasado: boolean };
    expect(a3.atrasado).toBe(false);

    relogio(at('2026-07-01T15:00:00Z'));
    const g = (await t.http().get('/api/vigilancia/negativas/grade?semanas=4&ate=202625').set(auth('gestora')).expect(200)).body as Grade;
    const coluna = g.colunas.find((c) => c.semana === '202624')!;
    const celula = (unitId: string) => g.linhas.find((l) => l.unidade.id === unitId)!.celulas.find((c) => c.semana === '202624')!;
    // O prazo da semana (coluna) é o da regra de agora: segunda 22/06, 18h de Brasília.
    expect(coluna.prazo).toBe('2026-06-22T21:00:00.000Z');
    // Cada atesto leva o prazo gravado com ele, o que decidiu o "fora do prazo".
    expect(celula(atrasada.id)).toMatchObject({ situacao: 'NEGATIVA_ATRASADA', fontes: { atesto: { id: a2.id, atrasado: true, prazo: '2026-06-22T17:00:00.000Z' } } });
    expect(celula(noPrazo.id)).toMatchObject({ situacao: 'NEGATIVA', fontes: { atesto: { id: a1.id, atrasado: false, prazo: '2026-06-22T17:00:00.000Z' } } });
    expect(celula(depois.id)).toMatchObject({ situacao: 'NEGATIVA', fontes: { atesto: { id: a3.id, atrasado: false, prazo: '2026-06-22T21:00:00.000Z' } } });
    // O cenário do revisor: o atesto das 14h30 marcado fora do prazo é coerente com o prazo mostrado para ele (14h).
    const doAtesto = celula(atrasada.id).fontes.atesto!;
    expect(Date.parse(a2.atestadoEm) > Date.parse(doAtesto.prazo)).toBe(true);
    // É o prazo gravado no banco.
    const gravados = await db.negativeReport.findMany({ where: { id: { in: [a1.id, a2.id, a3.id] } }, select: { id: true, deadlineAt: true } });
    for (const x of gravados) expect([celula(atrasada.id), celula(noPrazo.id), celula(depois.id)].find((c) => c.fontes.atesto?.id === x.id)!.fontes.atesto!.prazo).toBe(x.deadlineAt.toISOString());
  });

  /**
   * Monta a unidade com o titular que não vale (perdeu a lotação) e a nova titular lotada; a designação dela é feita com
   * a trilha presa por outra conexão, e o cadastro chega enquanto ela espera. Devolve as respostas das duas.
   */
  async function designarComCadastro(nome: string, cnes: string, cadastro: (unitId: string) => Promise<{ status: number; body: unknown }>) {
    const u = await novaUnidade(nome, cnes);
    await abrir(u.id, '2026-01-01');
    for (const [key, role, cbo] of [
      ['enfermeiro', 'ENFERMAGEM', '223505'],
      ['medica', 'MEDICO', '225125'],
    ] as const)
      await db.userAssignment.create({ data: { userId: usuario[key]!, unitId: u.id, role, cbo, active: true } });
    await t.http().post(`/api/vigilancia/unidades-notificantes/${u.id}/responsaveis`).set(auth('vig')).send({ userId: usuario.enfermeiro, tipo: 'TITULAR', desde: '2026-01-01' }).expect(201);
    // O titular perde a lotação na unidade: a designação dele deixa de valer, e a próxima designação de titular o encerra.
    await db.userAssignment.updateMany({ where: { userId: usuario.enfermeiro, unitId: u.id }, data: { active: false } });
    const hoje = localDateString(new Date(), 'America/Sao_Paulo');
    const segurador = await outraConexao();
    let designar: Promise<{ status: number; body: unknown }> | null = null;
    let doCadastro: Promise<{ status: number; body: unknown }> | null = null;
    try {
      await segurador.query(`SELECT pg_advisory_lock(hashtext('omnisaude_audit_chain'))`);
      designar = t
        .http()
        .post(`/api/vigilancia/unidades-notificantes/${u.id}/responsaveis`)
        .set(auth('vig'))
        .send({ userId: usuario.medica, tipo: 'TITULAR', desde: hoje })
        .then((x) => x);
      await esperarTravas(segurador, 1);
      doCadastro = cadastro(u.id);
      // O cadastro para na linha (a designação já a pediu pela chave estrangeira) ou na trilha (a ordem antiga).
      await esperarTravas(segurador, 2);
      await segurador.query(`SELECT pg_advisory_unlock(hashtext('omnisaude_audit_chain'))`);
      const [rd, rc] = await Promise.all([designar, doCadastro]);
      return { u, hoje, designar: rd, cadastro: rc };
    } finally {
      await segurador.query(`SELECT pg_advisory_unlock_all()`).catch(() => {});
      await segurador.end();
      await Promise.allSettled([designar, doCadastro]);
    }
  }

  /** A designação terminou inteira: o titular antigo encerrado hoje, a nova titular ativa e a trilha na ordem dos fatos. */
  async function conferirDesignacao(unitId: string, hoje: string) {
    const designacoes = await db.notifyingUnitResponsible.findMany({ where: { unitId }, orderBy: { designatedAt: 'asc' }, select: { id: true, userId: true, kind: true, until: true } });
    expect(designacoes.map((d) => [d.userId, d.kind, d.until?.toISOString().slice(0, 10) ?? null])).toEqual([
      [usuario.enfermeiro, 'TITULAR', hoje],
      [usuario.medica, 'TITULAR', null],
    ]);
    const trilha = await db.auditEntry.findMany({ where: { entityId: { in: designacoes.map((d) => d.id) }, action: { in: ['vigilancia.negativa_revogar', 'vigilancia.negativa_designar'] } }, orderBy: { seq: 'asc' } });
    // A primeira designação do enfermeiro, depois a revogação dele e a designação da médica (na mesma transação, nessa ordem).
    expect(trilha.map((e) => [e.action, e.entityId])).toEqual([
      ['vigilancia.negativa_designar', designacoes[0]!.id],
      ['vigilancia.negativa_revogar', designacoes[0]!.id],
      ['vigilancia.negativa_designar', designacoes[1]!.id],
    ]);
  }

  it('R5-12: designar o titular no lugar do que não vale enquanto o cadastro troca o CNES da unidade: as duas terminam (antes, impasse 40P01 e 500)', async () => {
    const r = await designarComCadastro('UBS R5 Designa e Troca CNES', '9005921', (unitId) =>
      t
        .http()
        .patch(`/api/admin/units/${unitId}`)
        .set(auth('gestora'))
        .send({ cnes: '9005922' })
        .then((x) => x),
    );
    console.log('R5NEG-DESIGNAR-CNES', r.designar.status, '| cadastro', r.cadastro.status, JSON.stringify(r.cadastro.body).slice(0, 200));
    expect({ designar: r.designar.status, cadastro: r.cadastro.status }).toEqual({ designar: 201, cadastro: 200 });
    expect((await db.unit.findUniqueOrThrow({ where: { id: r.u.id }, select: { cnes: true } })).cnes).toBe('9005922');
    await conferirDesignacao(r.u.id, r.hoje);
  });

  it('R5-12: o mesmo com o cadastro que troca o CNS da nova titular (a linha do usuário também é pedida pela designação)', async () => {
    const cns = cnsFromBase('10000000931');
    const r = await designarComCadastro('UBS R5 Designa e Troca CNS', '9005923', () =>
      t
        .http()
        .patch(`/api/admin/users/${usuario.medica}`)
        .set(auth('gestora'))
        .send({ cns })
        .then((x) => x),
    );
    console.log('R5NEG-DESIGNAR-CNS', r.designar.status, '| cadastro', r.cadastro.status, JSON.stringify(r.cadastro.body).slice(0, 200));
    expect({ designar: r.designar.status, cadastro: r.cadastro.status }).toEqual({ designar: 201, cadastro: 200 });
    expect((await db.user.findUniqueOrThrow({ where: { id: usuario.medica }, select: { cns: true } })).cns).toBe(cns);
    await conferirDesignacao(r.u.id, r.hoje);
  });
});
