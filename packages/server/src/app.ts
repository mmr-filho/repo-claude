import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { z } from 'zod';
import type { Config } from './config.js';
import { authFromToken, bearer, type Ctx } from './context.js';
import { one, openDb, run } from './db.js';
import { Hub } from './hub.js';
import { purgeExpired } from './services.js';
import { HttpError, forbidden, randomToken, unauthorized } from './util.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerContactRoutes } from './routes/contacts.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerLinkRoutes } from './routes/links.js';
import { registerRealtime } from './routes/realtime.js';

export async function buildApp(config: Config): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const db = openDb(config.dbPath);
  let secret = one<{ value: string }>(db, "SELECT value FROM meta WHERE key = 'server_secret'")?.value;
  if (!secret) {
    secret = randomToken(32);
    run(db, "INSERT INTO meta (key, value) VALUES ('server_secret', ?)", secret);
  }
  const ctx: Ctx = { db, config, hub: new Hub(), secret };

  const app = Fastify({
    logger: config.logger ? { level: 'info', redact: ['req.headers.authorization'] } : false,
    trustProxy: config.trustProxy,
    bodyLimit: 128 * 1024,
  });

  if (config.rateLimit) await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 } });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
    if (err instanceof z.ZodError) {
      const detail = err.issues.map((i) => `${i.path.join('.') || 'corpo'}: ${i.message}`).join('; ');
      return reply.code(400).send({ error: 'invalid_request', message: `Dados inválidos (${detail})` });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'error', message: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Erro interno do servidor' });
  });

  app.get('/health', async () => ({ ok: true }));

  registerAuthRoutes(app, ctx);
  registerRealtime(app, ctx);

  // Tudo abaixo exige sessão válida.
  await app.register(async (authed) => {
    authed.addHook('preHandler', async (req) => {
      const auth = authFromToken(ctx, bearer(req));
      if (!auth) throw unauthorized('Sessão inválida ou expirada');
      req.auth = auth;
    });
    registerContactRoutes(authed, ctx);
    registerMessageRoutes(authed, ctx);

    await authed.register(async (admin) => {
      admin.addHook('preHandler', async (req) => {
        if (req.auth?.user.role !== 'admin') throw forbidden('Apenas administradores da rede');
      });
      registerAdminRoutes(admin, ctx);
      registerLinkRoutes(admin, ctx);
    });
  });

  const timer = setInterval(() => purgeExpired(db), 10 * 60 * 1000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    db.close();
  });
  purgeExpired(db);

  return { app, ctx };
}

