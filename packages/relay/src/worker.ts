import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_RELAY_CONFIG, handleQueueRequest, parsePath, type QueueStorage, type RelayConfig, type StoredMessage } from './core';

/*
 * Relé no Cloudflare Workers. Cada caixa postal é uma Durable Object própria (nome = id da caixa), com o seu
 * próprio SQLite. Não há conta, não há lista de usuários e não há registro de quem acessa: o Worker só
 * encaminha o pedido à caixa certa e a lógica é a mesma do relé em Node (core.ts).
 */

export interface Env {
  QUEUES: DurableObjectNamespace<QueueObject>;
  MESSAGE_TTL_HOURS?: string;
  IDLE_QUEUE_DAYS?: string;
  /** Limite por IP para CRIAR caixas postais (a operação que consome armazenamento). */
  CREATE_LIMITER?: RateLimit;
  /** Limite geral por IP, folgado: serve para segurar inundações, não para atrapalhar um escritório inteiro atrás de um IP. */
  GENERAL_LIMITER?: RateLimit;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export class QueueObject extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  private get config(): RelayConfig {
    const h = Number(this.env.MESSAGE_TTL_HOURS);
    return { messageTtlMs: Number.isFinite(h) && h > 0 ? h * HOUR : DEFAULT_RELAY_CONFIG.messageTtlMs };
  }

  private get idleMs(): number {
    const d = Number(this.env.IDLE_QUEUE_DAYS);
    return (Number.isFinite(d) && d > 0 ? d : 60) * DAY;
  }

  /** As tabelas só nascem quando a caixa é criada: pedidos a ids que não existem não gravam nada. */
  private storage(): QueueStorage {
    const sql = this.sql;
    const ctx = this.ctx;
    const hasTables = () => sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
    const meta = (k: string) => (hasTables() ? (sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v as string | undefined) : undefined);
    const setMeta = (k: string, v: string) => void sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
    return {
      getRecvPub: () => meta('recv_pub'),
      create(recvPub, now) {
        sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
        sql.exec('CREATE TABLE IF NOT EXISTS msgs (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, expires_at INTEGER NOT NULL, frame BLOB NOT NULL)');
        setMeta('recv_pub', recvPub);
        setMeta('last_seen', String(now));
      },
      count: () => (hasTables() ? Number(sql.exec('SELECT COUNT(*) AS n FROM msgs').one().n) : 0),
      push: (m: StoredMessage, expiresAt: number) =>
        void sql.exec('INSERT INTO msgs (id, ts, expires_at, frame) VALUES (?, ?, ?, ?)', m.id, m.ts, expiresAt, m.frame.slice().buffer),
      list: (limit: number) =>
        sql
          .exec('SELECT id, ts, frame FROM msgs ORDER BY ts, rowid LIMIT ?', limit)
          .toArray()
          .map((r): StoredMessage => ({ id: r.id as string, ts: Number(r.ts), frame: new Uint8Array(r.frame as ArrayBuffer) })),
      remove: (id: string) => sql.exec('DELETE FROM msgs WHERE id = ?', id).rowsWritten > 0,
      touch: (now: number) => setMeta('last_seen', String(now)),
      destroy: () => {
        void ctx.storage.deleteAlarm();
        void ctx.storage.deleteAll();
      },
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    const now = Date.now();
    const out = handleQueueRequest(
      this.storage(),
      { method: request.method, path: url.pathname, headers: { ts: request.headers.get('x-sigilo-ts'), sig: request.headers.get('x-sigilo-sig') }, body },
      now,
      this.config,
    );
    await this.scheduleAlarm(now);
    return out.json === undefined ? new Response(null, { status: out.status }) : Response.json(out.json, { status: out.status });
  }

  /** O alarme acorda a caixa só quando algo precisa ser apagado: a próxima mensagem a vencer ou o fim da inatividade. */
  private async scheduleAlarm(now: number): Promise<void> {
    const tables = this.sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
    if (!tables) return;
    const lastSeen = Number(this.sql.exec("SELECT v FROM meta WHERE k = 'last_seen'").toArray()[0]?.v ?? now);
    const nextMsg = this.sql.exec('SELECT MIN(expires_at) AS e FROM msgs').toArray()[0]?.e;
    const next = Math.min(lastSeen + this.idleMs, typeof nextMsg === 'number' ? nextMsg : Infinity);
    await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const tables = this.sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
    if (!tables) return;
    this.sql.exec('DELETE FROM msgs WHERE expires_at <= ?', now);
    const lastSeen = Number(this.sql.exec("SELECT v FROM meta WHERE k = 'last_seen'").toArray()[0]?.v ?? now);
    if (lastSeen + this.idleMs <= now) {
      await this.ctx.storage.deleteAll(); // caixa abandonada
      return;
    }
    await this.scheduleAlarm(now);
  }
}

const tooMany = () => Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '30' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') return Response.json({ ok: true });
    const parsed = parsePath(pathname);
    if (!parsed) return Response.json({ error: 'not_found' }, { status: 404 });

    // O IP é usado só para limitar abuso, no momento do pedido. Não é guardado em lugar nenhum.
    const ip = request.headers.get('cf-connecting-ip') ?? 'desconhecido';
    if (request.method === 'PUT' && env.CREATE_LIMITER && !(await env.CREATE_LIMITER.limit({ key: ip })).success) return tooMany();
    if (env.GENERAL_LIMITER && !(await env.GENERAL_LIMITER.limit({ key: ip })).success) return tooMany();

    return env.QUEUES.get(env.QUEUES.idFromName(parsed.qid)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
