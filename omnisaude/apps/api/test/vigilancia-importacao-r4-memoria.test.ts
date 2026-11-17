import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Memória da leitura do corpo cru (VIG-1c, quarta rodada, N1), num processo filho com --max-old-space-size=512 (o heap
 * do container de 1 GiB da produção), pelo vite-node com o SWC, como os testes. Com o Content-Length, o rawBody aloca o
 * Buffer uma vez, no tamanho declarado, e copia os pedaços nele: dois envios simultâneos ficam com a memória dos dois
 * corpos. Antes, a lista dos pedaços e a cópia do Buffer.concat ficavam juntas na memória no fim de cada envio, e a
 * memória dos dois envios dobrava. Sem o Content-Length (envio em pedaços), os pedaços ainda são juntados no fim, como
 * antes: é o controle de que a medida enxerga a cópia. A medida é a memória dos ArrayBuffers (fora do heap), tirada
 * logo depois de cada alocação grande e a cada 1 MB lido (depois do coletor). Dados sintéticos.
 */

const RAIZ = resolve(__dirname, '../../..');
const TAMANHO_MB = 32;

const CONFIG_VITE = `
import swc from '${join(RAIZ, 'node_modules/unplugin-swc/dist/index.js')}';
const pkg = (n) => '${RAIZ}/packages/' + n + '/src/index.ts';
export default {
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    alias: {
      '@omnisaude/shared': pkg('shared'),
      '@omnisaude/database': pkg('database'),
      '@omnisaude/ai-engine': pkg('ai-engine'),
      '@omnisaude/messaging': pkg('messaging'),
      '@omnisaude/fhir': pkg('fhir'),
      '@omnisaude/esus': pkg('esus'),
      '@omnisaude/accessibility': pkg('accessibility'),
    },
  },
};
`;

/** Lê dois corpos ao mesmo tempo pelo rawBody e diz o pico da memória dos ArrayBuffers (R4_MODO: com-tamanho ou em-pedacos). */
const FILHO = `
import { Readable } from 'node:stream';
import { rawBody } from '${RAIZ}/apps/api/src/core/raw-body';

const modo = process.env.R4_MODO;
const tamanho = Number(process.env.R4_MB) * 1048576;
const PEDACO = 64 * 1024;
let base = 0;
let pico = 0;
const medir = () => {
  const m = process.memoryUsage().arrayBuffers - base;
  if (m > pico) pico = m;
};
// Logo depois de cada alocação grande: o Buffer do corpo, ou a cópia do Buffer.concat no fim.
const alocar = Buffer.allocUnsafe;
Buffer.allocUnsafe = (n) => {
  const b = alocar(n);
  if (n >= 1048576) medir();
  return b;
};
/** O pedido: entrega o corpo em pedaços de 64 KB, um por volta do laço (como o socket); a cada 1 MB, o coletor roda. */
function pedido() {
  let enviados = 0;
  const r = new Readable({
    read() {
      if (enviados >= tamanho) {
        r.complete = true;
        r.push(null);
        return;
      }
      const n = Math.min(PEDACO, tamanho - enviados);
      enviados += n;
      if (enviados % 1048576 === 0) {
        globalThis.gc();
        medir();
      }
      setImmediate(() => r.push(Buffer.alloc(n, 0x41)));
    },
  });
  r.headers = modo === 'com-tamanho' ? { 'content-length': String(tamanho) } : { 'transfer-encoding': 'chunked' };
  r.complete = false;
  return r;
}
globalThis.gc();
globalThis.gc();
base = process.memoryUsage().arrayBuffers;
const corpos = await Promise.all([rawBody(pedido(), tamanho + 1), rawBody(pedido(), tamanho + 1)]);
medir();
const certos = corpos.every((c) => c.length === tamanho && c[0] === 0x41 && c[tamanho - 1] === 0x41);
process.stdout.write('@@R4 ' + JSON.stringify({ modo, certos, picoMB: Math.round((pico / 1048576) * 10) / 10 }) + '\\n');
`;

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-r4-corpo-'));
  writeFileSync(join(dir, 'vite.config.mjs'), CONFIG_VITE);
  writeFileSync(join(dir, 'corpo.ts'), FILHO);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function lerNoFilho(modo: 'com-tamanho' | 'em-pedacos'): Promise<{ modo: string; certos: boolean; picoMB: number }> {
  const filho = spawn(process.execPath, ['--max-old-space-size=512', '--expose-gc', join(RAIZ, 'node_modules/vite-node/vite-node.mjs'), '--root', RAIZ, '--config', join(dir, 'vite.config.mjs'), join(dir, 'corpo.ts')], {
    cwd: RAIZ,
    env: { ...process.env, R4_MODO: modo, R4_MB: String(TAMANHO_MB) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let saida = '';
  let erro = '';
  filho.stdout.on('data', (d: Buffer) => (saida += d.toString()));
  filho.stderr.on('data', (d: Buffer) => (erro = (erro + d.toString()).slice(-4000)));
  const prazo = setTimeout(() => filho.kill('SIGKILL'), 110_000);
  const codigo = await new Promise<number | null>((ok) => filho.on('close', (c) => ok(c)));
  clearTimeout(prazo);
  const linha = saida.split('\n').find((l) => l.startsWith('@@R4 '));
  if (codigo !== 0 || !linha) throw new Error(`processo filho falhou (${codigo}): ${erro}`);
  const medida = JSON.parse(linha.slice(5)) as { modo: string; certos: boolean; picoMB: number };
  console.log(`[memória do corpo cru, r4] dois envios simultâneos de ${TAMANHO_MB} MB: ${JSON.stringify(medida)}`);
  return medida;
}

describe('N1: a memória de dois envios simultâneos não dobra (processo filho com 512 MB de heap)', () => {
  it(`com o Content-Length, dois corpos de ${TAMANHO_MB} MB lidos ao mesmo tempo ficam com a memória dos dois (sem a cópia do fim); em pedaços, a cópia continua (o controle)`, async () => {
    const comTamanho = await lerNoFilho('com-tamanho');
    expect(comTamanho.certos).toBe(true);
    // Os dois Buffers (64 MB) e alguns pedaços ainda não coletados.
    expect(comTamanho.picoMB).toBeGreaterThanOrEqual(2 * TAMANHO_MB);
    expect(comTamanho.picoMB).toBeLessThan(2 * TAMANHO_MB * 1.2);
    // Sem o Content-Length: os pedaços dos dois envios e a cópia de um deles juntos (três corpos, ou mais).
    const emPedacos = await lerNoFilho('em-pedacos');
    expect(emPedacos.certos).toBe(true);
    expect(emPedacos.picoMB).toBeGreaterThanOrEqual(2.8 * TAMANHO_MB);
  }, 240_000);
});
