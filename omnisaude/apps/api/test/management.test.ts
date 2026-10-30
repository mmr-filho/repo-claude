import { localDateString } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();

describe.runIf(enabled)('gestão executiva', () => {
  let t: TestApp;
  let gestora: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const today = localDateString(new Date());

  beforeAll(async () => {
    t = await startTestApp('management');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
  });
  afterAll(async () => {
    await t?.close();
  });

  it('calcula a produtividade por profissional, categoria e unidade', async () => {
    const res = await t.http().get(`/api/management/productivity?from=2025-01-01&to=${today}`).set(auth(gestora)).expect(200);
    const carla = res.body.professionals.find((p: { name: string }) => p.name === 'Carla Menezes Médica');
    expect(carla).toMatchObject({ category: 'MEDICO', encountersClosed: 8, signedNotes: 8, prescriptions: 2, avgDurationMin: 25 });
    const bruno = res.body.professionals.find((p: { name: string }) => p.name === 'Bruno Almeida Enfermeiro');
    expect(bruno).toMatchObject({ category: 'ENFERMAGEM', triages: 2 });
    const ubs = res.body.units.find((u: { unit: string }) => u.unit === 'UBS Centro');
    expect(ubs.encountersClosed).toBe(6);
    expect(res.body.categories.find((c: { category: string }) => c.category === 'MEDICO').encountersClosed).toBe(8);
    await t.http().get('/api/management/productivity?from=2026-13-01').set(auth(gestora)).expect(400);
  });

  it('lista as não conformidades, incluindo ACCR fora do tempo-alvo', async () => {
    const res = await t.http().get('/api/management/sla').set(auth(gestora)).expect(200);
    const accr = res.body.items.find((i: { key: string }) => i.key === 'accr_atrasado');
    // Carlos foi classificado como laranja há ~25 min (alvo: 10 min); Raimunda (amarelo, ~45 min) ainda está no prazo.
    expect(accr.count).toBe(1);
    expect(accr.records[0]).toMatchObject({ patient: 'Carlos Eduardo Martins', color: 'LARANJA', maxWaitMinutes: 10 });
    expect(res.body.items.map((i: { key: string }) => i.key)).toEqual(
      expect.arrayContaining(['atendimentos_abertos', 'prontuarios_rascunho', 'administracoes_bloqueadas', 'leitos_higienizacao', 'rnds_erro', 'glosas_previstas']),
    );
  });

  it('gera e guarda a pauta da reunião de gestão', async () => {
    const res = await t.http().post('/api/management/agendas').set(auth(gestora)).send({ from: '2026-01-01', to: today }).expect(201);
    const hosp = res.body.content.leitos.find((l: { unit: string }) => l.unit === 'Hospital Municipal São Lucas');
    expect(hosp).toMatchObject({ ocupados: 5, higienizacao: 2, bloqueados: 1 });
    expect(res.body.content.absenteismo[0]).toMatchObject({ schedule: 'Clínica médica - Dra. Carla', faltas: 1 });
    expect(res.body.markdown).toContain('# Pauta da reunião de gestão');
    expect(res.body.markdown).toContain('Clínica médica - Dra. Carla');
    expect(res.body.markdown).toContain('Pacientes aguardando além do tempo-alvo agora: 1');
    const list = await t.http().get('/api/management/agendas').set(auth(gestora)).expect(200);
    expect(list.body).toHaveLength(1);
    const one = await t.http().get(`/api/management/agendas/${res.body.id}`).set(auth(gestora)).expect(200);
    expect(one.body.markdown).toBe(res.body.markdown);
  });

  it('é exclusivo da gestão', async () => {
    const medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    await t.http().get('/api/management/sla').set(auth(medica)).expect(403);
    await t.http().post('/api/management/agendas').set(auth(medica)).send({}).expect(403);
  });
});
