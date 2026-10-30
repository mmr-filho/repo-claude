import { FakeLlmClient } from '@omnisaude/ai-engine';
import { MOCK_CITIZENS } from '@omnisaude/mocks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { RndsService } from '../src/modules/integrations/rnds.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();
const JOBS_SECRET = 'segredo-dos-jobs-com-32-caracteres';

describe.runIf(enabled)('integrações: CADSUS, OCR e RNDS', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let recepcao: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('integrations', { MOCKS_URL: mocks.url, RNDS_REQUESTER_CPF: '52998224725', JOBS_SECRET });
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
  });
  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('consulta o CADSUS pela RNDS', async () => {
    const citizen = MOCK_CITIZENS[0]!;
    const res = await t.http().get(`/api/integrations/cadsus?cpf=${citizen.cpf}`).set(auth(recepcao)).expect(200);
    expect(res.body.found).toBe(true);
    expect(res.body.citizen.name).toBe(citizen.name);
    expect(res.body.localMatches).toEqual([]);
  });

  it('lê documento a partir do texto do OCR e valida os dígitos', async () => {
    const citizen = MOCK_CITIZENS[0]!;
    const text = [
      'REPÚBLICA FEDERATIVA DO BRASIL',
      'CARTEIRA DE IDENTIDADE',
      `NOME ${citizen.name.toUpperCase()}`,
      `FILIAÇÃO ${citizen.motherName!.toUpperCase()}`,
      'DATA DE NASCIMENTO 17/05/1980',
      'CPF 529.982.247-25',
    ].join('\n');
    const res = await t.http().post('/api/integrations/ocr').set(auth(recepcao)).send({ text }).expect(200);
    expect(res.body.source).toBe('TEXTO');
    expect(res.body.extracted.cpf).toBe('52998224725');
    expect(res.body.extracted.birthDate).toBe('1980-05-17');
    expect(res.body.cadsus.found).toBe(true);
  });

  it('usa o modelo multimodal para imagens só quando há provedor configurado', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const off = await t.http().post('/api/integrations/ocr').set(auth(recepcao)).send({ image: png, mediaType: 'image/png' }).expect(503);
    expect(off.body.code).toBe('IA_INDISPONIVEL');
    t.app.get(AiService).client = new FakeLlmClient([
      { docType: 'CNH', fullName: 'MARIA DA SILVA SOUZA', motherName: 'JOANA DA SILVA', fatherName: null, birthDate: '1980-05-17', cpf: '529.982.247-25', cns: null, rg: '1234567', sex: 'F', confidence: 0.93 },
    ]);
    const res = await t.http().post('/api/integrations/ocr').set(auth(recepcao)).send({ image: png, mediaType: 'image/png' }).expect(200);
    expect(res.body.source).toBe('IA');
    expect(res.body.extracted.fullName).toBe('Maria da Silva Souza');
    t.app.get(AiService).client = null;
  });

  it('envia o registro clínico assinado para a RNDS pelo outbox', async () => {
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    const db = await tenants.client(tenant.id);
    const note = await db.clinicalNote.findFirstOrThrow({ where: { status: 'ASSINADO' }, orderBy: { signedAt: 'asc' } });
    const msg = await db.outboxMessage.create({ data: { kind: 'RNDS_RAC', aggregateId: note.id, payload: {} } });
    const result = await t.app.get(RndsService).dispatchDue({ tenant, db });
    expect(result.sent).toBe(1);
    const sent = await db.outboxMessage.findUniqueOrThrow({ where: { id: msg.id } });
    expect(sent.status).toBe('ENVIADO');
    expect(sent.externalId).toBeTruthy();
    expect(mocks.state.bundles.length).toBe(1);
  });

  it('dispara os jobs pelo endpoint externo só com o segredo (Cron Triggers da Cloudflare)', async () => {
    await t.http().post('/api/jobs/tick').expect(401);
    await t.http().post('/api/jobs/tick').set('x-omni-jobs', 'errado').expect(401);
    // Mesmo número de caracteres, mas não ASCII: bytes diferentes, recusa sem erro interno.
    await t.http().post('/api/jobs/tick').set('x-omni-jobs', 'é'.repeat(JOBS_SECRET.length)).expect(401);
    const res = await t.http().post('/api/jobs/tick?tasks=whatsapp,rnds,desconhecido').set('x-omni-jobs', JOBS_SECRET).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['rnds', 'whatsapp']);
    expect(res.body.rnds[t.slug]).toMatchObject({ failed: 0 });
  });
});
