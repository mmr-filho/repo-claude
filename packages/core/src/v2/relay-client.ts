import { b64, utf8Encode, type Bytes } from '../bytes';
import { signRelayRequest } from './relay-auth';
import type { SignKeys } from './keys';

export class RelayError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

export interface RelayMessage {
  id: string;
  ts: number;
  frame: Bytes;
}

/** Cliente do relé anônimo. Não envia identidade nenhuma: só ids de caixa postal e assinaturas do dono. */
export class RelayClient {
  private f: typeof fetch;

  constructor(opts: { fetch?: typeof fetch } = {}) {
    this.f = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  private async call(base: string, method: string, path: string, opts: { key?: SignKeys; body?: Bytes } = {}): Promise<{ status: number; json: unknown }> {
    const body = opts.body ?? new Uint8Array(0);
    const headers: Record<string, string> = opts.key ? signRelayRequest(opts.key.secretKey, method, path, body) : {};
    if (body.length) headers['content-type'] = 'application/octet-stream';
    let res: Response;
    try {
      res = await this.f(base.replace(/\/+$/, '') + path, { method, headers, body: body.length ? (body as BodyInit) : undefined });
    } catch {
      throw new RelayError(0, 'Sem conexão com o relé');
    }
    let json: unknown;
    if (res.status !== 204) {
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
    }
    return { status: res.status, json };
  }

  async createQueue(base: string, qid: string, key: SignKeys): Promise<void> {
    const body = utf8Encode(JSON.stringify({ recvPub: b64.encode(key.publicKey) }));
    const r = await this.call(base, 'PUT', `/q/${qid}`, { key, body });
    if (r.status !== 200 && r.status !== 201) throw new RelayError(r.status, 'Não foi possível criar a caixa postal');
  }

  async send(base: string, qid: string, frame: Bytes): Promise<void> {
    const r = await this.call(base, 'POST', `/q/${qid}/m`, { body: frame });
    if (r.status !== 201) throw new RelayError(r.status, r.status === 404 ? 'Caixa postal do destinatário não existe' : 'O relé recusou a mensagem');
  }

  async list(base: string, qid: string, key: SignKeys): Promise<RelayMessage[]> {
    const r = await this.call(base, 'GET', `/q/${qid}/m`, { key });
    if (r.status !== 200) throw new RelayError(r.status, 'Não foi possível ler a caixa postal');
    return ((r.json as { messages: Array<{ id: string; ts: number; frame: string }> }).messages ?? []).map((m) => ({ id: m.id, ts: m.ts, frame: b64.decode(m.frame) }));
  }

  async count(base: string, qid: string, key: SignKeys): Promise<number> {
    const r = await this.call(base, 'GET', `/q/${qid}/n`, { key });
    if (r.status !== 200) throw new RelayError(r.status, 'Não foi possível contar mensagens');
    return (r.json as { n: number }).n;
  }

  async ack(base: string, qid: string, key: SignKeys, id: string): Promise<void> {
    const r = await this.call(base, 'DELETE', `/q/${qid}/m/${id}`, { key });
    if (r.status !== 204 && r.status !== 404) throw new RelayError(r.status, 'Não foi possível confirmar a leitura');
  }
}
