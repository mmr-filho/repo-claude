import { cnsFromBase, completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();

describe.runIf(enabled)('Regulação ambulatorial: solicitação, protocolo, fila única, decisão e devolutiva', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let gestora: string;
  let recepcao: string;
  let medica: string;
  let enfermeira: string;
  let nir: string;
  let ubsId = '';
  let poliId = '';
  let pacienteId = '';
  let encounterId = '';
  let solicitacaoId = '';
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const address = { cep: '77405070', street: 'Rua da Regulação', number: '12', district: 'Setor Central', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('regulation', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    enfermeira = await t.login('enfermeiro', 'UBS Centro', 'ENFERMAGEM');
    nir = await t.login('nir', 'Policlínica Municipal', 'NIR');
    const me = (await t.http().get('/api/auth/me').set(auth(gestora)).expect(200)).body;
    ubsId = me.context.unitId;
    const dir = (await t.http().get('/api/directory').set(auth(gestora)).expect(200)).body;
    poliId = dir.units.find((u: { name: string }) => u.name === 'Policlínica Municipal').id;
    const p = (
      await t
        .http()
        .post('/api/patients')
        .set(auth(recepcao))
        .send({
          name: 'Regina Regulacao Teste',
          birthDate: '1966-05-20',
          sex: 'F',
          cpf: completeCpf('477000201'),
          cns: cnsFromBase('27700000201'),
          motherName: 'Mae Regulacao Teste',
          phone: '(63) 99999-0201',
          whatsappOptIn: true,
          address,
        })
        .expect(201)
    ).body;
    pacienteId = p.id;
    encounterId = (await t.http().post('/api/reception/check-in').set(auth(recepcao)).send({ patientId: pacienteId, kind: 'AMBULATORIAL' }).expect(201)).body.id;
  });
  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('expõe os protocolos e confere a solicitação contra eles (exames mínimos, critério e justificativa)', async () => {
    const prot = (await t.http().get('/api/regulacao/protocolos').set(auth(recepcao)).expect(200)).body;
    expect(prot.especialidades.find((e: { codigo: string }) => e.codigo === 'CARDIOLOGIA').criterios.length).toBeGreaterThan(3);
    expect(prot.prioridades.VERMELHA.prazoDias).toBe(1);
    const v1 = (await t.http().post('/api/regulacao/verificar').set(auth(medica)).send({ patientId: pacienteId, kind: 'CONSULTA', specialty: 'CARDIOLOGIA', criteria: [], priority: 'AMARELA' }).expect(200)).body;
    expect(v1.pendencias).toEqual([
      'Sem Eletrocardiograma nos últimos 12 meses',
      'Sem Creatinina nos últimos 12 meses',
      'Nenhum critério do protocolo de encaminhamento foi marcado',
      'Prioridade urgência sem justificativa',
    ]);
    // Exames pedidos no atendimento passam a atender o protocolo.
    await t
      .http()
      .post(`/api/clinical/encounters/${encounterId}/exams`)
      .set(auth(medica))
      .send({
        items: [
          { sigtapCode: '0211020036', name: 'Eletrocardiograma' },
          { sigtapCode: '0202010295', name: 'Creatinina', analyte: 'CREATININA' },
        ],
      })
      .expect(201);
    const v2 = (
      await t
        .http()
        .post('/api/regulacao/verificar')
        .set(auth(medica))
        .send({ patientId: pacienteId, kind: 'CONSULTA', specialty: 'CARDIOLOGIA', criteria: ['HAS_RESISTENTE'], priority: 'VERDE' })
        .expect(200)
    ).body;
    expect(v2.pendencias).toEqual([]);
    await t.http().post('/api/regulacao/verificar').set(auth(recepcao)).send({ patientId: pacienteId, kind: 'CONSULTA', specialty: 'CARDIOLOGIA', criteria: [], priority: 'VERDE' }).expect(403);
  });

  it('a médica solicita a partir do atendimento; o pedido recebe protocolo e entra na fila única na ordem certa', async () => {
    const body = {
      patientId: pacienteId,
      encounterId,
      kind: 'CONSULTA',
      specialty: 'CARDIOLOGIA',
      priority: 'AMARELA',
      clinicalSummary: 'Hipertensão resistente com piora recente da dispneia aos esforços moderados e edema de membros inferiores.',
      criteria: ['HAS_RESISTENTE', 'IC_DESCOMPENSADA'],
      cid: 'I10',
    };
    const semJustificativa = await t.http().post('/api/regulacao/solicitacoes').set(auth(medica)).send(body).expect(422);
    expect(semJustificativa.body.code).toBe('JUSTIFICATIVA_OBRIGATORIA');
    const r = (
      await t
        .http()
        .post('/api/regulacao/solicitacoes')
        .set(auth(medica))
        .send({ ...body, priorityJustification: 'Sinais de insuficiência cardíaca descompensada.' })
        .expect(201)
    ).body;
    solicitacaoId = r.id;
    expect(r.protocol).toMatch(/^REG-\d{4}-\d{6}$/);
    expect(r).toMatchObject({
      status: 'PENDENTE',
      statusLabel: 'Aguardando regulação',
      priority: 'AMARELA',
      procedureName: 'Consulta com Cardiologia',
      procedureCode: '0301010072',
      unit: { name: 'UBS Centro' },
      requester: { name: 'Carla Menezes Médica', cbo: '225125' },
      diasEmFila: 0,
      atrasada: false,
    });
    expect(r.criteria.map((c: { codigo: string }) => c.codigo)).toEqual(['HAS_RESISTENTE', 'IC_DESCOMPENSADA']);
    expect(r.protocolIssues).toEqual([]);
    expect(r.eventos[0]).toMatchObject({ kind: 'CRIADA', toStatus: 'PENDENTE', usuario: 'Carla Menezes Médica' });
    // Mesma pessoa, mesma especialidade aberta: recusa a duplicidade.
    await t
      .http()
      .post('/api/regulacao/solicitacoes')
      .set(auth(medica))
      .send({ ...body, priorityJustification: 'x' })
      .expect(409);
    // Enfermagem solicita exame regulado (azul); recepção não solicita.
    const mamo = (
      await t
        .http()
        .post('/api/regulacao/solicitacoes')
        .set(auth(enfermeira))
        .send({
          patientId: pacienteId,
          kind: 'EXAME',
          specialty: 'MAMOGRAFIA',
          priority: 'AZUL',
          clinicalSummary: 'Rastreamento do câncer de mama: 60 anos, sem mamografia há mais de dois anos.',
          criteria: ['RASTREIO_50_69'],
        })
        .expect(201)
    ).body;
    expect(mamo).toMatchObject({ kind: 'EXAME', procedureName: 'Mamografia bilateral', priority: 'AZUL' });
    await t
      .http()
      .post('/api/regulacao/solicitacoes')
      .set(auth(recepcao))
      .send({ ...body, priorityJustification: 'x' })
      .expect(403);

    const fila = (await t.http().get('/api/regulacao/fila').set(auth(nir)).expect(200)).body;
    expect(fila.total).toBeGreaterThanOrEqual(2);
    const ids = fila.itens.map((i: { id: string }) => i.id);
    expect(ids.indexOf(solicitacaoId)).toBeLessThan(ids.indexOf(mamo.id));
    expect(fila.itens.find((i: { id: string }) => i.id === solicitacaoId).posicao).toBe(1);
    expect(fila.porPrioridade.AMARELA).toBeGreaterThanOrEqual(1);
    await t.http().get('/api/regulacao/fila').set(auth(medica)).expect(403);
    // A unidade vê as suas solicitações; a recepção acompanha.
    const daUnidade = (await t.http().get('/api/regulacao/solicitacoes').set(auth(recepcao)).expect(200)).body;
    expect(daUnidade.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([solicitacaoId, mamo.id]));
    const doAtendimento = (await t.http().get(`/api/regulacao/solicitacoes?encounterId=${encounterId}`).set(auth(medica)).expect(200)).body;
    expect(doAtendimento).toHaveLength(1);
  });

  it('o regulador analisa, devolve com pendência; a unidade complementa e a solicitação volta à fila; depois é autorizada com devolutiva', async () => {
    await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoId}/autorizar`).set(auth(medica)).send({}).expect(403);
    const analise = (await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoId}/analisar`).set(auth(nir)).expect(200)).body;
    expect(analise).toMatchObject({ status: 'EM_ANALISE', regulator: { name: 'Fábio Teixeira NIR' } });
    const devolvida = (await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoId}/devolver`).set(auth(nir)).send({ reason: 'Informar a dose atual dos anti-hipertensivos e anexar o ECG.' }).expect(200)).body;
    expect(devolvida).toMatchObject({ status: 'DEVOLVIDA', returnedCount: 1, decisionReason: 'Informar a dose atual dos anti-hipertensivos e anexar o ECG.' });
    // Só a unidade solicitante complementa.
    const outraUnidade = await t.login('medica', 'UPA 24h Norte', 'MEDICO');
    await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoId}/complementar`).set(auth(outraUnidade)).send({ notes: 'tentativa' }).expect(403);
    const doc = (
      await t
        .http()
        .post(`/api/patients/${pacienteId}/documents`)
        .set(auth(medica))
        .send({ kind: 'LAUDO', mimeType: 'application/pdf', fileBase64: Buffer.from('%PDF-1.4 ecg de teste').toString('base64') })
        .expect(201)
    ).body;
    const complementada = (
      await t
        .http()
        .post(`/api/regulacao/solicitacoes/${solicitacaoId}/complementar`)
        .set(auth(medica))
        .send({ notes: 'Losartana 100 mg, anlodipino 10 mg, hidroclorotiazida 25 mg. ECG anexado.', attachmentIds: [doc.id] })
        .expect(200)
    ).body;
    expect(complementada).toMatchObject({ status: 'PENDENTE', returnedCount: 1 });
    expect(complementada.anexos).toHaveLength(1);
    expect(complementada.anexos[0]).toMatchObject({ documentId: doc.id, kind: 'LAUDO' });
    expect(complementada.eventos.map((e: { kind: string }) => e.kind)).toEqual(['CRIADA', 'EM_ANALISE', 'DEVOLVIDA', 'COMPLEMENTADA']);
    // Mantém a posição original na fila (data de criação).
    const fila = (await t.http().get('/api/regulacao/fila?specialty=CARDIOLOGIA').set(auth(nir)).expect(200)).body;
    expect(fila.itens[0].id).toBe(solicitacaoId);

    await fetch(`${mocks.url}/whatsapp/_sent`, { method: 'DELETE' });
    const autorizada = (await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoId}/autorizar`).set(auth(nir)).send({ providerUnitId: poliId, priority: 'VERDE', notes: 'Agendar na policlínica.' }).expect(200))
      .body;
    expect(autorizada).toMatchObject({ status: 'AUTORIZADA', priority: 'VERDE', requestedPriority: 'AMARELA', providerUnit: { name: 'Policlínica Municipal' }, regulator: { name: 'Fábio Teixeira NIR' } });
    expect(autorizada.eventos.at(-1).notes).toContain('reclassificada de urgência para prioridade');
    // Devolutiva ao cidadão por WhatsApp (modelo regulacao_atualizacao), enviada pelo disparo dos jobs.
    const disparo = (await t.http().post('/api/integrations/dispatch').set(auth(gestora)).expect(200)).body;
    expect(disparo.whatsapp.sent + disparo.whatsapp.postponed).toBeGreaterThanOrEqual(1);
    if (disparo.whatsapp.sent >= 1) {
      const enviadas = (await (await fetch(`${mocks.url}/whatsapp/_sent`)).json()) as { to: string; payload: { template?: { name: string } } }[];
      const msg = enviadas.find((m) => m.payload.template?.name === 'regulacao_atualizacao');
      expect(msg).toBeDefined();
      expect(msg!.to.endsWith('999990201')).toBe(true);
    }
    const detalhe = (await t.http().get(`/api/regulacao/solicitacoes/${solicitacaoId}`).set(auth(recepcao)).expect(200)).body;
    expect(detalhe.status).toBe('AUTORIZADA');
    // Autorizada não volta para a fila nem é autorizada de novo.
    await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoId}/autorizar`).set(auth(nir)).send({}).expect(422);
    // A linha do tempo do paciente mostra a solicitação.
    const timeline = (await t.http().get(`/api/patients/${pacienteId}/timeline`).set(auth(medica)).expect(200)).body;
    expect(timeline.events.some((e: { type: string; title: string }) => e.type === 'REGULACAO' && e.title.includes('Autorizada'))).toBe(true);
  });

  it('nega, cancela e mostra o painel; mensagens ficam no histórico', async () => {
    const r = (
      await t
        .http()
        .post('/api/regulacao/solicitacoes')
        .set(auth(medica))
        .send({ patientId: pacienteId, kind: 'CONSULTA', specialty: 'DERMATOLOGIA', priority: 'AZUL', clinicalSummary: 'Acne leve em uso de tratamento tópico há 2 semanas.', criteria: [] })
        .expect(201)
    ).body;
    expect(r.protocolIssues).toEqual(['Nenhum critério do protocolo de encaminhamento foi marcado']);
    await t.http().post(`/api/regulacao/solicitacoes/${r.id}/mensagem`).set(auth(nir)).send({ notes: 'Acne leve é manejo da atenção básica; confira o protocolo.' }).expect(200);
    const negada = (await t.http().post(`/api/regulacao/solicitacoes/${r.id}/negar`).set(auth(nir)).send({ reason: 'Fora do protocolo: acne leve é manejo da atenção básica.' }).expect(200)).body;
    expect(negada).toMatchObject({ status: 'NEGADA' });
    expect(negada.closedAt).not.toBeNull();
    expect(negada.eventos.map((e: { kind: string }) => e.kind)).toEqual(['CRIADA', 'MENSAGEM', 'NEGADA']);
    await t.http().post(`/api/regulacao/solicitacoes/${r.id}/cancelar`).set(auth(medica)).send({ reason: 'já negada' }).expect(422);

    const c = (
      await t
        .http()
        .post('/api/regulacao/solicitacoes')
        .set(auth(medica))
        .send({ patientId: pacienteId, kind: 'EXAME', specialty: 'USG_ABDOME', priority: 'VERDE', clinicalSummary: 'Dor abdominal crônica em hipocôndrio direito com dispepsia.', criteria: ['DOR_ABDOMINAL_CRONICA'] })
        .expect(201)
    ).body;
    await t.http().post(`/api/regulacao/solicitacoes/${c.id}/cancelar`).set(auth(recepcao)).send({ reason: 'teste' }).expect(403);
    const cancelada = (await t.http().post(`/api/regulacao/solicitacoes/${c.id}/cancelar`).set(auth(medica)).send({ reason: 'Paciente realizou o exame na rede particular.' }).expect(200)).body;
    expect(cancelada.status).toBe('CANCELADA');

    const painel = (await t.http().get('/api/regulacao/painel').set(auth(recepcao)).expect(200)).body;
    expect(painel.unidade.unitId).toBe(ubsId);
    expect(painel.unidade.porStatus.AUTORIZADA).toBeGreaterThanOrEqual(1);
    expect(painel.unidade.porStatus.NEGADA).toBeGreaterThanOrEqual(1);
    expect(painel.central).toBeNull();
    const central = (await t.http().get('/api/regulacao/painel').set(auth(nir)).expect(200)).body;
    expect(central.central.naFila).toBeGreaterThanOrEqual(1);
    const todas = (await t.http().get('/api/regulacao/solicitacoes?escopo=central&status=PENDENTE').set(auth(nir)).expect(200)).body;
    expect(todas.every((x: { status: string }) => x.status === 'PENDENTE')).toBe(true);
  });
});
