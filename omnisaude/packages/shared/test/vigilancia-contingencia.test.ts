import { describe, expect, it } from 'vitest';
import {
  avaliarPlano,
  deslocarSemana,
  PLANO_MODELO_MS_2025,
  ROTULO_EIXO_ACAO,
  semanasCompletas,
  validarPlano,
  type CriterioPlano,
  type IndicadoresAgravo,
  type PlanoContingencia,
  type StatusSemana,
} from '@omnisaude/shared';

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
    // Série com menos de 4 SE completas (as do ano anterior também contam: ver a virada do ano abaixo).
    expect(item(avalia([ind('dengue', [E, E, E])]), 'mob-canal', 'dengue')).toMatchObject({ atendido: false, detalhe: 'Só 3 SE completa(s); o critério pede 4' });
  });

  it('virada do ano: as N SE seguidas atravessam a SE 1 (as SE do ano anterior vêm nos indicadores)', () => {
    // 4 SE acima do LS: 50, 51 e 52/2016 e 01/2017.
    const virada: IndicadoresAgravo = { ...ind('dengue', []), semanas: ['201649', '201650', '201651', '201652', '201701'].map((semana, i) => ({ semana, status: i ? A : C, completa: true })) };
    const r = avalia([virada]);
    expect(item(r, 'ale-canal', 'dengue')).toMatchObject({ atendido: true, valor: 4 });
    expect(item(r, 'ale-canal', 'dengue').detalhe).toContain('SE 50/2016 a 01/2017');
    expect(r.sugerido).toBe('ALERTA');
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

  it('desmobilização só conta as SE completas desde o início do acionamento em vigor (K2)', () => {
    // Curva acima do LS nas SE 1 a 6/2026 e de volta ao canal nas SE 7 a 10.
    const curva = ind('dengue', [A, A, A, A, A, A, C, C, C, C]);
    // Sem a data do acionamento, as 4 SE abaixo bastam.
    expect(avalia([curva], [], 'ALERTA').desmobilizacao.sugerida).toBe(true);
    // Alerta acionado na SE 9: só a 9 e a 10 contam; mantém.
    const r = avaliarPlano(PLANO_MODELO_MS_2025, [curva], [], 'ALERTA', { semanaInicio: '202609' });
    expect(r.sugerido).toBe('ALERTA');
    expect(r.desmobilizacao).toEqual({
      sugerida: false,
      detalhe: 'Sugestão abaixo de Alerta há 2 de 4 SE completas seguidas: manter Alerta até completar 4. Só contam as SE completas desde o acionamento em vigor (SE 09/2026).',
    });
    // Acionado na semana em curso (incompleta): nenhuma SE conta ainda.
    const hoje = avaliarPlano(PLANO_MODELO_MS_2025, [ind('dengue', [A, A, A, A, A, A, C, C, C, C, C], {}, 1)], [], 'ALERTA', { semanaInicio: '202611' });
    expect(hoje.sugerido).toBe('ALERTA');
    expect(hoje.desmobilizacao.detalhe).toContain('há 0 de 4 SE completas seguidas');
    // Quatro SE completas desde o acionamento: pode descer.
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [curva], [], 'ALERTA', { semanaInicio: '202607' })).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true } });
    // Subir não espera o acionamento.
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [ind('dengue', [A, A, A, A])], [], 'MOBILIZACAO', { semanaInicio: '202604' }).sugerido).toBe('ALERTA');
  });

  it('a curva de volta ao canal endêmico desmobiliza mesmo com o acumulado do ano acima do limiar (item 7.2.3)', () => {
    // Epidemia em vigor; SE 1 a 10 acima do LS e SE 11 a 30 de volta ao canal; 3 óbitos em 2.000 prováveis (0,15% > 0,07%).
    const curva = [...Array<StatusSemana>(10).fill(A), ...Array<StatusSemana>(20).fill(C)];
    const r = avalia([ind('dengue', curva, { provaveis: 2000, obitosAgravo: 3 })], [], 'EPIDEMIA');
    expect(item(r, 'epi-letalidade', 'dengue')).toMatchObject({ atendido: true, valor: 0.15 });
    expect(r.sugerido).toBe('NORMALIDADE');
    expect(r.desmobilizacao.sugerida).toBe(true);
    expect(r.desmobilizacao.detalhe).toContain('pode desmobilizar para Normalidade');
    expect(r.desmobilizacao.detalhe).toContain('No acumulado do ano, segue acima do limiar: letalidade de dengue em 0,15%.');
    // A mesma curva sem óbitos: a mesma descida, sem a nota do acumulado.
    const semObitos = avalia([ind('dengue', curva, { provaveis: 2000 })], [], 'EPIDEMIA');
    expect(semObitos).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true } });
    expect(semObitos.desmobilizacao.detalhe).not.toContain('acumulado');
    // Curva ainda acima do LS numa das últimas 4 SE: o acumulado segura a epidemia (não desce para o alerta da curva).
    const naoVoltou = avalia([ind('dengue', [...Array<StatusSemana>(10).fill(A), C, C, C], { provaveis: 2000, obitosAgravo: 3 })], [], 'EPIDEMIA');
    expect(naoVoltou).toMatchObject({ sugerido: 'EPIDEMIA', desmobilizacao: { sugerida: false, detalhe: '' } });
    const emAlta = avalia([ind('dengue', Array<StatusSemana>(12).fill(A), { provaveis: 2000, obitosAgravo: 3 })], [], 'EPIDEMIA');
    expect(emAlta.sugerido).toBe('EPIDEMIA');
    // De volta ao canal, mas o acionamento é recente: mantém, já citando o acumulado.
    const recente = avaliarPlano(PLANO_MODELO_MS_2025, [ind('dengue', curva, { provaveis: 2000, obitosAgravo: 3 })], [], 'EPIDEMIA', { semanaInicio: '202629' });
    expect(recente.sugerido).toBe('EPIDEMIA');
    expect(recente.desmobilizacao.detalhe).toContain('há 2 de 4');
    expect(recente.desmobilizacao.detalhe).toContain('letalidade de dengue em 0,15%');
  });

  it('o acumulado do ano já atendido no acionamento em vigor não faz o estágio subir de novo; o que passou do limiar depois, faz', () => {
    const curva = [...Array<StatusSemana>(10).fill(A), ...Array<StatusSemana>(20).fill(C)];
    const agora = ind('dengue', curva, { provaveis: 2000, obitosAgravo: 3 });
    // Retrato do acionamento da normalidade (SE 29), feito depois da descida: os mesmos 3 óbitos.
    const retrato = ind('dengue', curva.slice(0, 28), { provaveis: 1990, obitosAgravo: 3 });
    const r = avaliarPlano(PLANO_MODELO_MS_2025, [agora], [], 'NORMALIDADE', { semanaInicio: '202629', indicadores: [retrato] });
    expect(r.sugerido).toBe('NORMALIDADE');
    expect(item(r, 'epi-letalidade', 'dengue').atendido).toBe(true);
    expect(item(r, 'epi-letalidade', 'dengue').detalhe).toContain('Já atendido quando o estágio em vigor foi decidido');
    // Sem o retrato, o mesmo acumulado faria sugerir a epidemia logo depois da descida.
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [agora], [], 'NORMALIDADE', { semanaInicio: '202629' }).sugerido).toBe('EPIDEMIA');
    // No retrato, só 1 óbito em 2.000 (0,05%, que não passa de nenhum limiar): os 3 de agora passaram depois; sobe.
    const antes = ind('dengue', curva.slice(0, 28), { provaveis: 2000, obitosAgravo: 1 });
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [agora], [], 'NORMALIDADE', { semanaInicio: '202629', indicadores: [antes] }).sugerido).toBe('EPIDEMIA');
    // Retrato de outro ano: o acumulado recomeçou e não vale.
    const doAnoPassado: IndicadoresAgravo = { ...retrato, semanas: retrato.semanas.map((s) => ({ ...s, semana: `2025${s.semana.slice(4)}` })) };
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [agora], [], 'NORMALIDADE', { semanaInicio: '202550', indicadores: [doAnoPassado] }).sugerido).toBe('EPIDEMIA');
  });

  it('SE sem canal no fim da curva não é volta ao canal: o acumulado segura o estágio (DIAGRAMA-1)', () => {
    // Chikungunya de 2016: SE 1 a 3 até o centro, 4 a 29 acima do LS e 30 a 34 sem canal (a importação para na SE 29).
    // 3 óbitos em 2.000 prováveis (0,15%, acima do limiar da epidemia). Epidemia acionada na SE 31.
    const chik = (fim: StatusSemana[]) => ({
      ...ind('chikungunya', [], { provaveis: 2000, obitosAgravo: 3 }),
      semanas: [...Array<StatusSemana>(3).fill(C), ...Array<StatusSemana>(26).fill(A), ...fim].map((status, i) => ({ semana: deslocarSemana('201601', i), status, completa: true })),
    });
    const r = avaliarPlano(PLANO_MODELO_MS_2025, [chik(Array<StatusSemana>(5).fill(S))], [], 'EPIDEMIA', { semanaInicio: '201631' });
    // Antes, as SE sem canal soltavam o acumulado e a descida para a normalidade era sugerida citando o item 7.2.3.
    expect(r).toMatchObject({ sugerido: 'EPIDEMIA', desmobilizacao: { sugerida: false, detalhe: '' } });
    expect(item(r, 'epi-letalidade', 'chikungunya')).toMatchObject({ atendido: true, valor: 0.15 });
    // Sem a data do acionamento, o mesmo.
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [chik(Array<StatusSemana>(5).fill(S))], [], 'EPIDEMIA').sugerido).toBe('EPIDEMIA');
    // Uma SE sem canal entre as 4 últimas já basta para segurar.
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [chik([C, C, C, C, S])], [], 'EPIDEMIA', { semanaInicio: '201631' }).sugerido).toBe('EPIDEMIA');
    // A volta de verdade (4 SE dentro do canal) solta o acumulado, como antes.
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [chik([S, C, C, C, C])], [], 'EPIDEMIA', { semanaInicio: '201631' })).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true } });
    // Todas as SE sem canal (bairro sem população): sem acionamento sugere a epidemia; com ela em vigor, mantém (sem vai e volta).
    const semPopulacao = { ...chik([]), semanas: Array.from({ length: 34 }, (_, i) => ({ semana: deslocarSemana('201601', i), status: S, completa: true })) };
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [semPopulacao], [], null).sugerido).toBe('EPIDEMIA');
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [semPopulacao], [], 'EPIDEMIA', { semanaInicio: '201620' })).toMatchObject({ sugerido: 'EPIDEMIA', desmobilizacao: { sugerida: false } });
  });

  it('SE em que o critério de canal do estágio em vigor ficou sem canal não conta como abaixo (DIAGRAMA-1)', () => {
    // Alerta pela curva (4 SE acima do LS) e as 4 últimas SE sem canal: nada diz que a curva desceu.
    const r = avalia([ind('dengue', [A, A, A, A, S, S, S, S])], [], 'ALERTA');
    expect(item(r, 'ale-canal', 'dengue').atendido).toBeNull();
    expect(r.sugerido).toBe('ALERTA');
    expect(r.desmobilizacao.sugerida).toBe(false);
    expect(r.desmobilizacao.detalhe).toBe(
      'Sugestão abaixo de Alerta há 0 de 4 SE completas seguidas: manter Alerta até completar 4. A SE sem canal (sem base que cubra a semana, sem população ou com o quartil indefinido) não conta como abaixo: a curva pode não ter descido.',
    );
    // A SE sem canal num agravo que nunca teve canal nos indicadores (sem como conferir) não trava a descida do outro.
    const semCanalNunca = ind('chikungunya', Array<StatusSemana>(8).fill(S));
    expect(avalia([ind('dengue', [A, A, A, A, C, C, C, C]), semCanalNunca], [], 'ALERTA')).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true } });
    // Já a chikungunya que teve canal e ficou sem ele nas últimas SE trava: ela pode estar acima do LS.
    const semCanalAgora = ind('chikungunya', [C, C, C, C, S, S, S, S]);
    expect(avalia([ind('dengue', [A, A, A, A, C, C, C, C]), semCanalAgora], [], 'ALERTA').sugerido).toBe('ALERTA');
    // A SE sem canal de um agravo com canal também trava quando o critério de canal dele é de estágio abaixo do em vigor
    // (4ª rodada: a SE sem canal nunca conta como abaixo; antes, a mobilização sem canal não segurava o alerta).
    const plano: PlanoContingencia = { ...PLANO_MODELO_MS_2025, criterios: PLANO_MODELO_MS_2025.criterios.map((c) => (c.id === 'mob-canal' ? { ...c, agravos: ['zika'] } : c)) };
    const zika = ind('zika', [C, C, C, C, S, S, S, S]);
    expect(avalia([ind('dengue', [A, A, A, A, C, C, C, C]), zika], [], 'ALERTA', plano)).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false } });
  });

  it('o retrato do acionamento segura o acumulado enquanto o que chegou desde ele não passa do limiar (DIAGRAMA-2)', () => {
    // Mobilização acionada na SE 5 com 20 prováveis, 1 grave e 1 óbito (5% e 5%: o retrato já passa dos limiares).
    const retratoSE5 = ind('dengue', Array<StatusSemana>(5).fill(E), { provaveis: 20, graves: 1, obitosAgravo: 1 });
    // Na SE 30: 5.000 prováveis, 150 graves (3%) e 25 óbitos (0,5%; 16,7% entre os graves), curva entre o centro e o LS.
    const se30 = ind('dengue', Array<StatusSemana>(30).fill(E), { provaveis: 5000, graves: 150, obitosAgravo: 25 });
    const r = avaliarPlano(PLANO_MODELO_MS_2025, [se30], [], 'MOBILIZACAO', { semanaInicio: '202605', indicadores: [retratoSE5] });
    // Antes, o retrato com poucos casos congelava o acumulado pelo resto do ano e a sugestão ficava na mobilização.
    expect(r.sugerido).toBe('EPIDEMIA');
    for (const id of ['epi-graves', 'epi-letalidade', 'epi-letalidade-graves']) {
      expect(item(r, id, 'dengue').atendido).toBe(true);
      expect(item(r, id, 'dengue').detalhe).not.toContain('Já atendido');
    }
    // Curva acima do LS e alerta em vigor: o mesmo retrato não segura (antes, mantinha o alerta).
    const acimaLs = ind('dengue', Array<StatusSemana>(30).fill(A), { provaveis: 5000, graves: 150, obitosAgravo: 25 });
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [acimaLs], [], 'ALERTA', { semanaInicio: '202605', indicadores: [retratoSE5] }).sugerido).toBe('EPIDEMIA');

    // O vai e volta depois da descida: normalidade acionada na SE 29 com os mesmos 3 óbitos e a curva no canal; segura.
    const curva = [...Array<StatusSemana>(10).fill(A), ...Array<StatusSemana>(20).fill(C)];
    const retrato = ind('dengue', curva.slice(0, 28), { provaveis: 1990, obitosAgravo: 3 });
    const desceu = { semanaInicio: '202629', indicadores: [retrato] };
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [ind('dengue', curva, { provaveis: 2000, obitosAgravo: 3 })], [], 'NORMALIDADE', desceu).sugerido).toBe('NORMALIDADE');
    // Um óbito a mais depois da descida: a letalidade volta a contar e sobe.
    const maisUm = avaliarPlano(PLANO_MODELO_MS_2025, [ind('dengue', curva, { provaveis: 2000, obitosAgravo: 4 })], [], 'NORMALIDADE', desceu);
    expect(maisUm.sugerido).toBe('EPIDEMIA');
    expect(item(maisUm, 'epi-letalidade', 'dengue').detalhe).not.toContain('Já atendido');
    // Os mesmos 3 óbitos e a curva saiu do canal na última SE: o retrato segura (4ª rodada: a saída do canal conta pelos
    // critérios de canal, que pedem 4 SE, e não reabre o acumulado do ano; antes, uma SE acima do LS levava à epidemia).
    const saiu = [...Array<StatusSemana>(10).fill(A), ...Array<StatusSemana>(19).fill(C), A];
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [ind('dengue', saiu, { provaveis: 2000, obitosAgravo: 3 })], [], 'NORMALIDADE', desceu).sugerido).toBe('NORMALIDADE');
    // Graves: o numerador é a soma de graves e sinais de alarme; caso provável novo sem grave a mais segura.
    const graves = (g: number, s: number, prov: number) => ind('dengue', curva, { provaveis: prov, graves: g, sinaisAlarme: s });
    const comGraves = { semanaInicio: '202629', indicadores: [ind('dengue', curva.slice(0, 28), { provaveis: 100, graves: 2, sinaisAlarme: 1 })] };
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [graves(1, 2, 120)], [], 'NORMALIDADE', comGraves).sugerido).toBe('NORMALIDADE');
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [graves(2, 2, 120)], [], 'NORMALIDADE', comGraves).sugerido).toBe('EPIDEMIA');
  });

  it('o texto da desmobilização diz o que a regra faz: 4 SE completas seguidas abaixo, ou a curva de volta ao canal (DIAGRAMA-6)', () => {
    expect(PLANO_MODELO_MS_2025.desmobilizacao.descricao).toMatch(/^4 SE completas seguidas abaixo do estágio em vigor, ou volta da curva ao canal endêmico \(.*item 7\.2\.3, p\. 52\)$/);
    const d = avalia([ind('dengue', [A, A, A, A, E, E, E, E])], [], 'ALERTA');
    expect(d.desmobilizacao.sugerida).toBe(true);
    expect(d.desmobilizacao.detalhe).toContain('pode desmobilizar para Mobilização. 4 SE completas seguidas abaixo do estágio em vigor, ou volta da curva ao canal endêmico');
    expect(d.desmobilizacao.detalhe).not.toContain('por mais de 4');
  });

  it('uma SE de queda no meio da alta não vale 4 SE abaixo: a curva da própria SE tem de sair do nível do critério de canal (N8)', () => {
    // Alerta em vigor; a SE 7 cai até o centro (feriado com subnotificação) e as SE 8 a 10 voltam acima do LS. Antes, a
    // SE de queda quebrava as 4 janelas dos critérios e a tela dizia "pode desmobilizar para Normalidade".
    const alta = ind('dengue', [A, A, A, A, A, A, C, A, A, A]);
    const r = avaliarPlano(PLANO_MODELO_MS_2025, [alta], [], 'ALERTA', { semanaInicio: '202601' });
    expect(item(r, 'ale-canal', 'dengue')).toMatchObject({ atendido: false, valor: 3 });
    expect(r).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false } });
    expect(r.desmobilizacao.detalhe).toBe(
      'Sugestão abaixo de Alerta há 0 de 4 SE completas seguidas: manter Alerta até completar 4. A SE 10/2026 não conta como abaixo: a curva de dengue está acima do limite superior, no nível do critério de canal de Alerta; descer pede a curva abaixo desse nível em cada SE.',
    );
    // Sem a data do acionamento, o mesmo.
    expect(avalia([alta], [], 'ALERTA')).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false } });
    // Mobilização em vigor e a curva entre o centro e o LS de novo depois de uma SE até o centro: mantém.
    const mob = avaliarPlano(PLANO_MODELO_MS_2025, [ind('dengue', [E, E, E, E, E, E, C, E, E, E])], [], 'MOBILIZACAO', { semanaInicio: '202604' });
    expect(mob).toMatchObject({ sugerido: 'MOBILIZACAO', desmobilizacao: { sugerida: false } });
    expect(mob.desmobilizacao.detalhe).toContain('a curva de dengue está entre o centro e o limite superior, no nível do critério de canal de Mobilização');
    // Na mobilização, a SE acima do LS também segura (o critério dela aceita as SE acima do LS).
    expect(avalia([ind('dengue', [E, E, E, E, E, E, C, C, C, A])], [], 'MOBILIZACAO').desmobilizacao.sugerida).toBe(false);
    // A queda sustentada (4 SE até o centro) desce, como antes.
    expect(avalia([ind('dengue', [A, A, A, A, A, A, C, C, C, C])], [], 'ALERTA')).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true } });
    expect(avalia([ind('dengue', [E, E, E, E, E, E, C, C, C, C])], [], 'MOBILIZACAO')).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true } });
    // Do alerta, a curva entre o centro e o LS (abaixo do nível do alerta) desce para a mobilização.
    expect(avalia([ind('dengue', [A, A, A, A, A, A, E, E, E, E])], [], 'ALERTA')).toMatchObject({ sugerido: 'MOBILIZACAO', desmobilizacao: { sugerida: true } });
    // O agravo fora dos critérios de canal do alerta (o Zika, no modelo) não segura o alerta pela curva dele.
    expect(avalia([ind('dengue', [A, A, A, A, A, A, C, C, C, C]), ind('zika', [E, E, E, E, E, E, C, C, C, A])], [], 'ALERTA').desmobilizacao.sugerida).toBe(true);
  });

  it('SE sem canal de agravo com canal nunca conta como abaixo; o destino não fica abaixo do critério de canal sem avaliação (DIAGRAMA-1)', () => {
    // Epidemia em vigor (o estágio da epidemia do MS não tem critério de canal); chikungunya até o centro nas SE 1 a 3,
    // acima do LS da 4 à 29 e sem canal da 30 à 34 (a importação para na 29); sem óbito. Antes: "pode desmobilizar para
    // Normalidade ... volta da curva ao canal endêmico".
    const chik = {
      ...ind('chikungunya', [], { provaveis: 2000 }),
      semanas: [...Array<StatusSemana>(3).fill(C), ...Array<StatusSemana>(26).fill(A), ...Array<StatusSemana>(5).fill(S)].map((status, i) => ({ semana: deslocarSemana('201601', i), status, completa: true })),
    };
    const epi = avaliarPlano(PLANO_MODELO_MS_2025, [chik], [], 'EPIDEMIA', { semanaInicio: '201631' });
    expect(epi).toMatchObject({ sugerido: 'EPIDEMIA', desmobilizacao: { sugerida: false } });
    expect(epi.desmobilizacao.detalhe).toContain('A SE sem canal (sem base que cubra a semana, sem população ou com o quartil indefinido) não conta como abaixo');
    // Alerta em vigor: 6 SE acima do LS, 1 até o centro e 3 sem canal. Antes, as 3 SE sem canal contavam como abaixo
    // (a janela já tinha a SE até o centro: o critério dava "não atendido", e não "sem avaliação").
    const ale = avalia([ind('dengue', [A, A, A, A, A, A, C, S, S, S])], [], 'ALERTA');
    expect(item(ale, 'ale-canal', 'dengue').atendido).toBe(false);
    expect(ale).toMatchObject({ sugerido: 'ALERTA', desmobilizacao: { sugerida: false } });
    // O critério de canal da mobilização ficou sem avaliação em 3 das 4 SE (o Zika sem canal na SE 6, dentro das
    // janelas): a dengue desceu, mas o alerta só desce até a mobilização.
    const zika = ind('zika', [C, C, C, E, E, S, E, E, E, C]);
    const desce = avalia([ind('dengue', [A, A, A, A, C, C, C, C, C, C]), zika], [], 'ALERTA');
    expect(item(desce, 'mob-canal', 'zika').atendido).toBe(false);
    expect(desce).toMatchObject({ sugerido: 'MOBILIZACAO', desmobilizacao: { sugerida: true } });
    expect(desce.desmobilizacao.detalhe).toContain('pode desmobilizar para Mobilização');
    expect(desce.desmobilizacao.detalhe).toContain('O critério de canal de Mobilização ficou sem avaliação numa dessas SE (SE sem canal na janela): a descida para nele.');
    // Com o Zika no canal em todas as SE, a descida vai à normalidade.
    expect(avalia([ind('dengue', [A, A, A, A, C, C, C, C, C, C]), ind('zika', Array<StatusSemana>(10).fill(C))], [], 'ALERTA')).toMatchObject({ sugerido: 'NORMALIDADE', desmobilizacao: { sugerida: true } });
  });

  it('o acumulado já atendido no retrato segue conhecido enquanto o que chegou desde ele, avaliado sozinho, não passa do limiar (DIAGRAMA-2)', () => {
    // Normalidade acionada na SE 29, depois da descida: 2.000 prováveis, 50 graves e com sinais de alarme (2,5%) e
    // 3 óbitos (0,15%; 6% entre os graves); a curva de volta ao canal.
    const curva = [...Array<StatusSemana>(10).fill(A), ...Array<StatusSemana>(20).fill(C)];
    const desceu = { semanaInicio: '202629', indicadores: [ind('dengue', curva.slice(0, 28), { provaveis: 2000, graves: 10, sinaisAlarme: 40, obitosAgravo: 3 })] };
    const agora = (o: Partial<IndicadoresAgravo>, semanas = curva) => ind('dengue', semanas, { provaveis: 2000, graves: 10, sinaisAlarme: 40, obitosAgravo: 3, ...o });
    // 100 casos novos, 1 com sinais de alarme (1% dos novos, abaixo dos 2% da epidemia e sem passar de 1% do alerta).
    // Antes, o numerador que cresceu reabria o critério e a epidemia voltava.
    const r = avaliarPlano(PLANO_MODELO_MS_2025, [agora({ provaveis: 2100, sinaisAlarme: 41 })], [], 'NORMALIDADE', desceu);
    expect(r.sugerido).toBe('NORMALIDADE');
    for (const id of ['epi-graves', 'ale-graves', 'epi-letalidade', 'epi-letalidade-graves']) {
      expect(item(r, id, 'dengue').atendido).toBe(true);
      expect(item(r, id, 'dengue').detalhe).toContain('Já atendido quando o estágio em vigor foi decidido, e o que chegou desde então não passa do limiar: não faz subir');
    }
    // Uma SE acima do LS depois da descida não reabre o acumulado: a curva sobe pelos critérios de canal (4 SE).
    const umaAcima = [...curva.slice(0, 29), A];
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [agora({ provaveis: 2100, sinaisAlarme: 41 }, umaAcima)], [], 'NORMALIDADE', desceu).sugerido).toBe('NORMALIDADE');
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [agora({ provaveis: 2100, sinaisAlarme: 41 }, [...curva.slice(0, 26), A, A, A, A])], [], 'NORMALIDADE', desceu).sugerido).toBe('ALERTA');
    // Sem caso provável novo, o óbito a mais (de um caso antigo) não reabre: sem denominador novo, segue conhecido.
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [agora({ obitosAgravo: 4 })], [], 'NORMALIDADE', desceu).sugerido).toBe('NORMALIDADE');
    // O que chegou passa do limiar sozinho: sobe. 1 óbito em 100 casos novos (1%, acima de 0,07%).
    const obito = avaliarPlano(PLANO_MODELO_MS_2025, [agora({ provaveis: 2100, sinaisAlarme: 41, obitosAgravo: 4 })], [], 'NORMALIDADE', desceu);
    expect(obito.sugerido).toBe('EPIDEMIA');
    expect(item(obito, 'epi-letalidade', 'dengue').detalhe).not.toContain('Já atendido');
    // 5 graves em 100 casos novos (5%, acima de 2%).
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [agora({ provaveis: 2100, graves: 15 })], [], 'NORMALIDADE', desceu).sugerido).toBe('EPIDEMIA');

    // Incidência acumulada (limiar de 300 por 100 mil; população de 100 mil): 5 casos novos são 5 por 100 mil.
    const plano: PlanoContingencia = {
      ...PLANO_MODELO_MS_2025,
      criterios: [...PLANO_MODELO_MS_2025.criterios, { id: 'epi-incidencia', estagio: 'EPIDEMIA', agravos: ['dengue'], tipo: 'INCIDENCIA_ACUMULADA', descricao: 'Mais de 300 por 100 mil', limiar: 300 }],
    };
    const comIncidencia = { semanaInicio: '202629', indicadores: [ind('dengue', curva.slice(0, 28), { provaveis: 2000, incidenciaAcumulada: 2000 })] };
    const inc = (provaveis: number) => avaliarPlano(plano, [ind('dengue', curva, { provaveis, incidenciaAcumulada: provaveis })], [], 'NORMALIDADE', comIncidencia);
    expect(inc(2005).sugerido).toBe('NORMALIDADE');
    expect(item(inc(2005), 'epi-incidencia', 'dengue').detalhe).toContain('Já atendido');
    // 301 casos novos por 100 mil: sobe.
    expect(inc(2301).sugerido).toBe('EPIDEMIA');
    // Vira o ano: o acumulado recomeça e o retrato do ano anterior não vale.
    const doAnoPassado = { semanaInicio: '202550', indicadores: [{ ...desceu.indicadores[0]!, semanas: desceu.indicadores[0]!.semanas.map((s) => ({ ...s, semana: `2025${s.semana.slice(4)}` })) }] };
    expect(avaliarPlano(PLANO_MODELO_MS_2025, [agora({ provaveis: 2100, sinaisAlarme: 41 })], [], 'NORMALIDADE', doAnoPassado).sugerido).toBe('EPIDEMIA');
  });

  it('semanas completas: as incompletas contam a semana em curso', () => {
    expect(semanasCompletas('202610', 2)).toEqual({ incompletas: ['202609', '202610'], ultimaCompleta: '202608' });
    expect(semanasCompletas('202602', 2)).toEqual({ incompletas: ['202601', '202602'], ultimaCompleta: '202553' });
    expect(semanasCompletas('202601', 3)).toEqual({ incompletas: ['202552', '202553', '202601'], ultimaCompleta: '202551' });
    // A semana em curso nunca é completa.
    expect(semanasCompletas('202610', 0)).toEqual({ incompletas: ['202610'], ultimaCompleta: '202609' });
  });
});

describe('contingência: conferência da definição do plano (a mesma na API e na tela)', () => {
  const base = PLANO_MODELO_MS_2025;
  const com = (patch: Partial<PlanoContingencia>) => validarPlano({ ...base, ...patch });

  it('o modelo do MS passa', () => {
    expect(validarPlano(base)).toEqual([]);
  });

  it('estágios, critérios, agravos, limiares, ações e desmobilização', () => {
    expect(com({ estagios: [...base.estagios, { chave: 'ALERTA', nome: 'Repetido', ordem: 9 }] })).toContain('Há estágios com a mesma chave.');
    expect(com({ estagios: base.estagios.map((e) => ({ ...e, ordem: e.ordem + 1 })) })).toContain('O primeiro estágio (normalidade) tem ordem 0.');
    expect(com({ estagios: [base.estagios[0]!] })).toContain('O plano tem de 2 a 10 estágios.');
    expect(com({ criterios: [...base.criterios, { ...base.criterios[0]!, id: 'nor-1', estagio: 'NORMALIDADE' }] })).toContain('Critério nor-1: a normalidade não tem critério (é o estado padrão).');
    expect(com({ criterios: [{ ...base.criterios[0]!, estagio: 'INEXISTENTE' }] })).toContain('Critério mob-canal: estágio INEXISTENTE não existe no plano.');
    expect(com({ criterios: [...base.criterios, base.criterios[0]!] })).toContain('Critério mob-canal: identificador repetido.');
    expect(com({ criterios: [{ ...base.criterios[0]!, modo: 'K_DE_N', k: 6, n: 5 }] })).toContain('Critério mob-canal: k não pode ser maior que n.');
    const { semanas: _semanas, ...semSemanas } = base.criterios[0]!;
    expect(com({ criterios: [semSemanas] })).toContain('Critério mob-canal: informe quantas semanas seguidas o critério pede.');
    expect(com({ criterios: [{ ...base.criterios[0]!, agravos: ['febre-amarela'] }] })).toContain('Critério mob-canal: agravo(s) fora do plano (febre-amarela).');
    const graves = base.criterios.find((c) => c.id === 'ale-graves')!;
    expect(com({ criterios: [{ ...graves, limiar: 120 }] })).toContain('Critério ale-graves: o limiar é um percentual (até 100).');
    expect(com({ criterios: [{ ...graves, limiar: undefined }] })).toEqual(['Critério ale-graves: informe o limiar.']);
    expect(com({ criterios: [{ ...graves, limiar: -1 }] })).toContain('Critério ale-graves: o limiar não pode ser negativo.');
    expect(com({ criterios: [{ ...base.criterios[0]!, descricao: 'abc' }] })).toContain('Critério mob-canal: a descrição tem de 5 a 500 caracteres.');
    expect(com({ agravos: ['dengue', 'dengue'] })).toContain('Há agravos repetidos no plano.');
    expect(com({ acoes: [{ estagio: 'NIVEL_9', eixo: 'APS', descricao: 'Ação de outro plano' }] })).toContain('Ação "Ação de outro plano": estágio NIVEL_9 não existe no plano.');
    expect(com({ desmobilizacao: { semanas: 0, descricao: 'ok ok' } })).toContain('Desmobilização: semanas inteiras de 1 a 52.');
    expect(com({ desmobilizacao: { semanas: 4, descricao: ' ' } })).toContain('Desmobilização: a descrição tem de 3 a 1.000 caracteres.');
  });
});
