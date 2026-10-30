import type { Bundle, Condition, Encounter, MedicationRequest, Procedure, Reference } from 'fhir/r4';
import {
  DocumentBuilder,
  establishmentIdentifier,
  fhirDateTime,
  FhirInputError,
  narrative,
  patientIdentifier,
  problemCode,
  sigtapCode,
} from '../common';
import { CODE_SYSTEMS, DOCUMENT_TYPES, PROFILES } from '../rnds';
import type { DischargeSummaryInput } from '../types';

/** Sumário de Alta Hospitalar: linha de cuidado pós-internação. */
export function buildDischargeSummaryBundle(input: DischargeSummaryInput): Bundle {
  if (input.discharge.getTime() < input.admission.getTime()) throw new FhirInputError('Alta anterior à internação');
  const principal = input.diagnoses.filter((d) => d.role === 'principal');
  if (principal.length !== 1) throw new FhirInputError('O sumário de alta exige exatamente um diagnóstico principal');

  const doc = new DocumentBuilder(input);
  const subject = { identifier: patientIdentifier(input.patient) };
  const role = doc.practitionerRole(input.practitioner, input.establishment);
  const admission = fhirDateTime(input.admission);
  const discharge = fhirDateTime(input.discharge);
  const encounterUrn = doc.newUrn();
  const encounterRef = { reference: encounterUrn };

  // Diagnóstico principal primeiro (rank 1).
  const ordered = [...principal, ...input.diagnoses.filter((d) => d.role !== 'principal')];
  const diagnosisRefs = ordered.map((d) => {
    const condition: Condition = {
      resourceType: 'Condition',
      meta: { profile: [PROFILES.problem] },
      clinicalStatus: { coding: [{ system: CODE_SYSTEMS.conditionClinical, code: d.clinicalStatus ?? 'active' }] },
      category: [{ coding: [{ system: CODE_SYSTEMS.conditionCategory, code: 'encounter-diagnosis' }] }],
      code: problemCode(d),
      subject,
      encounter: encounterRef,
      recordedDate: discharge,
    };
    return doc.add(condition);
  });

  const encounter: Encounter = {
    resourceType: 'Encounter',
    meta: { profile: [PROFILES.dischargeEncounter] },
    status: 'finished',
    class: { system: CODE_SYSTEMS.actCode, code: 'IMP', display: 'inpatient encounter' },
    subject,
    participant: [{ individual: role }],
    period: { start: admission, end: discharge },
    diagnosis: diagnosisRefs.map((condition, i) => ({
      condition,
      use: { coding: [{ system: CODE_SYSTEMS.diagnosisRole, code: 'DD', display: 'Discharge diagnosis' }] },
      rank: i + 1,
    })),
    ...(input.dischargeDisposition
      ? { hospitalization: { dischargeDisposition: { coding: [{ system: CODE_SYSTEMS.dischargeDisposition, code: input.dischargeDisposition }] } } }
      : {}),
    serviceProvider: { identifier: establishmentIdentifier(input.establishment) },
  };
  doc.add(encounter, encounterUrn);

  const procedureRefs: Reference[] = (input.procedures ?? []).map((p) => {
    const procedure: Procedure = {
      resourceType: 'Procedure',
      meta: { profile: [PROFILES.procedure] },
      status: 'completed',
      code: { coding: [{ system: CODE_SYSTEMS.sigtap, code: sigtapCode(p.sigtapCode), ...(p.display ? { display: p.display } : {}) }] },
      subject,
      encounter: encounterRef,
      performedPeriod: { start: admission, end: discharge },
    };
    return doc.add(procedure);
  });

  const medicationRefs = (input.dischargeMedications ?? []).map((m) => {
    const request: MedicationRequest = {
      resourceType: 'MedicationRequest',
      meta: { profile: [PROFILES.dischargeMedication] },
      status: 'active',
      intent: 'plan',
      medicationCodeableConcept: {
        ...(m.catmatCode ? { coding: [{ system: CODE_SYSTEMS.catmat, code: m.catmatCode, display: m.name }] } : {}),
        text: m.name,
      },
      subject,
      encounter: encounterRef,
      authoredOn: discharge,
      requester: role,
      dosageInstruction: [{ text: m.instructions }],
    };
    return doc.add(request);
  });

  return doc.build(
    {
      meta: { profile: [PROFILES.dischargeComposition] },
      type: { coding: [{ system: CODE_SYSTEMS.tipoDocumento, ...DOCUMENT_TYPES.discharge }] },
      subject,
      encounter: encounterRef,
      author: [role],
      title: DOCUMENT_TYPES.discharge.display,
      custodian: { identifier: establishmentIdentifier(input.establishment) },
    },
    [
      { title: 'Diagnósticos', entry: diagnosisRefs },
      { title: 'Procedimentos realizados', entry: procedureRefs },
      { title: 'Prescrição de alta', entry: medicationRefs },
      ...(input.clinicalSummary ? [{ title: 'Resumo clínico da internação', text: narrative(input.clinicalSummary) }] : []),
      ...(input.followUp ? [{ title: 'Plano de seguimento', text: narrative(input.followUp) }] : []),
    ],
  );
}
