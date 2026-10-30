import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealtimeService } from '../src/core/realtime.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();

describe.runIf(enabled)('recepção, senhas e classificação de risco', () => {
  let t: TestApp;
  let recepcao: string;
  let enfermeiro: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    t = await startTestApp('reception');
    recepcao = await t.login('recepcao', 'UPA 24h Norte', 'RECEPCAO');
    enfermeiro = await t.login('enfermeiro', 'UPA 24h Norte', 'ENFERMAGEM');
  });
  afterAll(async () => {
    await t?.close();
  });

  it('emite senhas, chama a prioridade primeiro e publica no painel com texto para voz', async () => {
    const n = await t.http().post('/api/reception/tickets').set(auth(recepcao)).send({ kind: 'NORMAL' }).expect(201);
    const p = await t.http().post('/api/reception/tickets').set(auth(recepcao)).send({ kind: 'PRIORIDADE' }).expect(201);
    expect(n.body.code).toBe('N004'); // a carga de demonstração já usou N001-N003 hoje
    expect(p.body.code).toBe('P001');
    const called = await t.http().post('/api/reception/tickets/call-next').set(auth(recepcao)).send({ desk: 'Guichê 2' }).expect(200);
    expect(called.body.code).toBe('P001');
    expect(called.body.speech).toBe('Senha P, 0, 0, 1. Guichê 2.');
    const events = t.app.get(RealtimeService).recent.filter((e) => e.event === 'senha.chamada');
    expect(events.at(-1)?.payload).toMatchObject({ code: 'P001', desk: 'Guichê 2' });

    const { body: panel } = await t.http().post('/api/reception/panel-token').set(auth(recepcao)).expect(201);
    const state = await t.http().get(`/api/reception/panel?token=${panel.token}`).expect(200);
    expect(state.body.unitName).toBe('UPA 24h Norte');
    expect(state.body.lastCalls[0].code).toBe('P001');
    // O token do painel não abre a API.
    await t.http().get('/api/patients?q=maria').set(auth(panel.token)).expect(401);
  });

  it('acolhe, classifica e ordena a fila por gravidade', async () => {
    const [pedro] = (await t.http().get('/api/patients?q=pedro henrique').set(auth(recepcao))).body;
    const ticket = await t.http().post('/api/reception/tickets').set(auth(recepcao)).send({ kind: 'NORMAL' }).expect(201);
    const enc = await t.http().post('/api/reception/check-in').set(auth(recepcao)).send({ patientId: pedro.id, kind: 'URGENCIA', ticketId: ticket.body.id }).expect(201);
    await t.http().post('/api/reception/check-in').set(auth(recepcao)).send({ patientId: pedro.id, kind: 'URGENCIA' }).expect(409);

    let queue = (await t.http().get('/api/triage/queue').set(auth(enfermeiro)).expect(200)).body;
    expect(queue.awaitingTriage.map((r: { encounterId: string }) => r.encounterId)).toContain(enc.body.id);

    const sug = await t.http().post('/api/triage/suggest').set(auth(enfermeiro)).send({ spo2: 88, respiratoryRate: 28 }).expect(200);
    expect(sug.body.color).toBe('LARANJA');

    const base = {
      complaint: 'Falta de ar há 2 horas',
      spo2: 88,
      respiratoryRate: 28,
      heartRate: 120,
      glucose: 110,
      painMap: [{ view: 'FRENTE', region: 'torax', x: 0.5, y: 0.32, intensity: 4 }],
    };
    const refused = await t.http().post(`/api/triage/encounters/${enc.body.id}`).set(auth(enfermeiro)).send({ ...base, riskColor: 'VERDE' }).expect(422);
    expect(refused.body.code).toBe('JUSTIFICATIVA_OBRIGATORIA');
    const ok = await t.http().post(`/api/triage/encounters/${enc.body.id}`).set(auth(enfermeiro)).send(base).expect(201);
    expect(ok.body.triage.riskColor).toBe('LARANJA');
    expect(ok.body.maxWaitMinutes).toBe(10);
    expect(ok.body.triage.painScore).toBe(4);

    queue = (await t.http().get('/api/triage/queue').set(auth(enfermeiro)).expect(200)).body;
    const colors = queue.awaitingDoctor.map((r: { triage: { color: string } }) => r.triage.color);
    expect(colors).toEqual(['LARANJA', 'LARANJA', 'AMARELO']);
    expect(queue.awaitingDoctor[1].encounterId).toBe(enc.body.id); // mesma cor: quem chegou antes vem primeiro

    // A recepção não classifica risco.
    await t.http().post(`/api/triage/encounters/${enc.body.id}`).set(auth(recepcao)).send(base).expect(403);
  });
});
