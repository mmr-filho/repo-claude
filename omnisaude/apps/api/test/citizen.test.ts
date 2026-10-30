import { cnsFromBase, completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();

describe.runIf(enabled)('cidadão: cadastro completo, CEP, domicílio e família, unificação', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let recepcao: string;
  let enfermeira: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  let joana: { id: string };
  let bia: { id: string };
  let familyId = '';
  let householdId = '';

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('citizen', { CEP_API_URL: `${mocks.url}/ws` });
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    enfermeira = await t.login('enfermeiro', 'UBS Centro', 'ENFERMAGEM');
  });
  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('consulta o endereço pelo CEP', async () => {
    const res = await t.http().get('/api/patients/cep/77405-070').set(auth(recepcao)).expect(200);
    expect(res.body).toMatchObject({ cep: '77405070', street: 'Rua de 14 Novembro', district: 'Setor Central', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' });
    await t.http().get('/api/patients/cep/99999999').set(auth(recepcao)).expect(404);
    await t.http().get('/api/patients/cep/123').set(auth(recepcao)).expect(422);
  });

  it('cadastra com documentos, dados sociais e endereço completo, e atualiza só o que mudou', async () => {
    const res = await t
      .http()
      .post('/api/patients')
      .set(auth(recepcao))
      .send({
        name: 'Joana Teste Cidadã',
        birthDate: '1990-02-03',
        sex: 'F',
        cpf: completeCpf('400000001'),
        rg: '1.234.567',
        rgIssuer: 'ssp',
        rgUf: 'TO',
        nis: '123.45678.90-1',
        education: '10',
        workSituation: '02',
        occupationCbo: '422105',
        homeless: false,
        phone: '(63) 99999-0000',
        address: { cep: '77405-070', street: 'Rua de 14 Novembro', number: '100', district: 'Setor Central', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' },
      })
      .expect(201);
    joana = res.body;
    const got = await t.http().get(`/api/patients/${joana.id}`).set(auth(recepcao)).expect(200);
    expect(got.body).toMatchObject({ rg: '1.234.567', rgIssuer: 'SSP', rgUf: 'TO', nis: '12345678901', education: '10', workSituation: '02', occupationCbo: '422105', homeless: false, family: null, redirectedFromId: null });
    expect(got.body.address).toMatchObject({ cep: '77405070', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500', number: '100' });
    await t.http().patch(`/api/patients/${joana.id}`).set(auth(recepcao)).send({ education: '13', address: { number: '120' } }).expect(200);
    const again = await t.http().get(`/api/patients/${joana.id}`).set(auth(recepcao)).expect(200);
    expect(again.body.education).toBe('13');
    expect(again.body.address).toMatchObject({ street: 'Rua de 14 Novembro', number: '120', city: 'Gurupi' });
    await t.http().post('/api/patients').set(auth(recepcao)).send({ name: 'Escolaridade Inválida Teste', birthDate: '1990-01-01', sex: 'M', education: '42' }).expect(400);
  });

  it('cria o domicílio com a família, inclui um membro, edita e remove', async () => {
    const res = await t
      .http()
      .post('/api/households')
      .set(auth(recepcao))
      .send({ cep: '77405070', street: 'Rua de 14 Novembro', number: '120', district: 'Setor Central', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500', dwellingType: '01', tenure: '01', waterSupply: '01', sewage: '01', garbage: '01', electricity: true, rooms: 5, family: { responsibleId: joana.id, incomeBracket: '03' } })
      .expect(201);
    householdId = res.body.id;
    expect(res.body.addressLine).toBe('Rua de 14 Novembro, 120, Setor Central');
    expect(res.body.families).toHaveLength(1);
    familyId = res.body.families[0].id;
    expect(res.body.families[0].responsible.id).toBe(joana.id);
    expect(res.body.families[0].members[0]).toMatchObject({ id: joana.id, kinship: '00' });

    bia = (await t.http().post('/api/patients').set(auth(recepcao)).send({ name: 'Bia Teste Cidadã', birthDate: '2015-06-07', sex: 'F', motherName: 'Joana Teste Cidadã' }).expect(201)).body;
    const fam = await t.http().post(`/api/families/${familyId}/members`).set(auth(recepcao)).send({ patientId: bia.id, kinship: '02' }).expect(201);
    expect(fam.body.members).toHaveLength(2);
    const biaDetail = await t.http().get(`/api/patients/${bia.id}`).set(auth(recepcao)).expect(200);
    expect(biaDetail.body.kinship).toBe('02');
    expect(biaDetail.body.family).toMatchObject({ id: familyId, responsible: { id: joana.id }, household: { id: householdId, tenure: '01', rooms: 5 } });

    const upd = await t.http().patch(`/api/households/${householdId}`).set(auth(recepcao)).send({ rooms: 4, animals: '1 cachorro' }).expect(200);
    expect(upd.body).toMatchObject({ rooms: 4, animals: '1 cachorro', street: 'Rua de 14 Novembro' });
    const search = await t.http().get('/api/households?q=Novembro').set(auth(recepcao)).expect(200);
    expect(search.body.map((h: { id: string }) => h.id)).toContain(householdId);

    const removed = await t.http().delete(`/api/families/${familyId}/members/${bia.id}`).set(auth(recepcao)).expect(200);
    expect(removed.body.members).toHaveLength(1);
    expect((await t.http().get(`/api/patients/${bia.id}`).set(auth(recepcao))).body.family).toBeNull();
    // Trocar o responsável mantém o anterior na família como outro parente.
    await t.http().post(`/api/families/${familyId}/members`).set(auth(recepcao)).send({ patientId: bia.id, kinship: '00' }).expect(201);
    const after = await t.http().get(`/api/households/${householdId}`).set(auth(recepcao)).expect(200);
    expect(after.body.families[0].responsible.id).toBe(bia.id);
    expect(after.body.families[0].members.find((m: { id: string }) => m.id === joana.id).kinship).toBe('09');
  });

  it('lista possíveis duplicidades e unifica os cadastros, levando o histórico junto', async () => {
    const a = (await t.http().post('/api/patients').set(auth(recepcao)).send({ name: 'Carlos Teste Duplicado', birthDate: '1980-05-05', sex: 'M', phone: '63988880000' }).expect(201)).body;
    const dupAttempt = await t.http().post('/api/patients').set(auth(recepcao)).send({ name: 'Carlos Teste Duplicado', birthDate: '1980-05-05', sex: 'M' }).expect(409);
    expect(dupAttempt.body.details.needsConfirmation).toBe(true);
    const b = (await t.http().post('/api/patients').set(auth(recepcao)).send({ name: 'Carlos Teste Duplicado', birthDate: '1980-05-05', sex: 'M', cns: cnsFromBase('29876543210'), email: 'carlos@exemplo.com', confirmNotDuplicate: true }).expect(201)).body;
    await t.http().post(`/api/patients/${b.id}/allergies`).set(auth(enfermeira)).send({ substance: 'Dipirona' }).expect(201);

    const cand = await t.http().get('/api/patients/duplicates/candidates').set(auth(recepcao)).expect(200);
    const group = cand.body.find((g: { name: string }) => g.name === 'Carlos Teste Duplicado');
    expect(group.patients).toHaveLength(2);
    expect(group.patients.map((p: { id: string }) => p.id).sort()).toEqual([a.id, b.id].sort());

    const merged = await t.http().post(`/api/patients/${a.id}/merge`).set(auth(recepcao)).send({ duplicateId: b.id }).expect(201);
    expect(merged.body.moved.allergies).toBe(1);
    expect(merged.body.filled).toEqual(expect.arrayContaining(['cns', 'email']));
    const survivor = await t.http().get(`/api/patients/${a.id}`).set(auth(recepcao)).expect(200);
    expect(survivor.body).toMatchObject({ cns: cnsFromBase('29876543210'), email: 'carlos@exemplo.com', phone: '63988880000' });
    expect(survivor.body.allergies.map((x: { substance: string }) => x.substance)).toEqual(['dipirona']);
    const redirected = await t.http().get(`/api/patients/${b.id}`).set(auth(recepcao)).expect(200);
    expect(redirected.body).toMatchObject({ id: a.id, redirectedFromId: b.id });
    const search = await t.http().get('/api/patients?q=Carlos Teste Duplicado').set(auth(recepcao)).expect(200);
    expect(search.body).toHaveLength(1);
    expect((await t.http().get('/api/patients/duplicates/candidates').set(auth(recepcao)).expect(200)).body.find((g: { name: string }) => g.name === 'Carlos Teste Duplicado')).toBeUndefined();
    // O duplicado não recebe novos registros nem pode ser unificado de novo.
    await t.http().post(`/api/patients/${b.id}/allergies`).set(auth(enfermeira)).send({ substance: 'Látex' }).expect(409);
    await t.http().post(`/api/patients/${a.id}/merge`).set(auth(recepcao)).send({ duplicateId: b.id }).expect(404);
    await t.http().post(`/api/patients/${a.id}/merge`).set(auth(recepcao)).send({ duplicateId: a.id }).expect(422);
    const medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    await t.http().post(`/api/patients/${a.id}/merge`).set(auth(medica)).send({ duplicateId: b.id }).expect(403);
  });
});
