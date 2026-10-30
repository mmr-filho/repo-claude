import type { TenantClient } from '@omnisaude/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { RealtimeService } from '../src/core/realtime.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();

describe.runIf(enabled)('leitos e NIR', () => {
  let t: TestApp;
  let db: TenantClient;
  let nir: string;
  let medica: string;
  let recepcao: string;
  const bed = (code: string) => db.bed.findFirstOrThrow({ where: { code } });
  const patient = (name: string) => db.patient.findFirstOrThrow({ where: { name } });

  beforeAll(async () => {
    t = await startTestApp('beds');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    nir = await t.login('nir', 'Hospital Municipal São Lucas', 'NIR');
    medica = await t.login('medica', 'Hospital Municipal São Lucas', 'MEDICO');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
  });
  afterAll(async () => {
    await t?.close();
  });

  it('mostra o censo com ocupante, totais e taxa de ocupação', async () => {
    const res = await t.http().get('/api/beds/census').set('authorization', `Bearer ${nir}`).expect(200);
    expect(res.body.unit.name).toBe('Hospital Municipal São Lucas');
    expect(res.body.totals.total).toBe(25);
    expect(res.body.totals.BLOQUEADO).toBe(1);
    const cm03 = res.body.wards.flatMap((w: { beds: unknown[] }) => w.beds).find((b: { code: string }) => b.code === 'CM-03');
    expect(cm03.occupant).toMatchObject({ name: 'Francisco Souza Santos', mainCid: 'J18' });
    expect(cm03.occupant.daysAdmitted).toBeGreaterThanOrEqual(1);
    expect(res.body.occupancyRate).toBeCloseTo((res.body.totals.OCUPADO / 24) * 100, 0);
    await t.http().get('/api/beds/census').set('authorization', `Bearer ${recepcao}`).expect(403);
  });

  it('controla as transições manuais de situação', async () => {
    const cm05 = await bed('CM-05');
    const ok = await t.http().patch(`/api/beds/${cm05.id}`).set('authorization', `Bearer ${nir}`).send({ status: 'VAGO', reason: 'Higienização concluída' }).expect(200);
    expect(ok.body.status).toBe('VAGO');
    const toOccupied = await t.http().patch(`/api/beds/${cm05.id}`).set('authorization', `Bearer ${nir}`).send({ status: 'OCUPADO' }).expect(422);
    expect(toOccupied.body.code).toBe('LEITO_TRANSICAO');
    const cm03 = await bed('CM-03');
    const occupied = await t.http().patch(`/api/beds/${cm03.id}`).set('authorization', `Bearer ${nir}`).send({ status: 'VAGO' }).expect(422);
    expect(occupied.body.code).toBe('LEITO_OCUPADO');
    // Isolamento pode ser marcado em leito ocupado.
    await t.http().patch(`/api/beds/${cm03.id}`).set('authorization', `Bearer ${nir}`).send({ isolation: 'GOTICULAS', reason: 'Suspeita de influenza' }).expect(200);
    const history = await t.http().get(`/api/beds/${cm05.id}/history`).set('authorization', `Bearer ${nir}`).expect(200);
    expect(history.body[0].reason).toBe('Higienização concluída');
    const realtime = t.app.get(RealtimeService);
    expect(realtime.recent.some((e) => e.event === 'censo')).toBe(true);
  });

  it('interna a partir do atendimento da UPA, transfere de leito e dá alta', async () => {
    const carlos = await patient('Carlos Eduardo Martins');
    const upaEncounter = await db.encounter.findFirstOrThrow({ where: { patientId: carlos.id, kind: 'URGENCIA' } });
    const cm04 = await bed('CM-04');
    const adm = await t.http()
      .post('/api/admissions')
      .set('authorization', `Bearer ${nir}`)
      .send({ encounterId: upaEncounter.id, bedId: cm04.id, mainCid: 'I20', regulationCode: 'SISREG-2026-0001' })
      .expect(201);
    expect((await bed('CM-04')).status).toBe('OCUPADO');
    const upa = await db.encounter.findUniqueOrThrow({ where: { id: upaEncounter.id } });
    expect(upa).toMatchObject({ status: 'ENCERRADO', outcome: 'INTERNACAO' });
    const internacao = await db.encounter.findUniqueOrThrow({ where: { id: adm.body.encounterId } });
    expect(internacao.kind).toBe('INTERNACAO');

    const twice = await t.http().post('/api/admissions').set('authorization', `Bearer ${nir}`).send({ patientId: carlos.id, bedId: (await bed('CM-06')).id, mainCid: 'I20' }).expect(409);
    expect(twice.body.code).toBe('CONFLITO');
    const busy = await t.http().post('/api/admissions').set('authorization', `Bearer ${nir}`).send({ patientId: (await patient('Thiago Nascimento')).id, bedId: cm04.id, mainCid: 'R50' }).expect(422);
    expect(busy.body.code).toBe('LEITO_INDISPONIVEL');

    const cm06 = await bed('CM-06');
    await t.http().post(`/api/admissions/${adm.body.id}/transfer`).set('authorization', `Bearer ${nir}`).send({ bedId: cm06.id, reason: 'Proximidade do posto' }).expect(200);
    expect((await bed('CM-04')).status).toBe('HIGIENIZACAO');
    expect((await bed('CM-06')).status).toBe('OCUPADO');

    const outbox = await db.outboxMessage.count({ where: { kind: 'RNDS_SUMARIO_ALTA' } });
    const alta = await t.http()
      .post(`/api/admissions/${adm.body.id}/discharge`)
      .set('authorization', `Bearer ${medica}`)
      .send({ summary: 'Dor torácica investigada, sem lesão miocárdica. Alta com seguimento ambulatorial.', diagnoses: ['I20', 'I10'], followUp: 'Cardiologia em 30 dias' })
      .expect(200);
    expect(alta.body.pendingUnitDoses).toEqual([]);
    expect((await bed('CM-06')).status).toBe('HIGIENIZACAO');
    expect((await db.encounter.findUniqueOrThrow({ where: { id: adm.body.encounterId } })).status).toBe('ENCERRADO');
    const msg = await db.outboxMessage.findFirstOrThrow({ where: { kind: 'RNDS_SUMARIO_ALTA', aggregateId: adm.body.id } });
    expect((msg.payload as { diagnoses: string[] }).diagnoses).toEqual(['I20', 'I10']);
    expect(await db.outboxMessage.count({ where: { kind: 'RNDS_SUMARIO_ALTA' } })).toBe(outbox + 1);
    await t.http().post(`/api/admissions/${adm.body.id}/discharge`).set('authorization', `Bearer ${medica}`).send({ summary: 'Duplicada para teste' }).expect(422);
  });

  it('respeita o isolamento do leito', async () => {
    const raimunda = await patient('Raimunda Oliveira');
    const cm08 = await bed('CM-08');
    const wrong = await t.http().post('/api/admissions').set('authorization', `Bearer ${nir}`).send({ patientId: raimunda.id, bedId: cm08.id, mainCid: 'E11' }).expect(422);
    expect(wrong.body.code).toBe('ISOLAMENTO_INCOMPATIVEL');
    await t.http().post('/api/admissions').set('authorization', `Bearer ${nir}`).send({ patientId: raimunda.id, bedId: cm08.id, mainCid: 'E11', isolation: 'CONTATO' }).expect(201);
    const list = await t.http().get('/api/admissions').set('authorization', `Bearer ${nir}`).expect(200);
    expect(list.body.map((a: { patientName: string }) => a.patientName)).toContain('Raimunda Oliveira');
  });

  it('na alta lista as doses unitárias pendentes no posto', async () => {
    const francisco = await patient('Francisco Souza Santos');
    const adm = await db.admission.findFirstOrThrow({ where: { patientId: francisco.id, dischargedAt: null } });
    const res = await t.http().post(`/api/admissions/${adm.id}/discharge`).set('authorization', `Bearer ${nir}`).send({ summary: 'Pneumonia tratada com boa evolução clínica.' }).expect(200);
    expect(res.body.pendingUnitDoses.length).toBe(12);
    expect(await db.prescription.count({ where: { patientId: francisco.id, kind: 'HOSPITALAR', status: 'ATIVA' } })).toBe(0);
  });
});
