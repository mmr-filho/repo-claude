export const LINES = ['HIPERTENSAO', 'DIABETES', 'GESTANTE', 'ONCOLOGIA', 'SAUDE_MENTAL', 'TUBERCULOSE', 'HANSENIASE', 'CRIANCA', 'IDOSO', 'MULHER', 'BOLSA_FAMILIA', 'SISVAN'] as const;
export type LineOfCare = (typeof LINES)[number];

export const LINE_LABELS: Record<LineOfCare, string> = {
  HIPERTENSAO: 'Hipertensão',
  DIABETES: 'Diabetes',
  GESTANTE: 'Gestantes',
  ONCOLOGIA: 'Oncologia',
  SAUDE_MENTAL: 'Saúde mental',
  TUBERCULOSE: 'Tuberculose',
  HANSENIASE: 'Hanseníase',
  CRIANCA: 'Criança (puericultura)',
  IDOSO: 'Pessoa idosa',
  MULHER: 'Saúde da mulher',
  BOLSA_FAMILIA: 'Bolsa Família',
  SISVAN: 'SISVAN',
};

export const CHANNELS = { TELEFONE: 'Telefone', WHATSAPP: 'WhatsApp', VISITA_DOMICILIAR: 'Visita domiciliar', ACS: 'Agente comunitário (ACS)' } as const;
export const VULNERABILITIES = {
  TRANSPORTE: 'Transporte',
  ABANDONO: 'Abandono do tratamento',
  BARREIRA_SOCIAL: 'Barreira social',
  FINANCEIRA: 'Financeira',
  MOBILIDADE: 'Mobilidade reduzida',
  OUTRA: 'Outra',
} as const;
export const ACTIONS = {
  TRANSPORTE_SANITARIO: 'Transporte sanitário agendado',
  VISITA_DOMICILIAR: 'Visita domiciliar agendada',
  CONSULTA_AGENDADA: 'Consulta agendada',
  ENCAMINHAMENTO_CRAS: 'Encaminhamento ao CRAS',
} as const;

export const CASE_STATUS: Record<string, { label: string; tone: 'slate' | 'blue' | 'green' | 'amber' }> = {
  ABERTO: { label: 'Aberto', tone: 'amber' },
  EM_CONTATO: { label: 'Em contato', tone: 'blue' },
  AGENDADO: { label: 'Retorno agendado', tone: 'green' },
  ENCERRADO: { label: 'Encerrado', tone: 'slate' },
};

export interface PanelItem {
  patientId: string;
  name: string;
  age: number;
  cns: string | null;
  phone: string | null;
  whatsappOptIn: boolean;
  district: string | null;
  lineOfCare: LineOfCare;
  condition: { code: string; description: string };
  lastVisitAt: string | null;
  daysSinceLastVisit: number | null;
  thresholdDays: number;
  daysOverdue: number | null;
  missedAppointments: number;
  lastMissedAt: string | null;
  reasons: string[];
  case: { id: string; status: string; assignedTo: string | null; openedAt: string } | null;
}

export interface CaseDetail {
  id: string;
  status: string;
  lineOfCare: LineOfCare;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  lastVisitAt: string | null;
  assignedToName: string | null;
  patient: { id: string; name: string; cns: string | null; phone: string | null; whatsappOptIn: boolean; district: string | null; age: number };
  contacts: { id: string; channel: keyof typeof CHANNELS; outcome: string; vulnerabilities: (keyof typeof VULNERABILITIES)[]; actions: (keyof typeof ACTIONS)[]; notes: string | null; at: string; userName: string | null }[];
}
