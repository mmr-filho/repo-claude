import { demoFixtures } from '@omnisaude/database';
import { completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../src/core/totp';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();

type Unit = { id: string; name: string };
type AssignmentView = { unitName: string; role: string; active: boolean };

describe.runIf(enabled)('administração: unidades, profissionais e segurança', () => {
  let t: TestApp;
  let gestora: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const unit = async (name: string): Promise<Unit> => {
    const res = await t.http().get('/api/admin/units').set(auth(gestora)).expect(200);
    return res.body.find((u: Unit) => u.name === name);
  };
  const joanaCpf = completeCpf('200000001');
  let provisional = '';

  beforeAll(async () => {
    t = await startTestApp('admin');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
  });
  afterAll(async () => {
    await t?.close();
  });

  it('cadastra e edita uma unidade', async () => {
    const created = await t
      .http()
      .post('/api/admin/units')
      .set(auth(gestora))
      .send({ name: 'UBS Vila Nova', type: 'UBS', cnes: '9000095', ibgeCode: '1709500', phone: '(63) 3333-0000', openingHours: 'Segunda a sexta, 7h às 17h' })
      .expect(201);
    expect(created.body).toMatchObject({ name: 'UBS Vila Nova', cnes: '9000095', active: true, openingHours: 'Segunda a sexta, 7h às 17h' });
    await t.http().post('/api/admin/units').set(auth(gestora)).send({ name: 'Outra', type: 'UBS', cnes: '9000095', ibgeCode: '1709500' }).expect(409);
    await t.http().post('/api/admin/units').set(auth(gestora)).send({ name: 'Sem CNES', type: 'UBS', cnes: '12', ibgeCode: '1709500' }).expect(400);
    const updated = await t.http().patch(`/api/admin/units/${created.body.id}`).set(auth(gestora)).send({ active: false, email: 'Vila@Exemplo.gov.br' }).expect(200);
    expect(updated.body).toMatchObject({ active: false, email: 'vila@exemplo.gov.br' });
    const active = await t.http().get('/api/admin/units').set(auth(gestora)).expect(200);
    expect(active.body.find((u: Unit) => u.id === created.body.id)).toBeUndefined();
    const all = await t.http().get('/api/admin/units?includeInactive=true').set(auth(gestora)).expect(200);
    expect(all.body.find((u: Unit) => u.id === created.body.id)).toBeDefined();
    // A unidade da sessão atual não pode ser desativada.
    const me = await t.http().get('/api/auth/me').set(auth(gestora)).expect(200);
    const denied = await t.http().patch(`/api/admin/units/${me.body.context.unitId}`).set(auth(gestora)).send({ active: false }).expect(422);
    expect(denied.body.code).toBe('UNIDADE_EM_USO');
  });

  it('cadastra um profissional com senha provisória e exige a troca no primeiro acesso', async () => {
    const ubs = await unit('UBS Centro');
    const res = await t
      .http()
      .post('/api/admin/users')
      .set(auth(gestora))
      .send({ cpf: joanaCpf, name: 'Joana Nova Enfermeira', email: 'Joana@Exemplo.gov.br', phone: '(63) 99999-0001', assignments: [{ unitId: ubs.id, role: 'ENFERMAGEM', cbo: '223505', council: 'COREN-TO 12345' }] })
      .expect(201);
    provisional = res.body.provisionalPassword;
    expect(provisional).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
    expect(res.body.user).toMatchObject({ cpf: joanaCpf, email: 'joana@exemplo.gov.br', phone: '63999990001', mustChangePassword: true, mfaEnabled: false });
    expect(res.body.user.assignments[0]).toMatchObject({ unitName: 'UBS Centro', role: 'ENFERMAGEM', cbo: '223505', cboLabel: 'Enfermeiro', council: 'COREN-TO 12345' });

    const login = await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf: joanaCpf, password: provisional }).expect(200);
    const ctx = await t.http().post('/api/auth/context').set(auth(login.body.token)).send({ unitId: ubs.id, role: 'ENFERMAGEM' }).expect(200);
    const token = ctx.body.token;
    const me = await t.http().get('/api/auth/me').set(auth(token)).expect(200);
    expect(me.body.user.mustChangePassword).toBe(true);
    // Com senha provisória, só a própria conta é acessível.
    const blocked = await t.http().get('/api/directory').set(auth(token)).expect(403);
    expect(blocked.body.code).toBe('SENHA_PROVISORIA');
    await t.http().post('/api/auth/password').set(auth(token)).send({ current: provisional, next: provisional }).expect(422);
    await t.http().post('/api/auth/password').set(auth(token)).send({ current: provisional, next: 'curta1' }).expect(422);
    await t.http().post('/api/auth/password').set(auth(token)).send({ current: provisional, next: 'NovaSenha2026' }).expect(200);
    await t.http().get('/api/directory').set(auth(token)).expect(200);
    expect((await t.http().get('/api/auth/me').set(auth(token))).body.user.mustChangePassword).toBe(false);

    // Validações de cadastro.
    const invalid = await t.http().post('/api/admin/users').set(auth(gestora)).send({ cpf: '11111111111', name: 'CPF Inválido Teste', assignments: [{ unitId: ubs.id, role: 'MEDICO', cbo: '225125' }] }).expect(422);
    expect(invalid.body.code).toBe('CPF_INVALIDO');
    await t.http().post('/api/admin/users').set(auth(gestora)).send({ cpf: joanaCpf, name: 'Duplicada Teste', assignments: [{ unitId: ubs.id, role: 'MEDICO', cbo: '225125' }] }).expect(409);
    await t.http().post('/api/admin/users').set(auth(gestora)).send({ cpf: completeCpf('200000002'), name: 'Sem Lotação Teste', assignments: [] }).expect(400);
  });

  it('troca lotações, redefine a senha e desativa (a sessão aberta perde o acesso na hora)', async () => {
    const list = await t.http().get('/api/admin/users?q=Joana Nova').set(auth(gestora)).expect(200);
    expect(list.body).toHaveLength(1);
    const joana = list.body[0];
    const upa = await unit('UPA 24h Norte');
    const put = await t
      .http()
      .put(`/api/admin/users/${joana.id}/assignments`)
      .set(auth(gestora))
      .send([
        { unitId: upa.id, role: 'ENFERMAGEM', cbo: '223505' },
        { unitId: upa.id, role: 'NIR', cbo: '223505' },
      ])
      .expect(200);
    const active = (put.body.assignments as AssignmentView[]).filter((a) => a.active).map((a) => `${a.unitName}/${a.role}`).sort();
    expect(active).toEqual(['UPA 24h Norte/ENFERMAGEM', 'UPA 24h Norte/NIR']);
    expect((put.body.assignments as AssignmentView[]).find((a) => a.unitName === 'UBS Centro')?.active).toBe(false);
    expect((await t.http().get('/api/admin/users?unitId=' + upa.id + '&role=NIR').set(auth(gestora))).body.map((u: { id: string }) => u.id)).toContain(joana.id);

    const reset = await t.http().post(`/api/admin/users/${joana.id}/reset-password`).set(auth(gestora)).expect(200);
    await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf: joanaCpf, password: 'NovaSenha2026' }).expect(401);
    const login = await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf: joanaCpf, password: reset.body.provisionalPassword }).expect(200);
    expect(login.body.assignments.map((a: { role: string }) => a.role).sort()).toEqual(['ENFERMAGEM', 'NIR']);
    const ctx = await t.http().post('/api/auth/context').set(auth(login.body.token)).send({ unitId: upa.id, role: 'NIR' }).expect(200);
    await t.http().get('/api/auth/me').set(auth(ctx.body.token)).expect(200);

    await t.http().patch(`/api/admin/users/${joana.id}`).set(auth(gestora)).send({ active: false }).expect(200);
    await t.http().get('/api/auth/me').set(auth(ctx.body.token)).expect(401);
    await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf: joanaCpf, password: reset.body.provisionalPassword }).expect(401);
    expect((await t.http().get('/api/admin/users?q=Joana Nova').set(auth(gestora))).body).toHaveLength(0);
    expect((await t.http().get('/api/admin/users?q=Joana Nova&includeInactive=true').set(auth(gestora))).body).toHaveLength(1);
    const back = await t.http().patch(`/api/admin/users/${joana.id}`).set(auth(gestora)).send({ active: true, socialName: 'Jô' }).expect(200);
    expect(back.body).toMatchObject({ active: true, socialName: 'Jô' });
  });

  it('protege a própria conta e a lotação em uso', async () => {
    const me = await t.http().get('/api/auth/me').set(auth(gestora)).expect(200);
    expect((await t.http().patch(`/api/admin/users/${me.body.user.id}`).set(auth(gestora)).send({ active: false }).expect(422)).body.code).toBe('AUTO_DESATIVACAO');
    await t.http().post(`/api/admin/users/${me.body.user.id}/reset-password`).set(auth(gestora)).expect(422);
    await t.http().post(`/api/admin/users/${me.body.user.id}/mfa/reset`).set(auth(gestora)).expect(422);
    const denied = await t.http().put(`/api/admin/users/${me.body.user.id}/assignments`).set(auth(gestora)).send([{ unitId: me.body.context.unitId, role: 'RECEPCAO', cbo: '422105' }]).expect(422);
    expect(denied.body.code).toBe('LOTACAO_EM_USO');
  });

  it('exige 2FA para os papéis definidos em Segurança, com configuração na própria entrada', async () => {
    await t.http().patch('/api/admin/security').set(auth(gestora)).send({ mfaRequiredRoles: ['FATURAMENTO', 'FATURAMENTO'] }).expect(200);
    expect((await t.http().get('/api/admin/security').set(auth(gestora)).expect(200)).body.mfaRequiredRoles).toEqual(['FATURAMENTO']);

    const fat = demoFixtures.STAFF.find((s) => s.assignments.some((a) => a.role === 'FATURAMENTO'))!;
    const login = await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf: fat.cpf, password: demoFixtures.DEMO_PASSWORD }).expect(200);
    const a = login.body.assignments.find((x: { role: string }) => x.role === 'FATURAMENTO');
    const denied = await t.http().post('/api/auth/context').set(auth(login.body.token)).send({ unitId: a.unitId, role: 'FATURAMENTO' }).expect(403);
    expect(denied.body.code).toBe('MFA_OBRIGATORIO');
    expect(denied.body.details).toMatchObject({ mfaEnabled: false, role: 'FATURAMENTO' });
    // Outros papéis do mesmo profissional seguem livres.
    const other = login.body.assignments.find((x: { role: string }) => x.role !== 'FATURAMENTO');
    if (other) await t.http().post('/api/auth/context').set(auth(login.body.token)).send({ unitId: other.unitId, role: other.role }).expect(200);

    const setup = await t.http().post('/api/auth/pending/mfa/setup').set(auth(login.body.token)).expect(201);
    await t.http().post('/api/auth/pending/mfa/enable').set(auth(login.body.token)).send({ code: '000000', setupToken: setup.body.setupToken }).expect(422);
    const enabledRes = await t.http().post('/api/auth/pending/mfa/enable').set(auth(login.body.token)).send({ code: totpCode(setup.body.secret), setupToken: setup.body.setupToken }).expect(200);
    const ctx = await t.http().post('/api/auth/context').set(auth(enabledRes.body.token)).send({ unitId: a.unitId, role: 'FATURAMENTO' }).expect(200);
    expect((await t.http().get('/api/auth/me').set(auth(ctx.body.token)).expect(200)).body.context.mfa).toBe(true);

    // No próximo login o código passa a ser pedido; a gestão pode remover um autenticador perdido.
    expect((await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf: fat.cpf, password: demoFixtures.DEMO_PASSWORD }).expect(200)).body.stage).toBe('mfa');
    const users = await t.http().get('/api/admin/users?role=FATURAMENTO').set(auth(gestora)).expect(200);
    const target = users.body.find((u: { cpf: string }) => u.cpf === fat.cpf);
    expect(target.mfaEnabled).toBe(true);
    await t.http().post(`/api/admin/users/${target.id}/mfa/reset`).set(auth(gestora)).expect(200);
    expect((await t.http().post('/api/auth/login').send({ tenant: t.slug, cpf: fat.cpf, password: demoFixtures.DEMO_PASSWORD }).expect(200)).body.stage).toBe('context');
    await t.http().patch('/api/admin/security').set(auth(gestora)).send({ mfaRequiredRoles: [] }).expect(200);
  });

  it('é exclusivo de quem tem as permissões de cadastro', async () => {
    const medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    await t.http().get('/api/admin/units').set(auth(medica)).expect(403);
    await t.http().get('/api/admin/users').set(auth(medica)).expect(403);
    await t.http().get('/api/admin/security').set(auth(medica)).expect(403);
  });
});
