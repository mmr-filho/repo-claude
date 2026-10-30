import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAdherenceReminderTemplate,
  buildAppointmentConfirmationTemplate,
  buildRescheduleOptions,
  decodeButtonPayload,
  encodeAppointmentPayload,
  formatBrazilPhone,
  handleVerificationChallenge,
  normalizeBrazilPhone,
  parseWebhook,
  verifyWebhookSignature,
  WhatsAppApiError,
  WhatsAppCloudClient,
} from '@omnisaude/messaging';

describe('telefones', () => {
  it('normaliza para E.164 sem "+"', () => {
    expect(normalizeBrazilPhone('(11) 99999-8888')).toBe('5511999998888');
    expect(normalizeBrazilPhone('+55 11 99999-8888')).toBe('5511999998888');
    expect(normalizeBrazilPhone('011 99999-8888')).toBe('5511999998888');
    expect(normalizeBrazilPhone('0 21 11 99999-8888')).toBe('5511999998888');
    expect(normalizeBrazilPhone('551199998888')).toBe('551199998888'); // wa_id antigo, sem o nono dígito
    expect(normalizeBrazilPhone('(63) 3412-0000')).toBe('556334120000');
    expect(normalizeBrazilPhone('(10) 99999-8888')).toBeNull(); // DDD inexistente
    expect(normalizeBrazilPhone('(11) 89999-8888')).toBeNull(); // 9 dígitos sem iniciar por 9
    expect(normalizeBrazilPhone('12345')).toBeNull();
    expect(formatBrazilPhone('5511999998888')).toBe('(11) 99999-8888');
  });
});

describe('mensagens', () => {
  it('monta o template de confirmação com payloads dos botões', () => {
    const t = buildAppointmentConfirmationTemplate({
      appointmentId: 'apt_123',
      patientName: 'MARIA DA SILVA',
      service: 'Clínica Médica',
      unitName: 'UBS Centro',
      startsAt: new Date('2026-03-12T17:30:00Z'),
      timeZone: 'America/Sao_Paulo',
    });
    expect(t.name).toBe('confirmacao_consulta');
    expect(t.bodyParams[0]).toBe('Maria');
    expect(t.bodyParams[2]).toMatch(/^quinta-feira, 12\/03$/);
    expect(t.bodyParams[3]).toBe('14:30');
    expect(t.buttons?.map((b) => b.payload)).toEqual(['APPT:CONFIRM:apt_123', 'APPT:CANCEL:apt_123', 'APPT:RESCHEDULE:apt_123']);
  });

  it('descreve doses de outro dia no lembrete', () => {
    const t = buildAdherenceReminderTemplate({
      patientName: 'João Souza',
      medication: 'Amoxicilina 500 mg',
      dose: '1 cápsula',
      doseTimes: [new Date('2026-03-11T01:00:00Z'), new Date('2026-03-11T09:00:00Z')],
      sendAt: new Date('2026-03-11T09:01:00Z'),
      reminderId: 'rem1',
      timeZone: 'America/Sao_Paulo',
    });
    expect(t.bodyParams).toEqual(['João', 'Amoxicilina 500 mg (1 cápsula)', '22:00 de 10/03 e 06:00']);
    expect(t.buttons?.[0]?.payload).toBe('ADH:TAKEN:rem1');
  });

  it('oferece até três horários para remarcar', () => {
    const m = buildRescheduleOptions({
      appointmentId: 'apt_1',
      slots: [1, 2, 3, 4].map((i) => ({ id: `s${i}`, startsAt: new Date(`2026-03-1${i}T12:00:00Z`) })),
      timeZone: 'America/Sao_Paulo',
    });
    expect(m.buttons).toHaveLength(3);
    expect(m.buttons[0]!.id).toBe('APPT:SLOT:apt_1:s1');
    expect(m.buttons.every((b) => b.title.length <= 20)).toBe(true);
  });

  it('codifica e decodifica payloads', () => {
    expect(decodeButtonPayload(encodeAppointmentPayload('CANCEL', 'abc'))).toEqual({
      kind: 'APPOINTMENT',
      action: 'CANCEL',
      appointmentId: 'abc',
    });
    expect(decodeButtonPayload('APPT:DELETE:abc')).toBeNull();
    expect(decodeButtonPayload('qualquer coisa')).toBeNull();
    expect(() => encodeAppointmentPayload('CONFIRM', 'a:b')).toThrow();
  });
});

describe('cliente da Cloud API', () => {
  it('envia template e devolve o id', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.X' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new WhatsAppCloudClient({ phoneNumberId: '123', accessToken: 'tok', apiVersion: 'v99.0', fetchImpl });
    const id = await client.sendTemplate('5511999998888', {
      name: 'confirmacao_consulta',
      languageCode: 'pt_BR',
      bodyParams: ['Maria'],
      buttons: [{ subType: 'quick_reply', index: 0, payload: 'APPT:CONFIRM:1' }],
    });
    expect(id).toBe('wamid.X');
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v99.0/123/messages');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Maria' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'APPT:CONFIRM:1' }] },
    ]);
  });

  it('lança erro tipado em respostas de erro', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'Invalid parameter', code: 100, error_subcode: 2018001, fbtrace_id: 'T' } }), {
        status: 400,
      })) as unknown as typeof fetch;
    const client = new WhatsAppCloudClient({ phoneNumberId: '1', accessToken: 't', fetchImpl });
    const err = await client.sendText('5511999998888', 'oi').catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppApiError);
    expect(err).toMatchObject({ status: 400, code: 100, subcode: 2018001, fbtraceId: 'T' });
  });

  it('recusa botões inválidos', async () => {
    const client = new WhatsAppCloudClient({ phoneNumberId: '1', accessToken: 't' });
    await expect(client.sendInteractiveButtons('5511999998888', { body: 'x', buttons: [] })).rejects.toThrow();
    await expect(
      client.sendInteractiveButtons('5511999998888', { body: 'x', buttons: [{ id: '1', title: 'um título longo demais aqui' }] }),
    ).rejects.toThrow(/20 caracteres/);
  });
});

describe('webhook', () => {
  it('verifica assinatura HMAC', () => {
    const raw = '{"object":"whatsapp_business_account"}';
    const sig = `sha256=${createHmac('sha256', 'segredo').update(raw).digest('hex')}`;
    expect(verifyWebhookSignature(raw, sig, 'segredo')).toBe(true);
    expect(verifyWebhookSignature(raw, sig, 'outro')).toBe(false);
    expect(verifyWebhookSignature(raw + ' ', sig, 'segredo')).toBe(false);
    expect(verifyWebhookSignature(raw, undefined, 'segredo')).toBe(false);
    expect(verifyWebhookSignature(raw, 'sha256=xyz', 'segredo')).toBe(false);
  });

  it('responde ao desafio de verificação', () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'tk', 'hub.challenge': '42' };
    expect(handleVerificationChallenge(q, 'tk')).toEqual({ ok: true, challenge: '42' });
    expect(handleVerificationChallenge(q, 'outro')).toEqual({ ok: false });
  });

  it('normaliza respostas de botões, texto e status', () => {
    const events = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                contacts: [{ wa_id: '5511999998888', profile: { name: 'Maria' } }],
                messages: [
                  {
                    from: '5511999998888',
                    id: 'wamid.1',
                    timestamp: '1773300000',
                    type: 'button',
                    button: { payload: 'APPT:CONFIRM:apt_1', text: 'Confirmar' },
                    context: { from: '15550001', id: 'wamid.orig' },
                  },
                  {
                    from: '5511999998888',
                    id: 'wamid.2',
                    timestamp: '1773300001',
                    type: 'interactive',
                    interactive: { type: 'button_reply', button_reply: { id: 'APPT:SLOT:apt_1:slot_9', title: 'qui. 12/03 09:00' } },
                  },
                  { from: '5511999998888', id: 'wamid.3', timestamp: '1773300002', type: 'button', button: { payload: 'ADH:TAKEN:r1' } },
                  { from: '5511999998888', id: 'wamid.4', timestamp: '1773300003', type: 'text', text: { body: 'Obrigada' } },
                  { from: '5511999998888', id: 'wamid.5', timestamp: '1773300004', type: 'image', image: { id: 'm' } },
                ],
                statuses: [{ id: 'wamid.orig', status: 'read', timestamp: '1773300005', recipient_id: '5511999998888' }],
              },
            },
          ],
        },
      ],
    });
    expect(events[0]).toMatchObject({
      type: 'appointment_reply',
      action: 'CONFIRM',
      appointmentId: 'apt_1',
      from: '5511999998888',
      contextMessageId: 'wamid.orig',
      timestamp: new Date(1773300000 * 1000),
    });
    expect(events[1]).toMatchObject({ type: 'appointment_reply', action: 'SLOT', appointmentId: 'apt_1', slotId: 'slot_9' });
    expect(events[2]).toMatchObject({ type: 'button_reply', decoded: { kind: 'ADHERENCE', reminderId: 'r1' } });
    expect(events[3]).toMatchObject({ type: 'text', text: 'Obrigada', profileName: 'Maria' });
    expect(events[4]).toMatchObject({ type: 'unsupported', messageType: 'image' });
    expect(events[5]).toMatchObject({ type: 'status', status: 'read', messageId: 'wamid.orig' });
  });

  it('recusa corpo fora do formato', () => {
    expect(() => parseWebhook({ foo: 1 })).toThrow();
  });
});
