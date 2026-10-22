import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MemberDTO, MemberWithCode } from '@sigilo/core';
import { parse, type Ctx } from '../context.js';
import { all, run, tx } from '../db.js';
import {
  createMember,
  getUser,
  issueActivation,
  linkedNetworkIds,
  purgeMessagesOfUser,
  toMemberDTO,
  userIdsOfNetworks,
  type UserRow,
} from '../services.js';
import { badRequest, notFound } from '../util.js';

const createSchema = z
  .object({
    username: z
      .string()
      .max(40)
      .transform((s) => s.trim().toLowerCase()),
    displayName: z.string().min(1).max(80),
    role: z.enum(['admin', 'member']).default('member'),
  })
  .strict();

const idParam = z.object({ id: z.uuid() });

export function registerAdminRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, hub, config } = ctx;

  /** Administrador só enxerga e altera gente da própria rede. */
  function memberOfMyNetwork(networkId: string, id: string): UserRow {
    const user = getUser(db, id);
    if (!user || user.network_id !== networkId) throw notFound('Membro não encontrado');
    return user;
  }

  function notifyDirectoryChanged(networkId: string): void {
    hub.sendMany(userIdsOfNetworks(db, networkId, ...linkedNetworkIds(db, networkId)), { type: 'contacts.changed' });
  }

  function endAccess(userId: string): void {
    run(db, 'DELETE FROM sessions WHERE user_id = ?', userId);
    purgeMessagesOfUser(db, userId);
    hub.revokeUser(userId);
  }

  app.get('/admin/members', async (req): Promise<MemberDTO[]> => {
    return all<UserRow>(db, 'SELECT * FROM users WHERE network_id = ? ORDER BY created_at', req.auth!.network.id).map(toMemberDTO);
  });

  app.post('/admin/members', async (req, reply): Promise<MemberWithCode> => {
    const input = parse(createSchema, req.body);
    const created = tx(db, () => createMember(db, config, req.auth!.network, input));
    reply.code(201);
    return { member: toMemberDTO(created.member), activationCode: created.activationCode, activationExpiresAt: created.activationExpiresAt };
  });

  // "Esqueci a senha": zera as chaves da conta. O histórico pendente é perdido (ninguém mais consegue abri-lo).
  app.post('/admin/members/:id/reset-activation', async (req): Promise<MemberWithCode> => {
    const { id } = parse(idParam, req.params);
    if (id === req.auth!.user.id) throw badRequest('Para trocar a própria senha use "Alterar senha"');
    const member = memberOfMyNetwork(req.auth!.network.id, id);
    const activation = tx(db, () => {
      run(
        db,
        `UPDATE users SET status = 'pending', kdf_salt = NULL, kdf_params = NULL, auth_salt = NULL, auth_hash = NULL,
           public_key = NULL, encrypted_private_key = NULL, failed_logins = 0, locked_until = 0 WHERE id = ?`,
        member.id,
      );
      endAccess(member.id);
      return issueActivation(db, config, member.id);
    });
    notifyDirectoryChanged(member.network_id);
    return { member: toMemberDTO(getUser(db, member.id)!), activationCode: activation.code, activationExpiresAt: activation.expiresAt };
  });

  app.post('/admin/members/:id/disable', async (req): Promise<MemberDTO> => {
    const { id } = parse(idParam, req.params);
    if (id === req.auth!.user.id) throw badRequest('Você não pode desativar a própria conta');
    const member = memberOfMyNetwork(req.auth!.network.id, id);
    tx(db, () => {
      run(db, "UPDATE users SET status = 'disabled' WHERE id = ?", member.id);
      endAccess(member.id);
    });
    notifyDirectoryChanged(member.network_id);
    return toMemberDTO(getUser(db, member.id)!);
  });

  app.post('/admin/members/:id/enable', async (req): Promise<MemberDTO> => {
    const { id } = parse(idParam, req.params);
    const member = memberOfMyNetwork(req.auth!.network.id, id);
    run(db, 'UPDATE users SET status = ?, failed_logins = 0, locked_until = 0 WHERE id = ?', member.auth_hash ? 'active' : 'pending', member.id);
    notifyDirectoryChanged(member.network_id);
    return toMemberDTO(getUser(db, member.id)!);
  });
}
