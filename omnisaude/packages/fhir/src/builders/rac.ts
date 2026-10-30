import type { Bundle, Condition, Encounter, Observation, Procedure, Reference } from 'fhir/r4';
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
import { CODE_SYSTEMS, DOCUMENT_TYPES, LOINC, PROFILES } from '../rnds';
import type { RacInput, RacVitals } from '../types';

const MODALITY_CLASS = {
  PRESENCIAL: { code: 'AMB', display: 'ambulatory' },
  TELESSAUDE: { code: 'VR', display: 'virtual' },
  DOMICILIAR: { code: 'HH', display: 'home health' },
} as const;

/** Limite de repetições de um mesmo procedimento (cada execução vira um Procedure). */
const MAX_PROCEDURE_QUANTITY = 50;

export function vitalObservations(
  vitals: RacVitals,
  ctx: { subject: Reference; encounter: Reference; performer: Reference; effective: string },
): Observation[] {
  const base = (code: { code: string; display: string }): Observation => ({
    resourceType: 'Observation',
    meta: { profile: [PROFILES.vitalSign] },
    status: 'final',
    category: [{ coding: [{ system: CODE_SYSTEMS.observationCategory, code: 'vital-signs' }] }],
    code: { coding: [{ system: CODE_SYSTEMS.loinc, code: code.code, display: code.display }] },
    subject: ctx.subject,
    encounter: ctx.encounter,
    effectiveDateTime: ctx.effective,
    performer: [ctx.performer],
  });
  const quantity = (value: number, unit: string) => ({ value, unit, system: CODE_SYSTEMS.ucum, code: unit });
  const out: Observation[] = [];
  if (vitals.systolic !== undefined || vitals.diastolic !== undefined) {
    const bp = base(LOINC.bloodPressurePanel);
    bp.component = [];
    if (vitals.systolic !== undefined) {
      bp.component.push({
        code: { coding: [{ system: CODE_SYSTEMS.loinc, code: LOINC.systolic.code, display: LOINC.systolic.display }] },
        valueQuantity: quantity(vitals.systolic, LOINC.systolic.unit),
      });
    }
    if (vitals.diastolic !== undefined) {
      bp.component.push({
        code: { coding: [{ system: CODE_SYSTEMS.loinc, code: LOINC.diastolic.code, display: LOINC.diastolic.display }] },
        valueQuantity: quantity(vitals.diastolic, LOINC.diastolic.unit),
      });
    }
    out.push(bp);
  }
  const simple: [keyof RacVitals, (typeof LOINC)[Exclude<keyof typeof LOINC, 'bloodPressurePanel'>]][] = [
    ['heartRate', LOINC.heartRate],
    ['respiratoryRate', LOINC.respiratoryRate],
    ['temperature', LOINC.temperature],
    ['spo2', LOINC.spo2],
    ['glucose', LOINC.glucose],
    ['weightKg', LOINC.weight],
    ['heightCm', LOINC.height],
    ['painScore', LOINC.painScore],
  ];
  for (const [key, code] of simple) {
    const value = vitals[key];
    if (value === undefined) continue;
    const obs = base(code);
    obs.valueQuantity = quantity(value, code.unit);
    out.push(obs);
  }
  return out;
}

/** RAC: Registro de Atendimento Clínico (atenção básica ou especializada). */
export function buildRacBundle(input: RacInput): Bundle {
  if (input.problems.length === 0) throw new FhirInputError('O RAC precisa de ao menos um problema/diagnóstico avaliado');
  const doc = new DocumentBuilder(input);
  const subject = { identifier: patientIdentifier(input.patient) };
  const role = doc.practitionerRole(input.practitioner, input.establishment);
  const start = fhirDateTime(input.encounter.start);
  const end = input.encounter.end ? fhirDateTime(input.encounter.end) : undefined;
  const modality = MODALITY_CLASS[input.encounter.modality ?? 'PRESENCIAL'];

  const encounterUrn = doc.newUrn();
  const encounterRef = { reference: encounterUrn };
  const encounter: Encounter = {
    resourceType: 'Encounter',
    meta: { profile: [PROFILES.racEncounter] },
    status: 'finished',
    class: { system: CODE_SYSTEMS.actCode, code: modality.code, display: modality.display },
    type: [
      {
        coding: [
          {
            system: CODE_SYSTEMS.nivelAtencao,
            code: input.careLevel,
            display: input.careLevel === 'ATENCAO_BASICA' ? 'Atenção Básica' : 'Atenção Especializada',
          },
        ],
      },
    ],
    subject,
    participant: [{ individual: role }],
    period: { start, ...(end ? { end } : {}) },
    serviceProvider: { identifier: establishmentIdentifier(input.establishment) },
  };
  doc.add(encounter, encounterUrn);

  const problemRefs = input.problems.map((p) => {
    const condition: Condition = {
      resourceType: 'Condition',
      meta: { profile: [PROFILES.problem] },
      clinicalStatus: { coding: [{ system: CODE_SYSTEMS.conditionClinical, code: p.clinicalStatus ?? 'active' }] },
      category: [{ coding: [{ system: CODE_SYSTEMS.conditionCategory, code: 'encounter-diagnosis' }] }],
      code: problemCode(p),
      subject,
      encounter: encounterRef,
      recordedDate: start,
      recorder: role,
    };
    return doc.add(condition);
  });
  encounter.diagnosis = problemRefs.map((condition, i) => ({ condition, rank: i + 1 }));

  const procedureRefs: Reference[] = [];
  for (const p of input.procedures ?? []) {
    const quantity = p.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PROCEDURE_QUANTITY) {
      throw new FhirInputError(`Quantidade inválida para o procedimento ${p.sigtapCode}: ${quantity}`);
    }
    for (let i = 0; i < quantity; i++) {
      const procedure: Procedure = {
        resourceType: 'Procedure',
        meta: { profile: [PROFILES.procedure] },
        status: 'completed',
        code: { coding: [{ system: CODE_SYSTEMS.sigtap, code: sigtapCode(p.sigtapCode), ...(p.display ? { display: p.display } : {}) }] },
        subject,
        encounter: encounterRef,
        performedDateTime: start,
        performer: [{ actor: role }],
      };
      procedureRefs.push(doc.add(procedure));
    }
  }

  const vitalRefs = input.vitals
    ? vitalObservations(input.vitals, { subject, encounter: encounterRef, performer: role, effective: start }).map((o) => doc.add(o))
    : [];

  return doc.build(
    {
      meta: { profile: [PROFILES.racComposition] },
      type: { coding: [{ system: CODE_SYSTEMS.tipoDocumento, ...DOCUMENT_TYPES.rac }] },
      subject,
      encounter: encounterRef,
      author: [role],
      title: DOCUMENT_TYPES.rac.display,
      custodian: { identifier: establishmentIdentifier(input.establishment) },
    },
    [
      { title: 'Problemas e diagnósticos avaliados', entry: problemRefs },
      { title: 'Procedimentos realizados', entry: procedureRefs },
      { title: 'Sinais vitais', entry: vitalRefs },
      ...(input.notes ? [{ title: 'Observações', text: narrative(input.notes) }] : []),
    ],
  );
}
