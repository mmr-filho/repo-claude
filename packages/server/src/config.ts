export interface KdfParamsConfig {
  alg: 'scrypt';
  N: number;
  r: number;
  p: number;
}

export interface Config {
  host: string;
  port: number;
  /** Caminho do arquivo SQLite, ou ':memory:'. */
  dbPath: string;
  sessionTtlMs: number;
  /** Mensagens não lidas expiram e são apagadas depois disso. */
  messageTtlMs: number;
  activationTtlMs: number;
  inviteTtlMs: number;
  /** Parâmetros de scrypt que o app deve usar em contas novas (e que o servidor devolve para contas inexistentes). */
  kdfDefaults: KdfParamsConfig;
  /** Menor N de scrypt aceito numa ativação/troca de senha. */
  minKdfN: number;
  maxLoginFailures: number;
  lockMs: number;
  rateLimit: boolean;
  trustProxy: boolean;
  logger: boolean;
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Valor numérico inválido: ${value}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? '0.0.0.0',
    port: int(env.PORT, 3000),
    dbPath: env.DB_PATH ?? './data/sigilo.db',
    sessionTtlMs: int(env.SESSION_TTL_DAYS, 30) * DAY,
    messageTtlMs: int(env.MESSAGE_TTL_HOURS, 24 * 7) * HOUR,
    activationTtlMs: int(env.ACTIVATION_TTL_HOURS, 72) * HOUR,
    inviteTtlMs: int(env.INVITE_TTL_HOURS, 24 * 7) * HOUR,
    kdfDefaults: { alg: 'scrypt', N: int(env.KDF_N, 2 ** 15), r: 8, p: 1 },
    minKdfN: int(env.MIN_KDF_N, 2 ** 14),
    maxLoginFailures: int(env.MAX_LOGIN_FAILURES, 8),
    lockMs: int(env.LOCK_MINUTES, 5) * 60 * 1000,
    rateLimit: env.RATE_LIMIT !== 'off',
    trustProxy: env.TRUST_PROXY === 'true',
    logger: env.LOG !== 'off',
  };
}

/** Configuração para testes: tudo em memória, scrypt barato, sem limite de requisições. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    dbPath: ':memory:',
    kdfDefaults: { alg: 'scrypt', N: 1024, r: 8, p: 1 },
    minKdfN: 1024,
    rateLimit: false,
    logger: false,
    ...overrides,
  };
}
