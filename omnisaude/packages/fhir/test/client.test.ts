import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { citizenToPatient, patientToCitizen, RndsCadsusClient, RndsClient, RndsError, type CadsusCitizen } from '@omnisaude/fhir';

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

function handlerServer(handler: Handler, tls?: https.ServerOptions): http.Server {
  const fn = (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, body, res));
  };
  return tls ? https.createServer(tls, fn) : http.createServer(fn);
}

const citizen: CadsusCitizen = {
  cpf: '52998224725',
  cns: ['203456789010002', '700123456789002'],
  name: 'Maria da Silva Souza',
  socialName: 'Mara Souza',
  motherName: 'Joana da Silva',
  birthDate: '1980-05-17',
  sex: 'F',
  phones: ['63999998888'],
  address: { line: 'Rua 7, 120', district: 'Centro', city: 'Gurupi', ibgeCode: '1709500', state: 'TO', postalCode: '77405-070' },
};

describe('CADSUS', () => {
  it('converte Patient <-> cidadão', () => {
    const back = patientToCitizen(citizenToPatient(citizen, 'p1'));
    expect(back).toEqual({ ...citizen, address: { ...citizen.address, postalCode: '77405070' } });
  });

  it('lê filiação de Patient.contact (MTH/FTH)', () => {
    const c = patientToCitizen({
      resourceType: 'Patient',
      name: [{ given: ['João'], family: 'Pereira' }],
      contact: [{ relationship: [{ coding: [{ code: 'FTH' }] }], name: { text: 'Pedro Pereira' } }],
      gender: 'male',
    });
    expect(c).toMatchObject({ name: 'João Pereira', fatherName: 'Pedro Pereira', sex: 'M', cns: [] });
  });
});

describe('RndsClient', () => {
  it('obtém token, envia bundle, renova token em 401 e consulta cidadão', async () => {
    let tokens = 0;
    let rejectNext = false;
    const seen: http.IncomingHttpHeaders[] = [];
    const port = await listen(
      handlerServer((req, body, res) => {
        if (req.url === '/api/token') {
          tokens++;
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: `tok${tokens}`, expires_in: 1800 }));
          return;
        }
        seen.push(req.headers);
        if (rejectNext) {
          rejectNext = false;
          res.writeHead(401).end();
          return;
        }
        if (req.method === 'POST' && req.url === '/api/fhir/r4/Bundle') {
          expect(JSON.parse(body).resourceType).toBe('Bundle');
          res.writeHead(201, { location: 'https://rnds/api/fhir/r4/Bundle/abc-123/_history/1' }).end();
          return;
        }
        if (req.method === 'GET' && req.url!.startsWith('/api/fhir/r4/Patient?identifier=')) {
          const id = decodeURIComponent(req.url!.split('=')[1]!);
          const found = id.endsWith('|52998224725');
          res.writeHead(200, { 'content-type': 'application/fhir+json' }).end(
            JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: found ? 1 : 0, entry: found ? [{ resource: citizenToPatient(citizen) }] : [] }),
          );
          return;
        }
        res.writeHead(400, { 'content-type': 'application/fhir+json' }).end(
          JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', diagnostics: 'Bundle inválido' }] }),
        );
      }),
    );
    const base = `http://127.0.0.1:${port}`;
    const client = new RndsClient({ authUrl: base, ehrUrl: base, requesterCpf: '12345678909' });

    const sent = await client.sendBundle({ resourceType: 'Bundle', type: 'document' });
    expect(sent.id).toBe('abc-123');
    expect(seen[0]!['x-authorization-server']).toBe('Bearer tok1');
    expect(seen[0]!.authorization).toBe('12345678909');
    expect(seen[0]!['content-type']).toBe('application/fhir+json');

    rejectNext = true;
    await client.sendBundle({ resourceType: 'Bundle', type: 'document' });
    expect(tokens).toBe(2);

    const cadsus = new RndsCadsusClient(client);
    expect((await cadsus.findByCpf('529.982.247-25'))?.name).toBe('Maria da Silva Souza');
    expect(await cadsus.findByCpf('12345678909')).toBeNull();
    await expect(cadsus.findByCns('123')).rejects.toThrow(/CNS inválido/);
    expect(tokens).toBe(2); // token reaproveitado
  });

  it('traduz OperationOutcome em RndsError', async () => {
    const port = await listen(
      handlerServer((req, _body, res) => {
        if (req.url === '/api/token') return res.writeHead(200).end(JSON.stringify({ access_token: 't' }));
        res.writeHead(422, { 'content-type': 'application/fhir+json' }).end(
          JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', diagnostics: 'CNES desconhecido' }] }),
        );
      }),
    );
    const client = new RndsClient({ authUrl: `http://127.0.0.1:${port}`, ehrUrl: `http://127.0.0.1:${port}`, requesterCpf: '12345678909' });
    const err = await client.sendBundle({ resourceType: 'Bundle', type: 'document' }).catch((e) => e);
    expect(err).toBeInstanceOf(RndsError);
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/CNES desconhecido/);
  });

  it('usa certificado cliente (mTLS)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rnds-mtls-'));
    const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=Teste CA');
    for (const name of ['server', 'client']) {
      const subj = name === 'server' ? '/CN=127.0.0.1' : '/CN=Cliente ICP Teste';
      ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', subj);
      const ext = name === 'server' ? ['-extfile', join(dir, 'san.ext')] : [];
      if (name === 'server') writeFileSync(join(dir, 'san.ext'), 'subjectAltName=IP:127.0.0.1\n');
      ssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1', ...ext);
    }
    const read = (f: string) => readFileSync(join(dir, f));
    let clientCn = '';
    const port = await listen(
      handlerServer(
        (req, _body, res) => {
          clientCn = String((req.socket as import('node:tls').TLSSocket).getPeerCertificate().subject?.CN ?? '');
          res.writeHead(200).end(JSON.stringify({ access_token: 'mtls-ok' }));
        },
        { key: read('server.key'), cert: read('server.crt'), ca: read('ca.crt'), requestCert: true, rejectUnauthorized: true },
      ),
    );
    const url = `https://127.0.0.1:${port}`;
    const client = new RndsClient({
      authUrl: url,
      ehrUrl: url,
      requesterCpf: '12345678909',
      tls: { cert: read('client.crt'), key: read('client.key'), ca: read('ca.crt') },
    });
    expect(await client.getAccessToken()).toBe('mtls-ok');
    expect(clientCn).toBe('Cliente ICP Teste');
    rmSync(dir, { recursive: true, force: true });

  }, 30_000);
});
