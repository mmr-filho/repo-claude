import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateRawSync } from 'node:zlib';
import { competencia as competenciaOf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BPA_C_LINE, BPA_HEADER, BPA_I_LINE, controlField, lineWidth } from '../src/modules/billing/bpa-layout';
import { isFirstBusinessDay } from '../src/modules/billing/calendar';
import { readZip } from '../src/modules/billing/zip';
import { pgAvailable, startTestApp, type TestApp } from './harness';

const enabled = await pgAvailable();

/** Gera um zip (deflate) em memória, no mesmo formato do pacote do DATASUS. */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'latin1');
    const compressed = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'latin1');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, compressed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const pad = (v: string, n: number) => v.padEnd(n, ' ').slice(0, n);
const num = (v: number | string, n: number) => String(v).padStart(n, '0');

function sigtapZip(): Buffer {
  const layoutProc = [
    'Coluna,Tamanho,Inicio,Fim,Tipo',
    'CO_PROCEDIMENTO,10,1,10,VARCHAR2',
    'NO_PROCEDIMENTO,250,11,260,VARCHAR2',
    'TP_COMPLEXIDADE,1,261,261,VARCHAR2',
    'TP_SEXO,1,262,262,VARCHAR2',
    'QT_MAXIMA_EXECUCAO,4,263,266,NUMBER',
    'QT_DIAS_PERMANENCIA,4,267,270,NUMBER',
    'QT_PONTOS,4,271,274,NUMBER',
    'VL_IDADE_MINIMA,4,275,278,NUMBER',
    'VL_IDADE_MAXIMA,4,279,282,NUMBER',
    'VL_SH,12,283,294,NUMBER',
    'VL_SA,12,295,306,NUMBER',
    'VL_SP,12,307,318,NUMBER',
    'DT_COMPETENCIA,6,319,324,VARCHAR2',
  ].join('\r\n');
  const proc = (code: string, name: string, sex: string, max: number, minAge: number, maxAge: number, sa: number) =>
    code + pad(name, 250) + '1' + sex + num(max, 4) + num(0, 4) + num(0, 4) + num(minAge, 4) + num(maxAge, 4) + num(0, 12) + num(Math.round(sa * 100), 12) + num(0, 12) + '202611';
  return makeZip({
    'tb_procedimento.txt': [proc('0301060061', 'ATENDIMENTO DE URGÊNCIA EM ATENÇÃO ESPECIALIZADA', 'I', 1, 0, 9999, 11), proc('0211020036', 'ELETROCARDIOGRAMA', 'I', 1, 0, 9999, 5.15)].join('\r\n'),
    'tb_procedimento_layout.txt': layoutProc,
    'rl_procedimento_ocupacao.txt': ['0301060061225125', '0301060061225142', '0211020036225125'].join('\r\n'),
    'rl_procedimento_ocupacao_layout.txt': 'Coluna,Tamanho,Inicio,Fim,Tipo\r\nCO_PROCEDIMENTO,10,1,10,VARCHAR2\r\nCO_OCUPACAO,6,11,16,CHAR',
    'rl_procedimento_cid.txt': ['0301060061I10 S', '0301060061R51 N'].join('\r\n'),
    'rl_procedimento_cid_layout.txt': 'Coluna,Tamanho,Inicio,Fim,Tipo\r\nCO_PROCEDIMENTO,10,1,10,VARCHAR2\r\nCO_CID,4,11,14,VARCHAR2\r\nST_PRINCIPAL,1,15,15,CHAR',
    'rl_procedimento_registro.txt': ['030106006102202611', '021102003601202611', '021102003602202611'].join('\r\n'),
    'rl_procedimento_registro_layout.txt': 'Coluna,Tamanho,Inicio,Fim,Tipo\r\nCO_PROCEDIMENTO,10,1,10,VARCHAR2\r\nCO_REGISTRO,2,11,12,VARCHAR2\r\nDT_COMPETENCIA,6,13,18,VARCHAR2',
  });
}

describe('calendário da SIGTAP', () => {
  it('reconhece o primeiro dia útil considerando feriados nacionais', () => {
    expect(isFirstBusinessDay(new Date('2026-11-03T12:00:00Z'))).toBe(true); // 02/11 é Finados
    expect(isFirstBusinessDay(new Date('2026-11-02T12:00:00Z'))).toBe(false);
    expect(isFirstBusinessDay(new Date('2026-08-03T12:00:00Z'))).toBe(true); // 01/08 é sábado
    expect(isFirstBusinessDay(new Date('2027-01-04T12:00:00Z'))).toBe(true); // 01/01 é feriado (sexta)
  });

  it('lê o zip gerado', () => {
    const entries = readZip(sigtapZip());
    expect(entries.map((e) => e.name)).toContain('tb_procedimento.txt');
  });
});

describe.runIf(enabled)('faturamento SUS', () => {
  let t: TestApp;
  let faturamento: string;
  let upaId: string;
  let server: Server;
  const comp = competenciaOf(new Date());
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/sigtap/TabelaUnificada_202611.zip') {
        res.writeHead(200, { 'content-type': 'application/zip' }).end(sigtapZip());
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    t = await startTestApp('billing', { SIGTAP_ZIP_URL: `http://127.0.0.1:${port}/sigtap/TabelaUnificada_{competencia}.zip` });
    faturamento = await t.login('faturamento', 'UPA 24h Norte', 'FATURAMENTO');
    const me = await t.http().get('/api/auth/me').set(auth(faturamento)).expect(200);
    upaId = me.body.context.unitId;
  });
  afterAll(async () => {
    await t?.close();
    server?.close();
  });

  it('só o faturamento acessa', async () => {
    const medica = await t.login('medica', 'UPA 24h Norte', 'MEDICO');
    await t.http().get(`/api/billing/production?competencia=${comp}`).set(auth(medica)).expect(403);
  });

  it('a crítica pré-glosa aponta CBO, CID e sexo incompatíveis', async () => {
    const res = await t.http().post('/api/billing/critique').set(auth(faturamento)).send({ competencia: comp }).expect(200);
    expect(res.body.total).toBe(6);
    expect(res.body.validated).toBe(3);
    expect(res.body.glosas).toBe(3);
    expect(res.body.byRule).toEqual({ CBO_INCOMPATIVEL: 1, CID_INCOMPATIVEL: 1, SEXO_INCOMPATIVEL: 1 });
    const list = await t.http().get(`/api/billing/production?competencia=${comp}&status=GLOSA_PREVISTA`).set(auth(faturamento)).expect(200);
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items.find((i: { cbo: string }) => i.cbo === '422105').issues[0].rule).toBe('CBO_INCOMPATIVEL');
  });

  it('lançamento manual com idade e sexo fora da regra vira glosa prevista', async () => {
    const recepcao = await t.login('recepcao', 'UPA 24h Norte', 'RECEPCAO');
    const pedro = (await t.http().get('/api/patients?q=pedro henrique').set(auth(recepcao)).expect(200)).body[0];
    await t
      .http()
      .post('/api/billing/production')
      .set(auth(faturamento))
      .send({ procedureCode: '02.01.02.003-3', patientId: pedro.id, cbo: '223505', quantity: 1, performedAt: new Date().toISOString(), instrument: 'BPA_C', unitId: upaId })
      .expect(201);
    const res = await t.http().post('/api/billing/critique').set(auth(faturamento)).send({ competencia: comp, unitId: upaId }).expect(200);
    const rules = res.body.records.filter((r: { procedureCode: string }) => r.procedureCode === '0201020033').flatMap((r: { issues: { rule: string }[] }) => r.issues.map((i) => i.rule));
    expect(rules).toEqual(expect.arrayContaining(['SEXO_INCOMPATIVEL', 'IDADE_INCOMPATIVEL']));
  });

  it('exporta o BPA-I com layout de largura fixa e campo de controle', async () => {
    const res = await t.http().post('/api/billing/export/bpa').set(auth(faturamento)).send({ competencia: comp, unitId: upaId, instrument: 'BPA_I' }).expect(201);
    expect(res.body.lines).toBe(2);
    expect(res.body.controlField).toBe(
      controlField([
        { procedureCode: '0301060061', quantity: 1 },
        { procedureCode: '0301060061', quantity: 1 },
      ]),
    );
    const file = await t.http().get(`/api/billing/exports/${res.body.id}/download`).set(auth(faturamento)).buffer(true).expect(200);
    expect(file.headers['content-type']).toContain('ISO-8859-1');
    const lines = file.text.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]!.startsWith(`01#BPA#${comp}000002000001${res.body.controlField}`)).toBe(true);
    expect(lines[0]!.length).toBe(lineWidth(BPA_HEADER));
    expect(res.body.validation).toMatchObject({ ok: true, errors: 0 });
    for (const l of lines.slice(1)) {
      expect(l.length).toBe(350);
      expect(l.startsWith('039000036')).toBe(true);
      // Um só documento do paciente (CNS ou CPF) e situação de rua S/N/branco na última posição.
      const cns = l.slice(59, 74).trim();
      const cpf = l.slice(338, 349).trim();
      expect(cns && cpf).toBeFalsy();
      expect([' ', 'N', 'S']).toContain(l[349]);
    }
    const check = await t.http().get(`/api/billing/exports/${res.body.id}/validation`).set(auth(faturamento)).expect(200);
    expect(check.body).toMatchObject({ ok: true, records: { bpaI: 2, bpaC: 0 } });
    // Conferência de um arquivo externo: campo de controle adulterado.
    const tampered = file.text.replace(res.body.controlField, '1234');
    const bad = await t.http().post('/api/billing/bpa/validate').set(auth(faturamento)).set('content-type', 'text/plain').send(tampered).expect(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.issues.some((i: { field?: string }) => i.field === 'cbc-smt-vrf')).toBe(true);
    // Já exportado: não sai de novo.
    await t.http().post('/api/billing/export/bpa').set(auth(faturamento)).send({ competencia: comp, unitId: upaId, instrument: 'BPA_I' }).expect(422);
    const exports = await t.http().get(`/api/billing/exports?competencia=${comp}`).set(auth(faturamento)).expect(200);
    expect(exports.body[0].fileName).toBe(`BPA_9000036_${comp}_BPA_I.txt`);
  });

  it('exporta o BPA-C consolidado', async () => {
    const res = await t.http().post('/api/billing/export/bpa').set(auth(faturamento)).send({ competencia: comp, unitId: upaId, instrument: 'BPA_C' }).expect(201);
    expect(res.body.lines).toBe(1);
    const e = await t.http().get(`/api/billing/exports/${res.body.id}/download`).set(auth(faturamento)).buffer(true).expect(200);
    const line = e.text.split('\r\n')[1]!;
    expect(line.length).toBe(lineWidth(BPA_C_LINE));
    expect(line.slice(0, 2)).toBe('02');
    expect(line).toContain('0301060118');
  });

  it('mostra o espelho das internações', async () => {
    const res = await t
      .http()
      .get(`/api/billing/aih-mirror?competencia=${competenciaOf(new Date(Date.now() - 2 * 86_400_000))}`)
      .set(auth(faturamento))
      .expect(200);
    expect(res.body.items.some((i: { patient: string; mainCid: string }) => i.patient === 'Francisco Souza Santos' && i.mainCid === 'J18')).toBe(true);
  });

  it('importa o pacote da SIGTAP por upload e por sincronização', async () => {
    const zip = sigtapZip();
    const up = await t.http().post('/api/billing/sigtap/import').set(auth(faturamento)).set('content-type', 'application/zip').send(zip).expect(201);
    expect(up.body).toMatchObject({ competencia: '202611', procedures: 2, cboLinks: 3, cidLinks: 2 });
    const procs = await t.http().get('/api/billing/sigtap/procedures?q=0211').set(auth(faturamento)).expect(200);
    expect(procs.body[0]).toMatchObject({ code: '0211020036', name: 'ELETROCARDIOGRAMA', instruments: ['BPA_C', 'BPA_I'] });
    const viaJson = await t
      .http()
      .post('/api/billing/sigtap/import')
      .set(auth(faturamento))
      .send({ fileBase64: zip.toString('base64') })
      .expect(201);
    expect(viaJson.body.procedures).toBe(2);
    const sync = await t.http().post('/api/billing/sigtap/sync').set(auth(faturamento)).send({ competencia: '202611' }).expect(201);
    expect(sync.body.procedures).toBe(2);
    await t.http().post('/api/billing/sigtap/sync').set(auth(faturamento)).send({ competencia: '202612' }).expect(502);
    await t.http().post('/api/billing/sigtap/import').set(auth(faturamento)).set('content-type', 'application/zip').send(Buffer.from('não é zip nenhum, só texto')).expect(422);
    const history = await t.http().get('/api/billing/sigtap/syncs').set(auth(faturamento)).expect(200);
    expect(history.body.some((s: { status: string }) => s.status === 'ERRO')).toBe(true);
    // Com a nova tabela, procedimentos que saíram dela viram glosa prevista.
    const res = await t.http().post('/api/billing/critique').set(auth(faturamento)).send({ competencia: comp }).expect(200);
    expect(res.body.byRule.PROCEDIMENTO_INEXISTENTE).toBeGreaterThan(0);
  });
});
