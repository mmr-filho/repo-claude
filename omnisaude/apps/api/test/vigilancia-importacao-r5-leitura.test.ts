import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { lerEnvio, type OpcoesLeitura } from '../src/modules/vigilancia/importacao/leitura';
import { CAMPOS_NINDINET, escreverDbf, type CampoEscrita, type ValorEscrita } from './helpers/dbf-escrita';

/*
 * Importação (VIG-1c), quinta rodada, sem banco (R5-1): a cobertura dos ausentes é a lista das coberturas de cada
 * arquivo, somada linha a linha na leitura (a mesma conta do `cnes` de official_imports.files). Cada arquivo cobre o
 * sistema e o tipo dele, os agravos (no e-SUS Notifica, as fichas) e o período dos registros que vieram dele (ou o
 * declarado) e, no e-SUS, o CNES dele quando traz um só; as entradas iguais se juntam com os CNES unidos. Dados
 * sintéticos.
 */

const OPCOES: OpcoesLeitura = { hoje: '2026-11-17', municipio: '3550308' };
const enc = (s: string) => new TextEncoder().encode(s);
const X = '9000011';
const Y = '9000028';

async function ler(nome: string, bytes: Uint8Array) {
  const l = await lerEnvio(nome, bytes, OPCOES);
  l.fechar();
  return l;
}

/** CSV do e-SUS Notifica (síndrome gripal): número, CNES e data (DD/MM/AAAA) de cada linha. */
const csvSg = (linhas: [string, string | null, string][]) =>
  enc(
    `${['Número da Notificação', 'Data da Notificação', 'Município da Notificação', 'CNES Notificação', 'Nome Completo', 'Sintoma- Febre', 'Classificação Final'].join(';')}\r\n${linhas
      .map(([n, cnes, data]) => [n, data, '3550308', cnes ?? '', `Pessoa ${n}`, 'Sim', 'Confirmado Laboratorial'].join(';'))
      .join('\r\n')}\r\n`,
  );
/** CSV do e-SUS Sinan: número, agravo (CID) e CNES de cada linha, todos em 10/03/2026. */
const csvEsusSinan = (linhas: [string, string, string][]) =>
  enc(
    '"nu_notific";"id_agravo";"dt_notific";"id_municip";"id_unidade";"classi_fin";"evolucao"\r\n' + linhas.map(([n, agravo, cnes]) => `"${n}";"${agravo}";"10/03/2026";"355030";"${cnes}";"1";"1"`).join('\r\n') + '\r\n',
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
const DENGON: CampoEscrita[] = [...CAMPOS_NINDINET, { nome: 'CLASSI_FIN', tipo: 'C', tamanho: 2 }, { nome: 'FEBRE', tipo: 'C', tamanho: 1 }];
/** DBF do agravo (ficha de investigação da leptospirose: uma coluna fora da notificação individual). */
const LEPTONET: CampoEscrita[] = [...CAMPOS_NINDINET, { nome: 'CLASSI_FIN', tipo: 'C', tamanho: 2 }, { nome: 'RES_ELISA', tipo: 'C', tamanho: 1 }];

describe('R5-1: a cobertura dos ausentes é a de cada arquivo', () => {
  it('e-SUS Notifica e e-SUS Sinan: o período e os agravos de um arquivo não valem para o outro', async () => {
    const sg = await ler(
      'unidades.zip',
      zipSync({
        'ubs-x.csv': csvSg([['352400001101', X, '10/06/2024']]),
        'ubs-y.csv': csvSg([
          ['352400001103', Y, '10/06/2024'],
          ['352400001104', Y, '10/08/2024'],
        ]),
      }),
    );
    expect(sg.cobertura(null, OPCOES.municipio).cobertura.map((c) => [c.cnes, c.de, c.ate, c.grupos])).toEqual([
      [[X], '2024-06-10', '2024-06-10', ['covid']],
      [[Y], '2024-06-10', '2024-08-10', ['covid']],
    ]);
    const esusSinan = await ler('esus-sinan.zip', zipSync({ 'x-mpox.csv': csvEsusSinan([['352600002101', 'B04', X]]), 'y-esporotricose.csv': csvEsusSinan([['352600002103', 'B42', Y]]) }));
    expect(esusSinan.cobertura(null, OPCOES.municipio).cobertura.map((c) => [c.sistema, c.agravos, c.cnes])).toEqual([
      ['ESUS_SINAN', ['B04'], [X]],
      ['ESUS_SINAN', ['B42'], [Y]],
    ]);
  });

  it('Sinan: o zip com o DENGON de 2023 e o de 2025 cobre os dois períodos, não 2024', async () => {
    const l = await ler(
      'dengue.zip',
      zipSync({
        'DENGON2023.DBF': escreverDbf(DENGON, [sinan('0023001', 'A90', '2023-03-13', { CLASSI_FIN: '10', FEBRE: '1' }), sinan('0023002', 'A90', '2023-11-20', { CLASSI_FIN: '10', FEBRE: '1' })]),
        'DENGON2025.DBF': escreverDbf(DENGON, [sinan('0025001', 'A90', '2025-02-03', { CLASSI_FIN: '10', FEBRE: '1' }), sinan('0025002', 'A90', '2025-10-06', { CLASSI_FIN: '10', FEBRE: '1' })]),
      }),
    );
    expect(l.arquivos.map((a) => a.tipo)).toEqual(['DENGON', 'DENGON']);
    expect(l.cobertura(null, OPCOES.municipio).cobertura.map((c) => [c.sistema, c.agravos, c.de, c.ate])).toEqual([
      ['SINAN_ONLINE', ['A90'], '2023-03-13', '2023-11-20'],
      ['SINAN_ONLINE', ['A90'], '2025-02-03', '2025-10-06'],
    ]);
  });

  it('o registro do NINDINET com o DBF do agravo entra na cobertura de cada um dos dois arquivos; a dengue do NINDINET não cobre o Sinan Net', async () => {
    const l = await ler(
      'sinan-net.zip',
      zipSync({
        'NINDINET.DBF': escreverDbf(CAMPOS_NINDINET, [sinan('0000101', 'A279', '2025-03-05'), sinan('0000102', 'A379', '2025-02-10'), sinan('0000103', 'B19', '2025-03-20'), sinan('0000104', 'A90', '2025-01-02')]),
        'LEPTONET.DBF': escreverDbf(LEPTONET, [sinan('0000101', 'A279', '2025-03-05', { CLASSI_FIN: '1', RES_ELISA: '1' }), sinan('0000105', 'A279', '2025-04-01', { CLASSI_FIN: '1', RES_ELISA: '1' })]),
      }),
    );
    expect(l.arquivos.map((a) => [a.nome, a.tipo])).toEqual([
      ['LEPTONET.DBF', 'AGRAVO_NET'],
      ['NINDINET.DBF', 'NINDINET'],
    ]);
    // A leptospirose 0000101 (03/05) está nos dois arquivos: cada um cobre a data dela.
    expect(l.cobertura(null, OPCOES.municipio).cobertura.map((c) => [c.sistema, c.agravos, c.de, c.ate])).toEqual([
      ['SINAN_NET', ['A279'], '2025-03-05', '2025-04-01'],
      ['SINAN_NET', ['A279', 'A379', 'B19'], '2025-02-10', '2025-03-20'],
    ]);
  });

  it('a mesma chave em dois arquivos do mesmo tipo (o mesmo número em duas unidades): os dois arquivos mantêm a cobertura e o CNES', async () => {
    // O número 352400002101 aparece nos CSV de X e de Y: o registro fica com a parte do último arquivo (Y), e o arquivo de
    // X, sem nenhuma parte, não ficava na cobertura (o limite do N0 na quarta rodada). Na leitura linha a linha, o arquivo
    // de X continua cobrindo X no período dele.
    const l = await ler(
      'mesmo-numero.zip',
      zipSync({
        'ubs-x.csv': csvSg([['352400002101', X, '10/06/2024']]),
        'ubs-y.csv': csvSg([
          ['352400002101', Y, '15/06/2024'],
          ['352400002102', Y, '20/06/2024'],
        ]),
      }),
    );
    expect(l.arquivos.map((a) => [a.nome, a.cnes])).toEqual([
      ['ubs-x.csv', X],
      ['ubs-y.csv', Y],
    ]);
    expect(l.avisos.join(' ')).toContain('1 registro(s) repetido(s) em mais de um arquivo do mesmo tipo');
    expect(l.cobertura(null, OPCOES.municipio).cobertura.map((c) => [c.cnes, c.de, c.ate])).toEqual([
      [[X], '2024-06-10', '2024-06-10'],
      [[Y], '2024-06-15', '2024-06-20'],
    ]);
  });

  it('as entradas iguais ficam numa só, com os CNES unidos; o aviso agrega os arquivos de um estabelecimento só quando são muitos', async () => {
    const unidades = Array.from({ length: 7 }, (_, i) => `90001${String(10 + i)}`);
    const arquivos: Record<string, Uint8Array> = {
      'municipio.csv': csvSg([
        ['352400003001', X, '10/06/2024'],
        ['352400003002', Y, '10/06/2024'],
      ]),
    };
    unidades.forEach((cnes, i) => (arquivos[`ubs-${i + 1}.csv`] = csvSg([[`3524000031${String(i).padStart(2, '0')}`, cnes, '10/06/2024']])));
    const l = await ler('muitas.zip', zipSync(arquivos));
    const { cobertura, avisos } = l.cobertura(null, OPCOES.municipio);
    // O CSV do município (dois CNES) cobre o município inteiro; os 7 das unidades (o mesmo período) viram uma entrada.
    expect(cobertura).toHaveLength(2);
    expect(cobertura[0]).not.toHaveProperty('cnes');
    expect(cobertura[1]).toMatchObject({ cnes: [...unidades].sort(), de: '2024-06-10', ate: '2024-06-10' });
    expect(avisos).toContain(
      `e-SUS Notifica: 7 arquivo(s) de um estabelecimento só (${unidades
        .slice(0, 5)
        .map((c, i) => `ubs-${i + 1}.csv, CNES ${c}`)
        .join('; ')}; e mais 2): os ausentes de cada um valem só para o estabelecimento dele. Os outros arquivos do e-SUS Notifica valem para o município inteiro.`,
    );
  });

  it('o período declarado vale para todos os arquivos (as entradas se juntam), e o fim de cada uma para no primeiro envio do arquivo', async () => {
    const l = await ler(
      'declarado.zip',
      zipSync({
        'ubs-x.csv': csvSg([['352400004001', X, '10/06/2024']]),
        'ubs-y.csv': csvSg([['352400004002', Y, '10/08/2024']]),
      }),
    );
    const ano = { de: '2024-01-01', ate: '2024-12-31' };
    expect(l.cobertura(ano, OPCOES.municipio).cobertura.map((c) => [c.cnes, c.de, c.ate])).toEqual([[[X, Y], '2024-01-01', '2024-12-31']]);
    expect(l.cobertura(ano, OPCOES.municipio, '2024-09-30').cobertura.map((c) => [c.cnes, c.de, c.ate])).toEqual([[[X, Y], '2024-01-01', '2024-09-30']]);
    // Sem período declarado, o fim de cada arquivo para no primeiro envio: o de Y (só agosto) não cobre nada.
    expect(l.cobertura(null, OPCOES.municipio, '2024-07-31').cobertura.map((c) => [c.cnes, c.de, c.ate])).toEqual([[[X], '2024-06-10', '2024-06-10']]);
  });
});
