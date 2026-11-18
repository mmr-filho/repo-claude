import type { EstimativaPopulacao } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import { corpoDaPopulacao, errosDoLote, gruposDePopulacao, lerPopulacaoColada, lerValorDaFonte, opcoesDeFonte, valorDaFonte } from '../src/components/consolidacao/populacao-colar';

/*
 * População colada na tela (web): "ano;população" por linha, com ponto de milhar, cópia de planilha e os limites da
 * API (anos de 1990 a 2100, inteiro positivo, Censo 2022 só em 2022, sem ano repetido).
 */

describe('texto colado', () => {
  it('lê ponto e vírgula, tabulação, espaço e vírgula; ponto de milhar; ignora cabeçalho e linhas em branco', () => {
    const r = lerPopulacaoColada('Ano;População\n2020;1.234.567\n\n2021\t1240000\n2022 1 250 001\n2023, 1.260.002\r\n2024;1270003;\n', 'RIPSA');
    expect(r.erros).toEqual([]);
    expect(r.linhas).toEqual([
      { linha: 2, ano: 2020, populacao: 1234567 },
      { linha: 4, ano: 2021, populacao: 1240000 },
      { linha: 5, ano: 2022, populacao: 1250001 },
      { linha: 6, ano: 2023, populacao: 1260002 },
      { linha: 7, ano: 2024, populacao: 1270003 },
    ]);
  });

  it('aponta cada linha com problema e o motivo, sem perder as boas', () => {
    const r = lerPopulacaoColada(['2019;100', '19;100', '1989;100', '2020;1,5', '2021;0', '2022;abc', '2019;200', '2023;1;2', 'texto solto', '2024;1.2345'].join('\n'), 'MANUAL');
    expect(r.linhas).toEqual([{ linha: 1, ano: 2019, populacao: 100 }]);
    expect(r.erros.map((e) => [e.linha, e.erro])).toEqual([
      [2, 'Ano inválido: use 4 dígitos (ex.: 2024)'],
      [3, 'Ano fora do intervalo (1990 a 2100)'],
      [4, 'A população precisa ser um número inteiro maior que zero'],
      [5, 'A população precisa ser um número inteiro maior que zero'],
      [6, 'População inválida: use só números, com ponto de milhar se quiser (ex.: 1.234.567)'],
      [7, 'Ano repetido no texto (já está na linha 1)'],
      [8, 'Use duas colunas: ano;população'],
      [9, 'Use duas colunas: ano;população'],
      [10, 'População inválida: use só números, com ponto de milhar se quiser (ex.: 1.234.567)'],
    ]);
  });

  it('o Censo 2022 só vale para 2022', () => {
    const r = lerPopulacaoColada('2021;100\n2022;120', 'CENSO_2022');
    expect(r.linhas.map((l) => l.ano)).toEqual([2022]);
    expect(r.erros[0]).toMatchObject({ linha: 1, erro: 'O Censo 2022 só vale para o ano de 2022' });
  });

  it('versão e nota dentro dos limites da API', () => {
    expect(errosDoLote({ versao: '2025', nota: '' })).toEqual([]);
    expect(errosDoLote({ versao: 'x'.repeat(21), nota: 'y'.repeat(501) })).toEqual(['A versão tem no máximo 20 caracteres', 'A nota tem no máximo 500 caracteres']);
  });
});

describe('corpo e listas', () => {
  const linhas = [
    { linha: 1, ano: 2024, populacao: 10 },
    { linha: 2, ano: 2025, populacao: 11 },
  ];

  it('no município não vai território; versão aparada; nota vazia vira null', () => {
    expect(corpoDaPopulacao(linhas, { nivel: 'MUNICIPIO', territorioId: 'x' }, { fonte: 'IBGE_DOU', versao: ' 2025 ', nota: '  ' })).toEqual({
      linhas: [
        { ano: 2024, nivel: 'MUNICIPIO', territorioId: null, populacao: 10, fonte: 'IBGE_DOU', versao: '2025', nota: null },
        { ano: 2025, nivel: 'MUNICIPIO', territorioId: null, populacao: 11, fonte: 'IBGE_DOU', versao: '2025', nota: null },
      ],
    });
    expect(corpoDaPopulacao(linhas, { nivel: 'BAIRRO', territorioId: 'b1' }, { fonte: 'CENSO_2022', versao: '', nota: 'Censo por bairro' }).linhas[0]).toMatchObject({
      nivel: 'BAIRRO',
      territorioId: 'b1',
      nota: 'Censo por bairro',
    });
  });

  const est = (ano: number, fonte: EstimativaPopulacao['fonte'], versao: string, nivel: EstimativaPopulacao['nivel'] = 'MUNICIPIO'): EstimativaPopulacao => ({
    id: `${fonte}-${versao}-${ano}-${nivel}`,
    ano,
    nivel,
    territorioId: nivel === 'MUNICIPIO' ? null : 't1',
    territorioNome: nivel === 'MUNICIPIO' ? 'Município' : 'Centro',
    populacao: 1000 + ano,
    fonte,
    versao,
    nota: null,
    atualizadoEm: '2026-01-01T00:00:00.000Z',
  });

  it('agrupa por fonte e versão, com os anos em ordem', () => {
    const g = gruposDePopulacao([est(2025, 'RIPSA', '2025'), est(2024, 'RIPSA', '2025'), est(2025, 'IBGE_DOU', ''), est(2024, 'RIPSA', '2024')]);
    expect(g.map((x) => [x.fonte, x.versao, x.linhas.map((l) => l.ano)])).toEqual([
      ['RIPSA', '2025', [2024, 2025]],
      ['IBGE_DOU', '', [2025]],
      ['RIPSA', '2024', [2024]],
    ]);
  });

  it('opções de fonte da receita: as do município, com os anos; a escolha atual fica mesmo sem estimativa', () => {
    const o = opcoesDeFonte([est(2016, 'RIPSA', '2025'), est(2025, 'RIPSA', '2025'), est(2022, 'CENSO_2022', '', 'BAIRRO')], { fonte: 'IBGE_DOU', versao: null });
    expect(o.map((x) => x.rotulo)).toEqual(['RIPSA/MS (estimativas para indicadores de saúde), versão 2025 (2016 a 2025)', 'IBGE (estimativa publicada no DOU) (qualquer versão) (escolha atual)']);
    expect(opcoesDeFonte([], { fonte: null, versao: null })).toEqual([]);
  });

  it('valor do seletor de fonte vai e volta (vazio = escolhida pelo sistema)', () => {
    for (const v of [
      { fonte: 'RIPSA' as const, versao: '2025' },
      { fonte: 'IBGE_DOU' as const, versao: '' },
      { fonte: 'MANUAL' as const, versao: null },
      { fonte: null, versao: null },
    ])
      expect(lerValorDaFonte(valorDaFonte(v))).toEqual(v);
    expect(valorDaFonte({ fonte: null, versao: 'x' })).toBe('');
  });
});
