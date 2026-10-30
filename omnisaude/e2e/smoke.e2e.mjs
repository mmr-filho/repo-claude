// Teste de fumaça da interface: percorre as telas principais de cada papel no tenant "demo".
// Pré-requisitos: API em http://localhost:3001 (com a carga de demonstração) e web em WEB_URL.
//   node e2e/smoke.e2e.mjs
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

// require (e não import) para achar também um Playwright instalado globalmente (NODE_PATH).
const { chromium } = createRequire(import.meta.url)('playwright');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const OUT = process.env.SCREENSHOTS ?? './e2e-screenshots';
const PASSWORD = 'OmniSaude2026';
mkdirSync(OUT, { recursive: true });

const journeys = [
  { cpf: '100.000.001-08', unit: 'UBS Centro', role: 'Recepção', pages: ['/recepcao', '/agenda'] },
  { cpf: '100.000.002-80', unit: 'UPA 24h Norte', role: 'Enfermagem', pages: ['/triagem'] },
  { cpf: '100.000.003-61', unit: 'UPA 24h Norte', role: 'Médico', pages: ['/atendimentos', '/pacientes'] },
  { cpf: '100.000.007-95', unit: 'Hospital Municipal São Lucas', role: 'Farmácia', pages: ['/farmacia'] },
  { cpf: '100.000.006-04', unit: null, role: 'NIR', pages: ['/leitos'] },
  { cpf: '100.000.008-76', unit: 'UPA 24h Norte', role: 'Faturamento', pages: ['/faturamento'] },
  { cpf: '100.000.009-57', unit: 'UBS Centro', role: 'Gestor', pages: ['/gestao', '/bi', '/auditoria'] },
  { cpf: '100.000.005-23', unit: 'UBS Centro', role: 'Serviço Social', pages: ['/servico-social'] },
];

const browser = await chromium.launch();
let failures = 0;
let step = 0;
for (const j of journeys) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${WEB}/login`);
    await page.getByLabel('Instituição').fill('demo');
    await page.getByLabel('CPF').fill(j.cpf);
    await page.getByLabel('Senha').fill(PASSWORD);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.waitForURL(/\/(contexto|inicio)/);
    if (page.url().includes('/contexto')) {
      const option = j.unit ? page.getByRole('button', { name: new RegExp(`${j.unit}.*${j.role}`) }) : page.getByRole('button').first();
      await option.first().click();
    }
    await page.waitForURL(/\/inicio/);
    for (const path of j.pages) {
      await page.goto(`${WEB}${path}`);
      // O Socket.IO mantém a rede ativa: espera o carregamento e um intervalo para as chamadas da API.
      await page.waitForLoadState('load');
      await page.waitForTimeout(2500);
      const shot = `${OUT}/${String(++step).padStart(2, '0')}-${j.role.replace(/\W+/g, '_')}${path.replace(/\//g, '_')}.png`;
      await page.screenshot({ path: shot, fullPage: true });
      const crashed = await page.getByText(/Application error|Unhandled Runtime Error/).count();
      if (crashed) throw new Error(`Tela quebrada em ${path}`);
      console.log(`ok  ${j.role.padEnd(15)} ${path}`);
    }
    if (errors.length) throw new Error(`Erros de JavaScript: ${errors.join(' | ')}`);
  } catch (err) {
    failures++;
    console.error(`ERRO ${j.role}: ${err.message}`);
  } finally {
    await page.close();
  }
}
await browser.close();
process.exit(failures ? 1 : 0);
