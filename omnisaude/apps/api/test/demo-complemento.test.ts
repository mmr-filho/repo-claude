import { applyMigrations, completarDemoNoBanco, demoFixtures } from '@omnisaude/database';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, TEST_PG } from './harness';

/**
 * A carga da demonstração só roda em instituição vazia. Uma demonstração publicada antes de a tabela de acessos crescer
 * ficava sem os profissionais novos (8 dos 18 do README no ambiente publicado). A partida agora completa unidades,
 * profissionais e lotações que faltam, sem mexer no que já existe.
 */
const enabled = await pgAvailable();
const SUFIXO = (process.env.OMNI_TEST_SUFFIX ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const BANCO = `omni_test_democompl${SUFIXO}`;

describe.runIf(enabled)('Complemento da demonstração na partida', () => {
  const url = new URL(TEST_PG);
  const conexao = `postgresql://omni_app:omni_app@${url.hostname}:${url.port}/${BANCO}`;
  let db: Client;

  async function comoSuperusuario(sql: string) {
    const c = new Client({ connectionString: TEST_PG });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    await comoSuperusuario(`DROP DATABASE IF EXISTS ${BANCO} WITH (FORCE)`);
    await comoSuperusuario(`CREATE DATABASE ${BANCO} OWNER omni_app`);
    await applyMigrations(conexao, 'tenant');
    db = new Client({ connectionString: conexao });
    await db.connect();
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await comoSuperusuario(`DROP DATABASE IF EXISTS ${BANCO} WITH (FORCE)`);
  });

  it('cria só o que falta (unidades, profissionais e lotações) e a segunda rodada não muda nada', async () => {
    const { UNITS, STAFF, DEMO_TENANT } = demoFixtures;
    const unidade = (key: string) => UNITS.find((u) => u.key === key)!;
    // Demonstração antiga: duas unidades, o NIR só no hospital (sem a policlínica) e uma senha trocada pela pessoa.
    const ids: Record<string, string> = {};
    for (const key of ['ubs', 'hosp']) {
      const u = unidade(key);
      ids[key] = (
        await db.query<{ id: string }>(`INSERT INTO units (id, cnes, name, type, ibge_code) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`, [u.cnes, u.name, u.type, DEMO_TENANT.ibgeCode])
      ).rows[0]!.id;
    }
    const nir = STAFF.find((s) => s.key === 'nir')!;
    const fabio = (
      await db.query<{ id: string }>(`INSERT INTO users (id, cpf, cns, name, email, password_hash) VALUES (gen_random_uuid(), $1, $2, 'Nome trocado pela gestão', $3, 'hash-proprio') RETURNING id`, [
        nir.cpf,
        nir.cns,
        `${nir.key}@demo.omnisaude.dev`,
      ])
    ).rows[0]!.id;
    await db.query(`INSERT INTO user_assignments (id, user_id, unit_id, role, cbo, active) VALUES (gen_random_uuid(), $1, $2, 'NIR', '223505', true)`, [fabio, ids.hosp]);

    const feito = await completarDemoNoBanco(conexao);
    expect(feito.unidades).toHaveLength(UNITS.length - 2);
    expect(feito.profissionais).toHaveLength(STAFF.length - 1);
    expect(feito.lotacoes).toEqual([`${nir.name} (NIR)`]);

    const unidades = (await db.query<{ cnes: string }>('SELECT cnes FROM units')).rows.map((r) => r.cnes).sort();
    expect(unidades).toEqual(UNITS.map((u) => u.cnes).sort());
    const usuarios = (await db.query<{ cpf: string }>('SELECT cpf FROM users')).rows.map((r) => r.cpf).sort();
    expect(usuarios).toEqual(STAFF.map((s) => s.cpf).sort());
    // Cada profissional da demonstração tem todas as lotações da carga atual.
    for (const s of STAFF) {
      const lotacoes = (
        await db.query<{ cnes: string; role: string }>('SELECT u.cnes, a.role FROM user_assignments a JOIN users p ON p.id = a.user_id JOIN units u ON u.id = a.unit_id WHERE p.cpf = $1', [s.cpf])
      ).rows.map((r) => `${r.cnes}:${r.role}`);
      expect(lotacoes.sort()).toEqual(s.assignments.map((a) => `${unidade(a.unit).cnes}:${a.role}`).sort());
    }
    // Quem já existia fica como estava: nome e senha não mudam.
    const existente = (await db.query<{ name: string; password_hash: string }>('SELECT name, password_hash FROM users WHERE id = $1', [fabio])).rows[0]!;
    expect(existente).toEqual({ name: 'Nome trocado pela gestão', password_hash: 'hash-proprio' });

    // Segunda rodada: nada a fazer, e a lotação desativada pela gestão não volta.
    await db.query(`UPDATE user_assignments SET active = false WHERE user_id = $1 AND unit_id = $2`, [fabio, ids.hosp]);
    expect(await completarDemoNoBanco(conexao)).toEqual({ unidades: [], profissionais: [], lotacoes: [] });
    expect((await db.query('SELECT 1 FROM user_assignments WHERE user_id = $1 AND unit_id = $2 AND active', [fabio, ids.hosp])).rowCount).toBe(0);
  }, 60_000);
});
