import { describe, expect, it } from 'vitest';
import {
  avaliarPlano,
  calcularCanal,
  curvaObservada,
  deslocarSemana,
  PLANO_MODELO_MS_2025,
  RECEITAS_MODELO,
  semanaDoCanal,
  statusDaSemana,
  type AcionamentoEmVigor,
  type IndicadoresAgravo,
  type StatusSemana,
} from '@omnisaude/shared';

/**
 * Plano de contingência, quinta rodada da semana 27 (R5-7): a descida pelos agravos que sustentam o estágio (S), os com
 * canal cujo critério de canal de algum estágio até o em vigor foi atendido numa SE completa desde o início do
 * acionamento em vigor, ou no retrato dele. A condição da curva e o piso de nível valem só para eles (r4vdia-1 e
 * r4vdia-2); a SE sem canal vale para eles e para o agravo cujo critério de canal ficou sem avaliação nas SE contadas
 * (com S vazio, para todo agravo com canal).
 */
const E = 'ENTRE_CENTRO_E_LS' as const;
const A = 'ACIMA_LS' as const;
const C = 'ATE_CENTRO' as const;
const S = 'SEM_CANAL' as const;
const P = PLANO_MODELO_MS_2025;

/** Indicadores com as SE a partir da 1/2026, todas completas. */
function ind(grupo: string, status: StatusSemana[], extra: Partial<IndicadoresAgravo> = {}): IndicadoresAgravo {
  return {
    grupo,
    semanas: status.map((s, i) => ({ semana: deslocarSemana('202601', i), status: s, completa: true })),
    provaveis: 1000,
    graves: 0,
    sinaisAlarme: 0,
    obitosAgravo: 0,
    obitosInvestigacao: 0,
    incidenciaAcumulada: null,
    ...extra,
  };
}
const avalia = (indicadores: IndicadoresAgravo[], atual: string, acionamento: AcionamentoEmVigor | null = null) => avaliarPlano(P, indicadores, [], atual, acionamento);
const desde = (semanaInicio: string, indicadores?: IndicadoresAgravo[]): AcionamentoEmVigor => ({ semanaInicio, ...(indicadores ? { indicadores } : {}) });
/** "pode desmobilizar para X" com o texto da desmobilização do modelo. */
const desmobiliza = (atual: string, destino: string) => `Sugestão abaixo de ${atual} nas últimas 4 SE completas: pode desmobilizar para ${destino}. ${P.desmobilizacao.descricao}.`;

describe('contingência, quinta rodada (R5-7): descida pelos agravos que sustentam o estágio', () => {
  it('r4vdia-1: a SE de queda no meio da alta não leva a descida abaixo do nível da curva (piso de nível)', () => {
    // Epidemia em vigor, decidida pela vigilância (nenhum acumulado acima do limiar; o estágio da epidemia do MS não tem
    // critério de canal). A dengue acima do LS desde a SE 1; a SE 7 cai até o centro (feriado) e as SE 8 a 10 voltam
    // acima do LS. As 4 janelas contêm a SE de queda: as 4 sugestões são normalidade. Antes: "pode desmobilizar para
    // Normalidade" com a curva acima do LS em 3 das 4 SE, e na SE seguinte a sugestão de subir ao alerta.
    const epidemia = avalia([ind('dengue', [A, A, A, A, A, A, C, A, A, A])], 'EPIDEMIA', desde('202601'));
    expect(epidemia).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: true } });
    expect(epidemia.desmobilizacao.detalhe).toBe(
      `${desmobiliza('Situação de epidemia', 'Alerta')} Na SE 10/2026, a curva de dengue está acima do limite superior, no nível do critério de canal de Alerta: a descida para nele.`,
    );
    // Sem a SE de queda, o mesmo destino (as sugestões já são o alerta), sem a nota.
    const semQueda = avalia([ind('dengue', Array<StatusSemana>(10).fill(A))], 'EPIDEMIA', desde('202601'));
    expect(semQueda).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: true, detalhe: desmobiliza('Situação de epidemia', 'Alerta') } });
    // No alerta, na SE seguinte (de novo acima do LS): sem vai e volta, a sugestão confirma o estágio.
    expect(avalia([ind('dengue', [A, A, A, A, A, A, C, A, A, A, A])], 'ALERTA', desde('202611'))).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false, detalhe: '' } });

    // Um estágio abaixo: alerta em vigor e a curva entre o centro e o LS (o nível da mobilização) há 6 SE, com uma SE até
    // o centro no meio. Antes: normalidade, e na SE seguinte a sugestão de subir à mobilização.
    const alerta = avalia([ind('dengue', [A, A, A, A, A, A, E, E, C, E, E, E])], 'ALERTA', desde('202601'));
    expect(alerta).toMatchObject({ sugerido: 'MOBILIZACAO', desmobilizacao: { sugerida: true } });
    expect(alerta.desmobilizacao.detalhe).toBe(
      `${desmobiliza('Alerta', 'Mobilização')} Na SE 12/2026, a curva de dengue está entre o centro e o limite superior, no nível do critério de canal de Mobilização: a descida para nele.`,
    );
    // Sem a queda, as sugestões já são a mobilização: sem a nota.
    expect(avalia([ind('dengue', [A, A, A, A, A, A, E, E, E, E, E, E])], 'ALERTA', desde('202601')).desmobilizacao.detalhe).toBe(desmobiliza('Alerta', 'Mobilização'));
    // A queda sustentada (4 SE até o centro) vai à normalidade, como antes.
    expect(avalia([ind('dengue', [A, A, A, A, A, A, C, C, C, C])], 'EPIDEMIA', desde('202601'))).toMatchObject({
      sugerido: 'NORMALIDADE',
      desmobilizacao: { sugerida: true, detalhe: desmobiliza('Situação de epidemia', 'Normalidade') },
    });
    // O nível de um agravo fora de S não segura o destino: Zika e chikungunya que nunca atenderam critério de canal.
    const foraDeS = avalia([ind('dengue', [A, A, A, A, A, A, C, C, C, C]), ind('zika', [C, C, C, C, C, C, C, E, C, E]), ind('chikungunya', [C, C, C, C, C, C, A, C, C, C])], 'EPIDEMIA', desde('202601'));
    expect(foraDeS).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true } });
  });

  it('r4vdia-2: um caso esporádico de Zika ou chikungunya (canal do MS com centro e LS zero) fora de S não trava a descida', () => {
    // Canal do MS 2025 (quartis da incidência dos 5 anos anteriores) num município de 100 mil habitantes onde o agravo
    // teve 2 casos em 5 anos: mediana e Q3 zero em quase todas as SE; um caso provável já fica acima do LS.
    const receita = RECEITAS_MODELO.MS_2025.receita;
    const raro = (grupo: string, semanaDoCaso: number): IndicadoresAgravo => {
      const anteriores = [2021, 2022, 2023, 2024, 2025].map((ano, k) => ({
        ano,
        populacao: 100_000,
        semanas: Array.from({ length: 52 }, (_, i) => ((k === 1 && i === 30) || (k === 3 && i === 40) ? 1 : 0)),
      }));
      const atual = { ano: 2026, populacao: 100_000, semanas: Array.from({ length: 52 }, (_, i) => (i === semanaDoCaso - 1 ? 1 : 0)) };
      const canal = calcularCanal([...anteriores, atual], 2026, receita, []);
      const obs = curvaObservada(atual, receita);
      return ind(
        grupo,
        Array.from({ length: 10 }, (_, i) => statusDaSemana(obs[i]!.valor, semanaDoCanal(canal, i + 1))),
      );
    };
    const zika = raro('zika', 9);
    expect(zika.semanas.map((s) => s.status)).toEqual([C, C, C, C, C, C, C, C, A, C]);

    // Mobilização em vigor pela dengue, de volta até o centro nas SE 7 a 10; 1 caso de Zika na SE 9. Antes: "manter
    // Mobilização ... a curva de zika está acima do limite superior".
    const mob = avalia([ind('dengue', [E, E, E, E, E, E, C, C, C, C]), zika], 'MOBILIZACAO', desde('202601'));
    expect(mob.criterios.filter((c) => c.atendido === true)).toEqual([]);
    expect(mob).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true, detalhe: desmobiliza('Mobilização', 'Normalidade') } });
    // Alerta em vigor pela dengue, de volta até o centro há 4 SE; 1 caso de chikungunya na SE 9.
    const ale = avalia([ind('dengue', [A, A, A, A, A, A, C, C, C, C]), raro('chikungunya', 9)], 'ALERTA', desde('202601'));
    expect(ale.criterios.filter((c) => c.atendido === true)).toEqual([]);
    expect(ale).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true, detalhe: desmobiliza('Alerta', 'Normalidade') } });

    // O Zika que sustenta o estágio (critério de canal da mobilização atendido nas SE 4 a 6) segura pela curva, como no N8.
    const sustenta = avalia([ind('dengue', [E, E, E, E, E, E, C, C, C, C]), ind('zika', [E, E, E, E, E, E, C, C, A, C])], 'MOBILIZACAO', desde('202601'));
    expect(sustenta).toMatchObject({ sugerido: 'MOBILIZACAO', desmobilizacao: { sugerida: false } });
    expect(sustenta.desmobilizacao.detalhe).toBe(
      'Sugestão abaixo de Mobilização há 1 de 4 SE completas seguidas: manter Mobilização até completar 4. A SE 09/2026 não conta como abaixo: a curva de zika está acima do limite superior, no nível do critério de canal de Mobilização; descer pede a curva abaixo desse nível em cada SE.',
    );
  });

  it('o caso original do N8 continua mantendo o estágio', () => {
    const alta = ind('dengue', [A, A, A, A, A, A, C, A, A, A]);
    const r = avalia([alta], 'ALERTA', desde('202601'));
    expect(r).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false } });
    expect(r.desmobilizacao.detalhe).toBe(
      'Sugestão abaixo de Alerta há 0 de 4 SE completas seguidas: manter Alerta até completar 4. A SE 10/2026 não conta como abaixo: a curva de dengue está acima do limite superior, no nível do critério de canal de Alerta; descer pede a curva abaixo desse nível em cada SE.',
    );
    // Sem o acionamento (só nos testes do motor), todas as SE completas dos indicadores contam para S.
    expect(avalia([alta], 'ALERTA')).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false } });
  });

  it('S vem do acionamento em vigor: critério de canal atendido desde o início dele (não antes) ou no retrato', () => {
    // Alerta decidido na SE 7, com o retrato até a SE 6 (dengue acima do LS desde a SE 1: o critério de canal do alerta
    // atendido nele). Desde a SE 7, nenhuma janela de 4 SE ficou inteira acima do LS: a dengue entra em S pelo retrato,
    // e a curva acima do LS na SE 10 segura o alerta.
    const curva = ind('dengue', [A, A, A, A, A, A, C, A, A, A]);
    const retrato = [ind('dengue', [A, A, A, A, A, A])];
    const comRetrato = avalia([curva], 'ALERTA', desde('202607', retrato));
    expect(comRetrato).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false } });
    expect(comRetrato.desmobilizacao.detalhe).toContain('A SE 10/2026 não conta como abaixo: a curva de dengue está acima do limite superior, no nível do critério de canal de Alerta');
    // Sem retrato (acionamento antigo, ou o da demonstração), S fica vazio: com o dado presente, valem só as sugestões.
    expect(avalia([curva], 'ALERTA', desde('202607'))).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true, detalhe: desmobiliza('Alerta', 'Normalidade') } });
    expect(avalia([curva], 'ALERTA', desde('202607', []))).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true } });

    // Mobilização decidida na SE 7 pela dengue; o Zika atendeu o critério de canal da mobilização nas SE 4 e 5, antes do
    // acionamento e fora do retrato (as SE 3 a 6 já tinham a queda). Um caso esporádico na SE 11 não trava a descida.
    const dengue = ind('dengue', [C, C, E, E, E, E, E, E, C, C, C, C]);
    const zika = ind('zika', [E, E, E, E, E, C, C, C, C, C, A, C]);
    const acionado = desde('202607', [ind('dengue', [C, C, E, E, E, E]), ind('zika', [E, E, E, E, E, C])]);
    expect(avalia([dengue, zika], 'MOBILIZACAO', acionado)).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true } });
    // Sem o acionamento, todas as SE contam: o Zika entra em S e o caso da SE 11 segura a mobilização.
    const semAcionamento = avalia([dengue, zika], 'MOBILIZACAO');
    expect(semAcionamento).toMatchObject({ sugerido: 'MOBILIZACAO', desmobilizacao: { sugerida: false } });
    expect(semAcionamento.desmobilizacao.detalhe).toContain('A SE 11/2026 não conta como abaixo: a curva de zika está acima do limite superior');
  });

  it('a SE sem canal vale para os agravos de S e para o que ficou sem avaliação nas SE contadas; com S vazio, para todos', () => {
    // A SE sem canal do agravo que sustenta o alerta não conta como abaixo (DIAGRAMA-1).
    expect(avalia([ind('dengue', [A, A, A, A, A, A, C, S, S, S])], 'ALERTA', desde('202601'))).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false } });
    // Uma SE sem canal do Zika que não muda nenhum critério dele (as janelas dão "não atendido" com ou sem ela): o Zika
    // fica fora de S e não trava a descida da dengue. Antes, travava ("A SE sem canal ... não conta como abaixo").
    const lacuna = avalia([ind('dengue', [A, A, A, A, C, C, C, C, C, C]), ind('zika', [C, C, C, C, C, C, C, S, C, C])], 'ALERTA', desde('202601'));
    expect(lacuna).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true, detalhe: desmobiliza('Alerta', 'Normalidade') } });
    // O Zika sem canal nas últimas 4 SE (a importação dele parou): o critério de canal dele ficou sem avaliação, e sem o
    // dado ele pode estar sustentando o estágio. Não desce por falta de dado.
    const parou = avalia([ind('dengue', [A, A, A, A, C, C, C, C, C, C]), ind('zika', [C, C, C, C, C, C, S, S, S, S])], 'ALERTA', desde('202601'));
    expect(parou).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false } });
    expect(parou.desmobilizacao.detalhe).toContain('A SE sem canal (sem base que cubra a semana, sem população ou com o quartil indefinido) não conta como abaixo');
    // S vazio (o alerta decidido na SE 7, sem retrato, e nenhum critério de canal atendido desde então): a SE sem canal
    // de qualquer agravo com canal não conta como abaixo, como antes.
    const vazio = avalia([ind('dengue', [A, A, A, A, A, A, C, C, S, C])], 'ALERTA', desde('202607'));
    expect(vazio).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false } });
    expect(vazio.desmobilizacao.detalhe).toBe(
      'Sugestão abaixo de Alerta há 1 de 4 SE completas seguidas: manter Alerta até completar 4. A SE sem canal (sem base que cubra a semana, sem população ou com o quartil indefinido) não conta como abaixo: a curva pode não ter descido.',
    );
  });
});
