import type { FastifyInstance } from 'fastify';
import type { Contact } from '@sigilo/core';
import { z } from 'zod';
import { parse, type Ctx } from '../context.js';
import { all } from '../db.js';
import type { UserRow } from '../services.js';
import { notFound } from '../util.js';

interface ContactRow {
  id: string;
  handle: string;
  display_name: string;
  role: 'admin' | 'member';
  public_key: string;
  network_id: string;
  slug: string;
  net_name: string;
}

export function registerContactRoutes(app: FastifyInstance, ctx: Ctx): void {
  // Diretório = minha rede + redes com vínculo ativo direto. Nunca mais que isso.
  function visibleContacts(me: UserRow, onlyId?: string): Contact[] {
    const rows = all<ContactRow>(
      ctx.db,
      `SELECT u.id, u.handle, u.display_name, u.role, u.public_key, u.network_id, n.slug, n.name AS net_name
         FROM users u JOIN networks n ON n.id = u.network_id
        WHERE u.status = 'active' AND u.public_key IS NOT NULL AND u.id != ? ${onlyId ? 'AND u.id = ?' : ''}
          AND (u.network_id = ? OR u.network_id IN (
                SELECT CASE WHEN net_lo = ? THEN net_hi ELSE net_lo END
                  FROM network_links WHERE status = 'active' AND (net_lo = ? OR net_hi = ?)))
        ORDER BY (u.network_id = ?) DESC, n.name, u.display_name`,
      me.id,
      ...(onlyId ? [onlyId] : []),
      me.network_id,
      me.network_id,
      me.network_id,
      me.network_id,
      me.network_id,
    );
    return rows.map((r) => ({
      id: r.id,
      handle: r.handle,
      displayName: r.display_name,
      role: r.role,
      networkSlug: r.slug,
      networkName: r.net_name,
      sameNetwork: r.network_id === me.network_id,
      publicKey: r.public_key,
    }));
  }

  app.get('/contacts', async (req): Promise<Contact[]> => visibleContacts(req.auth!.user));

  // Consulta de um contato só. O app a usa antes de cada envio para nunca cifrar com chave desatualizada.
  app.get('/contacts/:id', async (req): Promise<Contact> => {
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const contact = visibleContacts(req.auth!.user, id)[0];
    if (!contact) throw notFound('Contato não encontrado');
    return contact;
  });
}
