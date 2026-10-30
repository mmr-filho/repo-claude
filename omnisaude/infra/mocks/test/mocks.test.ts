import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRacBundle, RndsCadsusClient, RndsClient } from '@omnisaude/fhir';
import { buildAppointmentConfirmationTemplate, WhatsAppCloudClient } from '@omnisaude/messaging';
import { isValidCns, isValidCpf, isValidGtin } from '@omnisaude/shared';
import { createMockServer, DEMO_DEST_CNPJ, loadNfeFixtures, MOCK_CITIZENS } from '../src';

let server: ReturnType<typeof createMockServer>;
let base: string;

beforeAll(async () => {
  server = createMockServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

describe('fixtures', () => {
  it('cidadãos têm CPF e CNS válidos', () => {
    for (const c of MOCK_CITIZENS) {
      if (c.cpf) expect(isValidCpf(c.cpf), c.cpf).toBe(true);
      expect(c.cns.length).toBeGreaterThan(0);
      for (const cns of c.cns) expect(isValidCns(cns), cns).toBe(true);
    }
  });

  it('NF-e têm chave com DV correto, GTIN válido e rastro por lote', () => {
    const nfes = loadNfeFixtures();
    expect(nfes).toHaveLength(2);
    for (const n of nfes) {
      const digits = n.chave.slice(0, 43);
      let sum = 0;
      let w = 2;
      for (const d of [...digits].reverse()) {
        sum += Number(d) * w;
        w = w === 9 ? 2 : w + 1;
      }
      const dv = 11 - (sum % 11);
      expect(Number(n.chave[43])).toBe(dv >= 10 ? 0 : dv);
      expect(n.destCnpj).toBe(DEMO_DEST_CNPJ);
      expect(n.chave.slice(6, 20)).toBe(n.emitCnpj);
      for (const ean of n.xml.matchAll(/<cEAN>(\d+)<\/cEAN>/g)) expect(isValidGtin(ean[1]!)).toBe(true);
      expect(n.xml).toMatch(/<rastro><nLote>[^<]+<\/nLote><qLote>[\d.]+<\/qLote><dFab>\d{4}-\d{2}-\d{2}<\/dFab><dVal>\d{4}-\d{2}-\d{2}<\/dVal><\/rastro>/);
      expect(n.xml).toMatch(/<med><cProdANVISA>\d{13}<\/cProdANVISA><vPMC>[\d.]+<\/vPMC><\/med>/);
    }
  });
});

describe('servidor simulado', () => {
  it('health', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ status: 'ok' });
  });

  it('RNDS: consulta CADSUS e recebe documentos', async () => {
    const rnds = new RndsClient({ authUrl: `${base}/rnds/auth`, ehrUrl: `${base}/rnds/ehr`, requesterCpf: '12345678909' });
    const cadsus = new RndsCadsusClient(rnds);
    expect(await cadsus.findByCpf('52998224725')).toMatchObject({ name: 'Maria da Silva Souza', cns: ['203456789010002'] });
    expect(await cadsus.findByCns('898765432100008')).toMatchObject({ name: 'Raimundo Nonato Alves' });
    expect((await cadsus.findByCns('700123456789002'))?.cpf).toBe('12345678909');
    expect(await cadsus.findByCpf('04567891201')).toBeNull();

    const bundle = buildRacBundle({
      rndsRequesterId: '1234',
      localId: 'rac-1',
      patient: { cpf: '52998224725' },
      practitioner: { cns: '203456789010002', cbo: '225125' },
      establishment: { cnes: '1234567' },
      careLevel: 'ATENCAO_BASICA',
      encounter: { start: new Date('2026-03-10T13:00:00Z') },
      problems: [{ system: 'CID10', code: 'I10' }],
    });
    const sent = await rnds.sendBundle(bundle);
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/);
    const received = await (await fetch(`${base}/rnds/_received`)).json();
    expect(received.at(-1)).toMatchObject({ id: sent.id, requesterCpf: '12345678909' });

    // Documento inválido volta 422 com OperationOutcome.
    (bundle.entry![0]!.resource as { subject?: unknown }).subject = undefined;
    await expect(rnds.sendBundle(bundle)).rejects.toMatchObject({ status: 422 });
  });

  it('RNDS: exige token e CPF do solicitante', async () => {
    const res = await fetch(`${base}/rnds/ehr/api/fhir/r4/Patient?identifier=x|1`);
    expect(res.status).toBe(401);
    const { access_token } = await (await fetch(`${base}/rnds/auth/api/token`, { method: 'POST' })).json();
    const res2 = await fetch(`${base}/rnds/ehr/api/fhir/r4/Patient?identifier=x|1`, {
      headers: { 'X-Authorization-Server': `Bearer ${access_token}`, Authorization: '123' },
    });
    expect(res2.status).toBe(403);
  });

  it('SEFAZ: lista NF-e destinadas ao CNPJ e devolve o XML pela chave', async () => {
    const list = await (await fetch(`${base}/sefaz/nfe?cnpj=${DEMO_DEST_CNPJ}`)).json();
    expect(list.total).toBe(2);
    expect(list.documentos[0].xml).toContain('<nfeProc');
    const xml = await (await fetch(`${base}/sefaz/nfe/${list.documentos[0].chave}`)).text();
    expect(xml).toContain(list.documentos[0].chave);
    expect((await fetch(`${base}/sefaz/nfe?cnpj=11222333000181`)).ok).toBe(true);
    expect((await fetch(`${base}/sefaz/nfe`)).status).toBe(400);
  });

  it('WhatsApp: aceita envios do cliente e expõe o que foi enviado', async () => {
    await fetch(`${base}/whatsapp/_sent`, { method: 'DELETE' });
    const client = new WhatsAppCloudClient({ phoneNumberId: '5550001', accessToken: 'tok', baseUrl: `${base}/whatsapp`, apiVersion: 'v23.0' });
    const id = await client.sendTemplate(
      '5563999998888',
      buildAppointmentConfirmationTemplate({
        appointmentId: 'apt1',
        patientName: 'Maria da Silva Souza',
        service: 'Clínica Médica',
        unitName: 'UBS Centro',
        startsAt: new Date('2026-03-12T17:30:00Z'),
      }),
    );
    expect(id).toMatch(/^wamid\.MOCK/);
    const sent = await (await fetch(`${base}/whatsapp/_sent`)).json();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id, to: '5563999998888', type: 'template', phoneNumberId: '5550001' });

    const unauth = await fetch(`${base}/whatsapp/v23.0/1/messages`, { method: 'POST', body: '{}' });
    expect(unauth.status).toBe(401);
  });

  it('404 para rotas desconhecidas', async () => {
    expect((await fetch(`${base}/nada`)).status).toBe(404);
  });
});
