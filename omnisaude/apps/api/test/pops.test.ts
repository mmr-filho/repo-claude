import { demoFixtures, type TenantClient } from '@omnisaude/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();
const staff = (key: string) => demoFixtures.STAFF.find((s) => s.key === key)!;

describe.runIf(enabled)('POPs (hard e soft gates)', () => {
  let t: TestApp;
  let db: TenantClient;
  let enf: string;
  let recepcao: string;
  const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });

  beforeAll(async () => {
    t = await startTestApp('pops');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
    enf = await t.login('enfermeiro', 'Hospital Municipal São Lucas', 'ENFERMAGEM');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
  });
  afterAll(async () => {
    await t?.close();
  });

  it('lista e filtra POPs', async () => {
    const all = await t.http().get('/api/pops').set(auth(enf)).expect(200);
    expect(all.body).toHaveLength(6);
    expect(all.body[0].content).toBeUndefined();
    const soft = await t.http().get('/api/pops?kind=SOFT').set(auth(recepcao)).expect(200);
    expect(soft.body).toHaveLength(3);
    const byTrigger = await t.http().get('/api/pops?trigger=administracao.alta_vigilancia').set(auth(enf)).expect(200);
    expect(byTrigger.body.map((p: { code: string }) => p.code)).toEqual(['POP-ENF-001']);
  });

  it('registra na trilha o acesso a guia consultivo (soft gate)', async () => {
    const pop = await db.pop.findUniqueOrThrow({ where: { code: 'POP-GER-001' } });
    const res = await t.http().get(`/api/pops/${pop.id}`).set(auth(recepcao)).expect(200);
    expect(res.body.content).toMatch(/cinco momentos/);
    expect(await db.auditEntry.count({ where: { action: 'pop.consultar', entityId: pop.id } })).toBe(1);
  });

  it('exige checklist completo e dupla checagem por outro profissional clínico', async () => {
    const pop = await db.pop.findUniqueOrThrow({ where: { code: 'POP-ENF-001' } });
    const url = `/api/pops/${pop.id}/executions`;
    const answers = { identificacao: true, prescricao: true, calculo: true };
    const incomplete = await t.http().post(url).set(auth(enf)).send({ answers: { identificacao: true } }).expect(422);
    expect(incomplete.body.code).toBe('CHECKLIST_INCOMPLETO');
    expect(incomplete.body.details.missing.map((m: { id: string }) => m.id)).toEqual(['prescricao', 'calculo']);
    expect((await t.http().post(url).set(auth(enf)).send({ answers }).expect(422)).body.code).toBe('DUPLA_CHECAGEM_OBRIGATORIA');
    const self = await t.http().post(url).set(auth(enf)).send({ answers, doubleCheck: { cpf: staff('enfermeiro').cpf, password: demoFixtures.DEMO_PASSWORD } }).expect(422);
    expect(self.body.code).toBe('DUPLA_CHECAGEM_MESMO_USUARIO');
    const notClinical = await t.http().post(url).set(auth(enf)).send({ answers, doubleCheck: { cpf: staff('recepcao').cpf, password: demoFixtures.DEMO_PASSWORD } }).expect(422);
    expect(notClinical.body.code).toBe('DUPLA_CHECAGEM_PAPEL');
    const badPassword = await t.http().post(url).set(auth(enf)).send({ answers, doubleCheck: { cpf: staff('tecnica').cpf, password: 'errada' } }).expect(422);
    expect(badPassword.body.code).toBe('DUPLA_CHECAGEM_INVALIDA');

    const ok = await t.http().post(url).set(auth(enf)).send({ answers, doubleCheck: { cpf: staff('tecnica').cpf, password: demoFixtures.DEMO_PASSWORD } }).expect(201);
    expect(ok.body.doubleCheckBy.name).toBe('Joana Lima Técnica de Enfermagem');
    expect(ok.body.trigger).toBe('administracao.alta_vigilancia');
    const exec = await db.popExecution.findUniqueOrThrow({ where: { id: ok.body.id } });
    expect(exec.answers).toEqual({ ...answers, bomba: false });
    expect(await db.auditEntry.count({ where: { action: 'pop.executar', entityId: ok.body.id } })).toBe(1);
  });

  it('não executa POP consultivo nem permite papel sem pop.executar', async () => {
    const soft = await db.pop.findUniqueOrThrow({ where: { code: 'POP-GER-002' } });
    expect((await t.http().post(`/api/pops/${soft.id}/executions`).set(auth(enf)).send({ answers: {} }).expect(422)).body.code).toBe('POP_CONSULTIVO');
    const hard = await db.pop.findUniqueOrThrow({ where: { code: 'POP-ENF-002' } });
    await t.http().post(`/api/pops/${hard.id}/executions`).set(auth(recepcao)).send({ answers: { ccih: true, horario: true } }).expect(403);
  });
});
