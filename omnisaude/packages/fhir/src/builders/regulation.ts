import type { Appointment, Bundle, Condition, Identifier, Reference, ServiceRequest } from 'fhir/r4';
import { estadoMira, exigeMotivoMira, isValidCns, isValidCpf, onlyDigits } from '@omnisaude/shared';
import { DocumentBuilder, fhirDate, fhirDateTime, FhirInputError, problemCode, sigtapCode } from '../common';
import { CODE_SYSTEMS, DOCUMENT_TYPES, PROFILES, RIRA_IDENTIFIERS } from '../rnds';
import type { EstablishmentIdentity, PatientIdentity, RegulationDocumentInput } from '../types';

function individuo(p: PatientIdentity): Identifier {
  const cpf = p.cpf ? onlyDigits(p.cpf) : '';
  const cns = p.cns ? onlyDigits(p.cns) : '';
  if (cpf && isValidCpf(cpf)) return { system: RIRA_IDENTIFIERS.individuo, value: cpf };
  if (cns && isValidCns(cns)) return { system: RIRA_IDENTIFIERS.individuo, value: cns };
  throw new FhirInputError('Indivíduo sem CPF ou CNS válido para a RNDS');
}

function estabelecimento(e: EstablishmentIdentity, papel: string): Identifier {
  const cnes = onlyDigits(e.cnes);
  if (!/^(?!(\d)\1{6})\d{7}$/.test(cnes)) throw new FhirInputError(`CNES inválido (${papel}): ${e.cnes}`);
  return { system: RIRA_IDENTIFIERS.estabelecimento, value: cnes };
}

/**
 * Registro de Regulação Assistencial (RIRA): Composition "RA" com um evento (situação atual), Appointment,
 * ServiceRequest e o motivo (Condition), conforme o guia br.gov.saude.rira.fhir 1.0.0-release e as
 * invariantes mira-1 a mira-19.
 */
export function buildRegulationBundle(input: RegulationDocumentInput): Bundle {
  const estado = estadoMira(input.status);
  const subject = { identifier: individuo(input.patient) };
  const procedimento = sigtapCode(input.procedure.sigtapCode);
  if (!/^\d{10}$/.test(procedimento)) throw new FhirInputError(`Procedimento SIGTAP inválido: ${input.procedure.sigtapCode}`);
  if (exigeMotivoMira(input.authoredOn) && !input.reason) throw new FhirInputError('Solicitações a partir de 1/1/2025 exigem o motivo (CID-10 ou CIAP-2) para a RNDS');
  const performer = estado.proibeExecutante ? undefined : input.performer;
  const appointment = estado.proibeExecutante ? undefined : input.appointment;
  const occurrence = estado.proibeExecutante || !estado.exigeExecucao ? undefined : input.occurrence;
  if (estado.exigeExecutante && !performer) throw new FhirInputError(`Situação "${input.status}" exige o estabelecimento executante`);
  if (estado.exigeExecutante && !appointment) throw new FhirInputError(`Situação "${input.status}" exige a data do agendamento`);
  if (estado.exigeExecucao && !occurrence) throw new FhirInputError(`Situação "${input.status}" exige a data de execução`);
  if (input.performerCbo && !/^\d{6}$/.test(input.performerCbo.replace('-', ''))) throw new FhirInputError(`CBO inválido: ${input.performerCbo}`);

  const doc = new DocumentBuilder(input);
  const modality = { coding: [{ system: CODE_SYSTEMS.modalidadeAssistencial, code: input.modality }] };
  const procedure = { coding: [{ system: CODE_SYSTEMS.sigtap, code: procedimento, ...(input.procedure.display ? { display: input.procedure.display } : {}) }] };
  const specialty = input.performerCbo ? { coding: [{ system: CODE_SYSTEMS.cbo, code: input.performerCbo.replace('-', '') }] } : undefined;

  let reasonRef: Reference | undefined;
  if (input.reason) {
    const condition: Condition = { resourceType: 'Condition', meta: { profile: [PROFILES.problem] }, code: problemCode(input.reason), subject };
    reasonRef = doc.add(condition);
  }

  const requestUrn = doc.newUrn();
  const request: ServiceRequest = {
    resourceType: 'ServiceRequest',
    meta: { profile: [PROFILES.regulationRequest] },
    status: estado.serviceRequest,
    intent: 'proposal',
    category: [modality],
    priority: input.priority,
    code: procedure,
    subject,
    ...(occurrence ? { occurrenceDateTime: fhirDateTime(occurrence) } : {}),
    authoredOn: fhirDateTime(input.authoredOn),
    requester: { identifier: estabelecimento(input.requester, 'solicitante') },
    ...(specialty ? { performerType: specialty } : {}),
    ...(performer ? { performer: [{ identifier: estabelecimento(performer, 'executante') }] } : {}),
    ...(reasonRef ? { reasonReference: [reasonRef] } : {}),
  };
  doc.add(request, requestUrn);

  const appointmentUrn = doc.newUrn();
  const appt: Appointment = {
    resourceType: 'Appointment',
    meta: { profile: [PROFILES.regulationAppointment] },
    status: estado.appointment,
    serviceCategory: [modality],
    serviceType: [procedure],
    ...(specialty ? { specialty: [specialty] } : {}),
    appointmentType: { coding: [{ system: CODE_SYSTEMS.requestPriority, code: input.priority }] },
    ...(reasonRef ? { reasonReference: [reasonRef] } : {}),
    ...(input.regulator ? { supportingInformation: [{ identifier: estabelecimento(input.regulator, 'regulador') }] } : {}),
    ...(appointment ? { start: fhirDateTime(appointment.start), end: fhirDateTime(appointment.end ?? appointment.start) } : {}),
    ...(input.appointment?.created ? { created: fhirDateTime(input.appointment.created) } : {}),
    basedOn: [{ reference: requestUrn }],
    participant: [{ type: [{ coding: [{ system: CODE_SYSTEMS.tipoParticipante, code: 'PCT' }] }], actor: subject, status: 'accepted' }],
  };
  doc.add(appt, appointmentUrn);

  const detail: Reference[] = [{ identifier: estabelecimento(input.statusChangedBy, 'alteração da situação') }];
  if (input.status === 'pending') detail.push({ reference: requestUrn });
  else if (estado.exigeExecutante) detail.push({ reference: appointmentUrn });

  return doc.build(
    {
      meta: { profile: [PROFILES.regulationComposition] },
      type: { coding: [{ system: CODE_SYSTEMS.tipoDocumento, code: DOCUMENT_TYPES.regulation.code }] },
      category: [modality],
      subject,
      date: fhirDate(input.timestamp ?? new Date()),
      author: [{ identifier: estabelecimento(input.author, 'autor') }],
      title: DOCUMENT_TYPES.regulation.display,
      ...(input.replaces ? { relatesTo: [{ code: 'replaces', targetReference: { reference: input.replaces } }] } : {}),
      event: [{ code: [{ coding: [{ system: CODE_SYSTEMS.statusRegulacao, code: input.status }] }], period: { end: fhirDateTime(input.statusChangedAt) }, detail }],
    },
    [{ entry: [{ reference: appointmentUrn }] }],
  );
}
