import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { decodeButtonPayload, type AppointmentAction, type DecodedPayload } from './templates';

/** Assinatura "sha256=<hex>" enviada pela Meta em X-Hub-Signature-256 (HMAC do corpo cru com o app secret). */
export function verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | undefined | null, appSecret: string): boolean {
  if (!signatureHeader || !appSecret) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!m) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(m[1]!, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

type Query = Record<string, string | string[] | undefined>;

/** Handshake de verificação (GET) do endpoint do webhook. */
export function handleVerificationChallenge(query: Query, verifyToken: string): { ok: true; challenge: string } | { ok: false } {
  const one = (k: string) => {
    const v = query[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const mode = one('hub.mode');
  const token = one('hub.verify_token');
  const challenge = one('hub.challenge');
  if (mode !== 'subscribe' || !token || !challenge || !verifyToken) return { ok: false };
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  return { ok: true, challenge };
}

export type WebhookEvent =
  | {
      type: 'appointment_reply';
      action: AppointmentAction | 'SLOT';
      appointmentId: string;
      slotId?: string;
      from: string;
      messageId: string;
      contextMessageId?: string;
      timestamp: Date;
    }
  | {
      type: 'button_reply';
      payload: string;
      title?: string;
      decoded: DecodedPayload | null;
      from: string;
      messageId: string;
      contextMessageId?: string;
      timestamp: Date;
    }
  | { type: 'text'; text: string; from: string; profileName?: string; messageId: string; timestamp: Date }
  | {
      type: 'status';
      messageId: string;
      recipient: string;
      status: 'sent' | 'delivered' | 'read' | 'failed' | string;
      timestamp: Date;
      errors?: { code?: number; title?: string; message?: string }[];
    }
  | { type: 'unsupported'; messageType?: string; from?: string; messageId?: string; timestamp?: Date };

const messageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string(),
    type: z.string(),
    context: z.object({ id: z.string().optional() }).loose().optional(),
    text: z.object({ body: z.string() }).loose().optional(),
    button: z.object({ payload: z.string(), text: z.string().optional() }).loose().optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z.object({ id: z.string(), title: z.string().optional() }).loose().optional(),
        list_reply: z.object({ id: z.string(), title: z.string().optional() }).loose().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const statusSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    timestamp: z.string(),
    recipient_id: z.string(),
    errors: z.array(z.object({ code: z.number().optional(), title: z.string().optional(), message: z.string().optional() }).loose()).optional(),
  })
  .loose();

const webhookSchema = z
  .object({
    object: z.string().optional(),
    entry: z.array(
      z
        .object({
          changes: z.array(
            z
              .object({
                field: z.string().optional(),
                value: z
                  .object({
                    contacts: z.array(z.object({ wa_id: z.string().optional(), profile: z.object({ name: z.string().optional() }).loose().optional() }).loose()).optional(),
                    messages: z.array(z.unknown()).optional(),
                    statuses: z.array(z.unknown()).optional(),
                  })
                  .loose(),
              })
              .loose(),
          ),
        })
        .loose(),
    ),
  })
  .loose();

const toDate = (unixSeconds: string) => new Date(Number(unixSeconds) * 1000);

function buttonEvent(
  payload: string,
  title: string | undefined,
  base: { from: string; messageId: string; contextMessageId?: string; timestamp: Date },
): WebhookEvent {
  const decoded = decodeButtonPayload(payload);
  if (decoded?.kind === 'APPOINTMENT') {
    return { type: 'appointment_reply', action: decoded.action, appointmentId: decoded.appointmentId, ...base };
  }
  if (decoded?.kind === 'APPOINTMENT_SLOT') {
    return { type: 'appointment_reply', action: 'SLOT', appointmentId: decoded.appointmentId, slotId: decoded.slotId, ...base };
  }
  return { type: 'button_reply', payload, ...(title ? { title } : {}), decoded, ...base };
}

/** Normaliza o corpo do webhook em eventos. Itens malformados viram "unsupported" em vez de derrubar o lote. */
export function parseWebhook(body: unknown): WebhookEvent[] {
  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success) throw new Error('Corpo de webhook do WhatsApp inválido');
  const events: WebhookEvent[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      const value = change.value;
      const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const raw of value.messages ?? []) {
        const m = messageSchema.safeParse(raw);
        if (!m.success) {
          events.push({ type: 'unsupported' });
          continue;
        }
        const msg = m.data;
        const base = {
          from: msg.from,
          messageId: msg.id,
          ...(msg.context?.id ? { contextMessageId: msg.context.id } : {}),
          timestamp: toDate(msg.timestamp),
        };
        if (msg.type === 'button' && msg.button) {
          events.push(buttonEvent(msg.button.payload, msg.button.text, base));
        } else if (msg.type === 'interactive' && msg.interactive?.button_reply) {
          events.push(buttonEvent(msg.interactive.button_reply.id, msg.interactive.button_reply.title, base));
        } else if (msg.type === 'interactive' && msg.interactive?.list_reply) {
          events.push(buttonEvent(msg.interactive.list_reply.id, msg.interactive.list_reply.title, base));
        } else if (msg.type === 'text' && msg.text) {
          const profileName = names.get(msg.from);
          events.push({
            type: 'text',
            text: msg.text.body,
            from: msg.from,
            ...(profileName ? { profileName } : {}),
            messageId: msg.id,
            timestamp: base.timestamp,
          });
        } else {
          events.push({ type: 'unsupported', messageType: msg.type, from: msg.from, messageId: msg.id, timestamp: base.timestamp });
        }
      }
      for (const raw of value.statuses ?? []) {
        const s = statusSchema.safeParse(raw);
        if (!s.success) {
          events.push({ type: 'unsupported' });
          continue;
        }
        events.push({
          type: 'status',
          messageId: s.data.id,
          recipient: s.data.recipient_id,
          status: s.data.status,
          timestamp: toDate(s.data.timestamp),
          ...(s.data.errors ? { errors: s.data.errors } : {}),
        });
      }
    }
  }
  return events;
}
