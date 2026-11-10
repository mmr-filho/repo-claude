import { describe, expect, it } from 'vitest';
import {
  avaliarPlano,
  calcularCanal,
  curvaObservada,
  PLANO_MODELO_MS_2025,
  RECEITAS_MODELO,
  semanaDoCanal,
  semanasCompletas,
  semanasNoAno,
  statusDaSemana,
  type IndicadoresAgravo,
  type SerieAnual,
} from '@omnisaude/shared';
import { DEMO_TENANT, gravesDemo, POPULACAO_RIPSA_DEMO, semanasDemo, seriesDemo, type SemanasDemo } from '../src/seed/fixtures';

/**
 * A carga de demonstração da semana 27 (VIG-1c) monta a curva da dengue em relação ao dia em que roda. Aqui a sugestão
 * do plano modelo do MS é refeita só com as funções compartilhadas (as mesmas do diagrama e da contingência), como a
 * API faz: canal MS 2025 (5 anos, mediana e quartis, incidência pela RIPSA), semanas incompletas = 2.
 */
const receita = RECEITAS_MODELO.MS_2025.receita;

/** População RIPSA do ano; no ano em análise sem estimativa, a do último ano da série (como a API, "repetida"). */
function populacao(ano: number, anoAnalise: number): number | null {
  const anos = POPULACAO_RIPSA_DEMO.anos;
  if (anos[ano]) return anos[ano]!;
  if (ano < anoAnalise) return null;
  const anteriores = Object.keys(anos)
    .map(Number)
    .filter((a) => a < ano)
    .sort((a, b) => b - a);
  return anteriores.length ? anos[anteriores[0]!]! : null;
}

function indicadores(sem: SemanasDemo, anosExcluidos: number[] = []): IndicadoresAgravo[] {
  const series = seriesDemo(sem);
  const { incompletas } = semanasCompletas(sem.atual, 2);
  const ano = sem.anoAnalise;
  const anoAtual = Number(sem.atual.slice(0, 4));
  return (['dengue', 'chikungunya', 'zika'] as const).map((grupo) => {
    const doGrupo = series.filter((s) => s.grupo === grupo);
    const serieAnual = (a: number): SerieAnual => {
      const s = doGrupo.find((x) => x.ano === a);
      // Semanas futuras ficam nulas, como na API.
      const semanas = Array.from({ length: 53 }, (_, i) => (i < semanasNoAno(a) && `${a}${String(i + 1).padStart(2, '0')}` <= sem.atual ? (s?.provaveis[i] ?? 0) : null));
      return { ano: a, semanas, populacao: populacao(a, ano) };
    };
    const referencia = doGrupo.length ? Array.from({ length: receita.anos }, (_, i) => serieAnual(ano - receita.anos + i)) : [];
    const canal = calcularCanal(referencia, ano, receita, anosExcluidos);
    const observado = curvaObservada(serieAnual(ano), receita);
    const ultima = ano < anoAtual ? semanasNoAno(ano) : Number(sem.atual.slice(4));
    const semanas = Array.from({ length: ultima }, (_, i) => {
      const codigo = `${ano}${String(i + 1).padStart(2, '0')}`;
      return { semana: codigo, status: statusDaSemana(observado[i]?.valor ?? null, semanaDoCanal(canal, i + 1)), completa: !incompletas.includes(codigo) && codigo <= sem.atual };
    });
    const doAno = doGrupo.find((x) => x.ano === ano);
    const provaveis = doAno ? doAno.provaveis.reduce((t, c, i) => (`${ano}${String(i + 1).padStart(2, '0')}` <= sem.ultimaCompleta ? t + c : t), 0) : 0;
    const graves = grupo === 'dengue' ? gravesDemo(provaveis) : { graves: 0, sinaisAlarme: 0 };
    return { grupo, semanas, provaveis, ...graves, obitosAgravo: 0, obitosInvestigacao: 0, incidenciaAcumulada: null };
  });
}

describe('demonstração da semana 27: curva da dengue', () => {
  // Dias de 2026 em semanas diferentes (fora da virada do ano, quando a contingência só tem as semanas do ano novo).
  const dias = ['2026-11-10T15:00:00Z', '2026-11-08T03:30:00Z', '2026-11-04T15:00:00Z', '2026-08-20T12:00:00Z', '2026-04-15T12:00:00Z', '2026-02-26T12:00:00Z'];

  it.each(dias)('em %s a sugestão do plano modelo do MS é MOBILIZAÇÃO', (iso) => {
    const sem = semanasDemo(new Date(iso), DEMO_TENANT.timeZone);
    const ind = indicadores(sem);
    const dengue = ind.find((i) => i.grupo === 'dengue')!;
    const completas = dengue.semanas.filter((s) => s.completa);
    // As 4 últimas semanas completas ficam acima da mediana e abaixo do limite superior.
    expect(completas.slice(-4).map((s) => s.status)).toEqual(['ENTRE_CENTRO_E_LS', 'ENTRE_CENTRO_E_LS', 'ENTRE_CENTRO_E_LS', 'ENTRE_CENTRO_E_LS']);
    expect((dengue.graves + dengue.sinaisAlarme) * 100).toBeLessThanOrEqual(dengue.provaveis);
    const avaliacao = avaliarPlano(PLANO_MODELO_MS_2025, ind, [], 'NORMALIDADE');
    expect(avaliacao.sugerido).toBe('MOBILIZACAO');
    expect(avaliacao.criterios.find((c) => c.id === 'mob-canal' && c.agravo === 'dengue')?.atendido).toBe(true);
    expect(avaliacao.criterios.filter((c) => c.estagio !== 'MOBILIZACAO' && c.atendido === true)).toEqual([]);
  });

  it('o ano epidêmico (2024 em 2026) fica no canal; excluído, a curva passa do limite superior e a sugestão sobe para ALERTA', () => {
    const sem = semanasDemo(new Date('2026-11-10T15:00:00Z'), DEMO_TENANT.timeZone);
    expect(sem).toMatchObject({ atual: '202645', ultimaCompleta: '202643', anoAnalise: 2026 });
    const avaliacao = avaliarPlano(PLANO_MODELO_MS_2025, indicadores(sem, [2024]), [], 'NORMALIDADE');
    expect(avaliacao.sugerido).toBe('ALERTA');
    expect(avaliacao.criterios.find((c) => c.id === 'ale-canal' && c.agravo === 'dengue')?.atendido).toBe(true);
  });

  it('o histórico tem 2024 epidêmico, chikungunya menor e nada no futuro', () => {
    const sem = semanasDemo(new Date('2026-11-10T15:00:00Z'), DEMO_TENANT.timeZone);
    const series = seriesDemo(sem);
    const total = (grupo: string, ano: number) => series.find((s) => s.grupo === grupo && s.ano === ano)!.provaveis.reduce((a, b) => a + b, 0);
    expect(series.map((s) => s.ano).filter((a, i, l) => l.indexOf(a) === i)).toEqual([2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
    for (const ano of [2019, 2020, 2021, 2022, 2023, 2025]) expect(total('dengue', 2024)).toBeGreaterThan(3 * total('dengue', ano));
    for (const ano of [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]) expect(total('chikungunya', ano)).toBeLessThan(total('dengue', ano));
    const d2026 = series.find((s) => s.grupo === 'dengue' && s.ano === 2026)!;
    expect(d2026.provaveis.slice(45).every((c) => c === 0)).toBe(true);
    expect(d2026.provaveis[44]).toBeGreaterThan(0);
    // Chikungunya sem casos nas 10 últimas semanas.
    expect(series.find((s) => s.grupo === 'chikungunya' && s.ano === 2026)!.provaveis.slice(34, 45)).toEqual(Array(11).fill(0));
  });
});
