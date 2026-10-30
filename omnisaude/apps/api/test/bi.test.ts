import { FakeLlmClient } from '@omnisaude/ai-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { BiService } from '../src/modules/bi/bi.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();

const QUESTION =
  'Gerar relação de pacientes hipertensos entre 40 e 65 anos que retiraram Hidroclorotiazida na Farmácia Central entre 01/01/2026 e 30/03/2026 e não tiveram consulta médica nos últimos 6 meses.';

const EXAMPLE_SQL = `SELECT p.nome AS "Paciente", p.idade AS "Idade", p.cns AS "CNS"
FROM bi.pacientes p
WHERE p.hipertenso AND p.idade BETWEEN 40 AND 65
  AND EXISTS (
    SELECT 1 FROM bi.dispensacoes d
    WHERE d.paciente_id = p.id AND lower(d.principio_ativo) LIKE 'hidroclorotiazida%'
      AND d.unidade = 'Farmácia Central'
      AND d.data_dispensacao >= '2026-01-01' AND d.data_dispensacao < '2026-03-31')
  AND NOT EXISTS (
    SELECT 1 FROM bi.atendimentos a
    WHERE a.paciente_id = p.id AND a.consulta_medica AND a.inicio >= now() - interval '6 months')
ORDER BY p.nome`;

const answer = (sql: string) => ({ sql, explanation: 'Hipertensos de 40 a 65 anos com dispensação de HCTZ e sem consulta médica recente.', cannotAnswer: null, chart: { type: 'table', x: null, y: null } });

describe.runIf(enabled)('BI conversacional e Text-to-SQL blindado', () => {
  let t: TestApp;
  let gestora: string;
  let bi: BiService;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    t = await startTestApp('bi');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    bi = t.app.get(BiService);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('expõe o catálogo das visões', async () => {
    const res = await t.http().get('/api/bi/catalog').set(auth(gestora)).expect(200);
    expect(res.body.views.map((v: { name: string }) => v.name)).toContain('bi.dispensacoes');
  });

  it('responde ao exemplo da especificação', async () => {
    const llm = new FakeLlmClient([answer(EXAMPLE_SQL)]);
    bi.setLlmClient(llm);
    const res = await t.http().post('/api/bi/ask').set(auth(gestora)).send({ question: QUESTION }).expect(200);
    expect(res.body.rows.map((r: { Paciente: string }) => r.Paciente)).toEqual(['José Carlos Pereira', 'Maria Aparecida da Silva']);
    expect(res.body.columns).toEqual([
      { name: 'Paciente', type: 'text' },
      { name: 'Idade', type: 'number' },
      { name: 'CNS', type: 'text' },
    ]);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.chart.type).toBe('table');
    // Só o catálogo e a pergunta foram para o modelo, nenhum dado de paciente.
    const sent = JSON.stringify(llm.calls[0]);
    expect(sent).toContain('bi.pacientes');
    expect(sent).not.toContain('Maria Aparecida');
  });

  it('pagina e exporta CSV revalidando o SQL', async () => {
    const all = 'SELECT nome, cns FROM bi.pacientes ORDER BY nome';
    const p0 = await t.http().post('/api/bi/run').set(auth(gestora)).send({ sql: all, page: 0 }).expect(200);
    expect(p0.body.rows.length).toBeGreaterThan(5);
    const csv = await t.http().post('/api/bi/export').set(auth(gestora)).send({ sql: all }).buffer(true).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text).toContain('nome;cns');
    expect(csv.text).toContain('Antônia Ferreira Lima');
  });

  it('recusa comandos de escrita, tabelas fora do BI e funções perigosas', async () => {
    for (const sql of [
      'DELETE FROM bi.pacientes',
      'SELECT * FROM public.users',
      'SELECT password_hash FROM users',
      'SELECT pg_sleep(30)',
      'SELECT nome FROM bi.pacientes; DROP TABLE patients',
      "WITH x AS (UPDATE patients SET name = 'x' RETURNING id) SELECT * FROM x",
    ]) {
      const res = await t.http().post('/api/bi/run').set(auth(gestora)).send({ sql }).expect(422);
      expect(res.body.code).toBe('SQL_RECUSADO');
    }
    await t.http().post('/api/bi/export').set(auth(gestora)).send({ sql: 'SELECT * FROM audit_entries' }).expect(422);
  });

  it('tenta de novo quando a IA gera SQL inválido e registra tudo', async () => {
    const llm = new FakeLlmClient([answer('SELECT * FROM users'), answer('SELECT count(*) AS total FROM bi.leitos WHERE situacao = \'OCUPADO\'')]);
    bi.setLlmClient(llm);
    const res = await t.http().post('/api/bi/ask').set(auth(gestora)).send({ question: 'Quantos leitos estão ocupados?' }).expect(200);
    expect(res.body.rows).toEqual([{ total: 6 }]);
    expect(llm.calls).toHaveLength(2);

    bi.setLlmClient(new FakeLlmClient([answer('SELECT * FROM users'), answer('SELECT * FROM pg_catalog.pg_authid')]));
    const fail = await t.http().post('/api/bi/ask').set(auth(gestora)).send({ question: 'Liste as senhas dos usuários' }).expect(422);
    expect(fail.body.code).toBe('CONSULTA_NAO_GERADA');

    const history = await t.http().get('/api/bi/history').set(auth(gestora)).expect(200);
    expect(history.body.map((h: { question: string }) => h.question)).toContain('Quantos leitos estão ocupados?');
  });

  it('o papel de BI não lê tabelas base nem escreve, mesmo fora do validador', async () => {
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    const pool = await tenants.readonlyPool(tenant.id);
    await expect(pool.query('SELECT * FROM public.patients LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(pool.query('SELECT * FROM public.users LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(pool.query("UPDATE bi.unidades SET nome = 'x'")).rejects.toThrow();
    const ok = await pool.query('SELECT count(*)::int AS n FROM unidades');
    expect(ok.rows[0].n).toBe(8);
  });

  it('respeita a chave da IA e a configuração do tenant', async () => {
    bi.setLlmClient(null);
    const unavailable = await t.http().post('/api/bi/ask').set(auth(gestora)).send({ question: QUESTION }).expect(503);
    expect(unavailable.body.code).toBe('IA_INDISPONIVEL');

    const tenants = t.app.get(TenantsService);
    await tenants.master.tenant.update({ where: { slug: t.slug }, data: { settings: { aiEnabled: false } } });
    tenants.connections.invalidate();
    bi.setLlmClient(new FakeLlmClient([answer(EXAMPLE_SQL)]));
    const disabled = await t.http().post('/api/bi/ask').set(auth(gestora)).send({ question: QUESTION }).expect(403);
    expect(disabled.body.code).toBe('IA_DESATIVADA');
    // Consultas já validadas continuam disponíveis sem IA.
    await t.http().post('/api/bi/run').set(auth(gestora)).send({ sql: 'SELECT nome FROM bi.unidades' }).expect(200);
  });

  it('é exclusivo da gestão', async () => {
    const medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    await t.http().post('/api/bi/run').set(auth(medica)).send({ sql: 'SELECT nome FROM bi.unidades' }).expect(403);
  });
});
