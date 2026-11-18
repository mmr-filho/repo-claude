import { avaliarPlano, PLANO_MODELO_MS_2025, type AcaoChecklist, type IndicadoresAgravo, type PlanoContingencia, type RespostaManualCriterio, type StatusSemana } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import {
  acoesPorEstagio,
  checklistPorEixo,
  classeDoEstagio,
  comparacaoSugestao,
  criteriosPorEstagio,
  definicaoParaEnvio,
  errosAcionamento,
  exigenciaDoCriterio,
  incluirAcao,
  incluirCriterioManual,
  justificativaSugerida,
  lerNumero,
  manuaisDaSemana,
  novoIdCriterio,
  patchAcao,
  progressoChecklist,
  removerAcao,
  removerCriterio,
  resumoIndicadores,
  situacaoDoCriterio,
  textoSugestao,
  textoValor,
  textoVigencia,
  trocarAcao,
  trocarCriterio,
  ultimasSemanas,
  validarPlano,
} from '../src/components/consolidacao/contingencia-regras';

/*
 * Regras da aba Contingência (web): critérios por estágio com a avaliação da semana, textos dos valores, respostas
 * manuais, checklist por eixo, acionamento e a edição do plano (com a mesma conferência da API).
 */

const MODELO = PLANO_MODELO_MS_2025;

function indicadores(grupo: string, status: StatusSemana[], o: Partial<IndicadoresAgravo> = {}): IndicadoresAgravo {
  return {
    grupo,
    semanas: status.map((s, i) => ({ semana: `2026${String(i + 30).padStart(2, '0')}`, status: s, completa: i < status.length - 2 })),
    provaveis: 1000,
    graves: 5,
    sinaisAlarme: 3,
    obitosAgravo: 0,
    obitosInvestigacao: 0,
    incidenciaAcumulada: 250.456,
    ...o,
  };
}

function acao(id: string, eixo: AcaoChecklist['eixo'], estagio: string, status: AcaoChecklist['status'] = 'PENDENTE'): AcaoChecklist {
  return { id, estagio, eixo, descricao: `Ação ${id}`, status, responsavel: null, nota: null, atualizadoEm: '2026-11-01T12:00:00.000Z', atualizadoPor: null };
}

describe('estágios e sugestão', () => {
  it('pinta os estágios da normalidade (verde) à epidemia (vermelho) e o desconhecido de cinza', () => {
    expect(classeDoEstagio(MODELO, 'NORMALIDADE')).toContain('emerald');
    expect(classeDoEstagio(MODELO, 'MOBILIZACAO')).toContain('yellow');
    expect(classeDoEstagio(MODELO, 'ALERTA')).toContain('orange');
    expect(classeDoEstagio(MODELO, 'EPIDEMIA')).toContain('red');
    expect(classeDoEstagio(MODELO, 'NIVEL_9')).toContain('slate');
    expect(classeDoEstagio(null, 'NORMALIDADE')).toContain('slate');
    const dois: Pick<PlanoContingencia, 'estagios'> = {
      estagios: [
        { chave: 'ROTINA', nome: 'Rotina', ordem: 0 },
        { chave: 'EMERGENCIA', nome: 'Emergência', ordem: 1 },
      ],
    };
    expect(classeDoEstagio(dois, 'ROTINA')).toContain('emerald');
    expect(classeDoEstagio(dois, 'EMERGENCIA')).toContain('red');
  });

  it('compara a sugestão com o estágio em vigor', () => {
    expect(comparacaoSugestao(MODELO, 'NORMALIDADE', 'MOBILIZACAO')).toBe('ACIMA');
    expect(comparacaoSugestao(MODELO, 'ALERTA', 'MOBILIZACAO')).toBe('ABAIXO');
    expect(comparacaoSugestao(MODELO, 'ALERTA', 'ALERTA')).toBe('IGUAL');
    // Estágio de outra versão do plano: não se compara (a API avisa).
    expect(comparacaoSugestao(MODELO, 'NIVEL_2', 'ALERTA')).toBe('IGUAL');
  });

  it('explica a sugestão: acima pede avaliar o acionamento; abaixo traz a desmobilização', () => {
    expect(textoSugestao(MODELO, 'NORMALIDADE', { sugerido: 'MOBILIZACAO', desmobilizacao: { sugerida: false, detalhe: '' } })).toContain('sugerem Mobilização');
    expect(textoSugestao(MODELO, 'ALERTA', { sugerido: 'MOBILIZACAO', desmobilizacao: { sugerida: true, detalhe: 'Pode desmobilizar.' } })).toBe('Os critérios sugerem descer para Mobilização. Pode desmobilizar.');
    expect(textoSugestao(MODELO, 'ALERTA', { sugerido: 'ALERTA', desmobilizacao: { sugerida: false, detalhe: 'Manter Alerta até completar 4.' } })).toBe('Manter Alerta até completar 4.');
    expect(textoSugestao(MODELO, 'ALERTA', { sugerido: 'ALERTA', desmobilizacao: { sugerida: false, detalhe: '' } })).toBe('Os critérios confirmam o estágio em vigor.');
  });
});

describe('critérios', () => {
  it('escreve o valor de cada tipo de critério', () => {
    expect(textoValor('CANAL_ACIMA_CENTRO', 4)).toBe('4 SE');
    expect(textoValor('PERCENTUAL_GRAVES', 1.25)).toBe('1,25%');
    expect(textoValor('LETALIDADE', 0.0549)).toBe('0,055%');
    expect(textoValor('LETALIDADE', 1234.5)).toBe('1.234,5%');
    expect(textoValor('INCIDENCIA_ACUMULADA', 123.456)).toBe('123,46 por 100 mil');
    expect(textoValor('MANUAL', 1)).toBe('—');
    expect(textoValor('LETALIDADE', null)).toBe('—');
    expect(textoValor('LETALIDADE', undefined)).toBe('—');
  });

  it('descreve a exigência do critério', () => {
    const porId = (id: string) => MODELO.criterios.find((c) => c.id === id)!;
    expect(exigenciaDoCriterio(porId('mob-canal'))).toBe('4 SE seguidas');
    expect(exigenciaDoCriterio({ ...porId('mob-canal'), modo: 'K_DE_N', k: 3, n: 5 })).toBe('3 de 5 SE');
    expect(exigenciaDoCriterio(porId('ale-graves'))).toBe('> 1%');
    expect(exigenciaDoCriterio(porId('ale-letalidade'))).toBe('> 0,05%');
    expect(exigenciaDoCriterio(porId('mob-rtpcr'))).toBe('Resposta da vigilância');
    expect(exigenciaDoCriterio({ ...porId('ale-graves'), limiar: undefined })).toBe('Sem limiar');
    expect(exigenciaDoCriterio({ ...porId('ale-graves'), tipo: 'INCIDENCIA_ACUMULADA', limiar: 300, comparador: '>=' })).toBe('>= 300 por 100 mil');
  });

  it('mostra atendido, não atendido e não avaliado (o manual sem resposta nunca é atendido)', () => {
    expect(situacaoDoCriterio(true)).toEqual({ texto: 'Atendido', tom: 'red' });
    expect(situacaoDoCriterio(false)).toEqual({ texto: 'Não atendido', tom: 'green' });
    expect(situacaoDoCriterio(null)).toEqual({ texto: 'Não avaliado', tom: 'slate' });
  });

  it('agrupa os critérios por estágio com a avaliação de cada agravo (a normalidade não tem critério)', () => {
    const dengue = indicadores('dengue', ['ATE_CENTRO', 'ENTRE_CENTRO_E_LS', 'ENTRE_CENTRO_E_LS', 'ACIMA_LS', 'ENTRE_CENTRO_E_LS', 'ACIMA_LS', 'ACIMA_LS']);
    const avaliacao = avaliarPlano(MODELO, [dengue, indicadores('chikungunya', ['ATE_CENTRO', 'ATE_CENTRO', 'ATE_CENTRO']), indicadores('zika', ['ATE_CENTRO'])], [{ criterio: 'mob-rtpcr', atendido: true }], null);
    const grupos = criteriosPorEstagio(MODELO, avaliacao);
    expect(grupos.map((g) => g.estagio.chave)).toEqual(['MOBILIZACAO', 'ALERTA', 'EPIDEMIA']);
    const mob = grupos[0]!;
    expect(mob.itens.map((i) => i.criterio.id)).toEqual(MODELO.criterios.filter((c) => c.estagio === 'MOBILIZACAO').map((c) => c.id));
    const canal = mob.itens.find((i) => i.criterio.id === 'mob-canal')!;
    expect(canal.avaliacoes.map((a) => a.agravo)).toEqual(['dengue', 'chikungunya', 'zika']);
    expect(canal.avaliacoes[0]!.atendido).toBe(true);
    expect(mob.itens.find((i) => i.criterio.id === 'mob-rtpcr')!.avaliacoes).toEqual([expect.objectContaining({ atendido: true })]);
    expect(mob.itens.find((i) => i.criterio.id === 'mob-sorotipo')!.avaliacoes[0]!.atendido).toBeNull();
    expect(mob.atendidos).toBe(avaliacao.porEstagio.MOBILIZACAO);
    // Sem avaliação (sem plano vigente): os critérios aparecem sem resultado.
    expect(criteriosPorEstagio(MODELO, null)[0]!.itens.every((i) => i.avaliacoes.length === 0)).toBe(true);
  });

  it('lista os critérios manuais na ordem dos estágios, com a resposta da semana de referência', () => {
    const respostas: RespostaManualCriterio[] = [
      { semana: '202644', criterio: 'ale-zdc', atendido: true, nota: 'Lacen', respondidoPor: 'Vera', respondidoEm: '2026-11-09T12:00:00.000Z' },
      { semana: '202643', criterio: 'mob-rtpcr', atendido: true, nota: null, respondidoPor: 'Vera', respondidoEm: '2026-11-02T12:00:00.000Z' },
    ];
    const lista = manuaisDaSemana(MODELO, respostas, '202644');
    expect(lista.every((m) => m.criterio.tipo === 'MANUAL')).toBe(true);
    expect(lista.map((m) => m.estagio?.chave)).toEqual([...lista.map((m) => m.estagio?.chave)].sort((a, b) => ['MOBILIZACAO', 'ALERTA', 'EPIDEMIA'].indexOf(a!) - ['MOBILIZACAO', 'ALERTA', 'EPIDEMIA'].indexOf(b!)));
    expect(lista.find((m) => m.criterio.id === 'ale-zdc')!.resposta?.nota).toBe('Lacen');
    // A resposta de outra semana não vale.
    expect(lista.find((m) => m.criterio.id === 'mob-rtpcr')!.resposta).toBeNull();
  });
});

describe('indicadores e acionamento', () => {
  it('resume os números do ano e as últimas semanas no canal', () => {
    const ind = indicadores('dengue', ['ATE_CENTRO', 'ACIMA_LS', 'SEM_CANAL'], { incidenciaAcumulada: null, provaveis: 1234 });
    expect(resumoIndicadores(ind)).toContainEqual({ rotulo: 'Casos prováveis', valor: '1.234' });
    expect(resumoIndicadores(ind)).toContainEqual({ rotulo: 'Incidência acumulada', valor: 'sem população' });
    expect(resumoIndicadores(indicadores('dengue', []))).toContainEqual({ rotulo: 'Incidência acumulada', valor: '250,46 por 100 mil' });
    expect(ultimasSemanas(ind, 2).map((s) => [s.rotulo, s.status])).toEqual([
      ['31/2026', 'ACIMA_LS'],
      ['32/2026', 'SEM_CANAL'],
    ]);
  });

  it('exige estágio e justificativa de 20 caracteres para acionar', () => {
    expect(errosAcionamento({ estagio: '', justificativa: 'curta', ato: '' })).toEqual(['Escolha o estágio.', 'Escreva a justificativa com pelo menos 20 caracteres (faltam 15).']);
    expect(errosAcionamento({ estagio: 'ALERTA', justificativa: '   Curva acima do LS há 4 SE   ', ato: 'Portaria SMS 12/2026' })).toEqual([]);
    expect(errosAcionamento({ estagio: 'ALERTA', justificativa: 'x'.repeat(20), ato: 'a'.repeat(301) })).toEqual(['O ato tem até 300 caracteres.']);
  });

  it('propõe a justificativa com os critérios atendidos do estágio', () => {
    const avaliacao = { criterios: [{ id: 'mob-canal', estagio: 'MOBILIZACAO', agravo: 'dengue', atendido: true, valor: 4, detalhe: '' }] };
    expect(justificativaSugerida(MODELO, avaliacao, 'MOBILIZACAO', '202644')).toBe(`Critérios atendidos na SE 44/2026: ${MODELO.criterios[0]!.descricao}.`);
    expect(justificativaSugerida(MODELO, avaliacao, 'ALERTA', '202644')).toBe('');
    expect(justificativaSugerida(MODELO, null, 'ALERTA', '202644')).toBe('');
  });
});

describe('checklist', () => {
  const lista = [
    acao('1', 'VIGILANCIA', 'ALERTA', 'FEITA'),
    acao('2', 'GESTAO', 'MOBILIZACAO', 'EM_ANDAMENTO'),
    acao('3', 'VIGILANCIA', 'MOBILIZACAO', 'PENDENTE'),
    acao('4', 'COMUNICACAO', 'NORMALIDADE', 'NAO_SE_APLICA'),
    acao('5', 'VIGILANCIA', 'NORMALIDADE', 'FEITA'),
  ];

  it('agrupa por eixo (na ordem dos eixos) e, no eixo, pela ordem dos estágios', () => {
    const grupos = checklistPorEixo(lista, MODELO);
    expect(grupos.map((g) => g.eixo)).toEqual(['GESTAO', 'VIGILANCIA', 'COMUNICACAO']);
    expect(grupos[1]!.acoes.map((a) => a.id)).toEqual(['5', '3', '1']);
    expect(grupos[1]).toMatchObject({ rotulo: 'Vigilância epidemiológica', feitas: 2, total: 3 });
    // A ação que não se aplica não conta no total.
    expect(grupos[2]).toMatchObject({ feitas: 0, total: 0 });
  });

  it('conta o progresso do checklist inteiro', () => {
    expect(progressoChecklist(lista)).toEqual({ feitas: 2, emAndamento: 1, pendentes: 1, total: 4 });
  });

  it('manda só o que mudou na ação (texto vazio apaga)', () => {
    const a = { ...acao('9', 'APS', 'ALERTA'), responsavel: 'Coord. APS', nota: 'Escala' };
    expect(patchAcao(a, { status: 'PENDENTE', responsavel: ' Coord. APS ', nota: 'Escala' })).toBeNull();
    expect(patchAcao(a, { status: 'FEITA', responsavel: 'Coord. APS', nota: '' })).toEqual({ status: 'FEITA', nota: null });
    expect(patchAcao({ ...a, responsavel: null }, { status: 'PENDENTE', responsavel: 'Ana', nota: 'Escala' })).toEqual({ responsavel: 'Ana' });
  });
});

describe('plano', () => {
  it('escreve a vigência do plano', () => {
    expect(textoVigencia({ status: 'VIGENTE', vigenteDesde: '2026-01-04', vigenteAte: null })).toBe('Em vigor desde 04/01/2026');
    expect(textoVigencia({ status: 'ARQUIVADO', vigenteDesde: '2025-01-05', vigenteAte: '2026-01-03' })).toBe('Vigorou de 05/01/2025 a 03/01/2026');
    expect(textoVigencia({ status: 'ARQUIVADO', vigenteDesde: null, vigenteAte: null })).toBe('Arquivado sem ter vigorado');
    expect(textoVigencia({ status: 'RASCUNHO', vigenteDesde: null, vigenteAte: null })).toBe('Rascunho: ainda não vigorou');
  });

  it('o modelo do MS passa na conferência e não muda ao ser preparado para envio', () => {
    expect(validarPlano(MODELO)).toEqual([]);
    expect(definicaoParaEnvio(MODELO)).toEqual(MODELO);
  });

  it('edita limiar e semanas sem tocar nos outros critérios', () => {
    let d = trocarCriterio(MODELO, 'ale-graves', { limiar: 1.5, comparador: '>=' });
    d = trocarCriterio(d, 'mob-canal', { modo: 'K_DE_N', k: 3, n: 5 });
    expect(d.criterios.find((c) => c.id === 'ale-graves')).toMatchObject({ limiar: 1.5, comparador: '>=' });
    expect(d.criterios.find((c) => c.id === 'mob-canal')).toMatchObject({ modo: 'K_DE_N', k: 3, n: 5, semanas: 4 });
    expect(validarPlano(d)).toEqual([]);
    // undefined tira o campo da definição.
    const sem = trocarCriterio(d, 'ale-graves', { limiar: undefined });
    expect('limiar' in sem.criterios.find((c) => c.id === 'ale-graves')!).toBe(false);
    expect(validarPlano(sem)).toEqual(['Critério ale-graves: informe o limiar.']);
    expect(MODELO.criterios.find((c) => c.id === 'ale-graves')!.limiar).toBe(1);
  });

  it('inclui e remove critérios manuais com identificador único', () => {
    expect(novoIdCriterio(MODELO, 'MOBILIZACAO')).toBe('mob-manual-1');
    let d = incluirCriterioManual(MODELO, 'MOBILIZACAO', '  Ocupação de leitos acima de 80%  ');
    d = incluirCriterioManual(d, 'MOBILIZACAO', 'Aumento de atendimentos nas UPAs');
    const novos = d.criterios.filter((c) => c.id.startsWith('mob-manual'));
    expect(novos.map((c) => [c.id, c.tipo, c.descricao])).toEqual([
      ['mob-manual-1', 'MANUAL', 'Ocupação de leitos acima de 80%'],
      ['mob-manual-2', 'MANUAL', 'Aumento de atendimentos nas UPAs'],
    ]);
    expect(validarPlano(d)).toEqual([]);
    expect(removerCriterio(d, 'mob-manual-1').criterios.some((c) => c.id === 'mob-manual-1')).toBe(false);
  });

  it('edita, inclui e remove ações e as agrupa por estágio e eixo com o índice', () => {
    const d0: PlanoContingencia = { ...MODELO, acoes: MODELO.acoes.slice(0, 3) };
    let d = incluirAcao(d0, { estagio: 'ALERTA', eixo: 'APS', descricao: '  Abrir sala de hidratação  ' });
    d = trocarAcao(d, 0, { descricao: 'Revisar o plano municipal' });
    expect(d.acoes[0]!.descricao).toBe('Revisar o plano municipal');
    expect(d.acoes[3]).toEqual({ estagio: 'ALERTA', eixo: 'APS', descricao: 'Abrir sala de hidratação' });
    const alerta = acoesPorEstagio(d).find((g) => g.estagio.chave === 'ALERTA')!;
    expect(alerta.eixos).toEqual([{ eixo: 'APS', rotulo: 'Atenção primária', acoes: [{ indice: 3, acao: d.acoes[3] }] }]);
    expect(removerAcao(d, 3).acoes).toHaveLength(3);
  });

  it('confere a definição como a API', () => {
    const base = MODELO;
    const com = (patch: Partial<PlanoContingencia>) => validarPlano({ ...base, ...patch });
    expect(com({ estagios: [...base.estagios, { chave: 'ALERTA', nome: 'Repetido', ordem: 9 }] })).toContain('Há estágios com a mesma chave.');
    expect(com({ estagios: base.estagios.map((e) => ({ ...e, ordem: e.ordem + 1 })) })).toContain('O primeiro estágio (normalidade) tem ordem 0.');
    expect(com({ criterios: [...base.criterios, { ...base.criterios[0]!, id: 'nor-1', estagio: 'NORMALIDADE' }] })).toContain('Critério nor-1: a normalidade não tem critério (é o estado padrão).');
    expect(com({ criterios: [...base.criterios, base.criterios[0]!] })).toContain('Critério mob-canal: identificador repetido.');
    expect(com({ criterios: [{ ...base.criterios[0]!, modo: 'K_DE_N', k: 6, n: 5 }] })).toContain('Critério mob-canal: k não pode ser maior que n.');
    expect(com({ criterios: [{ ...base.criterios[0]!, agravos: ['febre-amarela'] }] })).toContain('Critério mob-canal: agravo(s) fora do plano (febre-amarela).');
    expect(com({ criterios: [{ ...base.criterios.find((c) => c.id === 'ale-graves')!, limiar: 120 }] })).toContain('Critério ale-graves: o limiar é um percentual (até 100).');
    expect(com({ criterios: [{ ...base.criterios[0]!, descricao: 'abc' }] })).toContain('Critério mob-canal: a descrição tem de 5 a 500 caracteres.');
    expect(com({ acoes: [{ estagio: 'NIVEL_9', eixo: 'APS', descricao: 'Ação de outro plano' }] })).toContain('Ação "Ação de outro plano": estágio NIVEL_9 não existe no plano.');
    expect(com({ desmobilizacao: { semanas: 0, descricao: 'ok ok' } })).toContain('Desmobilização: semanas inteiras de 1 a 52.');
  });

  it('prepara o envio: textos aparados e só os campos do tipo do critério', () => {
    const d = trocarCriterio(trocarCriterio(MODELO, 'ale-graves', { semanas: 4, descricao: '  Graves acima de 1%  ' }), 'mob-canal', { limiar: 3 });
    const envio = definicaoParaEnvio(d);
    expect(envio.criterios.find((c) => c.id === 'ale-graves')).not.toHaveProperty('semanas');
    expect(envio.criterios.find((c) => c.id === 'ale-graves')!.descricao).toBe('Graves acima de 1%');
    expect(envio.criterios.find((c) => c.id === 'mob-canal')).not.toHaveProperty('limiar');
  });

  it('lê número com vírgula ou ponto', () => {
    expect(lerNumero('1,5')).toBe(1.5);
    expect(lerNumero(' 0.07 ')).toBe(0.07);
    expect(lerNumero('')).toBeUndefined();
    expect(lerNumero('abc')).toBeUndefined();
  });
});
