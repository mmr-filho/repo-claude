// Teste de ponta a ponta da página do módulo: abre no Chromium, sob a política de segurança do mm.api.br, e usa a
// interface (escolha, panorama, gaveta com a norma, receitas paginadas, relatório, metodologia, parecer pela API).
// Requer um Chromium: CHROMIUM_PATH=/caminho, ou `npx playwright-core install chromium`.
//
//   npm run test:e2e -w @mm/transferencias
//
// O município é escolhido nos dados (o que tem mais achados) e a API do site é simulada aqui.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
const ler = (p) => JSON.parse(fs.readFileSync(path.join(RAIZ, p), 'utf8'));

const indice = ler('dados/indice.json');
const escolhido = [...indice.municipios].sort((a, b) => b.criticos - a.criticos || (b.criticos + b.alertas + b.oportunidades) - (a.criticos + a.alertas + a.oportunidades))[0];
const analise = ler(`dados/analise/${escolhido.ibge}.json`);
assert.ok(analise.achados.length >= 2, 'município de teste com poucos achados');

const servidor = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = path.join(RAIZ, p);
  if (!f.startsWith(RAIZ) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://127.0.0.1:${servidor.address().port}/`;

const executablePath = process.env.CHROMIUM_PATH ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const erros = [];
const passo = (nome) => console.log('ok  ' + nome);
try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 950 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => erros.push(e.message));
  pg.on('console', (m) => { if (m.type() === 'error' && !(m.location().url || '').includes('/api/')) erros.push(m.text()); });
  const texto = async (s) => (await pg.textContent(s)).replace(/\s+/g, ' ').trim();

  // escolha
  await pg.goto(base);
  await pg.waitForSelector('.tf-escolha-link');
  assert.equal(await pg.locator('.tf-escolha .item').count(), indice.municipios.length);
  await pg.click('text=Mais críticos primeiro');
  assert.match(await pg.locator('.tf-escolha .item').first().textContent(), /crítico/);
  await pg.fill('input[type=search]', escolhido.nome);
  await pg.click(`.tf-escolha a[href="#/m/${escolhido.ibge}"]`);
  await pg.waitForSelector('.tf-card');
  passo(`escolha por nome e por criticidade: ${escolhido.nome}`);

  // panorama
  assert.equal(await pg.locator('.tf-card').count(), analise.achados.length);
  const primeiro = analise.achados[0];
  assert.equal(await pg.locator('.tf-card').first().getAttribute('data-id'), primeiro.id);
  assert.match(await texto('.tf-card >> nth=0'), new RegExp(primeiro.nivel));
  assert.match(await texto('.tf-card >> nth=0'), /Responsável técnico:.*Sistema oficial:.*Ação corretiva:.*Prazo ou competência:/);
  assert.match(await texto('.tf-kpis'), /Repasses em risco/);
  const eixo = primeiro.eixo;
  await pg.click(`.tf-filtros button:has-text("${eixo}")`);
  assert.equal(await pg.locator('.tf-card').count(), analise.achados.filter((x) => x.eixo === eixo).length);
  await pg.click('.tf-filtros button:has-text("Todos")');
  passo('panorama: cartões na ordem do motor, passo a passo em 4 itens, filtro por eixo');

  // gaveta com a norma
  const id = primeiro.base_legal[0];
  const botao = pg.locator('.tf-card >> nth=0').locator('.tf-base button').first();
  await botao.click();
  await pg.waitForSelector('#tf-gaveta.aberta');
  assert.equal(await texto('#tf-gaveta-titulo'), analise.trechos[id].rotulo);
  assert.ok((await texto('.tf-norma-texto')).startsWith(analise.trechos[id].texto.slice(0, 40).replace(/\s+/g, ' ')));
  assert.doesNotMatch(await texto('#tf-gaveta-corpo'), /\bnull\b|undefined/);
  await pg.keyboard.press('Escape');
  assert.ok(await pg.locator('#tf-gaveta').isHidden());
  assert.ok(await botao.evaluate((b) => b === document.activeElement), 'foco volta ao botão');
  passo('gaveta: texto do dispositivo citado, Esc fecha e devolve o foco');

  // receitas paginadas
  await pg.click('nav >> text=Receitas e pares');
  await pg.waitForSelector('table');
  const tabela = pg.locator('table').first();
  const n = analise.receitas_federais.length;
  assert.equal(await tabela.locator('tbody tr').count(), Math.min(8, n));
  if (n > 8) {
    await pg.locator('.tf-paginas').first().locator('text=Próxima').click();
    assert.equal(await tabela.locator('tbody tr').count(), n - 8);
    assert.match(await pg.locator('.tf-paginas').first().textContent(), /página 2 de 2/);
  }
  passo('receitas por fonte com paginação e comparação com o grupo');

  await pg.click('nav >> text=Relatório');
  await pg.waitForSelector('.tf-relatorio');
  assert.equal(await pg.locator('.tf-relatorio .tf-card').count(), analise.achados.length);
  await pg.emulateMedia({ media: 'print' });
  assert.ok(await pg.locator('.topbar').isHidden());
  await pg.emulateMedia({ media: 'screen' });
  passo('relatório para impressão');

  await pg.click('nav >> text=Metodologia');
  await pg.waitForSelector('table');
  assert.equal(await pg.locator('table tbody tr').count(), ler('dados/rag/chunks.json').normas.length);
  passo('metodologia com as normas do corpus');

  // parecer pela API do site (simulada)
  const pedidos = [];
  let falha = false;
  const parecer = {
    ibge: analise.ibge, gerado_em: '2026-10-25T12:00:00Z', origem: 'agente', modelo: 'claude-opus-5-5',
    resumo_executivo: 'Resumo do consultor para o prefeito.',
    gargalos: [{ achado_id: primeiro.id, eixo: primeiro.eixo, nivel_criticidade: primeiro.nivel, diagnostico_direto: 'Diagnóstico redigido pelo consultor.',
      impacto_financeiro: 'Impacto redigido.', base_legal: [], passo_a_passo_operacional: { responsavel_tecnico: 'Equipe X', sistema_oficial: 'Sistema Y', acao_corretiva_exata: 'Ação Z', prazo_competencia_limite: 'Prazo W' } }],
    ajustes: ['um ajuste da conferência'],
  };
  let gerado = false;
  await pg.route('**/api/tf/**', (r) => {
    const req = r.request();
    const u = new URL(req.url()).pathname;
    pedidos.push({ metodo: req.method(), u, tipo: req.headers()['content-type'], corpo: req.postData() });
    if (u === `/api/tf/${analise.ibge}`) return r.fulfill({ json: analise });
    if (u === `/api/tf/${analise.ibge}/parecer` && req.method() === 'GET') return gerado ? r.fulfill({ json: parecer }) : r.fulfill({ status: 404, json: { erro: 'nenhum parecer' } });
    if (u === `/api/tf/${analise.ibge}/parecer` && req.method() === 'POST') {
      if (falha) return r.fulfill({ status: 429, json: { erro: 'limite' } });
      gerado = true;
      return r.fulfill({ json: parecer });
    }
    return r.fulfill({ status: 404 });
  });
  await pg.evaluate((ibge) => { document.getElementById('tf-app').dataset.api = '/api/tf'; location.hash = `#/m/${ibge}`; }, analise.ibge);
  await pg.waitForSelector('.tf-parecer button:has-text("Gerar parecer")');
  await pg.click('.tf-parecer button:has-text("Gerar parecer")');
  await pg.waitForSelector('.tf-resumo');
  const post = pedidos.find((p) => p.metodo === 'POST');
  assert.equal(post.tipo, 'application/json');
  assert.deepEqual(JSON.parse(post.corpo), { refazer: false });
  assert.equal(await texto('.tf-resumo'), 'Resumo do consultor para o prefeito.');
  assert.match(await texto('.tf-card >> nth=0'), /Diagnóstico redigido pelo consultor\..*Equipe X.*Sistema Y.*Ação Z.*Prazo W/);
  assert.match(await texto('.tf-card >> nth=0'), new RegExp(primeiro.impacto.anual >= 1000 ? 'R\\$' : ''), 'valor do motor continua no cartão');
  falha = true;
  await pg.click('.tf-parecer button:has-text("Gerar de novo")');
  await pg.waitForFunction(() => /Limite de pareceres/.test(document.querySelector('.tf-parecer .aviso[aria-live]')?.textContent || ''));
  passo('parecer pela API: gera, mostra o texto conferido nos cartões e avisa o limite');

  // celular
  const cel = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pc = await cel.newPage();
  pc.on('pageerror', (e) => erros.push(e.message));
  for (const aba of ['', '/receitas', '/relatorio']) {
    await pc.goto(`${base}#/m/${analise.ibge}${aba}`);
    await pc.waitForSelector('.mesa-titulo');
    assert.ok(!(await pc.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), `rolagem horizontal em ${aba || 'panorama'}`);
  }
  passo('celular sem rolagem horizontal');

  assert.deepEqual(erros, [], 'erros na página');
  passo('sem erros de console ou da política de segurança');
} finally {
  await browser.close();
  servidor.close();
}
