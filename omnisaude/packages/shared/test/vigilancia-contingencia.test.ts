import { describe, expect, it } from 'vitest';
import { avaliarPlano, deslocarSemana, PLANO_MODELO_MS_2025, ROTULO_EIXO_ACAO, semanasCompletas, type CriterioPlano, type IndicadoresAgravo, type PlanoContingencia, type StatusSemana } from '@omnisaude/shared';

/** Plano de contingência (VIG-1c, §3.3 do desenho): modelo do Apêndice B do MS 2025 e o motor que sugere o estágio. */
const E = 'ENTRE_CENTRO_E_LS' as const;
const A = 'ACIMA_LS' as const;
const C = 'ATE_CENTRO' as const;
const S = 'SEM_CANAL' as const;

/** Indicadores com as SE a partir da 1/2026; as `incompletas` últimas ficam incompletas. */
function ind(grupo: string, status: StatusSemana[], extra: Partial<IndicadoresAgravo> = {}, incompletas = 0): IndicadoresAgravo {
  return {
    grupo,
    semanas: status.map((s, i) => ({ semana: deslocarSemana('202601', i), status: s, completa: i < status.length - incompletas })),
    provaveis: 1000,
    graves: 0,
    sinaisAlarme: 0,
    obitosAgravo: 0,
    obitosInvestigacao: 0,
    incidenciaAcumulada: null,
    ...extra,
  };
}
const avalia = (indicadores: IndicadoresAgravo[], respostas: { criterio: string; atendido: boolean }[] = [], atual: string | null = null, plano = PLANO_MODELO_MS_2025) =>
  avaliarPlano(plano, indicadores, respostas, atual);
const item = (r: ReturnType<typeof avaliarPlano>, id: string, agravo?: string) => r.criterios.find((c) => c.id === id && (agravo === undefined || c.agravo === agravo))!;

describe('contingência: modelo do MS 2025 (Apêndice B, municipal)', () => {
  it('quatro estágios, três agravos, "E/OU" e desmobilização em 4 SE', () => {
    const p = PLANO_MODELO_MS_2025;
    expect(p.estagios.map((e) => [e.chave, e.ordem])).toEqual([
      ['NORMALIDADE', 0],
      ['MOBILIZACAO', 1],
      ['ALERTA', 2],
      ['EPIDEMIA', 3],
    ]);
    expect(p.agravos).toEqual(['dengue', 'chikungunya', 'zika']);
    expect(p.combinacao).toBe('QUALQUER');
    expect(p.desmobilizacao.semanas).toBe(4);
    expect(p.desmobilizacao.descricao).toContain('7.2.3');
  });

  it('critérios do apêndice com limiar e fonte (página) em cada um', () => {
    const p = PLANO_MODELO_MS_2025;
    const c = (id: string) => p.criterios.find((x) => x.id === id)!;
    expect(c('mob-canal')).toMatchObject({ estagio: 'MOBILIZACAO', tipo: 'CANAL_ACIMA_CENTRO', semanas: 4, modo: 'CONSECUTIVAS' });
    expect(c('ale-canal')).toMatchObject({ estagio: 'ALERTA', tipo: 'CANAL_ACIMA_LS', semanas: 4, agravos: ['dengue', 'chikungunya'] });
    expect(c('ale-graves')).toMatchObject({ tipo: 'PERCENTUAL_GRAVES', limiar: 1, agravos: ['dengue'] });
    expect(c('ale-letalidade')).toMatchObject({ tipo: 'LETALIDADE', limiar: 0.05 });
    expect(c('ale-letalidade-graves')).toMatchObject({ tipo: 'LETALIDADE_GRAVES', limiar: 3 });
    expect(c('ale-obitos-investigacao')).toMatchObject({ tipo: 'OBITOS_INVESTIGACAO_PERCENTUAL', limiar: 1 });
    expect(c('epi-graves')).toMatchObject({ limiar: 2 });
    expect(c('epi-letalidade')).toMatchObject({ limiar: 0.07 });
    expect(c('epi-letalidade-graves')).toMatchObject({ limiar: 5 });
    expect(c('epi-obitos-investigacao')).toMatchObject({ limiar: 2 });
    // Nowcasting, positividade, sorotipo e atendimentos: avaliados pela vigilância.
    for (const id of ['mob-nowcasting', 'mob-rtpcr', 'mob-sorotipo', 'ale-zdc', 'ale-atendimentos', 'epi-nowcasting', 'epi-zdc', 'epi-sorotipo']) expect(c(id).tipo).toBe('MANUAL');
    for (const x of p.criterios) {
      expect(x.fonte).toMatch(/Apêndice B, pp?\. \d/);
      expect(p.estagios.map((e) => e.chave)).toContain(x.estagio);
    }
    expect(new Set(p.criterios.map((x) => x.id)).size).toBe(p.criterios.length);
  });

  it('ações por estágio em todos os eixos', () => {
    for (const estagio of ['NORMALIDADE', 'MOBILIZACAO', 'ALERTA', 'EPIDEMIA'])
      for (const eixo of Object.keys(ROTULO_EIXO_ACAO)) expect(PLANO_MODELO_MS_2025.acoes.some((a) => a.estagio === estagio && a.eixo === eixo)).toBe(true);
    expect(PLANO_MODELO_MS_2025.acoes.some((a) => a.descricao.includes('Investigar surtos e situações inusitadas'))).toBe(true);
  });
});

describe('contingência: motor do estágio', () => {
  it('canal acima da mediana nas últimas 4 SE completas consecutivas: mobilização', () => {
    const r = avalia([ind('dengue', [C, E, E, E, E])]);
    expect(r.sugerido).toBe('MOBILIZACAO');
    expect(item(r, 'mob-canal', 'dengue')).toMatchObject({ atendido: true, valor: 4 });
    expect(item(r, 'mob-canal', 'dengue').detalhe).toContain('SE 02/2026 a 05/2026');
    expect(r.porEstagio).toEqual({ NORMALIDADE: 0, MOBILIZACAO: 1, ALERTA: 0, EPIDEMIA: 0 });
    // Só 3 SE seguidas: não basta.
    expect(avalia([ind('dengue', [C, C, E, E, E])]).sugerido).toBe('NORMALIDADE');
    // Começo do ano com menos de 4 SE completas.
    expect(item(avalia([ind('dengue', [E, E, E])]), 'mob-canal', 'dengue')).toMatchObject({ atendido: false, detalhe: 'Só 3 SE completa(s) no ano; o critério pede 4' });
  });

  it('semanas incompletas não contam', () => {
    // As duas últimas SE estão acima do LS, mas incompletas: as 4 últimas completas são E, E, E, C.
    const r = avalia([ind('dengue', [E, E, E, C, A, A], {}, 2)]);
    expect(item(r, 'mob-canal', 'dengue').atendido).toBe(false);
    expect(r.sugerido).toBe('NORMALIDADE');
  });

  it('semanas acima do LS contam para a mobilização; 4 acima do LS: alerta', () => {
    expect(avalia([ind('dengue', [E, A, A, E])]).sugerido).toBe('MOBILIZACAO');
    const r = avalia([ind('dengue', [E, A, A, A, A])]);
    expect(r.sugerido).toBe('ALERTA');
    expect(item(r, 'mob-canal', 'dengue').atendido).toBe(true);
    expect(item(r, 'ale-canal', 'dengue').atendido).toBe(true);
    // A chikungunya também tem o critério de canal no alerta; o Zika não.
    expect(avalia([ind('chikungunya', [A, A, A, A])]).sugerido).toBe('ALERTA');
    expect(avalia([ind('zika', [A, A, A, A])]).sugerido).toBe('MOBILIZACAO');
  });

  it('k de n semanas', () => {
    const plano: PlanoContingencia = {
      ...PLANO_MODELO_MS_2025,
      criterios: [{ id: 'k-de-n', estagio: 'ALERTA', agravos: ['dengue'], tipo: 'CANAL_ACIMA_LS', descricao: '2 das últimas 4 SE acima do LS', modo: 'K_DE_N', k: 2, n: 4 }],
    };
    expect(avalia([ind('dengue', [A, C, A, C])], [], null, plano).sugerido).toBe('ALERTA');
    expect(avalia([ind('dengue', [C, C, A, C])], [], null, plano).sugerido).toBe('NORMALIDADE');
    // Com 2 já atendidas, menos de n SE no ano não impede.
    expect(avalia([ind('dengue', [A, A])], [], null, plano).sugerido).toBe('ALERTA');
    // SEM_CANAL pode mudar o resultado: não avaliado.
    expect(item(avalia([ind('dengue', [A, S, C, C])], [], null, plano), 'k-de-n')).toMatchObject({ atendido: null });
    expect(item(avalia([ind('dengue', [C, S, C, C])], [], null, plano), 'k-de-n')).toMatchObject({ atendido: false });
  });

  it('sem canal numa das SE da janela: não avaliado (null), nunca atendido', () => {
    const r = avalia([ind('dengue', [E, S, E, E])]);
    expect(item(r, 'mob-canal', 'dengue')).toMatchObject({ atendido: null });
    expect(r.sugerido).toBe('NORMALIDADE');
    // Uma SE fora da condição já decide: não atendido.
    expect(item(avalia([ind('dengue', [C, S, E, E])]), 'mob-canal', 'dengue').atendido).toBe(false);
  });

  it('critério MANUAL sem resposta na semana fica null; com resposta, conta', () => {
    const r = avalia([ind('dengue', [C, C, C, C])]);
    for (const id of ['mob-rtpcr', 'ale-zdc', 'epi-sorotipo']) expect(item(r, id)).toMatchObject({ atendido: null, detalhe: 'Sem resposta da vigilância nesta semana: não avaliado' });
    expect(r.sugerido).toBe('NORMALIDADE');
    expect(avalia([ind('dengue', [C, C, C, C])], [{ criterio: 'epi-sorotipo', atendido: true }]).sugerido).toBe('EPIDEMIA');
    expect(avalia([ind('dengue', [C, C, C, C])], [{ criterio: 'mob-rtpcr', atendido: false }]).sugerido).toBe('NORMALIDADE');
  });

  it('percentuais e letalidade sobre os casos prováveis do ano', () => {
    // 2 graves/sinais de alarme em 100 prováveis = 2%: passa de 1% (alerta), não de 2% (epidemia).
    const r = avalia([ind('dengue', [C], { provaveis: 100, graves: 1, sinaisAlarme: 1 })]);
    expect(item(r, 'ale-graves', 'dengue')).toMatchObject({ atendido: true, valor: 2 });
    expect(item(r, 'ale-graves', 'dengue').detalhe).toBe('2% dos casos prováveis são graves ou com sinais de alarme (2 de 100); limiar > 1%');
    expect(item(r, 'epi-graves', 'dengue').atendido).toBe(false);
    expect(r.sugerido).toBe('ALERTA');
    // Letalidade: 1 óbito em 1.000 prováveis = 0,1% (> 0,07%); entre os graves, 1 em 20 = 5% (não passa de 5%).
    const l = avalia([ind('dengue', [C], { provaveis: 1000, graves: 15, sinaisAlarme: 5, obitosAgravo: 1 })]);
    expect(item(l, 'epi-letalidade', 'dengue')).toMatchObject({ atendido: true, valor: 0.1 });
    expect(item(l, 'epi-letalidade-graves', 'dengue')).toMatchObject({ atendido: false, valor: 5 });
    expect(l.sugerido).toBe('EPIDEMIA');
    // Comparador ">=".
    const plano: PlanoContingencia = { ...PLANO_MODELO_MS_2025, criterios: [{ ...PLANO_MODELO_MS_2025.criterios.find((c) => c.id === 'epi-letalidade-graves')!, comparador: '>=' }] };
    expect(avalia([ind('dengue', [C], { graves: 15, sinaisAlarme: 5, obitosAgravo: 1 })], [], null, plano).sugerido).toBe('EPIDEMIA');
    // Óbitos em investigação: 3 em 100 = 3% (> 2%).
    expect(item(avalia([ind('chikungunya', [C], { provaveis: 100, obitosInvestigacao: 3 })]), 'epi-obitos-investigacao', 'chikungunya').atendido).toBe(true);
    // Sem casos prováveis: não atendido, sem divisão por zero.
    expect(item(avalia([ind('dengue', [C], { provaveis: 0 })]), 'ale-letalidade', 'dengue')).toMatchObject({ atendido: false, valor: null, detalhe: 'Sem casos prováveis no ano' });
    expect(item(avalia([ind('dengue', [C], { obitosAgravo: 1 })]), 'ale-letalidade-graves', 'dengue')).toMatchObject({ atendido: false, detalhe: 'Sem casos graves ou com sinais de alarme no ano' });
  });

  it('incidência acumulada contra o limiar; sem população, não avaliado', () => {
    const plano: PlanoContingencia = {
      ...PLANO_MODELO_MS_2025,
      criterios: [{ id: 'inc', estagio: 'ALERTA', agravos: ['chikungunya'], tipo: 'INCIDENCIA_ACUMULADA', descricao: 'Mais de 300 por 100 mil', limiar: 300 }],
    };
    expect(avalia([ind('chikungunya', [C], { incidenciaAcumulada: 301.5 })], [], null, plano).sugerido).toBe('ALERTA');
    expect(item(avalia([ind('chikungunya', [C], { incidenciaAcumulada: null })], [], null, plano), 'inc').atendido).toBeNull();
  });

  it('um item por agravo nos critérios automáticos; agravo sem indicadores não é avaliado', () => {
    const r = avalia([ind('dengue', [E, E, E, E])]);
    expect(r.criterios.filter((c) => c.id === 'mob-canal').map((c) => [c.agravo, c.atendido])).toEqual([
      ['dengue', true],
      ['chikungunya', null],
      ['zika', null],
    ]);
    expect(item(r, 'mob-canal', 'zika').detalhe).toBe('Sem indicadores do agravo: não avaliado');
  });

  it('QUALQUER: o estágio de maior ordem com algum critério atendido', () => {
    const r = avalia([ind('dengue', [E, E, E, E]), ind('chikungunya', [C], { provaveis: 100, obitosInvestigacao: 2 })]);
    // Chikungunya: 2% de óbitos em investigação (> 1%, alerta; não > 2%, epidemia).
    expect(r.sugerido).toBe('ALERTA');
    expect(r.porEstagio).toMatchObject({ MOBILIZACAO: 1, ALERTA: 1, EPIDEMIA: 0 });
  });

  it('DOIS_OU_MAIS (SES-MG): 2 critérios no estágio, empate no maior e o último estágio exige todos', () => {
    const crit = (id: string, estagio: string): CriterioPlano => ({ id, estagio, agravos: ['dengue'], tipo: 'MANUAL', descricao: id });
    const plano: PlanoContingencia = {
      ...PLANO_MODELO_MS_2025,
      combinacao: 'DOIS_OU_MAIS',
      criterios: [crit('m1', 'MOBILIZACAO'), crit('m2', 'MOBILIZACAO'), crit('a1', 'ALERTA'), crit('a2', 'ALERTA'), crit('a3', 'ALERTA'), crit('e1', 'EPIDEMIA'), crit('e2', 'EPIDEMIA')],
    };
    const sim = (...ids: string[]) => ids.map((criterio) => ({ criterio, atendido: true }));
    const dengue = [ind('dengue', [C])];
    expect(avalia(dengue, sim('a1'), null, plano).sugerido).toBe('NORMALIDADE');
    expect(avalia(dengue, sim('m1', 'm2'), null, plano).sugerido).toBe('MOBILIZACAO');
    expect(avalia(dengue, sim('m1', 'm2', 'a1', 'a2'), null, plano).sugerido).toBe('ALERTA');
    // Epidemia: um só dos dois critérios não basta, mesmo com 2 no alerta.
    expect(avalia(dengue, sim('a1', 'a2', 'e1'), null, plano).sugerido).toBe('ALERTA');
    expect(avalia(dengue, sim('e1', 'e2'), null, plano).sugerido).toBe('EPIDEMIA');
    // Com QUALQUER, o mesmo e1 sozinho já seria epidemia.
    expect(avalia(dengue, sim('e1'), null, { ...plano, combinacao: 'QUALQUER' }).sugerido).toBe('EPIDEMIA');
    // Por agravo: um critério da dengue e um da chikungunya no mesmo estágio não somam.
    const misto: PlanoContingencia = {
      ...PLANO_MODELO_MS_2025,
      combinacao: 'DOIS_OU_MAIS',
      criterios: [{ ...crit('d1', 'ALERTA') }, { ...crit('c1', 'ALERTA'), agravos: ['chikungunya'] }],
    };
    expect(avalia(dengue, sim('d1', 'c1'), null, misto).sugerido).toBe('NORMALIDADE');
  });

  it('desmobilização: só desce depois de 4 SE completas seguidas abaixo do estágio atual', () => {
    // Alerta (4 SE acima do LS) até 2 SE atrás; nas 2 últimas, a curva voltou para baixo da mediana.
    const r = avalia([ind('dengue', [A, A, A, A, C, C])], [], 'ALERTA');
    expect(r.sugerido).toBe('ALERTA');
    expect(r.desmobilizacao).toEqual({ sugerida: false, detalhe: 'Sugestão abaixo de Alerta há 2 de 4 SE completas seguidas: manter Alerta até completar 4.' });
    // Quatro SE completas seguidas abaixo do alerta: desce, para o maior estágio sugerido nessas 4 SE (redução gradual).
    const d = avalia([ind('dengue', [A, A, A, A, E, E, E, E])], [], 'ALERTA');
    expect(d.sugerido).toBe('MOBILIZACAO');
    expect(d.desmobilizacao.sugerida).toBe(true);
    expect(d.desmobilizacao.detalhe).toContain('pode desmobilizar para Mobilização');
    // Nas 4 últimas SE nenhuma janela de 4 SE ficou acima da mediana: normalidade.
    expect(avalia([ind('dengue', [A, A, A, A, C, C, C, C])], [], 'EPIDEMIA').sugerido).toBe('NORMALIDADE');
    // Descida gradual: hoje a sugestão é normalidade, mas nas 3 SE anteriores era alerta; da epidemia, desce para o alerta.
    expect(avalia([ind('dengue', [A, A, A, A, A, A, A, C])], [], 'EPIDEMIA').sugerido).toBe('ALERTA');
    expect(avalia([ind('dengue', [C, C, C, C, C, C, C, C, C])], [], 'EPIDEMIA').sugerido).toBe('NORMALIDADE');
    // Subir não espera: alerta com o estágio atual em mobilização.
    expect(avalia([ind('dengue', [A, A, A, A])], [], 'MOBILIZACAO')).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false } });
    // Poucas SE no ano: sem como confirmar 4 SE abaixo, mantém.
    expect(avalia([ind('dengue', [C, C])], [], 'ALERTA').sugerido).toBe('ALERTA');
    // Estágio atual desconhecido no plano: tratado como sem acionamento.
    expect(avalia([ind('dengue', [C])], [], 'NIVEL_3').sugerido).toBe('NORMALIDADE');
  });

  it('semanas completas: as incompletas contam a semana em curso', () => {
    expect(semanasCompletas('202610', 2)).toEqual({ incompletas: ['202609', '202610'], ultimaCompleta: '202608' });
    expect(semanasCompletas('202602', 2)).toEqual({ incompletas: ['202601', '202602'], ultimaCompleta: '202553' });
    expect(semanasCompletas('202601', 3)).toEqual({ incompletas: ['202552', '202553', '202601'], ultimaCompleta: '202551' });
    // A semana em curso nunca é completa.
    expect(semanasCompletas('202610', 0)).toEqual({ incompletas: ['202610'], ultimaCompleta: '202609' });
  });
});
