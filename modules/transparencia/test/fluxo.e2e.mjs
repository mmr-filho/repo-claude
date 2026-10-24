// Teste de ponta a ponta do módulo Transparência: abre a página no Chromium, sob a mesma política de segurança
// do mm.api.br, e usa a interface (panorama, plano, acompanhamento, exportação, importação, CSV, relatório, API).
// Requer um Chromium. Use CHROMIUM_PATH=/caminho/do/chromium, ou instale um com `npx playwright-core install chromium`.
//
//   node modules/transparencia/test/fluxo.e2e.mjs
//
// O município é escolhido nos dados (um com item essencial pendente) e as verificações (Siconfi, sonda) e a API
// são simuladas aqui, para o teste não depender da rede nem quebrar quando os dados forem atualizados.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
const ler = (p) => JSON.parse(fs.readFileSync(path.join(RAIZ, p), 'utf8'));

// município com essencial pendente e com o RGF ou o RREO (11.5, 11.6) entre as pendências
const catalogo = new Map(ler('dados/criterios.json').criterios.map((c) => [c.id, c]));
const municipio = ler('dados/municipios.json').municipios
  .map((m) => ler(`dados/m/${m.ibge}.json`))
  .find((m) => m.pendencias.some((p) => catalogo.get(p.id).classe === 'Essencial') && m.pendencias.some((p) => p.id === '11.5' || p.id === '11.6'));
assert.ok(municipio, 'nenhum município com essencial pendente nos dados');
const essencial = municipio.pendencias.find((p) => catalogo.get(p.id).classe === 'Essencial').id;
const relatorio = municipio.pendencias.find((p) => p.id === '11.5' || p.id === '11.6').id;
const sel = (k, id) => `#tr-${k}-${id.replace('.', '-')}`;

const siconfi = { consultado_em: '2026-10-24', anos: [2025, 2026], municipios: { [municipio.ibge]: {
  rreo: [{ ano: 2026, periodo: 4, periodicidade: 'B', simplificado: false, data: '2026-09-30' }],
  rgf: [{ ano: 2026, periodo: 1, periodicidade: 'S', simplificado: true, data: '2026-07-28' }],
} } };
const sonda = { verificado_em: '2026-10-24T08:00Z', municipios: { [municipio.ibge]: {
  url: municipio.portal, status: 404, final: null, https: null, tempo: null, erro: 'HTTP 404', sinais: null,
} } };

const servidor = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = path.join(RAIZ, p);
  if (!f.startsWith(RAIZ) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://127.0.0.1:${servidor.address().port}/`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-e2e-'));

const executablePath = process.env.CHROMIUM_PATH ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const erros = [];
const passo = (nome) => console.log('ok  ' + nome);
try {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 1000 }, acceptDownloads: true });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => erros.push(e.message));
  pg.on('console', (m) => { if (m.type() === 'error' && !(m.location().url || '').includes('/api/')) erros.push(m.text()); });
  await pg.route('**/dados/siconfi.json', (r) => r.fulfill({ json: siconfi }));
  await pg.route('**/dados/sonda.json', (r) => r.fulfill({ json: sonda }));
  const texto = async (s) => (await pg.textContent(s)).replace(/\s+/g, ' ').trim();

  // escolha e panorama
  await pg.goto(base);
  await pg.fill('input[type=search]', municipio.nome);
  await pg.click(`.tr-escolha a[href="#/m/${municipio.ibge}"]`);
  await pg.waitForSelector('.tr-veredito');
  assert.match(await texto('.tr-alerta'), /essencia/i);
  assert.match(await texto('.tr-site'), /404/);
  assert.match(await texto('.tr-verif'), /RREO do 4º bimestre de 2026/);
  passo(`panorama de ${municipio.nome}: essenciais, 404 do portal e Siconfi`);

  // plano: dica do Siconfi e acompanhamento
  await pg.click('nav >> text=Plano de ação');
  await pg.waitForSelector('.tr-acomp');
  assert.match(await pg.locator(`article:has(${sel('s', relatorio)}) .tr-dica`).first().textContent(), /Siconfi/);
  await pg.selectOption(sel('s', essencial), 'concluida');
  await pg.fill(sel('resp', essencial), 'Contabilidade');
  await pg.fill(sel('evid', essencial), 'https://exemplo.to.gov.br/pagina');
  const outro = municipio.pendencias.find((p) => p.id !== essencial).id;
  await pg.fill(sel('prazo', outro), '2020-01-31');
  await pg.selectOption(sel('s', outro), 'andamento');
  await pg.waitForTimeout(900);
  assert.ok(await pg.locator(`article:has(${sel('s', essencial)})`).evaluate((e) => e.classList.contains('est-cumprido')));
  assert.ok(await pg.locator(`article:has(${sel('s', outro)}) .chip-fatal:has-text("Atrasada")`).isVisible());
  assert.match(await texto('.tr-salvo'), /salvo neste navegador/);
  passo('acompanhamento: situação, responsável, evidência e prazo vencido');

  await pg.reload();
  await pg.waitForSelector('.tr-acomp');
  assert.equal(await pg.inputValue(sel('resp', essencial)), 'Contabilidade');
  passo('acompanhamento persiste após recarregar');

  const [exp] = await Promise.all([pg.waitForEvent('download'), pg.click('text=Exportar acompanhamento')]);
  const arquivo = path.join(tmp, 'acomp.json');
  await exp.saveAs(arquivo);
  assert.equal(JSON.parse(fs.readFileSync(arquivo, 'utf8')).acoes[essencial].s, 'concluida');
  await pg.evaluate(() => localStorage.clear());
  await pg.reload();
  await pg.waitForSelector('.tr-acomp');
  assert.equal(await pg.inputValue(sel('s', essencial)), 'pendente');
  await pg.setInputFiles('input[type=file]', arquivo);
  await pg.waitForFunction((s) => document.querySelector(s).value === 'concluida', sel('s', essencial));
  const errado = path.join(tmp, 'outro.json');
  fs.writeFileSync(errado, JSON.stringify({ ...JSON.parse(fs.readFileSync(arquivo, 'utf8')), ibge: 1 }));
  await pg.setInputFiles('input[type=file]', errado);
  await pg.waitForFunction(() => /Não foi possível importar/.test(document.querySelector('.tr-salvo').textContent));
  passo('exportar, importar e recusar arquivo de outro município');

  const [csv] = await Promise.all([pg.waitForEvent('download'), pg.click('text=Baixar CSV')]);
  const conteudo = fs.readFileSync(await csv.path(), 'utf8');
  assert.match(conteudo, /Concluída/);
  assert.match(conteudo, /Contabilidade/);
  passo('CSV com situação e responsável');

  await pg.click('nav >> text=Relatório');
  await pg.waitForSelector('.tr-relatorio');
  const rel = await texto('.tr-relatorio');
  assert.match(rel, /Contabilidade/);
  assert.match(rel, /atrasada/);
  passo('relatório com responsável e atraso');

  // API do site (simulada): GET sem dados (404), PUT a cada mudança, erro mostrado ao usuário
  const recebidos = [];
  await pg.route('**/api/acomp/**', (r) => {
    if (r.request().method() === 'GET') return r.fulfill({ status: 404, body: '' });
    recebidos.push({ metodo: r.request().method(), url: r.request().url(), corpo: r.request().postDataJSON() });
    return r.fulfill({ status: 204, body: '' });
  });
  await pg.evaluate((ibge) => { document.getElementById('tr-app').dataset.api = '/api/acomp'; location.hash = `#/m/${ibge}/plano`; }, municipio.ibge);
  await pg.waitForFunction(() => /servidor do site/.test(document.querySelector('.tr-salvo')?.textContent || ''));
  await pg.selectOption(sel('s', essencial), 'andamento');
  await pg.waitForTimeout(300);
  assert.equal(recebidos.length, 1);
  assert.equal(recebidos[0].metodo, 'PUT');
  assert.ok(recebidos[0].url.endsWith(`/api/acomp/${municipio.ibge}`));
  assert.equal(recebidos[0].corpo.acoes[essencial].s, 'andamento');
  await pg.unroute('**/api/acomp/**');
  await pg.route('**/api/acomp/**', (r) => r.fulfill({ status: 500, body: '' }));
  await pg.selectOption(sel('s', essencial), 'concluida');
  await pg.waitForFunction(() => /Não foi possível salvar/.test(document.querySelector('.tr-salvo').textContent));
  passo('API: PUT com o estado e erro do servidor visível');

  // celular
  const cel = await browser.newContext({ viewport: { width: 390, height: 840 } });
  const pc = await cel.newPage();
  pc.on('pageerror', (e) => erros.push(e.message));
  for (const aba of ['', '/plano']) {
    await pc.goto(`${base}#/m/${municipio.ibge}${aba}`);
    await pc.waitForSelector('.mesa-titulo');
    assert.ok(!(await pc.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `rolagem horizontal em ${aba || 'panorama'}`);
  }
  passo('celular sem rolagem horizontal');

  assert.deepEqual(erros, [], 'erros na página');
  passo('sem erros de console ou da política de segurança');
} finally {
  await browser.close();
  servidor.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
