import type { Bundle, Medication, MedicationDispense, Reference } from 'fhir/r4';
import { isValidCns, onlyDigits } from '@omnisaude/shared';
import { DocumentBuilder, establishmentIdentifier, fhirDateTime, FhirInputError, patientIdentifier } from '../common';
import { CODE_SYSTEMS, DOCUMENT_TYPES, PROFILES } from '../rnds';
import type { DispensationInput } from '../types';

/** Dispensação de medicamentos ao cidadão (CATMAT, quantidade, lote). */
export function buildDispensationBundle(input: DispensationInput): Bundle {
  if (input.items.length === 0) throw new FhirInputError('Dispensação sem itens');
  const doc = new DocumentBuilder(input);
  const subject = { identifier: patientIdentifier(input.patient) };
  const role = doc.practitionerRole(input.dispenser, input.establishment);
  if (input.prescription?.prescriberCns && !isValidCns(input.prescription.prescriberCns)) {
    throw new FhirInputError(`CNS do prescritor inválido: ${input.prescription.prescriberCns}`);
  }
  const prescription: Reference[] = input.prescription
    ? [
        {
          identifier: { value: input.prescription.identifier },
          ...(input.prescription.prescriberCns ? { display: `Prescritor CNS ${onlyDigits(input.prescription.prescriberCns)}` } : {}),
        },
      ]
    : [];

  const refs = input.items.map((item) => {
    if (!(item.quantity > 0)) throw new FhirInputError(`Quantidade inválida para ${item.display}`);
    if (!/^[A-Z]*\d+$/i.test(item.catmatCode)) throw new FhirInputError(`Código CATMAT inválido: ${item.catmatCode}`);
    if (item.expirationDate && !/^\d{4}-\d{2}-\d{2}$/.test(item.expirationDate)) {
      throw new FhirInputError(`Validade inválida: ${item.expirationDate}`);
    }
    const medication: Medication = {
      resourceType: 'Medication',
      meta: { profile: [PROFILES.medication] },
      code: { coding: [{ system: CODE_SYSTEMS.catmat, code: item.catmatCode, display: item.display }], text: item.display },
      ...(item.lot ? { batch: { lotNumber: item.lot, ...(item.expirationDate ? { expirationDate: item.expirationDate } : {}) } } : {}),
    };
    const medicationRef = doc.add(medication);
    const dispense: MedicationDispense = {
      resourceType: 'MedicationDispense',
      meta: { profile: [PROFILES.dispensation] },
      status: 'completed',
      medicationReference: medicationRef,
      subject,
      performer: [{ actor: role }],
      quantity: { value: item.quantity, unit: item.unit },
      whenHandedOver: fhirDateTime(input.dispensedAt),
      ...(prescription.length ? { authorizingPrescription: prescription } : {}),
    };
    return doc.add(dispense);
  });

  return doc.build(
    {
      meta: { profile: [PROFILES.dispensationComposition] },
      type: { coding: [{ system: CODE_SYSTEMS.tipoDocumento, ...DOCUMENT_TYPES.dispensation }] },
      subject,
      author: [role],
      title: DOCUMENT_TYPES.dispensation.display,
      custodian: { identifier: establishmentIdentifier(input.establishment) },
    },
    [{ title: 'Medicamentos dispensados', entry: refs }],
  );
}
