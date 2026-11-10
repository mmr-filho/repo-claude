import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  arredondar,
  calcularCanal,
  csvDoCanal,
  curvaObservada,
  desvioPadraoAmostral,
  media,
  mediana,
  quartilExc,
  quartilInc,
  RECEITAS_MODELO,
  semanaDoCanal,
  statusDaSemana,
  sugerirAnosEpidemicos,
  type ReceitaCanal,
  type SemanaCanal,
  type SerieAnual,
} from '@omnisaude/shared';

/**
 * Diagrama de controle (VIG-1c, §3.2 do desenho): funções iguais às do Excel e os exemplos publicados pelo MS. As
 * fixtures em fixtures/diagrama foram copiadas da pesquisa da semana 27 e conferidas número a número contra o texto
 * extraído dos PDFs oficiais (só as colunas publicadas; nada calculado por terceiros).
 */
const FIXTURES = join(__dirname, 'fixtures/diagrama');
const lerCsv = (nome: string) => {
  const [cab, ...linhas] = readFileSync(join(FIXTURES, nome), 'utf-8').trim().split('\n');
  const colunas = cab!.split(',');
  return linhas.map((l) => Object.fromEntries(l.split(',').map((v, i) => [colunas[i]!, v])) as Record<string, string>);
};
const num = (v: string | undefined) => (v === undefined || v === '' ? null : Number(v));

/** Série anual com os valores nas primeiras posições e o resto sem cobertura (null). */
const serie = (ano: number, valores: (number | null)[], populacao: number | null = null): SerieAnual => ({
  ano,
  semanas: Array.from({ length: 53 }, (_, i) => (i < valores.length ? valores[i]! : null)),
  populacao,
});
const cheia = (ano: number, f: (se: number) => number, populacao: number | null = null, total = 52): SerieAnual => ({
  ano,
  semanas: Array.from({ length: 53 }, (_, i) => (i < total ? f(i + 1) : null)),
  populacao,
});
const RECEITA_CASOS: ReceitaCanal = { ...RECEITAS_MODELO.MS_2025.receita, unidade: 'CASOS' };

describe('diagrama: funções iguais às do Excel', () => {
  it('ARRED do Excel: meia unidade para longe do zero, sobre a representação decimal', () => {
    expect(arredondar(0.495, 2)).toBe(0.5);
    expect(arredondar(0.4950000000000001, 2)).toBe(0.5);
    expect(arredondar(0.49499999999999994, 2)).toBe(0.5);
    expect(arredondar(0.605, 2)).toBe(0.61);
    expect(arredondar(1.005, 2)).toBe(1.01);
    expect(arredondar(2.675, 2)).toBe(2.68);
    expect(arredondar(12.5, 0)).toBe(13);
    expect(arredondar(-0.5, 0)).toBe(-1);
    expect(arredondar(-2.675, 2)).toBe(-2.68);
    expect(arredondar(0.494, 2)).toBe(0.49);
    expect(arredondar(1234.5, -1)).toBe(1230);
    expect(arredondar(1235, -1)).toBe(1240);
    expect(arredondar(-0.001, 2)).toBe(0);
    expect(Object.is(arredondar(-0.001, 2), -0)).toBe(false);
    expect(arredondar(0, 2)).toBe(0);
    expect(arredondar(745.5, 0)).toBe(746);
    // O arredondamento ingênuo no float erra exatamente onde o ARRED acerta.
    expect(Math.round(1.005 * 100) / 100).toBe(1);
    expect(Math.round(0.49499999999999994 * 100) / 100).toBe(0.49);
  });

  it('QUARTIL.EXC e QUARTIL.INC com o exemplo da Microsoft (6, 7, 15, 36, 39, 40, 41, 42, 43, 47, 49)', () => {
    const xs = [6, 7, 15, 36, 39, 40, 41, 42, 43, 47, 49];
    expect(quartilExc(xs, 1)).toBe(15);
    expect(quartilExc(xs, 3)).toBe(43);
    expect(quartilInc(xs, 1)).toBe(25.5);
    expect(quartilInc(xs, 3)).toBe(42.5);
    // A ordem de entrada não importa.
    expect(quartilExc([...xs].reverse(), 1)).toBe(15);
  });

  it('QUARTIL.EXC exige n >= 3; mediana, média e DESVPAD.A', () => {
    expect(quartilExc([1, 2], 1)).toBeNull();
    expect(quartilExc([1, 2], 3)).toBeNull();
    expect(quartilExc([], 1)).toBeNull();
    expect(quartilExc([3, 1, 2], 1)).toBe(1);
    expect(quartilExc([3, 1, 2], 3)).toBe(3);
    expect(quartilExc([1, 2, 3, 4], 1)).toBe(1.25);
    expect(quartilExc([1, 2, 3, 4], 3)).toBe(3.75);
    expect(quartilInc([5], 1)).toBe(5);
    expect(quartilInc([], 3)).toBeNull();
    expect(mediana([])).toBeNull();
    expect(mediana([5, 1, 3])).toBe(3);
    expect(mediana([4, 1, 3, 2])).toBe(2.5);
    expect(media([])).toBeNull();
    expect(media([1, 2, 3, 4])).toBe(2.5);
    expect(desvioPadraoAmostral([7])).toBeNull();
    expect(desvioPadraoAmostral([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 14);
    expect(desvioPadraoAmostral([3, 3, 3])).toBe(0);
  });
});

describe('diagrama: cálculo do canal', () => {
  it('anos de referência: os anteriores ao ano em análise, sem os excluídos e sem os anos sem cobertura', () => {
    const series = [2019, 2020, 2021, 2022, 2023, 2024, 2025].map((a) => cheia(a, (se) => se + a - 2019));
    series.push(serie(2018, [])); // sem cobertura (nenhuma semana com dado)
    const canal = calcularCanal(series, 2025, { ...RECEITA_CASOS, anos: 7 }, [2021]);
    expect(canal.anosReferencia).toEqual([2019, 2020, 2022, 2023, 2024]);
    expect(canal.avisos.join(' ')).toContain('Ano 2018 fora do canal: sem cobertura');
    // O ano em análise (2025) não entra.
    expect(canal.semanas[0]!.valores.map((v) => v.ano)).not.toContain(2025);
    expect(canal.semanas).toHaveLength(52);
    // SE 1: valores 1, 2, 4, 5, 6 → mediana 4, Q1 = 1,5, Q3 = 5,5 (QUARTIL.EXC).
    expect(canal.semanas[0]).toMatchObject({ semana: 1, n: 5, centro: 4, li: 1.5, ls: 5.5, q1: 1.5, mediana: 4, q3: 5.5 });
    const comAnalise = calcularCanal(series, 2025, { ...RECEITA_CASOS, anos: 2, incluiAnoEmAnalise: true }, []);
    expect(comAnalise.anosReferencia).toEqual([2023, 2024, 2025]);
  });

  it('SE 53 do histórico soma na SE 52 do mesmo ano; a SE 53 observada usa o canal da SE 52', () => {
    const series = [2020, 2021, 2022].map((a) => cheia(a, (se) => (se === 52 ? 10 : se === 53 ? 5 : 1), null, a === 2020 ? 53 : 52));
    const canal = calcularCanal(series, 2023, { ...RECEITA_CASOS, anos: 3 }, []);
    const se52 = canal.semanas[51]!;
    expect(se52.valores.find((v) => v.ano === 2020)).toMatchObject({ casos: 15, valor: 15 });
    expect(se52.valores.find((v) => v.ano === 2021)).toMatchObject({ casos: 10 });
    expect(semanaDoCanal(canal, 53)).toBe(se52);
    expect(semanaDoCanal(canal, 1)).toBe(canal.semanas[0]);
    // Curva observada: 53 posições; a SE 53 só existe nos anos de 53 semanas.
    const obs2025 = curvaObservada(
      cheia(2025, () => 2, null, 53),
      RECEITA_CASOS,
    );
    expect(obs2025).toHaveLength(53);
    expect(obs2025[52]).toEqual({ semana: 53, casos: 2, valor: 2 });
    const obs2026 = curvaObservada(
      cheia(2026, () => 2, null, 53),
      RECEITA_CASOS,
    );
    expect(obs2026[52]).toEqual({ semana: 53, casos: null, valor: null });
  });

  it('incidência: casos × 100.000 ÷ população do ano; ano sem população fica fora com aviso', () => {
    const r: ReceitaCanal = { ...RECEITAS_MODELO.MS_2025.receita, anos: 4 };
    const series = [cheia(2021, () => 5, 50_000), cheia(2022, () => 10, 100_000), cheia(2023, () => 30, 200_000), cheia(2024, () => 7, null)];
    const canal = calcularCanal(series, 2025, r, []);
    expect(canal.anosReferencia).toEqual([2021, 2022, 2023]);
    expect(canal.avisos.join(' ')).toContain('Ano 2024 fora do canal: sem população');
    expect(canal.semanas[0]!.valores.map((v) => v.valor)).toEqual([10, 10, 15]);
    // Observado na mesma unidade do canal.
    expect(
      curvaObservada(
        cheia(2025, () => 3, 30_000),
        r,
      )[0],
    ).toEqual({ semana: 1, casos: 3, valor: 10 });
    expect(
      curvaObservada(
        cheia(2025, () => 3, null),
        r,
      )[0],
    ).toEqual({ semana: 1, casos: 3, valor: null });
  });

  it('null (sem cobertura) é diferente de 0 (semana sem caso)', () => {
    const series = [serie(2021, [0, 0]), serie(2022, [0, null]), serie(2023, [0, 4]), serie(2024, [3, 2])];
    const canal = calcularCanal(series, 2025, { ...RECEITA_CASOS, anos: 4 }, []);
    expect(canal.semanas[0]).toMatchObject({ n: 4 });
    expect(canal.semanas[1]).toMatchObject({ n: 3, centro: 2 });
    expect(canal.semanas[1]!.valores.find((v) => v.ano === 2022)).toMatchObject({ casos: null, valor: null });
    // Menos de 3 valores: QUARTIL.EXC indefinido e aviso com as SE em faixas.
    expect(canal.semanas[2]).toMatchObject({ n: 0, centro: null, li: null, ls: null });
    expect(canal.avisos.join(' ')).toContain('Menos de 3 valores válidos nas SE 3 a 52');
    // Só 9 casos em toda a referência: o diagrama não vale, sugere a curva epidêmica.
    expect(canal.avisos.join(' ')).toContain('Só 9 caso(s) no período de referência: com tão poucos casos, prefira a curva epidêmica');
    expect(calcularCanal([...series, serie(2020, [5, 5])], 2025, { ...RECEITA_CASOS, anos: 5 }, []).avisos.join(' ')).not.toContain('curva epidêmica');
  });

  it('sem anos de referência: canal vazio com aviso', () => {
    const canal = calcularCanal([], 2025, RECEITAS_MODELO.MS_2025.receita, []);
    expect(canal.anosReferencia).toEqual([]);
    expect(canal.semanas.every((s) => s.n === 0 && s.centro === null)).toBe(true);
    expect(canal.avisos.filter((a) => a.includes('sem cobertura'))).toHaveLength(5);
    expect(canal.avisos[canal.avisos.length - 1]).toBe('Nenhum ano de referência com dados: o canal não pode ser calculado.');
  });

  it('janela agrupada com borda truncada, circular e contínua', () => {
    // Cada ano vale 100·ano_relativo + SE, para saber de onde veio cada valor.
    const series = [2021, 2022, 2023].map((a) => cheia(a, (se) => (a - 2020) * 100 + se));
    const base: ReceitaCanal = { ...RECEITA_CASOS, metodo: 'MEDIA_DP', k: 1, anos: 3, janela: 'AGRUPADA_5' };
    const trunc = calcularCanal(series, 2024, { ...base, borda: 'TRUNCADA' }, []);
    expect(trunc.semanas[0]!.n).toBe(9); // SE 1, 2, 3 de cada ano
    expect(trunc.semanas[0]!.media).toBe(202);
    expect(trunc.semanas[2]!.n).toBe(15);
    const circ = calcularCanal(series, 2024, { ...base, borda: 'CIRCULAR' }, []);
    // SE 1 circular: SE 51, 52, 1, 2, 3 do próprio ano.
    expect(circ.semanas[0]!.n).toBe(15);
    expect(circ.semanas[0]!.media).toBeCloseTo(200 + (51 + 52 + 1 + 2 + 3) / 5, 12);
    const cont = calcularCanal(series, 2024, { ...base, borda: 'CONTINUA' }, []);
    // SE 1 contínua: 2021 não tem o ano anterior na referência (truncado); 2022 e 2023 usam SE 51-52 do ano anterior.
    expect(cont.semanas[0]!.n).toBe(3 + 5 + 5);
    // SE 52: o ano seguinte de 2023 é o ano em análise e nunca entra.
    expect(cont.semanas[51]!.n).toBe(5 + 5 + 3);
    const valoresSe1 = [101, 102, 103, 151, 152, 201, 202, 203, 251, 252, 301, 302, 303];
    expect(cont.semanas[0]!.media).toBeCloseTo(valoresSe1.reduce((a, b) => a + b, 0) / valoresSe1.length, 12);
  });

  it('janela suavizada: média das SE s−2..s+2 de cada ano e depois os quartis entre os anos', () => {
    const series = [2021, 2022, 2023].map((a, k) => cheia(a, (se) => (se === 10 ? 50 : k + 1)));
    const r: ReceitaCanal = { ...RECEITA_CASOS, anos: 3, janela: 'SUAVIZADA_5', borda: 'TRUNCADA' };
    const canal = calcularCanal(series, 2024, r, []);
    // SE 10: cada ano vira (4·k + 50) / 5; SE 1 truncada: média de 3 semanas iguais.
    expect(canal.semanas[9]!.valores.map((v) => v.valor)).toEqual([(4 + 50) / 5, (8 + 50) / 5, (12 + 50) / 5]);
    expect(canal.semanas[9]!.valores.map((v) => v.casos)).toEqual([50, 50, 50]);
    expect(canal.semanas[9]!.n).toBe(3);
    expect(canal.semanas[0]!.valores.map((v) => v.valor)).toEqual([1, 2, 3]);
  });

  it('status da semana no canal', () => {
    const s: SemanaCanal = { semana: 1, valores: [], n: 5, centro: 10, li: 5, ls: 20 };
    expect(statusDaSemana(4.99, s)).toBe('ABAIXO_LI');
    expect(statusDaSemana(5, s)).toBe('ATE_CENTRO');
    expect(statusDaSemana(10, s)).toBe('ATE_CENTRO');
    expect(statusDaSemana(10.01, s)).toBe('ENTRE_CENTRO_E_LS');
    expect(statusDaSemana(20, s)).toBe('ENTRE_CENTRO_E_LS');
    expect(statusDaSemana(20.01, s)).toBe('ACIMA_LS');
    expect(statusDaSemana(null, s)).toBe('SEM_CANAL');
    expect(statusDaSemana(3, null)).toBe('SEM_CANAL');
    expect(statusDaSemana(3, { ...s, centro: null, li: null, ls: null })).toBe('SEM_CANAL');
    // Média e DP: sem limite inferior, nunca ABAIXO_LI.
    expect(statusDaSemana(0, { ...s, li: null })).toBe('ATE_CENTRO');
  });

  it('receitas publicadas', () => {
    expect(RECEITAS_MODELO.MS_2025.receita).toMatchObject({ metodo: 'QUARTIS', quartil: 'EXC', anos: 5, janela: 'NENHUMA', unidade: 'INCIDENCIA', base: 'PROVAVEIS', incluiAnoEmAnalise: false });
    expect(RECEITAS_MODELO.NT_1_2023.receita).toMatchObject({ metodo: 'QUARTIS', quartil: 'EXC', anos: 7, janela: 'NENHUMA' });
    expect(RECEITAS_MODELO.NT_1_2023.nota).toContain('suavizada');
    expect(RECEITAS_MODELO.VIGIEPI_2025.receita).toMatchObject({ metodo: 'QUARTIS', quartil: 'EXC', anos: 10, janela: 'NENHUMA' });
    expect(RECEITAS_MODELO.DIRETRIZES_2009.receita).toMatchObject({ metodo: 'MEDIA_DP', k: 1.96, anos: 10, janela: 'AGRUPADA_5', borda: 'CIRCULAR', anoEmAnaliseTodosNotificados: true });
    for (const m of Object.values(RECEITAS_MODELO)) expect(m.fonte).toMatch(/pp\. \d/);
  });

  it('sugere anos epidêmicos pela regra da SES-GO, sem excluir nada', () => {
    const anos = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
    // 2019 com 300 casos por 100 mil nas SE 5 a 30; os demais anos sempre com 10.
    const series = anos.map((a) => cheia(a, (se) => (a === 2019 && se >= 5 && se <= 30 ? 300 : 10), 100_000));
    const s = sugerirAnosEpidemicos(series, 2026, 10);
    expect(s.anos.map((a) => a.ano)).toEqual(anos);
    expect(s.anos.find((a) => a.ano === 2019)).toEqual({ ano: 2019, semanasAcima: 26, epidemico: true });
    // Com 9 anos em 0, o Q3 das contagens é 0; ano sem nenhuma SE acima nunca é epidêmico.
    expect(s.limiar).toBe(0);
    expect(s.anos.filter((a) => a.epidemico).map((a) => a.ano)).toEqual([2019]);
    expect(s.nota).toContain('SES-GO');
    // Contagens 0, 4, 8, ...: epidêmicos os anos com contagem >= Q3 (QUARTIL.EXC).
    const degraus = anos.map((a, i) => cheia(a, (se) => (se <= i * 4 ? 50 : 10), 100_000));
    const d = sugerirAnosEpidemicos(degraus, 2026, 10);
    const q3 = quartilExc(
      d.anos.map((a) => a.semanasAcima),
      3,
    )!;
    expect(d.limiar).toBe(q3);
    expect(d.anos.filter((a) => a.epidemico).every((a) => a.semanasAcima >= q3)).toBe(true);
    expect(d.anos.filter((a) => !a.epidemico).every((a) => a.semanasAcima < q3 || a.semanasAcima === 0)).toBe(true);
    expect(sugerirAnosEpidemicos(series.slice(0, 2), 2018, 2).limiar).toBeNull();
  });
});

describe('diagrama: CSV para refazer a conta no Excel', () => {
  const series = [2021, 2022, 2023, 2024, 2025].map((a) => cheia(a, (se) => (se % 7) + (a - 2020), 123_456));
  const canal = calcularCanal(series, 2026, RECEITAS_MODELO.MS_2025.receita, []);
  const observado = curvaObservada(
    cheia(2026, () => 3, 123_456, 44),
    RECEITAS_MODELO.MS_2025.receita,
  );
  const csv = csvDoCanal(canal, observado, { titulo: '=HIPERLINK("x")', fontePopulacao: 'RIPSA, versão 2025', geradoEm: '2026-11-10T12:00:00.000Z' });
  const linhas = csv.replace(/^﻿/, '').split('\r\n');

  it('BOM, ponto e vírgula, vírgula decimal e texto protegido contra fórmula', () => {
    expect(csv.startsWith('﻿')).toBe(true);
    expect(linhas[0]).toBe(`Diagrama de controle;"'=HIPERLINK(""x"")"`);
    expect(linhas.find((l) => l.startsWith('População;'))).toBe('População;RIPSA, versão 2025');
    const cab = linhas.findIndex((l) => l.startsWith('SE;'));
    expect(linhas[cab]).toBe('SE;2021;2022;2023;2024;2025;Q1 (limite inferior);Mediana (centro);Q3 (limite superior);Observado (casos);Observado (incidência)');
    const se1 = linhas[cab + 1]!.split(';');
    expect(se1[0]).toBe('1');
    // SE 1 de 2021: 2 casos × 100.000 ÷ 123.456, com vírgula decimal e 12 algarismos significativos.
    expect(se1[1]).toBe('1,62001036807');
    expect(se1).toHaveLength(11);
    expect(se1[9]).toBe('3');
    // SE 45 em diante sem dado observado: célula vazia.
    expect(linhas[cab + 45]!.split(';')[9]).toBe('');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('as fórmulas apontam para as linhas e colunas certas', () => {
    const cab = linhas.findIndex((l) => l.startsWith('SE;'));
    const linhaSe1 = cab + 2; // número da linha no Excel (base 1)
    const formulas = linhas.find((l) => l.startsWith('Fórmulas do Excel;'))!;
    expect(formulas).toContain(`;Mediana (SE 1) = MED(B${linhaSe1}:F${linhaSe1});`);
    expect(formulas).toContain(`"Q1 (SE 1) = QUARTIL.EXC(B${linhaSe1}:F${linhaSe1};1)"`);
    expect(formulas).toContain(`"Q3 (SE 1) = QUARTIL.EXC(B${linhaSe1}:F${linhaSe1};3)"`);
    const agrupado = calcularCanal(series, 2026, RECEITAS_MODELO.DIRETRIZES_2009.receita, []);
    const csv2 = csvDoCanal(agrupado, observado, { titulo: 'Dengue', fontePopulacao: null, geradoEm: '2026-11-10' }).split('\r\n');
    const l1 = csv2.findIndex((l) => l.startsWith('SE;')) + 2;
    expect(csv2.find((l) => l.startsWith('Fórmulas do Excel;'))).toContain(`LS (SE 3) = MÉDIA(B${l1}:F${l1 + 4})+1,96*DESVPAD.A(B${l1}:F${l1 + 4})`);
    expect(csv2.find((l) => l.startsWith('População;'))).toBe('População;não informada');
    // Receita em casos: a população não se aplica e as colunas do observado têm títulos distintos.
    const emCasos = csvDoCanal(calcularCanal(series, 2026, RECEITA_CASOS, []), observado, { titulo: 'Dengue', fontePopulacao: 'RIPSA', geradoEm: '2026-11-10' }).split('\r\n');
    expect(emCasos.find((l) => l.startsWith('População;'))).toBe('População;não se aplica (receita em número de casos)');
    expect(emCasos.find((l) => l.startsWith('SE;'))!.endsWith(';Observado (casos);Observado (valor)')).toBe(true);
  });

  it('linha da SE 53 quando o ano em análise tem 53 semanas', () => {
    const obs = curvaObservada(
      cheia(2025, () => 4, 123_456, 53),
      RECEITAS_MODELO.MS_2025.receita,
    );
    const c = calcularCanal(series, 2025, RECEITAS_MODELO.MS_2025.receita, []);
    const ls = csvDoCanal(c, obs, { titulo: 'Dengue', fontePopulacao: 'RIPSA', geradoEm: '2026-01-10' }).split('\r\n');
    const ultima = ls[ls.length - 2]!.split(';');
    expect(ultima[0]).toBe('53');
    expect(ultima.slice(-2)[0]).toBe('4');
  });
});

describe('diagrama: o canal bate com os exemplos publicados pelo MS', () => {
  it('1. VigiEPI, Londrina (Tabelas 1 e 2): MED e QUARTIL.EXC sem janela, 10 anos, dentro de 0,01 das incidências publicadas', () => {
    const t = lerCsv('londrina-vigiepi.csv');
    const anos = [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
    // As incidências publicadas entram como valores prontos (unidade CASOS: o valor é o próprio número).
    const series = anos.map((a) =>
      serie(
        a,
        t.map((l) => num(l[String(a)])),
      ),
    );
    const r: ReceitaCanal = { ...RECEITAS_MODELO.VIGIEPI_2025.receita, unidade: 'CASOS' };
    const canal = calcularCanal(series, 2024, r, []);
    expect(canal.anosReferencia).toEqual(anos);
    let incBate = 0;
    t.forEach((l, i) => {
      const s = canal.semanas[i]!;
      expect(Math.abs(s.q1! - num(l.Q1)!)).toBeLessThanOrEqual(0.0100001);
      expect(Math.abs(s.mediana! - num(l.mediana)!)).toBeLessThanOrEqual(0.0100001);
      expect(Math.abs(s.q3! - num(l.Q3)!)).toBeLessThanOrEqual(0.0100001);
      // QUARTIL.INC não pode bater: em toda SE, Q1 ou Q3 fica a mais de 0,01.
      const valores = s.valores.map((v) => v.valor!);
      if (Math.abs(quartilInc(valores, 1)! - num(l.Q1)!) <= 0.01 && Math.abs(quartilInc(valores, 3)! - num(l.Q3)!) <= 0.01) incBate++;
    });
    expect(incBate).toBe(0);
  });

  it('1b. VigiEPI, Londrina: IGUALDADE EXATA a 2 casas partindo dos casos inteiros e da população RIPSA de cada ano', () => {
    const t = lerCsv('londrina-vigiepi.csv');
    const fx = JSON.parse(readFileSync(join(FIXTURES, 'londrina-vigiepi-casos.json'), 'utf-8')) as {
      populacao: { anos: Record<string, number> };
      populacao2024: { valor: number };
      casos: Record<string, number[]>;
      casos2024: Record<string, number>;
    };
    const anos = [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
    const series = anos.map((a, k) =>
      serie(
        a,
        t.map((l) => fx.casos[l.SE!]![k]!),
        fx.populacao.anos[String(a)]!,
      ),
    );
    const canal = calcularCanal(series, 2024, RECEITAS_MODELO.VIGIEPI_2025.receita, []);
    t.forEach((l, i) => {
      const s = canal.semanas[i]!;
      // Os casos reconstroem a Tabela 1 (260 células) ...
      s.valores.forEach((v) => expect(arredondar(v.valor!, 2)).toBe(num(l[String(v.ano)])));
      // ... e o canal reproduz a Tabela 2 (78 valores).
      expect([arredondar(s.q1!, 2), arredondar(s.mediana!, 2), arredondar(s.q3!, 2)]).toEqual([num(l.Q1), num(l.mediana), num(l.Q3)]);
    });
    // A coluna 2024 usa a população do Censo 2022 (555.965), não a RIPSA de 2024: a armadilha que o desenho evita.
    const obs = curvaObservada(
      serie(
        2024,
        t.map((l) => fx.casos2024[l.SE!]!),
        fx.populacao2024.valor,
      ),
      RECEITAS_MODELO.VIGIEPI_2025.receita,
    );
    t.forEach((l, i) => expect(arredondar(obs[i]!.valor!, 2)).toBe(num(l['2024'])));
  });

  it('2. VigiEPI, doença meningocócica mensal (Tabelas 6 e 7): igualdade exata com o ARRED a 2 casas', () => {
    const t = lerCsv('meningococica-vigiepi.csv');
    const anos = [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019];
    // Os 12 meses ocupam as 12 primeiras posições da série.
    const series = anos.map((a) =>
      serie(
        a,
        t.map((l) => num(l[String(a)])),
      ),
    );
    const canal = calcularCanal(series, 2020, { ...RECEITAS_MODELO.VIGIEPI_2025.receita, unidade: 'CASOS' }, []);
    t.forEach((l, i) => {
      const s = canal.semanas[i]!;
      expect([arredondar(s.mediana!, 2), arredondar(s.q1!, 2), arredondar(s.q3!, 2)]).toEqual([num(l.mediana), num(l.Q1), num(l.Q3)]);
    });
    // O fixture pega os arredondamentos ingênuos no float: Q1 de agosto = 0,555 (no float, 0,55499999...) e mediana
    // de abril = 0,605 (0,60499999...). O ARRED dá 0,56 e 0,61, como o publicado.
    const agosto = canal.semanas[7]!.q1!;
    const abril = canal.semanas[3]!.mediana!;
    expect([arredondar(agosto, 2), arredondar(abril, 2)]).toEqual([0.56, 0.61]);
    expect(Math.round(agosto * 100) / 100).toBe(0.55);
    expect(abril.toFixed(2)).toBe('0.60');
  });

  it('3. Diretrizes 2009, Anexo VIII: média e DP agrupados, k = 1, borda circular, arredondamento inteiro', () => {
    const t = lerCsv('diretrizes-2009-anexo8.csv');
    // Colunas do PDF: 2001 e 2003 a 2008 (2002 não aparece: fica sem cobertura).
    const anos = [2001, 2003, 2004, 2005, 2006, 2007, 2008];
    const series = anos.map((a) =>
      serie(
        a,
        t.map((l) => num(l[String(a)])),
      ),
    );
    const r: ReceitaCanal = { ...RECEITAS_MODELO.DIRETRIZES_2009.receita, k: 1, anos: 8, unidade: 'CASOS' };
    const canal = calcularCanal(series, 2009, r, []);
    expect(canal.anosReferencia).toEqual(anos);
    expect(canal.semanas[15]!.n).toBe(35);
    // SE 16: média 67,94, DP 100,41, LS 168,36 (publicado 168).
    expect(canal.semanas[15]!.media).toBeCloseTo(67.94, 2);
    expect(canal.semanas[15]!.dp).toBeCloseTo(100.41, 2);
    const naoBate: number[] = [];
    t.forEach((l, i) => {
      const s = canal.semanas[i]!;
      const ok = arredondar(s.media!, 0) === num(l.media_movel) && arredondar(s.dp!, 0) === num(l.desvio_padrao) && arredondar(s.ls!, 0) === num(l.limite_maximo);
      if (!ok) naoBate.push(i + 1);
    });
    // A SE 2 publicada (15, 13, 28) não se reproduz por nenhuma regra de borda testada na pesquisa: fica documentada aqui.
    expect(naoBate).toEqual([2]);
    // Com k = 1,96 (o que o texto do anexo diz) o limite publicado não bate.
    const k196 = calcularCanal(series, 2009, { ...r, k: 1.96 }, []);
    expect(t.filter((l, i) => i !== 1 && arredondar(k196.semanas[i]!.ls!, 0) === num(l.limite_maximo))).toHaveLength(0);
    // 2009 (todos os notificados): as SE 1 a 15 ficam acima do limite publicado.
    const acima = t.filter((l) => num(l['2009']) !== null && num(l['2009'])! > num(l.limite_maximo)!).map((l) => Number(l.SE));
    expect(acima).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it('4. NT 1/2023, Tabela 1 (exemplo inconsistente da NT): QUARTIL.INC, ano em análise incluído, casos, SE 1 a 36', () => {
    // A tabela contradiz o texto da própria NT: usa casos (não incidência), 11 anos com o ano monitorado (2022) e
    // QUARTIL.INC; a coluna "limite superior" traz o Q1 e a "limite inferior" o Q3 (rótulos trocados). Nas SE 37 a
    // 52 (2022 em branco) falta a mediana e o Q3 publicado não corresponde a nenhuma função padrão.
    const t = lerCsv('nt-01-2023-tabela1.csv');
    const anos = Array.from({ length: 11 }, (_, i) => 2012 + i);
    const series = anos.map((a) =>
      serie(
        a,
        t.map((l) => num(l[String(a)])),
      ),
    );
    const r: ReceitaCanal = { ...RECEITAS_MODELO.NT_1_2023.receita, quartil: 'INC', anos: 10, incluiAnoEmAnalise: true, unidade: 'CASOS' };
    const canal = calcularCanal(series, 2022, r, []);
    expect(canal.anosReferencia).toEqual(anos);
    t.slice(0, 36).forEach((l, i) => {
      const s = canal.semanas[i]!;
      expect([s.mediana, s.q1, s.q3]).toEqual([num(l.mediana), num(l.limite_superior), num(l.limite_inferior)]);
    });
    // Nas SE 37 a 52 só o Q1 (coluna "limite superior") bate, sobre 10 valores.
    t.slice(36).forEach((l, i) => expect(canal.semanas[36 + i]!.q1).toBe(num(l.limite_superior)));
    // Com QUARTIL.EXC a SE 1 daria 174 e 3858.
    const exc = calcularCanal(series, 2022, { ...r, quartil: 'EXC' }, []);
    expect([exc.semanas[0]!.q1, exc.semanas[0]!.q3]).toEqual([174, 3858]);
  });

  it('5. Exemplo da Microsoft no canal: 11 anos com os valores 6, 7, 15, 36, 39, 40, 41, 42, 43, 47 e 49 na SE 1', () => {
    const valores = [6, 7, 15, 36, 39, 40, 41, 42, 43, 47, 49];
    const series = valores.map((v, i) => serie(2015 + i, [v]));
    const canal = calcularCanal(series, 2026, { ...RECEITA_CASOS, anos: 11 }, []);
    expect(canal.semanas[0]).toMatchObject({ n: 11, li: 15, centro: 40, ls: 43 });
  });
});
