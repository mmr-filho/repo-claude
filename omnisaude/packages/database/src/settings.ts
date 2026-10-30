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
}

export const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  aiEnabled: false,
  whatsappEnabled: false,
  rndsEnabled: false,
  icpBrasilEnabled: false,
  accrMaxWaitMinutes: {},
  appointmentReminderHours: 48,
  mfaRequiredRoles: [],
};

export function tenantSettings(raw: unknown): TenantSettings {
  const value = raw && typeof raw === 'object' ? (raw as Partial<TenantSettings>) : {};
  return { ...DEFAULT_TENANT_SETTINGS, ...value };
}
