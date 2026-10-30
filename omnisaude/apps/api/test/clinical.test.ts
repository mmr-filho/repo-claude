import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();

describe.runIf(enabled)('prontuário, prescrição com copiloto e atestado', () => {
  let t: TestApp;
  let medica: string;
  let recepcao: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    t = await startTestApp('clinical');
    medica = await t.login('medica', 'UPA 24h Norte', 'MEDICO');
    recepcao = await t.login('recepcao', 'UPA 24h Norte', 'RECEPCAO');
  });
  afterAll(async () => {
    await t?.close();
  });

  const queueEncounter = async (name: string) => {
    const queue = (await t.http().get('/api/triage/queue').set(auth(medica)).expect(200)).body;
    return queue.awaitingDoctor.find((r: { patient: { name: string } }) => r.patient.name.startsWith(name)).encounterId as string;
  };

  it('registra SOAP, assina com hash na trilha, lança produção e enfileira o RAC para a RNDS', async () => {
    const encId = await queueEncounter('Carlos');
    await t.http().post(`/api/clinical/encounters/${encId}/start`).set(auth(medica)).expect(200);
    const note = await t.http()
      .post(`/api/clinical/encounters/${encId}/notes`)
      .set(auth(medica))
      .send({
        kind: 'SOAP',
        subjective: 'Dor torácica em aperto há 1 hora.',
        objective: 'PA 165 x 100 mmHg, FC 112 bpm. ECG sem supra de ST.',
        assessment: 'Crise hipertensiva sem lesão de órgão-alvo aparente.',
        plan: 'Anti-hipertensivo oral, observação e reavaliação em 1 hora.',
        codes: [{ system: 'CID10', code: 'I10' }],
      })
      .expect(201);
    const signed = await t.http().post(`/api/clinical/notes/${note.body.id}/sign`).set(auth(medica)).expect(200);
    expect(signed.body.status).toBe('ASSINADO');
    expect(signed.body.auditHash).toMatch(/^[0-9a-f]{64}$/);
    await t.http().patch(`/api/clinical/notes/${note.body.id}`).set(auth(medica)).send({ plan: 'alterado' }).expect(422);

    const tenants = t.app.get(TenantsService);
    const db = await tenants.client((await tenants.resolve(t.slug)).id);
    await expect(db.clinicalNote.update({ where: { id: note.body.id }, data: { plan: 'adulterado' } })).rejects.toThrow(/assinado/);
    expect(await db.outboxMessage.count({ where: { kind: 'RNDS_RAC', aggregateId: note.body.id } })).toBe(1);
    const prod = await db.productionRecord.findFirstOrThrow({ where: { encounterId: encId, procedureCode: '0301060061' } });
    expect(prod).toMatchObject({ cbo: '225125', cid: 'I10', instrument: 'BPA_I' });

    const enc = await t.http().get(`/api/clinical/encounters/${encId}`).set(auth(medica)).expect(200);
    expect(enc.body.notes[0].authorName).toBe('Carla Menezes Médica');
    await t.http().get(`/api/clinical/encounters/${encId}`).set(auth(recepcao)).expect(403);
  });

  it('exige justificativa para alerta crítico do copiloto (varfarina em uso + AAS)', async () => {
    const encId = await queueEncounter('Carlos').catch(async () => {
      const q = (await t.http().get('/api/triage/queue').set(auth(medica))).body;
      return q.inProgress.find((r: { patient: { name: string } }) => r.patient.name.startsWith('Carlos')).encounterId;
    });
    const item = { description: 'Ácido acetilsalicílico 100 mg', activeIngredient: 'acido acetilsalicilico', dose: 100, doseUnit: 'mg', route: 'ORAL', frequencyHours: 24, durationDays: 30 };
    const blocked = await t.http().post(`/api/clinical/encounters/${encId}/prescriptions`).set(auth(medica)).send({ items: [item] }).expect(422);
    expect(blocked.body.code).toBe('JUSTIFICATIVA_OBRIGATORIA');
    expect(blocked.body.details.alerts.some((a: { severity: string }) => a.severity === 'GRAVE')).toBe(true);
    const ok = await t.http()
      .post(`/api/clinical/encounters/${encId}/prescriptions`)
      .set(auth(medica))
      .send({ items: [item], justification: 'Síndrome coronariana em investigação; benefício supera o risco, com controle de INR.' })
      .expect(201);
    expect(ok.body.prescription.justification).toMatch(/Síndrome coronariana/);
    expect(ok.body.prescription.auditHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('alerta função renal com a creatinina registrada (metformina para Raimunda)', async () => {
    const [raimunda] = (await t.http().get('/api/patients?q=raimunda').set(auth(medica))).body;
    const res = await t.http()
      .post('/api/clinical/prescriptions/check')
      .set(auth(medica))
      .send({ patientId: raimunda.id, items: [{ description: 'Metformina 850 mg', activeIngredient: 'metformina', dose: 850, doseUnit: 'mg', route: 'ORAL', frequencyHours: 12 }] })
      .expect(200);
    expect(res.body.egfr.value).toBeLessThan(30);
    expect(res.body.alerts.some((a: { code: string }) => a.code === 'FUNCAO_RENAL')).toBe(true);
  });

  it('sugere linha de cuidado, estrutura o ditado e interpreta comandos de voz', async () => {
    const proto = await t.http().get('/api/clinical/protocols?code=I10').set(auth(medica)).expect(200);
    expect(proto.body.exams.map((e: { sigtapCode: string }) => e.sigtapCode)).toContain('02.02.01.031-0');
    const soap = await t.http()
      .post('/api/clinical/soap-from-transcript')
      .set(auth(medica))
      .send({ transcript: 'Paciente refere cefaleia há dois dias. Ao exame PA 150 por 95, frequência cardíaca 88. Hipótese de hipertensão descompensada. Prescrevo losartana e oriento retorno em 7 dias.' })
      .expect(200);
    expect(soap.body.source).toBe('heuristic');
    expect(soap.body.vitals.systolic).toBe(150);
    expect(soap.body.soap.plan).toMatch(/losartana/i);
    const cmd = await t.http().post('/api/clinical/voice-command').set(auth(medica)).send({ text: 'prescrever dipirona quinhentos miligramas de 6 em 6 horas' }).expect(200);
    expect(cmd.body).toMatchObject({ intent: 'PRESCREVER', args: { drug: 'dipirona', dose: 500, intervalHours: 6 } });
  });

  it('emite atestado sem CID por padrão e encerra o atendimento só sem rascunhos', async () => {
    const q = (await t.http().get('/api/triage/queue').set(auth(medica))).body;
    const encId = q.awaitingDoctor.find((r: { patient: { name: string } }) => r.patient.name.startsWith('Raimunda')).encounterId;
    await t.http().post(`/api/clinical/encounters/${encId}/start`).set(auth(medica)).expect(200);
    const cert = await t.http().post(`/api/clinical/encounters/${encId}/certificate`).set(auth(medica)).send({ days: 2, cid: 'R42', includeCid: false }).expect(201);
    expect(cert.body.printable.cid).toBeNull();
    expect(cert.body.printable.text).toMatch(/2 dia/);
    const draft = await t.http().post(`/api/clinical/encounters/${encId}/notes`).set(auth(medica)).send({ kind: 'SOAP', subjective: 'Tontura', assessment: 'Hiperglicemia', codes: [{ system: 'CID10', code: 'E11' }] }).expect(201);
    await t.http().post(`/api/clinical/encounters/${encId}/close`).set(auth(medica)).send({ outcome: 'ALTA' }).expect(422);
    await t.http().post(`/api/clinical/notes/${draft.body.id}/sign`).set(auth(medica)).expect(200);
    const closed = await t.http().post(`/api/clinical/encounters/${encId}/close`).set(auth(medica)).send({ outcome: 'ALTA', mainCid: 'E11' }).expect(200);
    expect(closed.body.status).toBe('ENCERRADO');
  });
});
