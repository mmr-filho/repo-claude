import { describe, expect, it } from 'vitest';
import { avaliarPlano, deslocarSemana, PLANO_MODELO_MS_2025, semanasCompletas, type AcionamentoEmVigor, type IndicadoresAgravo, type StatusSemana } from '@omnisaude/shared';

/**
 * Plano de contingência, sexta rodada da semana 27 (R6-4, r5vdia-1): S, os agravos que sustentam o estágio, também olha
 * a SE que estava incompleta no dia do acionamento. A API grava o início na SE em curso (W) e o retrato com as SE
 * completas daquele dia (com as 2 semanas incompletas do padrão, até a W-2): a W-1 não estava em nenhum dos dois. O
 * limite das SE avaliadas para S passa a ser o menor entre o início e a SE seguinte à última SE completa do retrato (sem
 * retrato, o início); a contagem da descida continua desde o início. Os retratos daqui têm o formato que a API grava.
 */
const E = 'ENTRE_CENTRO_E_LS' as const;
const A = 'ACIMA_LS' as const;
const C = 'ATE_CENTRO' as const;
const P = PLANO_MODELO_MS_2025;

/** Indicadores com as SE a partir de `origem` (1/2026, se não vier); as `incompletas` últimas ficam incompletas. */
function ind(grupo: string, status: StatusSemana[], { origem = '202601', incompletas = 0 } = {}): IndicadoresAgravo {
  return {
    grupo,
    semanas: status.map((s, i) => ({ semana: deslocarSemana(origem, i), status: s, completa: i < status.length - incompletas })),
    provaveis: 1000,
    graves: 0,
    sinaisAlarme: 0,
    obitosAgravo: 0,
    obitosInvestigacao: 0,
    incidenciaAcumulada: null,
  };
}
/**
 * Acionamento como a API grava: início na SE em curso (a última de `ate`) e o retrato com as SE até ela, as
 * `semanasIncompletas` mais recentes incompletas (o padrão, 2: completas até a SE anterior à anterior ao início).
 */
function acionadoNa(curvas: Record<string, StatusSemana[]>, ate: number, { origem = '202601', semanasIncompletas = 2 } = {}): AcionamentoEmVigor {
  const semanaInicio = deslocarSemana(origem, ate - 1);
  const indicadores = Object.entries(curvas).map(([grupo, curva]) => ind(grupo, curva.slice(0, ate), { origem, incompletas: semanasIncompletas }));
  // O mesmo corte que a API usa (semanasCompletas da SE em curso).
  expect(indicadores[0]!.semanas.filter((s) => s.completa).at(-1)!.semana).toBe(semanasCompletas(semanaInicio, semanasIncompletas).ultimaCompleta);
  return { semanaInicio, indicadores };
}
const avalia = (indicadores: IndicadoresAgravo[], atual: string, acionamento: AcionamentoEmVigor | null) => avaliarPlano(P, indicadores, [], atual, acionamento);
/** "pode desmobilizar para X" com o texto da desmobilização do modelo. */
const desmobiliza = (atual: string, destino: string) => `Sugestão abaixo de ${atual} nas últimas 4 SE completas: pode desmobilizar para ${destino}. ${P.desmobilizacao.descricao}.`;
/** "manter X" com a SE que parou a contagem no nível do critério de canal do estágio em vigor. */
const mantem = (atual: string, se: string, agravo: string, nivel: string) =>
  `Sugestão abaixo de ${atual} há 0 de 4 SE completas seguidas: manter ${atual} até completar 4. A SE ${se} não conta como abaixo: a curva de ${agravo} está ${nivel}, no nível do critério de canal de ${atual}; descer pede a curva abaixo desse nível em cada SE.`;

describe('contingência, sexta rodada (R6-4): S enxerga a SE que estava incompleta no acionamento', () => {
  // Dengue até o centro nas SE 1 a 6 e acima do LS nas SE 7 a 10 (o critério de canal do alerta fecha na SE 10). A SE
  // 11, a do acionamento, cai até o centro (feriado com subnotificação), e as SE 12 a 14 voltam acima do LS.
  const curva: StatusSemana[] = [C, C, C, C, C, C, A, A, A, A, C, A, A, A];

  it('r5vdia-1, alerta: o critério de canal fechou na SE incompleta no dia da decisão e a SE do acionamento é de queda: mantém o alerta (N8)', () => {
    // Alerta acionado na SE 11 com o nowcasting: o retrato vai até a SE 9 (SE 10 e 11 incompletas), sem critério
    // atendido. Antes: S vazio (nenhuma janela a partir da SE 11 fica inteira acima do LS) e "pode desmobilizar para
    // Normalidade", com a curva acima do LS em 3 das 4 SE contadas.
    const acionado = acionadoNa({ dengue: curva }, 11);
    const r = avalia([ind('dengue', curva)], 'ALERTA', acionado);
    expect(r.criterios.filter((c) => c.atendido === true)).toEqual([]);
    expect(r).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false, detalhe: mantem('Alerta', '14/2026', 'dengue', 'acima do limite superior') } });
    // Na SE seguinte, de novo acima do LS, o critério fecha outra vez e confirma o estágio: sem vai e volta.
    expect(avalia([ind('dengue', [...curva, A])], 'ALERTA', acionado)).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false, detalhe: '' } });
    // A queda sustentada desce, como antes: as SE 11 a 14 até o centro.
    expect(avalia([ind('dengue', [C, C, C, C, C, C, A, A, A, A, C, C, C, C])], 'ALERTA', acionado)).toMatchObject({
      sugerido: 'NORMALIDADE',
      desmobilizacao: { sugerida: true, detalhe: desmobiliza('Alerta', 'Normalidade') },
    });
  });

  it('r5vdia-1, epidemia: a mesma curva leva a descida só até o alerta (piso de nível do r4vdia-1), não à normalidade', () => {
    const r = avalia([ind('dengue', curva)], 'EPIDEMIA', acionadoNa({ dengue: curva }, 11));
    expect(r).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: true } });
    expect(r.desmobilizacao.detalhe).toBe(`${desmobiliza('Situação de epidemia', 'Alerta')} Na SE 14/2026, a curva de dengue está acima do limite superior, no nível do critério de canal de Alerta: a descida para nele.`);
  });

  it('mobilização: o critério de canal dela fechou na SE incompleta no acionamento; a curva entre o centro e o LS segura', () => {
    const mob: StatusSemana[] = [C, C, C, C, C, C, E, E, E, E, C, E, E, E];
    const r = avalia([ind('dengue', mob)], 'MOBILIZACAO', acionadoNa({ dengue: mob }, 11));
    expect(r).toMatchObject({ sugerido: 'MOBILIZACAO', desmobilizacao: { sugerida: false, detalhe: mantem('Mobilização', '14/2026', 'dengue', 'entre o centro e o limite superior') } });
  });

  it('o limite é a SE seguinte à última SE completa do retrato: com 4 semanas incompletas, as 3 SE entre o retrato e o início contam; antes do retrato, não', () => {
    // Alerta acionado na SE 13 com 4 semanas incompletas: o retrato vai até a SE 9. O critério de canal fecha só na
    // janela que termina na SE 10 (7 a 10); as SE 11 e 13 caem (a 13 é a do acionamento). Antes: normalidade.
    const longe: StatusSemana[] = [C, C, C, C, C, C, A, A, A, A, C, A, C, A, A, A];
    const r = avalia([ind('dengue', longe)], 'ALERTA', acionadoNa({ dengue: longe }, 13, { semanasIncompletas: 4 }));
    expect(r).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false, detalhe: mantem('Alerta', '16/2026', 'dengue', 'acima do limite superior') } });

    // O critério atendido só antes da última SE completa do retrato (as janelas que terminam nas SE 4 e 5) não põe o
    // agravo em S: a SE acima do LS de agora, sozinha, não segura (o caso esporádico). Sem o acionamento, todas as SE
    // contam e ela segura.
    const antiga: StatusSemana[] = [A, A, A, A, A, C, C, C, C, C, C, C, C, A];
    expect(avalia([ind('dengue', antiga)], 'ALERTA', acionadoNa({ dengue: antiga }, 11))).toMatchObject({
      sugerido: 'NORMALIDADE',
      desmobilizacao: { sugerida: true, detalhe: desmobiliza('Alerta', 'Normalidade') },
    });
    expect(avalia([ind('dengue', antiga)], 'ALERTA', null)).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false } });
  });

  it('virada do ano: a SE 53/2025, incompleta no acionamento da SE 1/2026, conta para S', () => {
    // Dengue até o centro nas SE 40 a 49 de 2025 e acima do LS nas SE 50 a 53 (o critério fecha na 53); a SE 1/2026, a
    // do acionamento, cai; as SE 2 a 4 voltam acima do LS. O retrato vai até a SE 52/2025.
    const virada: StatusSemana[] = [...Array<StatusSemana>(10).fill(C), A, A, A, A, C, A, A, A];
    const agora = ind('dengue', virada, { origem: '202540' });
    expect(agora.semanas.slice(13, 15).map((s) => s.semana)).toEqual(['202553', '202601']);
    const acionado = acionadoNa({ dengue: virada }, 15, { origem: '202540' });
    expect(acionado.semanaInicio).toBe('202601');
    expect(avalia([agora], 'ALERTA', acionado)).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false, detalhe: mantem('Alerta', '04/2026', 'dengue', 'acima do limite superior') } });
  });

  it('o retrato é um só para o acionamento: o agravo que não está nele (o plano ganhou o agravo depois) também é olhado desde a SE seguinte ao retrato', () => {
    // Retrato só com a dengue (até a SE 9). A chikungunya fecha o critério do alerta na SE 10 e cai na SE 11.
    const acionado = acionadoNa({ dengue: Array<StatusSemana>(14).fill(C) }, 11);
    const r = avalia([ind('dengue', Array<StatusSemana>(14).fill(C)), ind('chikungunya', curva)], 'ALERTA', acionado);
    expect(r).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false, detalhe: mantem('Alerta', '14/2026', 'chikungunya', 'acima do limite superior') } });
  });

  it('sem retrato, o limite é o início; a contagem da descida segue só com as SE completas desde o início', () => {
    // Sem retrato (acionamento antigo, ou o da demonstração): S olha só desde a SE 11 e fica vazio; com o dado presente,
    // valem só as sugestões (risco documentado de S vazio).
    expect(avalia([ind('dengue', curva)], 'ALERTA', { semanaInicio: '202611' })).toMatchObject({
      sugerido: 'NORMALIDADE',
      desmobilizacao: { sugerida: true, detalhe: desmobiliza('Alerta', 'Normalidade') },
    });
    expect(avalia([ind('dengue', curva)], 'ALERTA', { semanaInicio: '202611', indicadores: [] })).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true } });

    // A dengue em S pelo retrato (acima do LS nas SE 1 a 9); a SE 10, depois do retrato e antes do início, está até o
    // centro, mas não entra na contagem: das SE 11 a 13, 3 de 4.
    const desce: StatusSemana[] = [A, A, A, A, A, A, A, A, A, C, C, C, C];
    const acionado = acionadoNa({ dengue: desce }, 11);
    expect(avalia([ind('dengue', desce)], 'ALERTA', acionado)).toMatchObject({
      sugerido: 'ALERTA',
      desmobilizacao: {
        sugerida: false,
        detalhe: 'Sugestão abaixo de Alerta há 3 de 4 SE completas seguidas: manter Alerta até completar 4. Só contam as SE completas desde o acionamento em vigor (SE 11/2026).',
      },
    });
    // Na SE seguinte, a 4ª desde o início: desce.
    expect(avalia([ind('dengue', [...desce, C])], 'ALERTA', acionado)).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true, detalhe: desmobiliza('Alerta', 'Normalidade') } });
  });

  it('retrato com a última SE fora do formato AAAASS (dado que o app não grava): o limite fica no início, sem erro', () => {
    const torto = (semana: string) => ({ ...ind('dengue', []), semanas: [{ semana, status: C, completa: true }] }) as IndicadoresAgravo;
    for (const semana of ['', 'SE 10', '2026-10', '2026100'])
      expect(avalia([ind('dengue', curva)], 'ALERTA', { semanaInicio: '202611', indicadores: [torto(semana)] }), semana).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true } });
  });
});
