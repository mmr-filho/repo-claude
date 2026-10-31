import { cnsFromBase, completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();
const DIA = 86_400_000;
/** Data sem hora deslocada em dias (aritmética em UTC sobre AAAA-MM-DD). */
const mais = (iso: string, dias: number) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + dias)).toISOString().slice(0, 10);
const instante = (iso: string, hora = 12) => new Date(`${iso}T${String(hora).padStart(2, '0')}:00:00.000Z`).toISOString();

/**
 * Equipe de teste com registros conhecidos: os números do painel são conferidos contra o cálculo manual
 * das notas metodológicas (boas práticas, pontos, média, conceito, nota final e valor do repasse).
 */
describe.runIf(enabled)('Indicadores do cofinanciamento da APS: cálculo manual numa equipe de teste', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let gestora: string;
  let recepcao: string;
  let medica: string;
  let faturamento: string;
  let ubsId = '';
  let medicaId = '';
  let enfermeiroId = '';
  let teamId = '';
  let hoje = '';
  let competencia = '';
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const address = { cep: '77405070', street: 'Rua das Equipes', number: '10', district: 'Setor Central', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('indicators', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    faturamento = await t.login('faturamento', 'UPA 24h Norte', 'FATURAMENTO');
    const meGestora = (await t.http().get('/api/auth/me').set(auth(gestora)).expect(200)).body;
    ubsId = meGestora.context.unitId;
    hoje = new Intl.DateTimeFormat('en-CA', { timeZone: meGestora.tenant.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    competencia = hoje.slice(0, 7);
    medicaId = (await t.http().get('/api/auth/me').set(auth(medica)).expect(200)).body.user.id;
    enfermeiroId = (
      await t
        .http()
        .get('/api/auth/me')
        .set(auth(await t.login('enfermeiro', 'UBS Centro', 'ENFERMAGEM')))
        .expect(200)
    ).body.user.id;
  });
  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  let seq = 0;
  async function pessoa(input: { name: string; birthDate: string; sex: 'F' | 'M' }) {
    seq++;
    const body = { ...input, cpf: completeCpf(`48800000${seq}`), cns: cnsFromBase(`288000000${String(seq).padStart(2, '0')}`), motherName: 'Mae Indicadores Teste', address };
    const p = (await t.http().post('/api/patients').set(auth(recepcao)).send(body).expect(201)).body;
    await t
      .http()
      .post('/api/households')
      .set(auth(recepcao))
      .send({ ...address, number: String(10 + seq), unitId: ubsId, teamId, family: { responsibleId: p.id } })
      .expect(201);
    return p.id as string;
  }
  async function consulta(
    patientId: string,
    opts: { codes?: { system: 'CID10' | 'CIAP2'; code: string }[]; triagem?: boolean; exames?: { sigtapCode: string; name: string; analyte?: string }[]; encounterId?: string } = {},
  ) {
    const encId = opts.encounterId ?? (await t.http().post('/api/reception/check-in').set(auth(recepcao)).send({ patientId, kind: 'AMBULATORIAL' }).expect(201)).body.id;
    if (opts.triagem) {
      const enfermeira = await t.login('enfermeiro', 'UBS Centro', 'ENFERMAGEM');
      await t
        .http()
        .post(`/api/triage/encounters/${encId}`)
        .set(auth(enfermeira))
        .send({ complaint: 'Acompanhamento', systolic: 128, diastolic: 82, heartRate: 76, temperature: 36.4, weightKg: 68, heightCm: 160 })
        .expect(201);
    }
    await t.http().post(`/api/clinical/encounters/${encId}/start`).set(auth(medica)).expect(200);
    if (opts.exames?.length) await t.http().post(`/api/clinical/encounters/${encId}/exams`).set(auth(medica)).send({ items: opts.exames }).expect(201);
    const note = (
      await t
        .http()
        .post(`/api/clinical/encounters/${encId}/notes`)
        .set(auth(medica))
        .send({ kind: 'SOAP', subjective: 'Consulta de acompanhamento', assessment: 'Estável', plan: 'Manter', codes: opts.codes ?? [{ system: 'CIAP2', code: 'A98' }] })
        .expect(201)
    ).body;
    await t.http().post(`/api/clinical/notes/${note.id}/sign`).set(auth(medica)).expect(200);
    await t.http().post(`/api/clinical/encounters/${encId}/close`).set(auth(medica)).send({ outcome: 'ALTA' }).expect(200);
    return encId as string;
  }
  const vacina = (patientId: string, vaccineCode: string, vaccineName: string, dia: string, dose = '1ª dose') =>
    t
      .http()
      .post('/api/clinical/vaccinations')
      .set(auth(medica))
      .send({ patientId, vaccineCode, vaccineName, lot: 'L1', manufacturer: 'Butantan', dose, route: 'Intramuscular', site: 'Deltoide', appliedAt: dia === hoje ? new Date().toISOString() : instante(dia) })
      .expect(201);

  it('cadastra a equipe eSF de teste com modalidade e membros', async () => {
    await t.http().post('/api/admin/teams').set(auth(gestora)).send({ ine: '0000009901', name: 'ESF Teste', typeCode: '70', unitId: ubsId, modality: 'EAP_20H' }).expect(400);
    const team = (
      await t
        .http()
        .post('/api/admin/teams')
        .set(auth(gestora))
        .send({
          ine: '0000009901',
          name: 'ESF Teste',
          typeCode: '70',
          unitId: ubsId,
          modality: 'ESF_40H',
          members: [
            { userId: medicaId, cbo: '225125' },
            { userId: enfermeiroId, cbo: '223505', microArea: '01' },
          ],
        })
        .expect(201)
    ).body;
    expect(team).toMatchObject({ ine: '0000009901', typeCode: '70', modality: 'ESF_40H', modalityLabel: 'eSF 40h', members: 2, source: 'MANUAL' });
    teamId = team.id;
    await t.http().post('/api/admin/teams').set(auth(gestora)).send({ ine: '0000009901', name: 'Repetida', typeCode: '70', unitId: ubsId }).expect(409);
    const list = (await t.http().get('/api/admin/teams').set(auth(gestora)).expect(200)).body;
    expect(list.find((x: { id: string }) => x.id === teamId).modalityOptions).toEqual([{ value: 'ESF_40H', label: 'eSF 40h' }]);
  });

  it('apura C1 a C7, a nota final e o valor do repasse conforme o cálculo manual', async () => {
    // Pessoa idosa com consulta, PA/peso/altura e influenza: A+B+D = 75 (visita do ACS sem fonte).
    const idosa = await pessoa({ name: 'Idosa Indicadores Teste', birthDate: '1950-01-01', sex: 'F' });
    await consulta(idosa, { triagem: true });
    await vacina(idosa, '33', 'Influenza trivalente', hoje);
    // Pessoa idosa sem nenhum registro: 0.
    await pessoa({ name: 'Idoso Sem Registro Teste', birthDate: '1958-06-15', sex: 'M' });
    // Diabética: consulta, PA, peso/altura, hemoglobina glicada e exame do pé (A20+B15+C15+E15+F15 = 80); mamografia para C7-D.
    const diabetica = await pessoa({ name: 'Diabetica Indicadores Teste', birthDate: '1976-03-10', sex: 'F' });
    await t.http().post(`/api/patients/${diabetica}/conditions`).set(auth(medica)).send({ system: 'CID10', code: 'E11', description: 'Diabetes mellitus tipo 2', lineOfCare: 'DIABETES' }).expect(201);
    await consulta(diabetica, {
      codes: [{ system: 'CID10', code: 'E11' }],
      triagem: true,
      exames: [
        { sigtapCode: '0202010503', name: 'Hemoglobina glicada', analyte: 'HBA1C' },
        { sigtapCode: '0204030188', name: 'Mamografia bilateral para rastreamento' },
      ],
    });
    await t
      .http()
      .post('/api/billing/production')
      .set(auth(faturamento))
      .send({ unitId: ubsId, patientId: diabetica, professionalId: medicaId, cbo: '225125', procedureCode: '0301040095', performedAt: new Date().toISOString(), instrument: 'BPA_I' })
      .expect(201);
    // Hipertenso: só a consulta (A = 25).
    const hipertenso = await pessoa({ name: 'Hipertenso Indicadores Teste', birthDate: '1971-05-05', sex: 'M' });
    await t.http().post(`/api/patients/${hipertenso}/conditions`).set(auth(medica)).send({ system: 'CIAP2', code: 'K86', description: 'Hipertensão sem complicações', lineOfCare: 'HIPERTENSAO' }).expect(201);
    await consulta(hipertenso, { codes: [{ system: 'CIAP2', code: 'K86' }] });
    // Gestação cujo puerpério termina hoje (DUM = hoje - 336 dias): só a consulta de hoje, no puerpério (I = 9).
    const gestante = await pessoa({ name: 'Gestante Indicadores Teste', birthDate: '1998-02-02', sex: 'F' });
    await t
      .http()
      .post(`/api/patients/${gestante}/conditions`)
      .set(auth(medica))
      .send({ system: 'CID10', code: 'Z34', description: 'Supervisão de gravidez normal', lineOfCare: 'GESTANTE', onsetAt: mais(hoje, -336) })
      .expect(201);
    await consulta(gestante, { codes: [{ system: 'CID10', code: 'Z39.2' }] });
    // Mulher de 30 anos: consulta agendada (demanda programada) com CID de saúde sexual e reprodutiva e citopatológico solicitado.
    const mulher = await pessoa({ name: 'Mulher Trinta Indicadores Teste', birthDate: '1996-07-07', sex: 'F' });
    const schedule = (
      await t
        .http()
        .post('/api/scheduling/schedules')
        .set(auth(gestora))
        .send({
          professionalId: medicaId,
          name: 'Agenda de indicadores',
          cbo: '225125',
          slotMinutes: 30,
          rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '08:00', endTime: '18:00', firstVisitQuota: 20, returnQuota: 20 })),
        })
        .expect(201)
    ).body;
    const slots = (
      await t
        .http()
        .get(`/api/scheduling/schedules/${schedule.id}/slots?date=${mais(hoje, 1)}`)
        .set(auth(recepcao))
        .expect(200)
    ).body.slots;
    const appt = (await t.http().post('/api/scheduling/appointments').set(auth(recepcao)).send({ scheduleId: schedule.id, patientId: mulher, startsAt: slots[0].startsAt, kind: 'PRIMEIRA_CONSULTA' }).expect(201)).body;
    const chegada = await t.http().post(`/api/scheduling/appointments/${appt.id}/check-in`).set(auth(recepcao));
    expect([200, 201]).toContain(chegada.status);
    const agendado = chegada.body;
    await consulta(mulher, { encounterId: agendado.id, codes: [{ system: 'CID10', code: 'Z30.0' }], exames: [{ sigtapCode: '0203010086', name: 'Citopatológico cérvico-vaginal (rastreamento)' }] });
    // Menina de 12 anos vacinada contra HPV.
    const menina = await pessoa({ name: 'Menina Doze Indicadores Teste', birthDate: mais(hoje, -12 * 365 - 100), sex: 'F' });
    await vacina(menina, '67', 'HPV quadrivalente', hoje);
    // Criança que completa dois anos hoje: esquema vacinal completo (E = 20), uma única consulta.
    const nasc = `${Number(hoje.slice(0, 4)) - 2}${hoje.slice(4)}`;
    const crianca = await pessoa({ name: 'Crianca Dois Anos Teste', birthDate: nasc, sex: 'F' });
    for (const [i, d] of [60, 120, 180].entries()) {
      await vacina(crianca, '42', 'Penta', mais(nasc, d), `${i + 1}ª dose`);
      await vacina(crianca, '22', 'VIP', mais(nasc, d), `${i + 1}ª dose`);
    }
    for (const [i, d] of [60, 120].entries()) await vacina(crianca, '26', 'Pneumo 10', mais(nasc, d), `${i + 1}ª dose`);
    for (const [i, d] of [370, 455].entries()) await vacina(crianca, '24', 'Tríplice viral', mais(nasc, d), `${i + 1}ª dose`);
    await consulta(crianca, { codes: [{ system: 'CIAP2', code: 'A98' }] });

    await t.http().get(`/api/indicadores-aps?competencia=${competencia}`).set(auth(recepcao)).expect(403);
    const painel = (await t.http().get(`/api/indicadores-aps?competencia=${competencia}&unitId=${ubsId}`).set(auth(gestora)).expect(200)).body;
    const equipe = painel.equipes.find((e: { team: { id: string } }) => e.team.id === teamId);
    expect(equipe, JSON.stringify(painel.equipes.map((e: { team: { name: string } }) => e.team.name))).toBeDefined();
    expect(equipe.pessoasVinculadas).toBe(8);
    const ind = (codigo: string) => equipe.indicadores.find((i: { codigo: string }) => i.codigo === codigo);
    const mes = (codigo: string) => ind(codigo).meses[ind(codigo).meses.length - 1];
    // C1: 1 atendimento agendado entre os 6 desta equipe no mês (a demonstração pode ter atendimentos antigos da médica no mesmo mês).
    expect(mes('C1').competencia).toBe(competencia);
    expect(mes('C1').numerador).toBe(1);
    expect(mes('C1').denominador).toBeGreaterThanOrEqual(6);
    expect(mes('C1').valor).toBe(Math.round((100 / mes('C1').denominador) * 100) / 100);
    expect(mes('C2')).toMatchObject({ denominador: 1, valor: 20 });
    expect(mes('C2').detalhe).toMatchObject({ A: { obtido: 0, possivel: 1 }, E: { obtido: 1, possivel: 1 } });
    expect(mes('C3')).toMatchObject({ denominador: 1, valor: 9 });
    expect(mes('C4')).toMatchObject({ denominador: 1, valor: 80 });
    expect(mes('C5')).toMatchObject({ denominador: 1, valor: 25 });
    expect(mes('C6')).toMatchObject({ denominador: 2, valor: 37.5 });
    // C7: A 1/3 × 20 = 6,67 · B 1/1 × 30 = 30 · C 1/3 × 30 = 10 · D 1/1 × 20 = 20 → 66,67
    expect(mes('C7').detalhe).toEqual({ A: { obtido: 1, possivel: 3 }, B: { obtido: 1, possivel: 1 }, C: { obtido: 1, possivel: 3 }, D: { obtido: 1, possivel: 1 } });
    expect(mes('C7').valor).toBe(66.67);
    for (const c of ['C2', 'C3', 'C4', 'C5', 'C6', 'C7']) expect(ind(c).resultado, c).toBe(mes(c).valor);
    expect(['C2', 'C3', 'C4', 'C5', 'C6', 'C7'].map((c) => ind(c).conceito)).toEqual(['REGULAR', 'REGULAR', 'OTIMO', 'REGULAR', 'SUFICIENTE', 'BOM']);
    // Nota: C2 0,25×2 + C3 0,25×2 + C4 1×1 + C5 0,25×1 + C6 0,5×1 + C7 0,75×2 = 4,25 + C1 (peso 1).
    const notaC1 = ind('C1').nota;
    expect(equipe.notaFinal).toBeCloseTo(4.25 + notaC1, 2);
    expect(equipe.semResultado).toEqual([]);
    expect(equipe.notaEstimada).toBe(equipe.notaFinal);
    expect(equipe.classificacao).toBe(equipe.notaFinal >= 5 ? 'BOM' : 'SUFICIENTE');
    expect(equipe.valorMensal).toBe(equipe.classificacao === 'BOM' ? 6000 : 4000);
    expect(equipe.repasseQuadrimestre).toBe(equipe.valorMensal * 4);
    expect(equipe.proximoNivel.diferencaMensal).toBe(2000);
    expect(painel.totais.valorMensal).toBeGreaterThanOrEqual(equipe.valorMensal);

    // Lista nominal: quem falta e o que falta (acesso auditado).
    const pend = (await t.http().get(`/api/indicadores-aps/pendencias?teamId=${teamId}&codigo=C4&competencia=${competencia}`).set(auth(gestora)).expect(200)).body;
    expect(pend.pessoas).toHaveLength(1);
    expect(pend.pessoas[0]).toMatchObject({ nome: 'Diabetica Indicadores Teste', pontos: 80, maximo: 100 });
    expect(pend.pessoas[0].faltam.map((f: { letra: string }) => f.letra)).toEqual(['D']);
    const pendC6 = (await t.http().get(`/api/indicadores-aps/pendencias?teamId=${teamId}&codigo=C6&competencia=${competencia}`).set(auth(gestora)).expect(200)).body;
    expect(pendC6.pessoas.map((p: { nome: string; pontos: number }) => [p.nome, p.pontos])).toEqual([
      ['Idoso Sem Registro Teste', 0],
      ['Idosa Indicadores Teste', 75],
    ]);
    const pendC3 = (await t.http().get(`/api/indicadores-aps/pendencias?teamId=${teamId}&codigo=C3&competencia=${competencia}`).set(auth(gestora)).expect(200)).body;
    expect(pendC3.pessoas[0]).toMatchObject({ nome: 'Gestante Indicadores Teste', pontos: 9 });
    expect(pendC3.pessoas[0].observacao).toContain('puerpério');
    const audit = (await t.http().get(`/api/audit/entries?entityType=Team&entityId=${teamId}`).set(auth(gestora)).expect(200)).body;
    expect(audit.filter((a: { action: string }) => a.action === 'indicadores.lista_nominal').length).toBeGreaterThanOrEqual(3);

    // Encerrar a condição com desfecho: a hipertensão resolvida sai do denominador de C5.
    const cond = (await t.http().get(`/api/patients/${hipertenso}`).set(auth(medica)).expect(200)).body.conditions[0];
    await t
      .http()
      .patch(`/api/patients/${hipertenso}/conditions/${cond.id}`)
      .set(auth(medica))
      .send({ active: false, resolvedAt: mais(hoje, -1) })
      .expect(200);
    const depois = (await t.http().get(`/api/indicadores-aps?competencia=${competencia}&unitId=${ubsId}`).set(auth(gestora)).expect(200)).body;
    const c5 = depois.equipes.find((e: { team: { id: string } }) => e.team.id === teamId).indicadores.find((i: { codigo: string }) => i.codigo === 'C5');
    expect(c5.resultado).toBeNull();
    expect(depois.equipes.find((e: { team: { id: string } }) => e.team.id === teamId).semResultado).toEqual(['C5']);
  });

  it('serve as fichas técnicas dos 15 indicadores com pesos e valores', async () => {
    const fichas = (await t.http().get('/api/indicadores-aps/fichas').set(auth(medica)).expect(200)).body;
    expect(fichas.indicadores).toHaveLength(15);
    expect(fichas.valores.ESF_40H.OTIMO).toBe(8000);
    expect(fichas.indicadores.find((i: { codigo: string }) => i.codigo === 'C3').boasPraticas).toHaveLength(11);
  });
});
