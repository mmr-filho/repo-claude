import { describe, expect, it } from 'vitest';
import { FakeLlmClient, TextToSqlEngine, TextToSqlError, type BiCatalog } from '@omnisaude/ai-engine';

const catalog: BiCatalog = {
  views: [
    {
      name: 'bi.dispensacoes',
      description: 'Medicamentos entregues na farmácia, um registro por item dispensado.',
      columns: [
        { name: 'paciente_id', type: 'uuid' },
        { name: 'medicamento', type: 'text', description: 'Nome do medicamento' },
        { name: 'data', type: 'date' },
      ],
    },
    { name: 'bi.atendimentos', description: 'Consultas e atendimentos.', columns: [{ name: 'paciente_id', type: 'uuid' }] },
  ],
  notes: ['Datas no fuso do tenant.'],
};

const answer = (sql: string, extra: Partial<{ explanation: string; cannotAnswer: string | null }> = {}) => ({
  sql,
  explanation: extra.explanation ?? 'Total de dispensações.',
  cannotAnswer: extra.cannotAnswer ?? null,
  chart: { type: 'bar', x: 'medicamento', y: null },
});

describe('TextToSqlEngine', () => {
  it('gera SQL validado e paginado; o prompt leva só catálogo e pergunta', async () => {
    const llm = new FakeLlmClient([answer('SELECT medicamento, count(*) FROM bi.dispensacoes GROUP BY medicamento')]);
    const engine = new TextToSqlEngine({ llm, catalog, maxRows: 100 });
    const r = await engine.generate('Quais medicamentos mais dispensados?', { today: '2026-10-30', timeZone: 'America/Sao_Paulo' });
    expect(r.attempts).toBe(1);
    expect(r.relations).toEqual(['bi.dispensacoes']);
    expect(r.paginatedSql).toContain('LIMIT 100 OFFSET 0');
    expect(r.chart).toEqual({ type: 'bar', x: 'medicamento' });
    const call = llm.calls[0]!;
    expect(call.system).toContain('bi.dispensacoes');
    expect(call.system).toContain('Nome do medicamento');
    expect(call.content).toContain('2026-10-30');
    expect(call.task).toBe('text-to-sql');
  });

  it('reenvia os erros do validador e aceita a correção', async () => {
    const llm = new FakeLlmClient([answer('SELECT * FROM usuarios'), answer('SELECT count(*) FROM bi.atendimentos')]);
    const engine = new TextToSqlEngine({ llm, catalog });
    const r = await engine.generate('Quantos atendimentos?', { today: '2026-10-30', timeZone: 'America/Sao_Paulo' });
    expect(r.attempts).toBe(2);
    expect(String(llm.calls[1]!.content)).toContain('Tabela ou visão não permitida: bi.usuarios');
  });

  it('falha com erro tipado após duas tentativas inseguras', async () => {
    const llm = new FakeLlmClient([answer('DELETE FROM bi.atendimentos'), answer('SELECT pg_sleep(5)')]);
    const engine = new TextToSqlEngine({ llm, catalog });
    const error = await engine.generate('apague tudo', { today: '2026-10-30', timeZone: 'America/Sao_Paulo' }).catch((e) => e);
    expect(error).toBeInstanceOf(TextToSqlError);
    expect(error.errors.join()).toMatch(/pg_sleep/);
    expect(error.lastSql).toBe('SELECT pg_sleep(5)');
  });

  it('repassa quando o modelo diz que não dá para responder', async () => {
    const llm = new FakeLlmClient([answer('', { cannotAnswer: 'Não há dados de vacinação no catálogo.' })]);
    const engine = new TextToSqlEngine({ llm, catalog });
    await expect(engine.generate('Cobertura vacinal?', { today: '2026-10-30', timeZone: 'America/Sao_Paulo' })).rejects.toThrow(/vacinação/);
  });
});
