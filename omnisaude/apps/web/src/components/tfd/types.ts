import type { AjudaCustoItem, StatusTfd } from '@omnisaude/shared';
import type { PatientSummary } from '@/lib/types';

export interface Processo {
  id: string;
  protocol: string;
  status: StatusTfd;
  statusLabel: string;
  patient: PatientSummary & { phone: string | null };
  requestId: string | null;
  unit: { id: string; name: string | null };
  requester: { id: string; name: string | null; cbo: string };
  cid: string | null;
  diagnosis: string;
  procedureName: string;
  procedureCode: string | null;
  clinicalSummary: string;
  justification: string;
  urgency: boolean;
  destination: { city: string; uf: string; ibge: string | null; unit: string | null };
  transport: string;
  transportLabel: string;
  companion: { name: string | null; cpf: string | null; relation: string | null } | null;
  accommodation: boolean;
  sentAt: string | null;
  opinion: { at: string; by: string | null; notes: string | null; allowanceApproved: boolean } | null;
  appointment: { at: string; place: string | null; notes: string | null } | null;
  allowance: { itens: (AjudaCustoItem & { tipoLabel: string; total: number })[]; total: number; paidAt: string | null; approved: boolean };
  tripId: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface ProcessoDetalhe extends Processo {
  eventos: { id: string; kind: string; fromStatus: string | null; toStatus: string | null; notes: string | null; at: string; usuario: string | null; role: string }[];
  viagem: {
    id: string;
    date: string;
    departureTime: string;
    destinationCity: string;
    destinationUf: string;
    destinationPlace: string | null;
    status: string;
    statusLabel: string;
    vehicle: { plate: string; model: string };
    driver: { name: string; phone: string | null };
    passageiro: { pickupAddress: string | null; status: string; statusLabel: string } | null;
  } | null;
  solicitacao: { id: string; protocol: string; procedureName: string; status: string } | null;
}

export const STATUS_TFD_TONE: Record<StatusTfd, 'slate' | 'blue' | 'green' | 'red' | 'violet' | 'amber'> = {
  ABERTO: 'slate',
  ENVIADO: 'blue',
  DEFERIDO: 'green',
  INDEFERIDO: 'red',
  AGENDADO: 'violet',
  CONCLUIDO: 'green',
  CANCELADO: 'slate',
};
export const EVENTO_TFD: Record<string, string> = {
  ABERTO: 'Processo aberto (laudo)',
  LAUDO_ATUALIZADO: 'Laudo atualizado',
  ENVIADO: 'Enviado à regional / estado',
  DEFERIDO: 'Parecer: deferido',
  INDEFERIDO: 'Parecer: indeferido',
  AGENDADO: 'Agendado no destino',
  AJUDA_CUSTO: 'Ajuda de custo lançada',
  AJUDA_PAGA: 'Ajuda de custo paga',
  VIAGEM: 'Transporte reservado',
  VIAGEM_CANCELADA: 'Reserva de transporte cancelada',
  CONCLUIDO: 'Concluído',
  CANCELADO: 'Cancelado',
  MENSAGEM: 'Mensagem',
};
