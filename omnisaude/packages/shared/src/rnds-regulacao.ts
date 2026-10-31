import type { StatusSolicitacaoLeito } from './leitos';
import type { PrioridadeRegulacao, StatusSolicitacao } from './regulacao';

/**
 * Registro de Regulação Assistencial (RIRA) da RNDS, Portaria GM/MS 6.656/2025 e Modelo de Informação da
 * Regulação Assistencial (MIRA, Portaria Conjunta SAES/SEIDIGI 3/2023). Mapeia as situações do OmniSaúde
 * para os códigos do guia oficial (br.gov.saude.rira.fhir 1.0.0-release).
 */

/** BRStatusRegulacaoAssistencial: situação da solicitação no MIRA. */
export type StatusMira = 'pending' | 'returned-to-requester' | 'booked' | 'attended' | 'cancelled' | 'absence' | 'excluded';
export const STATUS_MIRA: Record<StatusMira, string> = {
  pending: 'Pendente',
  'returned-to-requester': 'Devolvida ao solicitante',
  booked: 'Agendada',
  attended: 'Atendida / internada',
  cancelled: 'Negada / cancelada',
  absence: 'Falta',
  excluded: 'Excluída',
};

/** BRModalidadeAssistencialMIRA: 04 atenção hospitalar (leitos) e 09 assistência ambulatorial. */
export type ModalidadeMira = '04' | '09';
export const MODALIDADE_MIRA: Record<ModalidadeMira, string> = { '04': 'Atenção hospitalar', '09': 'Assistência ambulatorial' };

/** BRCaraterAtendimentoMIRA (request-priority): rotina ou urgência. */
export type CaraterMira = 'routine' | 'urgent';

export type FonteRegulacao = 'AMBULATORIAL' | 'LEITO';

/** Estados FHIR exigidos pelas invariantes mira-13 a mira-19 para cada situação do MIRA. */
export interface EstadoMira {
  status: StatusMira;
  serviceRequest: 'active' | 'on-hold' | 'revoked' | 'completed';
  appointment: 'proposed' | 'waitlist' | 'booked' | 'fulfilled' | 'cancelled' | 'noshow';
  /** Exige executante (ServiceRequest.performer) e data de agendamento (Appointment.start/end). */
  exigeExecutante: boolean;
  /** Exige data de execução (ServiceRequest.occurrenceDateTime). */
  exigeExecucao: boolean;
  /** Pendente não pode levar executante, agendamento nem execução (mira-2 a mira-4). */
  proibeExecutante: boolean;
}

const ESTADOS: Record<StatusMira, EstadoMira> = {
  pending: { status: 'pending', serviceRequest: 'active', appointment: 'proposed', exigeExecutante: false, exigeExecucao: false, proibeExecutante: true },
  'returned-to-requester': { status: 'returned-to-requester', serviceRequest: 'on-hold', appointment: 'waitlist', exigeExecutante: false, exigeExecucao: false, proibeExecutante: false },
  booked: { status: 'booked', serviceRequest: 'active', appointment: 'booked', exigeExecutante: true, exigeExecucao: false, proibeExecutante: false },
  attended: { status: 'attended', serviceRequest: 'completed', appointment: 'fulfilled', exigeExecutante: true, exigeExecucao: true, proibeExecutante: false },
  cancelled: { status: 'cancelled', serviceRequest: 'revoked', appointment: 'cancelled', exigeExecutante: false, exigeExecucao: false, proibeExecutante: false },
  absence: { status: 'absence', serviceRequest: 'completed', appointment: 'noshow', exigeExecutante: true, exigeExecucao: true, proibeExecutante: false },
  excluded: { status: 'excluded', serviceRequest: 'revoked', appointment: 'cancelled', exigeExecutante: false, exigeExecucao: false, proibeExecutante: false },
};

export function estadoMira(status: StatusMira): EstadoMira {
  return ESTADOS[status];
}

/**
 * Situação da solicitação ambulatorial no MIRA. Autorizada sem agendamento continua "pendente" para a RNDS
 * (o MIRA não tem "autorizada"); a falta é registrada quando o evento da transição é FALTOU.
 */
export function statusMiraAmbulatorial(status: StatusSolicitacao, evento?: string | null): StatusMira {
  if (evento === 'FALTOU') return 'absence';
  switch (status) {
    case 'PENDENTE':
    case 'EM_ANALISE':
    case 'AUTORIZADA':
      return 'pending';
    case 'DEVOLVIDA':
      return 'returned-to-requester';
    case 'AGENDADA':
      return 'booked';
    case 'REALIZADA':
      return 'attended';
    case 'NEGADA':
    case 'CANCELADA':
      return 'cancelled';
  }
}

/** Situação da solicitação de vaga de leito no MIRA: autorizada com destino vira "agendada"; internada, "atendida". */
export function statusMiraLeito(status: StatusSolicitacaoLeito): StatusMira {
  switch (status) {
    case 'PENDENTE':
    case 'EM_ANALISE':
      return 'pending';
    case 'DEVOLVIDA':
      return 'returned-to-requester';
    case 'AUTORIZADA':
    case 'EM_TRANSFERENCIA':
      return 'booked';
    case 'INTERNADA':
      return 'attended';
    case 'NEGADA':
    case 'CANCELADA':
      return 'cancelled';
  }
}

export function caraterMira(prioridade: PrioridadeRegulacao): CaraterMira {
  return prioridade === 'VERMELHA' || prioridade === 'AMARELA' ? 'urgent' : 'routine';
}

export function modalidadeMira(fonte: FonteRegulacao): ModalidadeMira {
  return fonte === 'LEITO' ? '04' : '09';
}

/** Identificador local do documento na RNDS: fonte, protocolo e sequência (cada mudança de situação gera um documento). */
export function identificadorDocumentoRegulacao(fonte: FonteRegulacao, protocolo: string, sequencia: number): string {
  return `${fonte === 'LEITO' ? 'LEI' : 'AMB'}_${protocolo}_${String(sequencia).padStart(3, '0')}`;
}

/** A partir de 1/1/2025 o MIRA exige o motivo (CID-10 ou CIAP-2) da solicitação (invariante mira-1). */
export function exigeMotivoMira(dataSolicitacao: Date): boolean {
  return dataSolicitacao.getTime() > Date.UTC(2025, 0, 1, 1, 0, 0);
}
