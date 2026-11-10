import { cnsFromBase, completeCpf, localDateString, ROLE_PERMISSIONS, semanaDaData, type Permission } from '@omnisaude/shared';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { decodificar, escolherCodificacao } from '../src/modules/vigilancia/importacao/codepages';
import { lerCsvOficial, normalizarCabecalho } from '../src/modules/vigilancia/importacao/csv-oficial';
import { ErroArquivo, lerDbf } from '../src/modules/vigilancia/importacao/dbf';
import { ConciliacaoService } from '../src/modules/vigilancia/conciliacao.service';
import { detectarTipo, extrairArquivos } from '../src/modules/vigilancia/importacao/detectar';
import { lerEnvio } from '../src/modules/vigilancia/importacao/leitura';
import { aplicarParte, colunasDoEstado, estadoDoBanco, estadoVazio, hashDoEstado } from '../src/modules/vigilancia/importacao/mescla';
import { lerData } from '../src/modules/vigilancia/importacao/normalizar';
import { CAMPOS_NINDINET, escreverDbf, type CampoEscrita, type ValorEscrita } from './helpers/dbf-escrita';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

/**
 * Importação das exportações oficiais e conciliação (VIG-1c, frente F2). Os bytes de texto em CP850, CP437, CP860 e
 * CP1252 foram gerados pelo Python 3.13 (`'JOÃO DA CONCEIÇÃO'.encode('cp850').hex()` etc.), fora do código testado.
 * Dados sintéticos: nomes, números e CNS inventados.
 */

const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const PY = {
  cp850: {
    'JOÃO DA CONCEIÇÃO': '4a4fc74f20444120434f4e43454980c74f',
    SERVIÇOS: '5345525649804f53',
    GOIÂNIA: '474f49b64e4941',
    'SÃO PAULO': '53c74f205041554c4f',
    'JOSÉ ANTÔNIO DE ASSUNÇÃO': '4a4f539020414e54e24e494f20444520415353554e80c74f',
    'Maria Aparecida Simões': '4d61726961204170617265636964612053696de46573',
    'VILA SÃO JOSÉ': '56494c412053c74f204a4f5390',
  },
  cp437: { SERVIÇOS: '5345525649804f53', JOSÉ: '4a4f5390', Goiânia: '476f69836e6961' },
  cp860: { 'JOÃO DA CONCEIÇÃO': '4a4f8e4f20444120434f4e434549808e4f', GOIÂNIA: '474f498f4e4941', 'SÃO PAULO': '538e4f205041554c4f', 'LUÍS CAMÕES': '4c558b532043414d994553' },
  cp1252: { 'JOÃO DA CONCEIÇÃO': '4a4fc34f20444120434f4e434549c7c34f', GOIÂNIA: '474f49c24e4941', 'SÃO PAULO': '53c34f205041554c4f' },
} as const;

describe('Importação oficial: leitura dos arquivos (sem banco)', () => {
  it('CP850, CP437, CP860 e CP1252 decodificam as palavras codificadas pelo Python', () => {
    for (const [palavra, h] of Object.entries(PY.cp850)) expect(decodificar(hex(h), 'CP850')).toBe(palavra);
    for (const [palavra, h] of Object.entries(PY.cp437)) expect(decodificar(hex(h), 'CP437')).toBe(palavra);
    for (const [palavra, h] of Object.entries(PY.cp860)) expect(decodificar(hex(h), 'CP860')).toBe(palavra);
    for (const [palavra, h] of Object.entries(PY.cp1252)) expect(decodificar(hex(h), 'CP1252')).toBe(palavra);
    // CP850 e CP860 diferem justamente no Ã: o mesmo byte não serve para os dois.
    expect(decodificar(hex(PY.cp860['JOÃO DA CONCEIÇÃO']), 'CP850')).not.toBe('JOÃO DA CONCEIÇÃO');
  });

  it('DBF sem marca no byte 29: a pontuação das letras escolhe CP850 ou CP1252 (empate: CP850)', () => {
    expect(escolherCodificacao(Object.values(PY.cp850).map(hex))).toBe('CP850');
    expect(escolherCodificacao(Object.values(PY.cp1252).map(hex))).toBe('CP1252');
    // "SÃO" em CP850 lido como CP1252 vira "SÇO": empate de pontos, fica o padrão do Sinan Net.
    expect(escolherCodificacao([hex(PY.cp850['SÃO PAULO'])])).toBe('CP850');
    expect(escolherCodificacao([])).toBe('CP850');
  });

  it('DBF: byte 29, registro apagado, data D vazia e preenchida, parada no 0x1A e aviso do arquivo regravado pelo R', () => {
    const campos: CampoEscrita[] = [
      { nome: 'NU_NOTIFIC', tipo: 'C', tamanho: 7 },
      { nome: 'DT_NOTIFIC', tipo: 'D', tamanho: 8 },
      { nome: 'DT_OBITO', tipo: 'D', tamanho: 8 },
      { nome: 'NU_IDADE_N', tipo: 'N', tamanho: 4 },
      { nome: 'NM_PACIENT', tipo: 'C', tamanho: 30 },
    ];
    const registros = [
      { NU_NOTIFIC: '0000001', DT_NOTIFIC: '2025-03-05', DT_OBITO: null, NU_IDADE_N: 4034, NM_PACIENT: hex(PY.cp850['JOÃO DA CONCEIÇÃO']) },
      { valores: { NU_NOTIFIC: '0000002', DT_NOTIFIC: '2025-03-06', NM_PACIENT: 'APAGADO' }, apagado: true },
      { NU_NOTIFIC: '0000003', DT_NOTIFIC: '2025-03-07', DT_OBITO: '2025-03-20', NU_IDADE_N: 3009, NM_PACIENT: hex(PY.cp850['Maria Aparecida Simões']) },
    ];
    const bytes = escreverDbf(campos, registros, { byteIdioma: 0x25 });
    const dbf = lerDbf(bytes);
    expect(dbf).toMatchObject({ versao: 3, registros: 3, codificacao: 'CP850', origemCodificacao: 'CABECALHO', byteIdioma: 0x25, atualizadoEm: '2026-11-09' });
    expect(dbf.campos.map((c) => `${c.nome}:${c.tipo}${c.tamanho}`)).toEqual(['NU_NOTIFIC:C7', 'DT_NOTIFIC:D8', 'DT_OBITO:D8', 'NU_IDADE_N:N4', 'NM_PACIENT:C30']);
    const linhas = [...dbf.linhas()];
    expect(linhas).toEqual([
      { NU_NOTIFIC: '0000001', DT_NOTIFIC: '2025-03-05', DT_OBITO: null, NU_IDADE_N: '4034', NM_PACIENT: 'JOÃO DA CONCEIÇÃO' },
      { NU_NOTIFIC: '0000003', DT_NOTIFIC: '2025-03-07', DT_OBITO: '2025-03-20', NU_IDADE_N: '3009', NM_PACIENT: 'Maria Aparecida Simões' },
    ]);
    // O cabeçalho promete 5 registros, mas o 0x1A vem depois do 3º: a leitura para ali, com aviso.
    const cortado = Buffer.from(bytes);
    cortado.writeUInt32LE(5, 4);
    const lido = lerDbf(cortado);
    expect([...lido.linhas()]).toHaveLength(2);
    expect(lido.avisos.join(' ')).toContain('terminou antes do previsto');
    // Sem marca no byte 29: decide a pontuação; data 1995-07-26 = regravado pelo R.
    const semMarca = lerDbf(escreverDbf(campos, registros, { byteIdioma: 0x00, data: { ano: 1995, mes: 7, dia: 26 } }));
    expect(semMarca).toMatchObject({ codificacao: 'CP850', origemCodificacao: 'PONTUACAO' });
    expect(semMarca.avisos.join(' ')).toContain('regravado pelo R');
    // Codificação informada na tela vence o cabeçalho.
    expect(lerDbf(bytes, { codificacao: 'CP1252' })).toMatchObject({ codificacao: 'CP1252', origemCodificacao: 'INFORMADA' });
    expect(() => lerDbf(Buffer.from('não é dbf'))).toThrow(ErroArquivo);
  });

  it('CSV oficial: BOM, aspas com separador e quebra de linha dentro, CRLF, sinônimos do cabeçalho e notação científica recusada', () => {
    const csv = '﻿"Número da Notificação";"Evolução do Caso";"Notificante e-mail";Observação\r\n"351234567890";Cura;"a@b.c";"texto; com ponto e vírgula\r\ne quebra"\r\n351234567891;Cancelado;;\r\n';
    const leitura = lerCsvOficial(new TextEncoder().encode(csv));
    expect(leitura).toMatchObject({ separador: ';', codificacao: 'UTF8', colunas: ['numero da notificacao', 'evolucao caso', 'notificante email', 'observacao'] });
    const linhas = [...leitura.linhas()];
    expect(linhas).toEqual([
      { 'numero da notificacao': '351234567890', 'evolucao caso': 'Cura', 'notificante email': 'a@b.c', observacao: 'texto; com ponto e vírgula\r\ne quebra' },
      { 'numero da notificacao': '351234567891', 'evolucao caso': 'Cancelado', 'notificante email': null, observacao: null },
    ]);
    expect(normalizarCabecalho('Evolução Caso')).toBe('evolucao caso');
    expect(normalizarCabecalho('Notificante Email')).toBe('notificante email');
    // UTF-8 inválido: lido como Windows-1252, com aviso.
    const latin = lerCsvOficial(Uint8Array.from([...Buffer.from('Bairro;Numero da Notificacao\r\n', 'latin1'), 0x53, 0xc3, 0x4f, 0x3b, 0x31, 0x0d, 0x0a]));
    expect(latin.codificacao).toBe('CP1252');
    expect([...latin.linhas()][0]).toEqual({ bairro: 'SÃO', 'numero da notificacao': '1' });
    expect(latin.avisos.join(' ')).toContain('Windows-1252');
    // Regravado pelo Excel: número em notação científica.
    const excel = lerCsvOficial(new TextEncoder().encode('Número da Notificação;CPF\r\n3,51235E+11;12345678901\r\n'));
    expect(() => [...excel.linhas()]).toThrow(/notação científica/);
  });

  it('o tipo vem do conteúdo, nunca do nome do arquivo', () => {
    const notif = ['nu_notific', 'tp_not', 'id_agravo', 'dt_notific', 'id_municip', 'id_unidade', 'nm_pacient', 'dt_nasc', 'cs_sexo'];
    expect(detectarTipo(notif, [{ tp_not: '2', id_agravo: 'A279' }])).toBe('NINDINET');
    expect(detectarTipo([...notif, 'res_elisa'], [{ tp_not: '2', id_agravo: 'A279' }])).toBe('AGRAVO_NET');
    expect(detectarTipo(['nu_notific', 'dt_notific', 'sem_not', 'id_municip', 'id_unidade'], [{}])).toBe('NNEGANET');
    expect(detectarTipo(['nu_notific', 'tp_not', 'id_agravo', 'dt_notific', 'qt_total_c', 'cs_local'], [{ tp_not: '3' }])).toBe('NSURTNET');
    expect(detectarTipo([...notif, 'classi_fin', 'tp_sistema'], [{ id_agravo: 'A90', tp_sistema: '2', classi_fin: '10' }])).toBe('DENGON');
    expect(detectarTipo([...notif, 'classi_fin', 'tp_sistema', 'clinc_chik'], [{ id_agravo: 'A92.0', tp_sistema: '2', classi_fin: '13' }])).toBe('CHIKON');
    expect(detectarTipo(['numero da notificacao', 'data da notificacao', 'cnes notificacao'], [])).toBe('ESUS_NOTIFICA_CSV');
    expect(detectarTipo(['nu_notific', 'id_agravo', 'dt_notific', 'status'], [{ nu_notific: '352600000123', id_agravo: 'A93.0' }], 'CSV')).toBe('ESUS_SINAN_CSV');
    expect(detectarTipo(['id_municip', 'nm_municip', 'sg_uf', 'id_regiona'], [])).toBe('TABELA_SINAN');
    expect(detectarTipo(['qualquer', 'coisa'], [])).toBe('DESCONHECIDO');
  });

  it('datas: AAAA-MM-DD, AAAAMMDD, dd/mm/aaaa e ISO em UTC (13h ou mais fica duvidosa)', () => {
    expect(lerData('2025-03-05')).toEqual({ data: '2025-03-05', invalida: false, duvidosa: false });
    expect(lerData('20250305').data).toBe('2025-03-05');
    expect(lerData('05/03/2025').data).toBe('2025-03-05');
    expect(lerData('2026-04-25T03:00:00.000Z')).toEqual({ data: '2026-04-25', invalida: false, duvidosa: false });
    expect(lerData('2026-04-25T19:00:00.000Z')).toEqual({ data: '2026-04-25', invalida: false, duvidosa: true });
    expect(lerData('31/02/2025')).toEqual({ data: null, invalida: true, duvidosa: false });
    expect(lerData('')).toEqual({ data: null, invalida: false, duvidosa: false });
  });

  it('zip: só .dbf e .csv entram; DBC e planilha do Excel ficam de fora; teto de 600 MB descompactados (zip bomb)', () => {
    const csv = new TextEncoder().encode('a;b\r\n1;2\r\n');
    const arquivos = extrairArquivos('envio.zip', zipSync({ 'x/NINDINET.DBF': new Uint8Array([3]), 'x/ZIKABR21.dbc': new Uint8Array([3]), 'x/notas.txt': csv, 'y/esus.CSV': csv }));
    expect(arquivos.map((a) => [a.nome, a.ignorado ?? null])).toEqual([
      ['x/NINDINET.DBF', null],
      ['y/esus.CSV', null],
      ['x/ZIKABR21.dbc', expect.stringContaining('DBC')],
      ['x/notas.txt', 'não é .dbf nem .csv'],
    ]);
    // Planilha do Excel: o .xlsx é um zip com [Content_Types].xml.
    expect(() => extrairArquivos('planilha.xlsx', zipSync({ '[Content_Types].xml': csv, 'xl/workbook.xml': csv }))).toThrow(/Excel/);
    // O diretório central declara 700 MB descompactados: recusado antes de descompactar.
    const bomba = Buffer.from(zipSync({ 'grande.csv': csv }));
    bomba.writeUInt32LE(700 * 1024 * 1024, bomba.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
    expect(() => extrairArquivos('bomba.zip', bomba)).toThrow(/600 MB/);
  });

  it('NNEGANET, NSURTNET e CSV do e-SUS Sinan: tipo, chave natural, "Excluída" e piso de 2022', () => {
    const negativa = escreverDbf(
      [
        { nome: 'NU_NOTIFIC', tipo: 'C', tamanho: 7 },
        { nome: 'DT_NOTIFIC', tipo: 'D', tamanho: 8 },
        { nome: 'SEM_NOT', tipo: 'C', tamanho: 6 },
        { nome: 'NU_ANO', tipo: 'C', tamanho: 4 },
        { nome: 'SG_UF_NOT', tipo: 'C', tamanho: 2 },
        { nome: 'ID_MUNICIP', tipo: 'C', tamanho: 6 },
        { nome: 'ID_REGIONA', tipo: 'C', tamanho: 8 },
        { nome: 'ID_UNIDADE', tipo: 'C', tamanho: 7 },
      ],
      [{ NU_NOTIFIC: '0000010', DT_NOTIFIC: '2025-03-08', SEM_NOT: '202509', NU_ANO: '2025', SG_UF_NOT: '35', ID_MUNICIP: '355030', ID_UNIDADE: '9000028' }],
    );
    const surto = escreverDbf(
      [
        { nome: 'NU_NOTIFIC', tipo: 'C', tamanho: 7 },
        { nome: 'TP_NOT', tipo: 'C', tamanho: 1 },
        { nome: 'ID_AGRAVO', tipo: 'C', tamanho: 4 },
        { nome: 'DT_NOTIFIC', tipo: 'D', tamanho: 8 },
        { nome: 'ID_MUNICIP', tipo: 'C', tamanho: 6 },
        { nome: 'ID_UNIDADE', tipo: 'C', tamanho: 7 },
        { nome: 'DT_SIN_PRI', tipo: 'D', tamanho: 8 },
        { nome: 'QT_TOTAL_C', tipo: 'C', tamanho: 5 },
        { nome: 'CS_LOCAL', tipo: 'C', tamanho: 2 },
      ],
      [{ NU_NOTIFIC: '0000020', TP_NOT: '3', ID_AGRAVO: 'A08', DT_NOTIFIC: '2025-03-10', ID_MUNICIP: '355030', ID_UNIDADE: '9000011', DT_SIN_PRI: '2025-03-07', QT_TOTAL_C: '12', CS_LOCAL: '3' }],
    );
    const esusSinan =
      'NU_NOTIFIC;ID_AGRAVO;DT_NOTIFIC;ID_MUNICIP;ID_UNIDADE;STATUS;NM_PACIENT;CPF\r\n' +
      '352500000101;B42;15/03/2025;355030;9000011;Encerrada;Ana Esporo;52998224725\r\n' +
      '352500000102;B42;16/03/2025;355030;9000011;Excluída;Bia Esporo;\r\n' +
      '352100000103;B42;16/03/2021;355030;9000011;Encerrada;Caio Antigo;\r\n';
    const zip = zipSync({ 'NNEGANET.DBF': negativa, 'NSURTNET.DBF': surto, 'esus-sinan.csv': new TextEncoder().encode(esusSinan) });
    const l = lerEnvio('envio.zip', zip, { hoje: '2026-11-10', municipio: '3550308' });
    expect(l.arquivos.map((a) => a.tipo).sort()).toEqual(['ESUS_SINAN_CSV', 'NNEGANET', 'NSURTNET']);
    const por = (n: string) => l.registros.find((r) => r.partes[0]!.numero === n)!;
    expect(por('0000010')).toMatchObject({ sistema: 'SINAN_NET', tipo: 'NEGATIVA', chave: '10|2025-03-08|355030|9000028' });
    expect(por('0000020')).toMatchObject({ sistema: 'SINAN_NET', tipo: 'SURTO', chave: '20|2025-03-10|355030|A08' });
    expect(por('0000020').partes[0]!.extras).toMatchObject({ qt_total_c: '12', cs_local: '3' });
    expect(por('352500000101')).toMatchObject({ sistema: 'ESUS_SINAN', tipo: 'INDIVIDUAL', chave: '352500000101|B42' });
    expect(por('352500000101').partes[0]).toMatchObject({ grupo: 'esporotricose', excluido: false, identificacao: { nome: 'Ana Esporo', cpf: '52998224725' } });
    expect(por('352500000102').partes[0]!.excluido).toBe(true);
    expect(l.motivosRecusa).toEqual({ 'Data da notificação anterior a 01/01/2022 (início do sistema)': 1 });
  });

  it('o estado gravado no banco e relido tem o mesmo hash (sem "alterado" falso na reexportação)', () => {
    const dengon: CampoEscrita[] = [
      { nome: 'NU_NOTIFIC', tipo: 'C', tamanho: 7 },
      { nome: 'ID_AGRAVO', tipo: 'C', tamanho: 4 },
      { nome: 'DT_NOTIFIC', tipo: 'D', tamanho: 8 },
      { nome: 'ID_MUNICIP', tipo: 'C', tamanho: 6 },
      { nome: 'ID_UNIDADE', tipo: 'C', tamanho: 7 },
      { nome: 'NM_PACIENT', tipo: 'C', tamanho: 30 },
      { nome: 'NM_MAE_PAC', tipo: 'C', tamanho: 30 },
      { nome: 'CLASSI_FIN', tipo: 'C', tamanho: 2 },
      { nome: 'TP_SISTEMA', tipo: 'C', tamanho: 1 },
    ];
    const arquivos = {
      'DENGON.DBF': escreverDbf(dengon, [
        { NU_NOTIFIC: '0000123', ID_AGRAVO: 'A90', DT_NOTIFIC: '2025-01-10', ID_MUNICIP: '355030', ID_UNIDADE: '9000011', NM_PACIENT: 'Ana', NM_MAE_PAC: 'Mãe da Ana', CLASSI_FIN: '10', TP_SISTEMA: '2' },
      ]),
      'esus.csv': new TextEncoder().encode('Número da Notificação;Data da Notificação;CNES Notificação;Evolução Caso;Sintoma- Febre\r\n351234500001;10/01/2025;9000011;Cura;Sim\r\n'),
    };
    const l = lerEnvio('envio.zip', zipSync(arquivos), { hoje: '2026-11-10', municipio: '3550308', sensiveis: new Set(['sifilis']) });
    expect(l.registros).toHaveLength(2);
    for (const r of l.registros) {
      const estado = r.partes.reduce(aplicarParte, estadoVazio());
      const linha = { id: 'x', ...colunasDoEstado(r.sistema, estado, new Set()) };
      const relido = estadoDoBanco(linha);
      expect(relido).toEqual(estado);
      expect(hashDoEstado(r.sistema, r.tipo, relido)).toBe(hashDoEstado(r.sistema, r.tipo, estado));
      // A mesma parte de novo não muda nada.
      expect(hashDoEstado(r.sistema, r.tipo, r.partes.reduce(aplicarParte, relido))).toBe(hashDoEstado(r.sistema, r.tipo, estado));
    }
  });

  it('conciliação: no degrau 1 desempata a data mais próxima até 7 dias; no degrau 2 só o candidato único; o par é único dos dois lados', () => {
    const servico = new ConciliacaoService(null as never, null as never, null as never) as unknown as {
      unicos(c: { recordId: string; notificationId: string; degrau: 1 | 2 | 3; distancia: number; motivo: string }[], desempate: boolean): { recordId: string; notificationId: string }[];
    };
    const c = (recordId: string, notificationId: string, distancia: number, degrau: 1 | 2 = 1) => ({ recordId, notificationId, distancia, degrau, motivo: '' });
    const degrau1 = [
      c('R1', 'N1', 0),
      c('R1', 'N2', 3),
      // Empate: ambíguo.
      c('R2', 'N3', 2),
      c('R2', 'N4', 2),
      // R3 e R4 disputam N5: fica o mais próximo dos dois lados.
      c('R3', 'N5', 0),
      c('R4', 'N5', 1),
      // Dois candidatos e nenhum até 7 dias.
      c('R6', 'N8', 9),
      c('R6', 'N9', 10),
    ];
    expect(servico.unicos(degrau1, true).map((p) => `${p.recordId}-${p.notificationId}`)).toEqual(['R1-N1', 'R3-N5']);
    expect(servico.unicos([c('R5', 'N6', 0, 2), c('R5', 'N7', 1, 2)], false)).toEqual([]);
    expect(servico.unicos([c('R7', 'N10', 5, 2)], false).map((p) => p.notificationId)).toEqual(['N10']);
  });
});

const enabled = await pgAvailable();
const FUSO = 'America/Sao_Paulo';

type Criada = { id: string };
type Detalhe = {
  id: string;
  status: string;
  contagens: { lidos: number; novos: number; alterados: number; iguais: number; recusados: number; duplicadosNoArquivo: number; ausentesPrevistos: number; motivosRecusa: Record<string, number> };
  arquivos: { nome: string; tipo: string; codificacao: string | null; origemCodificacao: string | null; registros: number; ignorado: boolean; avisos: string[] }[];
  previa: {
    novos: { numero: string; paciente: string | null; sigiloso: boolean }[];
    alterados: { numero: string; campos: { campo: string; antes: string | null; depois: string | null }[] }[];
    ausentes: { numero: string }[];
  } | null;
};

describe.runIf(enabled)('Vigilância: importação das exportações oficiais e conciliação (VIG-1c, frente F2)', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let recepcao = '';
  let medica = '';
  let vig = '';
  let gestora = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let seq = 0;
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const address = { cep: '77405070', street: 'Rua da Importação', number: '27', district: 'Centro', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };
  const hoje = () => localDateString(new Date(), FUSO);
  const semana = (d: string) => semanaDaData(d).codigo;
  const MUN = '355030';
  const UBS = '9000011';

  const novoPaciente = async (name: string, sex: 'M' | 'F', birthDate: string) => {
    seq++;
    const cns = cnsFromBase(String(27300000900 + seq));
    const body = { name, birthDate, sex, cpf: completeCpf(String(273000900 + seq)), cns, motherName: `Mae de ${name}`, phone: '(63) 97777-2700', address };
    return { id: (await t.http().post('/api/patients').set(auth(recepcao)).send(body).expect(201)).body.id as string, cns };
  };
  const notificar = async (nome: string, sex: 'M' | 'F', nasc: string, cid: string) => {
    const p = await novoPaciente(nome, sex, nasc);
    const enc = (await t.http().post('/api/reception/check-in').set(auth(recepcao)).send({ patientId: p.id, kind: 'AMBULATORIAL' }).expect(201)).body;
    await t.http().post(`/api/clinical/encounters/${enc.id}/start`).set(auth(medica)).expect(200);
    const note = (
      await t
        .http()
        .post(`/api/clinical/encounters/${enc.id}/notes`)
        .set(auth(medica))
        .send({ kind: 'SOAP', subjective: 'Queixa.', objective: 'Exame.', assessment: 'Hipótese.', plan: 'Conduta.', codes: [{ system: 'CID10', code: cid }] })
        .expect(201)
    ).body;
    const [c] = (await t.http().post(`/api/clinical/notes/${note.id}/sign`).set(auth(medica)).expect(200)).body.notificacoes as Criada[];
    const conf = await t.http().post(`/api/vigilancia/notificacoes/${c!.id}/confirmar`).set(auth(medica));
    if (conf.status !== 200) throw new Error(`confirmar ${cid}: ${conf.status} ${JSON.stringify(conf.body)}`);
    return { id: c!.id, cns: p.cns };
  };
  const enviar = async (bytes: Uint8Array, nome: string, q: Record<string, string> = {}, status = 201, tk = vig, tipo = 'application/octet-stream') =>
    (
      await t
        .http()
        .post('/api/vigilancia/importacoes')
        .query({ nome, ...q })
        .set(auth(tk))
        .set('Content-Type', tipo)
        .send(Buffer.from(bytes))
        .expect(status)
    ).body;
  const aplicar = async (id: string) => (await t.http().post(`/api/vigilancia/importacoes/${id}/aplicar`).set(auth(vig)).expect(200)).body;
  const registro = (numero: string) => db.officialRecord.findFirstOrThrow({ where: { number: numero } });

  /** Registro do NINDINET (leptospirose em 2025, de residente, na UBS Centro), com os campos que variam por teste. */
  const nindinet = (v: Record<string, ValorEscrita>) => ({
    TP_NOT: '2',
    ID_AGRAVO: 'A279',
    SG_UF_NOT: '35',
    ID_MUNICIP: MUN,
    ID_UNIDADE: UBS,
    SG_UF: '35',
    ID_MN_RESI: MUN,
    NU_TELEFON: '999990000',
    NDUPLIC_N: null,
    ...(typeof v.DT_NOTIFIC === 'string' ? { SEM_NOT: semana(v.DT_NOTIFIC), NU_ANO: v.DT_NOTIFIC.slice(0, 4) } : {}),
    ...v,
  });

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('vigimport', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    t.app.get(AiService).client = null;
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
  });

  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  // Arquivo do primeiro envio (reaproveitado no "mesmo arquivo de novo").
  let primeiro: Buffer;
  let primeiroId = '';

  it('NINDINET em CP850 (bytes do Python): registro apagado fica de fora, datas D, 0x1A; aplica, liga a unidade e descarta o telefone', async () => {
    primeiro = escreverDbf(CAMPOS_NINDINET, [
      nindinet({
        NU_NOTIFIC: '6100001',
        DT_NOTIFIC: '2025-03-05',
        DT_SIN_PRI: '2025-03-01',
        NM_PACIENT: hex(PY.cp850['JOÃO DA CONCEIÇÃO']),
        DT_NASC: '1980-01-01',
        CS_SEXO: 'M',
        NM_BAIRRO: hex(PY.cp850['VILA SÃO JOSÉ']),
      }),
      { valores: nindinet({ NU_NOTIFIC: '6100002', DT_NOTIFIC: '2025-03-06', NM_PACIENT: 'REGISTRO APAGADO' }), apagado: true },
      nindinet({ NU_NOTIFIC: '6100003', DT_NOTIFIC: '2025-03-07', DT_SIN_PRI: null, NM_PACIENT: hex(PY.cp850['JOSÉ ANTÔNIO DE ASSUNÇÃO']), CS_SEXO: 'M', NM_BAIRRO: 'CENTRO' }),
    ]);
    const d = (await enviar(primeiro, 'LEPTO2025.DBF')) as Detalhe;
    primeiroId = d.id;
    expect(d.status).toBe('PREVIA');
    expect(d.arquivos[0]).toMatchObject({ tipo: 'NINDINET', codificacao: 'CP850', origemCodificacao: 'CABECALHO', registros: 2, ignorado: false });
    expect(d.contagens).toMatchObject({ lidos: 2, novos: 2, alterados: 0, iguais: 0, recusados: 0 });
    expect(d.previa!.novos.map((n) => n.paciente).sort()).toEqual(['JOSÉ ANTÔNIO DE ASSUNÇÃO', 'JOÃO DA CONCEIÇÃO']);
    // Prévia não grava registro.
    expect(await db.officialRecord.count({ where: { number: { in: ['6100001', '6100003'] } } })).toBe(0);

    const r = await aplicar(d.id);
    expect(r.contagens).toMatchObject({ novos: 2, alterados: 0 });
    expect(r.unidadesLigadas).toBe(2);
    const a = await registro('6100001');
    const ubs = await db.unit.findUniqueOrThrow({ where: { cnes: UBS } });
    expect(a).toMatchObject({
      system: 'SINAN_NET',
      type: 'INDIVIDUAL',
      agravo: 'A279',
      groupKey: 'leptospirose',
      patientName: 'JOÃO DA CONCEIÇÃO',
      neighborhoodName: 'VILA SÃO JOSÉ',
      unitId: ubs.id,
      epiWeekNotified: semana('2025-03-05'),
      situation: 'EM_INVESTIGACAO',
    });
    expect(a.naturalKey).toBe(`6100001|2025-03-05|${MUN}|A279`);
    expect((await registro('6100003')).symptomsOnset).toBeNull();
    expect(JSON.stringify(a.data)).not.toContain('999990000');
    expect(await db.officialRecord.count({ where: { number: '6100002' } })).toBe(0);
    const imp = await db.officialImport.findUniqueOrThrow({ where: { id: d.id } });
    expect(imp).toMatchObject({ status: 'APLICADA', payload: null, preview: null });
  });

  it('o mesmo arquivo de novo responde jaImportado e não muda nada (importa sem duplicar)', async () => {
    const antes = { registros: await db.officialRecord.count(), importacoes: await db.officialImport.count() };
    const r = await enviar(primeiro, 'LEPTO2025-copia.DBF', {}, 200);
    expect(r).toEqual({ jaImportado: { id: primeiroId, aplicadoEm: expect.any(String) } });
    expect({ registros: await db.officialRecord.count(), importacoes: await db.officialImport.count() }).toEqual(antes);
  });

  it('arquivo alterado: só o registro que mudou conta como alterado', async () => {
    const alterado = escreverDbf(CAMPOS_NINDINET, [
      nindinet({ NU_NOTIFIC: '6100001', DT_NOTIFIC: '2025-03-05', DT_SIN_PRI: '2025-03-01', NM_PACIENT: hex(PY.cp850['JOÃO DA CONCEIÇÃO']), DT_NASC: '1980-01-01', CS_SEXO: 'M', NM_BAIRRO: 'CENTRO' }),
      nindinet({ NU_NOTIFIC: '6100003', DT_NOTIFIC: '2025-03-07', DT_SIN_PRI: null, NM_PACIENT: hex(PY.cp850['JOSÉ ANTÔNIO DE ASSUNÇÃO']), CS_SEXO: 'M', NM_BAIRRO: 'CENTRO' }),
    ]);
    const d = (await enviar(alterado, 'LEPTO2025-v2.DBF')) as Detalhe;
    expect(d.contagens).toMatchObject({ novos: 0, alterados: 1, iguais: 1 });
    expect(d.previa!.alterados[0]).toMatchObject({ numero: '6100001', campos: [{ campo: 'bairroNome', antes: 'VILA SÃO JOSÉ', depois: 'CENTRO' }] });
    const r = await aplicar(d.id);
    expect(r.contagens).toMatchObject({ novos: 0, alterados: 1, iguais: 1 });
    expect((await registro('6100001')).neighborhoodName).toBe('CENTRO');
  });

  it('DBF sem marca no byte 29: a prévia diz a codificação escolhida; reenviar com outra refaz a prévia e descarta a anterior', async () => {
    const arquivo = escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '6500001', DT_NOTIFIC: '2025-02-03', NM_PACIENT: hex(PY.cp850['JOÃO DA CONCEIÇÃO']) })], { byteIdioma: 0x00 });
    const d1 = (await enviar(arquivo, 'sem-marca.dbf')) as Detalhe;
    expect(d1.arquivos[0]).toMatchObject({ codificacao: 'CP850', origemCodificacao: 'PONTUACAO' });
    expect(d1.previa!.novos[0]!.paciente).toBe('JOÃO DA CONCEIÇÃO');
    const d2 = (await enviar(arquivo, 'sem-marca.dbf', { codificacao: 'CP1252' })) as Detalhe;
    expect(d2.arquivos[0]).toMatchObject({ codificacao: 'CP1252', origemCodificacao: 'INFORMADA' });
    expect(d2.previa!.novos[0]!.paciente).toBe('JOÇO DA CONCEI€ÇO');
    expect(await db.officialImport.findUniqueOrThrow({ where: { id: d1.id } })).toMatchObject({ status: 'DESCARTADA', payload: null });
    await t.http().post(`/api/vigilancia/importacoes/${d2.id}/descartar`).set(auth(vig)).expect(200);
  });

  it('NINDINET + DBF do agravo no mesmo zip viram um registro; o vazio só apaga o que o mesmo tipo de arquivo gravou', async () => {
    const campos = CAMPOS_NINDINET.filter((c) => c.nome !== 'NM_BAIRRO');
    const investigacao: CampoEscrita[] = [
      ...campos,
      { nome: 'CLASSI_FIN', tipo: 'C', tamanho: 1 },
      { nome: 'CRITERIO', tipo: 'C', tamanho: 1 },
      { nome: 'EVOLUCAO', tipo: 'C', tamanho: 1 },
      { nome: 'DT_ENCERRA', tipo: 'D', tamanho: 8 },
      { nome: 'RES_ELISA', tipo: 'C', tamanho: 1 },
    ];
    const base = nindinet({ NU_NOTIFIC: '0000777', DT_NOTIFIC: '2025-04-10', NM_PACIENT: 'MARCOS MESCLA', CS_SEXO: 'M' });
    // Nomes trocados de propósito: o tipo sai do conteúdo.
    const zip = zipSync({
      'exportacao/LEPTONET.DBF': escreverDbf(CAMPOS_NINDINET, [{ ...base, NM_BAIRRO: 'CENTRO' }]),
      'exportacao/NINDINET.DBF': escreverDbf(investigacao, [{ ...base, CLASSI_FIN: '1', CRITERIO: '1', EVOLUCAO: '1', DT_ENCERRA: '2025-05-02', RES_ELISA: '1' }]),
      'exportacao/leia-me.txt': new TextEncoder().encode('sem dados'),
    });
    const d = (await enviar(zip, 'exportacao.zip')) as Detalhe;
    expect(d.arquivos.map((a) => [a.nome, a.tipo, a.ignorado])).toEqual([
      ['exportacao/LEPTONET.DBF', 'NINDINET', false],
      ['exportacao/NINDINET.DBF', 'AGRAVO_NET', false],
      ['exportacao/leia-me.txt', 'DESCONHECIDO', true],
    ]);
    expect(d.contagens).toMatchObject({ lidos: 2, novos: 1 });
    await aplicar(d.id);
    const r = await registro('0000777');
    expect(r).toMatchObject({ neighborhoodName: 'CENTRO', finalClass: '1', criterion: '1', evolution: '1', situation: 'CONFIRMADO' });
    expect((r.data as { _fontes: Record<string, string> })._fontes).toMatchObject({ bairroNome: 'NINDINET', classificacao: 'AGRAVO_NET', numero: 'AGRAVO_NET' });
    expect(r.naturalKey).toBe(`777|2025-04-10|${MUN}|A279`);

    // Só o NINDINET de novo: o bairro (gravado por ele) vazio apaga; a classificação vazia não apaga a do DBF do agravo.
    const soNotificacao = escreverDbf([...CAMPOS_NINDINET, { nome: 'CLASSI_FIN', tipo: 'C', tamanho: 1 }], [{ ...base, NM_BAIRRO: null, CLASSI_FIN: null }]);
    const d2 = (await enviar(soNotificacao, 'NINDINET.DBF')) as Detalhe;
    expect(d2.arquivos[0]!.tipo).toBe('NINDINET');
    expect(d2.contagens).toMatchObject({ alterados: 1 });
    await aplicar(d2.id);
    expect(await registro('0000777')).toMatchObject({ neighborhoodName: null, finalClass: '1', situation: 'CONFIRMADO' });
  });

  it('ausência só dentro da cobertura (sistema, agravo, período e município); o registro que volta perde a marca', async () => {
    const maio = { de: '2025-05-01', ate: '2025-05-31' };
    const f1 = escreverDbf(CAMPOS_NINDINET, [
      nindinet({ NU_NOTIFIC: '6200001', DT_NOTIFIC: '2025-05-02' }),
      nindinet({ NU_NOTIFIC: '6200002', DT_NOTIFIC: '2025-05-03' }),
      nindinet({ NU_NOTIFIC: '6200003', DT_NOTIFIC: '2025-05-04', ID_AGRAVO: 'A379' }),
      nindinet({ NU_NOTIFIC: '6200004', DT_NOTIFIC: '2025-07-10' }),
      nindinet({ NU_NOTIFIC: '6200005', DT_NOTIFIC: '2025-05-05', ID_MUNICIP: '520870', SG_UF_NOT: '52' }),
    ]);
    await aplicar(((await enviar(f1, 'maio-1.dbf')) as Detalhe).id);
    // Segunda exportação de maio, só de leptospirose do município: o 6200002 não veio.
    const f2 = escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '6200001', DT_NOTIFIC: '2025-05-02' })]);
    const d2 = (await enviar(f2, 'maio-2.dbf', maio)) as Detalhe;
    expect(d2.contagens.ausentesPrevistos).toBe(1);
    expect(d2.previa!.ausentes.map((a) => a.numero)).toEqual(['6200002']);
    const r2 = await aplicar(d2.id);
    expect(r2.ausentesMarcados).toBe(1);
    const ausencia = async (n: string) => (await registro(n)).absentSince;
    expect(await ausencia('6200002')).not.toBeNull();
    // Outro agravo, fora do período e outro município de notificação: fora da cobertura.
    expect(await ausencia('6200003')).toBeNull();
    expect(await ausencia('6200004')).toBeNull();
    expect(await ausencia('6200005')).toBeNull();
    expect(await ausencia('6200001')).toBeNull();
    // Volta na exportação seguinte.
    const f3 = escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '6200001', DT_NOTIFIC: '2025-05-02' }), nindinet({ NU_NOTIFIC: '6200002', DT_NOTIFIC: '2025-05-03' })]);
    const r3 = await aplicar(((await enviar(f3, 'maio-3.dbf', maio)) as Detalhe).id);
    expect(r3).toMatchObject({ voltaram: 1, ausentesMarcados: 0 });
    expect(await ausencia('6200002')).toBeNull();
  });

  it('e-SUS Notifica em CSV: BOM, ponto e vírgula, "Cancelado" vira excluído e o contato fica de fora; notação científica é recusada', async () => {
    const cab = [
      'Número da Notificação',
      'Data da Notificação',
      'Data do início dos sintomas',
      'Estado de Residência',
      'Município de Residência',
      'Estado da Notificação',
      'Município da Notificação',
      'CNES Notificação',
      'Nome Completo',
      'CPF',
      'CNS',
      'Data de Nascimento',
      'Sexo',
      'Nome Completo da Mãe',
      'Telefone 1',
      'Notificante e-mail',
      'Sintoma- Febre',
      'Evolução Caso',
      'Classificação Final',
      'Data de encerramento',
      'Bairro',
    ];
    const linha = (v: string[]) => v.map((x) => (x.includes(';') ? `"${x}"` : x)).join(';');
    const csv = `﻿${cab.map((c) => `"${c}"`).join(';')}\r\n${linha([
      '351234567890',
      '10/06/2025',
      '08/06/2025',
      'São Paulo',
      '3550308',
      'São Paulo',
      '3550308',
      UBS,
      'Paula Esus Confirmada',
      '529.982.247-25',
      '',
      '01/02/1990',
      'Feminino',
      'Mae da Paula',
      '(11) 99999-0000',
      'notificante@exemplo.org',
      'Sim',
      'Cura',
      'Confirmado Laboratorial',
      '20/06/2025',
      'Centro',
    ])}\r\n${linha(['351234567891', '11/06/2025', '', 'São Paulo', 'Cidade Fictícia', 'São Paulo', '3550308', UBS, 'Pedro Esus Cancelado', '', '', '02/03/1985', 'Masculino', '', '', '', 'Não', 'Cancelado', 'Descartado', '', ''])}\r\n`;
    const d = (await enviar(new TextEncoder().encode(csv), 'esus-notifica-2025.csv', {}, 201, vig, 'text/csv')) as Detalhe;
    expect(d.arquivos[0]).toMatchObject({ tipo: 'ESUS_NOTIFICA_CSV', codificacao: 'UTF8', registros: 2 });
    expect(d.arquivos[0]!.avisos.join(' ')).toContain('Município pelo nome');
    await aplicar(d.id);
    const ok = await registro('351234567890');
    expect(ok).toMatchObject({ system: 'ESUS_NOTIFICA', groupKey: 'covid', situation: 'CONFIRMADO', finalClass: '1', evolution: '1', excluded: false, cpf: '52998224725', sex: 'F', municipalityIbge: '3550308' });
    expect(ok.naturalKey).toBe('351234567890');
    const dados = JSON.stringify(ok.data);
    expect(dados).not.toContain('99999-0000');
    expect(dados).not.toContain('notificante@exemplo.org');
    const cancelado = await registro('351234567891');
    expect(cancelado).toMatchObject({ excluded: true, evolution: '7', situation: 'DESCARTADO', residenceIbge: null });
    expect((cancelado.data as Record<string, unknown>)['municipio de residencia (nome)']).toBe('Cidade Fictícia');
    // O mesmo CSV aberto e salvo no Excel: o número vira notação científica e o arquivo é recusado.
    const excel = csv.replace('351234567890', '3,51235E+11');
    const recusa = await enviar(new TextEncoder().encode(excel), 'esus-excel.csv', {}, 422, vig, 'text/csv');
    expect(recusa.message).toContain('notação científica');
  });

  describe('conciliação', () => {
    let dengue: { id: string; cns: string };
    let lepto: { id: string; cns: string };
    let coque: { id: string; cns: string };
    let manual: { id: string; cns: string };

    it('degrau 1 (número oficial sem zeros à esquerda) e degrau 2 (CNS + mesmo agravo + datas a até 7 dias) vinculam sozinhos', async () => {
      // Fora da idade fértil: a ficha não pede o campo 12 (gestante).
      dengue = await notificar('Dora Dengue Importacao', 'F', '1950-01-01', 'A90');
      await t.http().post(`/api/vigilancia/notificacoes/${dengue.id}/numero-oficial`).set(auth(vig)).send({ numero: '7700001' }).expect(200);
      lepto = await notificar('Lauro Lepto Importacao', 'M', '1975-02-02', 'A27.9');
      const d = hoje();
      const dengon: CampoEscrita[] = [
        { nome: 'NU_NOTIFIC', tipo: 'C', tamanho: 10 },
        { nome: 'TP_NOT', tipo: 'C', tamanho: 1 },
        { nome: 'ID_AGRAVO', tipo: 'C', tamanho: 5 },
        { nome: 'DT_NOTIFIC', tipo: 'D', tamanho: 8 },
        { nome: 'SEM_NOT', tipo: 'C', tamanho: 6 },
        { nome: 'ID_MUNICIP', tipo: 'C', tamanho: 6 },
        { nome: 'ID_UNIDADE', tipo: 'C', tamanho: 7 },
        { nome: 'NM_PACIENT', tipo: 'C', tamanho: 70 },
        { nome: 'CLASSI_FIN', tipo: 'C', tamanho: 2 },
        { nome: 'CRITERIO', tipo: 'C', tamanho: 1 },
        { nome: 'EVOLUCAO', tipo: 'C', tamanho: 1 },
        { nome: 'TP_SISTEMA', tipo: 'C', tamanho: 1 },
      ];
      const zip = zipSync({
        'DENGON26.DBF': escreverDbf(dengon, [
          {
            NU_NOTIFIC: '0007700001',
            TP_NOT: '2',
            ID_AGRAVO: 'A90',
            DT_NOTIFIC: d,
            SEM_NOT: semana(d),
            ID_MUNICIP: MUN,
            ID_UNIDADE: UBS,
            NM_PACIENT: 'DORA DENGUE IMPORTACAO',
            CLASSI_FIN: '10',
            CRITERIO: '1',
            TP_SISTEMA: '2',
          },
        ]),
        'NINDINET.DBF': escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '8800001', DT_NOTIFIC: d, ID_CNS_SUS: lepto.cns, NM_PACIENT: 'LAURO LEPTO IMPORTACAO', CS_SEXO: 'M', DT_NASC: '1975-02-02' })]),
      });
      const det = (await enviar(zip, 'conciliacao-1.zip')) as Detalhe;
      expect(det.arquivos.map((a) => a.tipo)).toEqual(['DENGON', 'NINDINET']);
      const r = await aplicar(det.id);
      expect(r.vinculadosAutomaticamente).toBe(2);
      expect(await registro('0007700001')).toMatchObject({ notificationId: dengue.id, matchMethod: 'NUMERO_OFICIAL', system: 'SINAN_ONLINE', groupKey: 'dengue' });
      expect(await registro('8800001')).toMatchObject({ notificationId: lepto.id, matchMethod: 'IDENTIDADE' });
      const so = (await t.http().get('/api/vigilancia/conciliacao/so-oficial').query({ busca: '7700001' }).set(auth(vig)).expect(200)).body;
      expect(so.itens).toEqual([]);
    });

    it('degrau 3 (nome, nascimento e sexo) só sugere; a rejeição fica gravada e o par não volta', async () => {
      coque = await notificar('Célia Coqueluche Importacao', 'F', '1950-03-03', 'A37.9');
      const d = hoje();
      const arquivo = (bairro: string) =>
        escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '8800002', DT_NOTIFIC: d, ID_AGRAVO: 'A379', NM_PACIENT: 'CELIA COQUELUCHE IMPORTACAO', DT_NASC: '1950-03-03', CS_SEXO: 'F', NM_BAIRRO: bairro })]);
      const r = await aplicar(((await enviar(arquivo('CENTRO'), 'coqueluche.dbf')) as Detalhe).id);
      expect(r.vinculadosAutomaticamente).toBe(0);
      const rec = await registro('8800002');
      expect(rec.notificationId).toBeNull();
      const sugeridas = async () => (await t.http().get('/api/vigilancia/conciliacao/sugestoes').query({ busca: 'coqueluche importacao' }).set(auth(vig)).expect(200)).body;
      const s = await sugeridas();
      expect(s.itens).toEqual([expect.objectContaining({ degrau: 3, registro: expect.objectContaining({ id: rec.id }), notificacao: expect.objectContaining({ id: coque.id }) })]);
      await t.http().post('/api/vigilancia/conciliacao/rejeitar').set(auth(vig)).send({ recordId: rec.id, notificationId: coque.id, motivo: 'curto' }).expect(400);
      await t.http().post('/api/vigilancia/conciliacao/rejeitar').set(auth(vig)).send({ recordId: rec.id, notificationId: coque.id, motivo: 'Outra pessoa com o mesmo nome.' }).expect(200);
      expect((await sugeridas()).itens).toEqual([]);
      expect(await db.officialRecordRejection.count({ where: { recordId: rec.id, notificationId: coque.id } })).toBe(1);
      // Nova exportação com o mesmo registro: continua sem vínculo e sem sugestão.
      await aplicar(((await enviar(arquivo('VILA NOVA'), 'coqueluche-2.dbf')) as Detalhe).id);
      expect((await registro('8800002')).notificationId).toBeNull();
      expect((await sugeridas()).itens).toEqual([]);
    });

    it('vínculo manual preenche o número oficial pela regra da fila; o desvínculo com motivo não volta na importação seguinte', async () => {
      manual = await notificar('Hugo Manual Importacao', 'M', '1960-04-04', 'A27.9');
      const d = hoje();
      const arquivo = (bairro: string) => escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '0004321', DT_NOTIFIC: d, NM_PACIENT: 'NOME DIGITADO DIFERENTE', CS_SEXO: 'M', NM_BAIRRO: bairro })]);
      await aplicar(((await enviar(arquivo('CENTRO'), 'manual.dbf')) as Detalhe).id);
      const rec = await registro('0004321');
      expect(rec.notificationId).toBeNull();
      const so = (await t.http().get('/api/vigilancia/conciliacao/so-oficial').query({ busca: '0004321' }).set(auth(vig)).expect(200)).body;
      expect(so.itens.map((i: { id: string }) => i.id)).toEqual([rec.id]);
      const v = (await t.http().post('/api/vigilancia/conciliacao/vincular').set(auth(vig)).send({ recordId: rec.id, notificationId: manual.id, preencherNumeroOficial: true, motivo: 'Mesma ficha.' }).expect(200)).body;
      expect(v).toMatchObject({ recordId: rec.id, notificationId: manual.id, metodo: 'MANUAL', numeroOficialPreenchido: true });
      const n = (await t.http().get(`/api/vigilancia/notificacoes/${manual.id}`).set(auth(vig)).expect(200)).body;
      expect(n.saida).toMatchObject({ digitacao: 'DIGITADA', numero: '0004321' });
      expect(await registro('0004321')).toMatchObject({ notificationId: manual.id, matchMethod: 'MANUAL' });
      // Vincular de novo o mesmo registro: conflito.
      await t.http().post('/api/vigilancia/conciliacao/vincular').set(auth(vig)).send({ recordId: rec.id, notificationId: lepto.id }).expect(409);

      await t.http().post('/api/vigilancia/conciliacao/desvincular').set(auth(vig)).send({ recordId: rec.id, motivo: 'Vinculado por engano.' }).expect(200);
      expect(await registro('0004321')).toMatchObject({ notificationId: null, matchMethod: null });
      // A notificação tem agora o mesmo número oficial: o degrau 1 casaria os dois, mas o desvínculo virou rejeição.
      await aplicar(((await enviar(arquivo('VILA NOVA'), 'manual-2.dbf')) as Detalhe).id);
      expect((await registro('0004321')).notificationId).toBeNull();
      const auditoria = await db.auditEntry.findMany({ where: { entityId: rec.id }, select: { action: true } });
      expect(auditoria.map((a) => a.action)).toEqual(expect.arrayContaining(['vigilancia.conciliacao_vincular', 'vigilancia.conciliacao_desvincular']));
    });

    it('listas: só no OmniSaúde dentro da cobertura, divergentes e resumo', async () => {
      // A notificação de leptospirose sem registro oficial, de hoje, cai na cobertura do Sinan Net (importações de hoje).
      const outra = await notificar('Olga Omnisaude Importacao', 'F', '1970-05-05', 'A27.9');
      const so = (await t.http().get('/api/vigilancia/conciliacao/so-omnisaude').query({ busca: 'OLGA OMNISAUDE' }).set(auth(vig)).expect(200)).body;
      expect(so.itens.map((i: { id: string }) => i.id)).toEqual([outra.id]);
      // O par da dengue: o Sinan Online confirmou (CLASSI_FIN 10) e o OmniSaúde ainda investiga.
      const div = (await t.http().get('/api/vigilancia/conciliacao/divergentes').query({ busca: '7700001' }).set(auth(vig)).expect(200)).body;
      expect(div.itens[0]).toMatchObject({ notificacao: { id: dengue.id }, divergencias: expect.arrayContaining([{ campo: 'situacao', oficial: 'CONFIRMADO', omnisaude: 'EM_INVESTIGACAO' }]) });
      const resumo = (await t.http().get('/api/vigilancia/conciliacao/resumo').set(auth(vig)).expect(200)).body;
      expect(resumo.vinculados).toBeGreaterThanOrEqual(2);
      expect(resumo.cobertura).toEqual(expect.arrayContaining([expect.objectContaining({ sistema: 'SINAN_NET', grupos: null }), expect.objectContaining({ sistema: 'SINAN_ONLINE', grupos: ['dengue'] })]));
      expect(resumo.ultimaImportacao).toMatchObject({ id: expect.any(String) });
    });

    it('bairro sem correspondência no território vira apelido (exige territorio.editar), sem duplicar', async () => {
      const localidade = await db.locality.create({ data: { code: 'IMP', name: 'Localidade da Importação' } });
      const bairro = await db.neighborhood.create({ data: { localityId: localidade.id, name: 'Vila São José do Teste' } });
      const lista = async () => (await t.http().get('/api/vigilancia/conciliacao/bairros').set(auth(vig)).expect(200)).body as { nomeNormalizado: string; registros: number }[];
      // "VILA SÃO JOSÉ" veio do primeiro arquivo e saiu na segunda versão; o registro 6100003 traz "CENTRO" (bairro da demonstração).
      const arquivo = escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '6300001', DT_NOTIFIC: '2025-09-01', NM_BAIRRO: hex(PY.cp850['VILA SÃO JOSÉ']) })]);
      await aplicar(((await enviar(arquivo, 'bairro.dbf')) as Detalhe).id);
      expect((await lista()).find((b) => b.nomeNormalizado === 'VILA SAO JOSE')).toMatchObject({ registros: 1 });
      const r = (await t.http().post('/api/vigilancia/conciliacao/bairros/apelido').set(auth(vig)).send({ nome: 'VILA SÃO JOSÉ', neighborhoodId: bairro.id }).expect(200)).body;
      expect(r).toEqual({ neighborhoodId: bairro.id, apelidos: ['VILA SÃO JOSÉ'], registros: 1 });
      expect((await lista()).find((b) => b.nomeNormalizado === 'VILA SAO JOSE')).toBeUndefined();
      // De novo, com outra grafia: não duplica.
      const r2 = (await t.http().post('/api/vigilancia/conciliacao/bairros/apelido').set(auth(vig)).send({ nome: 'Vila Sao Jose', neighborhoodId: bairro.id }).expect(200)).body;
      expect(r2.apelidos).toEqual(['VILA SÃO JOSÉ']);
    });

    it('sigilo: sem notificacao.sensivel, o registro sigiloso sai sem identificação (lista e prévia)', async () => {
      const arquivo = escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '8800009', DT_NOTIFIC: '2025-08-01', ID_AGRAVO: 'O981', NM_PACIENT: 'SIGILOSA DA SILVA', CS_SEXO: 'F', DT_NASC: '1995-01-01' })]);
      const d = (await enviar(arquivo, 'sifilis.dbf')) as Detalhe;
      expect(d.previa!.novos[0]).toMatchObject({ paciente: 'SIGILOSA DA SILVA', sigiloso: true });
      const lista = async () => (await t.http().get('/api/vigilancia/conciliacao/so-oficial').query({ busca: '8800009' }).set(auth(vig)).expect(200)).body;
      await aplicar(d.id);
      expect((await lista()).itens[0]).toMatchObject({ sigiloso: true, paciente: { nome: 'SIGILOSA DA SILVA' } });
      const permissoes = ROLE_PERMISSIONS.VIGILANCIA_EPIDEMIOLOGICA as Permission[];
      const i = permissoes.indexOf('notificacao.sensivel');
      permissoes.splice(i, 1);
      try {
        expect((await lista()).itens[0]).toMatchObject({ sigiloso: true, paciente: null });
        const outra = escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '8800010', DT_NOTIFIC: '2025-08-02', ID_AGRAVO: 'O981', NM_PACIENT: 'OUTRA SIGILOSA', CS_SEXO: 'F' })]);
        const d2 = (await enviar(outra, 'sifilis-2.dbf')) as Detalhe;
        expect(d2.previa!.novos[0]).toMatchObject({ paciente: null, sigiloso: true });
      } finally {
        permissoes.splice(i, 0, 'notificacao.sensivel');
      }
      const auditoria = await db.auditEntry.count({ where: { action: 'vigilancia.conciliacao_ver_sensivel', entityId: (await registro('8800009')).id } });
      expect(auditoria).toBeGreaterThanOrEqual(1);
    });

    it('GESTOR não importa nem concilia (403)', async () => {
      await t.http().get('/api/vigilancia/importacoes').set(auth(gestora)).expect(403);
      await enviar(primeiro, 'gestor.dbf', {}, 403, gestora);
      await t.http().get('/api/vigilancia/conciliacao/resumo').set(auth(gestora)).expect(403);
      await t.http().post('/api/vigilancia/conciliacao/vincular').set(auth(gestora)).send({ recordId: dengue.id, notificationId: dengue.id }).expect(403);
    });
  });

  it('prévia: descartar apaga o payload; aplicar a descartada é recusado; a lista mostra quem fez', async () => {
    const arquivo = escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '6400001', DT_NOTIFIC: '2025-10-01' })]);
    const d = (await enviar(arquivo, 'descartar.dbf')) as Detalhe;
    const r = (await t.http().post(`/api/vigilancia/importacoes/${d.id}/descartar`).set(auth(vig)).expect(200)).body;
    expect(r).toMatchObject({ id: d.id, status: 'DESCARTADA' });
    expect(await db.officialImport.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'DESCARTADA', payload: null });
    await t.http().post(`/api/vigilancia/importacoes/${d.id}/aplicar`).set(auth(vig)).expect(409);
    const lista = (await t.http().get('/api/vigilancia/importacoes').set(auth(vig)).expect(200)).body as { id: string; status: string; descartadoPor: string | null; expirada: boolean }[];
    expect(lista.find((i) => i.id === d.id)).toMatchObject({ status: 'DESCARTADA', descartadoPor: 'Vera Lúcia Vigilância Epidemiológica', expirada: false });
    // Prévia vencida: o job a descarta sem usuário (expirada).
    const velha = (await enviar(escreverDbf(CAMPOS_NINDINET, [nindinet({ NU_NOTIFIC: '6400002', DT_NOTIFIC: '2025-10-02' })]), 'velha.dbf')) as Detalhe;
    await db.officialImport.update({ where: { id: velha.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    await t.http().post(`/api/vigilancia/importacoes/${velha.id}/aplicar`).set(auth(vig)).expect(409);
    expect(await db.officialImport.findUniqueOrThrow({ where: { id: velha.id } })).toMatchObject({ status: 'DESCARTADA', payload: null, discardedBy: null });
  });
});
