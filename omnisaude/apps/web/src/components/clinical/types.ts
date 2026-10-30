import type { AlertSeverity, RiskColor } from '@omnisaude/shared';

export interface CodeRef {
  system: 'CID10' | 'CIAP2';
  code: string;
}

export interface ClinicalNote {
  id: string;
  kind: 'SOAP' | 'EVOLUCAO' | 'ODONTOGRAMA' | 'LAUDO_INTERNACAO' | 'ATESTADO' | 'SUMARIO_ALTA';
  status: 'RASCUNHO' | 'ASSINADO';
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  codes: string[];
  data: Record<string, unknown>;
  authorId: string;
  authorName: string | null;
  role: string;
  cbo: string;
  signedAt: string | null;
  auditHash: string | null;
  createdAt: string;
}

export interface PrescriptionItem {
  id: string;
  productId: string | null;
  description: string;
  activeIngredient: string | null;
  dose: string | number | null;
  doseUnit: string | null;
  route: string | null;
  frequencyHours: number | null;
  durationDays: number | null;
  quantity: string | number | null;
  instructions: string | null;
  suspendedAt: string | null;
}

export interface Prescription {
  id: string;
  kind: 'AMBULATORIAL' | 'HOSPITALAR';
  status: string;
  signedAt: string;
  justification: string | null;
  alerts: ClinicalAlert[];
  auditHash: string | null;
  items: PrescriptionItem[];
}

export interface ExamRequest {
  id: string;
  sigtapCode: string;
  name: string;
  status: 'SOLICITADO' | 'COLETADO' | 'RESULTADO' | 'CANCELADO';
  resultValue: string | number | null;
  resultUnit: string | null;
  resultText: string | null;
  requestedAt: string;
  resultAt: string | null;
}

export interface Triage {
  id: string;
  riskColor: RiskColor;
  complaint: string;
  systolic: number | null;
  diastolic: number | null;
  heartRate: number | null;
  respiratoryRate: number | null;
  temperature: string | number | null;
  spo2: number | null;
  glucose: number | null;
  weightKg: string | number | null;
  painScore: number | null;
  classifiedAt: string;
}

export interface EncounterDetail {
  id: string;
  unitId: string;
  patientId: string;
  kind: 'AMBULATORIAL' | 'URGENCIA' | 'INTERNACAO' | 'DOMICILIAR' | 'ODONTOLOGICO';
  status: 'ABERTO' | 'TRIADO' | 'EM_ATENDIMENTO' | 'ENCERRADO' | 'CANCELADO' | 'EVADIU';
  mainCid: string | null;
  outcome: string | null;
  startedAt: string;
  endedAt: string | null;
  responsibleId: string | null;
  unit: { name: string; type: string; cnes: string };
  patient: {
    id: string;
    name: string;
    socialName: string | null;
    cns: string | null;
    cpf: string | null;
    birthDate: string;
    sex: 'M' | 'F';
    age: number;
    allergies: { id: string; substance: string; reaction: string | null }[];
    conditions: { id: string; system: string; code: string; description: string; lineOfCare: string | null }[];
  };
  triages: Triage[];
  notes: ClinicalNote[];
  prescriptions: Prescription[];
  examRequests: ExamRequest[];
  admission: { id: string; bedId: string | null; admittedAt: string } | null;
}

export interface ClinicalAlert {
  severity: AlertSeverity;
  code: string;
  ruleId: string;
  title: string;
  detail: string;
  recommendation: string;
  involves: string[];
}

export interface PrescriptionAnalysis {
  alerts: ClinicalAlert[];
  requiresJustification: boolean;
  egfr?: { value: number; source: string; collectedAt: string };
  potassium?: number;
  knowledgeBaseVersion?: string;
}

export interface ItemDraft {
  key: number;
  productId?: string;
  description: string;
  activeIngredient: string;
  dose: string;
  doseUnit: string;
  route: string;
  frequencyHours: string;
  durationDays: string;
  quantity: string;
  instructions: string;
}

export type VoiceCommand =
  | { intent: 'CHAMAR_PACIENTE'; args: { name?: string; ticket?: string }; raw: string }
  | { intent: 'CHAMAR_PROXIMO'; args: Record<string, never>; raw: string }
  | { intent: 'PRESCREVER'; args: { drug: string; dose?: number; unit?: string; intervalHours?: number; timesPerDay?: number; durationDays?: number; route?: string }; raw: string }
  | { intent: 'EMITIR_ATESTADO'; args: { days?: number; type: 'AFASTAMENTO' | 'COMPARECIMENTO' }; raw: string }
  | { intent: 'SOLICITAR_EXAME'; args: { exams: string[] }; raw: string }
  | { intent: 'ABRIR_PRONTUARIO'; args: { name?: string }; raw: string }
  | { intent: 'ENCERRAR_ATENDIMENTO'; args: Record<string, never>; raw: string }
  | { intent: 'DESCONHECIDO'; args: Record<string, never>; raw: string };

export function parseStoredCode(c: string): CodeRef {
  const [system, code] = c.includes(':') ? c.split(':', 2) : ['CID10', c];
  return { system: system === 'CIAP2' ? 'CIAP2' : 'CID10', code: code! };
}
