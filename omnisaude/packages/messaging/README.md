# @omnisaude/messaging

Conector da **WhatsApp Business Cloud API** com as regras de envio do OmniSaúde.

## Módulos

| Módulo | O que faz |
|---|---|
| `quiet-hours` | Janela de Silêncio Sanitário: mensagens de **rotina** não saem entre **22h00 e 06h00** (hora local do tenant) e são postergadas para **06h01**. A janela bloqueada é `[22:00, 06:01)`. Só `priority: 'URGENTE'` ignora a janela, e precisa ser informada explicitamente. |
| `planning` | `planAppointmentReminder` (confirmação 48h antes) e `planAdherenceReminders` (lembretes a cada N horas, sincronizados com a prescrição; avisos que caem no mesmo instante, como a dose das 22h e a das 6h, viram uma única mensagem às 06h01). |
| `client` | `WhatsAppCloudClient`: `sendText`, `sendTemplate`, `sendInteractiveButtons`. Devolve o `wamid`; erros da Graph API viram `WhatsAppApiError` (status, code, subcode, fbtraceId). |
| `templates` | Mensagens em português, payloads dos botões (`APPT:CONFIRM:<id>`, `APPT:CANCEL:<id>`, `APPT:RESCHEDULE:<id>`, `APPT:SLOT:<consulta>:<horário>`, `ADH:TAKEN:<id>`) e `TEMPLATE_DEFINITIONS` (textos a submeter para aprovação). |
| `webhook` | `verifyWebhookSignature` (HMAC-SHA256 do corpo cru, comparação em tempo constante), `handleVerificationChallenge` e `parseWebhook` (respostas de botões, textos e status de entrega normalizados). |
| `phone` | `normalizeBrazilPhone`: E.164 sem "+" (`5511999998888`), com validação de DDD. |

## Uso

```ts
import {
  applyQuietHours, buildAppointmentConfirmationTemplate, parseWebhook,
  planAppointmentReminder, verifyWebhookSignature, WhatsAppCloudClient,
} from '@omnisaude/messaging';

const plan = planAppointmentReminder({ startsAt }, new Date(), tenant.timeZone);
if (plan) queue.add('whatsapp', { appointmentId }, { delay: plan.sendAt.getTime() - Date.now() });

// no job:
const client = new WhatsAppCloudClient({ phoneNumberId, accessToken });
await client.sendTemplate(to, buildAppointmentConfirmationTemplate({ appointmentId, patientName, service, unitName, startsAt, timeZone }));

// no webhook (POST): validar com o corpo CRU, antes do JSON.parse
if (!verifyWebhookSignature(rawBody, req.headers['x-hub-signature-256'], appSecret)) return 401;
for (const ev of parseWebhook(JSON.parse(rawBody))) {
  if (ev.type === 'appointment_reply' && ev.action === 'CANCEL') liberarVaga(ev.appointmentId);
}
```

## Limitações e cuidados

- **Templates aprovados:** fora da janela de 24h de atendimento (aberta quando o paciente escreve), mensagens iniciadas pela unidade só podem ser **templates aprovados pela Meta**. Os nomes e textos de `TEMPLATE_DEFINITIONS` precisam ser cadastrados e aprovados no WhatsApp Manager antes do uso; os botões de resposta rápida fazem parte do template.
- Botões interativos (`sendInteractiveButtons`, usados para oferecer horários) só valem **dentro** da janela de 24h.
- A versão da Graph API (`DEFAULT_GRAPH_API_VERSION`) é configurável; acompanhe o calendário de descontinuação da Meta.
- A aplicação da janela de silêncio é responsabilidade de quem agenda o envio (fila); o cliente HTTP não bloqueia nada sozinho.
