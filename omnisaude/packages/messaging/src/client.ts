/** Cliente mínimo da WhatsApp Business Cloud API (Graph API da Meta). */

export const DEFAULT_GRAPH_BASE_URL = 'https://graph.facebook.com';
export const DEFAULT_GRAPH_API_VERSION = 'v23.0';

export interface WhatsAppClientOptions {
  phoneNumberId: string;
  accessToken: string;
  baseUrl?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface TemplateButton {
  /** Botões de resposta rápida carregam um payload que volta no webhook. */
  subType: 'quick_reply';
  index: number;
  payload: string;
}

export interface TemplateMessage {
  name: string;
  languageCode: string;
  bodyParams: string[];
  headerParams?: string[];
  buttons?: TemplateButton[];
}

export interface ReplyButton {
  id: string;
  title: string;
}

export interface InteractiveButtonsMessage {
  body: string;
  header?: string;
  footer?: string;
  buttons: ReplyButton[];
}

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly fbtraceId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

interface GraphSendResponse {
  messages?: { id: string }[];
}

export const MAX_REPLY_BUTTONS = 3;
export const MAX_BUTTON_TITLE = 20;

export function templatePayload(to: string, t: TemplateMessage): Record<string, unknown> {
  const components: Record<string, unknown>[] = [];
  if (t.headerParams?.length) {
    components.push({ type: 'header', parameters: t.headerParams.map((text) => ({ type: 'text', text })) });
  }
  if (t.bodyParams.length) {
    components.push({ type: 'body', parameters: t.bodyParams.map((text) => ({ type: 'text', text })) });
  }
  for (const b of t.buttons ?? []) {
    components.push({
      type: 'button',
      sub_type: b.subType,
      index: String(b.index),
      parameters: [{ type: 'payload', payload: b.payload }],
    });
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name: t.name, language: { code: t.languageCode }, components },
  };
}

export function interactiveButtonsPayload(to: string, m: InteractiveButtonsMessage): Record<string, unknown> {
  if (m.buttons.length === 0 || m.buttons.length > MAX_REPLY_BUTTONS) {
    throw new Error(`Mensagens interativas aceitam de 1 a ${MAX_REPLY_BUTTONS} botões`);
  }
  for (const b of m.buttons) {
    if (b.title.length > MAX_BUTTON_TITLE) throw new Error(`Título do botão excede ${MAX_BUTTON_TITLE} caracteres: ${b.title}`);
    if (b.id.length > 256) throw new Error('Identificador do botão excede 256 caracteres');
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(m.header ? { header: { type: 'text', text: m.header } } : {}),
      body: { text: m.body },
      ...(m.footer ? { footer: { text: m.footer } } : {}),
      action: { buttons: m.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    },
  };
}

export class WhatsAppCloudClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WhatsAppClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get messagesUrl(): string {
    const base = (this.opts.baseUrl ?? DEFAULT_GRAPH_BASE_URL).replace(/\/+$/, '');
    return `${base}/${this.opts.apiVersion ?? DEFAULT_GRAPH_API_VERSION}/${this.opts.phoneNumberId}/messages`;
  }

  async sendText(to: string, body: string, opts: { previewUrl?: boolean } = {}): Promise<string> {
    return this.send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: opts.previewUrl ?? false },
    });
  }

  async sendTemplate(to: string, template: TemplateMessage): Promise<string> {
    return this.send(templatePayload(to, template));
  }

  async sendInteractiveButtons(to: string, message: InteractiveButtonsMessage): Promise<string> {
    return this.send(interactiveButtonsPayload(to, message));
  }

  /** Envia um corpo já montado e devolve o id da mensagem (wamid). */
  async send(payload: Record<string, unknown>): Promise<string> {
    const res = await this.fetchImpl(this.messagesUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }
    if (!res.ok) {
      const err = (body as GraphErrorBody)?.error;
      throw new WhatsAppApiError(
        err?.message ?? `WhatsApp respondeu ${res.status}`,
        res.status,
        err?.code,
        err?.error_subcode,
        err?.fbtrace_id,
        body,
      );
    }
    const id = (body as GraphSendResponse)?.messages?.[0]?.id;
    if (!id) throw new WhatsAppApiError('Resposta do WhatsApp sem id de mensagem', res.status, undefined, undefined, undefined, body);
    return id;
  }
}
