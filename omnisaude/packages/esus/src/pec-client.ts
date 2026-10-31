/**
 * Cliente da API de transmissão de registros LEDI do PEC e-SUS APS:
 * - POST {url}/api/recebimento/login (multipart: usuario, senha) → cookie JSESSIONID;
 * - POST {url}/api/v1/recebimento/ficha (multipart: ficha = <uuid>.esus) → 200/201 aceita; 400 recusada com
 *   a mensagem do PEC (regra do LEDI ou formato); 500 erro no PEC.
 * As credenciais são criadas pelo administrador da instalação em Integração > Credenciais de integração.
 */

export interface PecClientOptions {
  url: string;
  usuario: string;
  senha: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class PecError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'PecError';
  }
}

export interface PecSendResult {
  ok: boolean;
  status: number;
  message: string;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

function messageFrom(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; mensagem?: string; erro?: string; error?: string };
    return parsed.message ?? parsed.mensagem ?? parsed.erro ?? parsed.error ?? body;
  } catch {
    return body;
  }
}

export class PecClient {
  private cookie: string | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: PecClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async login(): Promise<void> {
    const form = new FormData();
    form.set('usuario', this.opts.usuario);
    form.set('senha', this.opts.senha);
    const res = await this.fetchImpl(`${trimSlash(this.opts.url)}/api/recebimento/login`, { method: 'POST', body: form, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000) });
    const body = await res.text();
    if (!res.ok) throw new PecError(`Falha no login do PEC (${res.status}): ${messageFrom(body) || 'sem detalhes'}`, res.status, body);
    const cookie = res.headers.get('set-cookie') ?? '';
    const session = /JSESSIONID=([^;]+)/.exec(cookie)?.[1];
    if (!session) throw new PecError('O PEC não devolveu o cookie de sessão (JSESSIONID)', res.status, body);
    this.cookie = `JSESSIONID=${session}`;
  }

  /** Envia uma ficha (DadoTransporte serializado). Não lança para recusas do PEC: devolve ok=false com a mensagem. */
  async sendFicha(uuid: string, data: Uint8Array): Promise<PecSendResult> {
    if (!this.cookie) await this.login();
    const send = async () => {
      const form = new FormData();
      form.set('ficha', new Blob([data], { type: 'application/octet-stream' }), `${uuid}.esus`);
      return this.fetchImpl(`${trimSlash(this.opts.url)}/api/v1/recebimento/ficha`, { method: 'POST', body: form, headers: { Cookie: this.cookie! }, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000) });
    };
    let res = await send();
    if (res.status === 401 || res.status === 403) {
      // Sessão expirada: entra de novo uma vez.
      this.cookie = null;
      await this.login();
      res = await send();
    }
    const body = await res.text();
    if (res.status === 200 || res.status === 201) return { ok: true, status: res.status, message: messageFrom(body) || 'Ficha recebida' };
    if (res.status >= 500) throw new PecError(`Erro no PEC ao receber a ficha (${res.status}): ${messageFrom(body) || 'sem detalhes'}`, res.status, body);
    return { ok: false, status: res.status, message: messageFrom(body) || `Ficha recusada (${res.status})` };
  }
}
