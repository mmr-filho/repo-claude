import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { DEFAULT_RELAY_CONFIG, MAX_FRAME_BYTES, handleQueueRequest, type RelayConfig } from './core.js';
import { NodeRelayStore } from './node-store.js';

export interface NodeRelayOptions {
  dbPath: string;
  messageTtlMs?: number;
  /** Caixas sem uso por este tempo são apagadas. */
  idleQueueMs?: number;
  trustProxy?: boolean;
  rateLimit?: boolean;
  logger?: boolean;
}

export async function buildRelay(opts: NodeRelayOptions): Promise<{ app: FastifyInstance; store: NodeRelayStore }> {
  const store = new NodeRelayStore(opts.dbPath);
  const cfg: RelayConfig = { messageTtlMs: opts.messageTtlMs ?? DEFAULT_RELAY_CONFIG.messageTtlMs };
  const idle = opts.idleQueueMs ?? 60 * 24 * 60 * 60 * 1000;

  const app = Fastify({
    // Sem logs de requisição: o relé não deve manter registro de quem acessa o quê.
    logger: opts.logger ? { level: 'warn' } : false,
    trustProxy: opts.trustProxy ?? false,
    bodyLimit: MAX_FRAME_BYTES + 1024,
  });
  if (opts.rateLimit !== false) await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  app.addContentTypeParser(['application/octet-stream', 'application/json'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.get('/health', async () => ({ ok: true }));

  app.all('/q/*', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    const body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array(0);
    const qid = path.split('/')[2] ?? '';
    const out = handleQueueRequest(
      store.queue(qid),
      {
        method: req.method,
        path,
        headers: { ts: req.headers['x-sigilo-ts'] as string | undefined, sig: req.headers['x-sigilo-sig'] as string | undefined },
        body,
      },
      Date.now(),
      cfg,
    );
    reply.code(out.status);
    return out.json === undefined ? reply.send() : out.json;
  });

  const timer = setInterval(() => store.purge(Date.now(), idle), 10 * 60 * 1000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    store.close();
  });
  store.purge(Date.now(), idle);
  return { app, store };
}

// Execução direta: node dist/node-server.js
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { app } = await buildRelay({
    dbPath: process.env.DB_PATH ?? './data/relay.db',
    messageTtlMs: process.env.MESSAGE_TTL_HOURS ? Number(process.env.MESSAGE_TTL_HOURS) * 3600_000 : undefined,
    trustProxy: process.env.TRUST_PROXY === 'true',
    logger: process.env.LOG === 'on',
  });
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3100) });
}
