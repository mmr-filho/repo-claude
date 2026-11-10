import { describe, expect, it } from 'vitest';
import {
  CRITERIO_CASO_SURTO,
  DELIMITACAO_SURTO,
  detectarAglomerados,
  GRUPOS_SEM_SUGESTAO_DE_SURTO,
  LOCAL_INICIAL_SURTO,
  MODO_TRANSMISSAO,
  REGRAS_SURTO_PADRAO,
  SINDROMES_SURTO,
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
const OPCOES: OpcoesDeteccaoSurto = { hoje: '2026-11-10', dispensas: [], diasInusitado: 365, historicoPorGrupo: {} };
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
