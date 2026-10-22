import type { FastifyInstance } from 'fastify';
import { authFromToken, type Ctx } from '../context.js';

/**
 * WebSocket só de avisos ("chegou mensagem", "foi lida"). O cliente autentica com a primeira
 * mensagem (e não pela URL, para o token não aparecer em logs de proxy).
 */
export function registerRealtime(app: FastifyInstance, ctx: Ctx): void {
  app.get('/ws', { websocket: true }, (socket) => {
    let unregister: (() => void) | undefined;
    const authTimeout = setTimeout(() => socket.close(4401, 'auth timeout'), 5000);
    const ping = setInterval(() => {
      try {
        socket.ping();
      } catch {
        /* fechado */
      }
    }, 30_000);

    socket.on('message', (raw: Buffer) => {
      if (unregister) return;
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; token?: string };
        if (msg.type !== 'auth' || typeof msg.token !== 'string') throw new Error('esperava auth');
        const auth = authFromToken(ctx, msg.token);
        if (!auth) return void socket.close(4401, 'unauthorized');
        clearTimeout(authTimeout);
        unregister = ctx.hub.register(auth.user.id, auth.sessionId, socket);
        socket.send(JSON.stringify({ type: 'ready' }));
      } catch {
        socket.close(4400, 'bad message');
      }
    });
    socket.on('close', () => {
      clearTimeout(authTimeout);
      clearInterval(ping);
      unregister?.();
    });
    socket.on('error', () => socket.close());
  });
}
