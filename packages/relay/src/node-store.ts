import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { QueueStorage, StoredMessage } from './core.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queues (
  qid        TEXT PRIMARY KEY,
  recv_pub   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS msgs (
  id         TEXT PRIMARY KEY,
  qid        TEXT NOT NULL REFERENCES queues(qid) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  frame      BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msgs_qid ON msgs (qid, ts);
CREATE INDEX IF NOT EXISTS idx_msgs_exp ON msgs (expires_at);
`;

/** Armazenamento em SQLite para rodar o relé em Node (VPS ou máquina própria). */
export class NodeRelayStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
    this.db.exec(SCHEMA);
  }

  queue(qid: string): QueueStorage {
    const db = this.db;
    return {
      getRecvPub: () => (db.prepare('SELECT recv_pub FROM queues WHERE qid = ?').get(qid) as { recv_pub: string } | undefined)?.recv_pub,
      create: (recvPub, now) => void db.prepare('INSERT INTO queues (qid, recv_pub, created_at, last_seen) VALUES (?, ?, ?, ?)').run(qid, recvPub, now, now),
      count: () => Number((db.prepare('SELECT COUNT(*) AS n FROM msgs WHERE qid = ?').get(qid) as { n: number }).n),
      push: (m, expiresAt) =>
        void db.prepare('INSERT INTO msgs (id, qid, ts, expires_at, frame) VALUES (?, ?, ?, ?, ?)').run(m.id, qid, m.ts, expiresAt, m.frame),
      list: (limit) =>
        (db.prepare('SELECT id, ts, frame FROM msgs WHERE qid = ? ORDER BY ts, rowid LIMIT ?').all(qid, limit) as Array<{ id: string; ts: number; frame: Uint8Array }>).map(
          (r): StoredMessage => ({ id: r.id, ts: Number(r.ts), frame: new Uint8Array(r.frame) }),
        ),
      remove: (id) => Number(db.prepare('DELETE FROM msgs WHERE qid = ? AND id = ?').run(qid, id).changes) > 0,
      touch: (now) => void db.prepare('UPDATE queues SET last_seen = ? WHERE qid = ?').run(now, qid),
      destroy: () => void db.prepare('DELETE FROM queues WHERE qid = ?').run(qid),
    };
  }

  /** Apaga mensagens vencidas e caixas abandonadas. */
  purge(now: number, idleQueueMs: number): { messages: number; queues: number } {
    const messages = Number(this.db.prepare('DELETE FROM msgs WHERE expires_at <= ?').run(now).changes);
    const queues = Number(this.db.prepare('DELETE FROM queues WHERE last_seen <= ?').run(now - idleQueueMs).changes);
    return { messages, queues };
  }

  close(): void {
    this.db.close();
  }
}
