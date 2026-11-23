import assert from 'node:assert/strict';
import { test } from 'node:test';
import { corpus, perfis } from '../src/dados';
import { estatisticas } from '../src/pares';
import { contextoNormativo, termos } from '../src/rag';
import { analisa } from '../src/regras';

const c = corpus();

test('termos: sem acento, sem palavras vazias', () => {
  assert.deepEqual(termos('Remuneração dos profissionais da Educação'), ['remuneracao', 'profissionais', 'educacao']);
});

test('trechos preservam a hierarquia da norma', () => {
  const t = c.trechos.get('l14113-art26');
  assert.ok(t);
  assert.equal(t.rotulo, 'Lei nº 14.113/2020, art. 26');
  assert.ok(t.caminho.some((x) => x.startsWith('CAPÍTULO V')));
  const p = c.trechos.get('l14113-art14-1');
  assert.match(p?.rotulo ?? '', /art\. 14, caput e § 1º/);
  const inc = [...c.trechos.values()].find((x) => x.id.startsWith('cf88-art212-A') && x.dispositivo.includes('incisos'));
  assert.ok(inc?.contexto?.startsWith('Art. 212-A.'), 'pedaço de artigo longo leva o caput como contexto');
});

test('busca BM25 encontra o dispositivo certo', () => {
  const top = (q: string) => c.busca(q, 3).map((r) => r.trecho.id);
  assert.ok(top('70% dos recursos do FUNDEB na remuneração dos profissionais da educação básica').includes('l14113-art26'));
  assert.ok(top('condicionalidades VAAR gestor escolar SAEB 80% dos estudantes').includes('l14113-art14-1'));
  assert.ok(top('municípios aplicarão no mínimo 15% em ações e serviços públicos de saúde').includes('lc141-art7'));
  assert.ok(top('condição para os repasses conselho fundo e plano de assistência social').includes('l8742-art30'));
});

test('contexto normativo: os trechos citados pelas regras, sem repetição', () => {
  const lista = perfis();
  const est = estatisticas(lista);
  for (const p of lista.slice(0, 40)) {
    const a = analisa(p, est, c.trechos);
    const ctx = contextoNormativo(a, c);
    const ids = ctx.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const x of a.achados) for (const id of x.base_legal) assert.ok(ids.includes(id));
  }
});
