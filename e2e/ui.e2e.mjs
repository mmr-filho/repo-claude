// Teste de interface de ponta a ponta: servidor real + app real (exportado para web) + Chromium.
// Conduz o app como pessoas fariam: ativar contas, escrever, trancar, destrancar, ler, conectar redes.
//
//   npm run test:e2e
//
// Requer um Chromium. Use CHROMIUM_PATH=/caminho/do/chromium, ou instale um com `npx playwright-core install chromium`.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sigilo-e2e-'));
const SHOTS = process.env.SHOTS_DIR ?? path.join(WORK, 'shots');
const DB = path.join(WORK, 'e2e.db');
const API_PORT = Number(process.env.E2E_API_PORT ?? 3111);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 8080);
const BASE = `http://localhost:${WEB_PORT}`;
fs.mkdirSync(SHOTS, { recursive: true });

const step = (msg) => console.log(`• ${msg}`);
const run = (cmd, args, env = {}, cwd = ROOT) => execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

// ───── Preparação: build do servidor e do app para web ─────
step('compilando servidor e exportando o app para web');
run('npm', ['run', 'build', '-w', '@sigilo/server']);
const DIST = path.join(WORK, 'web');
run('npx', ['expo', 'export', '--platform', 'web', '--output-dir', DIST], { SIGILO_E2E: '1', CI: '1', EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1' }, path.join(ROOT, 'apps/mobile'));

const env = { ...process.env, DB_PATH: DB, PORT: String(API_PORT), LOG: 'off', NODE_NO_WARNINGS: '1' };
const cli = (...args) => execFileSync('node', [path.join(ROOT, 'packages/server/dist/cli.js'), ...args], { env, encoding: 'utf8' });
const CODE = /[0-9A-Z]{4}(?:-[0-9A-Z]{4}){3}/;

// O operador do servidor cria as redes e seus administradores (única forma de nascer uma rede).
const martaCode = cli('create-network', '--slug', 'unirg', '--name', 'UniRG', '--admin', 'marta', '--admin-name', 'Marta Admin').match(CODE)[0];
const zecaCode = cli('create-network', '--slug', 'clinica', '--name', 'Clínica Vida', '--admin', 'zeca', '--admin-name', 'Zeca Gestor').match(CODE)[0];

const api = spawn('node', [path.join(ROOT, 'packages/server/dist/index.js')], { env, stdio: 'inherit' });
const web = await serve({ dist: DIST, apiPort: API_PORT, port: WEB_PORT });
await new Promise((r) => setTimeout(r, 1500));

const executablePath = process.env.CHROMIUM_PATH ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const errors = [];

async function newUser(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push(`${name} console: ${m.text()}`));
  await page.goto(BASE);
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const label = (page, text) => page.getByLabel(text, { exact: true });
const text = (page, t, opts = {}) => page.getByText(t, { exact: true, ...opts });
const tap = (page, t) => text(page, t).first().click();

async function activate(page, handle, code, password) {
  await tap(page, 'Ativar conta');
  await label(page, 'Servidor').fill(BASE);
  await label(page, 'Usuário').fill(handle);
  await label(page, 'Código de ativação').fill(code);
  await label(page, 'Escolha sua senha').fill(password);
  await label(page, 'Repita a senha').fill(password);
  await tap(page, 'Ativar e entrar');
  await text(page, 'Conversas').first().waitFor({ timeout: 30000 });
}

async function createMember(admin, username, name) {
  await tap(admin, 'Rede');
  await tap(admin, '+ Novo membro');
  await label(admin, 'Usuário (sem espaços)').fill(username);
  await label(admin, 'Nome').fill(name);
  await tap(admin, 'Criar e gerar código');
  const code = (await admin.getByText(CODE).first().textContent()).match(CODE)[0];
  await shot(admin, `admin-codigo-${username}`);
  await tap(admin, 'Pronto');
  return code;
}

try {
  step('administradora ativa a conta e cadastra os membros');
  const marta = await newUser('marta');
  await shot(marta, '01-login');
  await activate(marta, 'marta@unirg', martaCode, 'senha-da-marta-1');
  const anaCode = await createMember(marta, 'ana', 'Ana Souza');
  const brunoCode = await createMember(marta, 'bruno', 'Bruno Lima');
  await shot(marta, '02-admin-membros');
  const ana = await newUser('ana');
  await activate(ana, 'ana@unirg', anaCode, 'ana-senha-segura');
  const bruno = await newUser('bruno');
  await activate(bruno, 'bruno@unirg', brunoCode, 'bruno-senha-segura');

  step('Ana escreve para Bruno');
  await tap(ana, 'Contatos');
  await shot(ana, '03-contatos');
  await tap(ana, 'Bruno Lima');
  await ana.getByText('Verificar', { exact: false }).first().waitFor();
  const SEGREDO = 'Reunião às 15h na sala 4 — traga o contrato';
  await ana.getByPlaceholder('Mensagem').fill(SEGREDO);
  await tap(ana, 'Enviar');
  await text(ana, SEGREDO).waitFor();
  await shot(ana, '04-ana-enviou');

  step('Bruno é avisado em tempo real, sem ver o texto');
  await text(bruno, '🔒 1 mensagem nova').waitFor({ timeout: 8000 });
  assert.equal(await bruno.getByText('Reunião').count(), 0, 'texto da mensagem vazou na lista');
  await shot(bruno, '05-bruno-aviso');

  step('Bruno reabre o app: cofre trancado até digitar a senha');
  await bruno.reload();
  await text(bruno, '🔒 Cofre trancado').waitFor({ timeout: 30000 });
  await bruno.getByText('1 mensagem aguarda', { exact: false }).waitFor();
  assert.equal(await bruno.getByText('Reunião').count(), 0);
  await shot(bruno, '06-bruno-trancado');
  await label(bruno, 'Senha').fill('senha-errada-123');
  await tap(bruno, 'Destrancar');
  await text(bruno, 'Senha incorreta').waitFor({ timeout: 30000 });
  await shot(bruno, '07-senha-errada');
  await label(bruno, 'Senha').fill('bruno-senha-segura');
  await tap(bruno, 'Destrancar');
  await text(bruno, '🔒 1 mensagem nova').waitFor({ timeout: 30000 });

  step('Bruno lê; a mensagem some do servidor e da tela de Ana');
  await tap(bruno, 'Ana Souza');
  await text(bruno, SEGREDO).waitFor({ timeout: 10000 });
  await shot(bruno, '08-bruno-leu');
  await text(ana, '🔥 Lida e apagada').waitFor({ timeout: 8000 });
  assert.equal(await ana.getByText(SEGREDO).count(), 0, 'texto continuou na tela da remetente');
  await shot(ana, '09-ana-lida-apagada');

  step('ao sair e voltar, a mensagem não reaparece');
  await bruno.getByText('‹', { exact: true }).first().click();
  await tap(bruno, 'Contatos');
  await tap(bruno, 'Ana Souza');
  await bruno.getByText('Verificar', { exact: false }).first().waitFor();
  await bruno.waitForTimeout(800);
  assert.equal(await bruno.getByText(SEGREDO).count(), 0, 'mensagem reapareceu');
  await shot(bruno, '10-bruno-volta-vazio');

  step('redes: pedido de conexão aceito pelo administrador da outra rede');
  const zeca = await newUser('zeca');
  await activate(zeca, 'zeca@clinica', zecaCode, 'zeca-senha-segura');
  await tap(marta, 'Redes conectadas');
  await label(marta, 'Código da outra rede').fill('clinica');
  await tap(marta, 'Enviar pedido');
  await tap(zeca, 'Rede');
  await tap(zeca, 'Redes conectadas');
  await text(zeca, 'Pedidos recebidos').waitFor({ timeout: 10000 });
  await shot(zeca, '11-zeca-pedido');
  await tap(zeca, 'Aceitar');
  await text(zeca, 'Pedidos recebidos').waitFor({ state: 'detached', timeout: 10000 });
  await shot(zeca, '12-zeca-conectada');

  await ana.getByText('‹', { exact: true }).first().click();
  await tap(ana, 'Contatos');
  await text(ana, 'CLÍNICA VIDA · REDE CONECTADA').waitFor({ timeout: 10000 });
  await shot(ana, '13-ana-contatos-rede-conectada');

  assert.deepEqual(errors, [], `erros no navegador:\n${errors.join('\n')}`);
  console.log(`\n✔ TODOS OS PASSOS PASSARAM (capturas de tela em ${SHOTS})`);
} catch (err) {
  console.error('\n✘ FALHOU:', err.message);
  for (const ctx of browser.contexts()) {
    let i = 0;
    for (const p of ctx.pages()) await p.screenshot({ path: path.join(SHOTS, `falha-${Date.now()}-${i++}.png`) }).catch(() => {});
  }
  if (errors.length) console.error('Erros do navegador:\n' + errors.join('\n'));
  console.error(`Capturas em ${SHOTS}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  api.kill();
  web.close();
  if (!process.env.KEEP_E2E_FILES && process.exitCode !== 1) fs.rmSync(WORK, { recursive: true, force: true });
}
