import { Injectable, Logger } from '@nestjs/common';
import type { TenantClient, TenantInfo } from '@omnisaude/database';
import {
  applyQuietHours,
  buildAdherenceReminderTemplate,
  buildAppointmentConfirmationTemplate,
  buildRegulationUpdateTemplate,
  buildRescheduleOptions,
  handleVerificationChallenge,
  normalizeBrazilPhone,
  parseWebhook,
  planAdherenceReminders,
  planAppointmentReminder,
  verifyWebhookSignature,
  WhatsAppCloudClient,
  type InteractiveButtonsMessage,
  type TemplateMessage,
  type WebhookEvent,
} from '@omnisaude/messaging';
import { TenantsService } from '../../core/database';
import { DomainError } from '../../core/errors';
import { IntegrationConfigService } from './integration-config.service';

/** Contexto mínimo para trabalho fora de uma requisição (jobs, webhooks). */
export interface SystemContext {
  tenant: TenantInfo;
  db: TenantClient;
}

type StoredPayload = { type: 'template'; template: TemplateMessage } | { type: 'interactive'; message: InteractiveButtonsMessage };

export type AppointmentReply = Extract<WebhookEvent, { type: 'appointment_reply' }>;
type ReplyHandler = (sys: SystemContext, reply: AppointmentReply) => Promise<void>;

@Injectable()
export class MessagingService {
  private readonly logger = new Logger('WhatsApp');
  private replyHandler?: ReplyHandler;

  constructor(
    private readonly integrations: IntegrationConfigService,
    private readonly tenants: TenantsService,
  ) {}

  /** A agenda registra aqui o tratamento das respostas (confirmar, cancelar, remarcar). */
  onAppointmentReply(handler: ReplyHandler) {
    this.replyHandler = handler;
  }

  /** Agenda a confirmação ativa (padrão: 48h antes), respeitando a janela de silêncio sanitário. */
  async scheduleAppointmentConfirmation(sys: SystemContext, appointmentId: string, now = new Date()) {
    if (!sys.tenant.settings.whatsappEnabled) return null;
    const appt = await sys.db.appointment.findUniqueOrThrow({ where: { id: appointmentId }, include: { patient: true, schedule: true } });
    const phone = appt.patient.phone ? normalizeBrazilPhone(appt.patient.phone) : null;
    if (!appt.patient.whatsappOptIn || !phone) return null;
    const plan = planAppointmentReminder({ startsAt: appt.startsAt }, now, sys.tenant.timeZone, {
      hoursBefore: sys.tenant.settings.appointmentReminderHours,
    });
    if (!plan) return null;
    const unit = await sys.db.unit.findUniqueOrThrow({ where: { id: appt.unitId } });
    const template = buildAppointmentConfirmationTemplate({
      appointmentId: appt.id,
      patientName: appt.patient.socialName ?? appt.patient.name,
      service: appt.schedule.name,
      unitName: unit.name,
      startsAt: appt.startsAt,
      timeZone: sys.tenant.timeZone,
    });
    await sys.db.messageLog.updateMany({ where: { refId: appt.id, kind: 'CONFIRMACAO_CONSULTA', status: 'AGENDADA' }, data: { status: 'CANCELADA' } });
    return sys.db.messageLog.create({
      data: {
        patientId: appt.patientId,
        phone,
        kind: 'CONFIRMACAO_CONSULTA',
        refId: appt.id,
        scheduledFor: plan.sendAt,
        payload: { type: 'template', template } satisfies StoredPayload as object,
      },
    });
  }

  async cancelScheduled(sys: SystemContext, refId: string) {
    await sys.db.messageLog.updateMany({ where: { refId, status: 'AGENDADA' }, data: { status: 'CANCELADA' } });
  }

  /** Lembretes de adesão sincronizados com a prescrição (ex.: de 8 em 8 horas), sem disparos entre 22h e 6h. */
  async scheduleAdherenceReminders(sys: SystemContext, prescriptionId: string, firstDoseAt = new Date()) {
    if (!sys.tenant.settings.whatsappEnabled) return 0;
    const rx = await sys.db.prescription.findUniqueOrThrow({ where: { id: prescriptionId }, include: { items: true, patient: true } });
    const phone = rx.patient.phone ? normalizeBrazilPhone(rx.patient.phone) : null;
    if (rx.kind !== 'AMBULATORIAL' || !rx.patient.whatsappOptIn || !phone) return 0;
    let count = 0;
    for (const item of rx.items) {
      if (!item.frequencyHours || !item.durationDays) continue;
      const dose = item.dose ? `${item.dose.toString()} ${item.doseUnit ?? ''}`.trim() : undefined;
      const reminders = planAdherenceReminders({
        firstDoseAt,
        intervalHours: item.frequencyHours,
        durationDays: item.durationDays,
        medication: item.description,
        dose,
        timeZone: sys.tenant.timeZone,
      });
      for (const r of reminders) {
        const log = await sys.db.messageLog.create({
          data: { patientId: rx.patientId, phone, kind: 'LEMBRETE_MEDICACAO', refId: item.id, scheduledFor: r.sendAt, payload: {} },
        });
        const template = buildAdherenceReminderTemplate({
          patientName: rx.patient.socialName ?? rx.patient.name,
          medication: r.medication,
          dose: r.dose,
          doseTimes: r.doseTimes,
          sendAt: r.sendAt,
          reminderId: log.id,
          timeZone: sys.tenant.timeZone,
        });
        await sys.db.messageLog.update({ where: { id: log.id }, data: { payload: { type: 'template', template } satisfies StoredPayload as object } });
        count++;
      }
    }
    return count;
  }

  /** Devolutiva da regulação ao cidadão (autorizada, negada, agendada, cancelada), respeitando a janela de silêncio. */
  async scheduleRegulationUpdate(
    sys: SystemContext,
    input: { patientId: string; refId: string; protocol: string; procedureName: string; status: 'AUTORIZADA' | 'NEGADA' | 'DEVOLVIDA' | 'AGENDADA' | 'CANCELADA'; detail?: string | null },
    now = new Date(),
  ) {
    if (!sys.tenant.settings.whatsappEnabled) return null;
    const patient = await sys.db.patient.findUnique({ where: { id: input.patientId }, select: { id: true, name: true, socialName: true, phone: true, whatsappOptIn: true } });
    const phone = patient?.phone ? normalizeBrazilPhone(patient.phone) : null;
    if (!patient || !patient.whatsappOptIn || !phone) return null;
    const template = buildRegulationUpdateTemplate({ patientName: patient.socialName ?? patient.name, procedureName: input.procedureName, protocol: input.protocol, status: input.status, detail: input.detail });
    return sys.db.messageLog.create({
      data: {
        patientId: patient.id,
        phone,
        kind: 'AVISO',
        refId: input.refId,
        scheduledFor: applyQuietHours(now, { timeZone: sys.tenant.timeZone, priority: 'ROTINA' }),
        payload: { type: 'template', template } satisfies StoredPayload as object,
      },
    });
  }

  /** Envia o que já venceu. Rotina: a janela de silêncio é reaplicada no momento do envio. */
  async dispatchDue(sys: SystemContext, now = new Date(), limit = 100): Promise<{ sent: number; failed: number; postponed: number }> {
    const due = await sys.db.messageLog.findMany({ where: { status: 'AGENDADA', scheduledFor: { lte: now } }, orderBy: { scheduledFor: 'asc' }, take: limit });
    const result = { sent: 0, failed: 0, postponed: 0 };
    if (due.length === 0) return result;
    const allowedAt = applyQuietHours(now, { timeZone: sys.tenant.timeZone, priority: 'ROTINA' });
    if (allowedAt.getTime() > now.getTime()) {
      await sys.db.messageLog.updateMany({ where: { id: { in: due.map((d) => d.id) } }, data: { scheduledFor: allowedAt } });
      result.postponed = due.length;
      return result;
    }
    const cfg = await this.integrations.whatsapp(sys.tenant.id);
    if (!cfg) return result;
    const client = new WhatsAppCloudClient({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, baseUrl: cfg.baseUrl, apiVersion: cfg.apiVersion });
    for (const msg of due) {
      const payload = msg.payload as unknown as StoredPayload;
      try {
        const id = payload.type === 'template' ? await client.sendTemplate(msg.phone, payload.template) : await client.sendInteractiveButtons(msg.phone, payload.message);
        await sys.db.messageLog.update({ where: { id: msg.id }, data: { status: 'ENVIADA', sentAt: new Date(), providerMessageId: id } });
        result.sent++;
      } catch (err) {
        await sys.db.messageLog.update({ where: { id: msg.id }, data: { status: 'FALHOU', error: (err as Error).message.slice(0, 500) } });
        result.failed++;
      }
    }
    return result;
  }

  /** Mensagem interativa imediata (resposta a um pedido do paciente, dentro da janela de 24h). */
  async sendInteractiveNow(sys: SystemContext, patientId: string | null, phone: string, message: InteractiveButtonsMessage, refId?: string) {
    const log = await sys.db.messageLog.create({
      data: { patientId, phone, kind: 'REMARCACAO', refId: refId ?? null, scheduledFor: new Date(), payload: { type: 'interactive', message } satisfies StoredPayload as object },
    });
    return this.dispatchOne(sys, log.id);
  }

  private async dispatchOne(sys: SystemContext, id: string) {
    const msg = await sys.db.messageLog.findUniqueOrThrow({ where: { id } });
    const cfg = await this.integrations.whatsapp(sys.tenant.id);
    if (!cfg) return msg;
    const client = new WhatsAppCloudClient({ phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, baseUrl: cfg.baseUrl, apiVersion: cfg.apiVersion });
    const payload = msg.payload as unknown as StoredPayload;
    try {
      const pid = payload.type === 'template' ? await client.sendTemplate(msg.phone, payload.template) : await client.sendInteractiveButtons(msg.phone, payload.message);
      return sys.db.messageLog.update({ where: { id }, data: { status: 'ENVIADA', sentAt: new Date(), providerMessageId: pid } });
    } catch (err) {
      return sys.db.messageLog.update({ where: { id }, data: { status: 'FALHOU', error: (err as Error).message.slice(0, 500) } });
    }
  }

  buildRescheduleMessage(appointmentId: string, slots: { id: string; startsAt: Date }[], unitName: string, timeZone: string) {
    return buildRescheduleOptions({ appointmentId, slots, unitName, timeZone });
  }

  async verifyChallenge(tenantSlug: string, query: Record<string, unknown>) {
    const tenant = await this.tenants.resolve(tenantSlug);
    const cfg = await this.integrations.whatsapp(tenant.id);
    if (!cfg?.verifyToken) throw new DomainError('WEBHOOK_NAO_CONFIGURADO', 'Webhook do WhatsApp não configurado', 404);
    const r = handleVerificationChallenge(query as Record<string, string>, cfg.verifyToken);
    if (!r.ok) throw new DomainError('WEBHOOK_TOKEN', 'Token de verificação inválido', 403);
    return r.challenge;
  }

  /** Webhook do WhatsApp: confere a assinatura, atualiza status de entrega e repassa as respostas dos botões. */
  async handleWebhook(tenantSlug: string, rawBody: Buffer | undefined, signature: string | undefined, body: unknown) {
    const tenant = await this.tenants.resolve(tenantSlug);
    const cfg = await this.integrations.whatsapp(tenant.id);
    if (cfg?.appSecret) {
      if (!rawBody || !verifyWebhookSignature(rawBody, signature ?? '', cfg.appSecret)) {
        throw new DomainError('ASSINATURA_INVALIDA', 'Assinatura do webhook inválida', 401);
      }
    }
    const sys: SystemContext = { tenant, db: await this.tenants.client(tenant.id) };
    let handled = 0;
    for (const event of parseWebhook(body)) {
      if (event.type === 'status') {
        const status = event.status === 'delivered' ? 'ENTREGUE' : event.status === 'read' ? 'LIDA' : event.status === 'failed' ? 'FALHOU' : null;
        if (status) await sys.db.messageLog.updateMany({ where: { providerMessageId: event.messageId }, data: { status } });
        handled++;
      } else if (event.type === 'appointment_reply') {
        await sys.db.messageLog.updateMany({
          where: { refId: event.appointmentId, kind: 'CONFIRMACAO_CONSULTA', status: { in: ['ENVIADA', 'ENTREGUE', 'LIDA'] } },
          data: { response: event.action, respondedAt: event.timestamp },
        });
        if (this.replyHandler) await this.replyHandler(sys, event);
        handled++;
      } else if (event.type === 'button_reply' && event.decoded?.kind === 'ADHERENCE') {
        handled++;
      } else {
        this.logger.debug(`Evento ignorado: ${event.type}`);
      }
    }
    return { handled };
  }
}
