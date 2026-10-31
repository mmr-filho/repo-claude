import { createHmac } from 'node:crypto';
import { localDateString } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { MessagingService } from '../src/modules/integrations/messaging.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();
const APP_SECRET = 'segredo-do-app-whatsapp';

/** Próximo dia útil (seg-sex) a pelo menos `minDays` de hoje. */
function nextWeekday(minDays: number) {
  const d = new Date(Date.now() + minDays * 86_400_000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return localDateString(d);
}

describe.runIf(enabled)('agenda e confirmação por WhatsApp', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let recepcao: string;
  let gestora: string;
  let scheduleId: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('scheduling', { MOCKS_URL: mocks.url, WHATSAPP_APP_SECRET: APP_SECRET });
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    const schedules = await t.http().get('/api/scheduling/schedules').set(auth(recepcao)).expect(200);
    scheduleId = schedules.body[0].id;
  });
  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  const patient = async (q: string) =>
    (
      await t
        .http()
        .get(`/api/patients?q=${encodeURIComponent(q)}`)
        .set(auth(recepcao))
        .expect(200)
    ).body[0];

  it('calcula os horários do dia a partir da grade', async () => {
    const date = nextWeekday(5);
    const res = await t.http().get(`/api/scheduling/schedules/${scheduleId}/slots?date=${date}`).set(auth(recepcao)).expect(200);
    expect(res.body.slots).toHaveLength(12); // 07:00-11:00 em blocos de 20 min
    expect(res.body.quotas[0].firstVisit.quota).toBe(6);
    expect(new Date(res.body.slots[0].startsAt).toISOString()).toBe(`${date}T10:00:00.000Z`); // 07:00 em Brasília
  });

  it('marca, respeita cotas e bloqueios', async () => {
    const date = nextWeekday(6);
    const created = await t
      .http()
      .post('/api/scheduling/schedules')
      .set(auth(gestora))
      .send({
        professionalId: (await t.http().get('/api/scheduling/schedules').set(auth(recepcao))).body[0].professionalId,
        name: 'Agenda teste de cotas',
        cbo: '225125',
        slotMinutes: 30,
        rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '13:00', endTime: '15:00', firstVisitQuota: 0, returnQuota: 1 })),
      })
      .expect(201);
    const slots = (await t.http().get(`/api/scheduling/schedules/${created.body.id}/slots?date=${date}`).set(auth(recepcao))).body.slots;
    const thiago = await patient('thiago');
    const pedro = await patient('pedro henrique');
    await t.http().post('/api/scheduling/appointments').set(auth(recepcao)).send({ scheduleId: created.body.id, patientId: thiago.id, startsAt: slots[0].startsAt, kind: 'PRIMEIRA_CONSULTA' }).expect(422);
    await t.http().post('/api/scheduling/appointments').set(auth(recepcao)).send({ scheduleId: created.body.id, patientId: thiago.id, startsAt: slots[0].startsAt, kind: 'RETORNO' }).expect(201);
    const full = await t.http().post('/api/scheduling/appointments').set(auth(recepcao)).send({ scheduleId: created.body.id, patientId: pedro.id, startsAt: slots[1].startsAt, kind: 'RETORNO' }).expect(422);
    expect(full.body.code).toBe('COTA_ESGOTADA');
    await t.http().post(`/api/scheduling/schedules/${created.body.id}/blocks`).set(auth(gestora)).send({ startsAt: slots[2].startsAt, endsAt: slots[3].endsAt, reason: 'Reunião de equipe' }).expect(201);
    const after = (await t.http().get(`/api/scheduling/schedules/${created.body.id}/slots?date=${date}`).set(auth(recepcao))).body.slots;
    expect(after.map((s: { status: string }) => s.status)).toEqual(['OCUPADO', 'LIVRE', 'BLOQUEADO', 'BLOQUEADO']);
  });

  it('agenda a confirmação 48h antes, envia fora da janela de silêncio e processa a resposta assinada', async () => {
    const maria = await patient('luana costa');
    // Primeiro dia útil, a partir de 48h, em que a agenda da carga de demonstração tem horário livre.
    let free: { startsAt: string } | undefined;
    for (let days = 2; days < 16 && !free; days++) {
      const slots = (
        await t
          .http()
          .get(`/api/scheduling/schedules/${scheduleId}/slots?date=${nextWeekday(days)}`)
          .set(auth(recepcao))
      ).body.slots as { status: string; startsAt: string }[];
      free = slots.find((s) => s.status === 'LIVRE');
    }
    if (!free) throw new Error('Nenhum horário livre nas próximas duas semanas');
    const appt = await t.http().post('/api/scheduling/appointments').set(auth(recepcao)).send({ scheduleId, patientId: maria.id, startsAt: free.startsAt, kind: 'RETORNO' }).expect(201);

    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    const sys = { tenant, db: await tenants.client(tenant.id) };
    const log = await sys.db.messageLog.findFirstOrThrow({ where: { refId: appt.body.id, kind: 'CONFIRMACAO_CONSULTA' } });
    const local = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(log.scheduledFor);
    expect(local >= '06:01' && local < '22:00').toBe(true);

    const messaging = t.app.get(MessagingService);
    const result = await messaging.dispatchDue(sys, new Date(log.scheduledFor.getTime() + 60_000));
    expect(result.sent).toBeGreaterThanOrEqual(1);
    const sent = mocks.state.whatsapp.find((m) => m.to === '5511990000005' && m.type === 'template');
    expect(sent).toBeTruthy();

    const webhook = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '1' },
                messages: [{ from: '5511990000005', id: 'wamid.resp1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'button', button: { payload: `APPT:CONFIRM:${appt.body.id}`, text: 'Confirmar' } }],
              },
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(webhook);
    await t.http().post(`/api/webhooks/whatsapp/${t.slug}`).set('content-type', 'application/json').set('x-hub-signature-256', 'sha256=00').send(raw).expect(401);
    const sig = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
    await t.http().post(`/api/webhooks/whatsapp/${t.slug}`).set('content-type', 'application/json').set('x-hub-signature-256', sig).send(raw).expect(200);
    const list = await t.http().get(`/api/scheduling/appointments?patientId=${maria.id}`).set(auth(recepcao)).expect(200);
    expect(list.body.find((a: { id: string }) => a.id === appt.body.id).status).toBe('CONFIRMADO');
  });

  it('cancela, libera a vaga para a lista de espera e registra a chegada de outro paciente', async () => {
    const pedro = await patient('pedro henrique');
    const entry = await t.http().post('/api/scheduling/waitlist').set(auth(recepcao)).send({ patientId: pedro.id, cbo: '225125', priority: 2, reason: 'Asma de difícil controle' }).expect(201);
    const juliana = await patient('juliana rocha');
    const [appt] = (await t.http().get(`/api/scheduling/appointments?patientId=${juliana.id}`).set(auth(recepcao))).body;
    const cancel = await t.http().post(`/api/scheduling/appointments/${appt.id}/cancel`).set(auth(recepcao)).send({ reason: 'Paciente viajou' }).expect(200);
    expect(cancel.body.offeredTo).toBe(entry.body.id);
    const jose = await patient('jose carlos');
    const [joseAppt] = (await t.http().get(`/api/scheduling/appointments?patientId=${jose.id}&status=CONFIRMADO`).set(auth(recepcao))).body;
    const enc = await t.http().post(`/api/scheduling/appointments/${joseAppt.id}/check-in`).set(auth(recepcao)).expect(201);
    expect(enc.body.kind).toBe('AMBULATORIAL');
  });
});
