import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Memória e laço de eventos da importação no maior envio aceito (VIG-1c, achados imp-memoria e tra-3). O container da
 * produção tem 1 GiB e cerca de 512 MB de heap: a leitura roda num processo filho com --max-old-space-size=512, no teto
 * de bytes (150 MB descompactados) e no teto de registros (400 mil linhas), passando pelo caminho inteiro da prévia e da
 * aplicação fora do banco: zip em fluxo, leitura, índice, arquivo temporário, comparação (mescla e hash) em lotes,
 * payload com gzip e a releitura dele em lotes. Mede o pico do heap e a maior pausa do laço de eventos (amostrador de
 * 10 ms). O script do filho é empacotado com o esbuild, com o shared do código-fonte.
 */

const RAIZ = resolve(__dirname, '../../..');
const IMPORTACAO = join(RAIZ, 'apps/api/src/modules/vigilancia/importacao');

/** O que roda no processo filho: gera o envio, lê, compara em lotes, grava e relê o payload. */
const FILHO = `
import { Zip, ZipDeflate } from 'fflate';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcumuladorCobertura, lerEnvio } from '${IMPORTACAO}/leitura';
import { aplicarParte, estadoVazio, hashDoEstado } from '${IMPORTACAO}/mescla';
import { EscritorPayload, LeitorPayload } from '${IMPORTACAO}/payload';

const [cenario, linhasTxt, larguraTxt] = process.argv.slice(2);
const linhas = Number(linhasTxt);
const largura = Number(larguraTxt);
let pico = 0;
let maiorPausa = 0;
let fase = 'gerar';
let faseDaPausa = '';
let ultimo = performance.now();
const amostrador = setInterval(() => {
  const h = process.memoryUsage().heapUsed;
  if (h > pico) pico = h;
  const agora = performance.now();
  if (agora - ultimo - 10 > maiorPausa) {
    maiorPausa = agora - ultimo - 10;
    faseDaPausa = fase;
  }
  ultimo = agora;
}, 10);

const enc = new TextEncoder();
function zipar(arquivos) {
  const partes = [];
  const zip = new Zip((erro, dado) => {
    if (erro) throw erro;
    partes.push(dado);
  });
  for (const [nome, gerar] of arquivos) {
    const f = new ZipDeflate(nome, { level: 6 });
    zip.add(f);
    gerar((bytes, fim) => f.push(bytes, fim));
  }
  zip.end();
  return Buffer.concat(partes);
}

/** CSV do e-SUS Notifica com linhas de largura realista (a observação completa a largura pedida). */
function esus(empurrar) {
  const cab = ['Número da Notificação', 'Data da Notificação', 'Data do início dos sintomas', 'Estado de Residência', 'Município de Residência', 'Estado da Notificação', 'Município da Notificação', 'CNES Notificação', 'Nome Completo', 'CPF', 'CNS', 'Data de Nascimento', 'Sexo', 'Nome Completo da Mãe', 'Sintoma- Febre', 'Evolução Caso', 'Classificação Final', 'Data de encerramento', 'Bairro', 'Observação'];
  empurrar(enc.encode(cab.map((c) => '"' + c + '"').join(';') + '\\r\\n'), false);
  let bloco = [];
  for (let i = 0; i < linhas; i++) {
    const d = String(1 + (i % 28)).padStart(2, '0') + '/0' + (1 + (i % 9)) + '/2025';
    const obs = 'x'.repeat(Math.max(0, largura - 260)) + (i % 97);
    bloco.push([String(350000000000 + i), d, d, 'São Paulo', '3550308', 'São Paulo', '3550308', '9000011', 'Paciente Número ' + i + ' da Silva', '', '', '01/02/1990', i % 2 ? 'Feminino' : 'Masculino', 'Mãe ' + i, 'Sim', 'Cura', 'Confirmado Laboratorial', d, 'Centro', obs].map((v) => '"' + v + '"').join(';'));
    if (bloco.length === 2000) {
      empurrar(enc.encode(bloco.join('\\r\\n') + '\\r\\n'), false);
      bloco = [];
    }
  }
  empurrar(enc.encode(bloco.join('\\r\\n') + (bloco.length ? '\\r\\n' : '')), true);
}

/** DBF dBase III com os campos dados (texto ASCII), registro por registro. */
function dbf(campos, valor) {
  return (empurrar) => {
    const tamReg = 1 + campos.reduce((a, c) => a + c[1], 0);
    const cab = Buffer.alloc(32 + 32 * campos.length + 1);
    cab[0] = 3; cab[1] = 126; cab[2] = 11; cab[3] = 16;
    cab.writeUInt32LE(linhas, 4); cab.writeUInt16LE(cab.length, 8); cab.writeUInt16LE(tamReg, 10); cab[29] = 0x25;
    campos.forEach(([nome, tam, tipo], i) => { cab.write(nome, 32 + 32 * i, 'latin1'); cab[32 + 32 * i + 11] = (tipo ?? 'C').charCodeAt(0); cab[32 + 32 * i + 16] = tam; });
    cab[cab.length - 1] = 0x0d;
    empurrar(cab, false);
    const bloco = Buffer.alloc(tamReg * 1000, 0x20);
    for (let i = 0; i < linhas; i += 1000) {
      const n = Math.min(1000, linhas - i);
      bloco.fill(0x20);
      for (let k = 0; k < n; k++) {
        let o = k * tamReg + 1;
        for (const [nome, tam] of campos) { bloco.write(String(valor(i + k, nome)).slice(0, tam), o, 'latin1'); o += tam; }
      }
      empurrar(Uint8Array.from(bloco.subarray(0, n * tamReg)), false);
    }
    empurrar(Uint8Array.of(0x1a), true);
  };
}
const NOTIFICACAO = [['NU_NOTIFIC', 7], ['TP_NOT', 1], ['ID_AGRAVO', 4], ['DT_NOTIFIC', 8, 'D'], ['SEM_NOT', 6], ['ID_MUNICIP', 6], ['ID_UNIDADE', 7], ['DT_SIN_PRI', 8, 'D'], ['NM_PACIENT', 70], ['DT_NASC', 8, 'D'], ['CS_SEXO', 1], ['ID_CNS_SUS', 15], ['NM_MAE_PAC', 60], ['ID_MN_RESI', 6], ['NM_BAIRRO', 60], ['NU_TELEFON', 9]];
const INVESTIGACAO = [...NOTIFICACAO, ['CLASSI_FIN', 2], ['CRITERIO', 1], ['EVOLUCAO', 1], ['DT_ENCERRA', 8, 'D'], ['RES_ELISA', 1]];
const valorSinan = (i, nome) => ({ NU_NOTIFIC: String(i).padStart(7, '0'), TP_NOT: '2', ID_AGRAVO: 'A279', DT_NOTIFIC: '20250' + (1 + (i % 9)) + '15', SEM_NOT: '202510', ID_MUNICIP: '355030', ID_UNIDADE: '9000011', DT_SIN_PRI: '20250110', NM_PACIENT: 'PACIENTE ' + i + ' DA SILVA', DT_NASC: '19800101', CS_SEXO: i % 2 ? 'F' : 'M', ID_CNS_SUS: '', NM_MAE_PAC: 'MAE ' + i, ID_MN_RESI: '355030', NM_BAIRRO: 'CENTRO', NU_TELEFON: '999990000', CLASSI_FIN: '1', CRITERIO: '1', EVOLUCAO: '1', DT_ENCERRA: '20250301', RES_ELISA: '1' })[nome] ?? '';

async function main() {
  const zip =
    cenario === 'dbf'
      ? zipar([['NINDINET.DBF', dbf(NOTIFICACAO, valorSinan)], ['LEPTONET.DBF', dbf(INVESTIGACAO, valorSinan)]])
      : zipar([['esus.csv', esus]]);
  globalThis.gc?.();
  pico = 0;
  maiorPausa = 0;
  ultimo = performance.now();
  const inicio = performance.now();
  const out = { cenario, linhas, zipMB: +(zip.length / 1048576).toFixed(1) };
  let leitura = null;
  fase = 'leitura';
  try {
    leitura = await lerEnvio('envio.zip', zip, { hoje: '2026-11-16', municipio: '3550308' });
  } catch (e) {
    out.recusado = e.message;
  }
  if (leitura) {
    out.descompactadoMB = +(leitura.arquivos.reduce((a, x) => a + x.tamanhoBytes, 0) / 1048576).toFixed(1);
    out.lidos = leitura.lidos;
    const pasta = mkdtempSync(join(tmpdir(), 'omni-memoria-'));
    try {
      // Prévia: comparação em lotes (sem banco: tudo novo), cobertura e payload.
      fase = 'previa';
      const escritor = new EscritorPayload(join(pasta, 'payload.gz'));
      const cobertura = new AcumuladorCobertura(null, '3550308');
      let registros = 0;
      for await (const lote of leitura.registros(500)) {
        for (const r of lote) {
          cobertura.somar(r);
          hashDoEstado(r.sistema, r.tipo, r.partes.reduce(aplicarParte, estadoVazio()));
        }
        registros += lote.length;
        await escritor.escrever(lote);
      }
      out.payloadMB = +((await escritor.fechar(cobertura.resultado().cobertura)) / 1048576).toFixed(1);
      out.registros = registros;
      leitura.fechar();
      // Aplicação: o payload relido em fatias de 4 MB e em lotes, com a mescla de cada registro.
      fase = 'aplicacao';
      const gz = readFileSync(join(pasta, 'payload.gz'));
      const leitor = new LeitorPayload((async function* () { for (let i = 0; i < gz.length; i += 4 << 20) yield gz.subarray(i, i + (4 << 20)); })());
      let relidos = 0;
      for await (const lote of leitor.lotes(500)) {
        for (const r of lote) hashDoEstado(r.sistema, r.tipo, r.partes.reduce(aplicarParte, estadoVazio()));
        relidos += lote.length;
      }
      out.relidos = relidos;
    } finally {
      leitura.fechar();
      rmSync(pasta, { recursive: true, force: true });
    }
  }
  out.segundos = +((performance.now() - inicio) / 1000).toFixed(1);
  await new Promise((r) => setTimeout(r, 30));
  clearInterval(amostrador);
  out.picoHeapMB = Math.round(pico / 1048576);
  out.maiorPausaMs = Math.round(maiorPausa);
  out.faseDaMaiorPausa = faseDaPausa;
  out.rssMB = Math.round(process.memoryUsage().rss / 1048576);
  console.log(JSON.stringify(out));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
`;

let pasta = '';
let pacote = '';

beforeAll(() => {
  pasta = mkdtempSync(join(tmpdir(), 'omni-filho-'));
  writeFileSync(join(pasta, 'filho.ts'), FILHO);
  pacote = join(pasta, 'filho.cjs');
  buildSync({
    entryPoints: [join(pasta, 'filho.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: pacote,
    alias: { '@omnisaude/shared': join(RAIZ, 'packages/shared/src/index.ts') },
    nodePaths: [join(RAIZ, 'node_modules')],
    logLevel: 'silent',
  });
});

afterAll(() => {
  if (pasta) rmSync(pasta, { recursive: true, force: true });
});

interface Medida {
  cenario: string;
  linhas: number;
  recusado?: string;
  descompactadoMB?: number;
  lidos?: number;
  registros?: number;
  relidos?: number;
  payloadMB?: number;
  picoHeapMB: number;
  maiorPausaMs: number;
  rssMB: number;
  segundos: number;
}

/** Roda um cenário no processo filho (sem travar o laço de eventos do teste). */
async function medir(cenario: string, linhas: number, largura = 0): Promise<Medida> {
  const filho = spawn(process.execPath, ['--max-old-space-size=512', '--expose-gc', pacote, cenario, String(linhas), String(largura)], { cwd: RAIZ, stdio: ['ignore', 'pipe', 'pipe'] });
  let saida = '';
  let erro = '';
  filho.stdout.on('data', (d: Buffer) => (saida += d.toString()));
  filho.stderr.on('data', (d: Buffer) => (erro += d.toString()));
  const prazo = setTimeout(() => filho.kill('SIGKILL'), 280_000);
  const [codigo, sinal] = (await new Promise((ok) => filho.on('close', (c, s) => ok([c, s])))) as [number | null, string | null];
  clearTimeout(prazo);
  if (codigo !== 0) throw new Error(`processo filho falhou (${codigo} ${sinal ?? ''}): ${erro.slice(-2000)}`);
  const medida = JSON.parse(saida.trim().split('\n').pop()!) as Medida;
  console.log(`[memória da importação] ${JSON.stringify(medida)}`);
  return medida;
}

/** Meta: pico do heap abaixo de ~250 MB (512 MB disponíveis) e nenhuma pausa perto de 1 s (aqui, abaixo de 250 ms). */
const PICO_MB = 250;
const PAUSA_MS = 250;

describe('importação: memória e laço de eventos no maior envio aceito (processo filho com 512 MB de heap)', () => {
  it('teto de bytes: CSV do e-SUS Notifica de ~130 MB descompactados (200 mil linhas de 700 bytes)', async () => {
    const m = await medir('esus', 200_000, 700);
    expect(m.recusado).toBeUndefined();
    expect(m.descompactadoMB!).toBeGreaterThan(120);
    expect(m).toMatchObject({ lidos: 200_000, registros: 200_000, relidos: 200_000 });
    expect(m.picoHeapMB).toBeLessThan(PICO_MB);
    expect(m.maiorPausaMs).toBeLessThan(PAUSA_MS);
  }, 300_000);

  it('teto de registros: 400 mil linhas do e-SUS Notifica', async () => {
    const m = await medir('esus', 400_000, 300);
    expect(m.recusado).toBeUndefined();
    expect(m).toMatchObject({ lidos: 400_000, registros: 400_000, relidos: 400_000 });
    expect(m.picoHeapMB).toBeLessThan(PICO_MB);
    expect(m.maiorPausaMs).toBeLessThan(PAUSA_MS);
  }, 300_000);

  it('acima do teto de registros: recusado com a mensagem de exportar por período, sem estourar a memória', async () => {
    const m = await medir('esus', 450_000, 200);
    expect(m.recusado).toMatch(/400 mil registros\. Exporte um ano por vez/);
    expect(m.picoHeapMB).toBeLessThan(PICO_MB);
    expect(m.maiorPausaMs).toBeLessThan(PAUSA_MS);
  }, 300_000);

  it('Sinan: NINDINET e DBF do agravo com as mesmas 200 mil notificações (400 mil linhas, partes somadas por chave)', async () => {
    const m = await medir('dbf', 200_000);
    expect(m.recusado).toBeUndefined();
    expect(m).toMatchObject({ lidos: 400_000, registros: 200_000, relidos: 200_000 });
    expect(m.picoHeapMB).toBeLessThan(PICO_MB);
    expect(m.maiorPausaMs).toBeLessThan(PAUSA_MS);
  }, 300_000);
});
