import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { LeitorCsv, lerCsvOficial } from '../src/modules/vigilancia/importacao/csv-oficial';
import { LeitorDbf, lerDbf, pareceDbf } from '../src/modules/vigilancia/importacao/dbf';
import { detectarTipo } from '../src/modules/vigilancia/importacao/detectar';
import { abrirEnvio, pedacos } from '../src/modules/vigilancia/importacao/entrada';
import { AcumuladorCobertura, lerEnvio, type OpcoesLeitura, type RegistroDoEnvio } from '../src/modules/vigilancia/importacao/leitura';
import { normalizarRegistro } from '../src/modules/vigilancia/importacao/normalizar';
import { EscritorPayload, LeitorPayload } from '../src/modules/vigilancia/importacao/payload';
import { Ritmo } from '../src/modules/vigilancia/importacao/ritmo';
import { CAMPOS_NINDINET, escreverDbf, type CampoEscrita, type ValorEscrita } from './helpers/dbf-escrita';

/**
 * Importação oficial (VIG-1c), correções da revisão da semana 27 na leitura: zip em fluxo contando os bytes reais
 * (tra-3), CSV e DBF lidos em pedaços sem segurar o texto (imp-memoria), CSV que parecia DBF (imp-csv-vira-dbf), planilha
 * do surto (imp-planilha-surto), dengue e chikungunya sempre no Sinan Online (imp-dengon-duplica), conclusão da ficha de
 * Mpox (imp-mpox-codigos) e cobertura do e-SUS Notifica pela ficha e pelo CNES (imp-ausentes-esus). Sem banco.
 * Dados sintéticos.
 */

const OPCOES: OpcoesLeitura = { hoje: '2026-11-16', municipio: '3550308' };
const enc = (s: string) => new TextEncoder().encode(s);

async function lerTudo(nome: string, bytes: Uint8Array, opcoes: OpcoesLeitura = OPCOES) {
  const l = await lerEnvio(nome, bytes, opcoes);
  try {
    const registros: RegistroDoEnvio[] = [];
    for await (const lote of l.registros(3)) registros.push(...lote);
    return { arquivos: l.arquivos, avisos: l.avisos, lidos: l.lidos, recusados: l.recusados, motivosRecusa: l.motivosRecusa, duplicadosNoArquivo: l.duplicadosNoArquivo, duplicados: l.duplicados, registros };
  } finally {
    l.fechar();
  }
}

/** Zip com o tamanho descompactado declarado trocado (no diretório central e no cabeçalho local). */
function zipMentiroso(nome: string, conteudo: Uint8Array, declarado: number): Buffer {
  const z = Buffer.from(zipSync({ [nome]: conteudo }));
  z.writeUInt32LE(declarado, z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
  z.writeUInt32LE(declarado, z.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])) + 22);
  return z;
}

/** O coletor de lixo dentro do teste (o vitest não liga o --expose-gc). */
function coletor(): () => void {
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
}

describe('zip em fluxo contando os bytes reais (tra-3)', () => {
  it('arquivo que descompacta mais do que o zip declara: recusado no primeiro pedaço, sem descompactar o resto', async () => {
    // 20 MB de zeros viram uns 20 KB no deflate; o zip diz que são 1.000 bytes.
    const bomba = zipMentiroso('NINDINET.DBF', new Uint8Array(20 * 1024 * 1024), 1000);
    expect(bomba.length).toBeLessThan(100_000);
    const inicio = performance.now();
    await expect(lerEnvio('bomba.zip', bomba, OPCOES)).rejects.toMatchObject({ recusaEnvio: true, message: expect.stringContaining('descompacta mais do que o zip declara') });
    expect(performance.now() - inicio).toBeLessThan(1000);
  });

  it('a soma declarada acima de 150 MB é recusada antes de descompactar; o arquivo cru acima de 150 MB também', () => {
    const z = zipMentiroso('a.csv', enc('a;b\r\n1;2\r\n'), 151 * 1024 * 1024);
    expect(() => abrirEnvio('grande.zip', z)).toThrow(/150 MB descompactado.*um ano por vez/);
    // Dois arquivos que, somados, passam do teto.
    const dois = Buffer.from(zipSync({ 'a.csv': enc('a;b\r\n'), 'b.csv': enc('a;b\r\n') }));
    let pos = 0;
    for (let k = 0; k < 2; k++) {
      pos = dois.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), pos);
      dois.writeUInt32LE(80 * 1024 * 1024, pos + 24);
      pos += 4;
    }
    expect(() => abrirEnvio('dois.zip', dois)).toThrow(/150 MB/);
  });

  it('o arquivo sai em pedaços: nenhum pedaço passa de 8 MB e o CRC é conferido', async () => {
    const conteudo = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 7) & 0xff);
    const [e] = abrirEnvio('x.zip', zipSync({ 'x.csv': conteudo }));
    let total = 0;
    let maior = 0;
    for await (const p of pedacos(e!, new Ritmo())) {
      total += p.length;
      maior = Math.max(maior, p.length);
    }
    expect(total).toBe(conteudo.length);
    expect(maior).toBeLessThanOrEqual(8 * 1024 * 1024 + 32 * 1024);
    // CRC trocado: zip corrompido.
    const z = Buffer.from(zipSync({ 'x.csv': conteudo }));
    z.writeUInt32LE(0xdeadbeef, z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 16);
    const [ruim] = abrirEnvio('x.zip', z);
    await expect(
      (async () => {
        for await (const _ of pedacos(ruim!, new Ritmo()));
      })(),
    ).rejects.toThrow(/CRC/);
  });

  it('teto de registros: passa do limite e o envio é recusado com a mensagem de exportar por período', async () => {
    const linhas = ['Número da Notificação;Data da Notificação;Sintoma- Febre', ...Array.from({ length: 12 }, (_, i) => `3512${String(i).padStart(8, '0')};10/06/2025;Sim`)];
    await expect(lerEnvio('esus.csv', enc(linhas.join('\r\n')), { ...OPCOES, limiteRegistros: 10 })).rejects.toThrow(/mil registros\. Exporte um ano por vez/);
    expect((await lerTudo('esus.csv', enc(linhas.join('\r\n')), { ...OPCOES, limiteRegistros: 12 })).registros).toHaveLength(12);
  });
});

describe('leitura em pedaços (imp-memoria)', () => {
  const CSV_DIFICIL =
    '﻿"Número da Notificação";"Evolução do Caso";Observação;Bairro;\r\n' +
    '"351234567890";Cura;"texto; com ponto e vírgula\r\ne quebra";Centro;\r\n' +
    '351234567891;"Can""ce""lado";;"Vila ""Nova""";x\r\n' +
    '\r\n' +
    ';;;;\r' +
    '351234567892;Óbito;"multi\nlinha\nlonga";São José\n' +
    '351234567893;Cura;"aspa sem fechar no fim';

  it('o CSV dá as mesmas linhas (e os mesmos números de linha) em qualquer tamanho de pedaço', () => {
    const bytes = enc(CSV_DIFICIL);
    const inteiro = new LeitorCsv({ codificacao: 'UTF8' });
    const referencia = [...inteiro.push(bytes), ...inteiro.fim()];
    expect(referencia.map((x) => x.n)).toEqual([2, 4, 7, 10]);
    expect(referencia[1]!.l).toMatchObject({ 'evolucao caso': 'Can"ce"lado', bairro: 'Vila "Nova"', observacao: null });
    expect(referencia[2]!.l).toMatchObject({ 'numero da notificacao': '351234567892', observacao: 'multi\nlinha\nlonga', bairro: 'São José' });
    expect(referencia[3]!.l).toMatchObject({ observacao: 'aspa sem fechar no fim' });
    for (const passo of [1, 2, 3, 5, 7, 13, 64]) {
      const leitor = new LeitorCsv({ codificacao: 'UTF8' });
      const linhas = [];
      for (let i = 0; i < bytes.length; i += passo) linhas.push(...leitor.push(bytes.subarray(i, i + passo)));
      linhas.push(...leitor.fim());
      expect(linhas, `pedaço de ${passo} bytes`).toEqual(referencia);
    }
    // O leitor de uma vez (testes) dá o mesmo.
    expect([...lerCsvOficial(bytes).linhas()]).toEqual(referencia.map((x) => x.l));
  });

  it('o DBF dá as mesmas linhas em qualquer tamanho de pedaço (com registro apagado e sem marca no byte 29)', () => {
    const campos: CampoEscrita[] = [
      { nome: 'NU_NOTIFIC', tipo: 'C', tamanho: 7 },
      { nome: 'DT_NOTIFIC', tipo: 'D', tamanho: 8 },
      { nome: 'NM_PACIENT', tipo: 'C', tamanho: 30 },
    ];
    const registros = [
      { NU_NOTIFIC: '0000001', DT_NOTIFIC: '2025-03-05', NM_PACIENT: 'JOÃO DA CONCEIÇÃO' },
      { valores: { NU_NOTIFIC: '0000002', DT_NOTIFIC: '2025-03-06', NM_PACIENT: 'APAGADO' }, apagado: true },
      { NU_NOTIFIC: '0000003', DT_NOTIFIC: null, NM_PACIENT: 'SÃO PAULO' },
    ];
    const bytes = escreverDbf(campos, registros, { byteIdioma: 0x00 });
    const referencia = [...lerDbf(bytes).linhas()];
    expect(referencia).toEqual([
      { NU_NOTIFIC: '0000001', DT_NOTIFIC: '2025-03-05', NM_PACIENT: 'JOÃO DA CONCEIÇÃO' },
      { NU_NOTIFIC: '0000003', DT_NOTIFIC: null, NM_PACIENT: 'SÃO PAULO' },
    ]);
    for (const passo of [1, 3, 31, 33, 100]) {
      const leitor = new LeitorDbf();
      const linhas = [];
      for (let i = 0; i < bytes.length; i += passo) linhas.push(...leitor.push(bytes.subarray(i, i + passo)));
      linhas.push(...leitor.fim());
      expect(linhas, `pedaço de ${passo} bytes`).toEqual(referencia);
      expect(leitor.origemCodificacao).toBe('PONTUACAO');
    }
  });

  it('só as colunas que a normalização usa são decodificadas; as outras ficam presentes, com null', () => {
    const leitor = new LeitorCsv({ codificacao: 'UTF8', lidas: new Set(['numero da notificacao']) });
    const linhas = [...leitor.push(enc('Número da Notificação;Telefone 1;Sintoma- Febre\r\n351234567890;99999-0000;Sim\r\n')), ...leitor.fim()];
    expect(linhas[0]!.l).toEqual({ 'numero da notificacao': '351234567890', 'telefone 1': null, 'sintoma febre': null });
  });

  it('os valores lidos não seguram o texto do arquivo: guardar poucos valores de um CSV grande não guarda o CSV', () => {
    const gc = coletor();
    // CSV de uns 24 MB; cada linha tem um valor longo (mais de 13 caracteres, que viraria fatia do texto).
    const linha = (i: number) => `3512${String(i).padStart(8, '0')};${'Observação longa que vira fatia do texto '.repeat(6)}${i}\r\n`;
    const partes = ['Número da Notificação;Observação\r\n'];
    for (let i = 0; i < 90_000; i++) partes.push(linha(i));
    let bytes: Uint8Array | null = enc(partes.join(''));
    partes.length = 0;
    expect(bytes.length).toBeGreaterThan(20 * 1024 * 1024);
    gc();
    const antes = process.memoryUsage().heapUsed;
    const guardados: string[] = [];
    const leitor = new LeitorCsv({ codificacao: 'UTF8' });
    for (let i = 0; i < bytes.length; i += 256 * 1024) for (const { l, n } of leitor.push(bytes.subarray(i, i + 256 * 1024))) if (n % 9000 === 0) guardados.push(l.observacao!);
    leitor.fim();
    bytes = null;
    gc();
    const depois = process.memoryUsage().heapUsed;
    expect(guardados).toHaveLength(10);
    // Dez valores de ~250 caracteres: bem menos de 1 MB (o texto inteiro teria mais de 20 MB).
    expect((depois - antes) / 1024 / 1024).toBeLessThan(2);
  });

  it('o payload em fluxo volta igual, em lotes, com a cobertura no fim', async () => {
    const zip = zipSync({
      'NINDINET.DBF': escreverDbf(CAMPOS_NINDINET, [
        { NU_NOTIFIC: '0000001', TP_NOT: '2', ID_AGRAVO: 'A279', DT_NOTIFIC: '2025-03-05', ID_MUNICIP: '355030', ID_UNIDADE: '9000011', NM_PACIENT: 'ANA', CS_SEXO: 'F', NU_IDADE_N: 4030 },
        { NU_NOTIFIC: '0000002', TP_NOT: '2', ID_AGRAVO: 'A379', DT_NOTIFIC: '2025-03-06', ID_MUNICIP: '355030', ID_UNIDADE: '9000011', NM_PACIENT: 'BIA' },
      ]),
      'esus.csv': enc('Número da Notificação;Data da Notificação;CNES Notificação;Sintoma- Febre;Raça Cor\r\n351234500001;10/01/2025;9000011;Sim;Parda\r\n'),
    });
    const l = await lerEnvio('envio.zip', zip, OPCOES);
    const pasta = (await import('node:fs')).mkdtempSync(`${(await import('node:os')).tmpdir()}/payload-teste-`);
    try {
      const escritor = new EscritorPayload(`${pasta}/p.gz`);
      const lidos: RegistroDoEnvio[] = [];
      const cobertura = new AcumuladorCobertura(null, '3550308');
      for await (const lote of l.registros(2)) {
        lidos.push(...lote);
        lote.forEach((r) => cobertura.somar(r));
        await escritor.escrever(lote);
      }
      await escritor.fechar(cobertura.resultado().cobertura);
      const gz = (await import('node:fs')).readFileSync(`${pasta}/p.gz`);
      const leitor = new LeitorPayload(
        (async function* () {
          for (let i = 0; i < gz.length; i += 17) yield gz.subarray(i, i + 17);
        })(),
      );
      const voltaram: RegistroDoEnvio[] = [];
      for await (const lote of leitor.lotes(2)) {
        expect(lote.length).toBeLessThanOrEqual(2);
        voltaram.push(...lote);
      }
      // O arquivo de origem e o CNES dele (quarta rodada, N0) só existem na leitura: a cobertura já sai calculada no
      // payload, e os registros voltam sem eles.
      expect(lidos[0]).toMatchObject({ arquivo: 0, cnesDoArquivo: '9000011' });
      expect(voltaram).toEqual(lidos.map(({ arquivo: _a, cnesDoArquivo: _c, ...r }) => r));
      expect(leitor.cobertura).toEqual(cobertura.resultado().cobertura);
    } finally {
      l.fechar();
      (await import('node:fs')).rmSync(pasta, { recursive: true, force: true });
    }
  });
});

describe('CSV que começava como DBF (imp-csv-vira-dbf)', () => {
  it('CSV do e-SUS sem BOM e sem aspas, que começa por C e tem um CR em múltiplo de 32: lido como CSV', async () => {
    // Cabeçalho completado até o CR cair no byte 96: o leitor antigo via "versão" 'C', "cabeçalho" pelos bytes 8-9 e o
    // 0x0D num múltiplo de 32, e lia o texto como DBF.
    let cab = 'CNES Notificação;Número da Notificação;Data da Notificação;Sintoma- Febre;Bairro';
    while (Buffer.byteLength(cab) < 96) cab += 'x';
    expect(Buffer.byteLength(cab)).toBe(96);
    const linhas = Array.from({ length: 700 }, (_, i) => `9000011;3512${String(i).padStart(8, '0')};10/06/2025;Sim;Centro`);
    const bytes = enc(`${cab}\r\n${linhas.join('\r\n')}\r\n`);
    expect(bytes[0]).toBe(0x43);
    expect(bytes[96]).toBe(0x0d);
    expect(bytes.length).toBeGreaterThan(bytes[8]! | (bytes[9]! << 8));
    expect(pareceDbf(bytes)).toBe(false);
    const l = await lerTudo('esus.csv', bytes);
    expect(l.arquivos[0]).toMatchObject({ tipo: 'ESUS_NOTIFICA_CSV', ignorado: false, registros: 700 });
    expect(l.registros).toHaveLength(700);
  });

  it('o DBF de verdade continua DBF; cabeçalho com nome de campo que não é ASCII não é DBF', () => {
    const dbf = escreverDbf(CAMPOS_NINDINET, [{ NU_NOTIFIC: '0000001' }]);
    expect(pareceDbf(dbf)).toBe(true);
    const estragado = Buffer.from(dbf);
    estragado[32 + 3] = 0xe7; // 'ç' no nome do primeiro campo
    expect(pareceDbf(estragado)).toBe(false);
  });
});

describe('planilha de acompanhamento do surto (imp-planilha-surto)', () => {
  const surto: CampoEscrita[] = [
    { nome: 'NU_NOTIFIC', tipo: 'C', tamanho: 7 },
    { nome: 'TP_NOT', tipo: 'C', tamanho: 1 },
    { nome: 'ID_AGRAVO', tipo: 'C', tamanho: 4 },
    { nome: 'DT_NOTIFIC', tipo: 'D', tamanho: 8 },
    { nome: 'ID_MUNICIP', tipo: 'C', tamanho: 6 },
    { nome: 'ID_UNIDADE', tipo: 'C', tamanho: 7 },
    { nome: 'DT_SIN_PRI', tipo: 'D', tamanho: 8 },
    { nome: 'ID_MUNI_RE', tipo: 'C', tamanho: 6 },
    { nome: 'QT_TOTAL_C', tipo: 'C', tamanho: 5 },
    { nome: 'CS_LOCAL', tipo: 'C', tamanho: 2 },
    { nome: 'NM_LOCAL', tipo: 'C', tamanho: 30 },
  ];
  const planilha: CampoEscrita[] = [
    { nome: 'NU_NOTIFIC', tipo: 'C', tamanho: 7 },
    { nome: 'DT_NOTIFIC', tipo: 'D', tamanho: 8 },
    { nome: 'ID_MUNICIP', tipo: 'C', tamanho: 6 },
    { nome: 'ID_AGRAVO', tipo: 'C', tamanho: 4 },
    { nome: 'ID_UNIDADE', tipo: 'C', tamanho: 7 },
    { nome: 'NU_CASO', tipo: 'N', tamanho: 5 },
    { nome: 'NM_LOCAL', tipo: 'C', tamanho: 30 },
    { nome: 'ID_MUNI_RE', tipo: 'C', tamanho: 6 },
    { nome: 'CS_SEXO', tipo: 'C', tamanho: 1 },
    { nome: 'NU_IDADE_N', tipo: 'N', tamanho: 4 },
    { nome: 'DT_SIN_PRI', tipo: 'D', tamanho: 8 },
  ];
  const chave = { NU_NOTIFIC: '0000020', ID_AGRAVO: 'A08', DT_NOTIFIC: '2026-03-10', ID_MUNICIP: '355030', ID_UNIDADE: '9000011' };

  it('a planilha (NU_CASO com a chave do surto) fica de fora com aviso e não mexe no surto', async () => {
    const zip = zipSync({
      'NSURTNET.DBF': escreverDbf(surto, [{ ...chave, TP_NOT: '3', DT_SIN_PRI: '2026-03-07', ID_MUNI_RE: '355030', QT_TOTAL_C: '12', CS_LOCAL: '3', NM_LOCAL: 'ESCOLA MUNICIPAL DO TESTE' }]),
      'PLANILHA.DBF': escreverDbf(
        planilha,
        [1, 2, 3].map((n) => ({ ...chave, NU_CASO: n, NM_LOCAL: 'A.B.C.', ID_MUNI_RE: '520870', CS_SEXO: 'F', NU_IDADE_N: 4030, DT_SIN_PRI: '2026-03-09' })),
      ),
    });
    const l = await lerTudo('surto.zip', zip);
    expect(l.arquivos.map((a) => [a.nome, a.tipo, a.ignorado])).toEqual([
      ['NSURTNET.DBF', 'NSURTNET', false],
      ['PLANILHA.DBF', 'PLANILHA_SURTO', true],
    ]);
    expect(l.avisos.join(' ')).toContain('Planilha de acompanhamento do surto');
    expect(l.duplicadosNoArquivo).toBe(0);
    expect(l.registros).toHaveLength(1);
    const [parte] = l.registros[0]!.partes;
    expect(parte).toMatchObject({ tipo: 'SURTO', inicioSintomas: '2026-03-07', municipioResidencia: '355030', identificacao: null });
    expect(parte!.extras).toMatchObject({ nm_local: 'ESCOLA MUNICIPAL DO TESTE', qt_total_c: '12' });
  });

  it('NM_LOCAL sozinho não faz surto; o NSURTNET com as colunas da planilha não leva sexo, idade nem iniciais', async () => {
    // Sem NU_CASO, sem as colunas do surto e com TP_NOT 2: ficha de agravo (NM_LOCAL não é da notificação individual).
    expect(detectarTipo(['nu_notific', 'id_agravo', 'dt_notific', 'id_municip', 'id_unidade', 'nm_local', 'nm_pacient', 'cs_sexo'], [{ tp_not: '2', id_agravo: 'A279' }])).toBe('AGRAVO_NET');
    const junto = [...surto, { nome: 'NU_CASO', tipo: 'N' as const, tamanho: 5 }, { nome: 'CS_SEXO', tipo: 'C' as const, tamanho: 1 }, { nome: 'NU_IDADE_N', tipo: 'N' as const, tamanho: 4 }];
    const l = await lerTudo(
      'NSURTNET.DBF',
      escreverDbf(
        junto,
        [1, 2].map((n) => ({ ...chave, TP_NOT: '3', QT_TOTAL_C: '12', CS_LOCAL: '3', NU_CASO: n, NM_LOCAL: 'A.B.C.', CS_SEXO: 'M', NU_IDADE_N: 4040, DT_SIN_PRI: '2026-03-07' })),
      ),
    );
    expect(l.arquivos[0]!.tipo).toBe('NSURTNET');
    const [parte] = l.registros[0]!.partes;
    expect(parte!.identificacao).toBeNull();
    expect(parte!.extras).not.toHaveProperty('nm_local');
    expect(parte!.extras).not.toHaveProperty('idade');
    expect(parte!.extras).not.toHaveProperty('nu_idade_n');
  });
});

describe('dengue e chikungunya sempre no Sinan Online (imp-dengon-duplica)', () => {
  const dengon: CampoEscrita[] = [
    ...CAMPOS_NINDINET,
    { nome: 'CLASSI_FIN', tipo: 'C', tamanho: 2 },
    { nome: 'CRITERIO', tipo: 'C', tamanho: 1 },
    { nome: 'DT_ENCERRA', tipo: 'D', tamanho: 8 },
    { nome: 'FEBRE', tipo: 'C', tamanho: 1 },
    { nome: 'MIALGIA', tipo: 'C', tamanho: 1 },
  ];
  const caso = (n: string, v: Record<string, ValorEscrita> = {}) => ({
    NU_NOTIFIC: n,
    TP_NOT: '2',
    ID_AGRAVO: 'A90',
    DT_NOTIFIC: '2026-03-02',
    ID_MUNICIP: '355030',
    ID_UNIDADE: '9000011',
    NM_PACIENT: `CASO ${n}`,
    ...v,
  });

  it('o DBF de investigação só com A90, sem TP_SISTEMA, sem CLINC_CHIK e sem CLASSI_FIN 10 a 13, é DENGON', () => {
    const colunas = dengon.map((c) => c.nome.toLowerCase());
    expect(detectarTipo(colunas, [{ id_agravo: 'A90', classi_fin: null }, { id_agravo: 'A90', classi_fin: '5' }, { id_agravo: 'A90' }])).toBe('DENGON');
    expect(detectarTipo(colunas, [{ id_agravo: 'A92.0' }, { id_agravo: 'A92' }])).toBe('CHIKON');
    // Sem colunas de investigação continua NINDINET (os registros de dengue dele vão para o Sinan Online pelo agravo).
    expect(
      detectarTipo(
        CAMPOS_NINDINET.map((c) => c.nome.toLowerCase()),
        [{ id_agravo: 'A90' }],
      ),
    ).toBe('NINDINET');
    // O DBF de outro agravo continua AGRAVO_NET.
    expect(detectarTipo(colunas, [{ id_agravo: 'A279' }])).toBe('AGRAVO_NET');
  });

  it('a mesma exportação dá o mesmo sistema e a mesma chave, com ou sem a classificação 10 na amostra', async () => {
    const sem = await lerTudo('DENGON.DBF', escreverDbf(dengon, [caso('0000001'), caso('0000002', { CLASSI_FIN: '5' }), caso('0000003')]));
    const com = await lerTudo('DENGON.DBF', escreverDbf(dengon, [caso('0000001', { CLASSI_FIN: '10' }), caso('0000002', { CLASSI_FIN: '5' }), caso('0000003')]));
    for (const l of [sem, com]) {
      expect(l.arquivos[0]).toMatchObject({ tipo: 'DENGON', sistema: 'SINAN_ONLINE' });
      expect(l.registros.map((r) => `${r.sistema} ${r.chave}`)).toEqual(['SINAN_ONLINE 1|2026-03-02|355030|A90', 'SINAN_ONLINE 2|2026-03-02|355030|A90', 'SINAN_ONLINE 3|2026-03-02|355030|A90']);
    }
  });

  it('a dengue de um NINDINET vira Sinan Online, com a mesma chave do DENGON: uma notificação só, sem cobertura do Online', async () => {
    const zip = zipSync({
      'NINDINET.DBF': escreverDbf(CAMPOS_NINDINET, [caso('0000001', { ID_AGRAVO: 'A90.0' }), caso('0000009', { ID_AGRAVO: 'A279' }), caso('0000010', { ID_AGRAVO: 'B19' })]),
      'DENGON.DBF': escreverDbf(dengon, [caso('0000001', { CLASSI_FIN: '10', CRITERIO: '1' })]),
    });
    const l = await lerTudo('envio.zip', zip);
    const dengue = l.registros.filter((r) => r.chave.endsWith('|A90'));
    expect(dengue).toHaveLength(1);
    expect(dengue[0]).toMatchObject({ sistema: 'SINAN_ONLINE', chave: '1|2026-03-02|355030|A90' });
    expect(dengue[0]!.partes.map((p) => p.tipoArquivo)).toEqual(['NINDINET', 'DENGON']);
    expect(l.registros.filter((r) => r.sistema === 'SINAN_NET').map((r) => r.chave.split('|')[3])).toEqual(['A279', 'B19']);
    // Só o NINDINET: a dengue dele não cobre o Sinan Online (não marca o DENGON como ausente).
    const so = await lerTudo('NINDINET.DBF', escreverDbf(CAMPOS_NINDINET, [caso('0000001'), caso('0000009', { ID_AGRAVO: 'A279' })]));
    const cob = new AcumuladorCobertura(null, '3550308');
    so.registros.forEach((r) => cob.somar(r));
    expect(cob.resultado().cobertura.map((c) => c.sistema)).toEqual(['SINAN_NET']);
  });
});

describe('Mpox no e-SUS Sinan (imp-mpox-codigos)', () => {
  it('DT_CONCLUSÃO é o encerramento; a classificação segue a ficha de Mpox', async () => {
    const csv =
      '"nu_notific";"id_agravo";"dt_notific";"id_municip";"id_unidade";"classi_fin";"evolucao";"DT_CONCLUSÃO"\r\n' +
      ['1', '2', '3', '4', '5', '6', '8'].map((c, i) => `"3526000001${String(i).padStart(2, '0')}";"B04";"10/03/2026";"355030";"9000011";"${c}";"2";20/03/2026`).join('\r\n');
    const l = await lerTudo('mpox.csv', enc(csv));
    expect(l.arquivos[0]!.tipo).toBe('ESUS_SINAN_CSV');
    expect(l.registros.map((r) => r.partes[0]!.situacao)).toEqual(['CONFIRMADO', 'DESCARTADO', 'INCONCLUSIVO', 'EM_INVESTIGACAO', 'INCONCLUSIVO', 'DESCARTADO', 'INCONCLUSIVO']);
    expect(l.registros.every((r) => r.partes[0]!.encerradoEm === '2026-03-20')).toBe(true);
    expect(l.registros[0]!.partes[0]!.colunas).toContain('encerradoEm');
    // A normalização de uma linha só, sem o leitor.
    const r = normalizarRegistro({ nu_notific: '352600000999', id_agravo: 'B04', dt_notific: '10/03/2026', dt_conclusao: '21/03/2026' }, { ...OPCOES, tipo: 'ESUS_SINAN_CSV', arquivo: 'x' });
    expect('registro' in r && r.registro.encerradoEm).toBe('2026-03-21');
  });
});

describe('cobertura do e-SUS Notifica pela ficha e pelo CNES (imp-ausentes-esus)', () => {
  const esus = (cab: string[], linhas: string[][]) => enc([cab.join(';'), ...linhas.map((l) => l.join(';'))].join('\r\n'));
  const CAB_SG = ['Número da Notificação', 'Data da Notificação', 'CNES Notificação', 'Município da Notificação', 'Sintoma- Febre'];
  const CAB_OUTRA = ['Número da Notificação', 'Data da Notificação', 'CNES Notificação', 'Município da Notificação', 'Vacina aplicada'];

  it('CSV de outra ficha (sem as colunas da SG) não cobre nada: nenhum ausente', async () => {
    const l = await lerTudo(
      'esavi.csv',
      esus(CAB_OUTRA, [
        ['351200000001', '09/06/2025', '9000011', '3550308', 'X'],
        ['351200000002', '13/06/2025', '9000028', '3550308', 'Y'],
      ]),
    );
    const cob = new AcumuladorCobertura(null, '3550308');
    l.registros.forEach((r) => cob.somar(r));
    const { cobertura, avisos } = cob.resultado();
    expect(cobertura).toEqual([]);
    expect(avisos.join(' ')).toContain('nenhum registro foi marcado como ausente');
  });

  it('a ficha da SG cobre só o grupo covid; com um CNES só, só esse CNES', async () => {
    const l = await lerTudo(
      'sg.csv',
      esus(CAB_SG, [
        ['351200000011', '10/06/2025', '9000011', '3550308', 'Sim'],
        ['351200000012', '12/06/2025', '9000011', '3550308', 'Não'],
      ]),
    );
    const cob = new AcumuladorCobertura({ de: '2025-06-01', ate: '2025-06-30' }, '3550308');
    l.registros.forEach((r) => cob.somar(r));
    const { cobertura, avisos } = cob.resultado();
    expect(cobertura).toEqual([{ sistema: 'ESUS_NOTIFICA', tipo: 'INDIVIDUAL', agravos: [null], grupos: ['covid'], cnes: ['9000011'], de: '2025-06-01', ate: '2025-06-30', municipios: ['355030'], municipioNulo: false }]);
    expect(avisos.join(' ')).toContain('um CNES só');
    // Dois CNES: a cobertura não fica restrita.
    const dois = await lerTudo(
      'sg.csv',
      esus(CAB_SG, [
        ['351200000011', '10/06/2025', '9000011', '3550308', 'Sim'],
        ['351200000013', '12/06/2025', '9000028', '3550308', 'Sim'],
      ]),
    );
    const cob2 = new AcumuladorCobertura(null, '3550308');
    dois.registros.forEach((r) => cob2.somar(r));
    expect(cob2.resultado().cobertura[0]).not.toHaveProperty('cnes');
  });
});
