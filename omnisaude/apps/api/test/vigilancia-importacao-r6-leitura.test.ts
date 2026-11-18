import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { coberturaGravada } from '../src/modules/vigilancia/cobertura-importacao';
import { avisoCamposLimpos, limparCampo, limparTexto } from '../src/modules/vigilancia/importacao/controle';
import { lerCsvOficial } from '../src/modules/vigilancia/importacao/csv-oficial';
import { lerDbf } from '../src/modules/vigilancia/importacao/dbf';
import { abrirEnvio } from '../src/modules/vigilancia/importacao/entrada';
import { lerEnvio, type OpcoesLeitura } from '../src/modules/vigilancia/importacao/leitura';
import { CAMPOS_NINDINET, escreverDbf, type CampoEscrita, type ValorEscrita } from './helpers/dbf-escrita';

/*
 * Importação (VIG-1c), sexta rodada, sem banco:
 * - R6-3: o NUL e os demais caracteres de controle dentro do arquivo (célula do CSV, campo do DBF, nome da entrada do
 *   zip) saem na leitura, trocados por um espaço, com um aviso por arquivo; a tabulação e a quebra de linha da célula
 *   do CSV ficam; o texto com algum nulo perdido continua lido como CSV, e o binário continua fora;
 * - R6-2: cada entrada da cobertura dos ausentes leva o tipo do arquivo de onde veio (a base consolidada e a conciliação
 *   leem por ele o que o arquivo cobre), e só as linhas do sistema do arquivo contam nela; a cobertura gravada é
 *   conferida entrada a entrada.
 * Dados sintéticos.
 */

const OPCOES: OpcoesLeitura = { hoje: '2026-11-18', municipio: '3550308' };
const enc = (s: string) => new TextEncoder().encode(s);
const X = '9000011';
const LIMPOS = (n: number) => `${n} campo(s) com caractere de controle foram limpos (cada sequência deles virou um espaço).`;
const AVISO_NOME = 'O nome do arquivo dentro do zip tinha caractere de controle: foi limpo (cada sequência deles virou um espaço).';

async function ler(nome: string, bytes: Uint8Array) {
  const l = await lerEnvio(nome, bytes, OPCOES);
  const registros = [];
  for await (const lote of l.registros(50)) registros.push(...lote);
  l.fechar();
  return { l, registros };
}

/** CSV do e-SUS Notifica (síndrome gripal) com o nome e o bairro de cada linha. */
const csvSg = (linhas: [string, string, string][]) =>
  enc(
    `${['Número da Notificação', 'Data da Notificação', 'Município da Notificação', 'CNES Notificação', 'Nome Completo', 'Bairro', 'Sintoma- Febre', 'Classificação Final'].join(';')}\r\n${linhas
      .map(([n, nome, bairro]) => [n, '10/03/2022', '3550308', X, nome, bairro, 'Sim', 'Confirmado Laboratorial'].join(';'))
      .join('\r\n')}\r\n`,
  );
const sinan = (n: string, agravo: string, dt: string, v: Record<string, ValorEscrita> = {}) => ({
  NU_NOTIFIC: n,
  TP_NOT: '2',
  ID_AGRAVO: agravo,
  DT_NOTIFIC: dt,
  ID_MUNICIP: '355030',
  ID_UNIDADE: X,
  NM_PACIENT: `PACIENTE ${n}`,
  CS_SEXO: 'F',
  ...v,
});
const NIND: CampoEscrita[] = [...CAMPOS_NINDINET, { nome: 'CLASSI_FIN', tipo: 'C', tamanho: 2 }];
const LEPTONET: CampoEscrita[] = [...NIND, { nome: 'RES_ELISA', tipo: 'C', tamanho: 1 }];

describe('R6-3: caracteres de controle', () => {
  it('a célula do CSV perde o NUL, o DEL e os C0/C1 (cada sequência vira um espaço), e guarda a tabulação e a quebra de linha', () => {
    expect(limparTexto('Vila\u0000Nova')).toBe('Vila Nova');
    expect(limparTexto('a\u0000\u0001\u001fb\u007fc\u0085d')).toBe('a b c d');
    expect(limparTexto('linha 1\r\nlinha\t2')).toBeNull();
    expect(limparTexto('sem nada')).toBeNull();
    // O campo do DBF e o nome da entrada do zip não usam tabulação nem quebra de linha: saem também.
    expect(limparCampo('A\tB\r\nC\u0000D')).toBe('A B C D');
    expect(limparCampo('CENTRO')).toBeNull();
    expect(avisoCamposLimpos(1234)).toBe('1.234 campo(s) com caractere de controle foram limpos (cada sequência deles virou um espaço).');
  });

  it('CSV: as células com caractere de controle saem limpas, com um aviso que conta as células; a quebra de linha dentro das aspas fica', () => {
    const csv = enc('"numero";"nome";"obs"\r\n"1";"Ana\u0000Maria";"linha 1\r\nlinha 2"\r\n"2";"Bia\u0001\u0002Lima";"com\ttab"\r\n"3";"Caio";"ok"\r\n');
    const l = lerCsvOficial(csv);
    expect([...l.linhas()].map((x) => [x.numero, x.nome, x.obs])).toEqual([
      ['1', 'Ana Maria', 'linha 1\r\nlinha 2'],
      ['2', 'Bia Lima', 'com\ttab'],
      ['3', 'Caio', 'ok'],
    ]);
    expect(l.avisos).toEqual([LIMPOS(2)]);
  });

  it('DBF: o NUL no meio do campo vira espaço, com aviso; o NUL de preenchimento no fim do campo continua só aparado', () => {
    const preenchido = new Uint8Array([...enc('CENTRO'), 0, 0, 0]);
    const dbf = escreverDbf(CAMPOS_NINDINET, [sinan('0000001', 'A279', '2025-03-05', { NM_BAIRRO: 'VILA\u0000NOVA' }), sinan('0000002', 'A279', '2025-03-06', { NM_BAIRRO: preenchido, NM_PACIENT: 'JOSE\u0007SILVA' })]);
    const l = lerDbf(dbf);
    expect([...l.linhas()].map((x) => [x.NU_NOTIFIC, x.NM_BAIRRO, x.NM_PACIENT])).toEqual([
      ['0000001', 'VILA NOVA', 'PACIENTE 0000001'],
      ['0000002', 'CENTRO', 'JOSE SILVA'],
    ]);
    expect(l.avisos).toEqual([LIMPOS(2)]);
  });

  it('zip: o nome da entrada com caractere de controle é limpo (a aceita e a fora da importação), e o arquivo ganha o aviso', async () => {
    const zip = zipSync({ 'ubs\u0000x.csv': csvSg([['352200000001', 'Ana', 'Centro']]), 'leia\u0007\u0008me.txt': enc('nada'), 'ok.csv': csvSg([['352200000002', 'Bia', 'Centro']]) });
    expect(abrirEnvio('unidades.zip', zip).map((e) => [e.nome, e.nomeLimpo ?? false, e.ignorado ?? null])).toEqual(
      expect.arrayContaining([
        ['ok.csv', false, null],
        ['ubs x.csv', true, null],
        ['leia me.txt', true, 'não é .dbf nem .csv'],
      ]),
    );
    const { l, registros } = await ler('unidades.zip', zip);
    expect(registros).toHaveLength(2);
    expect(l.arquivos.map((a) => [a.nome, a.ignorado, a.avisos.includes(AVISO_NOME)]).sort()).toEqual([
      ['leia me.txt', true, true],
      ['ok.csv', false, false],
      ['ubs x.csv', false, true],
    ]);
  });

  it('o CSV com NUL perdido no começo continua lido como CSV, com o aviso; o binário (nulo em mais de 1% do começo) e o UTF-16 continuam fora', async () => {
    const { l, registros } = await ler('nul-comeco.csv', csvSg([['352200000011', 'Ana\u0000Maria', 'Jardim\u0000\u0000Sul']]));
    expect(l.arquivos.map((a) => [a.tipo, a.ignorado, a.avisos])).toEqual([['ESUS_NOTIFICA_CSV', false, [LIMPOS(2)]]]);
    expect(registros[0]!.partes[0]).toMatchObject({ identificacao: expect.objectContaining({ nome: 'Ana Maria' }), bairroNome: 'Jardim Sul' });
    // Um binário qualquer (4 KB com 1 nulo a cada 50 bytes, 2%) e o mesmo CSV em UTF-16 (um nulo a cada dois bytes).
    const binario = new Uint8Array(4096).map((_, i) => (i % 50 === 0 ? 0 : 65 + (i % 26)));
    const utf16 = Buffer.from(new TextDecoder().decode(csvSg([['352200000012', 'Bia', 'Centro']])), 'utf16le');
    for (const [nome, bytes] of [
      ['dados.csv', binario],
      ['utf16.csv', utf16],
    ] as const) {
      const fora = await ler(nome, bytes);
      expect(fora.l.arquivos.map((a) => [a.nome, a.ignorado, a.avisos])).toEqual([[nome, true, ['Formato não reconhecido (nem DBF nem CSV)']]]);
      expect(fora.registros).toEqual([]);
    }
  });
});

describe('R6-2: a entrada da cobertura leva o tipo do arquivo', () => {
  it('o NINDINET com linhas de dengue: a entrada (Sinan Net) tem só as linhas do Sinan Net; o files[] mostra todas', async () => {
    const { l } = await ler(
      'NINDINET2022.DBF',
      escreverDbf(NIND, [
        sinan('2200001', 'A279', '2022-01-10'),
        sinan('2200002', 'A279', '2022-06-10'),
        sinan('2209001', 'A90', '2022-09-20', { CLASSI_FIN: '10' }),
        sinan('2209002', 'A90', '2022-12-20', { CLASSI_FIN: '10' }),
      ]),
    );
    expect(l.arquivos.map((a) => [a.tipo, a.agravos, a.periodo])).toEqual([['NINDINET', ['A279', 'A90'], { de: '2022-01-10', ate: '2022-12-20' }]]);
    expect(l.cobertura(null, OPCOES.municipio).cobertura.map((c) => [c.tipoArquivo, c.sistema, c.agravos, c.de, c.ate])).toEqual([['NINDINET', 'SINAN_NET', ['A279'], '2022-01-10', '2022-06-10']]);
  });

  it('o NINDINET e o DBF do agravo com as mesmas linhas não se juntam numa entrada só (o tipo do arquivo entra na comparação)', async () => {
    const { l } = await ler(
      'sinan-net.zip',
      zipSync({
        'NINDINET.DBF': escreverDbf(NIND, [sinan('0000101', 'A279', '2025-03-05'), sinan('0000102', 'A279', '2025-04-01')]),
        'LEPTONET.DBF': escreverDbf(LEPTONET, [sinan('0000101', 'A279', '2025-03-05', { RES_ELISA: '1' }), sinan('0000102', 'A279', '2025-04-01', { RES_ELISA: '1' })]),
      }),
    );
    expect(l.arquivos.map((a) => [a.nome, a.tipo])).toEqual([
      ['LEPTONET.DBF', 'AGRAVO_NET'],
      ['NINDINET.DBF', 'NINDINET'],
    ]);
    expect(l.cobertura(null, OPCOES.municipio).cobertura.map((c) => [c.tipoArquivo, c.sistema, c.agravos, c.de, c.ate])).toEqual([
      ['AGRAVO_NET', 'SINAN_NET', ['A279'], '2025-03-05', '2025-04-01'],
      ['NINDINET', 'SINAN_NET', ['A279'], '2025-03-05', '2025-04-01'],
    ]);
  });

  it('a cobertura gravada é conferida entrada a entrada: o tipo do arquivo é opcional (gravada antes da regra), mas fora da lista não vale', () => {
    const entrada = { sistema: 'SINAN_NET', tipo: 'INDIVIDUAL', agravos: ['A279'], de: '2022-01-10', ate: '2022-06-10', municipios: ['355030'], municipioNulo: false };
    expect(coberturaGravada({ cobertura: [{ ...entrada, tipoArquivo: 'NINDINET' }, entrada, { ...entrada, tipoArquivo: 'PLANILHA' }, { ...entrada, de: '10/01/2022' }] })).toEqual([
      { ...entrada, tipoArquivo: 'NINDINET' },
      entrada,
    ]);
    expect(coberturaGravada({ voltaram: 0 })).toEqual([]);
    expect(coberturaGravada(null)).toEqual([]);
  });
});
