import type { Bundle, Immunization } from 'fhir/r4';
import { DocumentBuilder, establishmentIdentifier, fhirDateTime, FhirInputError, patientIdentifier } from '../common';
import { CODE_SYSTEMS, DOCUMENT_TYPES, PROFILES } from '../rnds';
import type { ImmunizationInput } from '../types';

/** Registro de imunobiológico administrado (vacina, lote, fabricante, dose). */
export function buildImmunizationBundle(input: ImmunizationInput): Bundle {
  if (!input.lot.trim()) throw new FhirInputError('Lote do imunobiológico é obrigatório');
  if (input.expirationDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.expirationDate)) {
    throw new FhirInputError(`Validade do lote inválida: ${input.expirationDate}`);
  }
  const doc = new DocumentBuilder(input);
  const patient = { identifier: patientIdentifier(input.patient) };
  const role = doc.practitionerRole(input.practitioner, input.establishment);
  const coded = (system: string, c: { code: string; display?: string }) => ({
    coding: [{ system, code: c.code, ...(c.display ? { display: c.display } : {}) }],
  });

  const immunization: Immunization = {
    resourceType: 'Immunization',
    meta: { profile: [PROFILES.immunization] },
    status: 'completed',
    vaccineCode: coded(CODE_SYSTEMS.imunobiologico, input.vaccine),
    patient,
    occurrenceDateTime: fhirDateTime(input.occurrence),
    primarySource: true,
    lotNumber: input.lot.trim(),
    ...(input.expirationDate ? { expirationDate: input.expirationDate } : {}),
    manufacturer: {
      identifier: { system: CODE_SYSTEMS.fabricante, value: input.manufacturer.code },
      ...(input.manufacturer.display ? { display: input.manufacturer.display } : {}),
    },
    ...(input.site ? { site: coded(CODE_SYSTEMS.localAplicacao, input.site) } : {}),
    ...(input.route ? { route: coded(CODE_SYSTEMS.viaAdministracao, input.route) } : {}),
    performer: [{ actor: role }],
    // Código de BRDose ("1" = 1ª dose, "9" = reforço...), conforme a tabela da RNDS.
    protocolApplied: [{ doseNumberString: input.dose.code, ...(input.dose.display ? { series: input.dose.display } : {}) }],
  };
  const ref = doc.add(immunization);

  return doc.build(
    {
      meta: { profile: [PROFILES.immunizationComposition] },
      type: { coding: [{ system: CODE_SYSTEMS.tipoDocumento, ...DOCUMENT_TYPES.immunization }] },
      subject: patient,
      author: [role],
      title: DOCUMENT_TYPES.immunization.display,
      custodian: { identifier: establishmentIdentifier(input.establishment) },
    },
    [{ title: 'Imunobiológico administrado', entry: [ref] }],
  );
}
