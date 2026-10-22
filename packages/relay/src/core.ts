import { b64, randomBytes } from '@sigilo/core';
import { HEADER_SIG, HEADER_TS, verifyRelayRequest } from '@sigilo/core/v2';

/*
 * Lógica do relé, independente de onde roda (Node + SQLite, ou Cloudflare Durable Object).
 *
 * O relé é "burro" de propósito: guarda quadros cifrados em caixas postais identificadas por ids aleatórios.
 * Não tem contas, não sabe quem escreve, não lê o conteúdo e apaga quando o dono confirma a leitura.
 */

export const MAX_FRAME_BYTES = 16 * 1024;
export const MAX_QUEUE_MESSAGES = 200;
export const LIST_LIMIT = 100;
export const QID_RE = /^[A-Za-z0-9_-]{22,43}$/;

export interface StoredMessage {
  id: string;
  ts: number;
  frame: Uint8Array;
}

/** Armazenamento de UMA caixa postal. Implementações: SQLite (Node) e armazenamento do Durable Object. */
export interface QueueStorage {
  getRecvPub(): string | undefined;
  create(recvPub: string, now: number): void;
  count(): number;
  push(msg: StoredMessage, expiresAt: number): void;
  list(limit: number): StoredMessage[];
  remove(id: string): boolean;
  touch(now: number): void;
  destroy(): void;
}

export interface RelayRequest {
  method: string;
  /** Caminho completo, sem query: /q/<qid>/m */
  path: string;
  headers: { ts?: string | null; sig?: string | null };
  body: Uint8Array;
}

export interface RelayResponse {
  status: number;
  json?: unknown;
}

export interface RelayConfig {
  messageTtlMs: number;
}

export const DEFAULT_RELAY_CONFIG: RelayConfig = { messageTtlMs: 7 * 24 * 60 * 60 * 1000 };

const res = (status: number, json?: unknown): RelayResponse => ({ status, json });
export const HEADER_NAMES = { ts: HEADER_TS, sig: HEADER_SIG };

export function parsePath(path: string): { qid: string; rest: string[] } | undefined {
  const m = /^\/q\/([^/]+)((?:\/[^/]+)*)$/.exec(path);
  if (!m || !QID_RE.test(m[1]!)) return undefined;
  return { qid: m[1]!, rest: m[2]!.split('/').filter(Boolean) };
}

export function handleQueueRequest(storage: QueueStorage, req: RelayRequest, now: number, cfg: RelayConfig = DEFAULT_RELAY_CONFIG): RelayResponse {
  const parsed = parsePath(req.path);
  if (!parsed) return res(404, { error: 'not_found' });
  const [seg, arg] = parsed.rest;
  const method = req.method.toUpperCase();
  const recvPub = storage.getRecvPub();
  const authed = () => !!recvPub && verifyRelayRequest(recvPub, method, req.path, req.headers, req.body, now);

  // Criar a caixa postal: quem cria prova que tem a chave privada (assinatura com a própria chave pública enviada).
  if (method === 'PUT' && !seg) {
    let pub: string;
    try {
      pub = (JSON.parse(new TextDecoder().decode(req.body)) as { recvPub?: string }).recvPub ?? '';
      if (b64.decode(pub).length !== 32) throw new Error('chave');
    } catch {
      return res(400, { error: 'bad_request' });
    }
    if (!verifyRelayRequest(pub, method, req.path, req.headers, req.body, now)) return res(401, { error: 'unauthorized' });
    if (recvPub) return recvPub === pub ? res(200, { ok: true }) : res(409, { error: 'exists' });
    storage.create(pub, now);
    return res(201, { ok: true });
  }

  // Enviar: qualquer um que conheça o id da caixa. Só quem recebe o id (colegas da rede) consegue endereçar.
  if (method === 'POST' && seg === 'm' && !arg) {
    if (!recvPub) return res(404, { error: 'not_found' });
    if (req.body.length === 0 || req.body.length > MAX_FRAME_BYTES) return res(413, { error: 'bad_size' });
    if (storage.count() >= MAX_QUEUE_MESSAGES) return res(429, { error: 'queue_full' });
    const id = b64.encode(randomBytes(12));
    storage.push({ id, ts: now, frame: req.body }, now + cfg.messageTtlMs);
    return res(201, { id });
  }

  if (!recvPub) return res(404, { error: 'not_found' });
  if (!authed()) return res(401, { error: 'unauthorized' });
  storage.touch(now);

  if (method === 'GET' && seg === 'm' && !arg) {
    const messages = storage.list(LIST_LIMIT).map((m) => ({ id: m.id, ts: m.ts, frame: b64.encode(m.frame) }));
    return res(200, { messages });
  }
  if (method === 'GET' && seg === 'n' && !arg) return res(200, { n: storage.count() });
  if (method === 'DELETE' && seg === 'm' && arg) return storage.remove(arg) ? res(204) : res(404, { error: 'not_found' });
  if (method === 'DELETE' && !seg) {
    storage.destroy();
    return res(204);
  }
  return res(404, { error: 'not_found' });
}
