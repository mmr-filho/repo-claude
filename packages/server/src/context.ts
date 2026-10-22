import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Config } from './config.js';
import { one, type DB } from './db.js';
import type { Hub } from './hub.js';
import { getNetwork, type NetworkRow, type UserRow } from './services.js';
import { now, sha256Hex } from './util.js';

export interface Ctx {
  db: DB;
  config: Config;
  hub: Hub;
  /** Segredo do servidor (persistido) usado para respostas falsas que escondem se um usuário existe. */
  secret: string;
}

export interface AuthContext {
  user: UserRow;
  network: NetworkRow;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function authFromToken(ctx: Ctx, token: string | undefined): AuthContext | undefined {
  if (!token) return undefined;
  const row = one<{ session_id: string; user_id: string }>(
    ctx.db,
    'SELECT id AS session_id, user_id FROM sessions WHERE token_hash = ? AND expires_at > ?',
    sha256Hex(token),
    now(),
  );
  if (!row) return undefined;
  const user = one<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = ?', row.user_id);
  if (!user || user.status !== 'active') return undefined;
  const network = getNetwork(ctx.db, user.network_id);
  if (!network) return undefined;
  return { user, network, sessionId: row.session_id };
}

export function bearer(req: FastifyRequest): string | undefined {
  return /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

/** Limite por IP (por minuto) em rotas sensíveis. Só tem efeito quando o plugin de rate limit está registrado. */
export const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });
