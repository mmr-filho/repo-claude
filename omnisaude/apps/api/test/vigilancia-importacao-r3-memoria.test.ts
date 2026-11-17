import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { buildSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable } from './harness';

/**
 * Memória da importação (VIG-1c), terceira e quarta rodadas, sempre num processo filho com --max-old-space-size=512 (o
 * heap do container de 1 GiB da produção):
 * - leitura (filho empacotado com o esbuild): o zip com centenas de milhares de entradas no diretório central é recusado
 *   antes de montar a lista (IMPORTACAO-1); mil cópias do mesmo CSV no zip ficam com uma parte por registro e lotes
 *   pequenos (IMPORTACAO-2);
 * - API (filho com a API inteira, pelo vite-node com o SWC, como os testes): com uma importação segurando a vez, ou com
 *   o processo no teto de arquivos na memória, os envios simultâneos de 25 MB recebem 409 antes de o corpo ser lido, e o
 *   pico da memória retida fora do heap do servidor (os Buffers, medidos depois do coletor) não sobe com os corpos
 *   (imp-memoria). Depois da resposta, o Node lê o corpo que ninguém pediu e o descarta, sem guardar (a conexão segue
 *   viva e o cliente recebe o 409). Quarta rodada (N1): o teto do processo vem dos envios de outros tenants (um envio
 *   por tenant), e dois envios simultâneos do mesmo tenant ficam com um corpo só na memória: o segundo recebe 409 antes
 *   de o corpo ser lido. O envio lido mostra que a medida enxerga o corpo guardado.
 */

const RAIZ = resolve(__dirname, '../../..');
const IMPORTACAO = join(RAIZ, 'apps/api/src/modules/vigilancia/importacao');
const MB = 1024 * 1024;

// ───────────── leitura no filho (sem banco) ─────────────

const FILHO_LEITURA = `
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lerEnvio } from '${IMPORTACAO}/leitura';
import { aplicarParte, estadoVazio, hashDoEstado } from '${IMPORTACAO}/mescla';
import { EscritorPayload } from '${IMPORTACAO}/payload';

const [cenario, nTxt] = process.argv.slice(2);
const n = Number(nTxt);
let pico = 0;
let maiorPausa = 0;
let ultimo = performance.now();
const amostrador = setInterval(() => {
  const h = process.memoryUsage().heapUsed;
  if (h > pico) pico = h;
  const agora = performance.now();
  if (agora - ultimo - 5 > maiorPausa) maiorPausa = agora - ultimo - 5;
  ultimo = agora;
}, 5);

function juntar(preencher) {
  const partes = [];
  const z = new Zip((e, d) => {
    if (e) throw e;
    partes.push(d);
  });
  preencher(z);
  z.end();
  return Buffer.concat(partes);
}

/** Zip64: um arquivo local de 1 byte e n entradas no diretório central apontando para ele. */
function zipComEntradas(qtd) {
  const base = juntar((z) => {
    const f = new ZipPassThrough('a.txt');
    z.add(f);
    f.push(Uint8Array.of(0x41), true);
  });
  const cd = base.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const local = base.subarray(0, cd);
  const modelo = base.subarray(cd, cd + 46);
  const dir = Buffer.alloc(qtd * 58);
  for (let i = 0; i < qtd; i++) {
    const o = i * 58;
    modelo.copy(dir, o);
    dir.writeUInt16LE(12, o + 28);
    dir.writeUInt16LE(0, o + 30);
    dir.writeUInt16LE(0, o + 32);
    dir.writeUInt32LE(0, o + 42);
    dir.write('x' + String(i).padStart(7, '0') + '.txt', o + 46, 'latin1');
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

/** CSV do e-SUS Notifica com 100 linhas, copiado n vezes no zip (o mesmo arquivo repetido). */
function zipCopias(qtd) {
  const cab = ['Número da Notificação', 'Data da Notificação', 'Município da Notificação', 'CNES Notificação', 'Nome Completo', 'Sintoma- Febre', 'Bairro'];
  const linhas = [cab.join(';')];
  for (let i = 0; i < 100; i++) linhas.push([String(352500000000 + i), String(1 + (i % 28)).padStart(2, '0') + '/03/2025', '3550308', '9000011', 'Pessoa Sintetica ' + i, 'Sim', 'Centro'].join(';'));
  const csv = new TextEncoder().encode(linhas.join('\\r\\n') + '\\r\\n');
  return juntar((z) => {
    for (let i = 0; i < qtd; i++) {
      const f = new ZipDeflate('semana' + String(i).padStart(6, '0') + '.csv', { level: 6 });
      z.add(f);
      f.push(csv, true);
    }
  });
}

const opcoes = { hoje: '2026-11-17', municipio: '3550308' };

async function main() {
  const zip = cenario === 'entradas' ? zipComEntradas(n) : zipCopias(n);
  globalThis.gc?.();
  pico = 0;
  maiorPausa = 0;
  ultimo = performance.now();
  const out = { cenario, n, zipMB: +(zip.length / 1048576).toFixed(1) };
  const t0 = performance.now();
  let leitura = null;
  try {
    leitura = await lerEnvio('envio.zip', zip, opcoes);
  } catch (e) {
    out.recusado = e.message;
  }
  out.leituraMs = Math.round(performance.now() - t0);
  if (leitura) {
    out.arquivos = leitura.arquivos.length;
    out.lidos = leitura.lidos;
    const pasta = mkdtempSync(join(tmpdir(), 'omni-r3-memoria-'));
    try {
      // Como a prévia: comparação (mescla e hash) em lotes e o payload com gzip.
      const escritor = new EscritorPayload(join(pasta, 'payload.gz'));
      let registros = 0;
      let maxPartes = 0;
      for await (const lote of leitura.registros(500)) {
        for (const r of lote) {
          if (r.partes.length > maxPartes) maxPartes = r.partes.length;
          hashDoEstado(r.sistema, r.tipo, r.partes.reduce(aplicarParte, estadoVazio()));
        }
        registros += lote.length;
        await escritor.escrever(lote);
      }
      await escritor.fechar([]);
      out.registros = registros;
      out.maxPartes = maxPartes;
    } finally {
      leitura.fechar();
      rmSync(pasta, { recursive: true, force: true });
    }
  }
  await new Promise((r) => setTimeout(r, 20));
  clearInterval(amostrador);
  out.picoHeapMB = Math.round(pico / 1048576);
  out.maiorPausaMs = Math.round(maiorPausa);
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
  pasta = mkdtempSync(join(tmpdir(), 'omni-r3-filho-'));
  writeFileSync(join(pasta, 'filho.ts'), FILHO_LEITURA);
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

interface MedidaLeitura {
  recusado?: string;
  leituraMs: number;
  arquivos?: number;
  lidos?: number;
  registros?: number;
  maxPartes?: number;
  picoHeapMB: number;
  maiorPausaMs: number;
}

async function lerNoFilho(cenario: 'entradas' | 'copias', n: number): Promise<MedidaLeitura> {
  const filho = spawn(process.execPath, ['--max-old-space-size=512', '--expose-gc', pacote, cenario, String(n)], { cwd: RAIZ, stdio: ['ignore', 'pipe', 'pipe'] });
  let saida = '';
  let erro = '';
  filho.stdout.on('data', (d: Buffer) => (saida += d.toString()));
  filho.stderr.on('data', (d: Buffer) => (erro += d.toString()));
  const prazo = setTimeout(() => filho.kill('SIGKILL'), 170_000);
  const [codigo, sinal] = (await new Promise((ok) => filho.on('close', (c, s) => ok([c, s])))) as [number | null, string | null];
  clearTimeout(prazo);
  if (codigo !== 0) throw new Error(`processo filho falhou (${codigo} ${sinal ?? ''}): ${erro.slice(-1500)}`);
  const medida = JSON.parse(saida.trim().split('\n').pop()!) as MedidaLeitura;
  console.log(`[memória da importação, r3] ${JSON.stringify(medida)}`);
  return medida;
}

describe('importação: zip com muitas entradas e o mesmo arquivo repetido (processo filho com 512 MB de heap)', () => {
  it('IMPORTACAO-1: 300 mil entradas no diretório central (zip de ~17 MB): recusado na hora, sem montar a lista', async () => {
    const m = await lerNoFilho('entradas', 300_000);
    expect(m.recusado).toBe('O zip tem mais de 1.000 arquivos. Envie só os DBF ou CSV da exportação (em mais de um zip, se precisar).');
    expect(m.leituraMs).toBeLessThan(200);
    expect(m.picoHeapMB).toBeLessThan(64);
  }, 180_000);

  it('IMPORTACAO-2: mil cópias de um CSV de 100 linhas (100 mil linhas): uma parte por registro e o heap pequeno', async () => {
    const m = await lerNoFilho('copias', 1000);
    expect(m.recusado).toBeUndefined();
    expect(m).toMatchObject({ lidos: 100_000, registros: 100, maxPartes: 1 });
    expect(m.picoHeapMB).toBeLessThan(150);
    expect(m.maiorPausaMs).toBeLessThan(500);
  }, 180_000);
});

// ───────────── a API num filho (vite-node com o SWC) ─────────────

const enabled = await pgAvailable();

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

/**
 * O servidor: a API inteira, com uma leitura segura no gancho; responde aos comandos do teste pela entrada padrão.
 * `segurar` prende a próxima leitura no gancho (o arquivo dela fica na memória) até `soltar`; `ocupar` põe dois corpos
 * de outros tenants sendo lidos pelo serviço (as duas cargas do processo) até `desocupar`.
 */
const FILHO_SERVIDOR = `
import { createInterface } from 'node:readline';
import { startTestApp } from '${RAIZ}/apps/api/test/harness';
import { TenantsService } from '${RAIZ}/apps/api/src/core/database';
import { ImportacaoService } from '${RAIZ}/apps/api/src/modules/vigilancia/importacao.service';
import { CAMPOS_NINDINET, escreverDbf } from '${RAIZ}/apps/api/test/helpers/dbf-escrita';

const diga = (o) => process.stdout.write('@@R3 ' + JSON.stringify(o) + '\\n');
const t = await startTestApp('vigimpr3mem');
const vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
const tenants = t.app.get(TenantsService);
const tenant = await tenants.resolve(t.slug);
const db = await tenants.client(tenant.id);
let soltar = () => {};
let chegada = Promise.resolve();
const segurar = () => {
  let chegou = () => {};
  chegada = new Promise((r) => (chegou = r));
  const solto = new Promise((r) => (soltar = r));
  ImportacaoService.ganchoDeTeste = async (etapa) => {
    if (etapa !== 'LENDO') return;
    chegou();
    await solto;
  };
};
ImportacaoService.esperaMs = 0;
segurar();
const dbf = escreverDbf(CAMPOS_NINDINET, [{ NU_NOTIFIC: '5100001', TP_NOT: '2', ID_AGRAVO: 'A279', DT_NOTIFIC: '2024-05-02', ID_MUNICIP: '355030', ID_UNIDADE: '9000011' }]);
const r = await t.http().post('/api/vigilancia/importacoes').query({ nome: 'segura.dbf' }).set({ authorization: 'Bearer ' + vig }).set('Content-Type', 'application/octet-stream').send(dbf);
if (r.status !== 202) throw new Error('a leitura que segura a vez não começou: ' + r.status);
await chegada;
const mb = (x) => Math.round((x / 1048576) * 10) / 10;
// Memória retida fora do heap (os Buffers dos corpos): medida depois do coletor, a cada 10 ms. O que o Node lê e
// descarta (o corpo não pedido) é lixo e não conta; o corpo guardado conta.
let base = 0;
let pico = 0;
let amostrador = null;
const retida = () => {
  globalThis.gc();
  return process.memoryUsage().arrayBuffers - base;
};
let ocupados = [];
const comandos = {
  medir() {
    globalThis.gc();
    globalThis.gc();
    base = process.memoryUsage().arrayBuffers;
    pico = 0;
    clearInterval(amostrador);
    amostrador = setInterval(() => {
      const m = retida();
      if (m > pico) pico = m;
    }, 10);
    return { baseMB: mb(base) };
  },
  pico() {
    clearInterval(amostrador);
    const m = retida();
    if (m > pico) pico = m;
    return { picoMB: mb(pico) };
  },
  segurar() {
    segurar();
    return {};
  },
  async soltar() {
    ImportacaoService.ganchoDeTeste = null;
    soltar();
    await ImportacaoService.aguardarTrabalhos();
    return { cargas: ImportacaoService.cargas };
  },
  cargas() {
    return { cargas: ImportacaoService.cargas };
  },
  ocupar() {
    // Dois corpos de outros tenants sendo lidos (um envio por tenant): as duas cargas do processo.
    const svc = t.app.get(ImportacaoService);
    const ctx = (id) => ({ db, tenant: { ...tenant, id }, session: { userId: '00000000-0000-0000-0000-000000000000' }, ip: '127.0.0.1' });
    ocupados = ['tenant-b', 'tenant-c'].map((id) => {
      let ok = () => {};
      const fim = svc.enviar(ctx(id), () => new Promise((r) => (ok = r)), { nome: id + '.dbf' }).catch((e) => e);
      return { soltar: () => ok(Buffer.alloc(0)), fim };
    });
    return {};
  },
  async desocupar() {
    for (const o of ocupados) o.soltar();
    const codigos = (await Promise.all(ocupados.map((o) => o.fim))).map((e) => e?.code ?? null);
    ocupados = [];
    return { codigos, cargas: ImportacaoService.cargas };
  },
  async sair() {
    await ImportacaoService.aguardarTrabalhos();
    await t.close();
    return {};
  },
};
// Um comando por vez, na ordem em que chegam (sem for await: o SWC dos testes não o converte bem para o readline).
let fila = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (linha) => {
  const c = linha.trim();
  if (!c) return;
  fila = fila.then(async () => {
    diga({ comando: c, ...(await comandos[c]()) });
    if (c === 'sair') process.exit(0);
  });
});
diga({ pronto: true, url: t.baseUrl.replace('[::1]', '127.0.0.1'), token: vig });
`;

/** O filho do servidor e a conversa com ele (comando na entrada padrão; resposta numa linha "@@R3 {json}"). */
class Servidor {
  private readonly filho: ChildProcessWithoutNullStreams;
  private readonly fila: Record<string, unknown>[] = [];
  private espera: ((m: Record<string, unknown>) => void) | null = null;
  private log = '';
  readonly fim: Promise<number | null>;

  constructor(dir: string) {
    this.filho = spawn(
      process.execPath,
      ['--max-old-space-size=512', '--expose-gc', join(RAIZ, 'node_modules/vite-node/vite-node.mjs'), '--root', RAIZ, '--config', join(dir, 'vite.config.mjs'), join(dir, 'servidor.ts')],
      { cwd: RAIZ, env: process.env },
    );
    this.fim = new Promise((ok) => this.filho.on('close', (c) => ok(c)));
    createInterface({ input: this.filho.stdout }).on('line', (l) => {
      if (!l.startsWith('@@R3 ')) return;
      const m = JSON.parse(l.slice(5)) as Record<string, unknown>;
      if (this.espera) {
        const e = this.espera;
        this.espera = null;
        e(m);
      } else this.fila.push(m);
    });
    this.filho.stderr.on('data', (d: Buffer) => (this.log = (this.log + d.toString()).slice(-4000)));
  }

  proxima(ms = 120_000): Promise<Record<string, unknown>> {
    const m = this.fila.shift();
    if (m) return Promise.resolve(m);
    return new Promise((ok, falha) => {
      const prazo = setTimeout(() => falha(new Error(`o servidor filho não respondeu: ${this.log}`)), ms);
      this.espera = (x) => {
        clearTimeout(prazo);
        ok(x);
      };
    });
  }

  async pedir(comando: string): Promise<Record<string, unknown>> {
    this.filho.stdin.write(`${comando}\n`);
    return this.proxima();
  }

  matar() {
    this.filho.kill('SIGKILL');
  }
}

/**
 * Envio pelo cliente HTTP cru, com o corpo inteiro posto no socket de uma vez (`req.end(corpo)`). `antesDoFim`: a
 * resposta chegou com o corpo ainda saindo do cliente (o servidor respondeu sem esperar o corpo; 25 MB não cabem nos
 * buffers do socket sem o outro lado ler).
 */
function envio(url: string, token: string, nome: string, corpo: Buffer) {
  const u = new URL(url);
  const req = http.request({
    hostname: u.hostname,
    port: u.port,
    path: `/api/vigilancia/importacoes?nome=${encodeURIComponent(nome)}`,
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'content-length': String(corpo.length) },
  });
  let respondeu: { status: number; corpo: { code?: string; message?: string } | null; antesDoFim: boolean } | null = null;
  const resposta = new Promise<NonNullable<typeof respondeu>>((ok, falha) => {
    req.on('response', (res) => {
      const antesDoFim = !req.writableFinished;
      let s = '';
      res.on('data', (c: Buffer) => (s += c.toString()));
      res.on('end', () => {
        respondeu = { status: res.statusCode!, corpo: s ? JSON.parse(s) : null, antesDoFim };
        ok(respondeu);
      });
    });
    req.on('error', falha);
  });
  // O servidor fecha a conexão do corpo não lido (EPIPE/ECONNRESET depois da resposta): não é falha do teste.
  resposta.catch(() => undefined);
  req.end(corpo);
  return {
    resposta,
    get respondeu() {
      return respondeu;
    },
    fechar: () => req.destroy(),
  };
}

const esperarAte = async (fn: () => boolean | Promise<boolean>, ms = 10_000) => {
  const fim = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > fim) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe.runIf(enabled)('imp-memoria: a API num processo filho com 512 MB de heap', () => {
  let dir = '';
  let servidor: Servidor | null = null;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-r3-servidor-'));
    writeFileSync(join(dir, 'vite.config.mjs'), CONFIG_VITE);
    writeFileSync(join(dir, 'servidor.ts'), FILHO_SERVIDOR);
  });

  afterAll(async () => {
    servidor?.matar();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('envios simultâneos de 25 MB recebem 409 antes de o corpo ser lido e a memória do servidor não sobe com eles; dois do mesmo tenant ficam com um corpo só', async () => {
    servidor = new Servidor(dir);
    const pronto = await servidor.proxima();
    expect(pronto).toMatchObject({ pronto: true });
    const url = pronto.url as string;
    const token = pronto.token as string;
    const grande = Buffer.alloc(25 * MB, 0x20);
    const ocupada = { code: 'IMPORTACAO_OCUPADA', message: 'Outra importação está sendo processada agora. Tente de novo em alguns minutos.' };
    const cheio = { code: 'IMPORTACAO_SERVIDOR_OCUPADO', message: 'O servidor está recebendo ou processando outros envios agora. Tente de novo em instantes.' };
    const doTenant = { code: 'IMPORTACAO_SERVIDOR_OCUPADO', message: 'Outro envio da sua instituição está sendo recebido agora. Tente de novo quando ele terminar.' };

    // (b) Outra importação do tenant lendo (a do gancho): os três recebem 409 sem o servidor ler os corpos.
    await servidor.pedir('medir');
    const b = [1, 2, 3].map((i) => envio(url, token, `grande-b${i}.csv`, grande));
    await esperarAte(() => b.every((e) => e.respondeu));
    const picoB = (await servidor.pedir('pico')).picoMB as number;
    for (const e of b) expect(e.respondeu).toEqual({ status: 409, corpo: expect.objectContaining(ocupada), antesDoFim: true });
    b.forEach((e) => e.fechar());

    // (a) Nada rodando no tenant, mas dois corpos de outros tenants sendo lidos (o teto do processo; um envio por tenant,
    // quarta rodada): os três recebem 409 IMPORTACAO_SERVIDOR_OCUPADO.
    expect(await servidor.pedir('soltar')).toMatchObject({ cargas: 0 });
    await servidor.pedir('ocupar');
    await esperarAte(async () => (await servidor!.pedir('cargas')).cargas === 2);
    await servidor.pedir('medir');
    const a = [1, 2, 3].map((i) => envio(url, token, `grande-a${i}.csv`, grande));
    await esperarAte(() => a.every((e) => e.respondeu));
    const picoA = (await servidor.pedir('pico')).picoMB as number;
    for (const e of a) expect(e.respondeu).toEqual({ status: 409, corpo: expect.objectContaining(cheio), antesDoFim: true });
    a.forEach((e) => e.fechar());
    expect(await servidor.pedir('desocupar')).toMatchObject({ codigos: ['ARQUIVO_VAZIO', 'ARQUIVO_VAZIO'], cargas: 0 });

    // (c) Quarta rodada (N1): dois envios de 25 MB do mesmo tenant ao mesmo tempo, nada rodando. Um é lido e fica na
    // memória (a leitura presa no gancho); o outro recebe 409 antes de o corpo ser lido. A memória fica em um corpo e
    // não dobra (antes, os dois corpos eram lidos e o segundo só recebia o 409 depois). O lido mostra que a medida
    // enxerga o corpo guardado.
    await servidor.pedir('segurar');
    await servidor.pedir('medir');
    const c = [1, 2].map((i) => envio(url, token, `grande-c${i}.csv`, grande));
    // O corpo lido demora (o amostrador roda o coletor a cada 10 ms): espera as duas respostas, sem o prazo curto.
    await Promise.all(c.map((e) => e.resposta));
    const picoC = (await servidor.pedir('pico')).picoMB as number;
    const [aceito, recusado] = [...c].sort((x, y) => x.respondeu!.status - y.respondeu!.status);
    expect(aceito!.respondeu).toMatchObject({ status: 202, antesDoFim: false });
    expect(recusado!.respondeu).toEqual({ status: 409, corpo: expect.objectContaining(doTenant), antesDoFim: true });
    c.forEach((e) => e.fechar());
    expect(await servidor.pedir('soltar')).toMatchObject({ cargas: 0 });

    console.log(
      `[imp-memoria, r3 e r4] pico da memória retida fora do heap no servidor (depois do coletor): 3 envios de 25 MB recusados com a vez ocupada +${picoB} MB e com o teto do processo +${picoA} MB; dois envios de 25 MB do mesmo tenant (um lido, o outro recusado) +${picoC} MB`,
    );
    expect(picoB).toBeLessThan(10);
    expect(picoA).toBeLessThan(10);
    expect(picoC).toBeGreaterThanOrEqual(25);
    expect(picoC).toBeLessThan(40);
    await servidor.pedir('sair');
    expect(await servidor.fim).toBe(0);
    servidor = null;
  }, 240_000);
});
