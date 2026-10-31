import type { PatientSummary } from '@/lib/types';

export interface PatientHousehold {
  id: string;
  addressLine: string | null;
  cep: string | null;
  city: string | null;
  uf: string | null;
  dwellingType: string | null;
  tenure: string | null;
  waterSupply: string | null;
  waterTreatment: string | null;
  sewage: string | null;
  garbage: string | null;
  electricity: boolean | null;
  rooms: number | null;
  microArea: string | null;
  teamId: string | null;
  unitId: string | null;
}

export interface PatientFamily {
  id: string;
  householdId: string;
  recordNumber: string | null;
  incomeBracket: string | null;
  responsible: PatientSummary | null;
  members: (PatientSummary & { kinship: string | null })[];
  household: PatientHousehold | null;
}

export interface PatientDetail extends PatientSummary {
  fatherName: string | null;
  racaCor: string;
  phone: string | null;
  whatsappOptIn: boolean;
  email: string | null;
  rg: string | null;
  rgIssuer: string | null;
  rgUf: string | null;
  nis: string | null;
  birthIbgeCode: string | null;
  education: string | null;
  workSituation: string | null;
  occupationCbo: string | null;
  homeless: boolean;
  bolsaFamilia: boolean;
  kinship: string | null;
  address: { cep: string | null; street: string | null; number: string | null; complement: string | null; district: string | null; city: string | null; uf: string | null; ibgeCode: string | null };
  cadsusSyncedAt: string | null;
  /** Preenchido quando o id consultado foi unificado neste cadastro. */
  redirectedFromId: string | null;
  family: PatientFamily | null;
  allergies: { id: string; substance: string; reaction: string | null; severity: string | null }[];
  conditions: { id: string; system: string; code: string; description: string; lineOfCare: string | null; onsetAt: string | null }[];
}

export interface TimelineEvent {
  at: string;
  type: 'ATENDIMENTO' | 'PRESCRICAO' | 'DISPENSACAO' | 'EXAME' | 'VACINA' | 'AGENDAMENTO';
  id: string;
  unit?: string;
  title: string;
  detail?: Record<string, unknown>;
}

export interface Wristband {
  name: string;
  birthDate: string;
  cns: string | null;
  motherName: string | null;
  allergies: string[];
  code: string;
}
