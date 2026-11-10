import type { DetalheSurto, EventoSurto, SugestaoSurtoTela } from '@omnisaude/shared';
import { describe, expect, it } from 'vitest';
import {
  aceitaDta,
  candidatasParaPlanilha,
  comunicacoesDoSurto,
  corpoComunicacao,
  corpoEdicao,
  corpoEncerramento,
  corpoLinhaCaso,
  corpoNovoSurto,
  dtaDoForm,
  errosCategoria,
  formDaSugestao,
  formEdicao,
  formNovoSurto,
  idadeValida,
  isoParaLocal,
  linhaVazia,
  localParaIso,
  origemDoCaso,
  pendenciasComunicacao,
  pendenciasEdicao,
  pendenciasEncerramento,
  pendenciasLinhaCaso,
  pendenciasNovoSurto,
  textoEvento,
  type FormSurto,
} from '../src/components/consolidacao/surto-regras';

/*
 * Regras da aba Surtos (web): formulário da notificação de surto (manual e a partir da sugestão), o PATCH só com o
 * que mudou, encerramento, comunicação, linha manual da planilha e linha do tempo. Datas e horas no fuso da
 * instituição, nunca no relógio da máquina.
 */

const SP = 'America/Sao_Paulo';
const UNIDADE = '0190a000-0000-7000-8000-000000000001';
const HOSPITAL = '0190a000-0000-7000-8000-000000000002';
const BAIRRO = '0190a000-0000-7000-8000-0000000000b1';

function sugestao(tipo: SugestaoSurtoTela['vinculo']['tipo'], o: Partial<SugestaoSurtoTela> = {}): SugestaoSurtoTela {
  return {
    assinatura: `bairro-7d|${tipo}:${tipo === 'UNIDADE' ? HOSPITAL : BAIRRO}|hepatite-a`,
    regra: 'bairro-7d',
    descricao: 'Dois ou mais casos do mesmo agravo no mesmo bairro em 7 dias',
    grupo: 'hepatite-a',
    vinculo: { tipo, id: tipo === 'UNIDADE' ? HOSPITAL : tipo === 'MUNICIPIO' ? 'municipio' : BAIRRO },
    casos: ['n1', 'n2', 'n3'],
    primeiroSintoma: '2026-11-02',
    ultimoConhecimento: '2026-11-08T14:00:00.000Z',
    fonte: 'GVS',
    vinculoNome: 'Centro',
    casosDetalhe: [
      { id: 'n1', numero: '2026/000101', agravo: 'Hepatite A', unidade: 'UBS Centro', bairro: 'Centro', inicioSintomas: '2026-11-03', conhecidoEm: '2026-11-05T01:30:00.000Z' },
      { id: 'n2', numero: '2026/000102', agravo: 'Hepatite A', unidade: 'UBS Centro', bairro: 'Centro', inicioSintomas: null, conhecidoEm: '2026-11-06T13:00:00.000Z' },
      { id: 'n3', numero: '2026/000103', agravo: 'Hepatite A', unidade: 'UBS Centro', bairro: 'Centro', inicioSintomas: '2026-11-02', conhecidoEm: '2026-11-08T14:00:00.000Z' },
    ],
    ...o,
  };
}

function detalhe(o: Partial<DetalheSurto> = {}): DetalheSurto {
  return {
    id: 's1',
    numero: '2026/0001',
    status: 'ABERTO',
    categoria: 'DA_LISTA',
    grupo: 'hepatite-a',
    agravo: 'Hepatite A',
    sindrome: null,
    cid: 'B159',
    unidade: { id: UNIDADE, nome: 'UBS Centro', cnes: '1234567' },
    notificadoEm: '2026-11-08',
    conhecidoEm: '2026-11-08T13:10:30.000Z',
    primeirosSintomasEm: '2026-11-02',
    casos: 3,
    casosNaPlanilha: 0,
    localInicial: '3',
    esp: false,
    prazos: [],
    numeroOficial: null,
    encerradoEm: null,
    avisos: [],
    venceEm: '2026-11-09T13:10:30.000Z',
    notificador: 'Vera',
    agente: null,
    localInicialTexto: null,
    local: { municipioIbge: '3550308', localidadeId: null, bairroId: BAIRRO, endereco: 'Rua A, 10', referencia: null, zona: '1', lat: -23.5, lng: -46.6 },
    investigacao: { investigadoEm: null, modoTransmissao: null, veiculo: null, veiculoTexto: null, observacoes: null, investigadorNome: null, investigadorFuncao: null },
    dta: null,
    delimitacao: null,
    delimitacaoTexto: null,
    notasEncerramento: null,
    descarte: null,
    sinal: null,
    planilha: [],
    eventos: [],
    espelho: { campos: [], planilha: [], dta: [], avisos: [] },
    pendencias: [],
    permissoes: { editar: true, encerrar: true, descartar: true, numeroOficial: false },
    ...o,
  };
}

const evento = (tipo: EventoSurto['tipo'], dados: Record<string, unknown>, em = '2026-11-08T15:00:00.000Z'): EventoSurto => ({ id: `${tipo}-${em}`, tipo, em, por: 'Vera', dados });

describe('datas e horas no fuso da instituição', () => {
  it('converte o instante para o campo datetime-local e volta', () => {
    expect(isoParaLocal('2026-11-10T13:05:00.000Z', SP)).toBe('2026-11-10T10:05');
    expect(localParaIso('2026-11-10T10:05', SP)).toBe('2026-11-10T13:05:00.000Z');
    expect(isoParaLocal('2026-11-10T13:05:00.000Z', 'America/Manaus')).toBe('2026-11-10T09:05');
    expect(localParaIso('2026-11-10T09:05', 'America/Manaus')).toBe('2026-11-10T13:05:00.000Z');
    // Virada do dia: 22h em São Paulo já é o dia seguinte em UTC.
    expect(localParaIso('2026-12-31T22:30', SP)).toBe('2027-01-01T01:30:00.000Z');
  });

  it('recusa data inexistente e texto que não é data e hora', () => {
    expect(localParaIso('2026-02-30T10:00', SP)).toBeNull();
    expect(localParaIso('2026-11-10', SP)).toBeNull();
    expect(localParaIso('', SP)).toBeNull();
    expect(isoParaLocal(null, SP)).toBe('');
    expect(isoParaLocal('não é data', SP)).toBe('');
  });
});

describe('notificação de surto nova', () => {
  const base = { hoje: '2026-11-10', agora: '2026-11-10T10:00', unitIdPadrao: UNIDADE, tz: SP };

  it('pré-preenche pela sugestão de bairro: agravo, casos, primeiro sintoma, local 8 e o bairro', () => {
    const f = formDaSugestao(sugestao('BAIRRO'), base);
    expect(f).toMatchObject({ categoria: 'DA_LISTA', grupo: 'hepatite-a', casos: '3', primeirosSintomasEm: '2026-11-02', localInicial: '8', unitId: UNIDADE, notificadoEm: '2026-11-10', conhecidoEm: '2026-11-10T10:00' });
    expect(f.local.bairroId).toBe(BAIRRO);
  });

  it('na sugestão de unidade, a unidade notificante é a do vínculo e o local é a unidade de saúde (2)', () => {
    const f = formDaSugestao(sugestao('UNIDADE'), base);
    expect(f.unitId).toBe(HOSPITAL);
    expect(f.localInicial).toBe('2');
    expect(f.local.bairroId).toBe('');
    expect(formDaSugestao(sugestao('MUNICIPIO'), base).localInicial).toBe('9');
    expect(formDaSugestao(sugestao('QUARTEIRAO'), base).localInicial).toBe('8');
  });

  it('sem início dos sintomas, usa a data (no fuso) do primeiro caso conhecido', () => {
    const s = sugestao('BAIRRO', { primeiroSintoma: null, casosDetalhe: sugestao('BAIRRO').casosDetalhe.map((c) => ({ ...c, inicioSintomas: null })) });
    // 2026-11-05T01:30Z é 04/11 às 22h30 em São Paulo.
    expect(formDaSugestao(s, base).primeirosSintomasEm).toBe('2026-11-04');
  });

  it('monta o corpo com a assinatura e os casos da sugestão, o CID sem ponto e o instante em UTC', () => {
    const s = sugestao('BAIRRO');
    const f: FormSurto = { ...formDaSugestao(s, base), cid: ' b15.9 ', agente: '  Vírus da hepatite A ', local: { ...formDaSugestao(s, base).local, endereco: '  ', lat: '-23,55', lng: 'x' } };
    const corpo = corpoNovoSurto(f, SP, s);
    expect(corpo).toMatchObject({
      assinatura: s.assinatura,
      casosIndicados: [{ notificationId: 'n1' }, { notificationId: 'n2' }, { notificationId: 'n3' }],
      categoria: 'DA_LISTA',
      grupo: 'hepatite-a',
      sindrome: null,
      cid: 'B159',
      agente: 'Vírus da hepatite A',
      conhecidoEm: '2026-11-10T13:00:00.000Z',
      casos: 3,
      localInicial: '8',
      localInicialTexto: null,
    });
    // Só os campos do local preenchidos e válidos.
    expect(corpo.local).toEqual({ bairroId: BAIRRO, lat: -23.55 });
  });

  it('manual: a categoria decide entre agravo do catálogo, síndrome e CID', () => {
    const f = { ...formNovoSurto({ hoje: '2026-11-10', agora: '2026-11-10T10:00', unitId: UNIDADE }), categoria: 'FORA_DA_LISTA' as const, grupo: 'hepatite-a', sindrome: 'ICTERICA_AGUDA', cid: 'B17.8' };
    const corpo = corpoNovoSurto(f, SP);
    expect(corpo).toMatchObject({ grupo: null, sindrome: null, cid: 'B178' });
    expect(corpo).not.toHaveProperty('assinatura');
    expect(corpo).not.toHaveProperty('local');
    expect(corpoNovoSurto({ ...f, categoria: 'SINDROMICO' }, SP)).toMatchObject({ grupo: null, sindrome: 'ICTERICA_AGUDA' });
    expect(corpoNovoSurto({ ...f, categoria: 'DTA' }, SP)).toMatchObject({ grupo: 'hepatite-a', sindrome: null });
    expect(corpoNovoSurto({ ...f, localInicial: '11', localInicialTexto: ' Clube ' }, SP).localInicialTexto).toBe('Clube');
  });

  it('confere a categoria como a API', () => {
    expect(errosCategoria({ categoria: 'DA_LISTA', grupo: null, sindrome: null, cid: null })).toEqual(['Surto de doença da lista: escolha o agravo do catálogo.']);
    expect(errosCategoria({ categoria: 'SINDROMICO', grupo: null, sindrome: null, cid: null })).toEqual(['Agravo inusitado: escolha a síndrome.']);
    expect(errosCategoria({ categoria: 'FORA_DA_LISTA', grupo: null, sindrome: null, cid: '' })).toEqual(['Doença fora da lista: informe o CID.']);
    expect(errosCategoria({ categoria: 'FORA_DA_LISTA', grupo: null, sindrome: null, cid: 'XYZ' })).toEqual(['CID inválido (ex.: A05.9).']);
    expect(errosCategoria({ categoria: 'DTA', grupo: null, sindrome: null, cid: 'A05.9' })).toEqual([]);
  });

  it('lista as pendências da notificação (as do manual 5.3.1 e as datas)', () => {
    const vazio = formNovoSurto({ hoje: '2026-11-10', agora: '', unitId: '' });
    const p = pendenciasNovoSurto(vazio, { hoje: '2026-11-10', agoraIso: '2026-11-10T13:00:00.000Z', tz: SP });
    expect(p).toEqual(
      expect.arrayContaining([
        'Surto de doença da lista: escolha o agravo do catálogo.',
        'Informe a unidade notificante',
        'Informe a data dos primeiros sintomas do primeiro caso',
        'Informe o número de casos suspeitos (1 ou mais)',
        'Informe o local inicial de ocorrência (1 a 11)',
        'Informe quando a vigilância soube do surto (data e hora).',
      ]),
    );
    const ok = formDaSugestao(sugestao('BAIRRO'), base);
    expect(pendenciasNovoSurto(ok, { hoje: '2026-11-10', agoraIso: '2026-11-10T13:00:00.000Z', tz: SP })).toEqual([]);
    expect(pendenciasNovoSurto({ ...ok, conhecidoEm: '2026-11-10T11:00' }, { hoje: '2026-11-10', agoraIso: '2026-11-10T13:00:00.000Z', tz: SP })).toEqual(['O conhecimento do surto não pode ser futuro.']);
    expect(pendenciasNovoSurto({ ...ok, notificadoEm: '2026-11-11', primeirosSintomasEm: '2026-11-11' }, { hoje: '2026-11-10', agoraIso: '2026-11-10T13:00:00.000Z', tz: SP })).toEqual([
      'A data da notificação não pode ser futura.',
    ]);
    expect(pendenciasNovoSurto({ ...ok, primeirosSintomasEm: '2026-11-11' }, { hoje: '2026-11-10', agoraIso: '2026-11-10T13:00:00.000Z', tz: SP })).toEqual(['Os primeiros sintomas não podem ser depois da notificação']);
    expect(pendenciasNovoSurto({ ...ok, localInicial: '11' }, { hoje: '2026-11-10', agoraIso: '2026-11-10T13:00:00.000Z', tz: SP })).toEqual(['Descreva o local inicial de ocorrência (Outros)']);
    expect(pendenciasNovoSurto({ ...ok, casos: '0' }, { hoje: '2026-11-10', agoraIso: '2026-11-10T13:00:00.000Z', tz: SP })).toEqual(['Informe o número de casos suspeitos (1 ou mais)']);
    // O limite da API para o nº de casos.
    expect(pendenciasNovoSurto({ ...ok, casos: '1000001' }, { hoje: '2026-11-10', agoraIso: '2026-11-10T13:00:00.000Z', tz: SP })).toEqual(['O número de casos vai até 1.000.000.']);
    expect(pendenciasNovoSurto({ ...ok, local: { ...ok.local, municipioIbge: '35', lat: '91' } }, { hoje: '2026-11-10', agoraIso: '2026-11-10T13:00:00.000Z', tz: SP })).toEqual([
      'Município de ocorrência: código IBGE de 6 ou 7 dígitos.',
      'Latitude inválida (de -90 a 90).',
    ]);
  });
});

describe('edição da ficha (PATCH)', () => {
  it('sem mudança, o corpo fica vazio', () => {
    const d = detalhe();
    expect(corpoEdicao(d, formEdicao(d))).toEqual({});
  });

  it('manda só os campos mudados; texto apagado vira null', () => {
    const d = detalhe();
    const f = formEdicao(d);
    f.casos = '5';
    f.local.endereco = '';
    f.local.lat = '-23,4';
    f.investigacao.investigadoEm = '2026-11-09';
    f.investigacao.investigadorNome = ' Vera Lúcia ';
    expect(corpoEdicao(d, f)).toEqual({ casos: 5, local: { endereco: null, lat: -23.4 }, investigacao: { investigadoEm: '2026-11-09', investigadorNome: 'Vera Lúcia' } });
  });

  it('o CID igual com ponto não é mudança; trocar para fora da lista apaga o agravo', () => {
    const d = detalhe();
    expect(corpoEdicao(d, { ...formEdicao(d), cid: 'b15.9' })).toEqual({});
    expect(corpoEdicao(d, { ...formEdicao(d), categoria: 'FORA_DA_LISTA' })).toEqual({ categoria: 'FORA_DA_LISTA', grupo: null });
  });

  it('o bloco DTA só vai com categoria DTA ou veículo alimento/água; trocar o veículo apaga o bloco', () => {
    const d = detalhe();
    const f = formEdicao(d);
    f.investigacao.veiculo = '1';
    f.dta = { NU_TOT: '12', DS_ALICAUS: ' Maionese ', NU_OBITO: '' };
    expect(aceitaDta('DA_LISTA', '1')).toBe(true);
    expect(corpoEdicao(d, f)).toEqual({ investigacao: { veiculo: '1' }, dta: { NU_TOT: 12, DS_ALICAUS: 'Maionese' } });
    const comDta = detalhe({ investigacao: { ...d.investigacao, veiculo: '1' }, dta: { NU_TOT: 12, DS_ALICAUS: 'Maionese' } });
    expect(corpoEdicao(comDta, formEdicao(comDta))).toEqual({});
    const g = formEdicao(comDta);
    g.investigacao.veiculo = '3';
    expect(corpoEdicao(comDta, g)).toEqual({ investigacao: { veiculo: '3' }, dta: null });
    // Variável que a tela não mostra continua no bloco.
    expect(dtaDoForm({ NU_TOT: '3', SN_DIARREI: '1' })).toEqual({ NU_TOT: 3, SN_DIARREI: '1' });
    expect(dtaDoForm({ NU_TOT: ' ' })).toBeNull();
  });

  it('confere a ficha editada: investigação antes da notificação, veículo "outro" sem texto, números da DTA', () => {
    const d = detalhe();
    const f = formEdicao(d);
    f.investigacao.investigadoEm = '2026-11-07';
    f.investigacao.veiculo = '6';
    expect(pendenciasEdicao(d, f, '2026-11-10')).toEqual(['A investigação não pode ser antes da notificação', 'Descreva o veículo de transmissão (Outro).']);
    f.investigacao.investigadoEm = '2026-11-11';
    f.investigacao.veiculo = '1';
    f.dta = { NU_TOT: 'doze', DT_ENCERRA: '2026-12-01' };
    expect(pendenciasEdicao(d, f, '2026-11-10')).toEqual(['A data da investigação não pode ser futura.', 'DTA, Total de doentes: número inteiro.', 'DTA, Data de encerramento (DTA): data válida e não futura.']);
    expect(pendenciasEdicao(d, formEdicao(d), '2026-11-10')).toEqual([]);
  });
});

describe('encerramento, comunicação e planilha', () => {
  it('encerrar exige a investigação, a delimitação (texto no 11) e data entre a notificação e hoje', () => {
    const d = detalhe();
    expect(pendenciasEncerramento(d, { delimitacao: '', texto: '', data: '', notas: '' }, '2026-11-10')).toEqual([
      'Informe a data da investigação',
      'Informe a delimitação do surto (1 a 11)',
      'Informe a data do encerramento',
    ]);
    const investigado = detalhe({ investigacao: { ...d.investigacao, investigadoEm: '2026-11-09' } });
    expect(pendenciasEncerramento(investigado, { delimitacao: '11', texto: '', data: '2026-11-07', notas: '' }, '2026-11-10')).toEqual([
      'Descreva a delimitação do surto (Outros)',
      'O encerramento não pode ser antes da notificação',
    ]);
    expect(pendenciasEncerramento(investigado, { delimitacao: '3', texto: '', data: '2026-11-12', notas: '' }, '2026-11-10')).toEqual(['O encerramento não pode ter data futura.']);
    expect(pendenciasEncerramento(investigado, { delimitacao: '3', texto: 'x', data: '2026-11-10', notas: '' }, '2026-11-10')).toEqual([]);
    expect(corpoEncerramento({ delimitacao: '3', texto: 'sobra', data: '2026-11-10', notas: '  ' })).toEqual({ delimitacao: '3', texto: null, data: '2026-11-10', notas: null });
    expect(corpoEncerramento({ delimitacao: '11', texto: ' Clube ', data: '2026-11-10', notas: 'Fim' }).texto).toBe('Clube');
  });

  it('a comunicação não pode ser futura nem anterior ao conhecimento', () => {
    const o = { tz: SP, agoraIso: '2026-11-10T13:00:00.000Z', conhecidoEm: '2026-11-08T13:10:30.000Z' };
    const f = { alvo: 'SES' as const, canal: 'TELEFONE' as const, contraparte: 'Plantão CIEVS', protocolo: ' 123 ', nota: '', em: '2026-11-08T10:30' };
    expect(pendenciasComunicacao(f, o)).toEqual([]);
    expect(corpoComunicacao(f, SP)).toEqual({ alvo: 'SES', canal: 'TELEFONE', contraparte: 'Plantão CIEVS', protocolo: '123', nota: null, em: '2026-11-08T13:30:00.000Z' });
    // 10h10 em São Paulo (13h10 UTC) é antes do conhecimento às 13h10min30s UTC.
    expect(pendenciasComunicacao({ ...f, em: '2026-11-08T10:10' }, o)).toEqual(['A comunicação não pode ser anterior ao conhecimento do surto.']);
    expect(pendenciasComunicacao({ ...f, em: '2026-11-10T10:30', contraparte: 'x' }, o)).toEqual(['Informe com quem falou (nome ou setor).', 'A comunicação não pode ter data futura.']);
    expect(pendenciasComunicacao({ ...f, em: '' }, o)).toEqual(['Informe a data e a hora da comunicação.']);
  });

  it('lista as comunicações dos eventos, da mais recente para a mais antiga', () => {
    const eventos = [
      evento('CRIADO', { categoria: 'DA_LISTA', casos: 3 }),
      evento('COMUNICADO', { alvo: 'SMS', canal: 'TELEFONE', contraparte: 'Vigilância', protocolo: null, nota: null, em: '2026-11-08T14:00:00.000Z' }, '2026-11-08T14:05:00.000Z'),
      evento('COMUNICADO', { alvo: 'SES', canal: 'EMAIL', contraparte: 'CIEVS', protocolo: '55', nota: 'ok', em: '2026-11-09T09:00:00.000Z' }, '2026-11-09T09:01:00.000Z'),
    ];
    expect(comunicacoesDoSurto(eventos).map((c) => [c.alvo, c.protocolo, c.registradoEm])).toEqual([
      ['SES', '55', '2026-11-09T09:01:00.000Z'],
      ['SMS', null, '2026-11-08T14:05:00.000Z'],
    ]);
  });

  it('aceita as idades que a API aceita', () => {
    for (const ok of ['34', '34 anos', '34A', '1 ano', '5 meses', '5m', '10 dias', '12 horas', '12h', '11 mês']) expect(idadeValida(ok), ok).toBe(true);
    for (const ruim of ['', 'abc', '13 meses', '32 dias', '24 horas', '131', '3 semanas']) expect(idadeValida(ruim), ruim).toBe(false);
  });

  it('monta a linha manual e confere os campos', () => {
    const f = { ...linhaVazia(), iniciais: ' mas ', sexo: 'F', idade: '34 anos', hospitalizado: 'S' as const, obito: 'N' as const, classificacao: '1', criterio: '2', cidFinal: 'a05.9', municipioResidencia: '355030' };
    expect(pendenciasLinhaCaso(f, '2026-11-10')).toEqual([]);
    expect(corpoLinhaCaso(f)).toEqual({
      iniciais: 'MAS',
      sexo: 'F',
      idade: '34 anos',
      municipioResidencia: '355030',
      bairroId: null,
      inicioSintomas: null,
      hospitalizado: true,
      obito: false,
      classificacao: '1',
      criterio: '2',
      cidFinal: 'A059',
    });
    expect(pendenciasLinhaCaso(linhaVazia(), '2026-11-10')).toEqual(['Preencha ao menos um campo da linha.']);
    expect(pendenciasLinhaCaso({ ...linhaVazia(), sexo: 'M' }, '2026-11-10')).toEqual([]);
    expect(pendenciasLinhaCaso({ ...f, idade: '40 semanas', inicioSintomas: '2026-11-11', municipioResidencia: '12', cidFinal: '123' }, '2026-11-10')).toEqual([
      'Idade: número e unidade (ex.: 34 anos, 5 meses, 10 dias).',
      'O início dos sintomas não pode ser futuro.',
      'Município de residência: código IBGE de 6 ou 7 dígitos.',
      'CID final inválido (ex.: A05.9).',
    ]);
  });

  it('mostra a origem do caso e só oferece notificações fora da planilha e não descartadas', () => {
    expect(origemDoCaso({ notificationId: 'n1', notificacaoNumero: '2026/000101', officialRecordId: null })).toBe('Notificação 2026/000101');
    expect(origemDoCaso({ notificationId: null, notificacaoNumero: null, officialRecordId: 'r1' })).toBe('Registro oficial');
    expect(origemDoCaso({ notificationId: null, notificacaoNumero: null, officialRecordId: null })).toBe('Linha manual');
    const lista = [
      { id: 'n1', status: 'NOTIFICADA' },
      { id: 'n2', status: 'DESCARTADA' },
      { id: 'n3', status: 'RASCUNHO' },
    ];
    expect(candidatasParaPlanilha(lista, [{ notificationId: 'n1' }, { notificationId: null }]).map((n) => n.id)).toEqual(['n3']);
  });
});

describe('linha do tempo', () => {
  it('descreve cada evento', () => {
    expect(textoEvento(evento('CRIADO', { categoria: 'DTA', casos: 12, assinatura: 'x' }))).toBe('Surto notificado (Doença transmitida por alimento (DTA)), 12 caso(s) informado(s), a partir de uma sugestão.');
    expect(textoEvento(evento('EDITADO', { campos: ['casos', 'local', 'outro'] }))).toBe('Alterado: nº de casos, local de ocorrência, outro.');
    expect(textoEvento(evento('INVESTIGADO', { campos: ['investigacao'], investigadoEm: '2026-11-09' }))).toBe('Investigação em 09/11/2026. Alterado: investigação.');
    expect(textoEvento(evento('COMUNICADO', { alvo: 'SES', canal: 'TELEFONE', contraparte: 'CIEVS', protocolo: '55' }))).toBe('Comunicado à SES por telefone (CIEVS), protocolo 55.');
    expect(textoEvento(evento('CASO_VINCULADO', { caso: 2, notificacao: '2026/000101' }))).toBe('Caso 2 na planilha: notificação 2026/000101.');
    expect(textoEvento(evento('CASO_VINCULADO', { caso: 3, registro: '0012345', sistema: 'SINAN_NET' }))).toBe('Caso 3 na planilha: registro oficial 0012345.');
    expect(textoEvento(evento('CASO_VINCULADO', { caso: 4, manual: true }))).toBe('Caso 4 na planilha: linha manual.');
    expect(textoEvento(evento('CASO_RETIRADO', { caso: 2, notificacao: null }))).toBe('Caso 2 retirado da planilha.');
    expect(textoEvento(evento('ENCERRADO', { delimitacao: '3', data: '2026-11-20' }))).toBe('Encerrado em 20/11/2026; delimitação: Creche/Escola.');
    expect(textoEvento(evento('DESCARTADO', { motivo: 'Casos sem vínculo' }))).toBe('Descartado. Motivo: Casos sem vínculo');
    expect(textoEvento(evento('NUMERO_OFICIAL', { numero: '1234567', anterior: null }))).toBe('Número do Sinan: 1234567.');
  });
});
