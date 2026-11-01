import { describe, expect, it } from 'vitest';
import { buildRelBundle, CODE_SYSTEMS, fhirDateTimeLocal, FhirInputError, PROFILES, RIRA_IDENTIFIERS, validateRndsBundle } from '@omnisaude/fhir';

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const base = () => ({
  rndsRequesterId: '9999',
  localId: `exame-${++counter}`,
  uuid,
  patient: { cpf: '529.982.247-25' },
  establishment: { cnes: '1234567', name: 'UBS Centro' },
  suspicion: { code: 'B342' as const, display: 'Infecção por coronavírus de localização não especificada' },
  exam: { loinc: '94558-4', display: 'SARS Coronavírus 2, [presença de] antígenos Ag em amostra respiratória por imunoensaio rápido' },
  result: { type: 'RGNR' as const, code: '1' as const, display: 'Reagente' },
  referenceRange: 'Não Reagente',
  method: 'Imunocromatográfico',
  category: '0214' as const,
  specimen: { code: 'SWNAFA', display: 'Swab Nasofaríngeo' },
  pathogen: { code: '07', display: 'SARS-CoV-2' },
  collectedAt: new Date('2026-11-01T12:00:00Z'),
  resultAt: new Date('2026-11-01T12:20:00Z'),
  timeZone: 'America/Sao_Paulo',
});

describe('REL (resultado de exame laboratorial, 3.2.1)', () => {
  it('monta Composition, Condition, Observation e Specimen com os perfis e códigos da RNDS, e passa na validação', () => {
    const b = buildRelBundle(base());
    const [comp, cond, obs, spec] = b.entry!.map((e) => e.resource as unknown as Record<string, any>);
    expect(comp).toMatchObject({ resourceType: 'Composition', meta: { profile: [PROFILES.relComposition] }, type: { coding: [{ code: 'REL' }] }, title: 'Resultado de Exame Laboratorial' });
    expect(comp!.subject.identifier).toEqual({ system: RIRA_IDENTIFIERS.individuo, value: '52998224725' });
    expect(comp!.author[0].identifier).toEqual({ system: RIRA_IDENTIFIERS.estabelecimento, value: '1234567' });
    expect(cond).toMatchObject({ resourceType: 'Condition', code: { coding: [{ system: CODE_SYSTEMS.suspeitaDiagnostica, code: 'B342' }] } });
    expect(cond!.stage[0].assessment[0].reference).toBe(b.entry![2]!.fullUrl);
    expect(obs).toMatchObject({
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: CODE_SYSTEMS.nomeExameLoinc, code: '94558-4' }] },
      valueCodeableConcept: { coding: [{ system: CODE_SYSTEMS.tipoResultadoRGNR, code: '1' }] },
      method: { text: 'Imunocromatográfico' },
      effectiveDateTime: '2026-11-01T09:00:00-03:00',
      issued: '2026-11-01T09:20:00-03:00',
      category: [{ coding: [{ system: CODE_SYSTEMS.subgrupoTabelaSus, code: '0214' }] }],
    });
    expect(obs!.specimen.reference).toBe(b.entry![3]!.fullUrl);
    expect(spec).toMatchObject({ resourceType: 'Specimen', type: { coding: [{ system: CODE_SYSTEMS.tipoAmostraGal, code: 'SWNAFA' }] } });
    expect(Object.keys(spec!).sort()).toEqual(['meta', 'resourceType', 'type']);
    // display em 0..0 no perfil: Composition.type, Observation.code e category, Specimen.type.
    for (const coding of [comp!.type.coding[0], obs!.code.coding[0], obs!.category[0].coding[0], spec!.type.coding[0], obs!.valueCodeableConcept.coding[0]]) expect(coding).not.toHaveProperty('display');
    const v = validateRndsBundle(b);
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('recusa LOINC inválido, resultado antes da coleta e falta de método; o validador acusa REL incompleto', () => {
    expect(() => buildRelBundle({ ...base(), exam: { loinc: 'ABC', display: 'x' } })).toThrow(FhirInputError);
    expect(() => buildRelBundle({ ...base(), resultAt: new Date('2026-11-01T11:00:00Z') })).toThrow(FhirInputError);
    expect(() => buildRelBundle({ ...base(), method: ' ' })).toThrow(FhirInputError);
    const b = buildRelBundle(base()) as unknown as { entry: { resource: Record<string, any> }[] };
    delete b.entry[2]!.resource.method;
    b.entry[2]!.resource.issued = '2026-11-01T12:20Z';
    const v = validateRndsBundle(b);
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => i.message)).toEqual(expect.arrayContaining(['Método obrigatório (texto)', 'Data e hora com segundos e fuso obrigatórias']));
    const comDisplay = buildRelBundle(base()) as unknown as { entry: { resource: Record<string, any> }[] };
    comDisplay.entry[3]!.resource.type.coding[0].display = 'Swab Nasofaríngeo';
    expect(validateRndsBundle(comDisplay).issues.map((i) => i.path)).toContain('Specimen.type.coding.display');
  });

  it('data e hora no fuso do estabelecimento, com segundos', () => {
    expect(fhirDateTimeLocal(new Date('2026-07-15T03:04:05.678Z'), 'America/Sao_Paulo')).toBe('2026-07-15T00:04:05-03:00');
    expect(fhirDateTimeLocal(new Date('2026-07-15T03:04:05Z'), 'America/Manaus')).toBe('2026-07-14T23:04:05-04:00');
  });
});
