import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3001),
  /** Origens liberadas no CORS (web, app Capacitor). */
  CORS_ORIGINS: z.string().default('http://localhost:3000,capacitor://localhost,https://localhost'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET deve ter pelo menos 32 caracteres'),
  /** Chave AES-256 (base64, 32 bytes) para segredos guardados no banco, como o TOTP. */
  DATA_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'DATA_KEY deve ser 32 bytes em base64'),
  SESSION_HOURS: z.coerce.number().default(12),
  MASTER_DATABASE_URL: z.string().url(),
  DB_SSL: bool,
  REDIS_URL: z.string().optional(),
  /** Conexões por banco de tenant (planos menores de banco gerenciado limitam o total). */
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
  /**
   * Segredo do disparo externo de jobs (POST /api/jobs/tick), usado quando não há Redis: na Cloudflare,
   * os Cron Triggers do Worker chamam esse endpoint.
   */
  JOBS_SECRET: z.string().min(24).optional(),
  /** Liga os jobs em segundo plano neste processo (o worker separado usa a mesma configuração). */
  RUN_JOBS: bool,
  PUBLIC_API_URL: z.string().default('http://localhost:3001'),
  /**
   * Quantos proxies à frente da API são confiáveis para ler o IP do cliente (registrado na trilha de
   * auditoria). Ex.: Cloudflare Tunnel + roteador do servidor = 2.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  // Storage de objetos (Cloudflare R2 via API S3); sem R2 os arquivos vão para uma pasta local.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  LOCAL_STORAGE_DIR: z.string().default('./.storage'),
  // IA
  ANTHROPIC_API_KEY: z.string().optional(),
  OMNI_AI_MODEL: z.string().optional(),
  WHISPER_ASR_URL: z.string().optional(),
  // Integrações padrão (podem ser sobrescritas por tenant em tenant_integrations)
  MOCKS_URL: z.string().optional(),
  WHATSAPP_BASE_URL: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  RNDS_AUTH_URL: z.string().optional(),
  RNDS_EHR_URL: z.string().optional(),
  /** Certificado ICP-Brasil (PFX): caminho de arquivo ou "r2:<chave>" no armazenamento de objetos. */
  RNDS_CERT_PFX: z.string().optional(),
  RNDS_CERT_PASSPHRASE: z.string().optional(),
  RNDS_REQUESTER_CPF: z.string().optional(),
  SEFAZ_URL: z.string().optional(),
  SIGTAP_ZIP_URL: z.string().optional(),
  /** API de dados abertos do Ministério da Saúde (estabelecimentos do CNES); os testes apontam para o simulador. */
  CNES_API_URL: z.string().url().default('https://apidadosabertos.saude.gov.br'),
  /** Chave da central de intérpretes de Libras (login dos intérpretes no canal de vídeo). */
  LIBRAS_INTERPRETER_KEY: z.string().optional(),
  STUN_URL: z.string().default('stun:stun.l.google.com:19302'),
  TURN_URL: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  return parsed.data;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
