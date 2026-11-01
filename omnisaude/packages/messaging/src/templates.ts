import { DEFAULT_TIME_ZONE, localDateString, normalizePersonName } from '@omnisaude/shared';
import type { InteractiveButtonsMessage, TemplateMessage } from './client';

/**
 * Mensagens em português. Fora da janela de 24h de atendimento, mensagens iniciadas pela unidade só podem
 * ser templates aprovados pela Meta: os textos de TEMPLATE_DEFINITIONS são os modelos a submeter.
 */

export type AppointmentAction = 'CONFIRM' | 'CANCEL' | 'RESCHEDULE';
export const APPOINTMENT_ACTIONS: readonly AppointmentAction[] = ['CONFIRM', 'CANCEL', 'RESCHEDULE'];

export type DecodedPayload =
  | { kind: 'APPOINTMENT'; action: AppointmentAction; appointmentId: string }
  | { kind: 'APPOINTMENT_SLOT'; appointmentId: string; slotId: string }
  | { kind: 'ADHERENCE'; action: 'TAKEN'; reminderId: string }
  | { kind: 'ASSISTANT'; action: string; arg: string };

const ID = /^[A-Za-z0-9_-]{1,100}$/;

function checkId(id: string): string {
  if (!ID.test(id)) throw new Error(`Identificador inválido para payload: ${id}`);
  return id;
}

export function encodeAppointmentPayload(action: AppointmentAction, appointmentId: string): string {
  return `APPT:${action}:${checkId(appointmentId)}`;
}

export function encodeSlotPayload(appointmentId: string, slotId: string): string {
  return `APPT:SLOT:${checkId(appointmentId)}:${checkId(slotId)}`;
}

export function encodeAdherencePayload(reminderId: string): string {
  return `ADH:TAKEN:${checkId(reminderId)}`;
}

/** Botões do assistente do cidadão: "ASSIST:<ação>:<argumento>" (ids de agenda e horário separados por "_"). */
export function encodeAssistantPayload(action: string, arg: string): string {
  if (!/^[A-Z_]{1,20}$/.test(action) || !/^[A-Za-z0-9_-]{1,120}$/.test(arg)) throw new Error('Payload do assistente inválido');
  return `ASSIST:${action}:${arg}`;
}

export function decodeButtonPayload(payload: string): DecodedPayload | null {
  const parts = payload.split(':');
  if (parts[0] === 'ASSIST' && parts.length === 3 && /^[A-Z_]{1,20}$/.test(parts[1]!) && /^[A-Za-z0-9_-]{1,120}$/.test(parts[2]!)) {
    return { kind: 'ASSISTANT', action: parts[1]!, arg: parts[2]! };
  }
  if (parts[0] === 'APPT' && parts.length === 3 && (APPOINTMENT_ACTIONS as string[]).includes(parts[1]!) && ID.test(parts[2]!)) {
    return { kind: 'APPOINTMENT', action: parts[1] as AppointmentAction, appointmentId: parts[2]! };
  }
  if (parts[0] === 'APPT' && parts[1] === 'SLOT' && parts.length === 4 && ID.test(parts[2]!) && ID.test(parts[3]!)) {
    return { kind: 'APPOINTMENT_SLOT', appointmentId: parts[2]!, slotId: parts[3]! };
  }
  if (parts[0] === 'ADH' && parts[1] === 'TAKEN' && parts.length === 3 && ID.test(parts[2]!)) {
    return { kind: 'ADHERENCE', action: 'TAKEN', reminderId: parts[2]! };
  }
  return null;
}

/** Parâmetros de template não aceitam quebras de linha, tabulações nem sequências longas de espaços. */
export function sanitizeTemplateParam(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 1024);
}

export function firstName(fullName: string): string {
  return normalizePersonName(fullName).split(' ')[0] ?? '';
}

function fmt(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone, ...options }).format(date);
}

export function formatTime(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  return fmt(date, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** "quinta-feira, 12/03" */
export function formatDayLong(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  return `${fmt(date, timeZone, { weekday: 'long' })}, ${fmt(date, timeZone, { day: '2-digit', month: '2-digit' })}`;
}

/** "qui. 12/03 14:30" (cabe nos 20 caracteres de um botão) */
export function formatSlotShort(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  return `${fmt(date, timeZone, { weekday: 'short' })} ${fmt(date, timeZone, { day: '2-digit', month: '2-digit' })} ${formatTime(date, timeZone)}`;
}

export const TEMPLATE_DEFINITIONS = [
  {
    name: 'confirmacao_consulta',
    category: 'UTILITY',
    language: 'pt_BR',
    body: 'Olá, {{1}}! Lembramos da sua consulta de {{2}} na {{3}}, às {{4}}, na unidade {{5}}. ' + 'Você confirma a presença? Se não puder ir, cancele ou remarque para liberarmos a vaga para outra pessoa.',
    buttons: ['Confirmar', 'Cancelar', 'Remarcar'],
  },
  {
    name: 'lembrete_medicacao',
    category: 'UTILITY',
    language: 'pt_BR',
    body: 'Olá, {{1}}! Lembrete do seu remédio: {{2}}. Horário da dose: {{3}}. ' + 'Siga a orientação da receita e, em caso de dúvida, procure sua unidade de saúde.',
    buttons: ['Já tomei'],
  },
  {
    name: 'codigo_acesso',
    category: 'AUTHENTICATION',
    language: 'pt_BR',
    body: 'Olá, {{1}}! Seu código de acesso ao app da saúde é {{2}}. Ele vale por {{3}} minutos. Não compartilhe este código com ninguém.',
    buttons: [],
  },
  {
    name: 'regulacao_atualizacao',
    category: 'UTILITY',
    language: 'pt_BR',
    body: 'Olá, {{1}}! Sobre o seu pedido de {{2}} (protocolo {{3}}): {{4}}. {{5}} Em caso de dúvida, procure a sua unidade de saúde.',
    buttons: [],
  },
  {
    name: 'ouvidoria_resposta',
    category: 'UTILITY',
    language: 'pt_BR',
    body: 'Olá, {{1}}! Sua manifestação {{2}} na ouvidoria foi {{3}}. {{4}} A resposta completa está no app do cidadão e na unidade de saúde.',
    buttons: [],
  },
  {
    name: 'vigilancia_alerta',
    category: 'UTILITY',
    language: 'pt_BR',
    body: 'Alerta da vigilância epidemiológica: a notificação {{1}} ({{2}}), da unidade {{3}}, aguarda ciência. Prazo legal até {{4}}. Abra o painel da vigilância no OmniSaúde.',
    buttons: [],
  },
  {
    name: 'pesquisa_satisfacao',
    category: 'UTILITY',
    language: 'pt_BR',
    body: 'Olá, {{1}}! Como foi o seu atendimento de {{2}} na {{3}}? Sua opinião ajuda a melhorar o serviço e leva menos de um minuto.',
    buttons: ['Ótimo', 'Regular', 'Ruim'],
  },
] as const;

export interface AppointmentConfirmationInput {
  appointmentId: string;
  patientName: string;
  /** Especialidade ou tipo de atendimento ("Clínica Médica", "Odontologia"). */
  service: string;
  unitName: string;
  startsAt: Date;
  timeZone?: string;
  templateName?: string;
  languageCode?: string;
}

export function buildAppointmentConfirmationTemplate(input: AppointmentConfirmationInput): TemplateMessage {
  const tz = input.timeZone ?? DEFAULT_TIME_ZONE;
  return {
    name: input.templateName ?? 'confirmacao_consulta',
    languageCode: input.languageCode ?? 'pt_BR',
    bodyParams: [firstName(input.patientName), input.service, formatDayLong(input.startsAt, tz), formatTime(input.startsAt, tz), input.unitName].map(sanitizeTemplateParam),
    buttons: APPOINTMENT_ACTIONS.map((action, index) => ({
      subType: 'quick_reply' as const,
      index,
      payload: encodeAppointmentPayload(action, input.appointmentId),
    })),
  };
}

export interface AdherenceReminderInput {
  patientName: string;
  medication: string;
  dose?: string;
  doseTimes: Date[];
  /** Momento do envio; doses de outro dia aparecem com a data ("22:00 de 12/03"). */
  sendAt?: Date;
  reminderId?: string;
  timeZone?: string;
  templateName?: string;
  languageCode?: string;
}

export function describeDoseTimes(doseTimes: Date[], reference: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const refDay = localDateString(reference, timeZone);
  const labels = doseTimes.map((d) => (localDateString(d, timeZone) === refDay ? formatTime(d, timeZone) : `${formatTime(d, timeZone)} de ${fmt(d, timeZone, { day: '2-digit', month: '2-digit' })}`));
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} e ${labels.at(-1)}`;
}

export function buildAdherenceReminderTemplate(input: AdherenceReminderInput): TemplateMessage {
  const tz = input.timeZone ?? DEFAULT_TIME_ZONE;
  if (input.doseTimes.length === 0) throw new Error('Lembrete sem horário de dose');
  const reference = input.sendAt ?? input.doseTimes.at(-1)!;
  return {
    name: input.templateName ?? 'lembrete_medicacao',
    languageCode: input.languageCode ?? 'pt_BR',
    bodyParams: [firstName(input.patientName), input.dose ? `${input.medication} (${input.dose})` : input.medication, describeDoseTimes(input.doseTimes, reference, tz)].map(sanitizeTemplateParam),
    buttons: input.reminderId ? [{ subType: 'quick_reply', index: 0, payload: encodeAdherencePayload(input.reminderId) }] : [],
  };
}

export interface RescheduleOptionsInput {
  appointmentId: string;
  slots: { id: string; startsAt: Date }[];
  unitName?: string;
  timeZone?: string;
}

/** Até três horários livres como botões; vale dentro da janela de 24h aberta pela resposta do paciente. */
export function buildRescheduleOptions(input: RescheduleOptionsInput): InteractiveButtonsMessage {
  const tz = input.timeZone ?? DEFAULT_TIME_ZONE;
  const slots = input.slots.slice(0, 3);
  if (slots.length === 0) throw new Error('Nenhum horário disponível para oferecer');
  return {
    header: 'Remarcar consulta',
    body: input.unitName ? `Escolha um novo horário na unidade ${input.unitName}:` : 'Escolha um novo horário para a sua consulta:',
    footer: 'Se nenhum servir, responda esta mensagem.',
    buttons: slots.map((s) => ({ id: encodeSlotPayload(input.appointmentId, s.id), title: formatSlotShort(s.startsAt, tz) })),
  };
}

// ─── Regulação: devolutiva ao cidadão ───────────────────────────────────────

export type RegulationUpdateStatus = 'AUTORIZADA' | 'NEGADA' | 'DEVOLVIDA' | 'AGENDADA' | 'CANCELADA';

export interface RegulationUpdateInput {
  patientName: string;
  /** Nome do que foi pedido ("consulta com cardiologia", "mamografia"). */
  procedureName: string;
  protocol: string;
  status: RegulationUpdateStatus;
  /** Complemento (unidade autorizada, data agendada, orientação). */
  detail?: string | null;
  templateName?: string;
  languageCode?: string;
}

const REGULATION_STATUS_TEXT: Record<RegulationUpdateStatus, string> = {
  AUTORIZADA: 'foi autorizado pela regulação',
  NEGADA: 'não foi autorizado pela regulação',
  DEVOLVIDA: 'precisa de complementação pela sua unidade de saúde',
  AGENDADA: 'foi agendado',
  CANCELADA: 'foi cancelado',
};

/** Mensagem de devolutiva da regulação (modelo "regulacao_atualizacao", categoria UTILITY, sem botões). */
export function buildRegulationUpdateTemplate(input: RegulationUpdateInput): TemplateMessage {
  return {
    name: input.templateName ?? 'regulacao_atualizacao',
    languageCode: input.languageCode ?? 'pt_BR',
    bodyParams: [firstName(input.patientName), input.procedureName, input.protocol, REGULATION_STATUS_TEXT[input.status], (input.detail ?? '').trim() || 'Acompanhe pela unidade.'].map(sanitizeTemplateParam),
    buttons: [],
  };
}

export interface AccessCodeInput {
  patientName: string;
  code: string;
  validMinutes: number;
  templateName?: string;
  languageCode?: string;
}

/** Código de acesso do cidadão ao app (modelo "codigo_acesso", categoria AUTHENTICATION, sem botões). */
export function buildAccessCodeTemplate(input: AccessCodeInput): TemplateMessage {
  return {
    name: input.templateName ?? 'codigo_acesso',
    languageCode: input.languageCode ?? 'pt_BR',
    bodyParams: [firstName(input.patientName), input.code, String(input.validMinutes)].map(sanitizeTemplateParam),
    buttons: [],
  };
}

export interface OmbudsmanUpdateInput {
  patientName: string;
  protocol: string;
  /** "respondida" ou "prorrogada". */
  status: 'RESPONDIDA' | 'PRORROGADA';
  detail?: string | null;
  templateName?: string;
  languageCode?: string;
}

/** Retorno da ouvidoria ao cidadão (modelo "ouvidoria_resposta", categoria UTILITY, sem botões). */
export function buildOmbudsmanUpdateTemplate(input: OmbudsmanUpdateInput): TemplateMessage {
  const status = input.status === 'RESPONDIDA' ? 'respondida' : 'prorrogada por mais 30 dias, com justificativa';
  return {
    name: input.templateName ?? 'ouvidoria_resposta',
    languageCode: input.languageCode ?? 'pt_BR',
    bodyParams: [firstName(input.patientName), input.protocol, status, (input.detail ?? '').trim() || 'Obrigado por nos ajudar a melhorar.'].map(sanitizeTemplateParam),
    buttons: [],
  };
}

export interface SatisfactionSurveyInput {
  surveyId: string;
  patientName: string;
  service: string;
  unitName: string;
  templateName?: string;
  languageCode?: string;
}

/** Notas dos três botões da pesquisa (Ótimo, Regular, Ruim) na escala de 1 a 5 (5 = Ótimo, 3 = Regular, 2 = Ruim). */
export const SURVEY_BUTTON_SCORES = [5, 3, 2] as const;

/** Pesquisa de satisfação após o atendimento (modelo "pesquisa_satisfacao", botões de resposta rápida tratados pelo assistente). */
export function buildSatisfactionSurveyTemplate(input: SatisfactionSurveyInput): TemplateMessage {
  return {
    name: input.templateName ?? 'pesquisa_satisfacao',
    languageCode: input.languageCode ?? 'pt_BR',
    bodyParams: [firstName(input.patientName), input.service, input.unitName].map(sanitizeTemplateParam),
    buttons: SURVEY_BUTTON_SCORES.map((score, index) => ({ subType: 'quick_reply' as const, index, payload: encodeAssistantPayload('SURVEY', `${input.surveyId}_${score}`) })),
  };
}

export interface SurveillanceAlertInput {
  number: string;
  /** Nome do agravo ou "agravo de acesso restrito" (nunca dado do paciente). */
  condition: string;
  unitName: string;
  dueAt: Date | null;
  timeZone?: string;
  templateName?: string;
  languageCode?: string;
}

/** Alerta ao plantão da vigilância (modelo "vigilancia_alerta"): sem nome, CPF, CNS ou endereço do paciente. */
export function buildSurveillanceAlertTemplate(input: SurveillanceAlertInput): TemplateMessage {
  const tz = input.timeZone ?? DEFAULT_TIME_ZONE;
  const prazo = input.dueAt ? `${formatDayLong(input.dueAt, tz)}, ${formatTime(input.dueAt, tz)}` : 'a definir';
  return {
    name: input.templateName ?? 'vigilancia_alerta',
    languageCode: input.languageCode ?? 'pt_BR',
    bodyParams: [input.number, input.condition, input.unitName, prazo].map(sanitizeTemplateParam),
    buttons: [],
  };
}
