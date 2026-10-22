import type { ServerEvent } from './types';

/** Subconjunto do WebSocket padrão usado aqui (compatível com o do navegador, React Native e Node 22). */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface RealtimeOptions {
  baseUrl: string;
  token: string;
  onEvent: (event: ServerEvent) => void;
  /** 'up' quando autenticado, 'down' quando cai. */
  onStatus?: (status: 'up' | 'down') => void;
  WebSocket?: WebSocketCtor;
}

/** Avisos em tempo real (chegou mensagem, foi lida). Reconecta sozinho com espera crescente. */
export class RealtimeClient {
  private ws?: WebSocketLike;
  private closed = false;
  private attempts = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private opts: RealtimeOptions) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000);
      } catch {
        /* já fechado */
      }
    }
  }

  private connect(): void {
    const Ctor = this.opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Ctor) throw new Error('WebSocket indisponível neste ambiente');
    const url = this.opts.baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
    const ws = new Ctor(url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.opts.token }));
    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(String(ev.data)) as ServerEvent;
        if (event.type === 'ready') {
          this.attempts = 0;
          this.opts.onStatus?.('up');
        }
        if (event.type === 'session.revoked') this.closed = true;
        this.opts.onEvent(event);
      } catch {
        /* ignora quadro inválido */
      }
    };
    ws.onclose = () => {
      this.ws = undefined;
      this.opts.onStatus?.('down');
      if (this.closed) return;
      const delay = Math.min(30_000, 500 * 2 ** this.attempts++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      /* o onclose cuida da reconexão */
    };
  }
}
