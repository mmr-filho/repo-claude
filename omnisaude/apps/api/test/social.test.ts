import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();

describe.runIf(enabled)('serviço social: busca ativa', () => {
  let t: TestApp;
  let social: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    t = await startTestApp('social');
    social = await t.login('social', 'UBS Centro', 'SERVICO_SOCIAL');
  });
  afterAll(async () => {
    await t?.close();
  });

  it('lista crônicos e gestantes com retorno em atraso ou falta recente', async () => {
    const res = await t.http().get('/api/social/active-search').set(auth(social)).expect(200);
    const names = new Set(res.body.items.map((i: { name: string }) => i.name));
    for (const n of ['Maria Aparecida da Silva', 'José Carlos Pereira', 'Luana Costa Ribeiro', 'Sebastião Barbosa', 'Fernanda Gomes Araújo']) {
      expect(names).toContain(n);
    }
    // Atendidos recentemente (consulta há 75 dias, UPA hoje, internação) não aparecem.
    for (const n of ['Antônia Ferreira Lima', 'Raimunda Oliveira', 'Carlos Eduardo Martins', 'Francisco Souza Santos']) {
      expect(names).not.toContain(n);
    }
    const fernanda = res.body.items.find((i: { name: string; lineOfCare: string }) => i.name === 'Fernanda Gomes Araújo' && i.lineOfCare === 'DIABETES');
    expect(fernanda.reasons).toEqual(['RETORNO_ATRASADO', 'FALTA_RECENTE']);
    expect(fernanda.case.status).toBe('EM_CONTATO');
    expect(fernanda.daysOverdue).toBeGreaterThan(70);

    const gestantes = await t.http().get('/api/social/active-search?lineOfCare=GESTANTE').set(auth(social)).expect(200);
    expect(gestantes.body.items.map((i: { name: string }) => i.name)).toEqual(['Luana Costa Ribeiro']);
    expect(gestantes.body.items[0].thresholdDays).toBe(30);
  });

  it('registra o caso, os contatos com vulnerabilidades e o encerramento', async () => {
    const panel = await t.http().get('/api/social/active-search?lineOfCare=HIPERTENSAO').set(auth(social)).expect(200);
    const maria = panel.body.items.find((i: { name: string }) => i.name === 'Maria Aparecida da Silva');
    const opened = await t.http().post('/api/social/cases').set(auth(social)).send({ patientId: maria.patientId, lineOfCare: 'HIPERTENSAO' }).expect(201);
    expect(opened.body.status).toBe('ABERTO');
    await t.http().post('/api/social/cases').set(auth(social)).send({ patientId: maria.patientId, lineOfCare: 'HIPERTENSAO' }).expect(409);

    const c1 = await t
      .http()
      .post(`/api/social/cases/${opened.body.id}/contacts`)
      .set(auth(social))
      .send({ channel: 'TELEFONE', outcome: 'Paciente sem condução até a UBS', vulnerabilities: ['TRANSPORTE'], actions: ['TRANSPORTE_SANITARIO'] })
      .expect(201);
    expect(c1.body.status).toBe('EM_CONTATO');
    const c2 = await t
      .http()
      .post(`/api/social/cases/${opened.body.id}/contacts`)
      .set(auth(social))
      .send({ channel: 'VISITA_DOMICILIAR', outcome: 'Consulta marcada com transporte', vulnerabilities: [], actions: ['CONSULTA_AGENDADA'], notes: 'Retorno na próxima semana' })
      .expect(201);
    expect(c2.body.status).toBe('AGENDADO');
    await t.http().post(`/api/social/cases/${opened.body.id}/contacts`).set(auth(social)).send({ channel: 'POMBO', outcome: 'x' }).expect(400);

    const detail = await t.http().get(`/api/social/cases/${opened.body.id}`).set(auth(social)).expect(200);
    expect(detail.body.contacts).toHaveLength(2);
    expect(detail.body.contacts[0].vulnerabilities).toEqual(['TRANSPORTE']);
    expect(detail.body.contacts[0].userName).toBe('Elisa Ramos Assistente Social');

    const list = await t.http().get('/api/social/cases').set(auth(social)).expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).toContain(opened.body.id);

    await t.http().post(`/api/social/cases/${opened.body.id}/close`).set(auth(social)).send({ reason: 'Paciente retomou acompanhamento' }).expect(200);
    await t.http().post(`/api/social/cases/${opened.body.id}/contacts`).set(auth(social)).send({ channel: 'TELEFONE', outcome: 'Nova tentativa', vulnerabilities: [], actions: [] }).expect(422);
    const closed = await t.http().get('/api/social/cases?status=ENCERRADO').set(auth(social)).expect(200);
    expect(closed.body).toHaveLength(1);
  });

  it('é restrito ao serviço social e à gestão', async () => {
    const recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    await t.http().get('/api/social/active-search').set(auth(recepcao)).expect(403);
    const gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    await t.http().get('/api/social/cases').set(auth(gestora)).expect(200);
  });
});
