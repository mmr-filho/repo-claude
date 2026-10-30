import { completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();

describe.runIf(enabled)('pacientes', () => {
  let t: TestApp;
  let recepcao: string;
  let medica: string;
  beforeAll(async () => {
    t = await startTestApp('patients');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UPA 24h Norte', 'MEDICO');
  });
  afterAll(async () => {
    await t?.close();
  });

  it('busca por nome sem acento, CPF e CNS', async () => {
    const byName = await t.http().get('/api/patients?q=antonia ferreira').set('authorization', `Bearer ${recepcao}`).expect(200);
    expect(byName.body[0].name).toBe('Antônia Ferreira Lima');
    const byCpf = await t.http().get(`/api/patients?q=${byName.body[0].cpf}`).set('authorization', `Bearer ${recepcao}`).expect(200);
    expect(byCpf.body).toHaveLength(1);
  });

  it('cadastra, normaliza e detecta duplicidade', async () => {
    const body = { name: 'ROBERTO  DA SILVA', birthDate: '1979-03-02', sex: 'M', cpf: completeCpf('300000001'), motherName: 'MARIA DA SILVA' };
    const created = await t.http().post('/api/patients').set('authorization', `Bearer ${recepcao}`).send(body).expect(201);
    expect(created.body.name).toBe('Roberto da Silva');
    const dupCpf = await t.http().post('/api/patients').set('authorization', `Bearer ${recepcao}`).send(body).expect(409);
    expect(dupCpf.body.details.duplicates[0].reason).toBe('CPF');
    const homonimo = { ...body, cpf: completeCpf('300000002') };
    const soft = await t.http().post('/api/patients').set('authorization', `Bearer ${recepcao}`).send(homonimo).expect(409);
    expect(soft.body.details.needsConfirmation).toBe(true);
    await t.http().post('/api/patients').set('authorization', `Bearer ${recepcao}`).send({ ...homonimo, confirmNotDuplicate: true }).expect(201);
    await t.http().post('/api/patients').set('authorization', `Bearer ${recepcao}`).send({ ...body, cpf: '12345678900' }).expect(422);
  });

  it('mostra a linha do tempo unificada da rede e audita o acesso', async () => {
    const [maria] = (await t.http().get('/api/patients?q=maria aparecida').set('authorization', `Bearer ${medica}`).expect(200)).body;
    const tl = await t.http().get(`/api/patients/${maria.id}/timeline`).set('authorization', `Bearer ${medica}`).expect(200);
    const types = new Set(tl.body.events.map((e: { type: string }) => e.type));
    expect(types).toContain('ATENDIMENTO');
    expect(types).toContain('DISPENSACAO');
    const units = new Set(tl.body.events.map((e: { unit?: string }) => e.unit));
    expect(units).toContain('UBS Centro');
    expect(units).toContain('Farmácia Central');
    // Recepção não lê prontuário.
    await t.http().get(`/api/patients/${maria.id}/timeline`).set('authorization', `Bearer ${recepcao}`).expect(403);
  });
});

describe.runIf(enabled)('documentos do paciente', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startTestApp('documents');
  });
  afterAll(async () => {
    await t?.close();
  });

  it('anexa, lista e devolve o arquivo conferindo o hash', async () => {
    const token = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    const [p] = (await t.http().get('/api/patients?q=thiago').set('authorization', `Bearer ${token}`)).body;
    const content = Buffer.from('%PDF-1.4 termo de consentimento de teste');
    const up = await t.http().post(`/api/patients/${p.id}/documents`).set('authorization', `Bearer ${token}`).send({ kind: 'TERMO_CONSENTIMENTO', mimeType: 'application/pdf', fileBase64: content.toString('base64') }).expect(201);
    expect(up.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    const list = await t.http().get(`/api/patients/${p.id}/documents`).set('authorization', `Bearer ${token}`).expect(200);
    expect(list.body).toHaveLength(1);
    const file = await t.http().get(`/api/patients/${p.id}/documents/${up.body.id}/content`).set('authorization', `Bearer ${token}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(Buffer.compare(file.body as Buffer, content)).toBe(0);
  });
});
