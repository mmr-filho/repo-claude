import type { PrioridadeRegulacao, StatusSolicitacao, TipoSolicitacao } from '@omnisaude/shared';
import type { PatientSummary } from '@/lib/types';

export interface Solicitacao {
  id: string;
  protocol: string;
  kind: TipoSolicitacao;
  specialty: string;
  procedureCode: string;
  procedureName: string;
  status: StatusSolicitacao;
  statusLabel: string;
  priority: PrioridadeRegulacao;
  priorityLabel: string;
  requestedPriority: PrioridadeRegulacao;
  priorityJustification: string | null;
  clinicalSummary: string;
  criteria: { codigo: string; descricao: string }[];
  cid: string | null;
  protocolIssues: string[];
  patient: PatientSummary & { phone: string | null; whatsappOptIn: boolean };
  encounterId: string | null;
  unit: { id: string; name: string | null };
  requester: { id: string; name: string | null; cbo: string };
  regulator: { id: string; name: string | null } | null;
  providerUnit: { id: string; name: string | null } | null;
  provider: { id: string; name: string; kind: string; kindLabel: string; unitId: string | null } | null;
  quotaId: string | null;
  competencia: string | null;
  scheduledAt: string | null;
  noShowCount: number;
  decisionAt: string | null;
  decisionReason: string | null;
  returnedCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  prazoMeta: string;
  diasEmFila: number | null;
  atrasada: boolean;
  posicao?: number | null;
}

export interface SolicitacaoDetalhe extends Solicitacao {
  eventos: { id: string; kind: string; fromStatus: string | null; toStatus: string | null; notes: string | null; at: string; usuario: string | null; role: string }[];
  anexos: { id: string; documentId: string; label: string | null; kind: string | null; mimeType: string | null; sizeBytes: number | null; createdAt: string | null }[];
  agendamento: { id: string; startsAt: string; endsAt: string; status: string; confirmedAt: string | null; schedule: { id: string; name: string }; unit: { id: string; name: string | null } } | null;
}

export interface Oferta {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  unitId: string | null;
  semCota: boolean;
  disponivel: boolean;
  cotas: { id: string; quantity: number; used: number; available: number; originUnitId: string | null }[];
}

export interface AgendaPrestador {
  id: string;
  name: string;
  cbo: string;
  slotMinutes: number;
  profissional: string | null;
  proximos: { id: string; startsAt: string; endsAt: string }[];
}

export interface Protocolos {
  especialidades: {
    codigo: string;
    nome: string;
    sigtapCode: string;
    criterios: { codigo: string; descricao: string; prioridade: PrioridadeRegulacao }[];
    examesMinimos: { sigtapCode: string; nome: string; obrigatorio: boolean }[];
    manejoNaAps: string[];
    fonte: string;
  }[];
  procedimentos: { codigo: string; nome: string; sigtapCode: string; tipo: 'EXAME' | 'PROCEDIMENTO'; criterios: { codigo: string; descricao: string; prioridade: PrioridadeRegulacao }[]; fonte: string }[];
}

export const PRIORIDADE_TONE: Record<PrioridadeRegulacao, 'red' | 'amber' | 'green' | 'blue'> = { VERMELHA: 'red', AMARELA: 'amber', VERDE: 'green', AZUL: 'blue' };
export const STATUS_TONE: Record<StatusSolicitacao, 'slate' | 'blue' | 'amber' | 'green' | 'red' | 'violet'> = {
  PENDENTE: 'slate',
  EM_ANALISE: 'blue',
  DEVOLVIDA: 'amber',
  AUTORIZADA: 'green',
  AGENDADA: 'violet',
  NEGADA: 'red',
  CANCELADA: 'slate',
  REALIZADA: 'green',
};
export const EVENTO_LABEL: Record<string, string> = {
  CRIADA: 'Solicitação criada',
  EM_ANALISE: 'Em análise pela regulação',
  DEVOLVIDA: 'Devolvida ao solicitante',
  COMPLEMENTADA: 'Complementada pela unidade',
  AUTORIZADA: 'Autorizada',
  NEGADA: 'Negada',
  CANCELADA: 'Cancelada',
  AGENDADA: 'Agendada',
  REALIZADA: 'Realizada',
  MENSAGEM: 'Mensagem',
  REMARCADA: 'Remarcada',
  AGENDAMENTO_CANCELADO: 'Agendamento desmarcado',
  FALTOU: 'Não compareceu',
};
