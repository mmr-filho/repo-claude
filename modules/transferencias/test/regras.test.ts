import assert from 'node:assert/strict';
import { test } from 'node:test';
import { corpus, perfis } from '../src/dados';
import { estatisticas, mesesDeSaldo } from '../src/pares';
import { analisa, PARAMETROS } from '../src/regras';
import type { Perfil } from '../src/tipos';

const c = corpus();
const reais = perfis();
const est = estatisticas(reais);

/** Perfil sintético: só o que cada teste muda importa. */
function perfil(m: Partial<Perfil> = {}): Perfil {
  return {
    versao: 1, ibge: 1799999, nome: 'Município de Teste', uf: 'TO', populacao: 4000, faixa_populacional: 'até 5 mil',
    consultado_em: '2026-10-25', fonte: 'teste', rreo14: {}, rgf5: null, faltas: [],
    receitas: {
      '2025': { meses: 12, por_fonte: { '540': 4_000_000, '543': 0, '600': 2_400_000, '660': 240_000 }, por_natureza: {} },
      '2026': { meses: 8, por_fonte: { '540': 2_800_000, '600': 1_600_000, '660': 160_000 }, por_natureza: {} },
    },
    caixa: { ano: 2026, mes: 8, por_fonte: { '600': 400_000, '660': 40_000 } },
    ...m,
  };
}
const achados = (p: Perfil) => analisa(p, est, c.trechos).achados;

test('as 139 prefeituras: análise sem erro, citações no corpus e impacto em reais', () => {
  assert.equal(reais.length, 139);
  for (const p of reais) {
    const a = analisa(p, est, c.trechos);
    for (const x of a.achados) {
      assert.ok(x.base_legal.length + x.normas_externas.length > 0, `${p.nome} ${x.id} sem base legal`);
      for (const id of x.base_legal) assert.ok(a.trechos[id], `${x.id}: ${id} não anexado`);
      assert.ok(Number.isFinite(x.impacto.anual) && x.impacto.anual > 0, `${p.nome} ${x.id} impacto ${x.impacto.anual}`);
      assert.ok(x.passos.responsavel && x.passos.sistema && x.passos.acao && x.passos.prazo, `${x.id} passo a passo incompleto`);
    }
  }
});

test('FUNDEB 70% descumprido em ano encerrado: crítico, diferença exata, sem valor mensal', () => {
  const p = perfil({ rreo14: { '2025': { ano: 2025, bimestre: 6, simplificado: false, fundeb70: { valor: 6_500_000, minimo_pct: 70, aplicado_pct: 65 } } } });
  const x = achados(p).find((a) => a.regra === 'minimo_fundeb70');
  assert.ok(x);
  assert.equal(x.nivel, 'Crítico');
  assert.equal(Math.round(x.impacto.anual), 500_000); // base 10 mi × 5 pontos
  assert.equal(x.impacto.mensal, null);
  assert.deepEqual(x.base_legal, ['l14113-art26', 'cf88-art212-A-4']);
});

test('mínimo da saúde abaixo no meio do ano: alerta, com o ritmo mensal até dezembro', () => {
  const p = perfil({ rreo14: { '2026': { ano: 2026, bimestre: 4, simplificado: false, asps: { valor: 1_200_000, minimo_pct: 15, aplicado_pct: 12 } } } });
  const x = achados(p).find((a) => a.regra === 'minimo_asps');
  assert.ok(x);
  assert.equal(x.nivel, 'Alerta');
  assert.equal(Math.round(x.impacto.anual), 300_000); // base 10 mi × 3 pontos
  assert.equal(Math.round(x.impacto.mensal ?? 0), 75_000); // 4 meses até dezembro
  assert.match(x.passos.prazo, /31\/12\/2026/);
});

test('VAAR que parou de chegar: alerta com a perda do ano anterior; MSC curta demais não conclui', () => {
  const base = perfil();
  base.receitas['2025']!.por_fonte['543'] = 120_000;
  const x = achados(base).find((a) => a.regra === 'vaar_perdido');
  assert.ok(x);
  assert.equal(x.impacto.anual, 120_000);
  assert.equal(x.impacto.mensal, 10_000);
  const curto = structuredClone(base);
  curto.receitas['2026']!.meses = PARAMETROS.meses_para_ausencia - 1;
  assert.ok(!achados(curto).some((a) => a.regra === 'vaar_perdido'));
});

test('FNAS: saldo de 12 meses ou mais é crítico, de 6 a 12 é alerta, saldo negativo é ignorado', () => {
  const mk = (saldo: number) => perfil({ caixa: { ano: 2026, mes: 8, por_fonte: { '660': saldo } } });
  const critico = achados(mk(300_000)).find((a) => a.regra === 'fnas_saldo'); // 15 meses de R$ 20 mil
  assert.equal(critico?.nivel, 'Crítico');
  assert.equal(critico?.impacto.mensal, 20_000);
  assert.ok(critico?.normas_externas.some((n) => n.rotulo.includes('113/2015')));
  assert.equal(achados(mk(160_000)).find((a) => a.regra === 'fnas_saldo')?.nivel, 'Alerta'); // 8 meses
  assert.ok(!achados(mk(60_000)).some((a) => a.regra === 'fnas_saldo')); // 3 meses
  assert.equal(mesesDeSaldo(mk(-50_000), '660'), null);
});

test('FUNDEB: saldo acima de 10% no fim do ano', () => {
  const p = perfil({
    rgf5: { ano: 2025, periodicidade: 'S', periodo: 2, simplificado: true, linhas: { 'Transferências do FUNDEB': { bruta: 600_000, liquida: 500_000, liquida_apos_rp: 500_000 } } },
  });
  const x = achados(p).find((a) => a.regra === 'fundeb_saldo_10');
  assert.equal(x?.nivel, 'Crítico');
  assert.equal(Math.round(x?.impacto.anual ?? 0), 100_000); // 500 mil − 10% de 4 mi
});

test('comparação por habitante não roda no grupo heterogêneo de mais de 20 mil habitantes', () => {
  const p = perfil({ populacao: 60_000, faixa_populacional: '50 a 100 mil' });
  p.receitas['2025']!.por_fonte = { '540': 1, '600': 1, '660': 1, '552': 1, '553': 1 };
  assert.ok(!achados(p).some((a) => a.regra === 'por_habitante'));
});

test('achados em ordem: críticos, alertas, oportunidades', () => {
  for (const p of reais.slice(0, 60)) {
    const ordem = achados(p).map((a) => ['Crítico', 'Alerta', 'Oportunidade'].indexOf(a.nivel));
    assert.deepEqual(ordem, [...ordem].sort((a, b) => a - b));
  }
});
