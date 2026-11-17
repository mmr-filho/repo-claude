import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyMigrations } from '@omnisaude/database';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, TEST_PG } from './harness';

/**
 * O Prisma 7 guarda em memória os argumentos das últimas 100 chamadas de depuração, mesmo com o DEBUG desligado: o
 * plano de cada consulta (com as linhas do createMany) e cada SQL enviado ao Postgres com os parâmetros. A instalação
 * desliga isso (packages/database/scripts/prisma-sem-historico.cjs; docs/PRISMA-MEMORIA.md). Estes testes falham se a
 * correção não estiver aplicada, se uma atualização do Prisma mudar o trecho corrigido ou se uma carga do tamanho de
 * uma importação grande do CNES deixar 40 MB ou mais retidos no heap de 512 MB do container.
 */

interface Arquivo {
  pacote: string;
  versao: string | null;
  arquivo: string | null;
  obrigatorio: boolean;
  situacao: string;
}
type FuncaoDebug = ((...args: unknown[]) => void) & { log: (...args: unknown[]) => void };
interface ModuloDebug {
  Debug: ((namespace: string) => FuncaoDebug) & { enable(namespace: string): void; disable(): string };
  getLogs(caracteres?: number): string;
  clearLogs(): void;
}

const requerer = createRequire(import.meta.url);
const correcao = requerer('../../../packages/database/scripts/prisma-sem-historico.cjs') as {
  corrigirTexto(texto: string): { texto: string; trechos: number };
  situacaoDoTexto(texto: string): string;
  verificar(): Arquivo[];
  orientacao(alvo: Arquivo): string;
};
const RAIZ = fileURLToPath(new URL('../../../', import.meta.url));
const TETO_MB = 40;
const enabled = await pgAvailable();

function rodarNode(args: string[], limiteMs: number) {
  // Sem NODE_OPTIONS e sem DEBUG herdados: o heap e o histórico do filho são os de produção.
  const { NODE_OPTIONS: _opcoes, DEBUG: _debug, ...env } = process.env;
  return new Promise<{ codigo: number | null; saida: string; erros: string }>((resolve, reject) => {
    const filho = spawn(process.execPath, args, { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '';
    let erros = '';
    filho.stdout.on('data', (d) => (saida += d));
    filho.stderr.on('data', (d) => (erros += d));
    const relogio = setTimeout(() => filho.kill('SIGKILL'), limiteMs);
    filho.on('error', reject);
    filho.on('close', (codigo) => {
      clearTimeout(relogio);
      resolve({ codigo, saida, erros });
    });
  });
}

function ultimoJson<T>(r: { codigo: number | null; saida: string; erros: string }): T {
  const linha = r.saida
    .trim()
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('{'));
  if (r.codigo !== 0 || !linha) throw new Error(`Processo filho saiu com ${r.codigo}:\n${r.erros.slice(-3000)}`);
  return JSON.parse(linha) as T;
}

// O trecho como está no Prisma 7.10.1, nas duas formas (o runtime minificado e o @prisma/debug legível), dentro de uma
// função que imprime em `impresso` quando o Prisma imprimiria.
const MINIFICADO = 'r=(...n)=>{let{enabled:i,namespace:o}=t;if(n.length!==0&&Lt.push([o,...n]),Lt.length>Mu&&Lt.shift(),Vt.enabled(o)||i){impresso.push(n)}}';
const LEGIVEL = `r = (...args) => {
    const { enabled, namespace: namespace2 } = t;
    if (args.length !== 0) {
      argsHistory.push([namespace2, ...args]);
    }
    if (argsHistory.length > MAX_ARGS_HISTORY) {
      argsHistory.shift();
    }
    if (topProps.enabled(namespace2) || enabled) {
      impresso.push(args);
    }
  }`;

function chamar(codigo: string, ligado: boolean) {
  const historico: unknown[] = [];
  const impresso: unknown[] = [];
  const habilitado = { enabled: () => ligado };
  const fabricar = new Function('t', 'Lt', 'argsHistory', 'Mu', 'MAX_ARGS_HISTORY', 'Vt', 'topProps', 'impresso', `let r;${codigo};return r;`);
  const debug = fabricar({ enabled: false, namespace: 'prisma:client:clientEngine' }, historico, historico, 100, 100, habilitado, habilitado, impresso);
  for (let i = 0; i < 150; i++) debug('query plan created', { linha: i });
  return { historico: historico.length, impresso: impresso.length };
}

describe('histórico de depuração do Prisma', () => {
  it('a correção está aplicada nos dois arquivos que a API carrega (falha quando uma atualização do Prisma muda o trecho)', () => {
    const obrigatorios = correcao.verificar().filter((a) => a.obrigatorio);
    expect(obrigatorios.map((a) => a.pacote)).toEqual(['@prisma/client', '@prisma/debug']);
    const faltando = obrigatorios.filter((a) => a.situacao !== 'aplicado').map((a) => correcao.orientacao(a));
    expect(faltando, faltando.join('\n')).toEqual([]);
  });

  it('a correção só guarda no histórico quando o Prisma também imprimiria (DEBUG ligado), nas duas formas do trecho', () => {
    for (const original of [MINIFICADO, LEGIVEL]) {
      const { texto, trechos } = correcao.corrigirTexto(original);
      expect(trechos).toBe(1);
      expect(correcao.situacaoDoTexto(original)).toBe('pendente');
      expect(correcao.situacaoDoTexto(texto)).toBe('aplicado');
      expect(correcao.corrigirTexto(texto).trechos).toBe(0);
      // O problema: com o DEBUG desligado nada é impresso, mas as últimas 100 chamadas ficam guardadas.
      expect(chamar(original, false)).toEqual({ historico: 100, impresso: 0 });
      expect(chamar(texto, false)).toEqual({ historico: 0, impresso: 0 });
      expect(chamar(texto, true)).toEqual(chamar(original, true));
      expect(chamar(texto, true)).toEqual({ historico: 100, impresso: 150 });
    }
  });

  it('o @prisma/debug que o adaptador pg usa não guarda as consultas com o DEBUG desligado', () => {
    const alvo = correcao.verificar().find((a) => a.pacote === '@prisma/debug' && a.obrigatorio)!;
    const { Debug, getLogs, clearLogs } = requerer(alvo.arquivo!) as ModuloDebug;
    const anterior = Debug.disable();
    try {
      clearLogs();
      const debug = Debug('omnisaude:teste:historico');
      debug.log = () => {};
      debug('[js::query_raw] %O', { sql: 'SELECT $1', args: ['dado do paciente'] });
      expect(getLogs()).toBe('');
      Debug.enable('omnisaude:teste:historico');
      debug('[js::query_raw] %O', { sql: 'SELECT $1', args: ['com o DEBUG ligado'] });
      expect(getLogs()).toContain('com o DEBUG ligado');
    } finally {
      clearLogs();
      Debug.enable(anterior);
    }
  });

  it('o runtime do cliente não guarda os planos com o DEBUG desligado e continua guardando com ele ligado', async () => {
    const runtime = correcao.verificar().find((a) => a.pacote === '@prisma/client' && a.obrigatorio)!.arquivo!;
    // 100 chamadas com 900 KB cada: o histórico sem a correção prende ~90 MB. A string vem de um Buffer para ser plana e
    // nova a cada chamada ('x'.repeat cria no V8 uma árvore de pedaços compartilhados, que quase não ocupa memória) e
    // fica abaixo de ~1 MB (acima disso o Node a guarda fora do heap do V8).
    const codigo = `
      const { Debug } = require(process.argv[1]);
      const mb = () => { for (let i = 0; i < 3; i++) gc(); return process.memoryUsage().heapUsed / 1048576; };
      const debug = Debug('omnisaude:teste:historico');
      debug.log = () => {};
      const carga = () => { for (let i = 0; i < 100; i++) debug('query plan created', { linhas: Buffer.alloc(900 * 1024, 120).toString('latin1') }); };
      const a = mb(); carga(); const desligado = mb() - a;
      Debug.enable('omnisaude:teste:historico');
      const b = mb(); carga(); const ligado = mb() - b;
      console.log(JSON.stringify({ desligado, ligado }));`;
    const r = ultimoJson<{ desligado: number; ligado: number }>(await rodarNode(['--expose-gc', '-e', codigo, runtime], 60_000));
    expect(r.desligado, `${r.desligado.toFixed(1)} MB retidos com o DEBUG desligado`).toBeLessThan(10);
    expect(r.ligado).toBeGreaterThan(50);
  });
});

describe.runIf(enabled)('teto de memória do Prisma no heap do container (512 MB)', () => {
  const sufixo = (process.env.OMNI_TEST_SUFFIX ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const banco = `omni_test_prisma_memoria${sufixo}`;
  const url = new URL(TEST_PG);
  const conexao = `postgresql://omni_app:omni_app@${url.hostname}:${url.port}/${banco}`;

  async function admin(sql: string) {
    const c = new Client({ connectionString: TEST_PG });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${banco} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${banco} OWNER omni_app`);
    await applyMigrations(conexao, 'tenant');
  }, 120_000);
  afterAll(() => admin(`DROP DATABASE IF EXISTS ${banco} WITH (FORCE)`));

  it(`cargas do tamanho de uma importação grande do CNES deixam menos de ${TETO_MB} MB retidos depois de terminar`, async () => {
    const tsx = pathToFileURL(requerer.resolve('tsx')).href;
    const carga = fileURLToPath(new URL('./prisma-memoria-carga.ts', import.meta.url));
    const r = ultimoJson<{ baseMB: number; cargas: { nome: string; linhas: number; ms: number; retidoMB: number }[] }>(
      await rodarNode(['--import', tsx, '--max-old-space-size=512', '--expose-gc', carga, conexao], 240_000),
    );
    const tabela = r.cargas.map((c) => `${String(c.retidoMB).padStart(7)} MB  ${String(c.linhas).padStart(6)} linhas  ${c.nome}`).join('\n');
    expect(r.cargas).toHaveLength(5);
    expect(
      r.cargas.filter((c) => c.retidoMB >= TETO_MB),
      `Heap retido acima do teto de ${TETO_MB} MB (base ${r.baseMB} MB):\n${tabela}`,
    ).toEqual([]);
  }, 300_000);
});
