import type { RiskColor, Role } from '@omnisaude/shared';

/** Preferências institucionais guardadas em tenants.settings (master_auth_db). */
export interface TenantSettings {
  /** Recursos que enviam dados a provedores de IA (OCR, ditado, copiloto com LLM, BI conversacional). */
  aiEnabled: boolean;
  whatsappEnabled: boolean;
  rndsEnabled: boolean;
  /** Conector de assinatura ICP-Brasil, ativado conforme a maturidade do tenant. */
  icpBrasilEnabled: boolean;
  /** Tempos-alvo do ACCR sobrescritos pelo tenant (minutos). */
  accrMaxWaitMinutes: Partial<Record<RiskColor, number>>;
  /** Horas de antecedência da confirmação de consulta por WhatsApp. */
  appointmentReminderHours: number;
  /** Papéis que só podem ser assumidos com verificação em duas etapas ativa (ex.: GESTOR, FATURAMENTO). */
  mfaRequiredRoles: Role[];
  /** Assistente do cidadão no WhatsApp (CID-2): responde mensagens recebidas no número da instituição. */
  assistantEnabled: boolean;
  /** Nome com que o assistente se apresenta. */
  assistantName: string;
  /** Perguntas frequentes da instituição que o assistente usa nas respostas. */
  assistantFaq: { pergunta: string; resposta: string }[];
  /** Vigilância epidemiológica (VIG-1a): parâmetros locais de plantão, sem base normativa federal. */
  vigilancia: VigilanciaSettings;
}

export interface VigilanciaSettings {
  /** Minutos para a vigilância dar ciência de uma notificação imediata antes do escalonamento ao plantão. */
  ackMinutes: number;
  /** Telefones do plantão (WhatsApp) que recebem o alerta sem identificação do paciente. */
  onCallPhones: string[];
  /** Liga o alerta por WhatsApp (exige o modelo "vigilancia_alerta" aprovado na conta). */
  whatsappAlerts: boolean;
}

export const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  aiEnabled: false,
  whatsappEnabled: false,
  rndsEnabled: false,
  icpBrasilEnabled: false,
  accrMaxWaitMinutes: {},
  appointmentReminderHours: 48,
  mfaRequiredRoles: [],
  assistantEnabled: false,
  assistantName: 'Assistente de saúde',
  assistantFaq: [],
  vigilancia: { ackMinutes: 60, onCallPhones: [], whatsappAlerts: false },
};

export function tenantSettings(raw: unknown): TenantSettings {
  const value = raw && typeof raw === 'object' ? (raw as Partial<TenantSettings>) : {};
  return { ...DEFAULT_TENANT_SETTINGS, ...value, vigilancia: { ...DEFAULT_TENANT_SETTINGS.vigilancia, ...(value.vigilancia ?? {}) } };
}
