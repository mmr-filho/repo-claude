export type BedStatus = 'VAGO' | 'OCUPADO' | 'HIGIENIZACAO' | 'BLOQUEADO' | 'RESERVADO';
export type Isolation = 'NENHUM' | 'CONTATO' | 'GOTICULAS' | 'AEROSSOIS';

export interface Occupant {
  admissionId: string;
  encounterId: string;
  patientId: string;
  name: string;
  age: number;
  sex: 'M' | 'F';
  mainCid: string;
  admittedAt: string;
  daysAdmitted: number;
  regulationCode: string | null;
}

export interface Reservation {
  requestId: string;
  protocol: string;
  patientId: string;
  name: string;
  age: number;
  sex: 'M' | 'F';
  originUnit: string | null;
  priority: string;
  status: string;
  mainCid: string | null;
  isolation: Isolation;
}

export interface BedView {
  id: string;
  code: string;
  status: BedStatus;
  isolation: Isolation;
  updatedAt: string;
  occupant: Occupant | null;
  reservation: Reservation | null;
}

export interface WardView {
  id: string;
  name: string;
  kind: string;
  beds: BedView[];
}

export interface Census {
  unit: { id: string; name: string };
  totals: Record<BedStatus, number> & { total: number; isolated: number };
  occupancyRate: number;
  wards: WardView[];
}

export const STATUS_STYLE: Record<BedStatus, { label: string; card: string; dot: string }> = {
  VAGO: { label: 'Vago', card: 'border-emerald-300 bg-emerald-50', dot: 'bg-emerald-500' },
  OCUPADO: { label: 'Ocupado', card: 'border-brand-300 bg-brand-50', dot: 'bg-brand-600' },
  HIGIENIZACAO: { label: 'Higienização', card: 'border-amber-300 bg-amber-50', dot: 'bg-amber-500' },
  BLOQUEADO: { label: 'Bloqueado', card: 'border-slate-300 bg-slate-100', dot: 'bg-slate-500' },
  RESERVADO: { label: 'Reservado', card: 'border-violet-300 bg-violet-50', dot: 'bg-violet-600' },
};

export const ISOLATION_LABELS: Record<Isolation, string> = {
  NENHUM: 'Sem isolamento',
  CONTATO: 'Contato',
  GOTICULAS: 'Gotículas',
  AEROSSOIS: 'Aerossóis',
};
