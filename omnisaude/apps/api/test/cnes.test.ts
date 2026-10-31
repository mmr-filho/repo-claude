import { demoFixtures } from '@omnisaude/database';
import { completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();

type Row = { cnes: string; action: string; [k: string]: unknown };

describe.runIf(enabled)('importação do CNES', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let gestora: string;
  let importId = '';
  let stagedId = '';
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const apply = (id: string, body: object = {}) => t.http().post(`/api/admin/cnes/imports/${id}/aplicar`).set(auth(gestora)).send(body);

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('cnes', { CNES_API_URL: mocks.url });
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
  });
  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('busca os estabelecimentos do município no DATASUS e concilia com as unidades cadastradas', async () => {
    const res = await t.http().post('/api/admin/cnes/estabelecimentos/previa').set(auth(gestora)).send({ ibgeCode: '1709500' }).expect(200);
    expect(res.body.ibgeCode).toBe('170950');
    expect(res.body.summary).toMatchObject({ total: 8, publicos: 6, privadosSus: 0, novos: 6, atualizar: 1, inativos: 1, foraDoCnes: 7 });
    const rows = res.body.rows as Row[];
    const ubs = rows.find((r) => r.cnes === '9000011')!;
    expect(ubs).toMatchObject({ action: 'atualizar', name: 'UBS Centro', existing: { name: 'UBS Centro', type: 'UBS' } });
    expect(ubs.changes).toEqual(expect.arrayContaining(['e-mail', 'coordenadas']));
    expect(rows.find((r) => r.cnes === '3331326')).toMatchObject({ action: 'novo', suggestedType: 'UPA', isPublic: true, name: 'UPA Dra. Márcia Mucky', openingHours: '24 horas', preselected: true, management: 'M' });
    expect(rows.find((r) => r.cnes === '2786109')).toMatchObject({ suggestedType: 'HOSPITAL', management: 'E', address: 'Av Para, 1800 - Centro - CEP 77403-010' });
    expect(rows.find((r) => r.cnes === '0549126')).toMatchObject({ suggestedType: null, name: 'Coordenadoria de Vigilância Epidemiológica', openingHours: 'Manhã e tarde' });
    expect(rows.find((r) => r.cnes === '9695214')).toMatchObject({ isPublic: false, preselected: false });
    expect(rows.find((r) => r.cnes === '2546523')?.action).toBe('inativo');
    expect(res.body.missing.map((m: { cnes: string }) => m.cnes)).not.toContain('9000011');
    importId = res.body.importId;
    await t.http().post('/api/admin/cnes/estabelecimentos/previa').set(auth(gestora)).send({ ibgeCode: '9999999' }).expect(404);
  });

  it('aplica só o selecionado, pede o tipo quando não há sugestão e completa a unidade existente sem renomear', async () => {
    const denied = await apply(importId, { cnes: ['0549126'] }).expect(422);
    expect(denied.body.code).toBe('TIPO_NECESSARIO');
    const res = await apply(importId, { cnes: ['9000011', '3331326', '2786109', '0549126', '2546523'], types: { '0549126': 'POLICLINICA' } }).expect(200);
    expect([...res.body.created].sort()).toEqual(['Coordenadoria de Vigilância Epidemiológica', 'Hospital Regional de Gurupi', 'UPA Dra. Márcia Mucky']);
    expect(res.body.updated).toEqual(['UBS Centro']);
    const units = (await t.http().get('/api/admin/units').set(auth(gestora)).expect(200)).body as Record<string, unknown>[];
    expect(units.find((u) => u.cnes === '3331326')).toMatchObject({ type: 'UPA', source: 'CNES', openingHours: '24 horas', latitude: -11.74, cnesTypeCode: '73', ibgeCode: '1709500' });
    expect(units.find((u) => u.cnes === '2786109')).toMatchObject({ type: 'HOSPITAL', management: 'E', legalNature: '1023' });
    expect(units.find((u) => u.cnes === '0549126')).toMatchObject({ type: 'POLICLINICA' });
    expect(units.find((u) => u.cnes === '9000011')).toMatchObject({ name: 'UBS Centro', email: 'ubs.centro@gurupi.to.gov.br', cnesTypeCode: '02', susAmbulatory: true });
    expect(units.find((u) => u.cnes === '2546523')).toBeUndefined();
    // A prévia já aplicada não pode ser reaplicada; o histórico guarda o resultado.
    await apply(importId, { cnes: ['9000011'] }).expect(409);
    const list = await t.http().get('/api/admin/cnes/imports').set(auth(gestora)).expect(200);
    expect(list.body[0]).toMatchObject({ kind: 'ESTABELECIMENTOS', status: 'APLICADA', summary: { aplicado: { criadas: 3, atualizadas: 1 } } });
  });

  it('importa equipes por planilha', async () => {
    const csv = ['ine;tipo;nome;cnes;area', '0000123456;70;eSF Vila Nova;3331326;01', '0000123457;eSB;;9000011;01', '0000123458;99;Tipo ruim;9000011;', '0000123459;70;Sem unidade;1111111;'].join('\n');
    const prev = await t.http().post('/api/admin/cnes/equipes/previa').set(auth(gestora)).send({ csv }).expect(200);
    expect(prev.body.summary).toMatchObject({ linhas: 4, novas: 2, atualizar: 0, erros: 2 });
    expect(prev.body.rows[1]).toMatchObject({ typeCode: '71', name: 'eSB UBS Centro', unitName: 'UBS Centro', status: 'nova' });
    expect(prev.body.rows[2].errors[0]).toMatch(/tipo de equipe/);
    const res = await apply(prev.body.importId).expect(200);
    expect(res.body.created).toHaveLength(2);
    const teams = await t.http().get('/api/admin/teams').set(auth(gestora)).expect(200);
    // A demonstração já traz equipes próprias (ESF Centro I, Saúde Bucal e eMulti); conferimos só as importadas.
    expect(
      teams.body
        .map((x: { ine: string }) => x.ine)
        .filter((ine: string) => ine.startsWith('00001234'))
        .sort(),
    ).toEqual(['0000123456', '0000123457']);
    expect(teams.body.find((x: { ine: string }) => x.ine === '0000123456')).toMatchObject({ typeLabel: expect.stringContaining('eSF'), unitName: 'UPA Dra. Márcia Mucky', members: 0 });
  });

  it('importa profissionais por planilha: cria acesso, lota quem já existe e deixa pré-cadastro sem CPF', async () => {
    const novo = completeCpf('300000001');
    const medica = demoFixtures.STAFF.find((s) => s.key === 'medica')!;
    const csv = [
      'cpf;cns;nome;cbo;cnes;ine;papel;conselho;email',
      `${novo};;Helena Prado Enfermeira;223505;3331326;0000123456;;COREN-TO 555;Helena@Gurupi.to.gov.br`,
      `${medica.cpf};;${medica.name};225125;3331326;0000123456;MEDICO;;`,
      ';;Pedro Alves Agente;515105;9000011;0000123457;;;',
      '111.111.111-11;;CPF Invalido Teste;223505;3331326;;;;',
    ].join('\n');
    const prev = await t.http().post('/api/admin/cnes/profissionais/previa').set(auth(gestora)).send({ csv }).expect(200);
    expect(prev.body.summary).toMatchObject({ linhas: 4, acessos: 1, existentes: 1, preCadastro: 1, erros: 1 });
    expect(prev.body.rows[0]).toMatchObject({ role: 'ENFERMAGEM', unitName: 'UPA Dra. Márcia Mucky', teamFound: true, status: 'acesso', email: 'helena@gurupi.to.gov.br' });
    expect(prev.body.rows[2]).toMatchObject({ role: 'ACS', status: 'pre_cadastro', cboLabel: 'Agente comunitário de saúde' });
    expect(prev.body.rows[3].errors).toContain('CPF inválido');

    const res = await apply(prev.body.importId, { createAccess: true }).expect(200);
    expect(res.body.access).toHaveLength(1);
    expect(res.body.access[0]).toMatchObject({ cpf: novo, name: 'Helena Prado Enfermeira' });
    expect(res.body.linked).toEqual([medica.name]);
    expect(res.body.staged).toEqual(['Pedro Alves Agente']);
    expect(res.body.errors).toHaveLength(1);

    const login = await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf: novo, password: res.body.access[0].provisionalPassword }).expect(200);
    expect(login.body.assignments[0]).toMatchObject({ unitName: 'UPA Dra. Márcia Mucky', role: 'ENFERMAGEM' });
    const carla = (await t.http().get('/api/admin/users?q=Carla').set(auth(gestora)).expect(200)).body[0];
    expect(carla.assignments.filter((a: { active: boolean }) => a.active).map((a: { unitName: string }) => a.unitName)).toContain('UPA Dra. Márcia Mucky');
    const teams = await t.http().get('/api/admin/teams').set(auth(gestora)).expect(200);
    expect(teams.body.find((x: { ine: string }) => x.ine === '0000123456').members).toBe(2);
    expect(teams.body.find((x: { ine: string }) => x.ine === '0000123457').members).toBe(1);
    const staged = await t.http().get('/api/admin/cnes/pre-cadastro').set(auth(gestora)).expect(200);
    expect(staged.body).toHaveLength(1);
    expect(staged.body[0]).toMatchObject({ name: 'Pedro Alves Agente', suggestedRole: 'ACS', unitName: 'UBS Centro', ine: '0000123457' });
    stagedId = staged.body[0].id;
  });

  it('completa o pré-cadastro ao criar o acesso e passa a equipe para o usuário', async () => {
    const units = (await t.http().get('/api/admin/units').set(auth(gestora)).expect(200)).body as { id: string; cnes: string }[];
    const ubs = units.find((u) => u.cnes === '9000011')!;
    await t
      .http()
      .post('/api/admin/users')
      .set(auth(gestora))
      .send({ cpf: completeCpf('300000002'), name: 'Pedro Alves Agente', stagedId, assignments: [{ unitId: ubs.id, role: 'ACS', cbo: '515105' }] })
      .expect(201);
    expect((await t.http().get('/api/admin/cnes/pre-cadastro').set(auth(gestora)).expect(200)).body).toHaveLength(0);
    const teams = await t.http().get('/api/admin/teams').set(auth(gestora)).expect(200);
    expect(teams.body.find((x: { ine: string }) => x.ine === '0000123457').members).toBe(1);
    // Um pré-cadastro pode ser descartado.
    const csv = 'nome;cbo;cnes\nFulano Descartado Teste;515105;9000011';
    const prev = await t.http().post('/api/admin/cnes/profissionais/previa').set(auth(gestora)).send({ csv }).expect(200);
    await apply(prev.body.importId, { createAccess: false }).expect(200);
    const pending = (await t.http().get('/api/admin/cnes/pre-cadastro?q=Descartado').set(auth(gestora)).expect(200)).body;
    expect(pending).toHaveLength(1);
    await t.http().patch(`/api/admin/cnes/pre-cadastro/${pending[0].id}/ignorar`).set(auth(gestora)).expect(200);
    expect((await t.http().get('/api/admin/cnes/pre-cadastro?q=Descartado').set(auth(gestora)).expect(200)).body).toHaveLength(0);
    const modelo = await t.http().get('/api/admin/cnes/modelos/profissionais').set(auth(gestora)).expect(200);
    expect(modelo.body.content.split('\n')[0]).toBe('cpf;cns;nome;cbo;cnes;ine;papel;conselho;email;telefone');
  });

  it('é exclusivo dos papéis de cadastro', async () => {
    const medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    await t.http().post('/api/admin/cnes/estabelecimentos/previa').set(auth(medica)).send({ ibgeCode: '1709500' }).expect(403);
    await t.http().get('/api/admin/cnes/pre-cadastro').set(auth(medica)).expect(403);
    await t.http().get('/api/admin/teams').set(auth(medica)).expect(403);
  });
});
