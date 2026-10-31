import { demoFixtures } from '@omnisaude/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPdfSignatures } from '../src/modules/signatures/cms';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { makeTestPfx } from './test-certificate';

const enabled = await pgAvailable();
const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe.runIf(enabled)('assinatura digital ICP-Brasil (certificado A1 no servidor)', () => {
  let t: TestApp;
  let medica: string;
  let enfermeira: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const medicaCpf = demoFixtures.STAFF.find((s) => s.key === 'medica')!.cpf;
  const enfermeiraCpf = demoFixtures.STAFF.find((s) => s.key === 'enfermeiro')!.cpf;
  const mine = makeTestPfx({
    cpf: medicaCpf,
    name: 'CARLA MENEZES MEDICA',
    password: 'minha-senha',
  });
  let noteId = '';
  let docId = '';

  beforeAll(async () => {
    t = await startTestApp('signatures');
    medica = await t.login('medica', 'UPA 24h Norte', 'MEDICO');
    enfermeira = await t.login('enfermeiro', 'UBS Centro', 'ENFERMAGEM');
  });
  afterAll(async () => {
    await t?.close();
  });

  const queueEncounter = async (name: string) => {
    const queue = (await t.http().get('/api/triage/queue').set(auth(medica)).expect(200)).body;
    const row = [...queue.awaitingDoctor, ...queue.inProgress].find((r: { patient: { name: string } }) => r.patient.name.startsWith(name));
    return row.encounterId as string;
  };

  it('recusa certificado de outro CPF, senha errada, arquivo inválido e certificado vencido', async () => {
    expect((await t.http().get('/api/signatures/certificates/me').set(auth(medica)).expect(200)).body.certificate).toBeNull();
    const outra = makeTestPfx({ cpf: '12345678909', name: 'OUTRA PESSOA' });
    const divergente = await t.http().post('/api/signatures/certificates').set(auth(medica)).send({ pfxBase64: outra.pfxBase64, password: outra.password }).expect(422);
    expect(divergente.body.code).toBe('CERTIFICADO_CPF_DIVERGENTE');
    expect((await t.http().post('/api/signatures/certificates').set(auth(medica)).send({ pfxBase64: mine.pfxBase64, password: 'errada' }).expect(422)).body.code).toBe('SENHA_CERTIFICADO');
    expect(
      (
        await t
          .http()
          .post('/api/signatures/certificates')
          .set(auth(medica))
          .send({
            pfxBase64: Buffer.from('nada a ver com pfx').toString('base64'),
            password: 'x',
          })
          .expect(422)
      ).body.code,
    ).toBe('ARQUIVO_INVALIDO');
    const vencido = makeTestPfx({
      cpf: medicaCpf,
      name: 'CARLA',
      notAfter: new Date(Date.now() - 3600_000),
    });
    expect((await t.http().post('/api/signatures/certificates').set(auth(medica)).send({ pfxBase64: vencido.pfxBase64, password: vencido.password }).expect(422)).body.code).toBe('CERTIFICADO_VENCIDO');
    const semCpf = makeTestPfx({
      cpf: medicaCpf,
      name: 'CARLA',
      withCpf: false,
    });
    expect((await t.http().post('/api/signatures/certificates').set(auth(medica)).send({ pfxBase64: semCpf.pfxBase64, password: semCpf.password }).expect(422)).body.code).toBe('CERTIFICADO_SEM_CPF');
  });

  it('cadastra o certificado do próprio CPF e mostra em Minha conta', async () => {
    const res = await t.http().post('/api/signatures/certificates').set(auth(medica)).send({ pfxBase64: mine.pfxBase64, password: mine.password }).expect(201);
    expect(res.body.certificate).toMatchObject({
      cpf: medicaCpf,
      icpBrasil: false,
      active: true,
      expired: false,
    });
    expect(res.body.certificate.subject).toContain('CARLA MENEZES MEDICA');
    expect(res.body.certificate.chainError).toMatch(/ICP-Brasil/);
    expect(res.body.certificate.pfxEncrypted).toBeUndefined();
    const me = await t.http().get('/api/signatures/certificates/me').set(auth(medica)).expect(200);
    expect(me.body.certificate.id).toBe(res.body.certificate.id);
    expect(me.body.certificate.daysLeft).toBeGreaterThan(700);
  });

  it('assina o registro do prontuário em PAdES, entrega o PDF e valida (inclusive adulteração)', async () => {
    const encId = await queueEncounter('Carlos');
    await t.http().post(`/api/clinical/encounters/${encId}/start`).set(auth(medica)).expect(200);
    const draft = (
      await t
        .http()
        .post(`/api/clinical/encounters/${encId}/notes`)
        .set(auth(medica))
        .send({
          kind: 'SOAP',
          subjective: 'Dor torácica',
          objective: 'PA 150x90',
          assessment: 'Angina estável',
          plan: 'AAS, retorno em 7 dias',
          codes: [{ system: 'CID10', code: 'I20' }],
        })
        .expect(201)
    ).body;
    noteId = draft.id;
    expect(
      (
        await t
          .http()
          .post('/api/signatures/sign')
          .set(auth(medica))
          .send({
            entityType: 'ClinicalNote',
            entityId: noteId,
            password: mine.password,
          })
          .expect(422)
      ).body.code,
    ).toBe('REGISTRO_EM_RASCUNHO');
    await t.http().post(`/api/clinical/notes/${noteId}/sign`).set(auth(medica)).expect(200);
    expect(
      (
        await t
          .http()
          .post('/api/signatures/sign')
          .set(auth(medica))
          .send({
            entityType: 'ClinicalNote',
            entityId: noteId,
            password: 'errada',
          })
          .expect(422)
      ).body.code,
    ).toBe('SENHA_CERTIFICADO');

    const signed = await t
      .http()
      .post('/api/signatures/sign')
      .set(auth(medica))
      .send({
        entityType: 'ClinicalNote',
        entityId: noteId,
        password: mine.password,
      })
      .expect(201);
    expect(signed.body).toMatchObject({
      kind: 'PRONTUARIO',
      entityType: 'ClinicalNote',
      entityId: noteId,
      cpf: medicaCpf,
      source: 'A1_SERVIDOR',
      alreadySigned: false,
    });
    expect(signed.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    docId = signed.body.id;
    const again = await t
      .http()
      .post('/api/signatures/sign')
      .set(auth(medica))
      .send({
        entityType: 'ClinicalNote',
        entityId: noteId,
        password: mine.password,
      })
      .expect(201);
    expect(again.body).toMatchObject({ id: docId, alreadySigned: true });

    const pdfRes = await t.http().get(`/api/signatures/${docId}/pdf`).set(auth(medica)).buffer(true).parse(binary).expect(200);
    expect(pdfRes.headers['content-type']).toContain('application/pdf');
    expect(pdfRes.headers['content-disposition']).toMatch(/prontuario-\d{8}-/);
    const pdf = pdfRes.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const [check] = verifyPdfSignatures(pdf);
    expect(check).toMatchObject({
      valid: true,
      cpf: medicaCpf,
      coversWholeDocument: true,
      certificateHashOk: true,
    });
    const text = pdf.toString('latin1');
    expect(text).toContain('/SubFilter /ETSI.CAdES.detached');

    const valid = await t
      .http()
      .post('/api/signatures/validate')
      .set(auth(enfermeira))
      .send({ pdfBase64: pdf.toString('base64') })
      .expect(200);
    expect(valid.body.valid).toBe(true);
    expect(valid.body.signatures).toHaveLength(1);
    expect(valid.body.signatures[0]).toMatchObject({
      valid: true,
      cpf: medicaCpf,
      icpBrasil: false,
    });
    expect(valid.body.issuedHere).toMatchObject({
      id: docId,
      kind: 'PRONTUARIO',
      signerName: 'Carla Menezes Médica',
    });

    const tampered = Buffer.from(pdf);
    tampered[300] ^= 0x01;
    const invalid = await t
      .http()
      .post('/api/signatures/validate')
      .set(auth(enfermeira))
      .send({ pdfBase64: tampered.toString('base64') })
      .expect(200);
    expect(invalid.body.valid).toBe(false);
    expect(invalid.body.signatures[0]).toMatchObject({
      valid: false,
      digestOk: false,
    });
    expect(invalid.body.issuedHere).toBeNull();
    expect(
      (
        await t
          .http()
          .post('/api/signatures/validate')
          .set(auth(enfermeira))
          .send({ pdfBase64: Buffer.from('não é pdf').toString('base64') })
          .expect(422)
      ).body.code,
    ).toBe('ARQUIVO_INVALIDO');

    const note = (await t.http().get(`/api/clinical/encounters/${encId}`).set(auth(medica)).expect(200)).body.notes.find((n: { id: string }) => n.id === noteId);
    expect(note.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('assina receita e atestado e lista os documentos por registro', async () => {
    const encId = await queueEncounter('Carlos');
    const rx = (
      await t
        .http()
        .post(`/api/clinical/encounters/${encId}/prescriptions`)
        .set(auth(medica))
        .send({
          items: [
            {
              description: 'Ácido acetilsalicílico 100 mg',
              activeIngredient: 'acido acetilsalicilico',
              dose: 100,
              doseUnit: 'mg',
              route: 'ORAL',
              frequencyHours: 24,
              durationDays: 30,
            },
          ],
          justification: 'Síndrome coronariana em investigação; benefício supera o risco.',
        })
        .expect(201)
    ).body.prescription;
    const receita = await t
      .http()
      .post('/api/signatures/sign')
      .set(auth(medica))
      .send({
        entityType: 'Prescription',
        entityId: rx.id,
        password: mine.password,
      })
      .expect(201);
    expect(receita.body.kind).toBe('RECEITA');
    const cert = (await t.http().post(`/api/clinical/encounters/${encId}/certificate`).set(auth(medica)).send({ days: 3, cid: 'I20', includeCid: true }).expect(201)).body;
    const atestado = await t
      .http()
      .post('/api/signatures/sign')
      .set(auth(medica))
      .send({
        entityType: 'ClinicalNote',
        entityId: cert.noteId,
        password: mine.password,
      })
      .expect(201);
    expect(atestado.body.kind).toBe('ATESTADO');
    for (const id of [receita.body.id, atestado.body.id]) {
      const pdf = (await t.http().get(`/api/signatures/${id}/pdf`).set(auth(medica)).buffer(true).parse(binary).expect(200)).body as Buffer;
      expect(verifyPdfSignatures(pdf)[0]).toMatchObject({
        valid: true,
        cpf: medicaCpf,
      });
    }
    const list = await t.http().get(`/api/signatures?entityType=ClinicalNote&entityIds=${noteId},${cert.noteId}`).set(auth(medica)).expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.map((d: { kind: string }) => d.kind).sort()).toEqual(['ATESTADO', 'PRONTUARIO']);
    expect(list.body[0].signerName).toBe('Carla Menezes Médica');
    expect((await t.http().get(`/api/signatures?entityType=Prescription&entityIds=${rx.id}`).set(auth(medica)).expect(200)).body).toHaveLength(1);
    await t.http().get('/api/signatures?entityType=Outra&entityIds=x').set(auth(medica)).expect(400);
  });

  it('só o autor assina; sem certificado não assina; remover o certificado encerra o uso', async () => {
    expect(
      (
        await t
          .http()
          .post('/api/signatures/sign')
          .set(auth(enfermeira))
          .send({
            entityType: 'ClinicalNote',
            entityId: noteId,
            password: 'x',
          })
          .expect(422)
      ).body.code,
    ).toBe('SEM_CERTIFICADO');
    const dela = makeTestPfx({ cpf: enfermeiraCpf, name: 'ENFERMEIRA' });
    await t.http().post('/api/signatures/certificates').set(auth(enfermeira)).send({ pfxBase64: dela.pfxBase64, password: dela.password }).expect(201);
    await t
      .http()
      .post('/api/signatures/sign')
      .set(auth(enfermeira))
      .send({
        entityType: 'ClinicalNote',
        entityId: noteId,
        password: dela.password,
      })
      .expect(403);
    await t.http().delete('/api/signatures/certificates/me').set(auth(enfermeira)).expect(200);
    expect((await t.http().get('/api/signatures/certificates/me').set(auth(enfermeira)).expect(200)).body.certificate).toBeNull();
    await t.http().delete('/api/signatures/certificates/me').set(auth(enfermeira)).expect(404);
    expect(
      (
        await t
          .http()
          .post('/api/signatures/sign')
          .set(auth(enfermeira))
          .send({
            entityType: 'ClinicalNote',
            entityId: noteId,
            password: dela.password,
          })
          .expect(422)
      ).body.code,
    ).toBe('SEM_CERTIFICADO');
  });
});
