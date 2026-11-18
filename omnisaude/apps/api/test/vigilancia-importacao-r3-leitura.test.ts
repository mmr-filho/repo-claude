import { Zip, ZipPassThrough, zipSync } from 'fflate';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErroArquivo } from '../src/modules/vigilancia/importacao/dbf';
import { abrirEnvio } from '../src/modules/vigilancia/importacao/entrada';
import { lerEnvio, MAX_IGNORADOS, type OpcoesLeitura, type RegistroDoEnvio } from '../src/modules/vigilancia/importacao/leitura';
import { EscritorPayload, LeitorPayload } from '../src/modules/vigilancia/importacao/payload';
import { CAMPOS_NINDINET, escreverDbf, type CampoEscrita, type ValorEscrita } from './helpers/dbf-escrita';

/*
 * Importação (VIG-1c), terceira rodada, leitura sem banco: teto de entradas no diretório central do zip e lista dos
 * ignorados com "mais X" (IMPORTACAO-1), uma parte por tipo de arquivo e lotes fechados pelas partes (IMPORTACAO-2), a
 * planilha do surto dentro do NSURTNET (imp-planilha-surto) e o CNES único do arquivo (contrato com a conciliação).
 * Dados sintéticos.
 */

const OPCOES: OpcoesLeitura = { hoje: '2026-11-17', municipio: '3550308' };
const enc = (s: string) => new TextEncoder().encode(s);

async function lerTudo(nome: string, bytes: Uint8Array, tamanho = 500) {
  const l = await lerEnvio(nome, bytes, OPCOES);
  try {
    const lotes: RegistroDoEnvio[][] = [];
    for await (const lote of l.registros(tamanho)) lotes.push(lote);
    return { l, lotes, registros: lotes.flat() };
  } finally {
    l.fechar();
  }
}

/** Zip montado pelo fflate (arquivos pequenos, guardados sem compressão). */
function zipar(arquivos: [string, Uint8Array][]): Buffer {
  const partes: Uint8Array[] = [];
  const z = new Zip((e, d) => {
    if (e) throw e;
    partes.push(d);
  });
  for (const [nome, dados] of arquivos) {
    const f = new ZipPassThrough(nome);
    z.add(f);
    f.push(dados, true);
  }
  z.end();
  return Buffer.concat(partes);
}

/** Zip64 escrito à mão: um arquivo local de 1 byte e `qtd` entradas no diretório central apontando para ele. */
function zipComEntradas(qtd: number): Buffer {
  const base = zipar([['a.txt', Uint8Array.of(0x41)]]);
  const cd = base.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const local = base.subarray(0, cd);
  const modelo = base.subarray(cd, cd + 46);
  const nomeLen = 12;
  const dir = Buffer.alloc(qtd * (46 + nomeLen));
  for (let i = 0; i < qtd; i++) {
    const o = i * (46 + nomeLen);
    modelo.copy(dir, o);
    dir.writeUInt16LE(nomeLen, o + 28);
    dir.writeUInt16LE(0, o + 30);
    dir.writeUInt16LE(0, o + 32);
    dir.writeUInt32LE(0, o + 42);
    dir.write(`x${String(i).padStart(7, '0')}.txt`, o + 46, 'latin1');
  }
  const z64 = Buffer.alloc(56);
  z64.writeUInt32LE(0x06064b50, 0);
  z64.writeBigUInt64LE(44n, 4);
  z64.writeUInt16LE(45, 12);
  z64.writeUInt16LE(45, 14);
  z64.writeBigUInt64LE(BigInt(qtd), 24);
  z64.writeBigUInt64LE(BigInt(qtd), 32);
  z64.writeBigUInt64LE(BigInt(dir.length), 40);
  z64.writeBigUInt64LE(BigInt(local.length), 48);
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  loc.writeBigUInt64LE(BigInt(local.length + dir.length), 8);
  loc.writeUInt32LE(1, 16);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([local, dir, z64, loc, eocd]);
}

/** CSV do e-SUS Notifica (síndrome gripal), com o CNES de cada linha. */
function csvEsus(linhas: { numero: string; cnes: string | null; bairro?: string }[]): Uint8Array {
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
    'Sexo',
    'Sintoma- Febre',
    'Evolução Caso',
    'Classificação Final',
    'Bairro',
  ];
  const corpo = linhas.map((l, i) => {
    const d = `${String(1 + (i % 28)).padStart(2, '0')}/03/2025`;
    return [
      l.numero,
      d,
      d,
      'São Paulo',
      '3550308',
      'São Paulo',
      '3550308',
      l.cnes ?? '',
      `Pessoa Sintetica ${l.numero}`,
      i % 2 ? 'Feminino' : 'Masculino',
      'Sim',
      'Cura',
      'Confirmado Laboratorial',
      l.bairro ?? 'Centro',
    ].join(';');
  });
  return enc(`${[cab.join(';'), ...corpo].join('\r\n')}\r\n`);
}

const esus20 = () => csvEsus(Array.from({ length: 20 }, (_, i) => ({ numero: String(352500000000 + i), cnes: '9000011' })));

describe('IMPORTACAO-1: zip com muitas entradas no diretório central', () => {
  it('acima de 1.000 entradas, o envio inteiro é recusado antes de montar a lista (sem objeto por entrada)', async () => {
    const zip = zipComEntradas(5_000);
    const t0 = performance.now();
    let erro: unknown = null;
    try {
      abrirEnvio('envio.zip', zip);
    } catch (e) {
      erro = e;
    }
    expect(performance.now() - t0).toBeLessThan(200);
    expect(erro).toBeInstanceOf(ErroArquivo);
    expect(erro).toMatchObject({ recusaEnvio: true, message: 'O zip tem mais de 1.000 arquivos. Envie só os DBF ou CSV da exportação (em mais de um zip, se precisar).' });
    await expect(lerEnvio('envio.zip', zip, OPCOES)).rejects.toMatchObject({ recusaEnvio: true, message: expect.stringContaining('mais de 1.000 arquivos') });
  });

  it('no teto, os ignorados ficam na lista só até 50, com uma linha "mais X" (lista, avisos e o erro sem registros)', async () => {
    const txts: [string, Uint8Array][] = Array.from({ length: 999 }, (_, i) => [`leia-me-${String(i).padStart(4, '0')}.txt`, enc('x')]);
    const { l, registros } = await lerTudo('envio.zip', zipar([['notifica.csv', esus20()], ...txts]));
    expect(registros).toHaveLength(20);
    const ignorados = l.arquivos.filter((a) => a.ignorado);
    expect(ignorados).toHaveLength(MAX_IGNORADOS + 1);
    expect(ignorados.at(-1)).toMatchObject({ nome: '(mais 949 arquivo(s) fora da importação)', tipo: 'DESCONHECIDO', ignorado: true, cnes: null });
    expect(l.arquivos.filter((a) => !a.ignorado).map((a) => a.nome)).toEqual(['notifica.csv']);
    expect(l.avisos.filter((a) => a.includes('fora da importação'))).toHaveLength(MAX_IGNORADOS + 1);
    expect(l.avisos).toContain('E mais 949 arquivo(s) fora da importação.');

    // Só ignorados: a leitura termina e o que vai para o erro sem registros (arquivos e avisos) fica pequeno.
    const so = await lerEnvio('envio.zip', zipar(txts), OPCOES);
    so.fechar();
    expect(so.arquivos).toHaveLength(MAX_IGNORADOS + 1);
    expect(JSON.stringify({ arquivos: so.arquivos, avisos: so.avisos }).length).toBeLessThan(20_000);
  });
});

describe('IMPORTACAO-2: o mesmo arquivo repetido no zip e os lotes pelas partes', () => {
  it('300 cópias do mesmo CSV: uma parte por registro (a do último arquivo), com aviso, sem contar duplicado', async () => {
    const csv = esus20();
    const copias: [string, Uint8Array][] = Array.from({ length: 300 }, (_, i) => [`semana${String(i).padStart(6, '0')}.csv`, csv]);
    const { l, lotes, registros } = await lerTudo('copias.zip', zipSync(Object.fromEntries(copias)));
    expect(l.lidos).toBe(6_000);
    expect(registros).toHaveLength(20);
    expect(registros.every((r) => r.partes.length === 1)).toBe(true);
    expect(lotes).toHaveLength(1);
    expect(l.duplicadosNoArquivo).toBe(0);
    expect(l.avisos).toContain(
      '5.980 registro(s) repetido(s) em mais de um arquivo do mesmo tipo (e-SUS Notifica (CSV)): ficou a versão do último arquivo lido (semana000299.csv). Confira se o zip não traz a mesma exportação duas vezes.',
    );
  });

  it('dois arquivos do mesmo tipo com a mesma chave: fica a do último; a chave só do primeiro continua', async () => {
    const a = csvEsus([
      { numero: '352500000001', cnes: '9000011', bairro: 'Centro' },
      { numero: '352500000002', cnes: '9000011', bairro: 'Centro' },
    ]);
    const b = csvEsus([{ numero: '352500000001', cnes: '9000011', bairro: 'Vila Nova' }]);
    const { registros } = await lerTudo(
      'dois.zip',
      zipar([
        ['a.csv', a],
        ['b.csv', b],
      ]),
    );
    expect(registros.map((r) => [r.chave, r.partes.length, r.partes[0]!.bairroNome])).toEqual([
      ['352500000001', 1, 'Vila Nova'],
      ['352500000002', 1, 'Centro'],
    ]);
  });

  it('o lote fecha pelo número de partes: dois registros com três partes (NINDINET, DBF do agravo e DENGON) não cabem juntos em lotes de 2', async () => {
    const investigacao: CampoEscrita[] = [...CAMPOS_NINDINET, { nome: 'CLASSI_FIN', tipo: 'C', tamanho: 2 }, { nome: 'CRITERIO', tipo: 'C', tamanho: 1 }, { nome: 'FEBRE', tipo: 'C', tamanho: 1 }];
    const caso = (n: string, agravo: string, v: Record<string, ValorEscrita> = {}) => ({
      NU_NOTIFIC: n,
      TP_NOT: '2',
      ID_AGRAVO: agravo,
      DT_NOTIFIC: '2026-03-02',
      ID_MUNICIP: '355030',
      ID_UNIDADE: '9000011',
      NM_PACIENT: `CASO ${n}`,
      ...v,
    });
    const zip = zipar([
      ['AGRAVO.DBF', escreverDbf(investigacao, [caso('7000001', 'A90', { FEBRE: '1' }), caso('7000002', 'A90', { FEBRE: '1' }), caso('7000003', 'A279', { FEBRE: '1' })])],
      ['DENGON.DBF', escreverDbf(investigacao, [caso('7000001', 'A90', { FEBRE: '1' }), caso('7000002', 'A90', { FEBRE: '1' })])],
      ['NINDINET.DBF', escreverDbf(CAMPOS_NINDINET, [caso('7000001', 'A90'), caso('7000002', 'A90')])],
    ]);
    const { l, lotes } = await lerTudo('tres.zip', zip, 2);
    expect(l.arquivos.map((a) => a.tipo)).toEqual(['AGRAVO_NET', 'DENGON', 'NINDINET']);
    const forma = (ls: RegistroDoEnvio[][]) => ls.map((lote) => lote.map((r) => `${r.chave.split('|')[0]}:${r.partes.map((p) => p.tipoArquivo).join('+')}`));
    expect(forma(lotes)).toEqual([['7000001:NINDINET+AGRAVO_NET+DENGON'], ['7000002:NINDINET+AGRAVO_NET+DENGON', '7000003:AGRAVO_NET']]);

    // O payload da prévia, relido na aplicação, fecha os lotes do mesmo jeito.
    const pasta = mkdtempSync(join(tmpdir(), 'omni-r3-payload-'));
    try {
      const escritor = new EscritorPayload(join(pasta, 'payload.gz'));
      for (const lote of lotes) await escritor.escrever(lote);
      await escritor.fechar([]);
      const gz = readFileSync(join(pasta, 'payload.gz'));
      const leitor = new LeitorPayload(
        (async function* () {
          yield gz;
        })(),
      );
      const relidos: RegistroDoEnvio[][] = [];
      for await (const lote of leitor.lotes(2)) relidos.push(lote);
      expect(forma(relidos)).toEqual(forma(lotes));
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });
});

describe('imp-planilha-surto: a planilha dentro do NSURTNET.DBF (com NU_CASO)', () => {
  it('o surto fica com a DT_PRIM_SI e sem os campos de caso; as linhas de caso não contam como duplicadas', async () => {
    const junto: CampoEscrita[] = [
      { nome: 'NU_NOTIFIC', tipo: 'C', tamanho: 7 },
      { nome: 'TP_NOT', tipo: 'C', tamanho: 1 },
      { nome: 'ID_AGRAVO', tipo: 'C', tamanho: 4 },
      { nome: 'DT_NOTIFIC', tipo: 'D', tamanho: 8 },
      { nome: 'ID_MUNICIP', tipo: 'C', tamanho: 6 },
      { nome: 'ID_UNIDADE', tipo: 'C', tamanho: 7 },
      { nome: 'DT_PRIM_SI', tipo: 'D', tamanho: 8 },
      { nome: 'QT_TOTAL_C', tipo: 'C', tamanho: 5 },
      { nome: 'CS_LOCAL', tipo: 'C', tamanho: 2 },
      { nome: 'NU_CASO', tipo: 'N', tamanho: 5 },
      { nome: 'NM_LOCAL', tipo: 'C', tamanho: 30 },
      { nome: 'ID_MUNI_RE', tipo: 'C', tamanho: 6 },
      { nome: 'CS_SEXO', tipo: 'C', tamanho: 1 },
      { nome: 'NU_IDADE_N', tipo: 'N', tamanho: 4 },
      { nome: 'DT_SIN_PRI', tipo: 'D', tamanho: 8 },
      { nome: 'DT_OBITO', tipo: 'D', tamanho: 8 },
    ];
    const chave = { NU_NOTIFIC: '0000020', ID_AGRAVO: 'A08', DT_NOTIFIC: '2026-03-10', ID_MUNICIP: '355030', ID_UNIDADE: '9000011' };
    const linhas = [1, 2, 3].map((n) => ({
      ...chave,
      TP_NOT: '3',
      DT_PRIM_SI: '2026-03-07',
      QT_TOTAL_C: '12',
      CS_LOCAL: '3',
      NU_CASO: n,
      NM_LOCAL: 'A.B.C.',
      ID_MUNI_RE: '520870',
      CS_SEXO: n % 2 ? 'F' : 'M',
      NU_IDADE_N: 4030 + n,
      DT_SIN_PRI: `2026-03-0${7 + n}`,
      DT_OBITO: n === 3 ? '2026-03-12' : '',
    }));
    const { l, registros } = await lerTudo('NSURTNET.DBF', escreverDbf(junto, linhas));
    expect(l.arquivos[0]).toMatchObject({ tipo: 'NSURTNET', ignorado: false, registros: 3 });
    expect(l.duplicadosNoArquivo).toBe(0);
    expect(l.duplicados).toEqual([]);
    expect(l.arquivos[0]!.avisos.some((a) => a.includes('repetida'))).toBe(false);
    expect(registros).toHaveLength(1);
    const p = registros[0]!.partes[0]!;
    expect(p).toMatchObject({ tipo: 'SURTO', inicioSintomas: '2026-03-07', semanaSintomas: '202609', municipioResidencia: null, obitoEm: null, identificacao: null });
    expect(p.extras).toMatchObject({ qt_total_c: '12', cs_local: '3' });
    expect(Object.keys(p.extras)).not.toContain('nm_local');
    expect(p.colunas).not.toContain('municipioResidencia');
    expect(p.colunas).not.toContain('obitoEm');
    expect(p.colunas).toContain('inicioSintomas');
  });

  it('NSURTNET sem a planilha e sem DT_PRIM_SI: a DT_SIN_PRI continua valendo como a do surto', async () => {
    const surto: CampoEscrita[] = [
      { nome: 'NU_NOTIFIC', tipo: 'C', tamanho: 7 },
      { nome: 'TP_NOT', tipo: 'C', tamanho: 1 },
      { nome: 'ID_AGRAVO', tipo: 'C', tamanho: 4 },
      { nome: 'DT_NOTIFIC', tipo: 'D', tamanho: 8 },
      { nome: 'ID_MUNICIP', tipo: 'C', tamanho: 6 },
      { nome: 'ID_UNIDADE', tipo: 'C', tamanho: 7 },
      { nome: 'DT_SIN_PRI', tipo: 'D', tamanho: 8 },
      { nome: 'QT_TOTAL_C', tipo: 'C', tamanho: 5 },
    ];
    const { registros } = await lerTudo(
      'NSURTNET.DBF',
      escreverDbf(surto, [{ NU_NOTIFIC: '0000021', TP_NOT: '3', ID_AGRAVO: 'A08', DT_NOTIFIC: '2026-03-10', ID_MUNICIP: '355030', ID_UNIDADE: '9000011', DT_SIN_PRI: '2026-03-06', QT_TOTAL_C: '4' }]),
    );
    expect(registros[0]!.partes[0]).toMatchObject({ tipo: 'SURTO', inicioSintomas: '2026-03-06' });
  });
});

describe('contrato com a conciliação: o CNES único do arquivo (ArquivoDetectado.cnes)', () => {
  it('e-SUS Notifica e e-SUS Sinan com um CNES só: o CNES; dois CNES, linha sem CNES, Sinan Net ou ignorado: null', async () => {
    const um = await lerTudo(
      'um.csv',
      csvEsus([
        { numero: '352500000101', cnes: '9000011' },
        { numero: '352500000102', cnes: '9000011' },
      ]),
    );
    expect(um.l.arquivos[0]).toMatchObject({ tipo: 'ESUS_NOTIFICA_CSV', cnes: '9000011' });
    const dois = await lerTudo(
      'dois.csv',
      csvEsus([
        { numero: '352500000103', cnes: '9000011' },
        { numero: '352500000104', cnes: '9000012' },
      ]),
    );
    expect(dois.l.arquivos[0]!.cnes).toBeNull();
    const semCnes = await lerTudo(
      'sem.csv',
      csvEsus([
        { numero: '352500000105', cnes: '9000011' },
        { numero: '352500000106', cnes: null },
      ]),
    );
    expect(semCnes.l.arquivos[0]!.cnes).toBeNull();
    const sinan = `"nu_notific";"id_agravo";"dt_notific";"id_municip";"id_unidade";"nm_pacient";"classi_fin"\r\n${['352600000901', '352600000902']
      .map((n) => `"${n}";"B04";"10/03/2026";"355030";"9000011";"Paciente ${n}";"1"`)
      .join('\r\n')}\r\n`;
    const esusSinan = await lerTudo('mpox.csv', enc(sinan));
    expect(esusSinan.l.arquivos[0]).toMatchObject({ tipo: 'ESUS_SINAN_CSV', cnes: '9000011' });
    const nindinet = await lerTudo('NINDINET.DBF', escreverDbf(CAMPOS_NINDINET, [{ NU_NOTIFIC: '7100001', TP_NOT: '2', ID_AGRAVO: 'A279', DT_NOTIFIC: '2026-03-02', ID_MUNICIP: '355030', ID_UNIDADE: '9000011' }]));
    expect(nindinet.l.arquivos[0]).toMatchObject({ tipo: 'NINDINET', cnes: null });
    const comIgnorado = await lerTudo(
      'envio.zip',
      zipar([
        ['um.csv', csvEsus([{ numero: '352500000107', cnes: '9000011' }])],
        ['leia-me.txt', enc('x')],
      ]),
    );
    expect(comIgnorado.l.arquivos.map((a) => [a.nome, a.cnes])).toEqual([
      ['um.csv', '9000011'],
      ['leia-me.txt', null],
    ]);
  });
});
