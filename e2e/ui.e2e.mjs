// Teste de interface de ponta a ponta do Sigilo v2: relé real + app real (exportado para web) + Chromium.
// Conduz o app como pessoas fariam: criar a rede, convidar, entrar, conversar, trancar, destrancar, conectar redes.
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
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT ?? 3111);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 8080);
const BASE = `http://localhost:${WEB_PORT}`;
fs.mkdirSync(SHOTS, { recursive: true });

const step = (msg) => console.log(`• ${msg}`);
const run = (cmd, args, env = {}, cwd = ROOT) => execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

step('compilando o relé e exportando o app para web');
run('npm', ['run', 'build', '-w', '@sigilo/relay']);
const DIST = path.join(WORK, 'web');
// POLL_MS curto: no teste as mensagens precisam chegar em menos de um segundo.
run('npx', ['expo', 'export', '--platform', 'web', '--output-dir', DIST], { SIGILO_E2E: '1', CI: '1', EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1', EXPO_PUBLIC_POLL_MS: '600', EXPO_PUBLIC_RELAY_URL: BASE }, path.join(ROOT, 'apps/mobile'));

const relay = spawn('node', [path.join(ROOT, 'packages/relay/dist/node-server.js')], {
  cwd: path.join(ROOT, 'packages/relay'),
  env: { ...process.env, DB_PATH: path.join(WORK, 'relay.db'), PORT: String(RELAY_PORT), HOST: '127.0.0.1', NODE_NO_WARNINGS: '1' },
  stdio: 'inherit',
});
const web = await serve({ dist: DIST, apiPort: RELAY_PORT, port: WEB_PORT });
await new Promise((r) => setTimeout(r, 1500));

const executablePath = process.env.CHROMIUM_PATH ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const errors = [];

async function newUser(name, viewport = { width: 390, height: 844 }, { biometric = false } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  if (biometric) await page.addInitScript(() => window.localStorage.setItem('e2e.bioAvailable', '1'));
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push(`${name} console: ${m.text()}`));
  await page.goto(BASE);
  return page;
}
let shotCount = 0;
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${String(++shotCount).padStart(2, '0')}-${name}.png`) });
const label = (page, text) => page.getByLabel(text, { exact: true });
const text = (page, t, opts = {}) => page.getByText(t, { exact: true, ...opts });
const tap = (page, t) => text(page, t).first().click();
const PASSWORD = (n) => `senha-forte-${n}`;
const CODE_RE = /sigilo2-(convite|rede):[A-Za-z0-9_-]+/;

async function createNetwork(page, { name, network, password = PASSWORD(name) }, shotName) {
  if (!(await page.getByLabel('Seu nome').count())) await tap(page, 'Criar uma rede');
  await label(page, 'Seu nome').fill(name);
  await label(page, 'Nome da rede').fill(network);
  await label(page, 'Escolha uma senha').fill(password);
  await label(page, 'Repita a senha').fill(password);
  if (shotName) await shot(page, shotName);
  await tap(page, 'Criar rede');
  await text(page, 'Conversas').first().waitFor({ timeout: 30000 });
}

/** Lê o código mostrado na folha de código (texto e QR) e a fecha. */
async function readCodeSheet(page, shotName) {
  await page.getByLabel('QR code').first().waitFor();
  await page.waitForTimeout(500); // fim da animação de abertura
  if (shotName) await shot(page, shotName);
  const code = (await page.getByLabel('Código em texto').first().textContent()).match(CODE_RE)[0];
  await tap(page, 'Pronto');
  return code;
}

async function invite(admin, person) {
  await tap(admin, 'Rede');
  await tap(admin, 'Convites');
  await label(admin, 'Nome da pessoa').fill(person);
  await tap(admin, 'Gerar convite');
  return readCodeSheet(admin, `convite-${person.split(' ')[0].toLowerCase()}`);
}

async function join(page, code, who, shotName) {
  await tap(page, 'Entrar com convite');
  await label(page, 'Código do convite').fill(code);
  await label(page, 'Escolha uma senha').fill(PASSWORD(who));
  await label(page, 'Repita a senha').fill(PASSWORD(who));
  if (shotName) await shot(page, shotName);
  await tap(page, 'Entrar na rede');
  await text(page, '⏳ Aguardando aprovação').waitFor({ timeout: 30000 });
}

try {
  step('a administradora cria a rede e convida duas pessoas');
  const marta = await newUser('marta');
  await shot(marta, 'boas-vindas');
  // O endereço do relé não é pedido: vem de dentro do app.
  await tap(marta, 'Criar uma rede');
  assert.equal(await marta.getByLabel('Endereço do relé').count(), 0, 'o cadastro não deve pedir o endereço do relé');
  // Senha mínima de 6 caracteres: 5 é recusada.
  await label(marta, 'Seu nome').fill('Marta');
  await label(marta, 'Nome da rede').fill('UniRG');
  await label(marta, 'Escolha uma senha').fill('ab12c');
  await label(marta, 'Repita a senha').fill('ab12c');
  await tap(marta, 'Criar rede');
  await text(marta, 'A senha precisa ter pelo menos 6 caracteres').waitFor();
  await shot(marta, 'senha-curta-recusada');
  await marta.reload();
  await createNetwork(marta, { name: 'Marta', network: 'UniRG' }, 'criar-rede-formulario');
  await shot(marta, 'rede-criada-conversas-vazio');
  const anaCode = await invite(marta, 'Ana Souza');
  await shot(marta, 'convite-gerado');
  const brunoCode = await invite(marta, 'Bruno Lima');

  step('Ana e Bruno entram com o convite; a aprovação vem sozinha quando a administradora está com o app aberto');
  const ana = await newUser('ana', undefined, { biometric: true });
  await join(ana, anaCode, 'Ana', 'ana-entra-com-convite');
  await shot(ana, 'aguardando-aprovacao');
  await text(ana, 'Contatos').first().waitFor({ timeout: 30000 });
  const bruno = await newUser('bruno');
  await join(bruno, brunoCode, 'Bruno');
  await text(bruno, 'Contatos').first().waitFor({ timeout: 30000 });

  step('Ana vê os colegas (lista assinada pela administradora) e escreve para Bruno');
  await tap(ana, 'Contatos');
  await text(ana, 'Bruno Lima').waitFor({ timeout: 30000 });
  await shot(ana, 'contatos');
  await tap(ana, 'Bruno Lima');
  const SEGREDO = 'Reunião às 15h na sala 4 — traga o contrato';
  await ana.getByPlaceholder('Mensagem').fill(SEGREDO);
  await shot(ana, 'ana-digitando-mensagem');
  await tap(ana, 'Enviar');
  await text(ana, SEGREDO).waitFor();
  await shot(ana, 'ana-enviou');

  step('Bruno é avisado, sem ver o texto');
  await text(bruno, '🔒 1 mensagem nova').waitFor({ timeout: 30000 });
  assert.equal(await bruno.getByText('Reunião').count(), 0, 'o texto vazou na lista');
  await shot(bruno, 'bruno-aviso');

  step('Bruno reabre o app: cofre trancado, exige a senha');
  await bruno.reload();
  await text(bruno, '🔒 Cofre trancado').waitFor({ timeout: 30000 });
  await bruno.getByText('item aguarda', { exact: false }).waitFor({ timeout: 15000 });
  assert.equal(await bruno.getByText('Reunião').count(), 0);
  await shot(bruno, 'bruno-trancado');
  await label(bruno, 'Senha').fill('senha-errada-123');
  await tap(bruno, 'Destrancar com a senha');
  await text(bruno, 'Senha incorreta').waitFor({ timeout: 30000 });
  await shot(bruno, 'bruno-senha-incorreta');
  await label(bruno, 'Senha').fill(PASSWORD('Bruno'));
  await tap(bruno, 'Destrancar com a senha');
  await text(bruno, '🔒 1 mensagem nova').waitFor({ timeout: 30000 });

  step('Bruno lê; a mensagem some do relé e do texto de Ana');
  await tap(bruno, 'Ana Souza');
  await text(bruno, SEGREDO).waitFor({ timeout: 15000 });
  await shot(bruno, 'bruno-leu');
  await text(ana, '🔥 Lida e apagada').waitFor({ timeout: 30000 });
  assert.equal(await ana.getByText(SEGREDO).count(), 0, 'o texto continuou na tela da remetente');
  await shot(ana, 'ana-lida-apagada');

  step('ao sair e voltar, a mensagem não reaparece');
  await bruno.getByLabel('Voltar').click();
  await tap(bruno, 'Contatos');
  await tap(bruno, 'Ana Souza');
  await bruno.getByText('Verificar', { exact: false }).first().waitFor();
  await bruno.waitForTimeout(1500);
  assert.equal(await bruno.getByText(SEGREDO).count(), 0, 'a mensagem reapareceu');

  step('Bruno responde; Ana lê a resposta e a mensagem dele também some');
  const RESPOSTA = 'Combinado, levo o contrato assinado.';
  await bruno.getByPlaceholder('Mensagem').fill(RESPOSTA);
  await tap(bruno, 'Enviar');
  await text(ana, RESPOSTA).waitFor({ timeout: 30000 });
  await shot(ana, 'ana-recebe-resposta');
  await text(bruno, '🔥 Lida e apagada').waitFor({ timeout: 30000 });
  await shot(bruno, 'bruno-resposta-lida-e-apagada');

  step('administração e ajustes');
  await tap(marta, 'Membros');
  await text(marta, 'Bruno Lima').waitFor({ timeout: 15000 });
  await shot(marta, 'admin-membros');
  await tap(marta, 'Ajustes');
  await text(marta, 'Trancar ao sair do app').waitFor();
  await shot(marta, 'ajustes');
  await tap(marta, 'Rede');

  step('Ana usa a digital: cancelar mantém trancado; o toque destranca; desativar e reativar pelos Ajustes');
  await ana.getByLabel('Voltar').click();
  await tap(ana, 'Ajustes');
  await text(ana, 'Destravar com a digital').waitFor();
  await text(ana, 'Desativar').waitFor(); // ativada no cadastro (caixa marcada)
  await shot(ana, 'ajustes-digital-ativada');
  await ana.evaluate(() => { window.__e2eBio = 'cancel'; });
  await tap(ana, '🔒 Trancar agora');
  await text(ana, '🔒 Cofre trancado').waitFor();
  await ana.getByText('Destrancar com a digital', { exact: false }).first().waitFor();
  await ana.waitForTimeout(800);
  assert.equal(await text(ana, '🔒 Cofre trancado').count(), 1, 'cancelar a digital não pode destrancar');
  await shot(ana, 'cofre-com-botao-da-digital');
  await ana.evaluate(() => { window.__e2eBio = ''; });
  await ana.getByText('Destrancar com a digital', { exact: false }).first().click();
  await text(ana, 'Conversas').first().waitFor({ timeout: 15000 });
  await tap(ana, 'Ajustes');
  await tap(ana, 'Desativar');
  await text(ana, 'Digital desativada. Use a senha para destrancar.').waitFor();
  await tap(ana, 'Ativar');
  await label(ana, 'Senha').fill('senha-errada-9');
  await ana.getByRole('button', { name: 'Ativar' }).last().click();
  await text(ana, 'Senha incorreta').waitFor({ timeout: 15000 });
  await label(ana, 'Senha').fill(PASSWORD('Ana'));
  await ana.getByRole('button', { name: 'Ativar' }).last().click();
  await text(ana, 'Digital ativada. Na próxima vez, toque no sensor para destrancar.').waitFor({ timeout: 15000 });
  await shot(ana, 'digital-reativada');
  await tap(ana, 'Conversas');

  step('segunda rede (Clínica Vida) pede conexão; a administradora da UniRG aceita');
  // Celular pequeno (360×640): a folha com o QR code precisa caber, ou rolar.
  const zeca = await newUser('zeca', { width: 360, height: 640 });
  await createNetwork(zeca, { name: 'Zeca', network: 'Clínica Vida', password: 'zeca12' }, 'senha-de-6-caracteres-com-aviso');
  await tap(zeca, 'Rede');
  await tap(zeca, 'Conexões');
  await tap(zeca, 'Mostrar código da rede');
  const zecaCode = await readCodeSheet(zeca, 'codigo-da-rede-celular-pequeno');
  await tap(marta, 'Conexões');
  await label(marta, 'Código da outra rede').fill(zecaCode);
  await tap(marta, 'Enviar pedido');
  await text(zeca, 'Pedidos recebidos').waitFor({ timeout: 30000 });
  await shot(zeca, 'zeca-pedido');
  await tap(zeca, 'Aceitar');
  await text(zeca, 'UniRG').first().waitFor({ timeout: 30000 });

  step('os membros das duas redes passam a se ver (e só os das redes vinculadas)');
  await tap(ana, 'Contatos');
  await text(ana, 'CLÍNICA VIDA · REDE CONECTADA').waitFor({ timeout: 30000 });
  await text(ana, 'Zeca').first().waitFor();
  await shot(ana, 'contatos-rede-conectada');

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
  relay.kill();
  web.close();
  if (!process.env.KEEP_E2E_FILES && process.exitCode !== 1) fs.rmSync(WORK, { recursive: true, force: true });
}
