import type { CaraterMira, ModalidadeMira, StatusMira, VitalSigns } from '@omnisaude/shared';

/** Paciente identificado por CPF (preferencial na RNDS) e/ou CNS. */
export interface PatientIdentity {
  cpf?: string;
  cns?: string;
}

export interface PractitionerIdentity {
  cns?: string;
  cpf?: string;
  /** Ocupação (CBO), ex.: 225125 (médico clínico). */
  cbo: string;
  name?: string;
}

export interface EstablishmentIdentity {
  cnes: string;
  name?: string;
}

export interface DocumentMeta {
  /** Identificador do solicitante credenciado na RNDS (compõe Bundle.identifier.system). */
  rndsRequesterId: string;
  /** Identificador local único do documento (idempotência no reenvio). */
  localId: string;
  timestamp?: Date;
  /** Gerador de UUIDs (injetável para testes). */
  uuid?: () => string;
}

export interface ProblemInput {
  system: 'CID10' | 'CIAP2';
  code: string;
  display?: string;
  clinicalStatus?: 'active' | 'resolved' | 'inactive';
}

export interface ProcedureInput {
  /** Código SIGTAP de 10 dígitos (com ou sem pontuação). */
  sigtapCode: string;
  display?: string;
  quantity?: number;
}

export interface RacVitals extends VitalSigns {
  weightKg?: number;
  heightCm?: number;
}

export interface RacInput extends DocumentMeta {
  patient: PatientIdentity;
  practitioner: PractitionerIdentity;
  establishment: EstablishmentIdentity;
  careLevel: 'ATENCAO_BASICA' | 'ATENCAO_ESPECIALIZADA';
  encounter: { start: Date; end?: Date; modality?: 'PRESENCIAL' | 'TELESSAUDE' | 'DOMICILIAR' };
  problems: ProblemInput[];
  procedures?: ProcedureInput[];
  vitals?: RacVitals;
  notes?: string;
}

export interface ImmunizationInput extends DocumentMeta {
  patient: PatientIdentity;
  practitioner: PractitionerIdentity;
  establishment: EstablishmentIdentity;
  vaccine: { code: string; display?: string };
  lot: string;
  expirationDate?: string; // AAAA-MM-DD
  manufacturer: { code: string; display?: string };
  dose: { code: string; display?: string };
  occurrence: Date;
  route?: { code: string; display?: string };
  site?: { code: string; display?: string };
}

export interface DispensationItemInput {
  catmatCode: string;
  display: string;
  quantity: number;
  unit: string;
  lot?: string;
  expirationDate?: string; // AAAA-MM-DD
}

export interface DispensationInput extends DocumentMeta {
  patient: PatientIdentity;
  dispenser: PractitionerIdentity;
  establishment: EstablishmentIdentity;
  items: DispensationItemInput[];
  dispensedAt: Date;
  prescription?: { identifier: string; prescriberCns?: string; date?: Date };
}

export interface DischargeSummaryInput extends DocumentMeta {
  patient: PatientIdentity;
  practitioner: PractitionerIdentity;
  establishment: EstablishmentIdentity;
  admission: Date;
  discharge: Date;
  /** Código de http://terminology.hl7.org/CodeSystem/discharge-disposition (home, oth-hosp, exp...). */
  dischargeDisposition?: string;
  diagnoses: (ProblemInput & { system: 'CID10'; role: 'principal' | 'secundario' })[];
  procedures?: ProcedureInput[];
  dischargeMedications?: { name: string; catmatCode?: string; instructions: string }[];
  clinicalSummary?: string;
  followUp?: string;
}

/** Registro de Regulação Assistencial (RIRA): uma solicitação de procedimento regulado e sua situação atual. */
export interface RegulationDocumentInput extends DocumentMeta {
  patient: PatientIdentity;
  /** Estabelecimento autor do documento (a central reguladora ou, na falta dela, o estabelecimento que alterou a situação). */
  author: EstablishmentIdentity;
  /** Estabelecimento que realizou a última alteração da situação (Composition.event.detail). */
  statusChangedBy: EstablishmentIdentity;
  status: StatusMira;
  statusChangedAt: Date;
  modality: ModalidadeMira;
  priority: CaraterMira;
  procedure: { sigtapCode: string; display?: string };
  /** Estabelecimento solicitante e data da solicitação. */
  requester: EstablishmentIdentity;
  authoredOn: Date;
  /** CBO da especialidade do executante (opcional). */
  performerCbo?: string;
  /** Estabelecimento executante: obrigatório quando agendada, atendida ou falta; proibido quando pendente. */
  performer?: EstablishmentIdentity;
  /** Estabelecimento regulador (Appointment.supportingInformation). */
  regulator?: EstablishmentIdentity;
  /** Motivo da solicitação (CID-10 ou CIAP-2): obrigatório para solicitações a partir de 1/1/2025. */
  reason?: ProblemInput;
  /** Agendamento: início/fim obrigatórios quando agendada, atendida ou falta; created = data da autorização. */
  appointment?: { start: Date; end?: Date; created?: Date };
  /** Data da execução (atendida ou falta). */
  occurrence?: Date;
  /** Referência ao documento anterior na RNDS (ex.: "Composition/<id>") quando este o substitui. */
  replaces?: string;
}
