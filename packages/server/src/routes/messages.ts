import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ConversationSummary, InboxItem, OutboxItem } from '@sigilo/core';
import { parse, type Ctx } from '../context.js';
import { all, one, placeholders, run, tx } from '../db.js';
import { canMessage, getUser } from '../services.js';
import { HttpError, badRequest, conflict, notFound, now } from '../util.js';

const MAX_PENDING_PER_PAIR = 500;
const MAX_PER_MINUTE = 60;

const sendSchema = z
  .object({
    id: z.uuid(),
    recipientId: z.uuid(),
    envelope: z.string().min(20).max(24_000),
    senderEnvelope: z.string().min(20).max(24_000),
  })
  .strict();

const readSchema = z.object({ ids: z.array(z.uuid()).min(1).max(200) }).strict();

export function registerMessageRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, hub, config } = ctx;
  const sentAt = new Map<string, number[]>();

  function throttle(userId: string): void {
    const cutoff = now() - 60_000;
    const recent = (sentAt.get(userId) ?? []).filter((t) => t > cutoff);
    if (recent.length >= MAX_PER_MINUTE) throw new HttpError(429, 'rate_limited', 'Você está enviando mensagens rápido demais');
    recent.push(now());
    sentAt.set(userId, recent);
  }

  app.post('/messages', async (req, reply) => {
    const me = req.auth!.user;
    const body = parse(sendSchema, req.body);
    if (body.recipientId === me.id) throw badRequest('Não é possível enviar mensagem para si mesmo');
    const recipient = getUser(db, body.recipientId);
    // 404 uniforme: quem está fora da rede (ou sem vínculo) não deve nem saber se o usuário existe.
    if (!recipient || !canMessage(db, me, recipient)) throw notFound('Destinatário não encontrado');
    throttle(me.id);

    const pending = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND recipient_id = ?', me.id, recipient.id)!;
    if (pending.n >= MAX_PENDING_PER_PAIR) {
      throw new HttpError(429, 'inbox_full', 'O destinatário ainda não leu as mensagens anteriores');
    }

    const createdAt = now();
    try {
      run(
        db,
        `INSERT INTO messages (id, sender_id, recipient_id, envelope, sender_envelope, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        body.id,
        me.id,
        recipient.id,
        body.envelope,
        body.senderEnvelope,
        createdAt,
        createdAt + config.messageTtlMs,
      );
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) throw conflict('Mensagem já enviada', 'duplicate');
      throw err;
    }
    hub.send(recipient.id, { type: 'message.new', id: body.id, senderId: me.id, createdAt });
    return reply.code(201).send({ id: body.id, createdAt });
  });

  app.get('/messages/inbox', async (req): Promise<InboxItem[]> => {
    const { from } = parse(z.object({ from: z.uuid().optional() }), req.query);
    const rows = all<{ id: string; sender_id: string; created_at: number; envelope: string }>(
      db,
      `SELECT id, sender_id, created_at, envelope FROM messages
        WHERE recipient_id = ? ${from ? 'AND sender_id = ?' : ''}
        ORDER BY created_at, rowid LIMIT 500`,
      ...(from ? [req.auth!.user.id, from] : [req.auth!.user.id]),
    );
    return rows.map((r) => ({ id: r.id, senderId: r.sender_id, createdAt: r.created_at, envelope: r.envelope }));
  });

  app.get('/messages/outbox', async (req): Promise<OutboxItem[]> => {
    const { to } = parse(z.object({ to: z.uuid().optional() }), req.query);
    const rows = all<{ id: string; recipient_id: string; created_at: number; sender_envelope: string }>(
      db,
      `SELECT id, recipient_id, created_at, sender_envelope FROM messages
        WHERE sender_id = ? ${to ? 'AND recipient_id = ?' : ''}
        ORDER BY created_at, rowid LIMIT 500`,
      ...(to ? [req.auth!.user.id, to] : [req.auth!.user.id]),
    );
    return rows.map((r) => ({ id: r.id, recipientId: r.recipient_id, createdAt: r.created_at, senderEnvelope: r.sender_envelope }));
  });

  // Somente metadados: quantas mensagens bloqueadas há por conversa.
  app.get('/messages/summary', async (req): Promise<ConversationSummary[]> => {
    const me = req.auth!.user.id;
    const incoming = all<{ peer: string; n: number; last: number }>(
      db,
      'SELECT sender_id AS peer, COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE recipient_id = ? GROUP BY sender_id',
      me,
    );
    const outgoing = all<{ peer: string; n: number; last: number }>(
      db,
      'SELECT recipient_id AS peer, COUNT(*) AS n, MAX(created_at) AS last FROM messages WHERE sender_id = ? GROUP BY recipient_id',
      me,
    );
    const byPeer = new Map<string, ConversationSummary>();
    for (const r of incoming) byPeer.set(r.peer, { peerId: r.peer, incoming: r.n, outgoing: 0, lastAt: r.last });
    for (const r of outgoing) {
      const cur = byPeer.get(r.peer) ?? { peerId: r.peer, incoming: 0, outgoing: 0, lastAt: 0 };
      cur.outgoing = r.n;
      cur.lastAt = Math.max(cur.lastAt, r.last);
      byPeer.set(r.peer, cur);
    }
    return [...byPeer.values()].sort((a, b) => b.lastAt - a.lastAt);
  });

  // O app chama isto depois de exibir as mensagens: o texto cifrado é apagado do servidor.
  app.post('/messages/read', async (req) => {
    const me = req.auth!.user.id;
    const { ids } = parse(readSchema, req.body);
    const rows = tx(db, () => {
      const found = all<{ id: string; sender_id: string }>(
        db,
        `SELECT id, sender_id FROM messages WHERE recipient_id = ? AND id IN (${placeholders(ids.length)})`,
        me,
        ...ids,
      );
      if (found.length) {
        run(db, `DELETE FROM messages WHERE recipient_id = ? AND id IN (${placeholders(found.length)})`, me, ...found.map((r) => r.id));
      }
      return found;
    });
    const bySender = new Map<string, string[]>();
    for (const r of rows) bySender.set(r.sender_id, [...(bySender.get(r.sender_id) ?? []), r.id]);
    for (const [sender, readIds] of bySender) hub.send(sender, { type: 'message.read', ids: readIds, readerId: me });
    return { deleted: rows.length };
  });

  // "Apagar para todos" enquanto o destinatário ainda não leu.
  app.delete('/messages/:id', async (req, reply) => {
    const me = req.auth!.user.id;
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const row = one<{ recipient_id: string }>(db, 'SELECT recipient_id FROM messages WHERE id = ? AND sender_id = ?', id, me);
    if (!row) throw notFound('Mensagem não encontrada (talvez já tenha sido lida)');
    run(db, 'DELETE FROM messages WHERE id = ? AND sender_id = ?', id, me);
    hub.send(row.recipient_id, { type: 'message.recalled', id, senderId: me });
    return reply.code(204).send();
  });
}
