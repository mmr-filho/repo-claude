import { describe, expect, it } from 'vitest';
import {
  buildDischargeSummaryBundle,
  buildDispensationBundle,
  buildImmunizationBundle,
  buildRacBundle,
  BUNDLE_IDENTIFIER_PREFIX,
  CODE_SYSTEMS,
  FhirInputError,
  NAMING_SYSTEMS,
  PROFILES,
  validateRndsBundle,
} from '@omnisaude/fhir';

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const meta = () => ({ rndsRequesterId: '9999', localId: `doc-${++counter}`, timestamp: new Date('2026-03-10T15:00:00Z'), uuid });
const patient = { cpf: '529.982.247-25' };
const practitioner = { cns: '203456789010002', cbo: '225125', name: 'Dra. Ana Lima' };
const establishment = { cnes: '1234567', name: 'UBS Centro' };

describe('RAC', () => {
  const bundle = buildRacBundle({
    ...meta(),
    patient,
    practitioner,
    establishment,
    careLevel: 'ATENCAO_BASICA',
    encounter: { start: new Date('2026-03-10T13:00:00Z'), end: new Date('2026-03-10T13:20:00Z') },
    problems: [
      { system: 'CID10', code: 'I10', display: 'Hipertensão essencial' },
      { system: 'CIAP2', code: 'K86' },
    ],
    procedures: [{ sigtapCode: '03.01.01.006-4', display: 'Consulta médica em atenção básica' }],
    vitals: { systolic: 150, diastolic: 95, heartRate: 82, temperature: 36.5, weightKg: 80 },
    notes: 'Paciente refere cefaleia <occipital> & tontura.',
  });

  it('gera documento com Composition primeiro e referências internas', () => {
    expect(bundle.type).toBe('document');
    expect(bundle.identifier).toEqual({ system: `${BUNDLE_IDENTIFIER_PREFIX}9999`, value: expect.stringMatching(/^doc-/) });
    const [composition, ...rest] = bundle.entry!.map((e) => e.resource!);
    expect(composition!.resourceType).toBe('Composition');
    expect(composition!.meta?.profile).toEqual([PROFILES.racComposition]);
    const types = rest.map((r) => r.resourceType);
    expect(types).toEqual(expect.arrayContaining(['PractitionerRole', 'Encounter', 'Condition', 'Procedure', 'Observation']));
    expect(types.filter((t) => t === 'Observation')).toHaveLength(4); // PA (painel), FC, temperatura e peso
    const json = JSON.stringify(bundle);
    expect(json).toContain(NAMING_SYSTEMS.cpf);
    expect(json).toContain('"code":"0301010064"');
    expect(json).toContain('&lt;occipital&gt; &amp; tontura');
  });

  it('passa na validação', () => {
    const result = validateRndsBundle(bundle);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('recusa entradas inválidas', () => {
    const base = { ...meta(), patient, practitioner, establishment, careLevel: 'ATENCAO_BASICA' as const, encounter: { start: new Date() } };
    expect(() => buildRacBundle({ ...base, problems: [] })).toThrow(FhirInputError);
    expect(() => buildRacBundle({ ...base, problems: [{ system: 'CID10', code: 'XYZ' }] })).toThrow(/CID10/);
    expect(() => buildRacBundle({ ...base, patient: { cpf: '11111111111' }, problems: [{ system: 'CID10', code: 'I10' }] })).toThrow(/CPF/);
    expect(() =>
      buildRacBundle({ ...base, problems: [{ system: 'CID10', code: 'I10' }], procedures: [{ sigtapCode: '123' }] }),
    ).toThrow(/SIGTAP/);
  });
});

describe('Imunização, dispensação e sumário de alta', () => {
  it('imunização', () => {
    const bundle = buildImmunizationBundle({
      ...meta(),
      patient: { cns: '700123456789002' },
      practitioner: { cpf: '12345678909', cbo: '322205' },
      establishment,
      vaccine: { code: '86', display: 'Influenza trivalente' },
      lot: 'FLU2026A',
      expirationDate: '2027-02-28',
      manufacturer: { code: '64', display: 'Instituto Butantan' },
      dose: { code: '1', display: '1ª dose' },
      occurrence: new Date('2026-04-15T12:00:00Z'),
      route: { code: 'IM' },
      site: { code: 'DD' },
    });
    const imm = bundle.entry!.find((e) => e.resource?.resourceType === 'Immunization')!.resource as { lotNumber: string; vaccineCode: unknown };
    expect(imm.lotNumber).toBe('FLU2026A');
    expect(JSON.stringify(imm.vaccineCode)).toContain(CODE_SYSTEMS.imunobiologico);
    expect(validateRndsBundle(bundle).valid).toBe(true);
  });

  it('dispensação', () => {
    const bundle = buildDispensationBundle({
      ...meta(),
      patient,
      dispenser: { cns: '170123456780008', cbo: '223405' },
      establishment,
      dispensedAt: new Date('2026-03-10T14:00:00Z'),
      prescription: { identifier: 'RX-2026-0001', prescriberCns: '203456789010002' },
      items: [
        { catmatCode: 'BR0267690', display: 'Losartana potássica 50 mg comprimido', quantity: 30, unit: 'comprimido', lot: 'LS2401', expirationDate: '2027-06-30' },
        { catmatCode: 'BR0267539', display: 'Hidroclorotiazida 25 mg comprimido', quantity: 30, unit: 'comprimido' },
      ],
    });
    const types = bundle.entry!.map((e) => e.resource!.resourceType);
    expect(types.filter((t) => t === 'MedicationDispense')).toHaveLength(2);
    expect(types.filter((t) => t === 'Medication')).toHaveLength(2);
    expect(validateRndsBundle(bundle).valid).toBe(true);
    expect(() => buildDispensationBundle({ ...meta(), patient, dispenser: practitioner, establishment, dispensedAt: new Date(), items: [] })).toThrow();
  });

  it('sumário de alta', () => {
    const bundle = buildDischargeSummaryBundle({
      ...meta(),
      patient,
      practitioner,
      establishment,
      admission: new Date('2026-03-01T10:00:00Z'),
      discharge: new Date('2026-03-05T16:00:00Z'),
      dischargeDisposition: 'home',
      diagnoses: [
        { system: 'CID10', code: 'E11.9', role: 'secundario' },
        { system: 'CID10', code: 'J18.9', display: 'Pneumonia não especificada', role: 'principal' },
      ],
      procedures: [{ sigtapCode: '0303140151', display: 'Tratamento de pneumonias ou influenza (gripe)' }],
      dischargeMedications: [{ name: 'Amoxicilina 500 mg', instructions: '1 cápsula de 8/8h por 5 dias' }],
      clinicalSummary: 'Internado por pneumonia comunitária, boa evolução com antibioticoterapia.',
      followUp: 'Retorno na UBS em 7 dias.',
    });
    const encounter = bundle.entry!.find((e) => e.resource?.resourceType === 'Encounter')!.resource as {
      diagnosis: { condition: { reference: string }; rank: number }[];
    };
    const principal = bundle.entry!.find((e) => e.fullUrl === encounter.diagnosis[0]!.condition.reference)!.resource;
    expect(JSON.stringify(principal)).toContain('"code":"J189"');
    expect(validateRndsBundle(bundle).valid).toBe(true);
    expect(() =>
      buildDischargeSummaryBundle({
        ...meta(),
        patient,
        practitioner,
        establishment,
        admission: new Date(),
        discharge: new Date(),
        diagnoses: [{ system: 'CID10', code: 'J18', role: 'secundario' }],
      }),
    ).toThrow(/diagnóstico principal/);
  });
});

describe('validador', () => {
  const good = () =>
    buildImmunizationBundle({
      ...meta(),
      patient,
      practitioner,
      establishment,
      vaccine: { code: '86' },
      lot: 'L1',
      manufacturer: { code: '64' },
      dose: { code: '1' },
      occurrence: new Date('2026-04-15T12:00:00Z'),
    });

  it('aponta referência quebrada, CPF inválido e data fora do formato', () => {
    const b = good();
    const imm = b.entry!.find((e) => e.resource?.resourceType === 'Immunization')!.resource as Record<string, unknown>;
    imm.performer = [{ actor: { reference: 'urn:uuid:00000000-0000-4000-8000-ffffffffffff' } }];
    (imm.patient as { identifier: { value: string } }).identifier.value = '52998224726';
    imm.occurrenceDateTime = '15/04/2026';
    const r = validateRndsBundle(b);
    expect(r.valid).toBe(false);
    const messages = r.issues.map((i) => i.message).join('\n');
    expect(messages).toMatch(/Referência não encontrada/);
    expect(messages).toMatch(/CPF inválido/);
    expect(messages).toMatch(/formato FHIR/);
  });

  it('exige Composition primeiro e identificador RNDS', () => {
    const b = good();
    b.entry!.reverse();
    b.identifier = { system: 'http://example.org', value: 'x' };
    const r = validateRndsBundle(b);
    expect(r.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['Bundle.identifier.system', 'Bundle.entry[0]']));
  });

  it('recusa estruturas que não são documentos', () => {
    expect(validateRndsBundle({ resourceType: 'Patient' }).valid).toBe(false);
    expect(validateRndsBundle(null).valid).toBe(false);
  });
});
