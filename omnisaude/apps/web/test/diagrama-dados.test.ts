import { RECEITAS_MODELO, type CanalDoAno, type PontoDiagrama, type ReceitaCanal, type StatusSemana } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import { nomeDoAgravo, opcoesDeAgravo } from '../src/components/consolidacao/diagrama-agravos';
import {
  anosDoSeletor,
  consultaDiagrama,
  descricaoDoGrafico,
  fmtCasos,
  fmtMarcaY,
  fmtValor,
  linhasDoDiagrama,
  marcasDoEixo,
  receitaDoGrafico,
  rotulosDoCanal,
  semanasAcimaDoLs,
  semanasIncompletasDoEixo,
  textoFonte,
  textoSemanas,
  ultimaSemanaCompleta,
  viradaDoAno,
} from '../src/components/consolidacao/diagrama-dados';

/*
 * Dados da aba Diagrama de controle (web): linhas do gráfico e da tabela (os mesmos números), faixa do canal pelo
 * método, tracejado das semanas incompletas, eixo sazonal e números com o ARRED do Excel.
 */

const QUARTIS = RECEITAS_MODELO.MS_2025.receita;
const MEDIA_DP = RECEITAS_MODELO.DIRETRIZES_2009.receita;

function canal(ano: number, receita: ReceitaCanal): CanalDoAno {
  return { ano, canal: { receita, anosReferencia: [], semanas: [], avisos: [] }, congelado: null, observado: [] };
}

function ponto(
  ano: number,
  semana: number,
  valor: number | null,
  o: { li?: number | null; centro?: number | null; ls?: number | null; incompleta?: boolean; status?: StatusSemana; semCanal?: boolean } = {},
): PontoDiagrama {
  return {
    ano,
    semana,
    rotulo: `${String(semana).padStart(2, '0')}/${ano}`,
    casos: valor === null ? null : Math.round(valor),
    valor,
    canal: o.semCanal ? null : { li: o.li === undefined ? 1 : o.li, centro: o.centro === undefined ? 2 : o.centro, ls: o.ls === undefined ? 3 : o.ls },
    status: o.status ?? 'ATE_CENTRO',
    incompleta: o.incompleta ?? false,
  };
}

describe('linhas do diagrama', () => {
  it('quartis: a faixa vai do Q1 ao Q3; sem Q1 ou sem Q3 não há faixa', () => {
    const l = linhasDoDiagrama({ canais: [canal(2026, QUARTIS)], pontos: [ponto(2026, 1, 5), ponto(2026, 2, 5, { li: null }), ponto(2026, 3, 5, { ls: null }), ponto(2026, 4, 5, { semCanal: true })] });
    expect(l.map((x) => x.faixa)).toEqual([[1, 3], null, null, null]);
    expect(l[0]).toMatchObject({ chave: '2026-01', rotulo: '01/2026', li: 1, centro: 2, ls: 3, metodo: 'QUARTIS' });
    expect(l[3]).toMatchObject({ li: null, centro: null, ls: null });
  });

  it('média e desvio-padrão: sem limite inferior, a faixa vai do zero ao limite superior', () => {
    const l = linhasDoDiagrama({ canais: [canal(2026, MEDIA_DP)], pontos: [ponto(2026, 1, 5, { li: null, ls: 7.5 }), ponto(2026, 2, 5, { li: null, ls: null })] });
    expect(l.map((x) => x.faixa)).toEqual([[0, 7.5], null]);
    expect(l[0]!.metodo).toBe('MEDIA_DP');
  });

  it('semanas incompletas saem do traço contínuo e entram no tracejado, ligado à última semana completa', () => {
    const l = linhasDoDiagrama({
      canais: [canal(2026, QUARTIS)],
      pontos: [ponto(2026, 1, 1), ponto(2026, 2, 2), ponto(2026, 3, 3), ponto(2026, 4, 4, { incompleta: true }), ponto(2026, 5, 0, { incompleta: true }), ponto(2026, 6, null)],
    });
    expect(l.map((x) => x.observado)).toEqual([1, 2, 3, null, null, null]);
    expect(l.map((x) => x.incompleto)).toEqual([null, null, 3, 4, 0, null]);
    expect(l.map((x) => x.isoladoObservado || x.isoladoIncompleto)).toEqual([false, false, false, false, false, false]);
  });

  it('ponto sozinho na série é marcado para não sumir do gráfico (SE 1 incompleta no começo do ano)', () => {
    const l = linhasDoDiagrama({ canais: [canal(2026, QUARTIS)], pontos: [ponto(2026, 1, 2, { incompleta: true }), ponto(2026, 2, null), ponto(2026, 3, null)] });
    expect(l[0]).toMatchObject({ observado: null, incompleto: 2, isoladoIncompleto: true, isoladoObservado: false });
    const s = linhasDoDiagrama({ canais: [canal(2026, QUARTIS)], pontos: [ponto(2026, 1, null), ponto(2026, 2, 7), ponto(2026, 3, null)] });
    expect(s[1]).toMatchObject({ observado: 7, isoladoObservado: true });
  });

  it('valor zero é semana sem caso (desenhada), diferente de null (sem cobertura ou sem população)', () => {
    const l = linhasDoDiagrama({ canais: [canal(2026, QUARTIS)], pontos: [ponto(2026, 1, 0), ponto(2026, 2, null)] });
    expect(l.map((x) => x.observado)).toEqual([0, null]);
    expect(fmtValor(0, 'INCIDENCIA')).toBe('0,00');
    expect(fmtValor(null, 'INCIDENCIA')).toBe('—');
  });

  it('eixo sazonal: dois anos com chaves únicas, cada ponto com o método do canal do seu ano, e a virada marcada', () => {
    const pontos = [ponto(2025, 52, 1), ponto(2025, 53, 1, { li: null, ls: 4 }), ponto(2026, 1, 2, { li: null, ls: 5 }), ponto(2026, 2, 2, { li: null, ls: 5 })];
    const l = linhasDoDiagrama({ canais: [canal(2025, QUARTIS), canal(2026, MEDIA_DP)], pontos });
    expect(new Set(l.map((x) => x.chave)).size).toBe(4);
    expect(l.map((x) => x.metodo)).toEqual(['QUARTIS', 'QUARTIS', 'MEDIA_DP', 'MEDIA_DP']);
    // SE 53 de 2025 com o canal da SE 52 (sem Q1 aqui): sem faixa; 2026 na média e DP: do zero ao LS.
    expect(l.map((x) => x.faixa)).toEqual([[1, 3], null, [0, 5], [0, 5]]);
    expect(viradaDoAno(l)).toEqual({ chave: '2026-01', ano: 2026 });
    expect(viradaDoAno(l.slice(0, 2))).toBeNull();
  });
});

describe('receita e rótulos do gráfico', () => {
  const config = { receita: QUARTIS } as Parameters<typeof receitaDoGrafico>[0]['configuracao'];

  it('usa a receita do canal (a do congelado pode diferir da configuração) e avisa quando o sazonal mistura receitas', () => {
    expect(receitaDoGrafico({ canais: [canal(2026, { ...QUARTIS, unidade: 'CASOS' })], configuracao: config })).toEqual({ unidade: 'CASOS', metodo: 'QUARTIS', k: QUARTIS.k, misturada: false });
    expect(receitaDoGrafico({ canais: [canal(2025, QUARTIS), canal(2026, MEDIA_DP)], configuracao: config }).misturada).toBe(true);
    expect(receitaDoGrafico({ canais: [canal(2025, MEDIA_DP), canal(2026, { ...MEDIA_DP, k: 1 })], configuracao: config }).misturada).toBe(true);
    expect(receitaDoGrafico({ canais: [], configuracao: config })).toMatchObject({ unidade: 'INCIDENCIA', misturada: false });
  });

  it('rótulos pelo método: quartis com Q1 e Q3; média com o k da receita em vírgula decimal', () => {
    expect(rotulosDoCanal('QUARTIS', 1.96)).toMatchObject({ faixa: 'Faixa do canal (Q1 a Q3)', centro: 'Mediana (centro)', ls: 'Limite superior (Q3)' });
    expect(rotulosDoCanal('MEDIA_DP', 1.96)).toMatchObject({ faixa: 'Faixa do canal (até o limite superior)', centro: 'Média (centro)', ls: 'Limite superior (média + 1,96 DP)' });
  });
});

describe('números como a planilha', () => {
  it('arredonda como o ARRED do Excel (meia unidade para longe do zero), não como o ponto flutuante', () => {
    // 0,365 é o Q1 da SE 1 do exemplo de Londrina (VigiEPI); no binário vale 0,36499999…
    expect(fmtValor(0.365, 'INCIDENCIA')).toBe('0,37');
    expect(fmtValor(1.005, 'INCIDENCIA')).toBe('1,01');
    expect(fmtValor(2.675, 'INCIDENCIA')).toBe('2,68');
    expect(fmtValor(11.6075, 'INCIDENCIA')).toBe('11,61');
    expect(fmtValor(1234.5, 'INCIDENCIA')).toBe('1.234,50');
  });

  it('casos sem casas quando inteiros; mediana e quartis com até 2 casas', () => {
    expect(fmtValor(12, 'CASOS')).toBe('12');
    expect(fmtValor(2.5, 'CASOS')).toBe('2,5');
    expect(fmtValor(3.3333333, 'CASOS')).toBe('3,33');
    expect(fmtCasos(12345)).toBe('12.345');
    expect(fmtCasos(null)).toBe('—');
  });

  it('marcas do eixo Y: inteiras com ponto de milhar e compactas a partir de 10 mil', () => {
    expect(fmtMarcaY(0)).toBe('0');
    expect(fmtMarcaY(2500)).toBe('2.500');
    expect(fmtMarcaY(12.5)).toBe('12,5');
    expect(fmtMarcaY(20000)).toBe('20 mil');
    expect(fmtMarcaY(12500)).toBe('12,5 mil');
  });
});

describe('eixo e textos', () => {
  it('marcas do eixo X a cada 4 semanas desde o começo de cada trecho (1, 5…; no sazonal, 27, 31… e 1, 5…)', () => {
    const epi = Array.from({ length: 53 }, (_, i) => ({ chave: `2025-${i + 1}`, ano: 2025, semana: i + 1 }));
    expect(marcasDoEixo(epi).map((c) => Number(c.split('-')[1]))).toEqual([1, 5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 49, 53]);
    const saz = [...Array.from({ length: 27 }, (_, i) => ({ chave: `2025-${i + 27}`, ano: 2025, semana: i + 27 })), ...Array.from({ length: 26 }, (_, i) => ({ chave: `2026-${i + 1}`, ano: 2026, semana: i + 1 }))];
    expect(marcasDoEixo(saz)).toEqual(['2025-27', '2025-31', '2025-35', '2025-39', '2025-43', '2025-47', '2025-51', '2026-1', '2026-5', '2026-9', '2026-13', '2026-17', '2026-21', '2026-25']);
  });

  it('semanas incompletas do eixo mostrado (um ano passado não tem nenhuma)', () => {
    const l = linhasDoDiagrama({ canais: [canal(2026, QUARTIS)], pontos: [ponto(2026, 43, 1), ponto(2026, 44, 2, { incompleta: true }), ponto(2026, 45, 3, { incompleta: true })] });
    expect(semanasIncompletasDoEixo(l)).toEqual(['202644', '202645']);
    expect(semanasIncompletasDoEixo(linhasDoDiagrama({ canais: [canal(2024, QUARTIS)], pontos: [ponto(2024, 1, 1)] }))).toEqual([]);
  });

  it('semanas em texto, inclusive na virada do ano', () => {
    expect(textoSemanas(['202644', '202645'])).toBe('SE 44 e 45/2026');
    expect(textoSemanas(['202643', '202644', '202645'])).toBe('SE 43, 44 e 45/2026');
    expect(textoSemanas(['202552', '202601'])).toBe('SE 52/2025 e 1/2026');
    expect(textoSemanas([])).toBe('');
  });

  it('última semana completa com valor e semanas completas acima do LS', () => {
    const l = linhasDoDiagrama({
      canais: [canal(2026, QUARTIS)],
      pontos: [ponto(2026, 1, 9, { status: 'ACIMA_LS' }), ponto(2026, 2, 8, { status: 'ACIMA_LS' }), ponto(2026, 3, 9, { status: 'ACIMA_LS', incompleta: true }), ponto(2026, 4, null, { status: 'SEM_CANAL' })],
    });
    expect(ultimaSemanaCompleta(l)?.rotulo).toBe('02/2026');
    expect(semanasAcimaDoLs(l)).toBe(2);
    expect(ultimaSemanaCompleta([])).toBeNull();
  });

  it('consulta: território só fora do município', () => {
    expect(consultaDiagrama({ grupo: 'dengue', nivel: 'MUNICIPIO', territorio: 'x', ano: 2026, eixo: 'EPIDEMIOLOGICO' })).toBe('?grupo=dengue&nivel=MUNICIPIO&ano=2026&eixo=EPIDEMIOLOGICO');
    expect(consultaDiagrama({ grupo: 'dengue', nivel: 'BAIRRO', territorio: 'b1', ano: 2025, eixo: 'SAZONAL' })).toBe('?grupo=dengue&nivel=BAIRRO&ano=2025&eixo=SAZONAL&territorio=b1');
  });

  it('anos do seletor: do próximo ano até 2000 (o piso da API)', () => {
    const anos = anosDoSeletor(2026);
    expect(anos[0]).toBe(2027);
    expect(anos[anos.length - 1]).toBe(2000);
    expect(anos).toHaveLength(28);
  });

  it('fonte da população e descrição para leitor de tela', () => {
    expect(textoFonte('RIPSA', '2025')).toBe('RIPSA/MS (estimativas para indicadores de saúde), versão 2025');
    expect(textoFonte(null, null)).toBe('—');
    expect(descricaoDoGrafico({ agravo: 'Dengue', territorio: { nivel: 'MUNICIPIO', id: null, nome: 'Município' }, ano: 2025, eixo: 'SAZONAL' }, 'INCIDENCIA')).toContain('ano sazonal 2025/2026');
  });
});

describe('agravos do seletor', () => {
  it('do catálogo: um por grupo, com o nome da linha do grupo sem " - Casos", arboviroses primeiro', () => {
    const o = opcoesDeAgravo([
      { key: 'acidente-trabalho', groupKey: 'acidente-trabalho', name: 'Acidente de trabalho grave', context: 'CASO' },
      { key: 'zika-gestante', groupKey: 'zika', name: 'Doença aguda pelo vírus Zika em gestante', context: 'GESTANTE' },
      { key: 'zika', groupKey: 'zika', name: 'Doença aguda pelo vírus Zika', context: 'CASO' },
      { key: 'dengue-obito', groupKey: 'dengue', name: 'Dengue - Óbitos', context: 'OBITO' },
      { key: 'dengue', groupKey: 'dengue', name: 'Dengue - Casos', context: 'CASO' },
      { key: 'chikungunya', groupKey: 'chikungunya', name: 'Febre de Chikungunya', context: 'CASO' },
      { key: 'botulismo', groupKey: 'botulismo', name: 'Botulismo', context: 'CASO' },
      // Grupo que a API não aceita nas consultas (mais de 40 caracteres): fica fora do seletor.
      { key: 'mun-agravo-com-um-nome-muito-comprido-demais-x', groupKey: 'mun-agravo-com-um-nome-muito-comprido-demais-x', name: 'Agravo local', context: 'CASO' },
    ]);
    expect(o).toEqual([
      { grupo: 'dengue', nome: 'Dengue' },
      { grupo: 'chikungunya', nome: 'Febre de Chikungunya' },
      { grupo: 'zika', nome: 'Doença aguda pelo vírus Zika' },
      { grupo: 'acidente-trabalho', nome: 'Acidente de trabalho grave' },
      { grupo: 'botulismo', nome: 'Botulismo' },
    ]);
    expect(nomeDoAgravo(o, 'zika')).toBe('Doença aguda pelo vírus Zika');
    expect(nomeDoAgravo(o, 'outro')).toBe('outro');
  });

  it('sem o catálogo (gestor): os grupos da tabela do Sinan, sem repetir e sem as síndromes sem grupo', () => {
    const o = opcoesDeAgravo(null);
    expect(o.slice(0, 3).map((x) => x.grupo)).toEqual(['dengue', 'chikungunya', 'zika']);
    expect(new Set(o.map((x) => x.grupo)).size).toBe(o.length);
    expect(o.find((x) => x.grupo === 'sifilis')?.nome).toBe('Sífilis');
    expect(o.some((x) => x.nome.startsWith('Síndrome diarreica'))).toBe(false);
  });
});
