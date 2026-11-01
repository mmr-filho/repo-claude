import { cnsFromBase, completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();

describe.runIf(enabled)('App do cidadão (CID-1)', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let recepcao: string;
  let medica: string;
  let enfermeiro: string;
  let pacienteId = '';
  let cpf = '';
  let token = '';
  const birthDate = '1980-05-20';
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const address = { cep: '77405070', street: 'Rua do Cidadão', number: '10', district: 'Centro', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };
  const codigoEnviado = async () => {
    const sent = (await (await fetch(`${mocks.url}/whatsapp/_sent`)).json()) as { to: string; payload: unknown }[];
    const ultimo = sent.filter((m) => JSON.stringify(m.payload).includes('codigo_acesso')).at(-1);
    const m = /"text"\s*:\s*"(\d{6})"/.exec(JSON.stringify(ultimo?.payload ?? {}));
    return { to: ultimo?.to, codigo: m?.[1] ?? null };
  };

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('cidadao', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    enfermeiro = await t.login('enfermeiro', 'UBS Centro', 'ENFERMAGEM');
    cpf = completeCpf('477000701');
    pacienteId = (
      await t
        .http()
        .post('/api/patients')
        .set(auth(recepcao))
        .send({ name: 'Cecilia Cidada Teste', birthDate, sex: 'F', cpf, cns: cnsFromBase('27700000701'), motherName: 'Mae Cidada Teste', phone: '(63) 99999-0701', whatsappOptIn: true, address })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('pede o código: resposta genérica para cadastro inexistente e envio pelo WhatsApp para o cadastro certo', async () => {
    const nada = await t
      .http()
      .post('/api/cidadao/acesso/solicitar')
      .send({ tenant: t.slug, cpf: completeCpf('477000799'), birthDate })
      .expect(200);
    expect(nada.body.canal).toBe('nenhum');
    const dataErrada = await t.http().post('/api/cidadao/acesso/solicitar').send({ tenant: t.slug, cpf, birthDate: '1981-01-01' }).expect(200);
    expect(dataErrada.body.canal).toBe('nenhum');
    await fetch(`${mocks.url}/whatsapp/_sent`, { method: 'DELETE' });
    const ok = await t
      .http()
      .post('/api/cidadao/acesso/solicitar')
      .send({ tenant: t.slug, cpf: '477.000.701-' + cpf.slice(9), birthDate })
      .expect(200);
    expect(ok.body).toMatchObject({ canal: 'whatsapp', telefone: '(63) *****-0701', validadeMinutos: 10 });
    const { to, codigo } = await codigoEnviado();
    expect(to?.endsWith('999990701')).toBe(true);
    expect(codigo).toMatch(/^\d{6}$/);
  });

  it('confirma o código (uma vez só, com limite de tentativas) e abre a sessão do cidadão', async () => {
    const { codigo } = await codigoEnviado();
    await t.http().post('/api/cidadao/acesso/confirmar').send({ tenant: t.slug, cpf, birthDate, codigo: '000000' }).expect(401);
    const ok = await t.http().post('/api/cidadao/acesso/confirmar').send({ tenant: t.slug, cpf, birthDate, codigo: codigo! }).expect(200);
    token = ok.body.token;
    expect(ok.body.cidadao).toMatchObject({ id: pacienteId, nome: 'Cecilia Cidada Teste', primeiroNome: 'Cecilia' });
    expect(ok.body.instituicao.slug).toBe(t.slug);
    await t.http().post('/api/cidadao/acesso/confirmar').send({ tenant: t.slug, cpf, birthDate, codigo: codigo! }).expect(401);
    // Token do cidadão não abre rotas de profissional, e token de profissional não abre rotas do cidadão.
    await t.http().get('/api/patients?q=Cecilia').set(auth(token)).expect(401);
    await t.http().get('/api/cidadao/eu').set(auth(recepcao)).expect(401);
    await t.http().get('/api/cidadao/eu').expect(401);
  });

  it('recepção entrega um código de 24 h e limita pedidos repetidos pelo WhatsApp', async () => {
    const cod = await t.http().post('/api/cidadao/codigos').set(auth(recepcao)).send({ patientId: pacienteId }).expect(201);
    expect(cod.body.codigo).toMatch(/^\d{6}$/);
    expect(cod.body.validadeHoras).toBe(24);
    expect(cod.body.instrucoes).toContain('477.000.701');
    const ok = await t.http().post('/api/cidadao/acesso/confirmar').send({ tenant: t.slug, cpf, birthDate, codigo: cod.body.codigo }).expect(200);
    expect(ok.body.token).toBeTruthy();
    await t.http().post('/api/cidadao/codigos').set(auth(medica)).send({ patientId: pacienteId }).expect(403);
    await t.http().post('/api/cidadao/acesso/solicitar').send({ tenant: t.slug, cpf, birthDate }).expect(200);
    await t.http().post('/api/cidadao/acesso/solicitar').send({ tenant: t.slug, cpf, birthDate }).expect(200);
    await t.http().post('/api/cidadao/acesso/solicitar').send({ tenant: t.slug, cpf, birthDate }).expect(429);
  });

  it('mostra o resumo, as unidades e a senha do dia', async () => {
    const eu = (await t.http().get('/api/cidadao/eu').set(auth(token)).expect(200)).body;
    expect(eu.cidadao).toMatchObject({ nome: 'Cecilia Cidada Teste', cpf: '***.000.701-**', telefone: '(63) *****-0701', whatsapp: true, idade: expect.any(Number) });
    expect(eu.pendencias).toMatchObject({ examesNovos: 0, solicitacoesEmAndamento: 0 });
    expect(eu.senhaHoje).toBeNull();
    const unidades = (await t.http().get('/api/cidadao/unidades').set(auth(token)).expect(200)).body;
    expect(unidades.some((u: { name: string; tipoLabel: string }) => u.name === 'UBS Centro' && u.tipoLabel)).toBe(true);
    const senha = (await t.http().post('/api/reception/tickets').set(auth(recepcao)).send({ kind: 'NORMAL', patientId: pacienteId }).expect(201)).body;
    const minha = (await t.http().get('/api/cidadao/senha').set(auth(token)).expect(200)).body;
    expect(minha).toMatchObject({ senha: senha.code, status: 'AGUARDANDO', unidade: 'UBS Centro' });
    expect(minha.posicao).toBeGreaterThanOrEqual(1);
  });

  it('agenda: lista, confirma, cancela (só os futuros) e controla o lembrete por WhatsApp', async () => {
    const schedules = (await t.http().get('/api/scheduling/schedules').set(auth(recepcao)).expect(200)).body as { id: string; name: string }[];
    const schedule = schedules[0]!;
    const dia = new Date(Date.now() + 3 * 86_400_000);
    while ([0, 6].includes(dia.getUTCDay())) dia.setUTCDate(dia.getUTCDate() + 1);
    const slots = (
      await t
        .http()
        .get(`/api/scheduling/schedules/${schedule.id}/slots?date=${dia.toISOString().slice(0, 10)}`)
        .set(auth(recepcao))
        .expect(200)
    ).body.slots as { startsAt: string; status: string }[];
    const livres = slots.filter((s) => s.status === 'LIVRE');
    const a1 = (await t.http().post('/api/scheduling/appointments').set(auth(recepcao)).send({ scheduleId: schedule.id, patientId: pacienteId, startsAt: livres[0]!.startsAt, kind: 'RETORNO' }).expect(201)).body;
    const agenda = (await t.http().get('/api/cidadao/agenda').set(auth(token)).expect(200)).body;
    expect(agenda.proximos).toHaveLength(1);
    expect(agenda.proximos[0]).toMatchObject({ id: a1.id, servico: schedule.name, status: 'AGENDADO', podeCancelar: true, podeConfirmar: true, unidade: { nome: 'UBS Centro' } });
    expect(agenda.lembretes).toMatchObject({ whatsapp: true, telefone: '(63) *****-0701' });
    const conf = (await t.http().post(`/api/cidadao/agenda/${a1.id}/confirmar`).set(auth(token)).expect(200)).body;
    expect(conf.proximos[0]).toMatchObject({ status: 'CONFIRMADO', podeConfirmar: false, podeCancelar: true });
    await t.http().post(`/api/cidadao/agenda/${a1.id}/confirmar`).set(auth(token)).expect(422);
    const canc = (await t.http().post(`/api/cidadao/agenda/${a1.id}/cancelar`).set(auth(token)).send({ motivo: 'Vou viajar' }).expect(200)).body;
    expect(canc.proximos).toHaveLength(0);
    expect(canc.historico[0]).toMatchObject({ id: a1.id, status: 'CANCELADO' });
    const appt = (
      await t
        .http()
        .get(`/api/scheduling/appointments?scheduleId=${schedule.id}&date=${dia.toISOString().slice(0, 10)}`)
        .set(auth(recepcao))
        .expect(200)
    ).body as { id: string; cancelReason: string | null }[];
    expect(appt.find((a) => a.id === a1.id)?.cancelReason).toContain('cidadão');
    // Agendamento de outra pessoa não aparece nem pode ser cancelado.
    const outro = (
      await t
        .http()
        .post('/api/patients')
        .set(auth(recepcao))
        .send({ name: 'Otavio Cidadao Teste', birthDate: '1975-02-02', sex: 'M', cpf: completeCpf('477000702'), cns: cnsFromBase('27700000702'), motherName: 'Mae Otavio Teste', address })
        .expect(201)
    ).body;
    const a2 = (await t.http().post('/api/scheduling/appointments').set(auth(recepcao)).send({ scheduleId: schedule.id, patientId: outro.id, startsAt: livres[1]!.startsAt, kind: 'RETORNO' }).expect(201)).body;
    await t.http().post(`/api/cidadao/agenda/${a2.id}/cancelar`).set(auth(token)).send({}).expect(404);
    const pref = (await t.http().patch('/api/cidadao/preferencias').set(auth(token)).send({ whatsappOptIn: false }).expect(200)).body;
    expect(pref.whatsapp).toBe(false);
    await t.http().patch('/api/cidadao/preferencias').set(auth(token)).send({ whatsappOptIn: true }).expect(200);
  });

  it('exames com resultado, cartão de vacinas com certificado e medicamentos com estoque na rede', async () => {
    const enc = (await t.http().post('/api/reception/check-in').set(auth(recepcao)).send({ patientId: pacienteId, kind: 'AMBULATORIAL' }).expect(201)).body;
    await t
      .http()
      .post(`/api/clinical/encounters/${enc.id}/exams`)
      .set(auth(medica))
      .send({ items: [{ sigtapCode: '0202010473', name: 'Hemoglobina glicada', analyte: 'HBA1C' }] })
      .expect(201);
    const exames = (await t.http().get('/api/cidadao/exames').set(auth(token)).expect(200)).body;
    expect(exames[0]).toMatchObject({ nome: 'Hemoglobina glicada', status: 'SOLICITADO', statusLabel: 'Solicitado', resultado: null });
    const vacinas = (await t.http().get('/api/cidadao/vacinas').set(auth(token)).expect(200)).body;
    expect(vacinas.certificadoDisponivel).toBe(false);
    expect(Array.isArray(vacinas.proximas)).toBe(true);
    await t.http().get('/api/cidadao/vacinas/certificado.pdf').set(auth(token)).expect(422);
    // A enfermeira transcreve uma dose da caderneta: o cartão do app passa a mostrá-la e o certificado sai em PDF.
    await t
      .http()
      .post('/api/vacinas/aplicar')
      .set(auth(enfermeiro))
      .send({ patientId: pacienteId, vaccineCode: '9', doseCode: '1', transcription: true, lotNumber: 'HB-2026-01', manufacturer: 'Butantan', appliedAt: new Date(Date.now() - 400 * 86_400_000).toISOString() })
      .expect(201);
    const cartao = (await t.http().get('/api/cidadao/vacinas').set(auth(token)).expect(200)).body;
    expect(cartao.certificadoDisponivel).toBe(true);
    expect(cartao.doses).toHaveLength(1);
    expect(cartao.doses[0]).toMatchObject({ lote: 'HB-2026-01', transcrita: true, unidade: 'UBS Centro' });
    expect(cartao.proximas.some((p: { vacina: string; dose: string }) => p.vacina === 'HEPB' && p.dose === '2ª dose')).toBe(true);
    const pdf = await t.http().get('/api/cidadao/vacinas/certificado.pdf').set(auth(token)).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('certificado-vacinacao');
    const med = (await t.http().get('/api/cidadao/medicamentos').set(auth(token)).expect(200)).body;
    expect(med).toMatchObject({ itens: [], retiradas: [] });
    const reg = (await t.http().get('/api/cidadao/regulacao').set(auth(token)).expect(200)).body;
    expect(reg).toMatchObject({ solicitacoes: [], leitos: [], tfd: [] });
  });

  it('fila da regulação com posição e TFD aparecem para o cidadão', async () => {
    const r = await t
      .http()
      .post('/api/regulacao/solicitacoes')
      .set(auth(medica))
      .send({
        patientId: pacienteId,
        kind: 'CONSULTA',
        specialty: 'CARDIOLOGIA',
        priority: 'VERDE',
        cid: 'I10',
        clinicalSummary: 'Hipertensão resistente a três fármacos em dose otimizada; ECG com sobrecarga.',
        criteria: ['HAS_RESISTENTE'],
      })
      .expect(201);
    const reg = (await t.http().get('/api/cidadao/regulacao').set(auth(token)).expect(200)).body;
    expect(reg.solicitacoes[0]).toMatchObject({ protocolo: r.body.protocol, status: 'PENDENTE', prioridade: 'Prioridade', unidadeSolicitante: 'UBS Centro' });
    expect(reg.solicitacoes[0].posicaoNaFila).toBeGreaterThanOrEqual(1);
    const eu = (await t.http().get('/api/cidadao/eu').set(auth(token)).expect(200)).body;
    expect(eu.pendencias.solicitacoesEmAndamento).toBe(1);
  });
});
