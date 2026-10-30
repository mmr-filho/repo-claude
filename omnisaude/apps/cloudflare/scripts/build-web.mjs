// Gera as telas do OmniSaúde como site estático para a Cloudflare: public/omnisaude/ (BASE_PATH do Worker).
// Uso: npm run build:web -w @omnisaude/cloudflare
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const web = join(root, 'apps/web');
const basePath = process.env.OMNI_BASE_PATH ?? '/omnisaude';
const distDir = '.next-cloudflare';
const publicDir = resolve(here, '../public');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// As telas importam @omnisaude/shared e @omnisaude/accessibility já compilados.
run('npx', ['tsc', '-b', 'packages/shared', 'packages/accessibility'], { cwd: root });

rmSync(join(web, distDir), { recursive: true, force: true });
run('npx', ['next', 'build'], {
  cwd: web,
  env: {
    ...process.env,
    OMNI_STATIC_EXPORT: '1',
    NEXT_DIST_DIR: distDir,
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_API_URL: `${basePath}/api`,
    NEXT_TELEMETRY_DISABLED: '1',
  },
});

const out = join(web, distDir);
if (!existsSync(join(out, 'index.html'))) {
  console.error(`Exportação estática não encontrada em ${out}`);
  process.exit(1);
}
rmSync(publicDir, { recursive: true, force: true });
const target = join(publicDir, basePath);
mkdirSync(target, { recursive: true });
cpSync(out, target, { recursive: true, filter: (src) => !src.includes(`${distDir}/cache`) && !src.endsWith('.nft.json') });

// Cabeçalhos dos arquivos estáticos (o Worker só atende /api e /socket.io).
writeFileSync(
  join(publicDir, '_headers'),
  [
    `${basePath}/*`,
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  X-Frame-Options: SAMEORIGIN',
    '  Permissions-Policy: camera=(self), microphone=(self), geolocation=()',
    '  Strict-Transport-Security: max-age=31536000',
    `${basePath}/_next/static/*`,
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n'),
);
console.log(`Telas prontas em ${target}`);
