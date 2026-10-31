import { decodeLedi, readZipEntries, TIPO_DADO, type LediObject } from '@omnisaude/esus';
import { cnsFromBase, completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();
const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe.runIf(enabled)('e-SUS APS: fichas LEDI, lote, zip e envio ao PEC', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let gestora: string;
  let recepcao: string;
  let enfermeira: string;
  let medica: string;
  let ubsId = '';
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const address = { cep: '77405070', street: 'Rua de 14 Novembro', number: '50', district: 'Setor Central', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('esus', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws` });
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    enfermeira = await t.login('enfermeiro', 'UBS Centro', 'ENFERMAGEM');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    ubsId = (await t.http().get('/api/auth/me').set(auth(gestora)).expect(200)).body.context.unitId;
  });
  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  async function atendimentoCompleto(patientId: string) {
    const enc = (await t.http().post('/api/reception/check-in').set(auth(recepcao)).send({ patientId, kind: 'AMBULATORIAL' }).expect(201)).body;
    await t
      .http()
      .post(`/api/triage/encounters/${enc.id}`)
      .set(auth(enfermeira))
      .send({ complaint: 'Dor de cabeça há 2 dias', systolic: 130, diastolic: 85, heartRate: 80, temperature: 36.5, weightKg: 70, heightCm: 165 })
      .expect(201);
    await t.http().post(`/api/clinical/encounters/${enc.id}/start`).set(auth(medica)).expect(200);
    const note = (
      await t
        .http()
        .post(`/api/clinical/encounters/${enc.id}/notes`)
        .set(auth(medica))
        .send({
          kind: 'SOAP',
          subjective: 'Cefaleia',
          assessment: 'Hipertensão arterial',
          plan: 'Ajuste da medicação',
          codes: [
            { system: 'CIAP2', code: 'K86' },
            { system: 'CID10', code: 'I10' },
          ],
        })
        .expect(201)
    ).body;
    await t.http().post(`/api/clinical/notes/${note.id}/sign`).set(auth(medica)).expect(200);
    await t.http().post(`/api/clinical/encounters/${enc.id}/close`).set(auth(medica)).send({ outcome: 'ALTA', mainCid: 'I10' }).expect(200);
    return enc.id as string;
  }

  it('gera o lote com cadastro individual, domiciliar, atendimento individual e procedimentos a partir dos registros', async () => {
    const helena = (
      await t
        .http()
        .post('/api/patients')
        .set(auth(recepcao))
        .send({
          name: 'Helena Esus Teste',
          birthDate: '1985-05-05',
          sex: 'F',
          cpf: completeCpf('477000002'),
          cns: cnsFromBase('27700000001'),
          motherName: 'Maria Esus Teste',
          education: '10',
          workSituation: '02',
          phone: '(63) 99999-1111',
          address,
        })
        .expect(201)
    ).body;
    const household = (
      await t
        .http()
        .post('/api/households')
        .set(auth(recepcao))
        .send({ ...address, dwellingType: '01', tenure: '01', waterSupply: '01', sewage: '01', garbage: '01', electricity: true, rooms: 4, family: { responsibleId: helena.id, incomeBracket: '03' } })
        .expect(201)
    ).body;
    expect(household.id).toBeDefined();
    await atendimentoCompleto(helena.id);

    await t
      .http()
      .post('/api/esus/batches')
      .set(auth(medica))
      .send({ unitId: ubsId, from: day(-1), to: day(0) })
      .expect(403);
    const batch = (
      await t
        .http()
        .post('/api/esus/batches')
        .set(auth(gestora))
        .send({ unitId: ubsId, from: day(-1), to: day(0) })
        .expect(201)
    ).body;
    expect(batch.number).toBe(1);
    expect(batch.status).toBe('GERADO');
    const kinds = batch.byKind.map((k: { kind: number }) => k.kind);
    expect(kinds).toEqual(expect.arrayContaining([TIPO_DADO.CADASTRO_INDIVIDUAL, TIPO_DADO.CADASTRO_DOMICILIAR, TIPO_DADO.ATENDIMENTO_INDIVIDUAL, TIPO_DADO.PROCEDIMENTOS]));
    const mine = batch.records.filter((r: { summary: { cidadao?: string; domicilio?: string; registros?: string[] } }) => r.summary.cidadao === 'Helena Esus Teste' || r.summary.domicilio?.includes('14 Novembro'));
    expect(mine.length).toBeGreaterThanOrEqual(2);
    for (const r of mine) expect(r.status, JSON.stringify(r.issues)).toBe('GERADA');
    const fai = batch.records.find((r: { kind: number }) => r.kind === TIPO_DADO.ATENDIMENTO_INDIVIDUAL);
    expect(fai.status, JSON.stringify(fai.issues)).toBe('GERADA');
    expect(fai.summary.profissional).toBe('Carla Menezes Médica');
    const fp = batch.records.find((r: { kind: number }) => r.kind === TIPO_DADO.PROCEDIMENTOS);
    expect(fp.status, JSON.stringify(fp.issues)).toBe('GERADA');

    const zip = await t.http().get(`/api/esus/batches/${batch.id}/zip`).set(auth(gestora)).buffer(true).parse(binary).expect(200);
    expect(zip.headers['content-type']).toContain('application/zip');
    const entries = readZipEntries(zip.body as Buffer);
    expect(entries.length).toBe(Number(zip.headers['x-fichas']));
    expect(entries.every((e) => /^9000011-[0-9a-f-]{36}\.esus$/.test(e.name))).toBe(true);
    const dado = decodeLedi('DadoTransporteThrift', entries.find((e) => e.name === `${fai.uuid}.esus`)!.data);
    expect(dado).toMatchObject({ tipoDadoSerializado: TIPO_DADO.ATENDIMENTO_INDIVIDUAL, cnesDadoSerializado: '9000011', codIbge: '3550308', numLote: 1, versao: { major: 8, minor: 7, revision: 0 } });
    expect((dado.remetente as LediObject).contraChave).toMatch(/^OmniSaude/);
    const ficha = decodeLedi('FichaAtendimentoIndividualMasterThrift', dado.dadoSerializado as Uint8Array);
    const atend = (ficha.atendimentosIndividuais as LediObject[]).find((a) => a.cpfCidadao === completeCpf('477000002'))!;
    expect(atend).toMatchObject({ cns: cnsFromBase('27700000001'), sexo: 1, tipoAtendimento: 5, localDeAtendimento: 1, condutas: [9], stCidadaoNaoPossuiCpf: false });
    expect(atend.problemasCondicoes).toEqual([
      { ciap: 'K86', isAvaliado: true },
      { cid10: 'I10', isAvaliado: true },
    ]);
    expect(atend.medicoes).toMatchObject({ pressaoArterialSistolica: 130, peso: 70, altura: 165 });
    expect(((ficha.headerTransport as LediObject).lotacaoFormPrincipal as LediObject).cboCodigo_2002).toBe('225125');

    const list = await t.http().get(`/api/esus/batches?unitId=${ubsId}`).set(auth(enfermeira)).expect(200);
    expect(list.body[0]).toMatchObject({ id: batch.id, number: 1 });
    await t.http().get('/api/esus/batches').set(auth(recepcao)).expect(403);
    const status = await t.http().get('/api/esus/status').set(auth(gestora)).expect(200);
    expect(status.body.pec).toMatchObject({ configured: true, simulado: true });
  });

  it('envia ao PEC simulado, guarda a recusa com a mensagem do PEC e reprocessa a ficha', async () => {
    await fetch(`${mocks.url}/pec/_received`, { method: 'DELETE' });
    const rejeitar = (
      await t
        .http()
        .post('/api/patients')
        .set(auth(recepcao))
        .send({ name: 'Rejeitar Esus Teste', birthDate: '1990-01-01', sex: 'M', cpf: completeCpf('477000003'), motherName: 'Mae Esus Teste', address })
        .expect(201)
    ).body;
    await t.http().post('/api/reception/check-in').set(auth(recepcao)).send({ patientId: rejeitar.id, kind: 'AMBULATORIAL' }).expect(201);
    const batch = (
      await t
        .http()
        .post('/api/esus/batches')
        .set(auth(gestora))
        .send({ unitId: ubsId, from: day(-1), to: day(0) })
        .expect(201)
    ).body;
    expect(batch.number).toBe(2);
    const sent = await t.http().post(`/api/esus/batches/${batch.id}/send`).set(auth(gestora)).expect(200);
    expect(sent.body.error).toBeNull();
    expect(sent.body.rejected).toBe(1);
    expect(sent.body.accepted).toBeGreaterThan(0);
    expect(sent.body.status).toBe('PARCIAL');
    const detail = (await t.http().get(`/api/esus/batches/${batch.id}`).set(auth(gestora)).expect(200)).body;
    const rec = detail.records.find((r: { summary: { cidadao?: string } }) => r.summary.cidadao === 'Rejeitar Esus Teste');
    expect(rec).toMatchObject({ status: 'REJEITADA' });
    expect(rec.issues[0]).toMatchObject({ path: 'PEC' });
    expect(rec.issues[0].message).toMatch(/REJEITAR/);
    const received = await fetch(`${mocks.url}/pec/_received`).then((r) => r.json() as Promise<{ uuid: string; tipo: number }[]>);
    expect(received.length).toBe(sent.body.accepted);
    expect(received.some((r) => r.tipo === TIPO_DADO.CADASTRO_INDIVIDUAL)).toBe(true);

    const rep = await t.http().post(`/api/esus/batches/${batch.id}/reprocess`).set(auth(gestora)).expect(200);
    expect(rep.body.regenerated).toBe(1);
    expect(rep.body.batch.status).toBe('GERADO');
    const again = (await t.http().get(`/api/esus/batches/${batch.id}`).set(auth(gestora)).expect(200)).body;
    expect(again.records.find((r: { id: string }) => r.id === rec.id)).toMatchObject({ status: 'GERADA', uuid: rec.uuid });
    await t.http().post(`/api/esus/batches/${batch.id}/send`).set(auth(gestora)).expect(200);
    // Cadastro já aceito antes: a próxima ficha do mesmo cidadão sai como atualização, apontando para a original.
    await t.http().patch(`/api/patients/${rejeitar.id}`).set(auth(recepcao)).send({ name: 'Rejeitar Esus Teste', phone: '63988887777' }).expect(200);
    const helenaId = (await t.http().get('/api/patients?q=Helena Esus Teste').set(auth(recepcao)).expect(200)).body[0].id;
    await t.http().patch(`/api/patients/${helenaId}`).set(auth(recepcao)).send({ phone: '63988886666' }).expect(200);
    const third = (
      await t
        .http()
        .post('/api/esus/batches')
        .set(auth(gestora))
        .send({ unitId: ubsId, from: day(-1), to: day(0) })
        .expect(201)
    ).body;
    const helenaRec = third.records.find((r: { summary: { cidadao?: string } }) => r.summary.cidadao === 'Helena Esus Teste');
    expect(helenaRec.summary.atualizacao).toBe(true);
    const z = await t.http().get(`/api/esus/batches/${third.id}/zip`).set(auth(gestora)).buffer(true).parse(binary).expect(200);
    const entry = readZipEntries(z.body as Buffer).find((e) => e.name === `${helenaRec.uuid}.esus`)!;
    const fci = decodeLedi('CadastroIndividualThrift', decodeLedi('DadoTransporteThrift', entry.data).dadoSerializado as Uint8Array);
    expect(fci.fichaAtualizada).toBe(true);
    expect(fci.uuidFichaOriginadora).not.toBe(helenaRec.uuid);
    expect(fci.uuidFichaOriginadora).toMatch(/^9000011-/);
  });

  it('marca como inválida a ficha que o PEC recusaria (família sem documento do responsável)', async () => {
    const semDoc = (
      await t
        .http()
        .post('/api/patients')
        .set(auth(recepcao))
        .send({ name: 'Sem Documento Esus', birthDate: '2001-03-03', sex: 'F', motherName: 'Mae Esus Teste', address: { ...address, number: '77' } })
        .expect(201)
    ).body;
    await t
      .http()
      .post('/api/households')
      .set(auth(recepcao))
      .send({ ...address, number: '77', tenure: '03', family: { responsibleId: semDoc.id } })
      .expect(201);
    const batch = (
      await t
        .http()
        .post('/api/esus/batches')
        .set(auth(gestora))
        .send({ unitId: ubsId, from: day(-1), to: day(0) })
        .expect(201)
    ).body;
    const fcd = batch.records.find((r: { kind: number; summary: { domicilio?: string } }) => r.kind === TIPO_DADO.CADASTRO_DOMICILIAR && r.summary.domicilio?.includes(', 77'));
    expect(fcd.status).toBe('INVALIDA');
    expect(fcd.issues.map((i: { path: string }) => i.path)).toContain('$.familias[0]');
    await t.http().post(`/api/esus/batches/${batch.id}/send`).set(auth(gestora)).expect(200);
    // A inválida não vai ao PEC nem para o zip; continua listada para correção.
    const after = (await t.http().get(`/api/esus/batches/${batch.id}`).set(auth(gestora)).expect(200)).body;
    expect(after.records.find((r: { id: string }) => r.id === fcd.id).status).toBe('INVALIDA');
    expect(after.counts.ACEITA).toBeGreaterThan(0);
  });
});
