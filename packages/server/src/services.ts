import type { LinkDTO, MemberDTO, Role, UserDTO } from '@sigilo/core';
import type { Config } from './config.js';
import { all, one, placeholders, run, tx, type DB } from './db.js';
import { badRequest, conflict, hashCode, newCode, newId, now } from './util.js';

export interface NetworkRow {
  id: string;
  slug: string;
  name: string;
  created_at: number;
}

export interface UserRow {
  id: string;
  network_id: string;
  username: string;
  handle: string;
  display_name: string;
  role: Role;
  status: 'pending' | 'active' | 'disabled';
  activation_hash: string | null;
  activation_expires: number | null;
  activation_failures: number;
  kdf_salt: string | null;
  kdf_params: string | null;
  auth_salt: string | null;
  auth_hash: string | null;
  public_key: string | null;
  encrypted_private_key: string | null;
  failed_logins: number;
  locked_until: number;
  created_at: number;
}

export interface LinkRow {
  id: string;
  net_lo: string;
  net_hi: string;
  requested_by: string;
  status: 'pending' | 'active' | 'rejected' | 'cancelled' | 'revoked';
  via_invite: number;
  created_at: number;
  responded_at: number | null;
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export const getNetwork = (db: DB, id: string) => one<NetworkRow>(db, 'SELECT * FROM networks WHERE id = ?', id);
export const getNetworkBySlug = (db: DB, slug: string) => one<NetworkRow>(db, 'SELECT * FROM networks WHERE slug = ?', slug);
export const getUser = (db: DB, id: string) => one<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);

export function toUserDTO(user: UserRow, network: NetworkRow): UserDTO {
  return {
    id: user.id,
    handle: user.handle,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    networkId: network.id,
    networkSlug: network.slug,
    networkName: network.name,
  };
}

export function toMemberDTO(user: UserRow): MemberDTO {
  return {
    id: user.id,
    username: user.username,
    handle: user.handle,
    displayName: user.display_name,
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
  };
}

export function toLinkDTO(row: LinkRow & { peer_slug: string; peer_name: string }, myNetworkId: string): LinkDTO {
  return {
    id: row.id,
    peerSlug: row.peer_slug,
    peerName: row.peer_name,
    status: row.status === 'active' ? 'active' : 'pending',
    direction: row.status === 'active' ? 'mutual' : row.requested_by === myNetworkId ? 'outgoing' : 'incoming',
    createdAt: row.created_at,
  };
}

export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function hasActiveLink(db: DB, netA: string, netB: string): boolean {
  const [lo, hi] = orderedPair(netA, netB);
  return !!one(db, "SELECT 1 AS x FROM network_links WHERE net_lo = ? AND net_hi = ? AND status = 'active'", lo, hi);
}

/**
 * Regra central de isolamento: duas pessoas só trocam mensagens se estiverem na mesma rede
 * ou em redes com vínculo ativo direto. Vínculos não são transitivos.
 */
export function canMessage(db: DB, a: UserRow, b: UserRow): boolean {
  if (a.id === b.id) return false;
  if (a.status !== 'active' || b.status !== 'active') return false;
  return a.network_id === b.network_id || hasActiveLink(db, a.network_id, b.network_id);
}

export function userIdsOfNetworks(db: DB, ...networkIds: string[]): string[] {
  return all<{ id: string }>(db, `SELECT id FROM users WHERE network_id IN (${placeholders(networkIds.length)})`, ...networkIds).map((r) => r.id);
}

export function purgeMessagesOfUser(db: DB, userId: string): number {
  return run(db, 'DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?', userId, userId);
}

export function purgeMessagesBetweenNetworks(db: DB, netA: string, netB: string): number {
  return run(
    db,
    `DELETE FROM messages WHERE
       (sender_id IN (SELECT id FROM users WHERE network_id = ?) AND recipient_id IN (SELECT id FROM users WHERE network_id = ?))
    OR (sender_id IN (SELECT id FROM users WHERE network_id = ?) AND recipient_id IN (SELECT id FROM users WHERE network_id = ?))`,
    netA,
    netB,
    netB,
    netA,
  );
}

export function purgeExpired(db: DB, at = now()): { messages: number; sessions: number; invites: number } {
  return {
    messages: run(db, 'DELETE FROM messages WHERE expires_at <= ?', at),
    sessions: run(db, 'DELETE FROM sessions WHERE expires_at <= ?', at),
    invites: run(db, 'DELETE FROM link_invites WHERE expires_at <= ? OR used_at IS NOT NULL', at),
  };
}

// ───────── Administração ─────────

export interface NewMemberInput {
  username: string;
  displayName: string;
  role: Role;
}

export function validateMemberInput(input: NewMemberInput): void {
  if (!USERNAME_RE.test(input.username)) {
    throw badRequest('Usuário deve ter 2 a 32 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado');
  }
  const name = input.displayName.trim();
  if (name.length < 1 || name.length > 60) throw badRequest('Nome deve ter entre 1 e 60 caracteres');
}

export function issueActivation(db: DB, cfg: Config, userId: string): { code: string; expiresAt: number } {
  const code = newCode();
  const expiresAt = now() + cfg.activationTtlMs;
  run(db, 'UPDATE users SET activation_hash = ?, activation_expires = ?, activation_failures = 0 WHERE id = ?', hashCode(code), expiresAt, userId);
  return { code, expiresAt };
}

export function createMember(db: DB, cfg: Config, network: NetworkRow, input: NewMemberInput) {
  validateMemberInput(input);
  const handle = `${input.username}@${network.slug}`;
  const id = newId();
  try {
    run(
      db,
      `INSERT INTO users (id, network_id, username, handle, display_name, role, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      network.id,
      input.username,
      handle,
      input.displayName.trim(),
      input.role,
      now(),
    );
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) throw conflict(`O usuário ${handle} já existe`);
    throw err;
  }
  const activation = issueActivation(db, cfg, id);
  return { member: getUser(db, id)!, activationCode: activation.code, activationExpiresAt: activation.expiresAt };
}

export function createNetwork(
  db: DB,
  cfg: Config,
  input: { slug: string; name: string; adminUsername: string; adminDisplayName: string },
) {
  if (!SLUG_RE.test(input.slug)) throw badRequest('Código da rede: 2 a 32 caracteres, letras minúsculas, números e hífen');
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw badRequest('Nome da rede deve ter entre 2 e 80 caracteres');
  return tx(db, () => {
    const id = newId();
    try {
      run(db, 'INSERT INTO networks (id, slug, name, created_at) VALUES (?, ?, ?, ?)', id, input.slug, name, now());
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) throw conflict(`Já existe uma rede com o código ${input.slug}`);
      throw err;
    }
    const network = getNetwork(db, id)!;
    const admin = createMember(db, cfg, network, {
      username: input.adminUsername,
      displayName: input.adminDisplayName,
      role: 'admin',
    });
    return { network, ...admin };
  });
}

/** Redes com vínculo ativo direto com `networkId`. */
export function linkedNetworkIds(db: DB, networkId: string): string[] {
  return all<{ id: string }>(
    db,
    `SELECT CASE WHEN net_lo = ? THEN net_hi ELSE net_lo END AS id
       FROM network_links WHERE status = 'active' AND (net_lo = ? OR net_hi = ?)`,
    networkId,
    networkId,
    networkId,
  ).map((r) => r.id);
}
