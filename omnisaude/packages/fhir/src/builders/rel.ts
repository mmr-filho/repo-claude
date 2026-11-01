import type { Bundle, Condition, Observation, Specimen } from 'fhir/r4';
import { onlyDigits } from '@omnisaude/shared';
import { DocumentBuilder, FhirInputError, patientIdentifier } from '../common';
import { CODE_SYSTEMS, DOCUMENT_TYPES, PROFILES, RIRA_IDENTIFIERS } from '../rnds';
import type { RelInput } from '../types';

/**
 * Data e hora no fuso do estabelecimento, com segundos (ex.: 2021-06-08T09:23:00-03:00), como pede o guia do REL.
 */
export function fhirDateTimeLocal(date: Date, timeZone: string): string {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(Number(partes.year), Number(partes.month) - 1, Number(partes.day), Number(partes.hour), Number(partes.minute), Number(partes.second));
  const minutos = Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const sinal = minutos < 0 ? '-' : '+';
  const abs = Math.abs(minutos);
  return `${partes.year}-${partes.month}-${partes.day}T${partes.hour}:${partes.minute}:${partes.second}${sinal}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Sem `coding.display` nos elementos em que o perfil o proíbe (0..0: Composition.type, Observation.code e category,
 * Specimen.type) nem onde o guia não o usa (resultado e patógeno); a Condition leva, como no exemplo oficial.
 *
 * REL 3.2.1: Composition (tipo REL) com uma seção que referencia a Condition (suspeita diagnóstica) e a Observation
 * (o exame); a Condition aponta a Observation em stage.assessment e a Observation aponta o Specimen. Indivíduo por
 * CPF ou CNS (BRIndividuo-1.0) e estabelecimento por CNES (BREstabelecimentoSaude-1.0).
 */
export function buildRelBundle(input: RelInput): Bundle {
  if (!/^\d{1,7}-\d$/.test(input.exam.loinc)) throw new FhirInputError(`Código LOINC inválido: ${input.exam.loinc}`);
  if (input.resultAt.getTime() < input.collectedAt.getTime()) throw new FhirInputError('O resultado não pode ser anterior à coleta');
  if (!input.method.trim()) throw new FhirInputError('Método do exame é obrigatório');
  const cnes = onlyDigits(input.establishment.cnes);
  if (cnes.length !== 7) throw new FhirInputError(`CNES deve ter 7 dígitos: ${input.establishment.cnes}`);
  const doc = new DocumentBuilder({ ...input, timestamp: input.timestamp ?? input.resultAt });
  const pid = patientIdentifier(input.patient);
  const individuo = { identifier: { system: RIRA_IDENTIFIERS.individuo, value: pid.value } };
  const estabelecimento = { identifier: { system: RIRA_IDENTIFIERS.estabelecimento, value: cnes } };

  const specimenUrn = doc.newUrn();
  const observationUrn = doc.newUrn();
  const conditionUrn = doc.newUrn();

  const condition: Condition = {
    resourceType: 'Condition',
    meta: { profile: [PROFILES.relCondition] },
    code: { coding: [{ system: CODE_SYSTEMS.suspeitaDiagnostica, code: input.suspicion.code, display: input.suspicion.display }] },
    subject: individuo,
    stage: [{ assessment: [{ reference: observationUrn }] }],
  };
  const observation: Observation = {
    resourceType: 'Observation',
    meta: { profile: [PROFILES.relObservation] },
    ...(input.pathogen ? { extension: [{ url: PROFILES.relPathogenExtension, valueCodeableConcept: { coding: [{ system: CODE_SYSTEMS.patogeno, code: input.pathogen.code }] } }] } : {}),
    status: 'final',
    category: [{ coding: [{ system: CODE_SYSTEMS.subgrupoTabelaSus, code: input.category }] }],
    code: { coding: [{ system: CODE_SYSTEMS.nomeExameLoinc, code: input.exam.loinc }] },
    subject: individuo,
    effectiveDateTime: fhirDateTimeLocal(input.collectedAt, input.timeZone),
    issued: fhirDateTimeLocal(input.resultAt, input.timeZone),
    performer: [estabelecimento],
    valueCodeableConcept: {
      coding: [{ system: input.result.type === 'DTNT' ? CODE_SYSTEMS.tipoResultadoDTNT : CODE_SYSTEMS.tipoResultadoRGNR, code: input.result.code }],
    },
    method: { text: input.method.trim() },
    specimen: { reference: specimenUrn },
    referenceRange: [{ text: input.referenceRange }],
  };
  const specimen: Specimen = {
    resourceType: 'Specimen',
    meta: { profile: [PROFILES.relSpecimen] },
    type: { coding: [{ system: CODE_SYSTEMS.tipoAmostraGal, code: input.specimen.code }] },
  };
  doc.add(condition, conditionUrn);
  doc.add(observation, observationUrn);
  doc.add(specimen, specimenUrn);

  return doc.build(
    {
      meta: { profile: [PROFILES.relComposition] },
      type: { coding: [{ system: CODE_SYSTEMS.tipoDocumento, code: DOCUMENT_TYPES.rel.code }] },
      subject: individuo,
      author: [estabelecimento],
      title: 'Resultado de Exame Laboratorial',
      date: fhirDateTimeLocal(input.resultAt, input.timeZone),
      ...(input.replaces ? { relatesTo: [{ code: 'replaces', targetReference: { reference: input.replaces } }] } : {}),
    },
    [{ entry: [{ reference: conditionUrn }, { reference: observationUrn }] }],
  );
}
