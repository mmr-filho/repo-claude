import { describe, expect, it } from 'vitest';
import {
  alcanceDasRegras,
  CAMPOS_DTA,
  CRITERIO_CASO_SURTO,
  DELIMITACAO_SURTO,
  detectarAglomerados,
  errosDta,
  GRUPOS_SEM_SUGESTAO_DE_SURTO,
  grupoNoAlcance,
  idadeValida,
  LOCAL_INICIAL_SURTO,
  MODO_TRANSMISSAO,
  normalizarIdade,
  REGRAS_SURTO_PADRAO,
  SINDROMES_SURTO,
  UNIDADES_IDADE_CASO,
  validarSurto,
  VEICULO_TRANSMISSAO,
  type CasoParaSurto,
  type DadosSurtoValidacao,
  type OpcoesDeteccaoSurto,
} from '@omnisaude/shared';

/** Notificação de surto (VIG-1c, §3.5 do desenho): domínios da ficha, sugestões de aglomerado e validação por etapa. */
let seq = 0;
function caso(grupo: string, inicioSintomas: string | null, extra: Partial<CasoParaSurto> = {}): CasoParaSurto {
  seq++;
  return {
    id: `n${seq}`,
    numero: `2026/${String(seq).padStart(5, '0')}`,
    grupo,
    conhecidoEm: `${inicioSintomas ?? '2026-11-01'}T15:00:00.000Z`,
    inicioSintomas,
    blockId: null,
    neighborhoodId: null,
    unitId: 'ubs-centro',
    unidadeHospitalar: false,
    jaEmSurto: false,
    ...extra,
  };
}
// O fuso entrou nas opções (sur-9): o dia em que o caso sem início dos sintomas foi conhecido é o dia local.
const OPCOES: OpcoesDeteccaoSurto = { hoje: '2026-11-10', fuso: 'America/Sao_Paulo', dispensas: [], diasInusitado: 365, historicoPorGrupo: {} };
const detecta = (casos: CasoParaSurto[], opcoes: Partial<OpcoesDeteccaoSurto> = {}) => detectarAglomerados(casos, REGRAS_SURTO_PADRAO, { ...OPCOES, ...opcoes });
const doQuarteirao = (extra: Partial<CasoParaSurto> = {}) => ({ blockId: 'q1', neighborhoodId: 'b1', ...extra });

describe('surto: domínios da ficha e regras padrão', () => {
  it('categorias da ficha de notificação e de investigação', () => {
    expect(Object.keys(LOCAL_INICIAL_SURTO)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
    expect(DELIMITACAO_SURTO).toEqual(LOCAL_INICIAL_SURTO);
    expect(MODO_TRANSMISSAO).toEqual({ '1': 'Direta', '2': 'Indireta', '9': 'Ignorado' });
    expect(Object.keys(VEICULO_TRANSMISSAO)).toEqual(['1', '2', '3', '4', '5', '6', '9']);
    expect(Object.keys(SINDROMES_SURTO)).toHaveLength(7);
    expect(Object.keys(CRITERIO_CASO_SURTO)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('quatro regras com fonte: quarteirão, bairro, varicela hospitalar e síndrome gripal na unidade', () => {
    expect(REGRAS_SURTO_PADRAO.map((r) => [r.id, r.vinculo, r.minimo, r.janelaDias])).toEqual([
      ['quarteirao-7d', 'QUARTEIRAO', 2, 7],
      ['bairro-7d', 'BAIRRO', 2, 7],
      ['varicela-hospitalar', 'UNIDADE', 1, 21],
      ['sindrome-gripal-unidade-7d', 'UNIDADE', 3, 7],
    ]);
    for (const r of REGRAS_SURTO_PADRAO) expect(r.fonte).toMatch(/p\. \d/);
    expect(REGRAS_SURTO_PADRAO[0]!.excetoGrupos).toEqual(expect.arrayContaining(['dengue', 'chikungunya', 'zika', 'violencia']));
    expect(REGRAS_SURTO_PADRAO[2]).toMatchObject({ grupos: ['varicela'], soUnidadeHospitalar: true });
  });
});

describe('surto: sugestões de aglomerado', () => {
  it('dois casos do mesmo agravo no mesmo quarteirão em 7 dias (e no mesmo bairro)', () => {
    const a = caso('hepatites-virais', '2026-11-02', doQuarteirao());
    const b = caso('hepatites-virais', '2026-11-08', doQuarteirao());
    const s = detecta([a, b]);
    expect(s.map((x) => x.assinatura)).toEqual(['bairro-7d|BAIRRO:b1|hepatites-virais', 'quarteirao-7d|QUARTEIRAO:q1|hepatites-virais']);
    expect(s[1]).toMatchObject({
      regra: 'quarteirao-7d',
      grupo: 'hepatites-virais',
      vinculo: { tipo: 'QUARTEIRAO', id: 'q1' },
      casos: [a.id, b.id],
      primeiroSintoma: '2026-11-02',
      ultimoConhecimento: b.conhecidoEm,
    });
    // Quarteirões diferentes do mesmo bairro: só a regra do bairro.
    expect(detecta([a, caso('hepatites-virais', '2026-11-05', doQuarteirao({ blockId: 'q2' }))]).map((x) => x.regra)).toEqual(['bairro-7d']);
  });

  it('fora da janela, outro agravo, arboviroses e violência não viram sugestão', () => {
    expect(detecta([caso('leptospirose', '2026-10-20', doQuarteirao()), caso('leptospirose', '2026-10-28', doQuarteirao())])).toEqual([]);
    expect(detecta([caso('leptospirose', '2026-11-02', doQuarteirao()), caso('coqueluche', '2026-11-03', doQuarteirao())])).toEqual([]);
    expect(detecta([caso('dengue', '2026-11-02', doQuarteirao()), caso('dengue', '2026-11-03', doQuarteirao())])).toEqual([]);
    expect(detecta([caso('violencia', '2026-11-02', doQuarteirao()), caso('violencia', '2026-11-03', doQuarteirao())])).toEqual([]);
    expect(GRUPOS_SEM_SUGESTAO_DE_SURTO).toContain('tuberculose');
    // Sem início dos sintomas, vale a data em que o caso foi conhecido.
    const semData = caso('leptospirose', null, { ...doQuarteirao(), conhecidoEm: '2026-11-06T12:00:00.000Z' });
    expect(detecta([caso('leptospirose', '2026-11-02', doQuarteirao()), semData]).map((x) => x.regra)).toEqual(['bairro-7d', 'quarteirao-7d']);
  });

  it('casos em cadeia formam um aglomerado só; de dois aglomerados, vale o mais recente', () => {
    const cadeia = ['2026-10-14', '2026-10-18', '2026-10-24', '2026-10-30'].map((d) => caso('hepatites-virais', d, doQuarteirao({ neighborhoodId: null })));
    expect(detecta(cadeia)[0]!.casos).toEqual(cadeia.map((c) => c.id));
    const antigo = ['2026-10-12', '2026-10-13'].map((d) => caso('hepatites-virais', d, doQuarteirao({ neighborhoodId: null })));
    const recente = ['2026-11-01', '2026-11-04'].map((d) => caso('hepatites-virais', d, doQuarteirao({ neighborhoodId: null })));
    const s = detecta([...antigo, ...recente]);
    expect(s).toHaveLength(1);
    expect(s[0]!.casos).toEqual(recente.map((c) => c.id));
  });

  it('varicela em unidade hospitalar: um caso basta', () => {
    const h = caso('varicela', '2026-11-05', { unitId: 'hospital', unidadeHospitalar: true });
    expect(detecta([h])).toMatchObject([{ assinatura: 'varicela-hospitalar|UNIDADE:hospital|varicela', casos: [h.id] }]);
    expect(detecta([caso('varicela', '2026-11-05', { unitId: 'ubs-centro' })])).toEqual([]);
  });

  it('síndrome gripal (covid): 3 casos na mesma unidade com até 7 dias entre os inícios', () => {
    const tres = ['2026-11-01', '2026-11-04', '2026-11-08'].map((d) => caso('covid', d, { unitId: 'upa' }));
    expect(detecta(tres).map((s) => s.assinatura)).toEqual(['sindrome-gripal-unidade-7d|UNIDADE:upa|covid']);
    expect(detecta(tres.slice(0, 2))).toEqual([]);
    // Em cadeia, mas sem 3 casos numa mesma janela de 7 dias.
    const espalhados = ['2026-10-25', '2026-10-31', '2026-11-06'].map((d) => caso('covid', d, { unitId: 'upa' }));
    expect(detecta(espalhados)).toEqual([]);
  });

  it('casos já em surto aberto e casos com data futura não entram', () => {
    const a = caso('hepatites-virais', '2026-11-02', doQuarteirao({ neighborhoodId: null }));
    expect(detecta([a, caso('hepatites-virais', '2026-11-03', doQuarteirao({ neighborhoodId: null, jaEmSurto: true }))])).toEqual([]);
    expect(detecta([a, caso('hepatites-virais', '2026-11-12', doQuarteirao({ neighborhoodId: null }))])).toEqual([]);
  });

  it('sugestão dispensada some enquanto não chega caso conhecido depois da dispensa', () => {
    const a = caso('hepatites-virais', '2026-11-02', doQuarteirao({ neighborhoodId: null }));
    const b = caso('hepatites-virais', '2026-11-04', doQuarteirao({ neighborhoodId: null }));
    const assinatura = 'quarteirao-7d|QUARTEIRAO:q1|hepatites-virais';
    const dispensas = [{ assinatura, ateConhecimento: '2026-11-05T00:00:00.000Z' }];
    expect(detecta([a, b], { dispensas })).toEqual([]);
    // Outra assinatura não é afetada.
    expect(detecta([a, b], { dispensas: [{ assinatura: 'outra', ateConhecimento: '2026-11-05T00:00:00.000Z' }] })).toHaveLength(1);
    const c = caso('hepatites-virais', '2026-11-06', doQuarteirao({ neighborhoodId: null }));
    expect(detecta([a, b, c], { dispensas })).toMatchObject([{ assinatura, casos: [a.id, b.id, c.id] }]);
  });

  it('evento inusitado: primeiro caso depois de diasInusitado sem casos, ou nunca visto', () => {
    const fa = caso('febre-amarela', '2026-11-03');
    expect(detecta([fa], { historicoPorGrupo: { 'febre-amarela': null } })).toMatchObject([
      { assinatura: 'inusitado|MUNICIPIO:municipio|febre-amarela', regra: 'inusitado', vinculo: { tipo: 'MUNICIPIO', id: 'municipio' }, casos: [fa.id] },
    ]);
    expect(detecta([fa], { historicoPorGrupo: { 'febre-amarela': '2025-10-01' } })).toHaveLength(1);
    expect(detecta([fa], { historicoPorGrupo: { 'febre-amarela': '2025-11-03' } })).toEqual([]);
    expect(detecta([fa], { historicoPorGrupo: { 'febre-amarela': '2026-08-01' } })).toEqual([]);
    // Grupo fora do histórico não é avaliado; violência nunca é evento inusitado.
    expect(detecta([fa])).toEqual([]);
    expect(detecta([caso('violencia', '2026-11-03')], { historicoPorGrupo: { violencia: null } })).toEqual([]);
  });

  it('ordem: a sugestão com o caso conhecido mais recente primeiro', () => {
    const v = caso('varicela', '2026-11-08', { unitId: 'hospital', unidadeHospitalar: true });
    const h = [caso('hepatites-virais', '2026-11-01', doQuarteirao({ neighborhoodId: null })), caso('hepatites-virais', '2026-11-03', doQuarteirao({ neighborhoodId: null }))];
    expect(detecta([...h, v]).map((s) => s.regra)).toEqual(['varicela-hospitalar', 'quarteirao-7d']);
  });
});

describe('surto: correções da revisão (sur-1, sur-4, sur-9, SURTO-2)', () => {
  it('sur-9: o caso sem início dos sintomas conhecido à noite (horário de Brasília) conta no dia local, não no dia UTC', () => {
    const manha = caso('leptospirose', null, { ...doQuarteirao(), conhecidoEm: '2026-11-10T12:00:00.000Z' });
    // 21h30 de 10/11 em Brasília = 00h30 de 11/11 em UTC: antes, ficava "depois de hoje" e saía das regras.
    const noite = caso('leptospirose', null, { ...doQuarteirao(), conhecidoEm: '2026-11-11T00:30:00.000Z' });
    const s = detecta([manha, noite]);
    expect(s.map((x) => x.assinatura)).toEqual(['bairro-7d|BAIRRO:b1|leptospirose', 'quarteirao-7d|QUARTEIRAO:q1|leptospirose']);
    expect(s[1]!.casos).toEqual([manha.id, noite.id]);
    // Em outro fuso (Manaus, UTC-4), 00h30 UTC de 11/11 também é 10/11; em UTC, seria 11/11 e ficaria de fora.
    expect(detecta([manha, noite], { fuso: 'America/Manaus' })).toHaveLength(2);
    expect(detecta([manha, noite], { fuso: 'UTC' })).toEqual([]);
    // A janela também usa o dia local: 7 dias de 03/11 (local) a 10/11 (local, 21h30).
    const antigo = caso('leptospirose', null, { ...doQuarteirao({ neighborhoodId: null }), conhecidoEm: '2026-11-03T15:00:00.000Z' });
    const ultimo = caso('leptospirose', null, { ...doQuarteirao({ neighborhoodId: null }), conhecidoEm: '2026-11-11T00:30:00.000Z' });
    expect(detecta([antigo, ultimo]).map((x) => x.casos)).toEqual([[antigo.id, ultimo.id]]);
  });

  it('sur-4: o caso já ligado a surto é caso anterior no evento inusitado; o seguinte não vira "primeiro caso"', () => {
    const c1 = caso('colera', '2026-11-04', { jaEmSurto: true });
    const c2 = caso('colera', '2026-11-10');
    // Antes: o c1 sumia das duas listas e o c2 virava "Primeiro caso do agravo registrado no município".
    expect(detecta([c1, c2], { historicoPorGrupo: { colera: null } })).toEqual([]);
    // Sem o c1 no surto, os dois formam a sugestão; o já ligado nunca entra na lista de casos da sugestão.
    expect(detecta([{ ...c1, jaEmSurto: false }, c2], { historicoPorGrupo: { colera: null } })).toMatchObject([{ regra: 'inusitado', casos: [c1.id, c2.id] }]);
    const depois = caso('colera', '2026-11-08', { jaEmSurto: true });
    expect(detecta([c2, { ...depois, inicioSintomas: '2026-11-03' }], { historicoPorGrupo: { colera: null } })).toEqual([]);
    // O caso com início antes do caso em surto também não é o "primeiro" (r3: antes, virava "Primeiro caso do agravo
    // registrado no município", a variante do sur-4).
    expect(detecta([caso('colera', '2026-11-02'), depois], { historicoPorGrupo: { colera: null } })).toEqual([]);
    // Caso que quem lê não vê (de outra unidade, na visão do núcleo) também é caso anterior.
    expect(detecta([c2], { historicoPorGrupo: { colera: null }, outrosCasosPorGrupo: { colera: ['2026-11-05'] } })).toEqual([]);
    expect(detecta([c2], { historicoPorGrupo: { colera: null }, outrosCasosPorGrupo: { colera: ['2026-11-12'] } })).toHaveLength(1);
    // Histórico antigo com outro caso depois dele, ainda há muito tempo: continua inusitado, com a frase do intervalo.
    expect(detecta([c2], { historicoPorGrupo: { colera: '2024-01-10' }, outrosCasosPorGrupo: { colera: ['2025-01-10'] } })).toMatchObject([
      { regra: 'inusitado', descricao: 'Primeiro caso do agravo depois de 365 dias sem casos: evento inusitado' },
    ]);
  });

  it('sur-4 (r3): o caso índice achado pela busca ativa, com início antes do caso já em surto, não reabre o "primeiro caso"', () => {
    // c1 entrou no surto (início em 03/11); a busca ativa achou depois o c0 (início em 01/11), e chegou o c2 (09/11).
    const c1 = caso('colera', '2026-11-03', { jaEmSurto: true, conhecidoEm: '2026-11-04T12:00:00.000Z' });
    const c0 = caso('colera', '2026-11-01', { conhecidoEm: '2026-11-10T12:00:00.000Z' });
    const c2 = caso('colera', '2026-11-09', { conhecidoEm: '2026-11-10T13:00:00.000Z' });
    // Antes: a sugestão "Primeiro caso do agravo registrado no município" voltava com [c0, c2].
    expect(detecta([c1, c0, c2], { historicoPorGrupo: { colera: null } })).toEqual([]);
    expect(detecta([c1, c0, c2], { historicoPorGrupo: { colera: '2024-01-10' } })).toEqual([]);
    // Na visão do núcleo, o caso em surto é de outra unidade (não aparece nos casos): vale o mesmo, por `outrosEmSurto`.
    expect(detecta([c0, c2], { historicoPorGrupo: { colera: null }, outrosCasosPorGrupo: { colera: ['2026-11-03'] }, outrosEmSurto: ['colera'] })).toEqual([]);
    // Sem caso em surto, o c0 é o primeiro e a sugestão traz os dois casos; o caso em surto de outro grupo não muda nada.
    expect(detecta([c0, c2], { historicoPorGrupo: { colera: null }, outrosCasosPorGrupo: { colera: ['2026-11-03'] }, outrosEmSurto: ['difteria'] })).toMatchObject([
      { regra: 'inusitado', casos: [c0.id, c2.id], descricao: 'Primeiro caso do agravo registrado no município: evento inusitado' },
    ]);
    // O caso em surto com início muito antes (notificado com atraso) também tira o grupo do evento inusitado.
    const antigoEmSurto = caso('colera', '2025-06-01', { jaEmSurto: true, conhecidoEm: '2026-10-20T12:00:00.000Z' });
    expect(detecta([antigoEmSurto, c2], { historicoPorGrupo: { colera: null } })).toEqual([]);
    expect(detecta([{ ...antigoEmSurto, jaEmSurto: false }, c2], { historicoPorGrupo: { colera: null } })).toMatchObject([{ regra: 'inusitado', casos: [antigoEmSurto.id, c2.id] }]);
  });

  it('SURTO-2: alcance das regras de vizinhança, calculado das regras em vigor', () => {
    const padrao = alcanceDasRegras(REGRAS_SURTO_PADRAO);
    expect(padrao).toEqual({ todos: true, exceto: [...new Set(['dengue', 'chikungunya', 'zika', ...GRUPOS_SEM_SUGESTAO_DE_SURTO])].sort() });
    for (const g of ['esquistossomose', 'leptospirose', 'varicela', 'covid', 'colera']) expect(grupoNoAlcance(padrao, g), g).toBe(true);
    for (const g of ['dengue', 'chikungunya', 'zika', 'violencia', 'tuberculose']) expect(grupoNoAlcance(padrao, g), g).toBe(false);
    // Regra da instituição que olha a dengue no quarteirão: a dengue entra no alcance.
    const comDengue = alcanceDasRegras([...REGRAS_SURTO_PADRAO, { ...REGRAS_SURTO_PADRAO[0]!, id: 'dengue-quarteirao', grupos: ['dengue'], excetoGrupos: undefined, minimo: 5 }]);
    expect(grupoNoAlcance(comDengue, 'dengue')).toBe(true);
    expect(grupoNoAlcance(comDengue, 'zika')).toBe(false);
    // Sem regra para qualquer grupo: só os grupos citados (menos os excetuados).
    const so = alcanceDasRegras([{ ...REGRAS_SURTO_PADRAO[2]!, grupos: ['varicela', 'caxumba'], excetoGrupos: ['caxumba'] }, { ...REGRAS_SURTO_PADRAO[3]! }]);
    expect(so).toEqual({ todos: false, grupos: ['covid', 'varicela'] });
    expect(grupoNoAlcance(so, 'caxumba')).toBe(false);
    expect(alcanceDasRegras([])).toEqual({ todos: false, grupos: [] });
    // O alcance é o mesmo das regras: o grupo fora dele nunca vira sugestão de vizinhança, só evento inusitado.
    const dengue = [caso('dengue', '2026-11-02', doQuarteirao()), caso('dengue', '2026-11-03', doQuarteirao())];
    expect(detecta(dengue)).toEqual([]);
    expect(detectarAglomerados(dengue, [{ ...REGRAS_SURTO_PADRAO[0]!, grupos: ['dengue'], excetoGrupos: undefined }], OPCOES).map((s) => s.regra)).toEqual(['quarteirao-7d']);
  });

  it('sur-1: a dispensa do núcleo só esconde sugestão com todos os casos da unidade dele; a municipal vale para todos', () => {
    const h1 = caso('hepatites-virais', '2026-11-02', doQuarteirao({ neighborhoodId: null, unitId: 'hospital' }));
    const u1 = caso('hepatites-virais', '2026-11-03', doQuarteirao({ neighborhoodId: null, unitId: 'ubs' }));
    const h2 = caso('hepatites-virais', '2026-11-04', doQuarteirao({ neighborhoodId: null, unitId: 'hospital' }));
    const assinatura = 'quarteirao-7d|QUARTEIRAO:q1|hepatites-virais';
    const ate = '2026-11-05T00:00:00.000Z';
    // Visão municipal com a dispensa do núcleo do hospital: o caso da UBS mantém a sugestão (antes, sumia).
    expect(detecta([h1, u1, h2], { dispensas: [{ assinatura, ateConhecimento: ate, unitId: 'hospital' }] })).toMatchObject([{ assinatura, casos: [h1.id, u1.id, h2.id] }]);
    // Na visão do núcleo (só os casos dele), a dispensa dele vale.
    expect(detecta([h1, h2], { dispensas: [{ assinatura, ateConhecimento: ate, unitId: 'hospital' }] })).toEqual([]);
    // A de outra unidade não vale; a municipal (unidade nula) vale para todos.
    expect(detecta([h1, h2], { dispensas: [{ assinatura, ateConhecimento: ate, unitId: 'ubs' }] })).toHaveLength(1);
    expect(detecta([h1, u1, h2], { dispensas: [{ assinatura, ateConhecimento: ate, unitId: null }] })).toEqual([]);
    expect(detecta([h1, h2], { dispensas: [{ assinatura, ateConhecimento: ate }] })).toEqual([]);
  });
});

describe('surto: regras da planilha e do bloco DTA no shared (K8)', () => {
  it('idade: número e unidade do Sinan, dentro do máximo da unidade (a regra da API e da tela)', () => {
    for (const [texto, canon] of [
      ['34', '34A'],
      ['34 anos', '34A'],
      ['34A', '34A'],
      ['1 ano', '1A'],
      ['5 meses', '5M'],
      ['5m', '5M'],
      ['11 mês', '11M'],
      ['10 dias', '10D'],
      ['12 horas', '12H'],
      ['12h', '12H'],
    ])
      expect([texto, normalizarIdade(texto!)]).toEqual([texto, canon]);
    for (const ruim of ['', 'abc', '13 meses', '32 dias', '24 horas', '131', '3 semanas', 'sete anos']) {
      expect(normalizarIdade(ruim), ruim).toBeNull();
      expect(idadeValida(ruim), ruim).toBe(false);
    }
    expect(idadeValida('5 meses')).toBe(true);
    expect(Object.fromEntries(Object.entries(UNIDADES_IDADE_CASO).map(([k, v]) => [k, v.codigo]))).toEqual({ H: '1', D: '2', M: '3', A: '4' });
  });

  it('bloco DTA: as 11 variáveis conhecidas e a conferência de número, data e critério', () => {
    expect(CAMPOS_DTA.map((c) => c.variavel)).toEqual(['NU_ENTR', 'NU_ENT_DOE', 'NU_TOT', 'NU_TOT_HOS', 'NU_OBITO', 'TP_PRO_PRE', 'ST_ALIMEN', 'DS_ETIOLOG', 'DS_ALICAUS', 'CRITERIO', 'DT_ENCERRA']);
    expect(CAMPOS_DTA.find((c) => c.variavel === 'DT_ENCERRA')).toMatchObject({ tipo: 'data', rotulo: 'Data de encerramento (DTA)' });
    const hoje = '2026-11-10';
    expect(errosDta({ NU_ENTR: 40, NU_ENT_DOE: '12', DS_ALICAUS: 'Salada de maionese', CRITERIO: '4', DT_ENCERRA: '2026-11-10', OUTRA_VAR: 'livre', NU_TOT: null, NU_OBITO: '' }, hoje)).toEqual([]);
    expect(errosDta({ NU_ENTR: 'quarenta', NU_TOT: 2.5, NU_OBITO: -1, NU_TOT_HOS: '12a' }, hoje)).toEqual([
      'DTA, Nº de entrevistados: número inteiro.',
      'DTA, Total de doentes: número inteiro.',
      'DTA, Nº de hospitalizados: número inteiro.',
      'DTA, Nº de óbitos: número inteiro.',
    ]);
    for (const data of ['2026-11-11', '2026-02-30', '10/11/2026', '2026-13-01']) expect(errosDta({ DT_ENCERRA: data }, hoje), data).toEqual(['DTA, Data de encerramento (DTA): data válida e não futura.']);
    expect(errosDta({ CRITERIO: '9' }, hoje)).toEqual(['DTA, Critério de confirmação: código de 1 a 5.']);
  });
});

describe('surto: validação por etapa (manual do Sinan, 5.3.1 i)', () => {
  const ok: DadosSurtoValidacao = {
    notificadoEm: '2026-11-05',
    unitId: 'ubs-centro',
    grupo: null,
    sindrome: 'DIARREICA_AGUDA_SANGUINOLENTA',
    cid: null,
    primeirosSintomasEm: '2026-11-02',
    casos: 12,
    localInicial: '3',
    localInicialTexto: null,
    investigadoEm: '2026-11-06',
    delimitacao: '3',
    delimitacaoTexto: null,
    encerradoEm: '2026-11-20',
  };

  it('notificação: campos obrigatórios', () => {
    expect(validarSurto(ok, 'NOTIFICACAO')).toEqual([]);
    expect(validarSurto({ ...ok, sindrome: null, cid: 'A08' }, 'NOTIFICACAO')).toEqual([]);
    const vazio: DadosSurtoValidacao = { notificadoEm: null, unitId: null, grupo: null, sindrome: null, cid: null, primeirosSintomasEm: null, casos: null, localInicial: null, localInicialTexto: null };
    expect(validarSurto(vazio, 'NOTIFICACAO')).toEqual([
      'Informe a data da notificação',
      'Informe a unidade notificante',
      'Informe o agravo, a síndrome ou o CID do surto',
      'Informe a data dos primeiros sintomas do primeiro caso',
      'Informe o número de casos suspeitos (1 ou mais)',
      'Informe o local inicial de ocorrência (1 a 11)',
    ]);
    expect(validarSurto({ ...ok, casos: 0 }, 'NOTIFICACAO')).toEqual(['Informe o número de casos suspeitos (1 ou mais)']);
    expect(validarSurto({ ...ok, localInicial: '12' }, 'NOTIFICACAO')).toEqual(['Informe o local inicial de ocorrência (1 a 11)']);
    expect(validarSurto({ ...ok, localInicial: '11' }, 'NOTIFICACAO')).toEqual(['Descreva o local inicial de ocorrência (Outros)']);
    expect(validarSurto({ ...ok, localInicial: '11', localInicialTexto: 'Festa junina' }, 'NOTIFICACAO')).toEqual([]);
    expect(validarSurto({ ...ok, primeirosSintomasEm: '2026-11-06' }, 'NOTIFICACAO')).toEqual(['Os primeiros sintomas não podem ser depois da notificação']);
    // A notificação não olha a investigação nem o encerramento.
    expect(validarSurto({ ...ok, investigadoEm: null, delimitacao: null, encerradoEm: null }, 'NOTIFICACAO')).toEqual([]);
  });

  it('investigação exige a data da investigação (DT_INVEST), não antes da notificação', () => {
    expect(validarSurto(ok, 'INVESTIGACAO')).toEqual([]);
    expect(validarSurto({ ...ok, investigadoEm: null }, 'INVESTIGACAO')).toEqual(['Informe a data da investigação']);
    expect(validarSurto({ ...ok, investigadoEm: '2026-11-04' }, 'INVESTIGACAO')).toEqual(['A investigação não pode ser antes da notificação']);
    // As etapas acumulam: a investigação confere também a notificação.
    expect(validarSurto({ ...ok, unitId: null }, 'INVESTIGACAO')).toEqual(['Informe a unidade notificante']);
  });

  it('encerramento exige a delimitação e a data, igual ou depois da notificação', () => {
    expect(validarSurto(ok, 'ENCERRAMENTO')).toEqual([]);
    expect(validarSurto({ ...ok, encerradoEm: '2026-11-05' }, 'ENCERRAMENTO')).toEqual([]);
    expect(validarSurto({ ...ok, delimitacao: null, encerradoEm: null }, 'ENCERRAMENTO')).toEqual(['Informe a delimitação do surto (1 a 11)', 'Informe a data do encerramento']);
    expect(validarSurto({ ...ok, encerradoEm: '2026-11-04' }, 'ENCERRAMENTO')).toEqual(['O encerramento não pode ser antes da notificação']);
    expect(validarSurto({ ...ok, delimitacao: '11' }, 'ENCERRAMENTO')).toEqual(['Descreva a delimitação do surto (Outros)']);
    expect(validarSurto({ ...ok, investigadoEm: null }, 'ENCERRAMENTO')).toEqual(['Informe a data da investigação']);
  });
});
