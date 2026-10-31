import type { News2, PrioridadeRegulacao, SinaisVitais, StatusAih, StatusSolicitacaoLeito, Suporte, TipoLeito, TransporteTransferencia } from '@omnisaude/shared';
import type { PatientSummary } from '@/lib/types';

export type Isolation = 'NENHUM' | 'CONTATO' | 'GOTICULAS' | 'AEROSSOIS';

export interface SolicitacaoLeito {
  id: string;
  protocol: string;
  status: StatusSolicitacaoLeito;
  statusLabel: string;
  patient: PatientSummary & { phone: string | null };
  encounterId: string | null;
  originUnit: { id: string; name: string | null };
  requester: { id: string; name: string | null; cbo: string };
  bedKind: TipoLeito;
  bedKindLabel: string;
  specialty: string;
  priority: PrioridadeRegulacao;
  priorityLabel: string;
  requestedPriority: PrioridadeRegulacao;
  cid: string | null;
  clinicalSummary: string;
  vitals: SinaisVitais | null;
  news2: News2 | null;
  support: Suporte;
  isolation: Isolation;
  elective: boolean;
  prazoMeta: string;
  horasEmFila: number;
  atrasada: boolean;
  regulator: { id: string; name: string | null } | null;
  decision: { at: string; reason: string | null } | null;
  secondOpinion: { at: string | null; by: string | null; notes: string | null } | null;
  destination: { unitId: string; unitName: string | null; kind: TipoLeito | null; kindLabel: string | null; bed: { id: string; code: string; ward: string } | null } | null;
  transport: TransporteTransferencia | null;
  transportLabel: string | null;
  transferAt: string | null;
  transferNotes: string | null;
  admissionId: string | null;
  returnedCount: number;
  createdAt: string;
  closedAt: string | null;
  eventos: { id: string; kind: string; fromStatus: string | null; toStatus: string | null; notes: string | null; at: string; usuario: string | null; role: string; roleLabel: string }[];
}

export interface MapaUnidade {
  unit: { id: string; name: string; type: string; cnes: string };
  totals: Record<'VAGO' | 'OCUPADO' | 'HIGIENIZACAO' | 'BLOQUEADO' | 'RESERVADO', number> & { total: number; isolated: number };
  occupancyRate: number;
  porTipo: { tipo: TipoLeito; label: string; total: number; vagos: number; ocupados: number; reservados: number; higienizacao: number; bloqueados: number }[];
  aCaminho: number;
  leitosVagos: { id: string; code: string; ward: string; kind: TipoLeito; isolation: Isolation }[];
}
export interface Mapa {
  unidades: MapaUnidade[];
  totais: { total: number; vagos: number; ocupados: number; reservados: number; bloqueados: number; higienizacao: number; ocupacao: number };
}

export interface Laudo {
  id: string;
  status: StatusAih;
  statusLabel: string;
  patient: PatientSummary;
  unit: { id: string; name: string | null; cnes: string | null };
  requester: { id: string; name: string | null; cbo: string };
  admission: { id: string; admittedAt: string; dischargedAt: string | null; bed: string | null } | null;
  bedRequest: { id: string; protocol: string; status: string } | null;
  procedureCode: string;
  procedureName: string;
  mainCid: string;
  secondaryCid: string | null;
  associatedCid: string | null;
  specialtyCode: string;
  specialtyLabel: string;
  nature: string;
  natureLabel: string;
  symptoms: string;
  conditions: string;
  diagnostics: string;
  notes: string | null;
  aihNumber: string | null;
  aihType: string;
  aihTypeLabel: string;
  range: { id: string; name: string } | null;
  validUntil: string | null;
  vencida: boolean;
  authorizer: { id: string; name: string | null } | null;
  authorizedAt: string | null;
  decisionNotes: string | null;
  createdAt: string;
}

export interface Faixa {
  id: string;
  name: string;
  unitId: string | null;
  unitName: string | null;
  uf: string;
  year: number;
  aihType: string;
  tipoLabel: string;
  seqStart: number;
  seqEnd: number;
  seqNext: number;
  usados: number;
  restantes: number;
  exemplo: string;
  active: boolean;
}

export const STATUS_LEITO_TONE: Record<StatusSolicitacaoLeito, 'slate' | 'blue' | 'amber' | 'green' | 'violet' | 'red'> = {
  PENDENTE: 'slate',
  EM_ANALISE: 'blue',
  DEVOLVIDA: 'amber',
  AUTORIZADA: 'green',
  EM_TRANSFERENCIA: 'violet',
  INTERNADA: 'green',
  NEGADA: 'red',
  CANCELADA: 'slate',
};
export const PRIORIDADE_LEITO_TONE: Record<PrioridadeRegulacao, 'red' | 'amber' | 'green' | 'blue'> = { VERMELHA: 'red', AMARELA: 'amber', VERDE: 'green', AZUL: 'blue' };
export const STATUS_AIH_TONE: Record<StatusAih, 'slate' | 'green' | 'red'> = { PENDENTE: 'slate', AUTORIZADA: 'green', NEGADA: 'red', CANCELADA: 'slate' };
export const RISCO_NEWS2: Record<News2['risco'], { label: string; tone: 'green' | 'amber' | 'red' }> = {
  BAIXO: { label: 'risco baixo', tone: 'green' },
  BAIXO_MEDIO: { label: 'risco baixo-médio', tone: 'amber' },
  MEDIO: { label: 'risco médio', tone: 'amber' },
  ALTO: { label: 'risco alto', tone: 'red' },
};
export const EVENTO_LEITO: Record<string, string> = {
  CRIADA: 'Solicitação criada',
  ATUALIZADA: 'Solicitação atualizada',
  EM_ANALISE: 'Em análise pelo regulador',
  DEVOLVIDA: 'Devolvida com pendência',
  COMPLEMENTADA: 'Complementada pela origem',
  SEGUNDA_AVALIACAO_PEDIDA: 'Segunda avaliação pedida',
  SEGUNDA_AVALIACAO: 'Segunda avaliação',
  AUTORIZADA: 'Vaga autorizada',
  NEGADA: 'Negada',
  EM_TRANSFERENCIA: 'Paciente em transferência',
  INTERNADA: 'Internado no destino',
  CANCELADA: 'Cancelada',
  MENSAGEM: 'Mensagem',
};
