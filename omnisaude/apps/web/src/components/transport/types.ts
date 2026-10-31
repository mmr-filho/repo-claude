import type { StatusPassageiro, StatusViagem, TipoVeiculo } from '@omnisaude/shared';
import type { PatientSummary } from '@/lib/types';

export interface Veiculo {
  id: string;
  plate: string;
  model: string;
  kind: TipoVeiculo;
  kindLabel: string;
  seats: number;
  wheelchair: boolean;
  odometerKm: number;
  nextMaintenanceKm: number | null;
  nextMaintenanceAt: string | null;
  unitId: string | null;
  active: boolean;
  notes: string | null;
  consumoMedioKmL: number | null;
  kmMes: number;
  custoMes: number;
  viagensMes: number;
  ultimaManutencao: string | null;
}
export interface Motorista {
  id: string;
  name: string;
  cpf: string | null;
  phone: string | null;
  cnh: string;
  cnhCategory: string;
  cnhExpiry: string;
  active: boolean;
  cnhVencida: boolean;
  cnhVenceEm30: boolean;
}
export interface Rota {
  id: string;
  name: string;
  destinationCity: string;
  destinationUf: string;
  stops: { nome: string; endereco: string | null; horario: string | null }[];
  weekdays: number[];
  departureTime: string;
  returnTime: string | null;
  vehicleId: string | null;
  active: boolean;
}
export interface Passageiro {
  id: string;
  paciente: PatientSummary & { phone: string | null };
  companionName: string | null;
  pickupAddress: string | null;
  appointmentAt: string | null;
  appointmentPlace: string | null;
  wheelchair: boolean;
  tfdId: string | null;
  requestId: string | null;
  status: StatusPassageiro;
  statusLabel: string;
  notes: string | null;
}
export interface Viagem {
  id: string;
  routeId: string | null;
  route: { id: string; name: string; stops: unknown; returnTime: string | null } | null;
  date: string;
  departureTime: string;
  destinationCity: string;
  destinationUf: string;
  destinationPlace: string | null;
  status: StatusViagem;
  statusLabel: string;
  odometerStart: number | null;
  odometerEnd: number | null;
  km: number | null;
  fuelLiters: number | null;
  fuelCost: number | null;
  notes: string | null;
  vehicle: { id: string; plate: string; model: string; kind: TipoVeiculo; kindLabel: string; seats: number; wheelchair: boolean };
  driver: { id: string; name: string; phone: string | null; cnhVencida: boolean };
  ocupacao: { assentos: number; usados: number; livres: number; cadeirantes: number; lotada: boolean };
  passageiros: Passageiro[];
}
export const STATUS_VIAGEM_TONE: Record<StatusViagem, 'slate' | 'blue' | 'green' | 'red'> = { PLANEJADA: 'slate', EM_ANDAMENTO: 'blue', CONCLUIDA: 'green', CANCELADA: 'red' };
export const STATUS_PASSAGEIRO_TONE: Record<StatusPassageiro, 'slate' | 'green' | 'red' | 'amber'> = { AGENDADO: 'slate', EMBARCOU: 'green', FALTOU: 'red', CANCELADO: 'amber' };
