import { cnsFromBase, completeCpf, MCHAT_ITENS } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();
const mais = (iso: string, dias: number) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + dias)).toISOString().slice(0, 10);

describe.runIf(enabled)('Programas da APS: faltosos, estratificações e busca ativa', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let gestora: string;
  let recepcao: string;
  let medica: string;
  let enfermeira: string;
  let social: string;
  let ubsId = '';
  let teamId = '';
  let hoje = '';
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const address = { cep: '77405070', street: 'Rua dos Programas', number: '1', district: 'Setor Central', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('programs', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    enfermeira = await t.login('enfermeiro', 'UBS Centro', 'ENFERMAGEM');
    social = await t.login('social', 'UBS Centro', 'SERVICO_SOCIAL');
    const me = (await t.http().get('/api/auth/me').set(auth(gestora)).expect(200)).body;
    ubsId = me.context.unitId;
    hoje = new Intl.DateTimeFormat('en-CA', { timeZone: me.tenant.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const medicaId = (await t.http().get('/api/auth/me').set(auth(medica)).expect(200)).body.user.id;
    const team = (
      await t
        .http()
        .post('/api/admin/teams')
        .set(auth(gestora))
        .send({ ine: '0000009902', name: 'ESF Programas', typeCode: '70', unitId: ubsId, modality: 'ESF_40H', members: [{ userId: medicaId, cbo: '225125' }] })
        .expect(201)
    ).body;
    teamId = team.id;
  });
  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  let seq = 0;
  async function pessoa(input: { name: string; birthDate: string; sex: 'F' | 'M'; bolsaFamilia?: boolean }) {
    seq++;
    const p = (
      await t
        .http()
        .post('/api/patients')
        .set(auth(recepcao))
        .send({ ...input, cpf: completeCpf(`49900000${seq}`), cns: cnsFromBase(`299000000${String(seq).padStart(2, '0')}`), motherName: 'Mae Programas Teste', address })
        .expect(201)
    ).body;
    await t
      .http()
      .post('/api/households')
      .set(auth(recepcao))
      .send({ ...address, number: String(seq), unitId: ubsId, teamId, family: { responsibleId: p.id } })
      .expect(201);
    return p.id as string;
  }
  async function consulta(patientId: string, triagem = false) {
    const encId = (await t.http().post('/api/reception/check-in').set(auth(recepcao)).send({ patientId, kind: 'AMBULATORIAL' }).expect(201)).body.id;
    if (triagem)
      await t
        .http()
        .post(`/api/triage/encounters/${encId}`)
        .set(auth(enfermeira))
        .send({ complaint: 'Acompanhamento', systolic: 120, diastolic: 80, heartRate: 70, temperature: 36.5, weightKg: 68, heightCm: 160 })
        .expect(201);
    await t.http().post(`/api/clinical/encounters/${encId}/start`).set(auth(medica)).expect(200);
    const note = (
      await t
        .http()
        .post(`/api/clinical/encounters/${encId}/notes`)
        .set(auth(medica))
        .send({ kind: 'SOAP', subjective: 'Acompanhamento', assessment: 'Estável', plan: 'Manter', codes: [{ system: 'CIAP2', code: 'A98' }] })
        .expect(201)
    ).body;
    await t.http().post(`/api/clinical/notes/${note.id}/sign`).set(auth(medica)).expect(200);
    await t.http().post(`/api/clinical/encounters/${encId}/close`).set(auth(medica)).send({ outcome: 'ALTA' }).expect(200);
    return encId as string;
  }
  const lista = async (codigo: string, faltosos = false) => (await t.http().get(`/api/programas/${codigo}?teamId=${teamId}&faltosos=${faltosos}`).set(auth(enfermeira)).expect(200)).body;
  const linhaDe = (l: { pessoas: { patientId: string }[] }, id: string) =>
    l.pessoas.find((p) => p.patientId === id) as
      | { situacao: string; faltas: { codigo: string }[]; proximaAcao: string | null; estratificacao: { result: string } | null; buscaAtiva: { status: string } | null }
      | undefined;
  const codigos = (l: { pessoas: { patientId: string }[] }, id: string) => (linhaDe(l, id)?.faltas ?? []).map((f) => f.codigo);

  it('pré-natal: captação em atraso, exames do 1º trimestre e classificação de risco', async () => {
    const gestante = await pessoa({ name: 'Gestante Programas Teste', birthDate: '1995-05-05', sex: 'F' });
    await t
      .http()
      .post(`/api/patients/${gestante}/conditions`)
      .set(auth(medica))
      .send({ system: 'CID10', code: 'Z34', description: 'Gravidez', lineOfCare: 'GESTANTE', onsetAt: mais(hoje, -140) })
      .expect(201);
    let l = await lista('PRE_NATAL');
    expect(linhaDe(l, gestante)?.situacao).toContain('20 semanas');
    expect(codigos(l, gestante)).toEqual(['CAPTACAO', 'EXAMES_T1']);
    await consulta(gestante);
    l = await lista('PRE_NATAL');
    expect(codigos(l, gestante)).toEqual(['RISCO', 'EXAMES_T1']);
    expect(linhaDe(l, gestante)?.proximaAcao).toContain('Próxima consulta até');
    await t
      .http()
      .post('/api/programas/estratificacoes')
      .set(auth(recepcao))
      .send({ patientId: gestante, kind: 'GESTANTE', answers: ['HAS_CRONICA'] })
      .expect(403);
    const risco = (
      await t
        .http()
        .post('/api/programas/estratificacoes')
        .set(auth(medica))
        .send({ patientId: gestante, kind: 'GESTANTE', answers: ['IDADE', 'HAS_CRONICA'], notes: 'PA 150/95 na 1ª consulta' })
        .expect(201)
    ).body;
    expect(risco).toMatchObject({ kind: 'GESTANTE', result: 'ALTO_RISCO' });
    expect(risco.detalhe.altoRisco).toEqual(['HAS_CRONICA']);
    l = await lista('PRE_NATAL');
    expect(codigos(l, gestante)).toEqual(['EXAMES_T1']);
    expect(linhaDe(l, gestante)?.situacao).toContain('alto risco');
    expect(linhaDe(l, gestante)?.estratificacao).toMatchObject({ result: 'ALTO_RISCO' });
  });

  it('puericultura: consultas e vacinas por idade, M-CHAT-R e busca ativa da criança', async () => {
    const crianca = await pessoa({ name: 'Crianca Programas Teste', birthDate: mais(hoje, -548), sex: 'M' });
    let l = await lista('PUERICULTURA');
    const faltas = codigos(l, crianca);
    expect(faltas).toContain('CONSULTA');
    expect(faltas).toContain('MCHAT');
    expect(faltas).toContain('VACINA_DTP_1');
    expect(faltas).toContain('VACINA_SCR_1');
    expect(faltas).toContain('VACINA_HEPA_1');
    expect(faltas).not.toContain('VACINA_DTP_4'); // reforço dos 15 meses com tolerância: vence aos 16 meses, mas a 3ª dose nem foi dada; só a próxima dose em falta é cobrada
    expect(linhaDe(l, crianca)?.faltas.find((f) => f.codigo === 'CONSULTA')?.descricao).toBe('0 de 7 consultas previstas até esta idade');
    const respostas = Object.fromEntries(MCHAT_ITENS.map((i) => [String(i.numero), false]));
    await t
      .http()
      .post('/api/programas/estratificacoes')
      .set(auth(medica))
      .send({ patientId: crianca, kind: 'MCHAT', answers: { '1': true } })
      .expect(400);
    const mchat = (await t.http().post('/api/programas/estratificacoes').set(auth(medica)).send({ patientId: crianca, kind: 'MCHAT', answers: respostas }).expect(201)).body;
    expect(mchat).toMatchObject({ kind: 'MCHAT', result: 'ALTO', score: 17 });
    l = await lista('PUERICULTURA');
    expect(codigos(l, crianca)).not.toContain('MCHAT');
    expect(linhaDe(l, crianca)?.situacao).toContain('M-CHAT alto');
    // Busca ativa da criança pela linha CRIANCA (nova linha de cuidado).
    await t.http().post('/api/social/cases').set(auth(social)).send({ patientId: crianca, lineOfCare: 'CRIANCA' }).expect(201);
    l = await lista('PUERICULTURA', true);
    expect(linhaDe(l, crianca)?.buscaAtiva).toMatchObject({ status: 'ABERTO' });
    const casos = (await t.http().get('/api/social/cases').set(auth(social)).expect(200)).body;
    expect(casos.some((c: { lineOfCare: string }) => c.lineOfCare === 'CRIANCA')).toBe(true);
  });

  it('hipertensão e diabetes: a estratificação do pé registra a produção e pontua no indicador C4', async () => {
    const diabetico = await pessoa({ name: 'Diabetico Programas Teste', birthDate: '1970-02-02', sex: 'M' });
    await t.http().post(`/api/patients/${diabetico}/conditions`).set(auth(medica)).send({ system: 'CID10', code: 'E11', description: 'Diabetes tipo 2', lineOfCare: 'DIABETES' }).expect(201);
    await consulta(diabetico, true);
    let l = await lista('HAS_DM');
    expect(codigos(l, diabetico)).toEqual(['E', 'PE_RISCO']);
    const pe = (
      await t
        .http()
        .post('/api/programas/estratificacoes')
        .set(auth(medica))
        .send({ patientId: diabetico, kind: 'PE_DIABETICO', answers: ['PSP', 'DEFORMIDADE'] })
        .expect(201)
    ).body;
    expect(pe).toMatchObject({ kind: 'PE_DIABETICO', result: '1', score: 1 });
    expect([mais(hoje, 90), mais(hoje, 91), mais(hoje, 92)]).toContain(pe.nextDueAt);
    l = await lista('HAS_DM');
    expect(codigos(l, diabetico)).toEqual(['E']);
    expect(linhaDe(l, diabetico)?.situacao).toContain('pé grau 1');
    const pend = (await t.http().get(`/api/indicadores-aps/pendencias?teamId=${teamId}&codigo=C4`).set(auth(gestora)).expect(200)).body;
    const linha = pend.pessoas.find((p: { patientId: string }) => p.patientId === diabetico);
    expect(linha.faltam.map((f: { letra: string }) => f.letra)).toEqual(['D', 'E']);
    const estrat = (await t.http().get(`/api/programas/estratificacoes?patientId=${diabetico}`).set(auth(enfermeira)).expect(200)).body;
    expect(estrat[0]).toMatchObject({ kind: 'PE_DIABETICO', result: '1', assessedBy: 'Carla Menezes Médica' });
  });

  it('tuberculose, Bolsa Família, SISVAN e idoso', async () => {
    const tb = await pessoa({ name: 'Tuberculose Programas Teste', birthDate: '1988-08-08', sex: 'M' });
    await t
      .http()
      .post(`/api/patients/${tb}/conditions`)
      .set(auth(medica))
      .send({ system: 'CID10', code: 'A15.0', description: 'Tuberculose pulmonar', lineOfCare: 'TUBERCULOSE', onsetAt: mais(hoje, -230) })
      .expect(201);
    const l1 = await lista('TB_HANSENIASE');
    expect(codigos(l1, tb)).toEqual(['CONSULTA', 'ALTA']);
    expect(linhaDe(l1, tb)?.situacao).toContain('Tuberculose desde');

    const beneficiaria = await pessoa({ name: 'Beneficiaria Programas Teste', birthDate: '1996-06-06', sex: 'F', bolsaFamilia: true });
    const l2 = await lista('BOLSA_FAMILIA');
    expect(codigos(l2, beneficiaria)).toEqual(['ANTROPOMETRIA']);
    expect(linhaDe(l2, beneficiaria)?.situacao).toContain('Mulher 14 a 44 anos');

    const idoso = await pessoa({ name: 'Idoso Programas Teste', birthDate: '1961-01-01', sex: 'M' });
    await consulta(idoso, true);
    const l3 = await lista('SISVAN');
    expect(codigos(l3, idoso)).toEqual([]);
    expect(linhaDe(l3, idoso)?.situacao).toContain('Eutrofia (IMC 26.6)');
    const crianca = await pessoa({ name: 'Pequeno Programas Teste', birthDate: mais(hoje, -400), sex: 'F' });
    const l4 = await lista('SISVAN');
    expect(codigos(l4, crianca)).toEqual(['ANTROPOMETRIA']);
    const l5 = await lista('IDOSO');
    expect(codigos(l5, idoso)).toEqual(['D']);

    const resumo = (await t.http().get(`/api/programas/resumo?teamId=${teamId}`).set(auth(enfermeira)).expect(200)).body;
    expect(resumo.programas).toHaveLength(8);
    expect(resumo.programas.find((p: { codigo: string }) => p.codigo === 'TB_HANSENIASE')).toMatchObject({ populacao: 1, faltosos: 1 });
    await t.http().get(`/api/programas/resumo?teamId=${teamId}`).set(auth(recepcao)).expect(403);
    await t.http().get('/api/programas/INEXISTENTE').set(auth(enfermeira)).expect(404);
  });
});
