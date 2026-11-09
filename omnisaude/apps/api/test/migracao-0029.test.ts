import { randomUUID } from 'node:crypto';
import { applyMigrations, loadMigrations } from '@omnisaude/database';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, TEST_PG } from './harness';

/**
 * A migração 0029 corrige dados gravados antes de duas regras da semana 26: a ordem de bloqueio com o início do campo
 * antes da abertura passa a começar na abertura, e cada cadastro unificado numa cadeia (x em d, d em s) passa a apontar
 * para o fim dela. Aplicada pelo pacote de banco como num município que estava na 0028, e rodada de novo sem mudar nada.
 */
const enabled = await pgAvailable();

const MIGRACAO = '0029_inicio_do_campo_e_cadeia_de_unificacao';
const SUFIXO = (process.env.OMNI_TEST_SUFFIX ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const BANCO = `omni_test_mig0029${SUFIXO}`;

describe.runIf(enabled)('Migração 0029: início do campo antes da abertura e cadeias de unificação de cadastros', () => {
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
    expect(await applyMigrations(conexao, 'tenant')).toContain(MIGRACAO);
    db = new Client({ connectionString: conexao });
    await db.connect();
    // A 0029 só mexe em dados: sem o registro dela, o banco é o de um município que estava na 0028.
    await db.query('DELETE FROM _omni_migrations WHERE name = $1', [MIGRACAO]);
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    await comoSuperusuario(`DROP DATABASE IF EXISTS ${BANCO} WITH (FORCE)`);
  });

  it('corrige o início do campo e as cadeias de unificação, e a segunda rodada não muda nada', async () => {
    const ordem = { antes: randomUUID(), depois: randomUUID(), semCampo: randomUUID() };
    await db.query(
      `INSERT INTO blocking_orders (id, year, seq, status, radius_m, opened_at, started_at, updated_at) VALUES
        ($1, 2026, 901, 'EM_CAMPO', 150, '2026-10-05 12:00', '2026-10-05 08:00', now()),
        ($2, 2026, 902, 'CONCLUIDA', 150, '2026-10-05 12:00', '2026-10-06 09:00', now()),
        ($3, 2026, 903, 'ABERTA', 150, '2026-10-05 12:00', NULL, now())`,
      [ordem.antes, ordem.depois, ordem.semCampo],
    );
    // Cadeias x → d → s e y → x → d → s, a unificação direta z → s, o ciclo a ↔ b e c → a (que não chega a um fim).
    const p = Object.fromEntries(['s', 'd', 'x', 'y', 'z', 'a', 'b', 'c'].map((k) => [k, randomUUID()]));
    for (const [k, id] of Object.entries(p))
      await db.query(`INSERT INTO patients (id, name, name_key, birth_date, sex, updated_at) VALUES ($1, $2, $3, '1980-01-01', 'F', '2026-01-02 03:04:05')`, [
        id,
        `Pessoa Cadeia ${k.toUpperCase()}`,
        `PESSOA CADEIA ${k.toUpperCase()}`,
      ]);
    for (const [de, para] of [
      ['d', 's'],
      ['x', 'd'],
      ['y', 'x'],
      ['z', 's'],
      ['a', 'b'],
      ['b', 'a'],
      ['c', 'a'],
    ])
      await db.query('UPDATE patients SET merged_into_id = $2 WHERE id = $1', [p[de], p[para]]);
    const nome = new Map<string, string>(Object.entries(p).map(([k, id]) => [id, k]));
    const retrato = async () => ({
      ordens: Object.fromEntries(
        (await db.query<{ id: string; opened_at: Date; started_at: Date | null }>('SELECT id, opened_at, started_at FROM blocking_orders WHERE id = ANY($1::uuid[])', [Object.values(ordem)])).rows.map((o) => [
          Object.entries(ordem).find(([, id]) => id === o.id)![0],
          { abertura: o.opened_at.toISOString(), inicio: o.started_at?.toISOString() ?? null },
        ]),
      ),
      unificados: Object.fromEntries(
        (await db.query<{ id: string; merged_into_id: string | null; updated_at: Date }>('SELECT id, merged_into_id, updated_at FROM patients WHERE id = ANY($1::uuid[])', [Object.values(p)])).rows.map((x) => [
          nome.get(x.id)!,
          { em: x.merged_into_id ? nome.get(x.merged_into_id)! : null, alterado: x.updated_at.toISOString() },
        ]),
      ),
    });

    const antes = await retrato();
    expect(antes.ordens.antes.inicio! < antes.ordens.antes.abertura).toBe(true);

    // O pacote de banco aplica só a 0029 (as anteriores já estão registradas).
    expect(await applyMigrations(conexao, 'tenant')).toEqual([MIGRACAO]);
    const depois = await retrato();
    // Só a ordem com o início antes da abertura muda: passa a começar na abertura.
    expect(depois.ordens).toEqual({ ...antes.ordens, antes: { abertura: antes.ordens.antes.abertura, inicio: antes.ordens.antes.abertura } });
    // Cada cadastro unificado aponta para o fim da cadeia; o ciclo fica como estava (ninguém aponta para si mesmo), e
    // updated_at não muda (o cadastro unificado não volta ao e-SUS).
    const alterado = antes.unificados.s!.alterado;
    expect(depois.unificados).toEqual({
      s: { em: null, alterado },
      d: { em: 's', alterado },
      x: { em: 's', alterado },
      y: { em: 's', alterado },
      z: { em: 's', alterado },
      a: { em: 'b', alterado },
      b: { em: 'a', alterado },
      c: { em: 'a', alterado },
    });

    // Idempotente: rodada de novo, nenhum comando acha o que corrigir.
    const sql = loadMigrations('tenant').find((m) => m.name === MIGRACAO)!.sql;
    const rodada = await db.query(sql);
    expect((Array.isArray(rodada) ? rodada : [rodada]).map((r) => `${r.command} ${r.rowCount}`)).toEqual(['UPDATE 0', 'UPDATE 0']);
    expect(await retrato()).toEqual(depois);
  });

  it('uma rodada só achata a cadeia de 60 saltos; o ciclo longo (e a cadeia que entra nele) fica como está', async () => {
    const sql = loadMigrations('tenant').find((m) => m.name === MIGRACAO)!.sql;
    const comandos = (r: unknown) => (Array.isArray(r) ? r : [r]).map((x: { command: string; rowCount: number }) => `${x.command} ${x.rowCount}`);
    // Cadeia p0 → p1 → ... → p60 (60 saltos até p60, que não foi unificado); ciclo k0 → k1 → ... → k59 → k0 (60 saltos)
    // e t → k0, que entra no ciclo e não chega a um fim.
    const cadeia = Array.from({ length: 61 }, () => randomUUID());
    const ciclo = Array.from({ length: 60 }, () => randomUUID());
    const t = randomUUID();
    const todos = [...cadeia, ...ciclo, t];
    await db.query(
      `INSERT INTO patients (id, name, name_key, birth_date, sex, updated_at)
       SELECT id, 'Pessoa Longa ' || n, 'PESSOA LONGA ' || n, '1980-01-01', 'F', '2026-01-02 03:04:05' FROM unnest($1::uuid[]) WITH ORDINALITY AS x(id, n)`,
      [todos],
    );
    const apontar = (de: string[], para: string[]) => db.query('UPDATE patients p SET merged_into_id = x.para FROM unnest($1::uuid[], $2::uuid[]) AS x(de, para) WHERE p.id = x.de', [de, para]);
    await apontar(cadeia.slice(0, 60), cadeia.slice(1));
    await apontar([...ciclo, t], [...ciclo.slice(1), ciclo[0]!, ciclo[0]!]);
    const destinos = async () =>
      new Map((await db.query<{ id: string; merged_into_id: string | null }>('SELECT id, merged_into_id FROM patients WHERE id = ANY($1::uuid[])', [todos])).rows.map((x) => [x.id, x.merged_into_id]));
    const antes = await destinos();

    // Antes (até 50 saltos): p0 a p9 não chegavam a p60 na primeira rodada, e a segunda ainda mudava 10 cadastros.
    expect(comandos(await db.query(sql))).toEqual(['UPDATE 0', 'UPDATE 59']);
    const depois = await destinos();
    for (const id of cadeia.slice(0, 60)) expect(depois.get(id)).toBe(cadeia[60]);
    expect(depois.get(cadeia[60]!)).toBeNull();
    for (const id of [...ciclo, t]) expect(depois.get(id)).toBe(antes.get(id));
    // Rodar de novo não muda nada.
    expect(comandos(await db.query(sql))).toEqual(['UPDATE 0', 'UPDATE 0']);
    expect(await destinos()).toEqual(depois);
  });
});
