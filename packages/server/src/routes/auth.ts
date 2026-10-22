import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthBundle, MeResponse, PreloginResponse, ServerInfo } from '@sigilo/core';
import { authFromToken, bearer, limit, parse, type Ctx } from '../context.js';
import { one, run, tx } from '../db.js';
import { getNetwork, toUserDTO, type NetworkRow, type UserRow } from '../services.js';
import {
  HttpError,
  badRequest,
  forbidden,
  hashAuthSecret,
  hashCode,
  hmacBytes,
  newId,
  now,
  randomToken,
  safeEqual,
  sha256Hex,
  unauthorized,
} from '../util.js';

const b64u = (bytes: number) => z.string().regex(/^[A-Za-z0-9_-]+$/).length(Math.ceil((bytes * 8) / 6));

const handle = z
  .string()
  .max(70)
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9._-]{1,31}@[a-z0-9][a-z0-9-]{1,31}$/, 'formato esperado: usuario@rede'));

const kdfParams = z
  .object({ alg: z.literal('scrypt'), N: z.number().int(), r: z.number().int().min(8).max(16), p: z.number().int().min(1).max(4) })
  .strict();

const secretFields = {
  authSecret: b64u(32),
  kdfSalt: b64u(16),
  kdfParams,
  encryptedPrivateKey: z.string().min(20).max(1024),
};

const activateSchema = z
  .object({
    handle,
    activationCode: z.string().min(8).max(40),
    publicKey: b64u(32),
    deviceName: z.string().max(60).optional(),
    ...secretFields,
  })
  .strict();

const loginSchema = z.object({ handle, authSecret: b64u(32), deviceName: z.string().max(60).optional() }).strict();

const changePasswordSchema = z
  .object({
    currentAuthSecret: b64u(32),
    newAuthSecret: b64u(32),
    newKdfSalt: b64u(16),
    newKdfParams: kdfParams,
    newEncryptedPrivateKey: z.string().min(20).max(1024),
  })
  .strict();

const MAX_ACTIVATION_FAILURES = 5;
const DUMMY_SALT = 'AAAAAAAAAAAAAAAAAAAAAA';

export function registerAuthRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;

  function checkKdf(params: { N: number }): void {
    const { N } = params;
    if ((N & (N - 1)) !== 0 || N < config.minKdfN || N > 2 ** 20) {
      throw badRequest(`Parâmetro N do scrypt precisa ser potência de 2 entre ${config.minKdfN} e ${2 ** 20}`, 'weak_kdf');
    }
  }

  function createSession(userId: string, deviceName?: string): { token: string; expiresAt: number } {
    const token = randomToken(32);
    const expiresAt = now() + config.sessionTtlMs;
    run(
      db,
      'INSERT INTO sessions (id, user_id, token_hash, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      newId(),
      userId,
      sha256Hex(token),
      deviceName ?? null,
      now(),
      expiresAt,
    );
    return { token, expiresAt };
  }

  function bundle(user: UserRow, network: NetworkRow, session: { token: string; expiresAt: number }): AuthBundle {
    return {
      ...session,
      user: toUserDTO(user, network),
      publicKey: user.public_key!,
      encryptedPrivateKey: user.encrypted_private_key!,
      kdfSalt: user.kdf_salt!,
      kdfParams: JSON.parse(user.kdf_params!),
    };
  }

  /** Conta tentativa errada de senha e bloqueia por um tempo ao passar do limite. */
  function registerLoginFailure(user: UserRow): void {
    const failures = user.failed_logins + 1;
    if (failures >= config.maxLoginFailures) {
      run(db, 'UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?', now() + config.lockMs, user.id);
    } else {
      run(db, 'UPDATE users SET failed_logins = ? WHERE id = ?', failures, user.id);
    }
  }

  function assertNotLocked(user: UserRow): void {
    if (user.locked_until > now()) {
      throw new HttpError(429, 'locked', 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    }
  }

  async function verifySecret(user: UserRow, authSecret: string): Promise<boolean> {
    const hash = await hashAuthSecret(authSecret, user.auth_salt ?? DUMMY_SALT);
    return !!user.auth_hash && safeEqual(hash, user.auth_hash);
  }

  app.get('/server-info', async (): Promise<ServerInfo> => ({ name: 'sigilo', version: '0.1.0', kdfDefaults: config.kdfDefaults }));

  // Devolve sal e parâmetros do KDF. Para contas inexistentes responde algo plausível e estável.
  app.post('/auth/prelogin', limit(30), async (req): Promise<PreloginResponse> => {
    const body = parse(z.object({ handle }).strict(), req.body);
    const user = one<UserRow>(db, 'SELECT * FROM users WHERE handle = ?', body.handle);
    if (user?.kdf_salt && user.kdf_params) {
      return { kdfSalt: user.kdf_salt, kdfParams: JSON.parse(user.kdf_params) };
    }
    return { kdfSalt: hmacBytes(ctx.secret, `salt:${body.handle}`).subarray(0, 16).toString('base64url'), kdfParams: config.kdfDefaults };
  });

  app.post('/auth/activate', limit(10), async (req, reply): Promise<AuthBundle> => {
    const body = parse(activateSchema, req.body);
    const invalid = () => unauthorized('Código de ativação inválido ou expirado');
    const user = one<UserRow>(db, 'SELECT * FROM users WHERE handle = ?', body.handle);
    if (!user || user.status !== 'pending' || !user.activation_hash || (user.activation_expires ?? 0) <= now()) throw invalid();

    if (!safeEqual(user.activation_hash, hashCode(body.activationCode))) {
      if (user.activation_failures + 1 >= MAX_ACTIVATION_FAILURES) {
        // Código queimado: o administrador precisa emitir outro.
        run(db, 'UPDATE users SET activation_hash = NULL, activation_expires = NULL, activation_failures = 0 WHERE id = ?', user.id);
      } else {
        run(db, 'UPDATE users SET activation_failures = activation_failures + 1 WHERE id = ?', user.id);
      }
      throw invalid();
    }
    checkKdf(body.kdfParams);

    const authSalt = randomToken(16);
    const authHash = await hashAuthSecret(body.authSecret, authSalt);
    const session = tx(db, () => {
      const changed = run(
        db,
        `UPDATE users SET status = 'active', activation_hash = NULL, activation_expires = NULL, activation_failures = 0,
           kdf_salt = ?, kdf_params = ?, auth_salt = ?, auth_hash = ?, public_key = ?, encrypted_private_key = ?,
           failed_logins = 0, locked_until = 0
         WHERE id = ? AND status = 'pending' AND activation_hash = ?`,
        body.kdfSalt,
        JSON.stringify(body.kdfParams),
        authSalt,
        authHash,
        body.publicKey,
        body.encryptedPrivateKey,
        user.id,
        user.activation_hash,
      );
      if (changed !== 1) throw invalid();
      return createSession(user.id, body.deviceName);
    });
    const fresh = one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', user.id)!;
    reply.code(201);
    return bundle(fresh, getNetwork(db, fresh.network_id)!, session);
  });

  app.post('/auth/login', limit(20), async (req): Promise<AuthBundle> => {
    const body = parse(loginSchema, req.body);
    const user = one<UserRow>(db, 'SELECT * FROM users WHERE handle = ?', body.handle);
    // Sempre calcula o hash para o tempo de resposta não revelar se a conta existe.
    if (!user || user.status === 'pending' || !user.auth_hash) {
      await hashAuthSecret(body.authSecret, DUMMY_SALT);
      throw unauthorized();
    }
    assertNotLocked(user);
    if (!(await verifySecret(user, body.authSecret))) {
      registerLoginFailure(user);
      throw unauthorized();
    }
    if (user.status === 'disabled') throw forbidden('Conta desativada pelo administrador');
    run(db, 'UPDATE users SET failed_logins = 0 WHERE id = ?', user.id);
    return bundle(user, getNetwork(db, user.network_id)!, createSession(user.id, body.deviceName));
  });

  app.post('/auth/logout', async (req, reply) => {
    const auth = authFromToken(ctx, bearer(req));
    if (auth) {
      run(db, 'DELETE FROM sessions WHERE id = ?', auth.sessionId);
      ctx.hub.revokeSession(auth.user.id, auth.sessionId);
    }
    return reply.code(204).send();
  });

  app.get('/me', async (req): Promise<MeResponse> => {
    const auth = authFromToken(ctx, bearer(req));
    if (!auth) throw unauthorized('Sessão inválida ou expirada');
    const session = one<{ expires_at: number }>(db, 'SELECT expires_at FROM sessions WHERE id = ?', auth.sessionId)!;
    const { token: _token, ...rest } = bundle(auth.user, auth.network, { token: '', expiresAt: session.expires_at });
    return rest;
  });

  app.post('/auth/change-password', limit(10), async (req, reply) => {
    const auth = authFromToken(ctx, bearer(req));
    if (!auth) throw unauthorized('Sessão inválida ou expirada');
    const body = parse(changePasswordSchema, req.body);
    checkKdf(body.newKdfParams);
    assertNotLocked(auth.user);
    if (!(await verifySecret(auth.user, body.currentAuthSecret))) {
      registerLoginFailure(auth.user);
      throw unauthorized('Senha atual incorreta');
    }
    const authSalt = randomToken(16);
    const authHash = await hashAuthSecret(body.newAuthSecret, authSalt);
    tx(db, () => {
      run(
        db,
        `UPDATE users SET kdf_salt = ?, kdf_params = ?, auth_salt = ?, auth_hash = ?, encrypted_private_key = ?, failed_logins = 0
         WHERE id = ?`,
        body.newKdfSalt,
        JSON.stringify(body.newKdfParams),
        authSalt,
        authHash,
        body.newEncryptedPrivateKey,
        auth.user.id,
      );
      // Outros aparelhos precisam entrar de novo com a senha nova.
      run(db, 'DELETE FROM sessions WHERE user_id = ? AND id != ?', auth.user.id, auth.sessionId);
    });
    ctx.hub.revokeUser(auth.user.id, auth.sessionId);
    return reply.code(204).send();
  });
}
