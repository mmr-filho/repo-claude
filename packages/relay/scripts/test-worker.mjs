// Roda o Worker no workerd (runtime local da Cloudflare) e executa contra ele:
//   1. o contrato HTTP e todos os cenários do nó (sem o limitador de taxa, que atrapalharia os testes);
//   2. a verificação do limitador de taxa, com a configuração real de produção.
// Uso: npm run test:worker -w @sigilo/relay
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'sigilo-worker-'));
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };

async function startWorker(config, port) {
  const child = spawn('npx', ['wrangler', 'dev', '--local', '-c', config, '--port', String(port), '--persist-to', join(work, String(port))], { cwd: root, env, stdio: 'ignore', detached: true });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) return child;
    } catch {
      /* ainda subindo */
    }
  }
  stop(child);
  throw new Error('o Worker não subiu em 60 s');
}

const stop = (child) => {
  try {
    process.kill(-child.pid);
  } catch {
    /* já encerrou */
  }
};

let failed = false;
try {
  // Configuração de teste: a mesma de produção, sem os limitadores de taxa.
  const prod = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  delete prod.ratelimits;
  writeFileSync(join(root, 'wrangler.test.json'), JSON.stringify(prod));

  console.log('• Worker sem limitador: contrato HTTP + cenários do nó');
  const a = await startWorker('wrangler.test.json', 8801);
  const run = spawnSync('node', ['--import', 'tsx', '--test', '--test-concurrency=1', 'test/http.conformance.test.ts', 'test/node.e2e.test.ts'], {
    cwd: root,
    env: { ...process.env, RELAY_URL: 'http://localhost:8801' },
    stdio: 'inherit',
  });
  stop(a);
  if (run.status !== 0) throw new Error('testes contra o Worker falharam');

  console.log('• Worker com a configuração real: limitador de criação de caixas');
  const b = await startWorker('wrangler.jsonc', 8802);
  const codes = [];
  for (let i = 0; i < 25; i++) {
    const qid = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
    codes.push((await fetch(`http://localhost:8802/q/${qid}`, { method: 'PUT', body: '{}' })).status);
  }
  stop(b);
  const limited = codes.filter((c) => c === 429).length;
  if (codes.slice(0, 20).includes(429) || limited !== 5) throw new Error(`limitador inesperado: ${codes.join(' ')}`);
  console.log('✔ limitador: 20 passaram, 5 receberam 429');
  console.log('\n✔ WORKER OK');
} catch (err) {
  failed = true;
  console.error('\n✘', err.message);
} finally {
  rmSync(join(root, 'wrangler.test.json'), { force: true });
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
