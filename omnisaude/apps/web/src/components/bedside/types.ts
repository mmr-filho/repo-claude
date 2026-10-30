export interface ScheduleItem {
  prescriptionId: string;
  prescriptionItemId: string;
  description: string;
  productId: string | null;
  dose: number | null;
  doseUnit: string | null;
  route: string | null;
  frequencyHours: number | null;
  dueNow: boolean;
  dueAt: string | null;
  nextTimes: string[];
  lastAdministeredAt: string | null;
  requiredPops: string[];
  availableUnitDoses: number;
}

export interface Schedule {
  patientId: string;
  now: string;
  toleranceMinutes: number;
  items: ScheduleItem[];
}

export interface Check {
  check: 'PACIENTE' | 'PRESCRICAO' | 'MEDICAMENTO' | 'VIA' | 'DOSE' | 'HORARIO' | 'POP';
  ok: boolean;
  detail: string;
}

export interface AdministrationResult {
  status: 'ADMINISTRADO' | 'BLOQUEADO';
  administrationId: string;
  scheduledFor?: string | null;
  checks: Check[];
  sound: 'APROVADO' | 'BLOQUEIO';
}

export const CHECK_LABELS: Record<Check['check'], string> = {
  PACIENTE: 'Paciente certo',
  PRESCRICAO: 'Prescrição ativa',
  MEDICAMENTO: 'Medicamento certo',
  VIA: 'Via certa',
  DOSE: 'Dose certa',
  HORARIO: 'Horário certo',
  POP: 'Procedimento obrigatório (POP)',
};
