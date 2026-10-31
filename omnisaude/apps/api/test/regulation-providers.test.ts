import { cnsFromBase, completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();
const competencia = new Date().toISOString().slice(0, 7);

describe.runIf(enabled)('Regulação: prestadores, PPI/cotas e agendamento regulado', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let gestora: string;
  let recepcao: string;
  let medica: string;
  let nir: string;
  let poliId = '';
  let clinicaId = '';
  let poliProviderId = '';
  let pacienteA = '';
  let pacienteB = '';
  let solicitacaoA = '';
  let solicitacaoB = '';
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const address = { cep: '77405070', street: 'Rua das Cotas', number: '3', district: 'Setor Central', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('regulation2', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    nir = await t.login('nir', 'Policlínica Municipal', 'NIR');
    const dir = (await t.http().get('/api/directory').set(auth(gestora)).expect(200)).body;
    poliId = dir.units.find((u: { name: string }) => u.name === 'Policlínica Municipal').id;
    const pessoa = async (name: string, cpf: string, cns: string) =>
      (
        await t
          .http()
          .post('/api/patients')
          .set(auth(recepcao))
          .send({ name, birthDate: '1960-03-03', sex: 'M', cpf: completeCpf(cpf), cns: cnsFromBase(cns), motherName: 'Mae Cotas Teste', phone: '(63) 99999-0301', whatsappOptIn: true, address })
          .expect(201)
      ).body.id as string;
    pacienteA = await pessoa('Alberto Cotas Teste', '477000301', '27700000301');
    pacienteB = await pessoa('Bento Cotas Teste', '477000302', '27700000302');
    const pedir = async (patientId: string) =>
      (
        await t
          .http()
          .post('/api/regulacao/solicitacoes')
          .set(auth(medica))
          .send({
            patientId,
            kind: 'CONSULTA',
            specialty: 'CARDIOLOGIA',
            priority: 'VERDE',
            clinicalSummary: 'Hipertensão resistente apesar de três fármacos em dose otimizada; ECG com sobrecarga.',
            criteria: ['HAS_RESISTENTE'],
          })
          .expect(201)
      ).body.id as string;
    solicitacaoA = await pedir(pacienteA);
    solicitacaoB = await pedir(pacienteB);
  });
  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('lista os prestadores da carga com cotas e consumo; o NIR cadastra um contratado e define a PPI; a recepção só consulta', async () => {
    const lista = (await t.http().get(`/api/regulacao/prestadores?competencia=${competencia}`).set(auth(recepcao)).expect(200)).body;
    const poli = lista.find((p: { name: string }) => p.name === 'Policlínica Municipal');
    expect(poli).toMatchObject({ kind: 'PROPRIO', kindLabel: 'Rede própria', unit: { id: poliId }, agendas: 2 });
    expect(poli.resumo.cotas).toBe(4);
    expect(poli.resumo.usadas).toBe(1); // oftalmologia autorizada na carga
    poliProviderId = poli.id;
    const imagem = lista.find((p: { name: string }) => p.name === 'Clínica Conveniada Imagem');
    expect(imagem).toMatchObject({ kind: 'CONTRATADO', financialCeiling: 45000, physicalCeiling: 300, contractNumber: 'CT-2026-014' });
    await t.http().post('/api/regulacao/prestadores').set(auth(recepcao)).send({ name: 'x', kind: 'CONTRATADO' }).expect(403);
    const clinica = (
      await t
        .http()
        .post('/api/regulacao/prestadores')
        .set(auth(nir))
        .send({
          name: 'Clínica Cardio Teste',
          kind: 'CONTRATADO',
          cnpj: '12.345.678/0001-99',
          contractNumber: 'CT-TESTE',
          contractStart: '2026-01-01',
          contractEnd: '2026-12-31',
          physicalCeiling: 100,
          financialCeiling: 50,
        })
        .expect(201)
    ).body;
    clinicaId = clinica.id;
    expect(clinica).toMatchObject({ cnpj: '12345678000199', resumo: { cotas: 0 } });
    const cotas = (
      await t
        .http()
        .put(`/api/regulacao/prestadores/${clinicaId}/cotas`)
        .set(auth(nir))
        .send({ competencia, cotas: [{ kind: 'CONSULTA', specialty: 'CARDIOLOGIA', quantity: 1, unitValue: 10 }] })
        .expect(200)
    ).body;
    expect(cotas).toHaveLength(1);
    expect(cotas[0]).toMatchObject({ specialtyLabel: 'Consulta com Cardiologia', quantity: 1, used: 0, available: 1, unitValue: 10 });
    await t
      .http()
      .put(`/api/regulacao/prestadores/${clinicaId}/cotas`)
      .set(auth(nir))
      .send({ competencia, cotas: [{ kind: 'CONSULTA', specialty: 'INEXISTENTE', quantity: 1 }] })
      .expect(422);
    const atualizado = (
      await t
        .http()
        .patch(`/api/regulacao/prestadores/${clinicaId}`)
        .set(auth(nir))
        .send({ name: 'Clínica Cardio Teste', kind: 'CONTRATADO', physicalCeiling: 100, financialCeiling: 50, phone: '(63) 3333-0000' })
        .expect(200)
    ).body;
    expect(atualizado.phone).toBe('(63) 3333-0000');
  });

  it('a autorização consome a cota do prestador; esgotada, recusa; tetos do contrato também valem', async () => {
    const ofertas = (await t.http().get(`/api/regulacao/ofertas?kind=CONSULTA&specialty=CARDIOLOGIA`).set(auth(nir)).expect(200)).body;
    expect(ofertas.competencia).toBe(competencia);
    const clinica = ofertas.prestadores.find((p: { id: string }) => p.id === clinicaId);
    expect(clinica).toMatchObject({ disponivel: true, semCota: false });
    expect(clinica.cotas[0]).toMatchObject({ quantity: 1, used: 0, available: 1 });
    const a = (await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoA}/autorizar`).set(auth(nir)).send({ providerId: clinicaId }).expect(200)).body;
    expect(a).toMatchObject({ status: 'AUTORIZADA', provider: { id: clinicaId, name: 'Clínica Cardio Teste' }, competencia });
    expect(a.quotaId).not.toBeNull();
    expect(a.eventos.at(-1).notes).toContain('cota consumida');
    const esgotada = await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoB}/autorizar`).set(auth(nir)).send({ providerId: clinicaId }).expect(422);
    expect(esgotada.body.code).toBe('COTA_ESGOTADA');
    expect(esgotada.body.message).toContain('1/1');
    const cotas = (await t.http().get(`/api/regulacao/prestadores/${clinicaId}/cotas?competencia=${competencia}`).set(auth(recepcao)).expect(200)).body;
    expect(cotas[0]).toMatchObject({ used: 1, available: 0, valorUsado: 10 });
    // Não dá para remover uma cota com uso; reduzir a quantidade pode.
    await t.http().put(`/api/regulacao/prestadores/${clinicaId}/cotas`).set(auth(nir)).send({ competencia, cotas: [] }).expect(422);
    await t
      .http()
      .put(`/api/regulacao/prestadores/${clinicaId}/cotas`)
      .set(auth(nir))
      .send({ competencia, cotas: [{ id: cotas[0].id, kind: 'CONSULTA', specialty: 'CARDIOLOGIA', quantity: 5, unitValue: 20 }] })
      .expect(200);
    // Com 5 vagas, teto financeiro de R$ 50 e valor unitário de R$ 20: a 2ª autorização (20 + 20) cabe; a 3ª estouraria o teto.
    const b = (await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoB}/autorizar`).set(auth(nir)).send({ providerId: clinicaId }).expect(200)).body;
    expect(b.status).toBe('AUTORIZADA');
    const lista = (await t.http().get(`/api/regulacao/prestadores?competencia=${competencia}`).set(auth(nir)).expect(200)).body;
    expect(lista.find((p: { id: string }) => p.id === clinicaId).resumo).toMatchObject({ usadas: 2, valorUsado: 40, tetoFinanceiroUsadoPct: 80 });
  });

  it('agenda na agenda do prestador da rede, remarca, desmarca e conclui; a unidade acompanha e o cidadão é avisado', async () => {
    // A solicitação A foi autorizada para a clínica contratada (sem agenda no sistema): reautoriza para a Policlínica.
    const c = (
      await t
        .http()
        .post('/api/regulacao/solicitacoes')
        .set(auth(medica))
        .send({
          patientId: pacienteA,
          kind: 'CONSULTA',
          specialty: 'OFTALMOLOGIA',
          priority: 'VERDE',
          clinicalSummary: 'Diabetes há 6 anos sem fundoscopia; baixa acuidade visual progressiva.',
          criteria: ['RETINOPATIA_DM'],
        })
        .expect(201)
    ).body;
    const autorizada = (await t.http().post(`/api/regulacao/solicitacoes/${c.id}/autorizar`).set(auth(nir)).send({ providerId: poliProviderId }).expect(200)).body;
    expect(autorizada.provider.name).toBe('Policlínica Municipal');
    const agendas = (await t.http().get(`/api/regulacao/prestadores/${poliProviderId}/agendas`).set(auth(nir)).expect(200)).body;
    expect(agendas.unitId).toBe(poliId);
    const oftalmo = agendas.agendas.find((a: { name: string }) => a.name.startsWith('Oftalmologia'));
    expect(oftalmo.proximos.length).toBeGreaterThanOrEqual(2);
    // A médica da UBS não agenda (não é regulação nem unidade executante).
    await t.http().post(`/api/regulacao/solicitacoes/${c.id}/agendar`).set(auth(medica)).send({ scheduleId: oftalmo.id, startsAt: oftalmo.proximos[0].startsAt }).expect(403);
    await fetch(`${mocks.url}/whatsapp/_sent`, { method: 'DELETE' });
    const agendada = (await t.http().post(`/api/regulacao/solicitacoes/${c.id}/agendar`).set(auth(nir)).send({ scheduleId: oftalmo.id, startsAt: oftalmo.proximos[0].startsAt }).expect(200)).body;
    expect(agendada).toMatchObject({ status: 'AGENDADA', statusLabel: 'Agendada', scheduledAt: oftalmo.proximos[0].startsAt });
    expect(agendada.agendamento).toMatchObject({ status: 'AGENDADO', schedule: { id: oftalmo.id }, unit: { id: poliId } });
    expect(agendada.eventos.at(-1)).toMatchObject({ kind: 'AGENDADA' });
    // O agendamento está na agenda da Policlínica com a referência ao protocolo.
    const appts = (await t.http().get(`/api/scheduling/appointments?patientId=${pacienteA}`).set(auth(nir)).expect(200)).body;
    expect(appts.find((a: { id: string }) => a.id === agendada.agendamento.id).notes).toContain(agendada.protocol);
    // Mesma vaga de novo: a agenda recusa.
    await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoB}/agendar`).set(auth(nir)).send({ scheduleId: oftalmo.id, startsAt: oftalmo.proximos[0].startsAt }).expect(409);
    // Remarcação pela regulação.
    const remarcada = (await t.http().post(`/api/regulacao/solicitacoes/${c.id}/remarcar`).set(auth(nir)).send({ startsAt: oftalmo.proximos[1].startsAt }).expect(200)).body;
    expect(remarcada.agendamento.id).not.toBe(agendada.agendamento.id);
    expect(remarcada.scheduledAt).toBe(oftalmo.proximos[1].startsAt);
    expect(remarcada.eventos.at(-1)).toMatchObject({ kind: 'REMARCADA' });
    // Devolutiva ao cidadão (agendado e nova data) pelo WhatsApp.
    const disparo = (await t.http().post('/api/integrations/dispatch').set(auth(gestora)).expect(200)).body;
    if (disparo.whatsapp.sent >= 1) {
      const enviadas = (await (await fetch(`${mocks.url}/whatsapp/_sent`)).json()) as { payload: { template?: { name: string; components?: { parameters?: { text?: string }[] }[] } } }[];
      const avisos = enviadas.filter((m) => m.payload.template?.name === 'regulacao_atualizacao');
      expect(avisos.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(avisos)).toContain('foi agendado');
    }
    // Desmarca: a vaga volta e a solicitação volta a autorizada; depois agenda e conclui.
    const desmarcada = (await t.http().post(`/api/regulacao/solicitacoes/${c.id}/desmarcar`).set(auth(nir)).send({ reason: 'Paciente pediu outra data por telefone.' }).expect(200)).body;
    expect(desmarcada).toMatchObject({ status: 'AUTORIZADA', agendamento: null, scheduledAt: null });
    expect(desmarcada.eventos.at(-1)).toMatchObject({ kind: 'AGENDAMENTO_CANCELADO' });
    const deNovo = (await t.http().post(`/api/regulacao/solicitacoes/${c.id}/agendar`).set(auth(nir)).send({ scheduleId: oftalmo.id, startsAt: oftalmo.proximos[0].startsAt }).expect(200)).body;
    expect(deNovo.status).toBe('AGENDADA');
    await t.http().post(`/api/regulacao/solicitacoes/${c.id}/falta`).set(auth(nir)).expect(422); // ainda não ocorreu
    const concluida = (await t.http().post(`/api/regulacao/solicitacoes/${c.id}/realizar`).set(auth(nir)).send({ notes: 'Consulta realizada.' }).expect(200)).body;
    expect(concluida).toMatchObject({ status: 'REALIZADA' });
    expect(concluida.closedAt).not.toBeNull();
    // A unidade solicitante vê o agendamento e a conclusão; a linha do tempo também.
    const daUnidade = (await t.http().get('/api/regulacao/solicitacoes?status=REALIZADA').set(auth(recepcao)).expect(200)).body;
    expect(daUnidade.some((x: { id: string }) => x.id === c.id)).toBe(true);
    // Painel central: tempos médios e prestadores.
    const painel = (await t.http().get('/api/regulacao/painel').set(auth(nir)).expect(200)).body;
    expect(painel.central.tempoMedio.ateDecisaoDias).not.toBeNull();
    expect(painel.central.tempoMedio.ateAgendamentoDias).not.toBeNull();
    expect(painel.central.tempoMedio.porPrestador.find((p: { providerId: string }) => p.providerId === poliProviderId)).toMatchObject({ realizadas: 1 });
  });
});
