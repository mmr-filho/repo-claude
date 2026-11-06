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
  /** Território (PLT-3): regras locais do reconhecimento geográfico e do bloqueio de transmissão. */
  territorio: TerritorioSettings;
  /** Endemias (VIG-3a): ordem de bloqueio de transmissão aberta pelas notificações. */
  endemias: EndemiasSettings;
}

export interface EndemiasSettings {
  /**
   * Abre (ou amplia) a ordem de bloqueio a cada notificação de dengue, chikungunya ou Zika. Em epidemia, com a
   * transmissão espalhada, a coordenação desliga e passa a agir por área (Diretrizes de 2025, cap. 9).
   */
  bloqueioAutomatico: boolean;
  /** Casos da mesma área com até estes dias de diferença entram na mesma ordem (Diretrizes de 2025, p. 52: sete dias). */
  janelaAgrupamentoDias: number;
  /** Grupos de agravo que abrem a ordem (catálogo da Lista Nacional). */
  gruposBloqueio: string[];
  /** Dias sem início em campo para a ordem aparecer como atrasada (parâmetro local: o Ministério pede "o mais rápido possível"). */
  alertaSemInicioDias: number;
}

export interface TerritorioSettings {
  /** Numeração dos quarteirões: única na localidade ou reiniciada em cada bairro (PNCD 2001 faculta as duas). */
  numeracaoQuarteirao: 'LOCALIDADE' | 'BAIRRO';
  /** Raio do bloqueio de transmissão em metros (Diretrizes: no mínimo 150 m; a SES pode adotar outro). */
  raioBloqueioM: number;
}

export interface VigilanciaSettings {
  /** Minutos para a vigilância dar ciência de uma notificação imediata antes do escalonamento ao plantão. */
  ackMinutes: number;
  /** Telefones do plantão (WhatsApp) que recebem o alerta sem identificação do paciente. */
  onCallPhones: string[];
  /** Liga o alerta por WhatsApp (exige o modelo "vigilancia_alerta" aprovado na conta). */
  whatsappAlerts: boolean;
  /** Envia à RNDS o resultado de exame de covid-19 e mpox (REL); desligado se a rede não faz esses testes. */
  relEnabled: boolean;
  /** Prazo de encerramento em dias por grupo de agravo (sem padrão: só aparece o que a vigilância definir). */
  prazosEncerramento: Record<string, number>;
  /** Modelo da comunicação à autoridade policial (nulo = modelo padrão do sistema). */
  modeloPolicial: string | null;
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
  vigilancia: { ackMinutes: 60, onCallPhones: [], whatsappAlerts: false, relEnabled: false, prazosEncerramento: {}, modeloPolicial: null },
  territorio: { numeracaoQuarteirao: 'LOCALIDADE', raioBloqueioM: 150 },
  endemias: { bloqueioAutomatico: true, janelaAgrupamentoDias: 7, gruposBloqueio: ['dengue', 'chikungunya', 'zika'], alertaSemInicioDias: 3 },
};

export function tenantSettings(raw: unknown): TenantSettings {
  const value = raw && typeof raw === 'object' ? (raw as Partial<TenantSettings>) : {};
  return {
    ...DEFAULT_TENANT_SETTINGS,
    ...value,
    vigilancia: { ...DEFAULT_TENANT_SETTINGS.vigilancia, ...(value.vigilancia ?? {}) },
    territorio: { ...DEFAULT_TENANT_SETTINGS.territorio, ...(value.territorio ?? {}) },
    endemias: { ...DEFAULT_TENANT_SETTINGS.endemias, ...(value.endemias ?? {}) },
  };
}
