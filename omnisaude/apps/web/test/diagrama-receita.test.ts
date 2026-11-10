import { RECEITAS_MODELO, type ConfiguracaoDiagrama } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import { ajustarReceita, ajustesDoModelo, aplicarModelo, corpoDaReceita, formularioDaConfiguracao, janelasDoMetodo, modeloDaReceita, motivoSugerido } from '../src/components/consolidacao/diagrama-receita-regras';

/*
 * Receita do diagrama (web): o corpo do PUT parte do modelo e manda só os ajustes; anos excluídos sempre com motivo;
 * fonte e versão da população do seletor.
 */

const padrao: ConfiguracaoDiagrama = {
  grupo: 'dengue',
  modelo: 'MS_2025',
  receita: { ...RECEITAS_MODELO.MS_2025.receita },
  anosExcluidos: [],
  fontePopulacao: null,
  versaoPopulacao: null,
  atualizadoEm: null,
  atualizadoPor: null,
  padrao: true,
};

describe('corpo da receita', () => {
  it('modelo sem ajuste: só o modelo, sem receita, população escolhida pelo sistema', () => {
    const { corpo, erros } = corpoDaReceita(formularioDaConfiguracao(padrao), 2026);
    expect(erros).toEqual([]);
    expect(corpo).toEqual({ modelo: 'MS_2025', anosExcluidos: [], fontePopulacao: null, versaoPopulacao: null });
  });

  it('modelo com ajuste: manda só os campos que mudaram', () => {
    const f = formularioDaConfiguracao(padrao);
    const { corpo } = corpoDaReceita({ ...f, receita: ajustarReceita(ajustarReceita(f.receita, 'quartil', 'INC'), 'unidade', 'CASOS') }, 2026);
    expect(corpo?.receita).toEqual({ quartil: 'INC', unidade: 'CASOS' });
  });

  it('receita própria (sem modelo): manda a receita inteira', () => {
    const f = aplicarModelo(formularioDaConfiguracao(padrao), null);
    const { corpo } = corpoDaReceita({ ...f, receita: { ...f.receita, anos: 8 } }, 2026);
    expect(corpo?.modelo).toBeNull();
    expect(corpo?.receita).toEqual({ ...RECEITAS_MODELO.MS_2025.receita, anos: 8 });
  });

  it('anos excluídos: ordenados, com motivo aparado; fonte e versão do seletor', () => {
    const f = {
      ...formularioDaConfiguracao(padrao),
      anosExcluidos: [
        { ano: '2024', motivo: '  Epidemia de 2024 (DENV-3)  ' },
        { ano: '2019', motivo: 'Epidemia de 2019 na cidade' },
      ],
      fonte: JSON.stringify(['RIPSA', '2025']),
    };
    const { corpo, erros } = corpoDaReceita(f, 2026);
    expect(erros).toEqual([]);
    expect(corpo).toMatchObject({
      anosExcluidos: [
        { ano: 2019, motivo: 'Epidemia de 2019 na cidade' },
        { ano: 2024, motivo: 'Epidemia de 2024 (DENV-3)' },
      ],
      fontePopulacao: 'RIPSA',
      versaoPopulacao: '2025',
    });
  });

  it('versão vazia é uma versão (a das estimativas sem versão); "qualquer versão" vai como null', () => {
    expect(corpoDaReceita({ ...formularioDaConfiguracao(padrao), fonte: JSON.stringify(['IBGE_DOU', '']) }, 2026).corpo).toMatchObject({ fontePopulacao: 'IBGE_DOU', versaoPopulacao: '' });
    expect(corpoDaReceita({ ...formularioDaConfiguracao(padrao), fonte: JSON.stringify(['IBGE_DOU', null]) }, 2026).corpo).toMatchObject({ fontePopulacao: 'IBGE_DOU', versaoPopulacao: null });
  });

  it('recusa motivo curto, ano repetido, ano que não terminou e limites da receita', () => {
    const f = formularioDaConfiguracao(padrao);
    const r = corpoDaReceita(
      {
        ...f,
        receita: { ...f.receita, metodo: 'MEDIA_DP', k: 0, anos: 25 },
        anosExcluidos: [
          { ano: '2024', motivo: 'curto' },
          { ano: '2024', motivo: 'Epidemia grande de 2024' },
          { ano: '2027', motivo: 'Ano que ainda não chegou' },
          { ano: 'abc', motivo: 'Ano inválido no campo' },
        ],
      },
      2026,
    );
    expect(r.corpo).toBeNull();
    expect(r.erros).toEqual([
      'Anos de referência: de 1 a 20.',
      'Multiplicador do desvio-padrão: maior que zero e até 5.',
      'Escreva o motivo da exclusão de 2024 (mínimo de 10 caracteres).',
      'O ano 2024 aparece duas vezes nos anos excluídos.',
      'Ano excluído inválido: use um ano de 1990 a 2026.',
      'Ano excluído inválido: use um ano de 1990 a 2026.',
    ]);
  });
});

it('o k vale também nos quartis (a API confere sempre: ele fica guardado na receita)', () => {
  const f = formularioDaConfiguracao(padrao);
  expect(corpoDaReceita({ ...f, receita: { ...f.receita, k: 0 } }, 2026).erros).toEqual(['Multiplicador do desvio-padrão: maior que zero e até 5.']);
});

describe('modelos e ajustes', () => {
  it('reconhece o modelo igual à receita e lista os ajustes', () => {
    expect(modeloDaReceita(RECEITAS_MODELO.VIGIEPI_2025.receita)).toBe('VIGIEPI_2025');
    expect(modeloDaReceita({ ...RECEITAS_MODELO.MS_2025.receita, quartil: 'INC' })).toBeNull();
    expect(ajustesDoModelo('MS_2025', RECEITAS_MODELO.NT_1_2023.receita)).toEqual({ anos: 7 });
  });

  it('trocar de modelo volta à receita dele; receita própria mantém a atual', () => {
    const f = formularioDaConfiguracao(padrao);
    expect(aplicarModelo(f, 'DIRETRIZES_2009').receita).toEqual(RECEITAS_MODELO.DIRETRIZES_2009.receita);
    expect(aplicarModelo({ ...f, receita: { ...f.receita, anos: 4 } }, null).receita.anos).toBe(4);
  });

  it('janela agrupada só na média e desvio-padrão; voltar aos quartis tira a agrupada', () => {
    expect(janelasDoMetodo('QUARTIS')).toEqual(['NENHUMA', 'SUAVIZADA_5']);
    expect(janelasDoMetodo('MEDIA_DP')).toContain('AGRUPADA_5');
    const r = ajustarReceita(RECEITAS_MODELO.DIRETRIZES_2009.receita, 'metodo', 'QUARTIS');
    expect(r.janela).toBe('NENHUMA');
    expect(ajustarReceita(RECEITAS_MODELO.MS_2025.receita, 'janela', 'SUAVIZADA_5').janela).toBe('SUAVIZADA_5');
  });

  it('motivo sugerido para ano epidêmico tem o tamanho mínimo e cita a regra', () => {
    expect(motivoSugerido(14).length).toBeGreaterThanOrEqual(10);
    expect(motivoSugerido(14)).toContain('14 SE');
  });
});
