import { describe, expect, it } from 'vitest';
import { buildRegulationBundle, CODE_SYSTEMS, FhirInputError, PROFILES, RIRA_IDENTIFIERS, validateRndsBundle } from '@omnisaude/fhir';
import type { Appointment, Composition, Condition, ServiceRequest } from 'fhir/r4';

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const meta = () => ({ rndsRequesterId: '12345', localId: `AMB_REG-2026-000001_${++counter}`, timestamp: new Date('2026-10-31T15:00:00Z'), uuid });
const base = () => ({
  ...meta(),
  patient: { cpf: '529.982.247-25', cns: '203456789010002' },
  author: { cnes: '9000044' },
  statusChangedBy: { cnes: '9000010' },
  modality: '09' as const,
  priority: 'routine' as const,
  procedure: { sigtapCode: '03.01.01.007-2', display: 'Consulta médica em atenção especializada' },
  requester: { cnes: '9000010', name: 'UBS Centro' },
  authoredOn: new Date('2026-10-20T13:00:00Z'),
  performerCbo: '225120',
  reason: { system: 'CID10' as const, code: 'I10' },
  regulator: { cnes: '9000044' },
});
const find = <T>(bundle: ReturnType<typeof buildRegulationBundle>, type: string) => bundle.entry!.find((e) => e.resource!.resourceType === type)!.resource as T;

describe('Registro de Regulação Assistencial (RIRA)', () => {
  it('pendente: Composition RA com evento pending apontando para a requisição; sem executante nem agendamento', () => {
    const bundle = buildRegulationBundle({ ...base(), status: 'pending', statusChangedAt: new Date('2026-10-20T13:00:00Z'), performer: { cnes: '9000052' }, appointment: { start: new Date() } });
    expect(bundle.type).toBe('document');
    expect(bundle.identifier).toEqual({ system: 'http://www.saude.gov.br/fhir/r4/NamingSystem/BRRNDS-12345', value: expect.stringMatching(/^AMB_REG-2026-000001_/) });
    const comp = find<Composition>(bundle, 'Composition');
    expect(bundle.entry![0]!.resource!.resourceType).toBe('Composition');
    expect(comp.meta?.profile).toEqual([PROFILES.regulationComposition]);
    expect(comp.type.coding?.[0]).toEqual({ system: CODE_SYSTEMS.tipoDocumento, code: 'RA' });
    expect(comp.category?.[0]?.coding?.[0]).toEqual({ system: CODE_SYSTEMS.modalidadeAssistencial, code: '09' });
    expect(comp.subject?.identifier).toEqual({ system: RIRA_IDENTIFIERS.individuo, value: '52998224725' });
    expect(comp.date).toBe('2026-10-31');
    expect(comp.author?.[0]?.identifier).toEqual({ system: RIRA_IDENTIFIERS.estabelecimento, value: '9000044' });
    expect(comp.title).toBe('Regulação Assistencial');
    const ev = comp.event![0]!;
    expect(ev.code?.[0]?.coding?.[0]).toEqual({ system: CODE_SYSTEMS.statusRegulacao, code: 'pending' });
    expect(ev.period?.end).toBe('2026-10-20T13:00:00Z');
    expect(ev.detail?.[0]?.identifier).toEqual({ system: RIRA_IDENTIFIERS.estabelecimento, value: '9000010' });
    const sr = find<ServiceRequest>(bundle, 'ServiceRequest');
    const appt = find<Appointment>(bundle, 'Appointment');
    const srUrn = bundle.entry!.find((e) => e.resource === sr)!.fullUrl;
    const apptUrn = bundle.entry!.find((e) => e.resource === appt)!.fullUrl;
    expect(ev.detail?.[1]?.reference).toBe(srUrn);
    expect(comp.section?.[0]?.entry?.[0]?.reference).toBe(apptUrn);
    expect(sr).toMatchObject({ status: 'active', intent: 'proposal', priority: 'routine', authoredOn: '2026-10-20T13:00:00Z' });
    expect(sr.code?.coding?.[0]).toMatchObject({ system: CODE_SYSTEMS.sigtap, code: '0301010072' });
    expect(sr.requester?.identifier?.value).toBe('9000010');
    expect(sr.performer).toBeUndefined();
    expect(sr.occurrenceDateTime).toBeUndefined();
    expect(sr.performerType?.coding?.[0]).toEqual({ system: CODE_SYSTEMS.cbo, code: '225120' });
    expect(appt).toMatchObject({ status: 'proposed', basedOn: [{ reference: srUrn }] });
    expect(appt.start).toBeUndefined();
    expect(appt.participant?.[0]).toMatchObject({ type: [{ coding: [{ system: CODE_SYSTEMS.tipoParticipante, code: 'PCT' }] }], actor: { identifier: { value: '52998224725' } }, status: 'accepted' });
    expect(appt.supportingInformation?.[0]?.identifier?.value).toBe('9000044');
    const cond = find<Condition>(bundle, 'Condition');
    expect(cond.code?.coding?.[0]).toMatchObject({ system: CODE_SYSTEMS.cid10, code: 'I10' });
    expect(sr.reasonReference?.[0]?.reference).toBe(bundle.entry!.find((e) => e.resource === cond)!.fullUrl);
    expect(validateRndsBundle(bundle)).toMatchObject({ valid: true });
  });

  it('agendada: executante, datas do agendamento e evento apontando para o Appointment', () => {
    const bundle = buildRegulationBundle({
      ...base(),
      status: 'booked',
      statusChangedAt: new Date('2026-10-22T10:00:00Z'),
      performer: { cnes: '9000052' },
      appointment: { start: new Date('2026-11-05T11:00:00Z'), end: new Date('2026-11-05T11:20:00Z'), created: new Date('2026-10-22T10:00:00Z') },
      replaces: 'Composition/abc-123',
    });
    const comp = find<Composition>(bundle, 'Composition');
    const appt = find<Appointment>(bundle, 'Appointment');
    const sr = find<ServiceRequest>(bundle, 'ServiceRequest');
    expect(comp.event![0]!.code?.[0]?.coding?.[0]?.code).toBe('booked');
    expect(comp.event![0]!.detail?.[1]?.reference).toBe(bundle.entry!.find((e) => e.resource === appt)!.fullUrl);
    expect(comp.relatesTo?.[0]).toEqual({ code: 'replaces', targetReference: { reference: 'Composition/abc-123' } });
    expect(appt).toMatchObject({ status: 'booked', start: '2026-11-05T11:00:00Z', end: '2026-11-05T11:20:00Z', created: '2026-10-22T10:00:00Z' });
    expect(sr.status).toBe('active');
    expect(sr.performer?.[0]?.identifier?.value).toBe('9000052');
    expect(validateRndsBundle(bundle)).toMatchObject({ valid: true });
  });

  it('atendida e falta: execução obrigatória; devolvida e cancelada só levam o estabelecimento no evento', () => {
    const atendida = buildRegulationBundle({
      ...base(),
      status: 'attended',
      statusChangedAt: new Date('2026-11-05T12:00:00Z'),
      performer: { cnes: '9000052' },
      appointment: { start: new Date('2026-11-05T11:00:00Z') },
      occurrence: new Date('2026-11-05T11:10:00Z'),
    });
    expect(find<ServiceRequest>(atendida, 'ServiceRequest')).toMatchObject({ status: 'completed', occurrenceDateTime: '2026-11-05T11:10:00Z' });
    expect(find<Appointment>(atendida, 'Appointment')).toMatchObject({ status: 'fulfilled', end: '2026-11-05T11:00:00Z' });
    const falta = buildRegulationBundle({
      ...base(),
      status: 'absence',
      statusChangedAt: new Date(),
      performer: { cnes: '9000052' },
      appointment: { start: new Date('2026-11-05T11:00:00Z') },
      occurrence: new Date('2026-11-05T11:00:00Z'),
    });
    expect(find<Appointment>(falta, 'Appointment').status).toBe('noshow');
    const devolvida = buildRegulationBundle({ ...base(), status: 'returned-to-requester', statusChangedAt: new Date() });
    expect(find<Composition>(devolvida, 'Composition').event![0]!.detail).toHaveLength(1);
    expect(find<ServiceRequest>(devolvida, 'ServiceRequest').status).toBe('on-hold');
    expect(find<Appointment>(devolvida, 'Appointment').status).toBe('waitlist');
    const cancelada = buildRegulationBundle({ ...base(), status: 'cancelled', statusChangedAt: new Date() });
    expect(find<ServiceRequest>(cancelada, 'ServiceRequest').status).toBe('revoked');
    expect(find<Appointment>(cancelada, 'Appointment').status).toBe('cancelled');
    for (const b of [atendida, falta, devolvida, cancelada]) expect(validateRndsBundle(b).valid).toBe(true);
  });

  it('leito: modalidade 04, urgência e paciente só com CNS', () => {
    const bundle = buildRegulationBundle({ ...base(), patient: { cns: '203456789010002' }, modality: '04', priority: 'urgent', status: 'pending', statusChangedAt: new Date(), reason: { system: 'CIAP2', code: 'K86' } });
    const comp = find<Composition>(bundle, 'Composition');
    expect(comp.subject?.identifier?.value).toBe('203456789010002');
    expect(comp.category?.[0]?.coding?.[0]?.code).toBe('04');
    expect(find<ServiceRequest>(bundle, 'ServiceRequest').priority).toBe('urgent');
    expect(find<Condition>(bundle, 'Condition').code?.coding?.[0]?.system).toBe(CODE_SYSTEMS.ciap2);
    expect(validateRndsBundle(bundle).valid).toBe(true);
  });

  it('recusa dados inconsistentes com as invariantes do MIRA', () => {
    expect(() => buildRegulationBundle({ ...base(), status: 'booked', statusChangedAt: new Date(), appointment: { start: new Date() } })).toThrow(FhirInputError);
    expect(() => buildRegulationBundle({ ...base(), status: 'attended', statusChangedAt: new Date(), performer: { cnes: '9000052' }, appointment: { start: new Date() } })).toThrow(/execução/);
    expect(() => buildRegulationBundle({ ...base(), reason: undefined, status: 'pending', statusChangedAt: new Date() })).toThrow(/motivo/i);
    expect(() => buildRegulationBundle({ ...base(), reason: undefined, authoredOn: new Date('2024-06-01T10:00:00Z'), status: 'pending', statusChangedAt: new Date() })).not.toThrow();
    expect(() => buildRegulationBundle({ ...base(), patient: { cpf: '111.111.111-11' }, status: 'pending', statusChangedAt: new Date() })).toThrow(/CPF ou CNS/);
    expect(() => buildRegulationBundle({ ...base(), requester: { cnes: '123' }, status: 'pending', statusChangedAt: new Date() })).toThrow(/CNES/);
    expect(() => buildRegulationBundle({ ...base(), procedure: { sigtapCode: '12' }, status: 'pending', statusChangedAt: new Date() })).toThrow(/SIGTAP/);
  });
});
