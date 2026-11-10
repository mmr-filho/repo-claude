import { randomUUID } from 'node:crypto';
import { applyMigrations, loadMigrations } from '@omnisaude/database';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, TEST_PG } from './harness';

/**
 * A migração 0030 (VIG-1c) cria as tabelas da consolidação, do diagrama, da contingência, do surto e da negativa, e
 * semeia as unidades notificantes do município que já tem unidades: um período aberto desde 01/01/2026 para cada
 * unidade ativa, fora a central de abastecimento farmacêutico, o almoxarifado e a vigilância em saúde. Aplicada pelo
 * pacote de banco como num município que estava na 0029, com unidades de todos os tipos.
 */
const enabled = await pgAvailable();

const MIGRACAO = '0030_consolidacao_surto_negativa';
const SUFIXO = (process.env.OMNI_TEST_SUFFIX ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const BANCO = `omni_test_mig0030${SUFIXO}`;

/** Unidades do município antes da 0030 (nome, tipo, ativa). */
const UNIDADES: [string, string, boolean][] = [
  ['UBS Centro', 'UBS', true],
  ['UPA Norte', 'UPA', true],
  ['Policlínica', 'POLICLINICA', true],
  ['Hospital Municipal', 'HOSPITAL', true],
  ['CEO', 'CEO', true],
  ['SAMU', 'SAMU', true],
  ['CAPS', 'CAPS', true],
  ['Laboratório Municipal', 'LABORATORIO', true],
  ['Central de Abastecimento Farmacêutico', 'FARMACIA_CENTRAL', true],
  ['Almoxarifado', 'ALMOXARIFADO', true],
  ['Vigilância em Saúde', 'VIGILANCIA_SAUDE', true],
  ['UBS Desativada', 'UBS', false],
];

describe.runIf(enabled)('Migração 0030: unidades notificantes semeadas e restrições das tabelas novas', () => {
  const url = new URL(TEST_PG);
  const conexao = `postgresql://omni_app:omni_app@${url.hostname}:${url.port}/${BANCO}`;
  const ids = new Map<string, string>();
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
    db = new Client({ connectionString: conexao });
    await db.connect();
    // As migrações anteriores à 0030, com o mesmo registro do pacote de banco: o banco fica como um município na 0029.
    await db.query(`CREATE TABLE IF NOT EXISTS _omni_migrations (name text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const m of loadMigrations('tenant').filter((x) => x.name < MIGRACAO)) {
      await db.query('BEGIN');
      await db.query(m.sql);
      await db.query('INSERT INTO _omni_migrations (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
      await db.query('COMMIT');
    }
    for (const [i, [nome, tipo, ativa]] of UNIDADES.entries()) {
      const id = randomUUID();
      ids.set(nome, id);
      await db.query(`INSERT INTO units (id, cnes, name, type, ibge_code, active) VALUES ($1, $2, $3, $4, '3550308', $5)`, [id, String(9000001 + i), nome, tipo, ativa]);
    }
    const aplicadas = await applyMigrations(conexao, 'tenant');
    expect(aplicadas[0]).toBe(MIGRACAO);
  }, 180_000);

  afterAll(async () => {
    await db?.end();
    await comoSuperusuario(`DROP DATABASE IF EXISTS ${BANCO} WITH (FORCE)`);
  });

  it('cada unidade ativa que atende vira notificante desde 01/01/2026, com um período aberto só', async () => {
    const { rows } = await db.query<{ name: string; periodos: number; desde: string | null; abertos: number }>(
      `SELECT u.name, count(n.id)::int AS periodos, to_char(min(n.since), 'YYYY-MM-DD') AS desde, count(n.id) FILTER (WHERE n.until IS NULL)::int AS abertos
       FROM units u LEFT JOIN notifying_units n ON n.unit_id = u.id GROUP BY u.id, u.name ORDER BY u.cnes`,
    );
    const notificantes = rows.filter((r) => r.periodos > 0);
    expect(notificantes.map((r) => r.name)).toEqual(['UBS Centro', 'UPA Norte', 'Policlínica', 'Hospital Municipal', 'CEO', 'SAMU', 'CAPS', 'Laboratório Municipal']);
    for (const r of notificantes) expect(r).toMatchObject({ periodos: 1, desde: '2026-01-01', abertos: 1 });
    // A semeadura não tem autor: a vigilância ajusta na tela das unidades notificantes.
    expect((await db.query('SELECT count(*)::int AS n FROM notifying_units WHERE created_by IS NOT NULL OR end_reason IS NOT NULL')).rows[0].n).toBe(0);
  });

  it('recusa o que o desenho proíbe e aceita o histórico', async () => {
    const ubs = ids.get('UBS Centro')!;
    const falha = (sql: string, params: unknown[]) =>
      db.query(sql, params).then(
        () => null,
        (e: { code: string; constraint: string }) => ({ code: e.code, constraint: e.constraint }),
      );
    // Unidade notificante: um período aberto por unidade; o período encerrado convive com o aberto.
    expect(await falha(`INSERT INTO notifying_units (id, unit_id, since) VALUES ($1, $2, '2026-02-01')`, [randomUUID(), ubs])).toEqual({ code: '23505', constraint: 'notifying_units_aberto' });
    expect(await falha(`INSERT INTO notifying_units (id, unit_id, since, until, end_reason) VALUES ($1, $2, '2025-01-01', '2025-12-31', 'Reforma')`, [randomUUID(), ubs])).toBeNull();

    // População: chave única com o território nulo no município; nível e território coerentes; população positiva.
    const populacao = `INSERT INTO population_estimates (id, year, level, territory_id, population, source, version, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())`;
    expect(await falha(populacao, [randomUUID(), 2025, 'MUNICIPIO', null, 100_000, 'RIPSA', '2025'])).toBeNull();
    expect(await falha(populacao, [randomUUID(), 2025, 'MUNICIPIO', null, 100_001, 'RIPSA', '2025'])).toEqual({ code: '23505', constraint: 'population_estimates_chave' });
    expect(await falha(populacao, [randomUUID(), 2025, 'MUNICIPIO', null, 99_000, 'RIPSA', '2026'])).toBeNull();
    expect(await falha(populacao, [randomUUID(), 2025, 'BAIRRO', null, 1_000, 'CENSO_2022', ''])).toEqual({ code: '23514', constraint: 'population_estimates_territorio' });
    expect(await falha(populacao, [randomUUID(), 2025, 'MUNICIPIO', randomUUID(), 1_000, 'CENSO_2022', ''])).toEqual({ code: '23514', constraint: 'population_estimates_territorio' });
    expect(await falha(populacao, [randomUUID(), 2024, 'MUNICIPIO', null, 0, 'RIPSA', ''])).toEqual({ code: '23514', constraint: 'population_estimates_population_check' });

    // Canal congelado: uma versão ativa por agravo, território e ano; as versões antigas ficam inativas.
    const canal = `INSERT INTO control_channels (id, group_key, level, year, version, active, recipe, reference_years, weeks, computed_by) VALUES ($1, 'dengue', 'MUNICIPIO', 2026, $2, $3, '{}', '{2021,2022,2023}', '[]', $4)`;
    expect(await falha(canal, [randomUUID(), 1, true, randomUUID()])).toBeNull();
    expect(await falha(canal, [randomUUID(), 2, true, randomUUID()])).toEqual({ code: '23505', constraint: 'control_channels_ativo' });
    expect(await falha(canal, [randomUUID(), 2, false, randomUUID()])).toBeNull();

    // Atesto da negativa: um ATESTADA por unidade e semana; o cancelado fica no histórico.
    const atesto = `INSERT INTO negative_reports (id, unit_id, epi_week, status, attested_by, attested_at, attester_name, declaration) VALUES ($1, $2, '202644', $3, $4, now(), 'Pessoa Sintética', 'Declaro...')`;
    expect(await falha(atesto, [randomUUID(), ubs, 'ATESTADA', randomUUID()])).toBeNull();
    expect(await falha(atesto, [randomUUID(), ubs, 'ATESTADA', randomUUID()])).toEqual({ code: '23505', constraint: 'negative_reports_atestada' });
    expect(await falha(atesto, [randomUUID(), ubs, 'CANCELADA', randomUUID()])).toBeNull();

    // Importação: o mesmo arquivo (SHA-256) não é aplicado duas vezes; a prévia repetida pode existir.
    const envio = `INSERT INTO official_imports (id, system, status, file_name, sha256, size_bytes, created_by) VALUES ($1, 'SINAN_NET', $2, 'NINDINET.DBF', $3, 10, $4)`;
    const sha = 'a'.repeat(64);
    expect(await falha(envio, [randomUUID(), 'APLICADA', sha, randomUUID()])).toBeNull();
    expect(await falha(envio, [randomUUID(), 'APLICADA', sha, randomUUID()])).toEqual({ code: '23505', constraint: 'official_imports_sha_aplicado' });
    expect(await falha(envio, [randomUUID(), 'PREVIA', sha, randomUUID()])).toBeNull();
  });
});
