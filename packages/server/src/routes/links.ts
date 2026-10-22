import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InviteDTO, LinksOverview } from '@sigilo/core';
import { limit, parse, type Ctx } from '../context.js';
import { all, one, run, tx } from '../db.js';
import {
  getNetworkBySlug,
  orderedPair,
  purgeMessagesBetweenNetworks,
  toLinkDTO,
  userIdsOfNetworks,
  type LinkRow,
} from '../services.js';
import { badRequest, conflict, hashCode, newCode, newId, notFound, now, HttpError } from '../util.js';

type LinkWithPeer = LinkRow & { peer_slug: string; peer_name: string };

const slugSchema = z.string().max(40).transform((s) => s.trim().toLowerCase());
const idParam = z.object({ id: z.uuid() });

/**
 * Vínculos entre redes. Sempre exigem decisão explícita do administrador das DUAS redes:
 *  - pedido:  A pede a B pelo código da rede; o admin de B aceita ou recusa.
 *  - convite: A gera um código; o admin de B o aceita (digitando-o).
 * Vínculo vale só entre as duas redes (não é transitivo).
 */
export function registerLinkRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, hub, config } = ctx;

  function notifyBoth(netA: string, netB: string): void {
    hub.sendMany(userIdsOfNetworks(db, netA, netB), { type: 'contacts.changed' });
  }

  function insertLink(me: string, other: string, status: 'pending' | 'active', viaInvite: boolean): string {
    const [lo, hi] = orderedPair(me, other);
    const id = newId();
    try {
      run(
        db,
        `INSERT INTO network_links (id, net_lo, net_hi, requested_by, status, via_invite, created_at, responded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        lo,
        hi,
        other === me ? me : viaInvite ? other : me,
        status,
        viaInvite ? 1 : 0,
        now(),
        status === 'active' ? now() : null,
      );
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) {
        throw conflict('Já existe um pedido pendente ou um vínculo ativo com essa rede', 'link_exists');
      }
      throw err;
    }
    return id;
  }

  function myLink(networkId: string, id: string): LinkRow {
    const link = one<LinkRow>(db, 'SELECT * FROM network_links WHERE id = ? AND (net_lo = ? OR net_hi = ?)', id, networkId, networkId);
    if (!link) throw notFound('Vínculo não encontrado');
    return link;
  }

  const peerOf = (link: LinkRow, me: string) => (link.net_lo === me ? link.net_hi : link.net_lo);

  app.get('/admin/links', async (req): Promise<LinksOverview> => {
    const me = req.auth!.network.id;
    const rows = all<LinkWithPeer>(
      db,
      `SELECT l.*, n.slug AS peer_slug, n.name AS peer_name
         FROM network_links l JOIN networks n ON n.id = CASE WHEN l.net_lo = ? THEN l.net_hi ELSE l.net_lo END
        WHERE (l.net_lo = ? OR l.net_hi = ?) AND l.status IN ('pending','active')
        ORDER BY l.created_at DESC`,
      me,
      me,
      me,
    ).map((r) => toLinkDTO(r, me));
    return {
      active: rows.filter((r) => r.status === 'active'),
      incoming: rows.filter((r) => r.direction === 'incoming'),
      outgoing: rows.filter((r) => r.direction === 'outgoing'),
    };
  });

  // PEDIDO: minha rede pede para se conectar a outra, pelo código (slug) dela.
  app.post('/admin/links/requests', limit(20), async (req, reply) => {
    const me = req.auth!.network;
    const { slug } = parse(z.object({ slug: slugSchema }).strict(), req.body);
    const target = getNetworkBySlug(db, slug);
    if (!target) throw notFound('Rede não encontrada');
    if (target.id === me.id) throw badRequest('Não é possível conectar uma rede a ela mesma');
    insertLink(me.id, target.id, 'pending', false);
    return reply.code(201).send({ ok: true });
  });

  app.post('/admin/links/:id/accept', async (req) => {
    const me = req.auth!.network.id;
    const { id } = parse(idParam, req.params);
    const link = myLink(me, id);
    if (link.status !== 'pending') throw conflict('Este pedido não está mais pendente');
    if (link.requested_by === me) throw new HttpError(403, 'forbidden', 'Quem pediu não pode aceitar o próprio pedido');
    run(db, "UPDATE network_links SET status = 'active', responded_at = ? WHERE id = ? AND status = 'pending'", now(), id);
    notifyBoth(link.net_lo, link.net_hi);
    return { ok: true };
  });

  app.post('/admin/links/:id/reject', async (req) => {
    const me = req.auth!.network.id;
    const { id } = parse(idParam, req.params);
    const link = myLink(me, id);
    if (link.status !== 'pending') throw conflict('Este pedido não está mais pendente');
    if (link.requested_by === me) throw new HttpError(403, 'forbidden', 'Use "cancelar" para retirar o próprio pedido');
    run(db, "UPDATE network_links SET status = 'rejected', responded_at = ? WHERE id = ?", now(), id);
    return { ok: true };
  });

  app.post('/admin/links/:id/cancel', async (req) => {
    const me = req.auth!.network.id;
    const { id } = parse(idParam, req.params);
    const link = myLink(me, id);
    if (link.status !== 'pending') throw conflict('Este pedido não está mais pendente');
    if (link.requested_by !== me) throw new HttpError(403, 'forbidden', 'Só quem pediu pode cancelar');
    run(db, "UPDATE network_links SET status = 'cancelled', responded_at = ? WHERE id = ?", now(), id);
    return { ok: true };
  });

  // Qualquer um dos dois lados pode encerrar. Mensagens pendentes entre as redes são apagadas.
  app.post('/admin/links/:id/revoke', async (req) => {
    const me = req.auth!.network.id;
    const { id } = parse(idParam, req.params);
    const link = myLink(me, id);
    if (link.status !== 'active') throw conflict('Este vínculo não está ativo');
    tx(db, () => {
      run(db, "UPDATE network_links SET status = 'revoked', responded_at = ? WHERE id = ?", now(), id);
      purgeMessagesBetweenNetworks(db, link.net_lo, link.net_hi);
    });
    notifyBoth(link.net_lo, link.net_hi);
    return { ok: true };
  });

  // CONVITE: gero um código e entrego ao administrador da outra rede por qualquer meio.
  app.post('/admin/links/invites', limit(20), async (req, reply): Promise<InviteDTO> => {
    const code = newCode();
    const expiresAt = now() + config.inviteTtlMs;
    run(
      db,
      'INSERT INTO link_invites (id, network_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      newId(),
      req.auth!.network.id,
      hashCode(code),
      now(),
      expiresAt,
    );
    reply.code(201);
    return { code, expiresAt };
  });

  // O administrador da outra rede aceita o convite digitando o código. Só então o vínculo passa a valer.
  app.post('/admin/links/invites/accept', limit(10), async (req) => {
    const me = req.auth!.network.id;
    const { code } = parse(z.object({ code: z.string().min(8).max(40) }).strict(), req.body);
    const invite = one<{ id: string; network_id: string; expires_at: number; used_at: number | null }>(
      db,
      'SELECT id, network_id, expires_at, used_at FROM link_invites WHERE code_hash = ?',
      hashCode(code),
    );
    if (!invite || invite.used_at || invite.expires_at <= now()) throw new HttpError(410, 'invite_invalid', 'Convite inválido, já usado ou expirado');
    if (invite.network_id === me) throw badRequest('Este convite foi emitido pela sua própria rede');
    tx(db, () => {
      insertLink(me, invite.network_id, 'active', true);
      run(db, 'UPDATE link_invites SET used_at = ? WHERE id = ?', now(), invite.id);
    });
    notifyBoth(me, invite.network_id);
    return { ok: true };
  });
}
