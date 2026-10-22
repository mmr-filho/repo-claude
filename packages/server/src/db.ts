import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS networks (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  network_id            TEXT NOT NULL REFERENCES networks(id),
  username              TEXT NOT NULL,
  handle                TEXT NOT NULL UNIQUE,
  display_name          TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('admin','member')),
  status                TEXT NOT NULL CHECK (status IN ('pending','active','disabled')),
  activation_hash       TEXT,
  activation_expires    INTEGER,
  activation_failures   INTEGER NOT NULL DEFAULT 0,
  kdf_salt              TEXT,
  kdf_params            TEXT,
  auth_salt             TEXT,
  auth_hash             TEXT,
  public_key            TEXT,
  encrypted_private_key TEXT,
  failed_logins         INTEGER NOT NULL DEFAULT 0,
  locked_until          INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  UNIQUE (network_id, username)
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  device_name TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS network_links (
  id           TEXT PRIMARY KEY,
  net_lo       TEXT NOT NULL REFERENCES networks(id),
  net_hi       TEXT NOT NULL REFERENCES networks(id),
  requested_by TEXT NOT NULL REFERENCES networks(id),
  status       TEXT NOT NULL CHECK (status IN ('pending','active','rejected','cancelled','revoked')),
  via_invite   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  responded_at INTEGER,
  CHECK (net_lo < net_hi)
);
-- No máximo um vínculo aberto (pendente ou ativo) por par de redes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_link_open ON network_links (net_lo, net_hi) WHERE status IN ('pending','active');

CREATE TABLE IF NOT EXISTS link_invites (
  id         TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks(id),
  code_hash  TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

-- Só texto cifrado. Uma linha existe apenas até o destinatário ler (ou expirar).
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  sender_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  envelope        TEXT NOT NULL,
  sender_envelope TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_recipient ON messages (recipient_id, sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_sender    ON messages (sender_id, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_expires   ON messages (expires_at);
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
  db.exec(SCHEMA);
  return db;
}

export function one<T>(db: DB, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(db: DB, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: DB, sql: string, ...params: SQLInputValue[]): number {
  return Number(db.prepare(sql).run(...params).changes);
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}
