import { inflateSync } from 'node:zlib';
import { cnsFromBase, completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { AiService } from '../src/modules/integrations/ai.service';
import { RndsService } from '../src/modules/integrations/rnds.service';
import { CatalogoVigilanciaService } from '../src/modules/vigilancia/catalogo.service';
import { NotificacaoService } from '../src/modules/vigilancia/notificacao.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();
const H = 3_600_000;

/** Texto dos fluxos de conteúdo do PDF (o pdf-lib grava cada linha como string hexadecimal WinAnsi). */
const conteudoDoPdf = (pdf: Buffer) => {
  let out = '';
  for (const m of pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    try {
      out += inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
    } catch {
      out += m[1];
    }
  }
  return out.toUpperCase();
};
const hex = (texto: string) => Buffer.from(texto, 'latin1').toString('hex').toUpperCase();

type Criada = { id: string; numero: string; agravo: string; prazo: string; esferas: string[]; venceEm: string | null };

describe.runIf(enabled)('Vigilância: saída para os sistemas oficiais, encerramento, REL e comunicação policial (VIG-1b + INT-4a)', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let recepcao = '';
  let medica = '';
  let vig = '';
  let nucleo = '';
  let nir = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let seq = 0;
  const ids: Record<string, string> = {};
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const address = { cep: '77405070', street: 'Rua da Saída', number: '24', district: 'Centro', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };
  const hoje = () => new Date().toISOString().slice(0, 10);

  const novoPaciente = async (name: string, sex: 'M' | 'F', birthDate: string) => {
    seq++;
    const body = { name, birthDate, sex, cpf: completeCpf(String(483000900 + seq)), cns: cnsFromBase(String(28300000900 + seq)), motherName: `Mae de ${name}`, phone: '(63) 97777-2400', address };
    return (await t.http().post('/api/patients').set(auth(recepcao)).send(body).expect(201)).body.id as string;
  };
  const sys = async () => {
    const tenants = t.app.get(TenantsService);
    tenants.connections.invalidate(t.slug);
    const tenant = await tenants.resolve(t.slug);
    return { tenant, db: await tenants.client(tenant.id) };
  };
  const abrir = async (patientId: string) => {
    const enc = (await t.http().post('/api/reception/check-in').set(auth(recepcao)).send({ patientId, kind: 'AMBULATORIAL' }).expect(201)).body;
    await t.http().post(`/api/clinical/encounters/${enc.id}/start`).set(auth(medica)).expect(200);
    return enc.id as string;
  };
  const assinar = async (encId: string, code: string) => {
    const note = (
      await t
        .http()
        .post(`/api/clinical/encounters/${encId}/notes`)
        .set(auth(medica))
        .send({ kind: 'SOAP', subjective: 'Queixa.', objective: 'Exame.', assessment: 'Hipótese.', plan: 'Conduta.', codes: [{ system: 'CID10', code }] })
        .expect(201)
    ).body;
    return (await t.http().post(`/api/clinical/notes/${note.id}/sign`).set(auth(medica)).expect(200)).body.notificacoes as Criada[];
  };
  const confirmar = async (id: string, tk = medica) => (await t.http().post(`/api/vigilancia/notificacoes/${id}/confirmar`).set(auth(tk)).expect(200)).body;
  const detalhe = async (id: string, tk = vig) => (await t.http().get(`/api/vigilancia/notificacoes/${id}`).set(auth(tk)).expect(200)).body;
  const notificarComCid = async (nome: string, sex: 'M' | 'F', nasc: string, cid: string) => {
    const p = await novoPaciente(nome, sex, nasc);
    const [c] = await assinar(await abrir(p), cid);
    return { patientId: p, id: c!.id };
  };

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('vigsaida', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws`, RNDS_REQUESTER_CPF: '52998224725' });
    t.app.get(AiService).client = null;
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    nucleo = await t.login('nucleo', 'Hospital Municipal São Lucas', 'NUCLEO_VIGILANCIA');
    nir = await t.login('nir', 'Hospital Municipal São Lucas', 'NIR');
    db = (await sys()).db;
  });

  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('cada agravo cai na fila do sistema certo: dengue no Sinan Online, Oropouche no e-SUS Sinan, ESAVI no e-SUS Notifica', async () => {
    const den = await notificarComCid('Dario Dengue Saida', 'M', '1970-01-01', 'A90');
    const d = await confirmar(den.id);
    expect(d.saida).toMatchObject({ sistema: 'SINAN_ONLINE', digitacao: 'PENDENTE', numero: null, rota: { situacao: 'CONFIRMADO' } });
    ids.dengue = den.id;
    const oro = await notificarComCid('Osmar Oropouche Saida', 'M', '1971-02-02', 'A93.0');
    expect((await confirmar(oro.id)).saida.sistema).toBe('ESUS_SINAN');
    ids.oro = oro.id;
    // ESAVI pela vacina.
    const pv = await novoPaciente('Valdo Vacina Saida', 'M', '2025-03-03');
    const ubs = await db.unit.findFirstOrThrow({ where: { name: 'UBS Centro' } });
    const prof = await db.user.findFirstOrThrow({ where: { assignments: { some: { unitId: ubs.id, role: 'ENFERMAGEM' } } } });
    const vac = await db.vaccination.create({
      data: {
        patientId: pv,
        unitId: ubs.id,
        professionalId: prof.id,
        vaccineCode: '22',
        vaccineName: 'Pentavalente',
        lot: 'L-24',
        manufacturer: 'Fabricante',
        dose: 'D1',
        route: 'IM',
        appliedAt: new Date(Date.now() - 2 * H),
      },
    });
    const es = (await t.http().post('/api/vigilancia/notificacoes').set(auth(medica)).send({ patientId: pv, conditionKey: 'esavi', vaccinationId: vac.id }).expect(201)).body;
    expect((await confirmar(es.id)).saida.sistema).toBe('ESUS_NOTIFICA');
    const fila = (await t.http().get('/api/vigilancia/digitacao?sistema=SINAN_ONLINE').set(auth(vig)).expect(200)).body;
    expect(fila.notificacoes.map((n: { id: string }) => n.id)).toContain(den.id);
    expect(fila.sistemas.find((s: { sistema: string }) => s.sistema === 'SINAN_ONLINE').pendentes).toBeGreaterThanOrEqual(1);
    await t.http().get('/api/vigilancia/digitacao').set(auth(medica)).expect(403);
  });

  it('anomalia congênita não vai à fila: vira lembrete da Declaração de Nascido Vivo', async () => {
    const bebe = await novoPaciente('Bebe Anomalia Saida', 'F', new Date(Date.now() - 3 * 24 * H).toISOString().slice(0, 10));
    const d = (await t.http().post('/api/vigilancia/notificacoes').set(auth(medica)).send({ patientId: bebe, conditionKey: 'anomalias-congenitas' }).expect(201)).body;
    const c = await confirmar(d.id);
    ids.lembrete = c.numero;
    expect(c.saida).toMatchObject({ sistema: 'SINASC_SIM', digitacao: 'LEMBRETE' });
    expect(c.saida.rota.nota).toContain('Declaração de Nascido Vivo');
    const fila = (await t.http().get('/api/vigilancia/digitacao').set(auth(vig)).expect(200)).body;
    expect(fila.notificacoes.map((n: { id: string }) => n.id)).not.toContain(d.id);
  });

  it('Srag: internação com CID respiratório e SpO2 ≤ 94% abre o rascunho no Sivep-Gripe; só um dos sinais vira sugestão', async () => {
    const p = await novoPaciente('Sergio Srag Saida', 'M', '1950-04-04');
    const upa = await db.unit.findFirstOrThrow({ where: { name: 'UPA 24h Norte' } });
    const enfermeiro = await db.user.findFirstOrThrow({ where: { cpf: completeCpf('100000002') } });
    const enc = await db.encounter.create({ data: { unitId: upa.id, patientId: p, kind: 'URGENCIA', status: 'TRIADO', createdBy: enfermeiro.id } });
    await db.triage.create({ data: { encounterId: enc.id, nurseId: enfermeiro.id, complaint: 'Febre, tosse e falta de ar', spo2: 91, respiratoryRate: 28, flags: [], suggestedColor: 'LARANJA', riskColor: 'LARANJA' } });
    const leito = await db.bed.findFirstOrThrow({ where: { status: 'VAGO', ward: { unit: { name: 'Hospital Municipal São Lucas' }, kind: 'CLINICA_MEDICA' } }, orderBy: { code: 'asc' } });
    const adm = (await t.http().post('/api/admissions').set(auth(nir)).send({ patientId: p, bedId: leito.id, mainCid: 'J189' }).expect(201)).body;
    const srag = adm.notificacoes.find((n: Criada) => /Srag|SRAG/.test(n.agravo));
    expect(srag).toBeTruthy();
    expect((await confirmar(srag.id, nucleo)).saida.sistema).toBe('SIVEP_GRIPE');
    // Sinal de gravidade sem CID respiratório: sugestão no painel, sem rascunho.
    const p2 = await novoPaciente('Silvia Sugestao Saida', 'F', '1955-05-05');
    const enc2 = await db.encounter.create({ data: { unitId: upa.id, patientId: p2, kind: 'URGENCIA', status: 'TRIADO', createdBy: enfermeiro.id } });
    await db.triage.create({ data: { encounterId: enc2.id, nurseId: enfermeiro.id, complaint: 'Mal-estar', spo2: 92, flags: ['desconforto_respiratorio'], suggestedColor: 'LARANJA', riskColor: 'LARANJA' } });
    const leito2 = await db.bed.findFirstOrThrow({ where: { status: 'VAGO', ward: { unit: { name: 'Hospital Municipal São Lucas' }, kind: 'CLINICA_MEDICA' } }, orderBy: { code: 'asc' } });
    const adm2 = (await t.http().post('/api/admissions').set(auth(nir)).send({ patientId: p2, bedId: leito2.id, mainCid: 'R509' }).expect(201)).body;
    expect(adm2.notificacoes).toEqual([]);
    const sug = (await t.http().get('/api/vigilancia/srag/sugestoes').set(auth(nucleo)).expect(200)).body as { patientId: string; sinais: string[]; cidRespiratorio: boolean }[];
    expect(sug.find((s) => s.patientId === p2)).toMatchObject({ cidRespiratorio: false, sinais: expect.arrayContaining(['SpO2 92%', 'desconforto respiratório']) });
    expect(sug.find((s) => s.patientId === p)).toBeUndefined();
  });

  it('informar o número oficial tira da fila; formato do sistema e número repetido são recusados; só a vigilância desfaz', async () => {
    await t.http().post(`/api/vigilancia/notificacoes/${ids.dengue}/numero-oficial`).set(auth(vig)).send({ numero: 'ABC-12' }).expect(400);
    const d = (await t.http().post(`/api/vigilancia/notificacoes/${ids.dengue}/numero-oficial`).set(auth(vig)).send({ numero: '2600123', lote: 'L01' }).expect(200)).body;
    expect(d.saida).toMatchObject({ digitacao: 'DIGITADA', numero: '2600123', lote: 'L01', digitadaPor: expect.any(String) });
    const fila = (await t.http().get('/api/vigilancia/digitacao?sistema=SINAN_ONLINE').set(auth(vig)).expect(200)).body;
    expect(fila.notificacoes.map((n: { id: string }) => n.id)).not.toContain(ids.dengue);
    await t.http().post(`/api/vigilancia/notificacoes/${ids.dengue}/numero-oficial`).set(auth(vig)).send({ numero: '2600124' }).expect(422);
    const outra = await notificarComCid('Dalva Dengue Saida', 'F', '1940-06-06', 'A90');
    await confirmar(outra.id);
    const dup = (await t.http().post(`/api/vigilancia/notificacoes/${outra.id}/numero-oficial`).set(auth(vig)).send({ numero: '2600123' }).expect(409)).body;
    expect(dup.message).toContain('2600123');
    await t.http().post(`/api/vigilancia/notificacoes/${ids.dengue}/numero-oficial/desfazer`).set(auth(nucleo)).send({ reason: 'Número digitado errado.' }).expect(403);
    const desfeita = (await t.http().post(`/api/vigilancia/notificacoes/${ids.dengue}/numero-oficial/desfazer`).set(auth(vig)).send({ reason: 'Número digitado errado.' }).expect(200)).body;
    expect(desfeita.saida).toMatchObject({ digitacao: 'PENDENTE', numero: null });
    await t.http().post(`/api/vigilancia/notificacoes/${ids.dengue}/numero-oficial`).set(auth(vig)).send({ numero: '2600125' }).expect(200);
  });

  it('espelho e PDF na ordem da ficha do Sinan Net v5; exportação no layout do dicionário só para a vigilância', async () => {
    const e = (await t.http().get(`/api/vigilancia/notificacoes/${ids.dengue}/espelho`).set(auth(vig)).expect(200)).body;
    expect(e.linhas.map((l: { variavel: string }) => l.variavel)).toEqual([
      'NU_NOTIFIC',
      'TP_NOT',
      'ID_AGRAVO',
      'DT_NOTIFIC',
      'SEM_NOT',
      'SG_UF_NOT',
      'ID_MUNICIP',
      'ID_UNIDADE',
      'DT_SIN_PRI',
      'SEM_PRI',
      'NM_PACIENT',
      'DT_NASC',
      'NU_IDADE_N',
      'CS_SEXO',
      'CS_GESTANT',
      'CS_RACA',
      'CS_ESCOL_N',
      'ID_CNS_SUS',
      'NM_MAE_PAC',
      'SG_UF',
      'ID_MN_RESI',
      'ID_DISTRIT',
      'NM_BAIRRO',
      'NM_LOGRADO',
      'NU_NUMERO',
      'NM_COMPLEM',
      'ID_GEO1',
      'ID_GEO2',
      'NM_REFEREN',
      'NU_CEP',
      'NU_TELEFON',
      'NU_DDD_TEL',
      'CS_ZONA',
      'ID_PAIS',
      'DT_INVEST',
      'CLASSI_FIN',
      'CRITERIO',
      'EVOLUCAO',
      'DT_OBITO',
      'DT_ENCERRA',
    ]);
    const v = Object.fromEntries(e.linhas.map((l: { variavel: string; exportado: string }) => [l.variavel, l.exportado]));
    expect(v).toMatchObject({
      NU_NOTIFIC: '2600125',
      TP_NOT: '2',
      ID_AGRAVO: 'A90',
      ID_MUNICIP: expect.stringMatching(/^\d{6}$/),
      ID_MN_RESI: '170950',
      SG_UF: '17',
      CS_SEXO: 'M',
      NU_IDADE_N: expect.stringMatching(/^4\d{3}$/),
    });
    expect(v.DT_NOTIFIC).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(v.SEM_NOT).toMatch(/^\d{6}$/);
    const pdf = await t.http().get(`/api/vigilancia/notificacoes/${ids.dengue}/ficha.pdf`).set(auth(vig)).buffer(true).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(
      Buffer.from(pdf.body as Buffer)
        .subarray(0, 4)
        .toString(),
    ).toBe('%PDF');
    await t.http().get(`/api/vigilancia/exportacao.csv?de=${hoje()}&ate=${hoje()}`).set(auth(medica)).expect(403);
    await t.http().get(`/api/vigilancia/exportacao.csv?de=${hoje()}&ate=${hoje()}`).set(auth(nucleo)).expect(403);
    const csv = await t.http().get(`/api/vigilancia/exportacao.csv?sistema=SINAN_ONLINE&de=${hoje()}&ate=${hoje()}`).set(auth(vig)).buffer(true).expect(200);
    const texto = String(csv.text).replace(/^﻿/, '');
    const [cab, ...linhas] = texto.split('\r\n');
    expect(cab!.split(';').slice(0, 4)).toEqual(['NU_NOTIFIC', 'TP_NOT', 'ID_AGRAVO', 'DT_NOTIFIC']);
    expect(linhas.some((l) => l.startsWith('2600125;2;A90;'))).toBe(true);
    expect(await db.auditEntry.count({ where: { action: 'notificacao.exportar' } })).toBe(1);
  });

  it('encerramento: Oropouche só encerra com os campos 47, 48 e 54 (e 44 e 45) do e-SUS Sinan; genérico do Sinan Net nos demais', async () => {
    const base = { investigadaEm: hoje(), classificacao: '1', encerradaEm: hoje() };
    await t.http().post(`/api/vigilancia/notificacoes/${ids.oro}/encerrar`).set(auth(medica)).send(base).expect(403);
    const erro = (await t.http().post(`/api/vigilancia/notificacoes/${ids.oro}/encerrar`).set(auth(vig)).send(base).expect(400)).body;
    expect(erro.message).toContain('campo 48');
    expect(erro.message).toContain('campo 54');
    expect(erro.message).toContain('campo 44');
    expect(erro.message).toContain('campo 49');
    const ok = (
      await t
        .http()
        .post(`/api/vigilancia/notificacoes/${ids.oro}/encerrar`)
        .set(auth(vig))
        .send({ ...base, criterio: '1', evolucao: '1', conclusao: { '44': '2', '45': '2', '49': '1' } })
        .expect(200)
    ).body;
    expect(ok).toMatchObject({
      status: 'ENCERRADA',
      criterio: 'CONFIRMADO',
      encerramento: { classificacao: '1', criterioLabel: 'Laboratorial', evolucaoLabel: 'Cura', fichaEsus: true, numeracao: { classificacao: '47' } },
    });
    const esp = (await t.http().get(`/api/vigilancia/notificacoes/${ids.oro}/espelho`).set(auth(vig)).expect(200)).body;
    expect(esp.linhas.filter((l: { bloco: string }) => l.bloco === 'CONCLUSAO').map((l: { numero: string }) => l.numero)).toEqual(['46', '47', '48', '54', '55', '56']);
    await t
      .http()
      .patch(`/api/vigilancia/notificacoes/${ids.oro}`)
      .set(auth(vig))
      .send({ ficha: { CS_ZONA: '1' } })
      .expect(422);
    await t.http().post(`/api/vigilancia/notificacoes/${ids.oro}/reabrir`).set(auth(nucleo)).send({ reason: 'Resultado do LACEN mudou.' }).expect(403);
    expect((await t.http().post(`/api/vigilancia/notificacoes/${ids.oro}/reabrir`).set(auth(vig)).send({ reason: 'Resultado do LACEN mudou.' }).expect(200)).body.status).toBe('NOTIFICADA');
    // Sinan Net genérico: descartado com óbito pelo agravo é recusado.
    const coq = await notificarComCid('Celio Coqueluche Saida', 'M', '1980-07-07', 'A37.9');
    await confirmar(coq.id);
    ids.coq = coq.id;
    const ruim = (
      await t
        .http()
        .post(`/api/vigilancia/notificacoes/${coq.id}/encerrar`)
        .set(auth(vig))
        .send({ ...base, classificacao: '2', evolucao: '2', obitoEm: hoje() })
        .expect(400)
    ).body;
    expect(ruim.message).toContain('campo 41');
    expect(
      (
        await t
          .http()
          .post(`/api/vigilancia/notificacoes/${coq.id}/encerrar`)
          .set(auth(vig))
          .send({ ...base, classificacao: '2' })
          .expect(200)
      ).body.status,
    ).toBe('ENCERRADA');
  });

  it('resultado positivo de covid-19 abre a SG confirmada com prazo de 24 h do resultado e gera o REL aceito pelo simulador; o negativo só gera o REL', async () => {
    await t.http().patch('/api/vigilancia/configuracoes').set(auth(vig)).send({ relEnabled: true }).expect(200);
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    const p = await novoPaciente('Cora Covid Saida', 'F', '1960-08-08');
    const encId = await abrir(p);
    const [ex] = (
      await t
        .http()
        .post(`/api/clinical/encounters/${encId}/exams`)
        .set(auth(medica))
        .send({ items: [{ sigtapCode: '0214010058', name: 'Teste rápido de antígeno SARS-CoV-2' }] })
        .expect(201)
    ).body;
    const coleta = new Date(Date.now() - 30 * 60_000);
    await t.http().post(`/api/clinical/exams/${ex.id}/result`).set(auth(medica)).send({ examKey: 'covid-antigeno', qualitative: 'DETECTAVEL', collectedAt: coleta.toISOString() }).expect(400);
    await t.http().post(`/api/clinical/exams/${ex.id}/result`).set(auth(medica)).send({ examKey: 'covid-antigeno', qualitative: 'REAGENTE' }).expect(400);
    const r = (
      await t
        .http()
        .post(`/api/clinical/exams/${ex.id}/result`)
        .set(auth(medica))
        .send({ examKey: 'covid-antigeno', qualitative: 'REAGENTE', collectedAt: coleta.toISOString(), method: 'Imunocromatográfico' })
        .expect(200)
    ).body;
    expect(r.notificacoes).toHaveLength(1);
    const n = await db.notification.findUniqueOrThrow({ where: { id: r.notificacoes[0].id } });
    expect(n).toMatchObject({ conditionKey: 'sg-covid-confirmada', origin: 'EXAME', basis: 'CONFIRMADO', deadlineStart: 'CONFIRMACAO' });
    expect(n.dueAt!.getTime() - new Date(r.resultAt).getTime()).toBe(24 * H);
    // Negativo de outro paciente: REL sem notificação.
    const p2 = await novoPaciente('Nilo Negativo Saida', 'M', '1961-09-09');
    const enc2 = await abrir(p2);
    const [ex2] = (
      await t
        .http()
        .post(`/api/clinical/encounters/${enc2}/exams`)
        .set(auth(medica))
        .send({ items: [{ sigtapCode: '0202010000', name: 'RT-PCR SARS-CoV-2' }] })
        .expect(201)
    ).body;
    const r2 = (
      await t.http().post(`/api/clinical/exams/${ex2.id}/result`).set(auth(medica)).send({ examKey: 'covid-rtpcr', qualitative: 'NAO_DETECTAVEL', collectedAt: coleta.toISOString(), method: 'RT-PCR' }).expect(200)
    ).body;
    expect(r2.notificacoes).toEqual([]);
    expect(await db.outboxMessage.count({ where: { kind: 'RNDS_REL', aggregateId: { in: [ex.id, ex2.id] } } })).toBe(2);
    mocks.state.bundles.length = 0;
    await t.app.get(RndsService).dispatchDue(await sys(), new Date(Date.now() + 1000), 200);
    const enviados = await db.outboxMessage.findMany({ where: { kind: 'RNDS_REL' } });
    expect(enviados.map((m) => m.lastError)).toEqual([null, null]);
    const rels = mocks.state.bundles.filter((b) => (b.bundle as { entry: { resource: { type?: { coding?: { code: string }[] } } }[] }).entry[0]!.resource.type?.coding?.[0]?.code === 'REL');
    expect(rels).toHaveLength(2);
    const obs = (rels[0]!.bundle as { entry: { resource: Record<string, unknown> }[] }).entry.map((e) => e.resource).find((x) => x.resourceType === 'Observation')!;
    expect(obs).toMatchObject({ status: 'final', method: { text: expect.any(String) }, issued: expect.stringMatching(/T\d{2}:\d{2}:\d{2}-03:00$/) });
    expect(await db.outboxMessage.count({ where: { kind: 'RNDS_REL', status: 'ENVIADO' } })).toBe(2);
  });

  it('violência contra a mulher: prazo de 24 h para a autoridade policial e o envio registrado; lesão autoprovocada e homem não exigem', async () => {
    const v = await notificarComCid('Vivian Violencia Saida', 'F', '1990-10-10', 'T74.1');
    const d = await detalhe(v.id, medica);
    expect(d.policial).toMatchObject({ dispensa: null });
    expect(Date.parse(d.policial.venceEm) - Date.parse(d.datas.conhecimento)).toBe(24 * H);
    expect(d.prazo.porEsfera.find((e: { esfera: string }) => e.esfera === 'AUTORIDADE_POLICIAL')).toMatchObject({ situacao: 'NO_PRAZO' });
    expect(d.permissoes.comunicarPolicia).toBe(true);
    const pdf = await t.http().get(`/api/vigilancia/notificacoes/${v.id}/comunicacao-policial.pdf`).set(auth(medica)).buffer(true).expect(200);
    expect(
      Buffer.from(pdf.body as Buffer)
        .subarray(0, 4)
        .toString(),
    ).toBe('%PDF');
    // Sem identificação da vítima (Lei nº 10.778/2003, art. 3º): nem nome nem CPF no PDF padrão.
    const conteudo = conteudoDoPdf(Buffer.from(pdf.body as Buffer));
    expect(conteudo).toContain(hex('CNES'));
    expect(conteudo).not.toContain(hex('Vivian'));
    expect(conteudo).not.toContain(hex('Paciente:'));
    // O PDF não passa pela assinatura ICP-Brasil: não pode se declarar assinado.
    expect(conteudo).toContain(hex('DOCUMENTO SEM ASSINATURA DIGITAL'));
    expect(conteudo).not.toContain(hex('ASSINADO DIGITALMENTE'));
    expect(Buffer.from(pdf.body as Buffer).toString('latin1')).not.toContain('/ByteRange');
    // A médica (que atendeu) registra o envio, ainda com a notificação em rascunho; não registra repasse à SES.
    await t.http().post(`/api/vigilancia/notificacoes/${v.id}/comunicacoes`).set(auth(medica)).send({ target: 'SES', channel: 'TELEFONE', communicatedAt: new Date().toISOString(), counterpartName: 'SES' }).expect(403);
    const c = (
      await t
        .http()
        .post(`/api/vigilancia/notificacoes/${v.id}/comunicacoes`)
        .set(auth(medica))
        .send({ target: 'AUTORIDADE_POLICIAL', channel: 'PRESENCIAL', communicatedAt: new Date().toISOString(), counterpartName: 'Delegacia Especializada de Atendimento à Mulher', protocol: 'BO-1' })
        .expect(201)
    ).body;
    expect(c.prazo.porEsfera.find((e: { esfera: string }) => e.esfera === 'AUTORIDADE_POLICIAL').situacao).toBe('CUMPRIDO');
    const auto = await notificarComCid('Alice Autoprovocada Saida', 'F', '1991-11-11', 'X64');
    expect((await detalhe(auto.id, medica)).policial).toBeNull();
    const homem = await notificarComCid('Hilton Homem Saida', 'M', '1992-12-12', 'T74.1');
    expect((await detalhe(homem.id, medica)).policial).toBeNull();
    // Art. 14-A, parágrafo único: menina segue o ECA (Conselho Tutelar) e idosa o Estatuto da Pessoa Idosa.
    const menina = await notificarComCid('Marta Menina Saida', 'F', `${new Date().getUTCFullYear() - 14}-03-03`, 'T74.1');
    const dm = await detalhe(menina.id, medica);
    expect(dm.policial).toBeNull();
    expect(dm.orientacaoViolencia).toContain('Conselho Tutelar');
    const idosa = await notificarComCid('Iolanda Idosa Saida', 'F', '1950-04-04', 'T74.1');
    const di = await detalhe(idosa.id, medica);
    expect(di.policial).toBeNull();
    expect(di.orientacaoViolencia).toContain('Estatuto da Pessoa Idosa');
    expect(d.orientacaoViolencia).toBeNull();
    // Dispensa justificada pela vigilância.
    const v2 = await notificarComCid('Vera Violencia Dois Saida', 'F', '1993-01-02', 'Y04');
    await t
      .http()
      .patch(`/api/vigilancia/notificacoes/${v2.id}`)
      .set(auth(vig))
      .send({ policial: { dispensa: 'curta' } })
      .expect(400);
    const disp = (
      await t
        .http()
        .patch(`/api/vigilancia/notificacoes/${v2.id}`)
        .set(auth(vig))
        .send({ policial: { dispensa: 'Comunicado pela própria vítima na delegacia, com protocolo.' } })
        .expect(200)
    ).body;
    expect(disp.prazo.porEsfera.find((e: { esfera: string }) => e.esfera === 'AUTORIDADE_POLICIAL')).toBeUndefined();
    const painel = (await t.http().get('/api/vigilancia/painel').set(auth(vig)).expect(200)).body;
    expect(painel.cartoes.pendentesDigitacao).toBeGreaterThanOrEqual(1);
    expect(painel.cartoes).toHaveProperty('comunicacoesPoliciais');
  });

  it('Sinan Net: o NU_NOTIFIC é da unidade e só se repete em outro agravo, data ou município', async () => {
    const a = await notificarComCid('Amaro Agressao Saida', 'M', '1985-05-05', 'T74.1');
    const b = await notificarComCid('Bruno Agressao Saida', 'M', '1986-06-06', 'Y04');
    await confirmar(a.id);
    await confirmar(b.id);
    expect((await detalhe(a.id)).saida).toMatchObject({ sistema: 'SINAN_NET', digitacao: 'PENDENTE' });
    await t.http().post(`/api/vigilancia/notificacoes/${a.id}/numero-oficial`).set(auth(vig)).send({ numero: '12345678' }).expect(400);
    await t.http().post(`/api/vigilancia/notificacoes/${a.id}/numero-oficial`).set(auth(vig)).send({ numero: '0000417' }).expect(200);
    const dup = (await t.http().post(`/api/vigilancia/notificacoes/${b.id}/numero-oficial`).set(auth(vig)).send({ numero: '0000417' }).expect(409)).body;
    expect(dup.message).toContain('mesmo agravo');
    // Mesmo número em outro agravo (coqueluche) no mesmo dia e município: aceito.
    expect((await t.http().post(`/api/vigilancia/notificacoes/${ids.coq}/numero-oficial`).set(auth(vig)).send({ numero: '0000417' }).expect(200)).body.saida.numero).toBe('0000417');
    // e-SUS Sinan: 12 dígitos no formato UFAANNNNNNNN (dicionário de dados da notificação).
    await t.http().post(`/api/vigilancia/notificacoes/${ids.oro}/numero-oficial`).set(auth(vig)).send({ numero: '1726000123' }).expect(400);
    expect((await t.http().post(`/api/vigilancia/notificacoes/${ids.oro}/numero-oficial`).set(auth(vig)).send({ numero: '172600000123' }).expect(200)).body.saida).toMatchObject({
      sistema: 'ESUS_SINAN',
      numero: '172600000123',
    });
  });

  it('a vigilância muda a rota de um agravo com nova vigência (caxumba para o e-SUS Sinan, pactuado com a SES)', async () => {
    const r = (
      await t.http().post('/api/vigilancia/sistemas').set(auth(vig)).send({ groupKey: 'caxumba', system: 'ESUS_SINAN', status: 'CONFIRMADO', validFrom: hoje(), source: 'Ofício SES-TO nº 1/2026 (teste)' }).expect(201)
    ).body;
    expect(r).toMatchObject({ grupo: 'caxumba', sistema: 'ESUS_SINAN', vigente: true });
    await t.http().post('/api/vigilancia/sistemas').set(auth(vig)).send({ groupKey: 'caxumba', system: 'SINAN_NET', status: 'CONFIRMADO', validFrom: hoje(), source: 'duplicada' }).expect(409);
    const rotas = (await t.http().get('/api/vigilancia/sistemas').set(auth(vig)).expect(200)).body as { grupo: string; vigente: boolean; vigenteAte: string | null; sistema: string }[];
    expect(rotas.filter((x) => x.grupo === 'caxumba' && x.vigente).map((x) => x.sistema)).toEqual(['ESUS_SINAN']);
    const cax = await notificarComCid('Caio Caxumba Saida', 'M', '2010-03-03', 'B26');
    expect((await confirmar(cax.id)).saida.sistema).toBe('ESUS_SINAN');
  });

  // ───────────── correções da revisão adversarial ─────────────

  it('Srag sugerida fica na unidade do atendimento; covid com Srag na internação não abre a SG, e o exame confirma a Srag', async () => {
    const upa = await db.unit.findFirstOrThrow({ where: { name: 'UPA 24h Norte' } });
    const vigUnitId = (await db.unit.findFirstOrThrow({ where: { name: 'Vigilância em Saúde' } })).id;
    const enfermeiro = await db.user.findFirstOrThrow({ where: { cpf: completeCpf('100000002') } });
    const vaga = () => db.bed.findFirstOrThrow({ where: { status: 'VAGO', ward: { unit: { name: 'Hospital Municipal São Lucas' }, kind: 'CLINICA_MEDICA' } }, orderBy: { code: 'asc' } });
    // Sugestão (só o sinal na triagem): a vigilância municipal notifica pela internação, não pela própria unidade.
    const p1 = await novoPaciente('Saulo Sugerido Saida', 'M', '1952-02-02');
    const e1 = await db.encounter.create({ data: { unitId: upa.id, patientId: p1, kind: 'URGENCIA', status: 'TRIADO', createdBy: enfermeiro.id } });
    await db.triage.create({ data: { encounterId: e1.id, nurseId: enfermeiro.id, complaint: 'Falta de ar', spo2: 90, flags: [], suggestedColor: 'LARANJA', riskColor: 'LARANJA' } });
    await t
      .http()
      .post('/api/admissions')
      .set(auth(nir))
      .send({ patientId: p1, bedId: (await vaga()).id, mainCid: 'R060' })
      .expect(201);
    const sug = ((await t.http().get('/api/vigilancia/srag/sugestoes').set(auth(vig)).expect(200)).body as { patientId: string; encounterId: string; admissionId: string }[]).find((x) => x.patientId === p1)!;
    const criada = (await t.http().post('/api/vigilancia/notificacoes').set(auth(vig)).send({ patientId: p1, conditionKey: 'srag-coronavirus', encounterId: sug.encounterId, admissionId: sug.admissionId }).expect(201))
      .body;
    const n1 = await db.notification.findUniqueOrThrow({ where: { id: criada.id } });
    expect(n1.admissionId).toBe(sug.admissionId);
    expect(n1.unitId).toBe((await db.encounter.findUniqueOrThrow({ where: { id: sug.encounterId } })).unitId);
    expect(n1.unitId).not.toBe(vigUnitId);
    // Srag encerrada como inconclusiva: o covid-19 detectável depois vai para a Srag (reclassificação no Sivep-Gripe),
    // sem abrir a SG no e-SUS Notifica.
    await confirmar(criada.id, vig);
    await t.http().post(`/api/vigilancia/notificacoes/${criada.id}/encerrar`).set(auth(vig)).send({ investigadaEm: hoje(), classificacao: '8', encerradaEm: hoje() }).expect(200);
    const encS = await abrir(p1);
    const [exS] = (
      await t
        .http()
        .post(`/api/clinical/encounters/${encS}/exams`)
        .set(auth(medica))
        .send({ items: [{ sigtapCode: '0202020959', name: 'SARS-CoV-2 RT-PCR' }] })
        .expect(201)
    ).body;
    const rS = (
      await t
        .http()
        .post(`/api/clinical/exams/${exS.id}/result`)
        .set(auth(medica))
        .send({ examKey: 'covid-rtpcr', qualitative: 'DETECTAVEL', collectedAt: new Date(Date.now() - H).toISOString(), method: 'RT-PCR' })
        .expect(200)
    ).body;
    expect(rS.notificacoes).toEqual([expect.objectContaining({ id: criada.id, efeito: 'ENCERRADA' })]);
    expect(await db.notification.count({ where: { patientId: p1, groupKey: 'covid' } })).toBe(0);
    // Covid-19 confirmada (U07.1) com SpO2 baixa na internação: só a Srag (Sivep-Gripe).
    const p2 = await novoPaciente('Celso Covid Internado Saida', 'M', '1953-03-03');
    const e2 = await db.encounter.create({ data: { unitId: upa.id, patientId: p2, kind: 'URGENCIA', status: 'TRIADO', createdBy: enfermeiro.id } });
    await db.triage.create({ data: { encounterId: e2.id, nurseId: enfermeiro.id, complaint: 'Febre e dispneia', spo2: 89, flags: [], suggestedColor: 'LARANJA', riskColor: 'LARANJA' } });
    const adm = (
      await t
        .http()
        .post('/api/admissions')
        .set(auth(nir))
        .send({ patientId: p2, bedId: (await vaga()).id, mainCid: 'U071' })
        .expect(201)
    ).body;
    expect(adm.notificacoes.map((n: Criada) => n.agravo)).toEqual([expect.stringMatching(/Srag|SRAG|respiratória aguda grave/i)]);
    // Evolução com U07.1 depois da internação também não abre a SG (a Srag cobre o caso).
    const enc = await abrir(p2);
    expect(await assinar(enc, 'U07.1')).toEqual([]);
    // O RT-PCR detectável confirma a Srag e não abre a SG.
    const [ex] = (
      await t
        .http()
        .post(`/api/clinical/encounters/${enc}/exams`)
        .set(auth(medica))
        .send({ items: [{ sigtapCode: '0202020959', name: 'SARS-CoV-2 RT-PCR' }] })
        .expect(201)
    ).body;
    const r = (
      await t
        .http()
        .post(`/api/clinical/exams/${ex.id}/result`)
        .set(auth(medica))
        .send({ examKey: 'covid-rtpcr', qualitative: 'DETECTAVEL', collectedAt: new Date(Date.now() - 3 * H).toISOString(), method: 'RT-PCR' })
        .expect(200)
    ).body;
    // A Srag é do NIR: a médica recebe o aviso, mas sem link para uma ficha que não pode abrir.
    expect(r.notificacoes).toEqual([expect.objectContaining({ id: adm.notificacoes[0].id, efeito: 'CONFIRMADA', podeAbrir: false })]);
    expect(await db.notification.count({ where: { patientId: p2, groupKey: 'covid' } })).toBe(0);
    expect(await db.notification.findUniqueOrThrow({ where: { id: adm.notificacoes[0].id } })).toMatchObject({ basis: 'CONFIRMADO' });
    // Coleta mais de 5 min no futuro é recusada (até isso, vale a hora do servidor).
    const [ex2] = (
      await t
        .http()
        .post(`/api/clinical/encounters/${enc}/exams`)
        .set(auth(medica))
        .send({ items: [{ sigtapCode: '0202020959', name: 'SARS-CoV-2 RT-PCR' }] })
        .expect(201)
    ).body;
    await t
      .http()
      .post(`/api/clinical/exams/${ex2.id}/result`)
      .set(auth(medica))
      .send({ examKey: 'covid-rtpcr', qualitative: 'NAO_DETECTAVEL', collectedAt: new Date(Date.now() + 10 * 60_000).toISOString(), method: 'RT-PCR' })
      .expect(400);
    const grampeado = (
      await t
        .http()
        .post(`/api/clinical/exams/${ex2.id}/result`)
        .set(auth(medica))
        .send({ examKey: 'covid-rtpcr', qualitative: 'NAO_DETECTAVEL', collectedAt: new Date(Date.now() + 60_000).toISOString(), method: 'RT-PCR' })
        .expect(200)
    ).body;
    expect(Date.parse(grampeado.collectedAt)).toBeLessThanOrEqual(Date.parse(grampeado.resultAt));
    // Srag descartada não impede a SG do covid-19 confirmado.
    const p3 = await novoPaciente('Sonia Srag Descartada Saida', 'F', '1954-04-04');
    const sragManual = (await t.http().post('/api/vigilancia/notificacoes').set(auth(vig)).send({ patientId: p3, conditionKey: 'srag-coronavirus' }).expect(201)).body;
    await t.http().post(`/api/vigilancia/notificacoes/${sragManual.id}/descartar`).set(auth(vig)).send({ reason: 'Não preenche a definição de Srag.' }).expect(200);
    const enc3 = await abrir(p3);
    const [ex3] = (
      await t
        .http()
        .post(`/api/clinical/encounters/${enc3}/exams`)
        .set(auth(medica))
        .send({ items: [{ sigtapCode: '0202020959', name: 'SARS-CoV-2 RT-PCR' }] })
        .expect(201)
    ).body;
    const r3 = (
      await t
        .http()
        .post(`/api/clinical/exams/${ex3.id}/result`)
        .set(auth(medica))
        .send({ examKey: 'covid-rtpcr', qualitative: 'DETECTAVEL', collectedAt: new Date(Date.now() - H).toISOString(), method: 'RT-PCR' })
        .expect(200)
    ).body;
    expect(r3.notificacoes).toHaveLength(1);
    expect(r3.notificacoes[0].efeito).toBeUndefined();
    expect(await db.notification.count({ where: { patientId: p3, groupKey: 'covid' } })).toBe(1);
    // O núcleo do hospital não notifica por atendimento de outra unidade.
    await t.http().post('/api/vigilancia/notificacoes').set(auth(nucleo)).send({ patientId: p3, conditionKey: 'coqueluche', encounterId: enc3 }).expect(403);
  });

  it('violência: agressão na mesma nota da lesão autoprovocada, ou depois dela, exige a comunicação policial; só a vigilância dispensa', async () => {
    const nota = async (encId: string, codes: string[]) => {
      const n = (
        await t
          .http()
          .post(`/api/clinical/encounters/${encId}/notes`)
          .set(auth(medica))
          .send({ kind: 'SOAP', subjective: 'Relato.', objective: 'Exame.', assessment: 'Hipótese.', plan: 'Conduta.', codes: codes.map((code) => ({ system: 'CID10', code })) })
          .expect(201)
      ).body;
      return (await t.http().post(`/api/clinical/notes/${n.id}/sign`).set(auth(medica)).expect(200)).body.notificacoes as Criada[];
    };
    const p1 = await novoPaciente('Rita Mesma Nota Saida', 'F', '1994-04-04');
    const [mesma] = await nota(await abrir(p1), ['X64', 'T74.2']);
    const d1 = await detalhe(mesma!.id, medica);
    expect(d1.codigo.codigo).toBe('T742');
    expect(d1.policial).toMatchObject({ dispensa: null });
    const p2 = await novoPaciente('Lara Depois Saida', 'F', '1995-05-05');
    const enc2 = await abrir(p2);
    const [auto] = await nota(enc2, ['X64']);
    expect((await detalhe(auto!.id, medica)).policial).toBeNull();
    expect(await nota(enc2, ['T74.2'])).toEqual([]);
    const d2 = await detalhe(auto!.id, medica);
    expect(d2.policial).toMatchObject({ dispensa: null });
    expect(d2.eventos.map((e: { tipo: string }) => e.tipo)).toContain('POLICIAL_EXIGIDA');
    // Quem atendeu não dispensa a própria obrigação; a vigilância sim.
    expect(d2.permissoes.dispensarPolicia).toBe(false);
    await t
      .http()
      .patch(`/api/vigilancia/notificacoes/${auto!.id}`)
      .set(auth(medica))
      .send({ policial: { dispensa: 'A paciente não quis registrar ocorrência.' } })
      .expect(403);
    expect((await detalhe(auto!.id, vig)).permissoes.dispensarPolicia).toBe(true);
    await t
      .http()
      .patch(`/api/vigilancia/notificacoes/${auto!.id}`)
      .set(auth(vig))
      .send({ policial: { dispensa: 'Comunicada pela própria vítima, com protocolo.' } })
      .expect(200);
    // Violência doméstica (semanal) com exigência policial: o autor também não a tira descartando o rascunho.
    const dom = await notificarComCid('Dora Domestica Saida', 'F', '1990-09-09', 'T74.1');
    expect((await detalhe(dom.id, medica)).permissoes.descartar).toBe(false);
    await t.http().post(`/api/vigilancia/notificacoes/${dom.id}/descartar`).set(auth(medica)).send({ reason: 'Paciente pediu para não notificar.' }).expect(403);
    // Encerrada sem exigência; agressão registrada depois liga a exigência, e a vigilância dispensa sem reabrir.
    const p3 = await novoPaciente('Elisa Encerrada Saida', 'F', '1993-03-03');
    const enc3 = await abrir(p3);
    const [enc3n] = await nota(enc3, ['X64']);
    await t
      .http()
      .patch(`/api/vigilancia/notificacoes/${enc3n!.id}`)
      .set(auth(medica))
      .send({ ficha: { CS_GESTANT: '5' } })
      .expect(200);
    await confirmar(enc3n!.id);
    await t.http().post(`/api/vigilancia/notificacoes/${enc3n!.id}/encerrar`).set(auth(vig)).send({ investigadaEm: hoje(), classificacao: '1', criterio: '2', encerradaEm: hoje() }).expect(200);
    expect(await nota(enc3, ['T74.2'])).toEqual([]);
    const d3 = await detalhe(enc3n!.id);
    expect(d3).toMatchObject({ status: 'ENCERRADA', policial: { dispensa: null }, permissoes: { dispensarPolicia: true } });
    const dis = (
      await t
        .http()
        .patch(`/api/vigilancia/notificacoes/${enc3n!.id}`)
        .set(auth(vig))
        .send({ policial: { dispensa: 'Comunicada pela própria vítima, com protocolo.' } })
        .expect(200)
    ).body;
    expect(dis).toMatchObject({ status: 'ENCERRADA', policial: { dispensa: 'Comunicada pela própria vítima, com protocolo.' } });
  });

  it('descartada sai da fila e não recebe número; encerramento recusa óbito com cura; reabrir limpa a conclusão', async () => {
    const den = await notificarComCid('Dario Descarte Saida', 'M', '1970-07-07', 'A90');
    await confirmar(den.id);
    await t.http().post(`/api/vigilancia/notificacoes/${den.id}/descartar`).set(auth(vig)).send({ reason: 'Outro diagnóstico confirmado.' }).expect(200);
    const dd = await detalhe(den.id);
    expect(dd.permissoes.digitar).toBe(false);
    expect(dd.saida.digitacao).toBeNull();
    await t.http().post(`/api/vigilancia/notificacoes/${den.id}/numero-oficial`).set(auth(vig)).send({ numero: '2611111' }).expect(422);
    const fila = (await t.http().get('/api/vigilancia/digitacao?sistema=SINAN_ONLINE').set(auth(vig)).expect(200)).body;
    expect(fila.notificacoes.map((n: { id: string }) => n.id)).not.toContain(den.id);
    // O número de uma descartada fica como histórico e não prende outra notificação.
    const d1 = await notificarComCid('Diogo Digitado Saida', 'M', '1973-03-03', 'A90');
    await confirmar(d1.id);
    await t.http().post(`/api/vigilancia/notificacoes/${d1.id}/numero-oficial`).set(auth(vig)).send({ numero: '2622222' }).expect(200);
    await t.http().post(`/api/vigilancia/notificacoes/${d1.id}/descartar`).set(auth(vig)).send({ reason: 'Reclassificado como chikungunya.' }).expect(200);
    expect((await detalhe(d1.id)).saida).toMatchObject({ numero: '2622222' });
    const d2 = await notificarComCid('Diana Digitada Saida', 'F', '1950-03-03', 'A90');
    await confirmar(d2.id);
    await t.http().post(`/api/vigilancia/notificacoes/${d2.id}/numero-oficial`).set(auth(vig)).send({ numero: '2622222' }).expect(200);
    // Reabrir a coqueluche (encerrada como descartada): conclusão some, o critério volta ao de antes.
    const re = (await t.http().post(`/api/vigilancia/notificacoes/${ids.coq}/reabrir`).set(auth(vig)).send({ reason: 'Novo resultado do LACEN.' }).expect(200)).body;
    expect(re.encerramento).toMatchObject({ classificacao: null, criterio: null, evolucao: null, investigadaEm: null, encerradaEm: null });
    expect(re.criterio).toBe('SUSPEITA');
    const esp = (await t.http().get(`/api/vigilancia/notificacoes/${ids.coq}/espelho`).set(auth(vig)).expect(200)).body;
    expect(esp.linhas.find((l: { variavel: string }) => l.variavel === 'CLASSI_FIN').exportado).toBe('');
    const ruim = (
      await t.http().post(`/api/vigilancia/notificacoes/${ids.coq}/encerrar`).set(auth(vig)).send({ investigadaEm: hoje(), classificacao: '2', evolucao: '1', obitoEm: hoje(), encerradaEm: hoje() }).expect(400)
    ).body;
    expect(ruim.message).toContain('campo 42');
  });

  it('resultado positivo depois do encerramento sem confirmação fica registrado e aparece no painel', async () => {
    const p = await novoPaciente('Paulo Positivo Tarde Saida', 'M', '1971-01-01');
    const enc = await abrir(p);
    const [den] = await assinar(enc, 'A90');
    await confirmar(den!.id);
    await t.http().post(`/api/vigilancia/notificacoes/${den!.id}/encerrar`).set(auth(vig)).send({ investigadaEm: hoje(), classificacao: '2', criterio: '1', encerradaEm: hoje() }).expect(200);
    const [ex] = (
      await t
        .http()
        .post(`/api/clinical/encounters/${enc}/exams`)
        .set(auth(medica))
        .send({ items: [{ sigtapCode: '0202031144', name: 'Dengue IgM' }] })
        .expect(201)
    ).body;
    const r = (await t.http().post(`/api/clinical/exams/${ex.id}/result`).set(auth(medica)).send({ examKey: 'dengue-igm', qualitative: 'REAGENTE' }).expect(200)).body;
    expect(r.notificacoes).toEqual([expect.objectContaining({ id: den!.id, efeito: 'ENCERRADA' })]);
    expect((await detalhe(den!.id)).eventos.map((e: { tipo: string }) => e.tipo)).toContain('RESULTADO_APOS_FECHAMENTO');
    const painel = (await t.http().get('/api/vigilancia/painel').set(auth(vig)).expect(200)).body;
    expect(painel.cartoes.positivoAposFechamento).toBeGreaterThanOrEqual(1);
    // A tarefa periódica que reprocessa falhas não repete o registro do mesmo exame.
    const svc = t.app.get(NotificacaoService) as unknown as { resultadoPositivo: (...a: unknown[]) => Promise<unknown[]> };
    const medicaUser = await db.user.findFirstOrThrow({ where: { cpf: completeCpf('100000003') } });
    const exame = await db.examRequest.findUniqueOrThrow({ where: { id: ex.id } });
    const autor = { userId: medicaUser.id, role: 'MEDICO', cbo: null, unitId: (await db.encounter.findUniqueOrThrow({ where: { id: enc } })).unitId };
    expect(await svc.resultadoPositivo(await sys(), { id: ex.id, patientId: p, encounterId: enc, examKey: 'dengue-igm', resultAt: exame.resultAt }, autor, 'VARREDURA')).toEqual([]);
    expect(await db.notificationEvent.count({ where: { notificationId: den!.id, kind: 'RESULTADO_APOS_FECHAMENTO' } })).toBe(1);
  });

  it('exportação: texto que vira fórmula na planilha sai neutralizado, cabeçalho fixo com DT_CONCLU e cada sigilosa auditada', async () => {
    await t
      .http()
      .patch(`/api/vigilancia/notificacoes/${ids.dengue}`)
      .set(auth(vig))
      .send({ ficha: { NM_REFEREN: '=HYPERLINK("http://x")' } })
      .expect(200);
    const antes = await db.auditEntry.count({ where: { action: 'notificacao.exportar_sensivel' } });
    const res = await t
      .http()
      .get(`/api/vigilancia/exportacao.csv?de=${hoje()}&ate=${hoje()}`)
      .set(auth(vig))
      .buffer(true)
      .parse((r, cb) => {
        let d = '';
        r.on('data', (c: Buffer) => (d += c.toString('utf8')));
        r.on('end', () => cb(null, d));
      });
    expect(res.status).toBe(200);
    const texto = String(res.body).replace(/^﻿/, '');
    const [cab, ...linhas] = texto.split('\r\n');
    expect(cab).toContain(';DT_ENCERRA;DT_CONCLU;');
    expect(linhas.every((l) => l.split(';').length >= cab!.split(';').length)).toBe(true);
    expect(texto).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(texto).not.toMatch(/(^|;)=HYPERLINK/m);
    // Sem filtro de situação, os lembretes de DNV/DO (sem ficha) ficam de fora.
    expect(texto).not.toContain(ids.lembrete!);
    expect(await db.auditEntry.count({ where: { action: 'notificacao.exportar_sensivel' } })).toBeGreaterThan(antes);
  });

  it('notificação confirmada antes da saída para os sistemas oficiais entra na fila pela rota da data', async () => {
    const leg = await notificarComCid('Lucas Legado Saida', 'M', '1972-02-02', 'A90');
    await confirmar(leg.id);
    // Simula o dado da semana 23: confirmada sem sistema oficial.
    await db.notification.update({ where: { id: leg.id }, data: { officialSystem: null, entryStatus: null } });
    const catalogo = t.app.get(CatalogoVigilanciaService) as unknown as { filaRetroativa: (s: unknown) => Promise<void> };
    await catalogo.filaRetroativa(await sys());
    expect(await db.notification.findUniqueOrThrow({ where: { id: leg.id } })).toMatchObject({ officialSystem: 'SINAN_ONLINE', entryStatus: 'PENDENTE' });
  });
});
