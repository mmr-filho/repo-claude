/**
 * Regras do Worker que atende mm.api.br/omnisaude: o que vai para a API (container) e com que variáveis
 * o container sobe. Sem dependências do runtime da Cloudflare, para ser testado no Node.
 */

export const API_PORT = 3001;
export const MOCKS_PORT = 4010;

/** Repassadas ao container quando definidas (IA, R2, integrações reais, Libras). */
export const PASSTHROUGH = [
  'ANTHROPIC_API_KEY',
  'OMNI_AI_MODEL',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_ENDPOINT',
  'WHATSAPP_BASE_URL',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'RNDS_AUTH_URL',
  'RNDS_EHR_URL',
  'RNDS_CERT_PFX',
  'RNDS_CERT_PASSPHRASE',
  'RNDS_REQUESTER_CPF',
  'SEFAZ_URL',
  'SIGTAP_ZIP_URL',
  'WHISPER_ASR_URL',
  'LIBRAS_INTERPRETER_KEY',
  'PLATFORM_ADMIN_EMAIL',
  'TURN_URL',
  'TURN_USERNAME',
  'TURN_CREDENTIAL',
] as const;

/** Variáveis e segredos do Worker (wrangler.jsonc e painel da Cloudflare). */
export interface OmniVars extends Partial<Record<(typeof PASSTHROUGH)[number], string>> {
  /** Origem pública, sem barra no fim (https://mm.api.br). */
  PUBLIC_ORIGIN: string;
  /** Caminho de publicação (/omnisaude). */
  BASE_PATH: string;
  /** PostgreSQL do PlanetScale: host, porta direta (5432) e o papel padrão do provedor (`postgres.<branch>`). */
  PG_HOST: string;
  PG_PORT?: string;
  PG_ADMIN_USER: string;
  PG_ADMIN_PASSWORD: string;
  /** "false" em bancos sem réplica: o BI lê o primário (ainda somente leitura). */
  PG_USE_REPLICA?: string;
  /** TLS com o banco; "false" só para testar com um PostgreSQL local (`wrangler dev`). */
  PG_SSL?: string;
  MASTER_DB_NAME?: string;
  DB_POOL_SIZE?: string;
  APP_DB_PASSWORD: string;
  BI_DB_PASSWORD: string;
  JWT_SECRET: string;
  DATA_KEY: string;
  JOBS_SECRET: string;
  /** Senha da conta de operação da plataforma (cria e suspende tenants); substitui a senha pública da demo. */
  PLATFORM_ADMIN_PASSWORD: string;
  PLATFORM_ADMIN_EMAIL?: string;
  SEED_DEMO?: string;
  /** "true": RNDS/CADSUS, SEFAZ e WhatsApp simulados dentro do container (demonstração). */
  DEMO_MOCKS?: string;
}


/**
 * Partida do container: prepara o banco (papéis, master, demo, migrações), sobe os simulados se pedidos e
 * troca o shell pelo processo da API. A porta só abre depois das migrações.
 */
export const CONTAINER_ENTRYPOINT = [
  'sh',
  '-c',
  [
    'set -e',
    'node packages/database/dist/cli.js boot',
    `if [ "$DEMO_MOCKS" = "true" ]; then PORT=${MOCKS_PORT} MOCK_LOG=0 node infra/mocks/dist/index.js & fi`,
    'exec node apps/api/dist/main.js',
  ].join('\n'),
];

export function basePath(vars: Pick<OmniVars, 'BASE_PATH'>): string {
  const base = (vars.BASE_PATH ?? '').trim().replace(/\/+$/, '');
  return base && !base.startsWith('/') ? `/${base}` : base;
}

/** Caminho dentro da API para um caminho público, ou null quando não é da API. */
export function apiPath(pathname: string, base: string): string | null {
  for (const prefix of ['/api', '/socket.io']) {
    const full = base + prefix;
    if (pathname === full || pathname.startsWith(`${full}/`)) return pathname.slice(base.length);
  }
  return null;
}

/** Rotas que existem na API mas não são públicas (os jobs são disparados só pelos Cron Triggers). */
export function isInternalOnly(path: string): boolean {
  return path === '/api/jobs' || path.startsWith('/api/jobs/');
}

/**
 * Requisição repassada ao container: sem o prefixo de publicação e com o IP real do cliente.
 * O X-Forwarded-For enviado pelo cliente é descartado (a API confia em um proxy: este Worker).
 */
export function toContainerRequest(request: Request, path: string): Request {
  const url = new URL(request.url);
  url.pathname = path;
  const forwarded = new Request(url.toString(), request);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) forwarded.headers.set('x-forwarded-for', ip);
  else forwarded.headers.delete('x-forwarded-for');
  forwarded.headers.set('x-forwarded-proto', new URL(request.url).protocol.replace(':', ''));
  forwarded.headers.set('x-forwarded-host', url.host);
  return forwarded;
}

/** Sufixo do branch do PlanetScale no usuário (`postgres.abc123` → `.abc123`); vazio fora do PlanetScale. */
export function branchSuffix(adminUser: string): string {
  const user = adminUser.split('|')[0]!;
  const dot = user.indexOf('.');
  return dot >= 0 ? user.slice(dot) : '';
}

function postgresUrl(host: string, port: string, database: string, user: string, password: string, ssl: boolean): string {
  const url = new URL(`postgresql://${host}:${port}/${encodeURIComponent(database)}`);
  url.username = user;
  url.password = password;
  if (ssl) url.searchParams.set('sslmode', 'require');
  return url.toString();
}

/** Variáveis de ambiente da API no container, montadas a partir das variáveis e segredos do Worker. */
export function containerEnv(vars: OmniVars): Record<string, string> {
  const missing = (['PUBLIC_ORIGIN', 'PG_HOST', 'PG_ADMIN_USER', 'PG_ADMIN_PASSWORD', 'APP_DB_PASSWORD', 'BI_DB_PASSWORD', 'JWT_SECRET', 'DATA_KEY', 'JOBS_SECRET', 'PLATFORM_ADMIN_PASSWORD'] as const).filter(
    (k) => !vars[k],
  );
  if (missing.length) throw new Error(`Configure no Worker: ${missing.join(', ')}`);
  // Mesma regra mínima da API (packages/database/src/passwords.ts); a partida recusaria a senha.
  const admin = vars.PLATFORM_ADMIN_PASSWORD;
  if (admin.length < 10 || !/[A-Za-z]/.test(admin) || !/\d/.test(admin)) {
    throw new Error('PLATFORM_ADMIN_PASSWORD precisa de pelo menos 10 caracteres, com letras e números');
  }

  const origin = vars.PUBLIC_ORIGIN.replace(/\/+$/, '');
  const port = vars.PG_PORT || '5432';
  const branch = branchSuffix(vars.PG_ADMIN_USER);
  const appUser = `omni_app${branch}`;
  // O sufixo |replica faz o PlanetScale levar as consultas do BI para a réplica.
  const biUser = `omni_bi_reader${branch}${vars.PG_USE_REPLICA === 'false' ? '' : '|replica'}`;
  const demoMocks = vars.DEMO_MOCKS === 'true';
  const ssl = vars.PG_SSL !== 'false';

  const env: Record<string, string> = {
    NODE_ENV: 'production',
    PORT: String(API_PORT),
    DB_SSL: String(ssl),
    DB_POOL_SIZE: vars.DB_POOL_SIZE || '5',
    MASTER_DATABASE_URL: postgresUrl(vars.PG_HOST, port, vars.MASTER_DB_NAME || 'master_auth_db', appUser, vars.APP_DB_PASSWORD, ssl),
    TENANT_DB_HOST: vars.PG_HOST,
    TENANT_DB_PORT: port,
    TENANT_DB_USER: appUser,
    TENANT_DB_PASSWORD: vars.APP_DB_PASSWORD,
    TENANT_ADMIN_USER: vars.PG_ADMIN_USER,
    TENANT_ADMIN_PASSWORD: vars.PG_ADMIN_PASSWORD,
    TENANT_BI_USER: biUser,
    TENANT_BI_PASSWORD: vars.BI_DB_PASSWORD,
    BOOTSTRAP: 'true',
    SEED_DEMO: vars.SEED_DEMO === 'true' ? 'true' : 'false',
    JWT_SECRET: vars.JWT_SECRET,
    DATA_KEY: vars.DATA_KEY,
    JOBS_SECRET: vars.JOBS_SECRET,
    PLATFORM_ADMIN_PASSWORD: vars.PLATFORM_ADMIN_PASSWORD,
    // Sem Redis: os jobs rodam quando os Cron Triggers do Worker chamam /api/jobs/tick.
    RUN_JOBS: 'false',
    TRUST_PROXY: '1',
    CORS_ORIGINS: `${origin},capacitor://localhost,https://localhost`,
    PUBLIC_API_URL: `${origin}${basePath(vars)}`,
    // O disco do container é apagado a cada reinício: configure o R2 para guardar documentos.
    LOCAL_STORAGE_DIR: '/tmp/omnisaude-arquivos',
    DEMO_MOCKS: demoMocks ? 'true' : 'false',
  };
  if (demoMocks) {
    env.MOCKS_URL = `http://127.0.0.1:${MOCKS_PORT}`;
    env.RNDS_REQUESTER_CPF = '52998224725';
  }
  for (const key of PASSTHROUGH) {
    const value = vars[key];
    if (value) env[key] = value;
  }
  return env;
}

/**
 * Impressão digital da configuração com que o container sobe (SHA-256). Quando um segredo muda, o Worker
 * percebe a diferença e reinicia a API com os valores novos.
 */
export async function configFingerprint(env: Record<string, string>, entrypoint: string[]): Promise<string> {
  const canonical = JSON.stringify([Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), entrypoint]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Cron Triggers do wrangler.jsonc e os jobs que cada um dispara. */
export const CRON_JOBS: Record<string, string> = {
  '*/5 * * * *': 'whatsapp,rnds',
  '0 9 * * *': 'sigtap',
};
