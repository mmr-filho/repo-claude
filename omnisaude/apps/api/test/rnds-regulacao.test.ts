import { cnsFromBase, completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { RndsService } from '../src/modules/integrations/rnds.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();

describe.runIf(enabled)('Regulação na RNDS (Portaria 6.656/2025, RIRA)', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let gestora: string;
  let recepcao: string;
  let medica: string;
  let nir: string;
  let hospId = '';
  let poliId = '';
  let pacienteA = '';
  let pacienteSemDoc = '';
  let solicitacaoId = '';
  let vagaId = '';
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const address = { cep: '77405070', street: 'Rua da RNDS', number: '1', district: 'Centro', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };
  const outbox = async (requestId: string) => {
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    const db = await tenants.client(tenant.id);
    return { tenant, db, msgs: await db.outboxMessage.findMany({ where: { kind: 'RNDS_REGULACAO', aggregateId: requestId }, orderBy: { createdAt: 'asc' } }) };
  };
  const comp = (bundle: { entry: { resource: Record<string, unknown> }[] }) =>
    bundle.entry[0]!.resource as {
      type: { coding: { code: string }[] };
      category: { coding: { code: string }[] }[];
      event: { code: { coding: { code: string }[] }[]; detail: unknown[] }[];
      date: string;
      author: { identifier: { value: string } }[];
    };
  const resource = (bundle: { entry: { resource: Record<string, unknown> }[] }, type: string) => bundle.entry.find((e) => e.resource.resourceType === type)!.resource as Record<string, never>;

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('rndsreg', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws`, RNDS_REQUESTER_CPF: '52998224725', RNDS_REGULATOR_CNES: '9000052' });
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    nir = await t.login('nir', 'Hospital Municipal São Lucas', 'NIR');
    const dir = (await t.http().get('/api/directory').set(auth(gestora)).expect(200)).body;
    hospId = dir.units.find((u: { name: string }) => u.name === 'Hospital Municipal São Lucas').id;
    poliId = dir.units.find((u: { name: string }) => u.name === 'Policlínica Municipal').id;
    const pessoa = async (name: string, extra: Record<string, unknown>) =>
      (
        await t
          .http()
          .post('/api/patients')
          .set(auth(recepcao))
          .send({ name, birthDate: '1970-04-04', sex: 'F', motherName: 'Mae RNDS Teste', phone: '(63) 99999-0601', address, confirmNotDuplicate: true, ...extra })
          .expect(201)
      ).body.id as string;
    pacienteA = await pessoa('Aurora Rnds Teste', { cpf: completeCpf('477000601'), cns: cnsFromBase('27700000601') });
    pacienteSemDoc = await pessoa('Benta Semdoc Teste', {});
  });

  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('cada solicitação ambulatorial e cada mudança de situação geram um documento no outbox', async () => {
    const r = await t
      .http()
      .post('/api/regulacao/solicitacoes')
      .set(auth(medica))
      .send({
        patientId: pacienteA,
        kind: 'CONSULTA',
        specialty: 'CARDIOLOGIA',
        priority: 'VERDE',
        cid: 'I10',
        clinicalSummary: 'Hipertensão resistente a três fármacos em dose otimizada; ECG com sobrecarga de VE.',
        criteria: ['HAS_RESISTENTE'],
      })
      .expect(201);
    solicitacaoId = r.body.id;
    let { msgs } = await outbox(solicitacaoId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.payload).toMatchObject({ fonte: 'AMBULATORIAL', status: 'PENDENTE', evento: 'CRIADA', sequencia: 1 });
    await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoId}/analisar`).set(auth(nir)).expect(200);
    await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoId}/devolver`).set(auth(nir)).send({ reason: 'Anexar o ECG' }).expect(200);
    ({ msgs } = await outbox(solicitacaoId));
    expect(msgs.map((m) => (m.payload as { status: string }).status)).toEqual(['PENDENTE', 'EM_ANALISE', 'DEVOLVIDA']);
    const docs = (await t.http().get(`/api/regulacao/rnds/documentos?requestId=${solicitacaoId}`).set(auth(medica)).expect(200)).body;
    expect(docs.map((d: { statusMira: string }) => d.statusMira)).toEqual(['returned-to-requester', 'pending', 'pending']);
    expect(docs[0].solicitacao).toMatchObject({ paciente: 'Aurora Rnds Teste', identificado: true });
  });

  it('a pré-visualização monta o RIRA válido: Composition RA, evento, Appointment, ServiceRequest e Condition', async () => {
    const { msgs } = await outbox(solicitacaoId);
    const pendente = msgs[0]!;
    const previa = (await t.http().get(`/api/regulacao/rnds/documentos/${pendente.id}/previa`).set(auth(nir)).expect(200)).body;
    expect(previa.ok).toBe(true);
    expect(previa.validacao.valid).toBe(true);
    const c = comp(previa.bundle);
    expect(c.type.coding[0]!.code).toBe('RA');
    expect(c.category[0]!.coding[0]!.code).toBe('09');
    expect(c.event[0]!.code[0]!.coding[0]!.code).toBe('pending');
    expect(c.event[0]!.detail).toHaveLength(2);
    expect(c.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.author[0]!.identifier.value).toBe('9000052');
    const sr = resource(previa.bundle, 'ServiceRequest');
    expect(sr).toMatchObject({ status: 'active', intent: 'proposal', priority: 'routine' });
    expect((sr as { code: { coding: { code: string }[] } }).code.coding[0]!.code).toBe('0301010072');
    expect((sr as { requester: { identifier: { value: string } } }).requester.identifier.value).toBe('9000011');
    expect((sr as { performer?: unknown }).performer).toBeUndefined();
    expect(resource(previa.bundle, 'Appointment')).toMatchObject({ status: 'proposed' });
    expect((resource(previa.bundle, 'Condition') as { code: { coding: { code: string }[] } }).code.coding[0]!.code).toBe('I10');
    const devolvida = (await t.http().get(`/api/regulacao/rnds/documentos/${msgs[2]!.id}/previa`).set(auth(nir)).expect(200)).body;
    expect(comp(devolvida.bundle).event[0]!.code[0]!.coding[0]!.code).toBe('returned-to-requester');
    expect(resource(devolvida.bundle, 'ServiceRequest')).toMatchObject({ status: 'on-hold' });
    await t.http().get(`/api/regulacao/rnds/documentos/${pendente.id}/previa`).set(auth(medica)).expect(403);
  });

  it('o job envia os documentos ao simulador da RNDS, com substituição do anterior; sem CPF/CNS o documento é descartado', async () => {
    const semDoc = (
      await t
        .http()
        .post('/api/regulacao/solicitacoes')
        .set(auth(medica))
        .send({
          patientId: pacienteSemDoc,
          kind: 'CONSULTA',
          specialty: 'CARDIOLOGIA',
          priority: 'VERDE',
          cid: 'I10',
          clinicalSummary: 'Pessoa sem CPF nem CNS no cadastro para testar o descarte do documento.',
          criteria: ['HAS_RESISTENTE'],
        })
        .expect(201)
    ).body;
    const { tenant, db } = await outbox(solicitacaoId);
    mocks.state.bundles.length = 0;
    const result = await t.app.get(RndsService).dispatchDue({ tenant, db });
    expect(result.sent).toBeGreaterThanOrEqual(3);
    expect(result.discarded).toBeGreaterThanOrEqual(1);
    const descartada = await db.outboxMessage.findFirst({ where: { kind: 'RNDS_REGULACAO', aggregateId: semDoc.id } });
    expect(descartada?.status).toBe('DESCARTADO');
    expect(descartada?.lastError).toContain('CPF');
    const enviados = await db.outboxMessage.findMany({ where: { kind: 'RNDS_REGULACAO', aggregateId: solicitacaoId }, orderBy: { createdAt: 'asc' } });
    expect(enviados.every((m) => m.status === 'ENVIADO' && m.externalId)).toBe(true);
    const recebidos = mocks.state.bundles.map((b) => b.bundle as { identifier: { value: string }; entry: { resource: Record<string, unknown> }[] });
    const meus = recebidos.filter((b) => b.identifier.value && enviados.some((m) => m.id === b.identifier.value));
    expect(meus).toHaveLength(3);
    const ultimo = comp(meus[2]!);
    expect((ultimo as unknown as { relatesTo: { code: string; targetReference: { reference: string } }[] }).relatesTo[0]).toEqual({
      code: 'replaces',
      targetReference: { reference: `Composition/${enviados[1]!.externalId}` },
    });
    const painel = (await t.http().get('/api/regulacao/rnds/painel').set(auth(medica)).expect(200)).body;
    expect(painel.porStatus.ENVIADO).toBeGreaterThanOrEqual(3);
    expect(painel.regulatorCnes).toBe('9000052');
    expect(painel.ultimoEnvio).toBeTruthy();
    await t.http().post(`/api/regulacao/rnds/documentos/${enviados[0]!.id}/reenviar`).set(auth(nir)).expect(422);
    await t.http().post(`/api/regulacao/rnds/documentos/${descartada!.id}/reenviar`).set(auth(nir)).expect(200);
    expect((await db.outboxMessage.findUniqueOrThrow({ where: { id: descartada!.id } })).status).toBe('PENDENTE');
  });

  it('agendamento e conclusão viram "booked" e "attended" com executante, datas e execução', async () => {
    await t
      .http()
      .post(`/api/regulacao/solicitacoes/${solicitacaoId}/complementar`)
      .set(auth(medica))
      .send({ notes: 'ECG anexado', clinicalSummary: 'Hipertensão resistente; ECG anexado com sobrecarga de VE e alterações de repolarização.' })
      .expect(200);
    await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoId}/autorizar`).set(auth(nir)).send({ providerUnitId: poliId, notes: 'Cardiologia na policlínica' }).expect(200);
    const prestadores = (await t.http().get('/api/regulacao/prestadores').set(auth(nir)).expect(200)).body as { id: string; unit: { id: string } | null }[];
    const poli = prestadores.find((p) => p.unit?.id === poliId)!;
    const agendas = (await t.http().get(`/api/regulacao/prestadores/${poli.id}/agendas`).set(auth(nir)).expect(200)).body;
    const cardio = (agendas.agendas as { id: string; name: string; proximos: { startsAt: string }[] }[]).find((a) => /cardio/i.test(a.name) && a.proximos.length > 0)!;
    await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoId}/agendar`).set(auth(nir)).send({ scheduleId: cardio.id, startsAt: cardio.proximos[0]!.startsAt }).expect(200);
    let { msgs } = await outbox(solicitacaoId);
    expect((msgs.at(-1)!.payload as { status: string }).status).toBe('AGENDADA');
    const agendada = (
      await t
        .http()
        .get(`/api/regulacao/rnds/documentos/${msgs.at(-1)!.id}/previa`)
        .set(auth(nir))
        .expect(200)
    ).body;
    expect(agendada.validacao.valid).toBe(true);
    expect(comp(agendada.bundle).event[0]!.code[0]!.coding[0]!.code).toBe('booked');
    const appt = resource(agendada.bundle, 'Appointment') as { status: string; start?: string; end?: string; created?: string };
    expect(appt.status).toBe('booked');
    expect(appt.start).toBeTruthy();
    expect(appt.end).toBeTruthy();
    expect(appt.created).toBeTruthy();
    const sr = resource(agendada.bundle, 'ServiceRequest') as { status: string; performer: { identifier: { value: string } }[] };
    expect(sr.status).toBe('active');
    expect(sr.performer[0]!.identifier.value).toBe('9000052');
    await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoId}/realizar`).set(auth(nir)).send({ notes: 'Consulta realizada' }).expect(200);
    ({ msgs } = await outbox(solicitacaoId));
    const realizada = (
      await t
        .http()
        .get(`/api/regulacao/rnds/documentos/${msgs.at(-1)!.id}/previa`)
        .set(auth(nir))
        .expect(200)
    ).body;
    expect(realizada.validacao.valid).toBe(true);
    expect(comp(realizada.bundle).event[0]!.code[0]!.coding[0]!.code).toBe('attended');
    expect(resource(realizada.bundle, 'Appointment')).toMatchObject({ status: 'fulfilled' });
    expect(resource(realizada.bundle, 'ServiceRequest')).toMatchObject({ status: 'completed' });
    expect((resource(realizada.bundle, 'ServiceRequest') as { occurrenceDateTime?: string }).occurrenceDateTime).toBeTruthy();
  });

  it('vaga de leito: pendente sem SIGTAP fica descartada; com o procedimento vai para a RNDS como atenção hospitalar', async () => {
    const vaga = (
      await t
        .http()
        .post('/api/regulacao-leitos/solicitacoes')
        .set(auth(medica))
        .send({
          patientId: pacienteA,
          bedKind: 'CLINICA_MEDICA',
          specialty: 'Clínica médica',
          cid: 'J18',
          clinicalSummary: 'Pneumonia comunitária com necessidade de antibiótico venoso e oxigênio suplementar.',
          vitals: { fr: 24, sato2: 92, pas: 110, fc: 100, temp: 38.2, consciencia: 'ALERTA', oxigenio: true },
        })
        .expect(201)
    ).body;
    vagaId = vaga.id;
    const { tenant, db } = await outbox(vagaId);
    await t.app.get(RndsService).dispatchDue({ tenant, db });
    const primeiro = await db.outboxMessage.findFirst({ where: { kind: 'RNDS_REGULACAO', aggregateId: vagaId } });
    expect(primeiro?.status).toBe('DESCARTADO');
    expect(primeiro?.lastError).toContain('SIGTAP');
    await t.http().put(`/api/regulacao-leitos/solicitacoes/${vagaId}`).set(auth(medica)).send({ procedureCode: '0303140151', externalCode: 'SISREG-123' }).expect(200);
    await t
      .http()
      .post(`/api/regulacao-leitos/solicitacoes/${vagaId}/autorizar`)
      .set(auth(nir))
      .send({ destinationUnitId: hospId, destinationKind: 'CLINICA_MEDICA', transport: 'AMBULANCIA_BASICA', notes: 'Vaga na clínica médica' })
      .expect(200);
    mocks.state.bundles.length = 0;
    const result = await t.app.get(RndsService).dispatchDue({ tenant, db });
    expect(result.sent).toBeGreaterThanOrEqual(2);
    const docs = (await t.http().get(`/api/regulacao/rnds/documentos?requestId=${vagaId}&fonte=LEITO`).set(auth(nir)).expect(200)).body;
    const autorizada = docs.find((d: { statusLocal: string }) => d.statusLocal === 'AUTORIZADA');
    expect(autorizada).toMatchObject({ statusMira: 'booked', envio: { status: 'ENVIADO' } });
    const previa = (await t.http().get(`/api/regulacao/rnds/documentos/${autorizada.id}/previa`).set(auth(nir)).expect(200)).body;
    const c = comp(previa.bundle);
    expect(c.category[0]!.coding[0]!.code).toBe('04');
    expect(c.event[0]!.code[0]!.coding[0]!.code).toBe('booked');
    const sr = resource(previa.bundle, 'ServiceRequest') as { priority: string; performer: { identifier: { value: string } }[]; code: { coding: { code: string }[] } };
    expect(sr.priority).toBe('urgent');
    expect(sr.code.coding[0]!.code).toBe('0303140151');
    expect(sr.performer[0]!.identifier.value).toBe('9000044');
    const det = (await t.http().get(`/api/regulacao-leitos/solicitacoes/${vagaId}`).set(auth(nir)).expect(200)).body;
    expect(det).toMatchObject({ procedureCode: '0303140151', externalCode: 'SISREG-123' });
    await t.http().post(`/api/regulacao-leitos/solicitacoes/${vagaId}/codigo-externo`).set(auth(nir)).send({ externalCode: 'ESUSREG-77' }).expect(200);
    await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoId}/codigo-externo`).set(auth(nir)).send({ externalCode: 'SISREG-2026-9' }).expect(200);
    await t.http().post(`/api/regulacao/solicitacoes/${solicitacaoId}/codigo-externo`).set(auth(medica)).send({ externalCode: 'x' }).expect(403);
  });

  it('carga inicial enfileira as solicitações sem documento e o enfileiramento manual gera a situação atual', async () => {
    const { db } = await outbox(solicitacaoId);
    const semDocumento = await db.regulationRequest.findFirst({
      where: { NOT: { id: { in: (await db.outboxMessage.findMany({ where: { kind: 'RNDS_REGULACAO' }, select: { aggregateId: true } })).map((m) => m.aggregateId) } } },
      select: { id: true },
    });
    const carga = (await t.http().post('/api/regulacao/rnds/carga-inicial').set(auth(gestora)).expect(200)).body;
    expect(carga.enfileirados).toBeGreaterThanOrEqual(semDocumento ? 1 : 0);
    const manual = (await t.http().post('/api/regulacao/rnds/enfileirar').set(auth(nir)).send({ fonte: 'LEITO', requestId: vagaId }).expect(200)).body;
    expect(manual.status).toBe('PENDENTE');
    const docs = (await t.http().get(`/api/regulacao/rnds/documentos?requestId=${vagaId}`).set(auth(nir)).expect(200)).body;
    expect(docs[0]).toMatchObject({ evento: 'REENVIO', statusMira: 'booked' });
    await t.http().post('/api/regulacao/rnds/carga-inicial').set(auth(medica)).expect(403);
  });
});
