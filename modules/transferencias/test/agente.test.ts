import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ErroAgente, ESQUEMA_SAIDA, MODELO, normasCitadas, parecer, parecerDoMotor, type SaidaAgente } from '../src/agente';
import { valoresEmReais } from '../src/formata';
import { SYSTEM_PROMPT } from '../src/prompt';
import { analise, c, clienteSimulado, mensagemComTexto } from './apoio';

/** Saída "perfeita": o próprio texto do motor, no formato do agente. */
const eco = (): SaidaAgente => {
  const m = parecerDoMotor(analise);
  return { resumo_executivo: m.resumo_executivo, gargalos: m.gargalos.map((g) => ({ ...g, base_legal: g.base_legal.filter((b) => b.trecho_id) })) };
};

test('system prompt literal da especificação (seção 4)', () => {
  assert.equal(createHash('sha256').update(SYSTEM_PROMPT).digest('hex'), '013c558afcbb0c441f42caa4e1cf81d7017e544b0b12683d286bebc48a8d524d');
});

test('pedido ao modelo: modelo, system prompt em cache, saída estruturada, fallback e dados + contexto', async () => {
  const s = clienteSimulado(() => mensagemComTexto(JSON.stringify(eco())));
  const p = await parecer(analise, c, { cliente: s.cliente });
  const req = s.pedidos[0] as Record<string, any>;
  assert.equal(req.model, MODELO);
  assert.equal(req.model, 'claude-opus-5-5');
  assert.deepEqual(req.system, [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(req.thinking, { type: 'adaptive' });
  assert.deepEqual(req.output_config.format, { type: 'json_schema', schema: ESQUEMA_SAIDA });
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.ok(!('temperature' in req));
  const texto = req.messages[0].content as string;
  assert.ok(texto.includes('[DADOS_MUNICIPIO]') && texto.includes('[CONTEXTO_NORMATIVO_RAG]'));
  for (const x of analise.achados) for (const id of x.base_legal) assert.ok(texto.includes(`"trecho_id": "${id}"`));
  assert.equal(p.origem, 'agente');
  assert.deepEqual(p.ajustes, []);
  assert.equal(p.gargalos.length, analise.achados.length);
});

test('conferência: valor, percentual, norma e citação inventados são trocados pelo texto do motor', async () => {
  const s = eco();
  const [g0, g1] = s.gargalos;
  assert.ok(g0 && g1);
  g0.impacto_financeiro = 'Perda de R$ 9.876.543 por ano.';
  g0.diagnostico_direto = 'Segundo a Portaria GM/MS nº 999/2025, a prefeitura está irregular.';
  g0.base_legal = [{ trecho_id: 'nao-existe', citacao: 'Lei nº 1/1900' }];
  g1.passo_a_passo_operacional.acao_corretiva_exata = 'Aplicar 33,33% a mais.';
  s.gargalos.push({ ...g1, achado_id: 'inventado' });
  s.gargalos.splice(2, 1); // um achado sem bloco
  const motor = parecerDoMotor(analise);
  const p = await parecer(analise, c, { cliente: clienteSimulado(() => mensagemComTexto(JSON.stringify(s))).cliente });
  const r0 = p.gargalos.find((g) => g.achado_id === g0.achado_id)!;
  const m0 = motor.gargalos.find((g) => g.achado_id === g0.achado_id)!;
  assert.equal(r0.impacto_financeiro, m0.impacto_financeiro);
  assert.equal(r0.diagnostico_direto, m0.diagnostico_direto);
  assert.ok(r0.base_legal.every((b) => !b.trecho_id || c.trechos.has(b.trecho_id)));
  const r1 = p.gargalos.find((g) => g.achado_id === g1.achado_id)!;
  assert.doesNotMatch(r1.passo_a_passo_operacional.acao_corretiva_exata, /33,33%/);
  assert.ok(!p.gargalos.some((g) => g.achado_id === 'inventado'));
  assert.deepEqual(p.gargalos.map((g) => g.achado_id), analise.achados.map((x) => x.id));
  for (const esperado of ['valor em reais', 'norma fora do contexto', 'percentual', 'não corresponde', 'sem bloco do agente', 'citação']) {
    assert.ok(p.ajustes.some((a) => a.includes(esperado)), `ajuste "${esperado}" ausente: ${p.ajustes.join(' | ')}`);
  }
});

test('conferência aceita o valor em forma curta ("R$ 1,2 milhão") quando arredonda um valor do motor', async () => {
  const s = eco();
  const g = s.gargalos[0]!;
  const x = analise.achados.find((a) => a.id === g.achado_id)!;
  const curto = x.impacto.anual >= 1e6 ? `R$ ${(x.impacto.anual / 1e6).toFixed(1).replace('.', ',')} milhão` : `R$ ${Math.round(x.impacto.anual / 1e3)} mil`;
  g.impacto_financeiro = `Cerca de ${curto} por ano.`;
  const p = await parecer(analise, c, { cliente: clienteSimulado(() => mensagemComTexto(JSON.stringify(s))).cliente });
  assert.equal(p.gargalos[0]?.impacto_financeiro, `Cerca de ${curto} por ano.`);
  assert.deepEqual(p.ajustes, []);
});

test('recusa, resposta cortada e JSON inválido viram ErroAgente', async () => {
  for (const [texto, stop] of [['{}', 'refusal'], ['{"resumo', 'max_tokens'], ['não é json', 'end_turn'], ['{"resumo_executivo": 1}', 'end_turn']] as const) {
    const s = clienteSimulado(() => mensagemComTexto(texto, stop));
    await assert.rejects(parecer(analise, c, { cliente: s.cliente }), ErroAgente);
  }
});

test('normas citadas e valores em reais no texto', () => {
  assert.deepEqual(normasCitadas('Lei nº 14.113/2020 e Portaria GM/MS nº 3.493, de 11 de abril de 2024; LC 141/2012'), ['lei:14113/2020', 'portaria:3493/2024', 'lc:141/2012']);
  assert.deepEqual(valoresEmReais('R$ 1.234.567, R$ 2,5 milhões e R$ 350 mil').map((v) => v.valor), [1_234_567, 2_500_000, 350_000]);
});
