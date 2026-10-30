import type { PatientSummary } from '@/lib/types';

export interface PatientDetail extends PatientSummary {
  fatherName: string | null;
  racaCor: string;
  phone: string | null;
  whatsappOptIn: boolean;
  email: string | null;
  address: { cep: string | null; street: string | null; number: string | null; complement: string | null; district: string | null; ibgeCode: string | null };
  cadsusSyncedAt: string | null;
  allergies: { id: string; substance: string; reaction: string | null; severity: string | null }[];
  conditions: { id: string; system: string; code: string; description: string; lineOfCare: string | null }[];
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
