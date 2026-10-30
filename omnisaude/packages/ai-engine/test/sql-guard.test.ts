import { describe, expect, it } from 'vitest';
import { paginate, validateBiQuery, type SqlGuardPolicy } from '@omnisaude/ai-engine';

const policy: SqlGuardPolicy = {
  allowedRelations: ['bi.atendimentos', 'bi.dispensacoes', 'bi.pacientes'],
  maxRows: 500,
};

async function rejected(sql: string): Promise<string[]> {
  const r = await validateBiQuery(sql, policy);
  expect(r.ok, `deveria recusar: ${sql}`).toBe(false);
  return r.ok ? [] : r.errors;
}

async function accepted(sql: string) {
  const r = await validateBiQuery(sql, policy);
  if (!r.ok) throw new Error(`deveria aceitar: ${sql}\n${r.errors.join('\n')}`);
  return r;
}

describe('sql-guard: consultas analíticas válidas', () => {
  it.each([
    'SELECT count(*) FROM bi.atendimentos',
    `SELECT p.sexo, count(*) AS total FROM bi.pacientes p JOIN bi.atendimentos a ON a.paciente_id = p.id
       WHERE a.data_atendimento >= current_date - interval '6 months' GROUP BY p.sexo ORDER BY total DESC`,
    `WITH hipertensos AS (SELECT id FROM bi.pacientes WHERE 'I10' = ANY(cids) AND idade BETWEEN 40 AND 65)
       SELECT h.id FROM hipertensos h
       WHERE EXISTS (SELECT 1 FROM bi.dispensacoes d WHERE d.paciente_id = h.id AND lower(d.medicamento) LIKE '%hidroclorotiazida%'
                     AND d.data BETWEEN '2026-01-01' AND '2026-03-30')
         AND NOT EXISTS (SELECT 1 FROM bi.atendimentos a WHERE a.paciente_id = h.id AND a.data_atendimento > now() - interval '6 months')`,
    `SELECT date_trunc('month', data_atendimento) AS mes, extract(year from data_atendimento)::int AS ano,
       round(avg(tempo_espera_min)::numeric, 1), coalesce(nullif(unidade, ''), 'Sem unidade') AS unidade,
       CASE WHEN count(*) > 10 THEN 'alto' ELSE 'baixo' END
       FROM bi.atendimentos GROUP BY 1, 2, 4`,
    `SELECT unidade, rank() OVER (ORDER BY count(*) DESC) FROM atendimentos GROUP BY unidade`,
    `SELECT a.unidade FROM bi.atendimentos a UNION ALL SELECT d.unidade FROM bi.dispensacoes d`,
    `SELECT to_char(data_atendimento AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') FROM bi.atendimentos;`,
    `SELECT * FROM generate_series(date '2026-01-01', date '2026-06-01', interval '1 month') AS m(mes)`,
    `SELECT x.total FROM (SELECT count(*) AS total FROM bi.dispensacoes) x -- comentário final`,
  ])('aceita: %s', async (sql) => {
    await accepted(sql);
  });

  it('pagina com teto de linhas e remove o ponto e vírgula', async () => {
    const r = await accepted('SELECT * FROM bi.atendimentos ;  ');
    expect(r.sql).toBe('SELECT * FROM bi.atendimentos');
    expect(r.limit).toBe(500);
    expect(r.paginatedSql).toBe('SELECT * FROM (\nSELECT * FROM bi.atendimentos\n) AS q LIMIT 500 OFFSET 0');
    const page = await validateBiQuery('SELECT * FROM bi.atendimentos', policy, { limit: 10_000, offset: 20 });
    expect(page.ok && [page.limit, page.offset]).toEqual([500, 20]);
    expect(r.relations).toEqual(['bi.atendimentos']);
  });

  it('comentário de linha no fim não engole a paginação', async () => {
    const r = await accepted('SELECT 1 FROM bi.atendimentos -- LIMIT 1');
    expect(r.paginatedSql.endsWith('LIMIT 500 OFFSET 0')).toBe(true);
  });

  it('paginate recusa valores inválidos', () => {
    expect(() => paginate('SELECT 1', { limit: 0, offset: 0 })).toThrow();
    expect(() => paginate('SELECT 1', { limit: 1.5, offset: 0 })).toThrow();
  });
});

describe('sql-guard: ataques', () => {
  it.each([
    ['DELETE FROM bi.atendimentos', /DELETE/],
    ['UPDATE bi.pacientes SET nome = 1', /UPDATE/],
    ["INSERT INTO bi.pacientes (nome) VALUES ('x')", /INSERT/],
    ['DROP TABLE bi.pacientes', /DROP/],
    ['ALTER TABLE bi.pacientes ADD COLUMN x int', /ALTER/],
    ['GRANT ALL ON bi.pacientes TO public', /GRANT/],
    ['TRUNCATE bi.atendimentos', /TRUNCATE/],
    ["COPY bi.pacientes TO '/tmp/x'", /COPY/],
    ["SET statement_timeout = 0", /SET/],
    ['EXPLAIN ANALYZE DELETE FROM bi.atendimentos', /EXPLAIN/],
    ['SELECT 1 FROM bi.atendimentos; DROP TABLE bi.pacientes', /uma instrução/],
    ['SELECT 1; SELECT 2', /uma instrução/],
  ])('recusa comando: %s', async (sql, expected) => {
    const errors = await rejected(sql);
    expect(errors.join(' ')).toMatch(expected);
  });

  it('recusa CTE que modifica dados', async () => {
    const errors = await rejected('WITH x AS (DELETE FROM bi.atendimentos RETURNING *) SELECT * FROM x');
    expect(errors.join(' ')).toMatch(/WITH/);
    await rejected('WITH x AS (UPDATE bi.pacientes SET nome = nome RETURNING id) SELECT count(*) FROM x');
    await rejected("WITH x AS (INSERT INTO bi.pacientes (nome) VALUES ('a') RETURNING id) SELECT 1");
  });

  it('recusa bloqueios, SELECT INTO e WITH RECURSIVE', async () => {
    expect((await rejected('SELECT * FROM bi.atendimentos FOR UPDATE')).join()).toMatch(/FOR UPDATE/);
    expect((await rejected('SELECT * FROM bi.atendimentos FOR SHARE')).join()).toMatch(/FOR UPDATE/);
    expect((await rejected('SELECT * INTO copia FROM bi.atendimentos')).join()).toMatch(/SELECT INTO/);
    await rejected('WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT * FROM r');
  });

  it.each([
    'SELECT pg_sleep(10)',
    'SELECT count(*) FROM bi.atendimentos WHERE pg_sleep(1) IS NOT NULL',
    'SELECT * FROM bi.atendimentos ORDER BY pg_sleep(1)',
    "SELECT * FROM dblink('host=x', 'select 1') AS t(a int)",
    "SELECT lo_import('/etc/passwd')",
    "SELECT set_config('role', 'postgres', false)",
    "SELECT current_setting('data_directory')",
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT query_to_xml('select * from usuarios', true, true, '')",
    "SELECT pg_catalog.pg_sleep(1)",
    "SELECT outro_schema.funcao(1) FROM bi.atendimentos",
    'SELECT "pg_sleep"(1)',
  ])('recusa função perigosa: %s', async (sql) => {
    const errors = await rejected(sql);
    expect(errors.join(' ')).toMatch(/Função não permitida|não permitid/);
  });

  it.each([
    'SELECT * FROM usuarios',
    'SELECT * FROM public.usuarios',
    'SELECT * FROM credenciais',
    'SELECT * FROM pg_catalog.pg_authid',
    'SELECT usename, passwd FROM pg_shadow',
    'SELECT * FROM information_schema.tables',
    'SELECT * FROM "Atendimentos"',
    'SELECT * FROM bi."pacientes_completo"',
    'SELECT * FROM outrobanco.bi.atendimentos',
    'SELECT a.* FROM bi.atendimentos a WHERE a.id IN (SELECT id FROM usuarios)',
    'SELECT * FROM bi.atendimentos WHERE EXISTS (SELECT 1 FROM tenant.credenciais)',
    'SELECT unidade FROM bi.atendimentos UNION SELECT senha_hash FROM usuarios',
    'SELECT * FROM bi.atendimentos a, LATERAL (SELECT * FROM usuarios u WHERE u.id = a.id) x',
    'SELECT (SELECT max(senha) FROM usuarios) FROM bi.atendimentos',
    'SELECT * FROM bi.atendimentos /* comentário */ JOIN /* outro */ usuarios ON true',
  ])('recusa relação fora da lista: %s', async (sql) => {
    const errors = await rejected(sql);
    expect(errors.join(' ')).toMatch(/Tabela ou visão não permitida|outros bancos/);
  });

  it('respeita o escopo das CTEs (nome de CTE não vaza para outro escopo)', async () => {
    // A CTE "usuarios" só existe dentro do primeiro ramo; no segundo, o nome resolve para a tabela real.
    await rejected('SELECT * FROM (WITH usuarios AS (SELECT 1 AS id) SELECT * FROM usuarios) a, (SELECT * FROM usuarios) b');
    // Sem RECURSIVE, uma CTE não enxerga as posteriores.
    await rejected('WITH a AS (SELECT * FROM usuarios), usuarios AS (SELECT 1) SELECT * FROM a');
    await accepted('WITH usuarios AS (SELECT paciente_id FROM bi.atendimentos) SELECT * FROM usuarios');
    await accepted('WITH a AS (SELECT 1 AS n FROM bi.atendimentos), b AS (SELECT n FROM a) SELECT * FROM b');
  });

  it('recusa conversões de tipo de sistema, operadores estranhos e parâmetros', async () => {
    expect((await rejected("SELECT 'pg_authid'::regclass")).join()).toMatch(/tipo não permitida/);
    expect((await rejected('SELECT oid::regproc FROM bi.atendimentos')).join()).toMatch(/tipo/);
    await rejected('SELECT * FROM bi.atendimentos WHERE id = $1');
    await rejected('SELECT 1 OPERATOR(public.===) 2 FROM bi.atendimentos');
    await rejected('SELECT current_user');
    await rejected('SELECT session_user FROM bi.atendimentos');
    await rejected('SELECT xmlelement(name x) FROM bi.atendimentos');
    await rejected('SELECT * FROM bi.atendimentos TABLESAMPLE SYSTEM (10)');
  });

  it('recusa SQL inválido, vazio ou longo demais', async () => {
    expect((await rejected('SELEC * FRM x')).join()).toMatch(/SQL inválido/);
    expect((await rejected('   ')).join()).toMatch(/vazia/);
    expect((await rejected('-- só comentário')).join()).toMatch(/vazia/);
    await rejected(`SELECT ${'1 + '.repeat(6000)}1 FROM bi.atendimentos`);
  });

  it('não aceita lista de funções vazia como permissiva', async () => {
    const strict = await validateBiQuery('SELECT count(*) FROM bi.atendimentos', { ...policy, allowedFunctions: [] });
    expect(strict.ok).toBe(false);
  });
});
