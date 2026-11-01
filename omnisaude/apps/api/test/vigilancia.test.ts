import { cnsFromBase, completeCpf, semanaEpidemiologica } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TenantsService } from '../src/core/database';
import { RealtimeService } from '../src/core/realtime.service';
import { AiService } from '../src/modules/integrations/ai.service';
import { CatalogoVigilanciaService } from '../src/modules/vigilancia/catalogo.service';
import { NotificacaoService } from '../src/modules/vigilancia/notificacao.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();
const H = 3_600_000;

type Criada = { id: string; numero: string; agravo: string; prazo: string; esferas: string[]; venceEm: string | null; sigiloso: boolean; naoHomologado: boolean };

describe.runIf(enabled)('Vigilância: notificação compulsória a partir do atendimento (VIG-1a)', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let recepcao = '';
  let medica = '';
  let cardio = '';
  let vig = '';
  let nucleo = '';
  let gestora = '';
  let nir = '';
  let db: Awaited<ReturnType<TenantsService['client']>>;
  let seq = 0;
  const ids: Record<string, string> = {};
  const pacientes: Record<string, string> = {};
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const address = { cep: '77405070', street: 'Rua da Vigilância', number: '23', district: 'Centro', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };

  const novoPaciente = async (name: string, sex: 'M' | 'F', birthDate: string) => {
    seq++;
    const body = { name, birthDate, sex, cpf: completeCpf(String(482000900 + seq)), cns: cnsFromBase(String(28200000900 + seq)), motherName: `Mae de ${name}`, phone: '(63) 97777-2300', address };
    return (await t.http().post('/api/patients').set(auth(recepcao)).send(body).expect(201)).body.id as string;
  };
  const tarefa = async () => {
    const tenants = t.app.get(TenantsService);
    tenants.connections.invalidate(t.slug);
    const tenant = await tenants.resolve(t.slug);
    return t.app.get(NotificacaoService).tarefa({ tenant, db: await tenants.client(tenant.id) });
  };
  const abrir = async (patientId: string, startedAt?: Date) => {
    const enc = (await t.http().post('/api/reception/check-in').set(auth(recepcao)).send({ patientId, kind: 'AMBULATORIAL' }).expect(201)).body;
    await t.http().post(`/api/clinical/encounters/${enc.id}/start`).set(auth(medica)).expect(200);
    if (startedAt) await db.encounter.update({ where: { id: enc.id }, data: { startedAt } });
    return enc.id as string;
  };
  const assinar = async (encId: string, codes: { system: 'CID10' | 'CIAP2'; code: string }[]) => {
    const note = (
      await t
        .http()
        .post(`/api/clinical/encounters/${encId}/notes`)
        .set(auth(medica))
        .send({ kind: 'SOAP', subjective: 'Queixa principal.', objective: 'Exame físico.', assessment: 'Hipótese diagnóstica.', plan: 'Conduta.', codes })
        .expect(201)
    ).body;
    const signed = (await t.http().post(`/api/clinical/notes/${note.id}/sign`).set(auth(medica)).expect(200)).body;
    return signed.notificacoes as Criada[];
  };
  const detalhe = async (id: string, tk = vig, status = 200) => (await t.http().get(`/api/vigilancia/notificacoes/${id}`).set(auth(tk)).expect(status)).body;

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('vigilancia', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws`, RNDS_REQUESTER_CPF: '52998224725' });
    t.app.get(AiService).client = null;
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    cardio = await t.login('cardiologista', 'Policlínica Municipal', 'MEDICO');
    vig = await t.login('vigilancia', 'Vigilância em Saúde', 'VIGILANCIA_EPIDEMIOLOGICA');
    nucleo = await t.login('nucleo', 'Hospital Municipal São Lucas', 'NUCLEO_VIGILANCIA');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    nir = await t.login('nir', 'Hospital Municipal São Lucas', 'NIR');
    const tenants = t.app.get(TenantsService);
    db = await tenants.client((await tenants.resolve(t.slug)).id);
  });

  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('catálogo: versões nacionais 11.211 (vigente) e 10.175 carregadas; retrato da data com 81 linhas', async () => {
    const versoes = (await t.http().get('/api/vigilancia/catalogo/versoes').set(auth(vig)).expect(200)).body as { ato: string; vigente: boolean; linhas: number; vigenteAte: string | null }[];
    const atual = versoes.find((v) => v.ato.includes('11.211'))!;
    expect(atual).toMatchObject({ vigente: true, linhas: 81, vigenteAte: null });
    expect(versoes.find((v) => v.ato.includes('10.175'))).toMatchObject({ vigente: false, linhas: 77, vigenteAte: '2026-05-13' });
    const r = (await t.http().get('/api/vigilancia/catalogo/vigente?data=2026-11-01').set(auth(medica)).expect(200)).body;
    expect(r.condicoes).toHaveLength(81);
    expect(r.versaoNacional.ato).toContain('11.211');
    const contatos = (await t.http().get('/api/vigilancia/contatos').set(auth(vig)).expect(200)).body as { label: string; phone: string }[];
    expect(contatos.find((c) => c.label.startsWith('CIEVS Nacional'))?.phone).toBe('0800-644-6645');
  });

  it('assinar registro com A37.9 abre um rascunho imediato (SES e SMS) que vence 24 h após o início do atendimento; não repete', async () => {
    pacientes.coq = await novoPaciente('Caio Coqueluche Teste', 'M', '2015-03-10');
    const encId = await abrir(pacientes.coq);
    const criadas = await assinar(encId, [{ system: 'CID10', code: 'A37.9' }]);
    expect(criadas).toHaveLength(1);
    expect(criadas[0]).toMatchObject({ prazo: 'IMEDIATA', sigiloso: false, naoHomologado: false, numero: expect.stringMatching(/^\d{4}\/\d{6}$/) });
    expect([...criadas[0]!.esferas].sort()).toEqual(['SES', 'SMS']);
    const enc = await db.encounter.findUniqueOrThrow({ where: { id: encId } });
    expect(Date.parse(criadas[0]!.venceEm!) - enc.startedAt.getTime()).toBe(24 * H);
    ids.coq = criadas[0]!.id;
    // Outro registro no mesmo atendimento com o mesmo agravo: idempotente.
    expect(await assinar(encId, [{ system: 'CID10', code: 'A37.9' }])).toHaveLength(0);
    expect(await db.notification.count({ where: { patientId: pacientes.coq } })).toBe(1);
    const d = await detalhe(ids.coq, medica);
    expect(d).toMatchObject({
      status: 'RASCUNHO',
      origem: 'ATENDIMENTO',
      agravo: { key: 'coqueluche', item: 8 },
      codigo: { sistema: 'CID10', codigo: 'A379' },
      prazo: { tipo: 'IMEDIATA', marco: 'ATENDIMENTO', aguardandoConfirmacao: false },
      ficha: { TP_NOT: '2', CS_SEXO: 'M', CS_GESTANT: '6', ID_MUNICIP: expect.any(String), ID_AGRAVO: { cid: 'A37.9' }, NM_PACIENT: 'Caio Coqueluche Teste' },
      permissoes: { confirmar: true, ciencia: false },
    });
    expect(d.paciente.nome).toBe('Caio Coqueluche Teste');
  });

  it('código não notificável não gera rascunho', async () => {
    const p = await novoPaciente('Lia Lombalgia Teste', 'F', '1980-01-01');
    const encId = await abrir(p);
    expect(await assinar(encId, [{ system: 'CID10', code: 'M54.5' }])).toEqual([]);
    expect(await db.notification.count({ where: { patientId: p } })).toBe(0);
  });

  it('falha no gatilho não bloqueia a assinatura: fica auditada e a varredura periódica recupera', async () => {
    const p = await novoPaciente('Rui Recuperacao Teste', 'M', '1990-06-06');
    const encId = await abrir(p);
    const spy = vi.spyOn(t.app.get(CatalogoVigilanciaService), 'retrato').mockRejectedValueOnce(new Error('falha simulada'));
    expect(await assinar(encId, [{ system: 'CID10', code: 'A37.9' }])).toEqual([]);
    spy.mockRestore();
    expect(await db.auditEntry.count({ where: { action: 'vigilancia.erro_gatilho', entityId: encId } })).toBe(1);
    expect(await db.notification.count({ where: { patientId: p } })).toBe(0);
    const r = await tarefa();
    expect(r.recuperadas).toBeGreaterThanOrEqual(1);
    const n = await db.notification.findFirstOrThrow({ where: { patientId: p } });
    expect(n).toMatchObject({ origin: 'VARREDURA', conditionKey: 'coqueluche', encounterId: encId });
    expect((await tarefa()).recuperadas).toBe(0);
  });

  it('A90 (de-para proposto) abre rascunho semanal: 7 dias do conhecimento, só SMS, aviso de mapeamento não homologado', async () => {
    pacientes.den = await novoPaciente('Davi Dengue Teste', 'M', '1975-02-02');
    const encId = await abrir(pacientes.den);
    ids.denEnc = encId;
    const [c] = await assinar(encId, [{ system: 'CID10', code: 'A90' }]);
    expect(c).toMatchObject({ prazo: 'SEMANAL', esferas: ['SMS'], naoHomologado: true });
    const n = await db.notification.findUniqueOrThrow({ where: { id: c!.id } });
    expect(n.dueAt!.getTime() - n.knownAt.getTime()).toBe(7 * 24 * H);
    expect(n.deadlineStart).toBe('CONHECIMENTO');
    ids.den = c!.id;
  });

  it('óbito no encerramento abre a notificação imediata do óbito por dengue ligada ao caso', async () => {
    const r = (await t.http().post(`/api/clinical/encounters/${ids.denEnc}/close`).set(auth(medica)).send({ outcome: 'OBITO', mainCid: 'A90' }).expect(200)).body;
    expect(r.notificacoes).toHaveLength(1);
    expect(r.notificacoes[0]).toMatchObject({ prazo: 'IMEDIATA' });
    expect([...r.notificacoes[0].esferas].sort()).toEqual(['MS', 'SES', 'SMS']);
    const n = await db.notification.findUniqueOrThrow({ where: { id: r.notificacoes[0].id } });
    expect(n).toMatchObject({ conditionKey: 'dengue-obito', origin: 'OBITO', relatedNotificationId: ids.den });
  });

  it('gestante com A93.0 recebe a linha de oropouche em gestante (imediata para MS, SES e SMS)', async () => {
    pacientes.oro = await novoPaciente('Olga Oropouche Teste', 'F', '1998-04-04');
    await db.patientCondition.create({ data: { patientId: pacientes.oro, system: 'CID10', code: 'Z34', description: 'Gestação', lineOfCare: 'GESTANTE', active: true } });
    const encId = await abrir(pacientes.oro);
    const [c] = await assinar(encId, [{ system: 'CID10', code: 'A93.0' }]);
    expect(c).toMatchObject({ prazo: 'IMEDIATA', naoHomologado: false });
    expect([...c!.esferas].sort()).toEqual(['MS', 'SES', 'SMS']);
    const d = await detalhe(c!.id, medica);
    expect(d.agravo).toMatchObject({ key: 'oropouche-gestante', contexto: 'GESTANTE' });
    expect(d.ficha.CS_GESTANT).toBe('4');
    expect(d.subitens.map((s: { key: string }) => s.key)).toEqual(expect.arrayContaining(['oropouche', 'oropouche-obito', 'oropouche-gestante']));
    ids.oro = c!.id;
  });

  it('atendimento de 10/05/2026 usa a lista da PRT 10.175/2026 (vigente na data)', async () => {
    pacientes.antiga = await novoPaciente('Ana Lista Antiga Teste', 'F', '1950-05-05');
    const encId = await abrir(pacientes.antiga, new Date('2026-05-10T13:00:00Z'));
    const [c] = await assinar(encId, [{ system: 'CID10', code: 'A37.9' }]);
    const n = await db.notification.findUniqueOrThrow({ where: { id: c!.id }, include: { condition: { include: { version: true } } } });
    expect(n.condition.version.nationalId).toBe('PRT-GM-MS-10175-2026');
    expect(n.dueAt!.toISOString()).toBe('2026-05-11T13:00:00.000Z');
    const d = await detalhe(c!.id);
    expect(d.prazo.porEsfera.find((e: { esfera: string }) => e.esfera === 'SMS').situacao).toBe('VENCIDO');
    ids.antiga = c!.id;
  });

  it('item 60 (covid-19 confirmada): notificação manual aguarda a confirmação; o prazo conta da data de confirmação', async () => {
    const p = await novoPaciente('Caco Covid Teste', 'M', '1985-08-08');
    const d = (await t.http().post('/api/vigilancia/notificacoes').set(auth(medica)).send({ patientId: p, conditionKey: 'sg-covid-confirmada' }).expect(201)).body;
    expect(d).toMatchObject({ origem: 'MANUAL', criterio: 'SUSPEITA', prazo: { aguardandoConfirmacao: true, venceEm: null, marco: 'CONFIRMACAO' } });
    const confirmada = new Date(Date.now() - 2 * H);
    const e = (await t.http().patch(`/api/vigilancia/notificacoes/${d.id}`).set(auth(medica)).send({ basis: 'CONFIRMADO', confirmedAt: confirmada.toISOString() }).expect(200)).body;
    expect(e).toMatchObject({ criterio: 'CONFIRMADO', prazo: { aguardandoConfirmacao: false } });
    expect(Date.parse(e.prazo.venceEm) - confirmada.getTime()).toBe(24 * H);
    // U07.1 já indica covid-19 confirmada: o gatilho conta o prazo da própria assinatura.
    const p2 = await novoPaciente('Cida Covid Teste', 'F', '1950-09-09');
    const [c] = await assinar(await abrir(p2), [{ system: 'CID10', code: 'U07.1' }]);
    const n = await db.notification.findUniqueOrThrow({ where: { id: c!.id } });
    expect(n).toMatchObject({ conditionKey: 'sg-covid-confirmada', basis: 'CONFIRMADO', deadlineStart: 'CONFIRMACAO' });
    expect(n.dueAt).not.toBeNull();
  });

  it('validações: datas futuras, agravo fora da lista e campo 12 (gestante) obrigatório para mulher em idade fértil', async () => {
    const p = await novoPaciente('Vera Leishmaniose Teste', 'F', '1996-10-10');
    await t
      .http()
      .post('/api/vigilancia/notificacoes')
      .set(auth(medica))
      .send({ patientId: p, conditionKey: 'leishmaniose-visceral', knownAt: new Date(Date.now() + 48 * H).toISOString() })
      .expect(400);
    await t.http().post('/api/vigilancia/notificacoes').set(auth(medica)).send({ patientId: p, conditionKey: 'agravo-inexistente' }).expect(400);
    const d = (await t.http().post('/api/vigilancia/notificacoes').set(auth(medica)).send({ patientId: p, conditionKey: 'leishmaniose-visceral' }).expect(201)).body;
    expect(d.prazo).toMatchObject({ tipo: 'SEMANAL', esferas: ['SMS'] });
    await t.http().patch(`/api/vigilancia/notificacoes/${d.id}`).set(auth(medica)).send({ symptomsOnset: '2099-01-01' }).expect(400);
    await t.http().patch(`/api/vigilancia/notificacoes/${d.id}`).set(auth(medica)).send({ conditionKey: 'coqueluche' }).expect(400);
    const erro = (await t.http().post(`/api/vigilancia/notificacoes/${d.id}/confirmar`).set(auth(medica)).expect(400)).body;
    expect(erro.message).toContain('campo 12');
    await t
      .http()
      .patch(`/api/vigilancia/notificacoes/${d.id}`)
      .set(auth(medica))
      .send({ ficha: { CS_GESTANT: '5' } })
      .expect(200);
    const ok = (await t.http().post(`/api/vigilancia/notificacoes/${d.id}/confirmar`).set(auth(medica)).expect(200)).body;
    expect(ok).toMatchObject({ status: 'NOTIFICADA', datas: { semanaNotificacao: semanaEpidemiologica(new Date(), 'America/Sao_Paulo').codigo } });
    // Semanal: confirmada já cumpre o prazo perante a SMS.
    expect(ok.prazo.porEsfera).toEqual([expect.objectContaining({ esfera: 'SMS', situacao: 'CUMPRIDO' })]);
  });

  it('confirmação, ciência da vigilância municipal e repasse à SES em 24 h com registro da comunicação', async () => {
    const c = (await t.http().post(`/api/vigilancia/notificacoes/${ids.coq}/confirmar`).set(auth(medica)).expect(200)).body;
    expect(c.status).toBe('NOTIFICADA');
    expect(c.comunicacoes).toEqual([expect.objectContaining({ esfera: 'SMS', meio: 'SISTEMA' })]);
    // Imediata: a comunicação pelo painel não cumpre sozinha; falta a ciência (ou contato pelo meio mais rápido).
    expect(c.prazo.porEsfera.find((e: { esfera: string }) => e.esfera === 'SMS').situacao).not.toBe('CUMPRIDO');
    await t.http().post(`/api/vigilancia/notificacoes/${ids.coq}/confirmar`).set(auth(medica)).expect(422);
    const painel = (await t.http().get('/api/vigilancia/painel').set(auth(vig)).expect(200)).body;
    expect(painel.cartoes.imediatasAguardandoCiencia).toBeGreaterThanOrEqual(1);
    expect(painel.notificacoes.find((n: { id: string }) => n.id === ids.coq)).toMatchObject({ status: 'NOTIFICADA', ciencia: false, prazo: 'IMEDIATA' });
    await t.http().post(`/api/vigilancia/notificacoes/${ids.coq}/ciencia`).set(auth(medica)).expect(403);
    const ci = (await t.http().post(`/api/vigilancia/notificacoes/${ids.coq}/ciencia`).set(auth(vig)).expect(200)).body;
    const sms = ci.prazo.porEsfera.find((e: { esfera: string }) => e.esfera === 'SMS');
    const ses = ci.prazo.porEsfera.find((e: { esfera: string }) => e.esfera === 'SES');
    expect(sms.situacao).toBe('CUMPRIDO');
    expect(Date.parse(ses.venceEm) - Date.parse(ci.ciencia.em)).toBe(24 * H);
    expect(ses.situacao).toBe('NO_PRAZO');
    await t.http().post(`/api/vigilancia/notificacoes/${ids.coq}/ciencia`).set(auth(vig)).expect(422);
    await t
      .http()
      .post(`/api/vigilancia/notificacoes/${ids.coq}/comunicacoes`)
      .set(auth(vig))
      .send({ target: 'SES', channel: 'TELEFONE', communicatedAt: new Date(Date.now() + 3 * H).toISOString(), counterpartName: 'Plantão CIEVS TO' })
      .expect(400);
    const com = (
      await t
        .http()
        .post(`/api/vigilancia/notificacoes/${ids.coq}/comunicacoes`)
        .set(auth(vig))
        .send({ target: 'SES', channel: 'TELEFONE', communicatedAt: new Date().toISOString(), counterpartName: 'Plantão CIEVS TO', contactValue: '(63) 3218-0000', protocol: 'CIEVS-123' })
        .expect(201)
    ).body;
    expect(com.prazo.porEsfera.find((e: { esfera: string }) => e.esfera === 'SES').situacao).toBe('CUMPRIDO');
    expect(com.eventos.map((e: { tipo: string }) => e.tipo)).toEqual(['GERADA_PELO_GATILHO', 'CONFIRMADA', 'CIENCIA_SMS', 'COMUNICACAO']);
  });

  it('tarefa periódica: escalona ao plantão por WhatsApp sem dado do paciente e marca prazo vencido', async () => {
    await t.http().post(`/api/vigilancia/notificacoes/${ids.oro}/confirmar`).set(auth(medica)).expect(200);
    await db.notification.update({ where: { id: ids.oro }, data: { notifiedAt: new Date(Date.now() - 2 * H) } });
    await t.http().patch('/api/vigilancia/configuracoes').set(auth(medica)).send({ whatsappAlerts: true }).expect(403);
    await t
      .http()
      .patch('/api/vigilancia/configuracoes')
      .set(auth(vig))
      .send({ onCallPhones: ['123'] })
      .expect(400);
    const cfg = (
      await t
        .http()
        .patch('/api/vigilancia/configuracoes')
        .set(auth(vig))
        .send({ ackMinutes: 30, onCallPhones: ['(63) 98888-2301'], whatsappAlerts: true })
        .expect(200)
    ).body;
    expect(cfg).toMatchObject({ ackMinutes: 30, onCallPhones: ['5563988882301'], whatsappAlerts: true });
    mocks.state.whatsapp.length = 0;
    const r = await tarefa();
    expect(r.escaladas).toBe(1);
    expect(r.vencidas).toBeGreaterThanOrEqual(1);
    const oro = await db.notification.findUniqueOrThrow({ where: { id: ids.oro } });
    expect(oro.escalatedAt).not.toBeNull();
    const logs = await db.messageLog.findMany({ where: { phone: '5563988882301' } });
    expect(logs).toHaveLength(1);
    const tpl = (logs[0]!.payload as { template: { name: string; bodyParams: string[] } }).template;
    expect(tpl.name).toBe('vigilancia_alerta');
    expect(tpl.bodyParams[0]).toBe(oro.number);
    expect(tpl.bodyParams[2]).toBe('UBS Centro');
    const texto = JSON.stringify(logs[0]!.payload) + JSON.stringify(mocks.state.whatsapp);
    expect(texto).not.toContain('Olga');
    expect(texto).not.toContain('Rua da Vigilância');
    expect(mocks.state.whatsapp.some((m) => m.to === '5563988882301')).toBe(true);
    const antiga = await db.notification.findUniqueOrThrow({ where: { id: ids.antiga }, include: { events: true } });
    expect(antiga.overdueAt).not.toBeNull();
    expect(antiga.events.map((e) => e.kind)).toContain('PRAZO_VENCIDO');
    // Rodar de novo não repete o alerta nem o vencimento.
    expect(await tarefa()).toMatchObject({ escaladas: 0, vencidas: 0 });
  });

  it('internação: o CID da admissão abre o rascunho com prazo contado do conhecimento; núcleo do hospital vê só a sua unidade', async () => {
    const p = await novoPaciente('Ivo Internacao Teste', 'M', '1970-07-07');
    const leito = await db.bed.findFirstOrThrow({ where: { status: 'VAGO', ward: { unit: { name: 'Hospital Municipal São Lucas' }, kind: 'CLINICA_MEDICA' } }, orderBy: { code: 'asc' } });
    const adm = (await t.http().post('/api/admissions').set(auth(nir)).send({ patientId: p, bedId: leito.id, mainCid: 'A379' }).expect(201)).body;
    expect(adm.notificacoes).toHaveLength(1);
    const n = await db.notification.findUniqueOrThrow({ where: { id: adm.notificacoes[0].id }, include: { unit: true } });
    expect(n).toMatchObject({ origin: 'INTERNACAO', deadlineStart: 'CONHECIMENTO', notifierRole: 'NIR' });
    expect(n.unit.name).toBe('Hospital Municipal São Lucas');
    ids.int = n.id;
    const painel = (await t.http().get('/api/vigilancia/painel').set(auth(nucleo)).expect(200)).body;
    expect(painel.notificacoes.length).toBeGreaterThanOrEqual(1);
    expect(painel.notificacoes.every((x: { unidade: string }) => x.unidade === 'Hospital Municipal São Lucas')).toBe(true);
    await detalhe(ids.coq, nucleo, 403);
    await t.http().post(`/api/vigilancia/notificacoes/${ids.int}/confirmar`).set(auth(nucleo)).expect(200);
    await t
      .http()
      .post(`/api/vigilancia/notificacoes/${ids.int}/comunicacoes`)
      .set(auth(nucleo))
      .send({ target: 'SES', channel: 'TELEFONE', communicatedAt: new Date().toISOString(), counterpartName: 'CIEVS TO' })
      .expect(403);
    const sms = (
      await t
        .http()
        .post(`/api/vigilancia/notificacoes/${ids.int}/comunicacoes`)
        .set(auth(nucleo))
        .send({ target: 'SMS', channel: 'TELEFONE', communicatedAt: new Date().toISOString(), counterpartName: 'Plantão da vigilância municipal' })
        .expect(201)
    ).body;
    expect(sms.prazo.porEsfera.find((e: { esfera: string }) => e.esfera === 'SMS').situacao).toBe('CUMPRIDO');
  });

  it('sigilo: HIV só abre para o autor e a vigilância (leitura auditada); para outros aparece como agravo de acesso restrito', async () => {
    pacientes.hiv = await novoPaciente('Hugo Sigilo Teste', 'M', '1988-11-11');
    const [c] = await assinar(await abrir(pacientes.hiv), [{ system: 'CID10', code: 'Z21' }]);
    expect(c).toMatchObject({ sigiloso: true, prazo: 'SEMANAL' });
    await detalhe(c!.id, medica, 200);
    await detalhe(c!.id, cardio, 403);
    await detalhe(c!.id, nucleo, 403);
    const lista = (await t.http().get(`/api/vigilancia/pacientes/${pacientes.hiv}/notificacoes`).set(auth(cardio)).expect(200)).body;
    expect(lista[0]).toMatchObject({ agravo: 'Agravo de acesso restrito', paciente: null, grupo: null, sigiloso: true });
    const antes = await db.auditEntry.count({ where: { action: 'notificacao.ler_sensivel', entityId: c!.id } });
    const d = await detalhe(c!.id, vig, 200);
    expect(d.agravo.key).toBe('hiv');
    expect(await db.auditEntry.count({ where: { action: 'notificacao.ler_sensivel', entityId: c!.id } })).toBe(antes + 1);
    const painel = (await t.http().get('/api/vigilancia/painel').set(auth(vig)).expect(200)).body;
    expect(painel.notificacoes.find((x: { id: string }) => x.id === c!.id).agravo).not.toBe('Agravo de acesso restrito');
  });

  it('perfis: recepção não notifica nem vê o painel; gestão vê só contagens', async () => {
    await t.http().post('/api/vigilancia/notificacoes').set(auth(recepcao)).send({ patientId: pacientes.coq, conditionKey: 'varicela' }).expect(403);
    await t.http().get('/api/vigilancia/painel').set(auth(recepcao)).expect(403);
    await t.http().get('/api/vigilancia/painel').set(auth(gestora)).expect(403);
    await t.http().get(`/api/vigilancia/notificacoes/${ids.coq}`).set(auth(gestora)).expect(403);
    const r = (await t.http().get('/api/vigilancia/resumo').set(auth(gestora)).expect(200)).body;
    expect(Object.keys(r).sort()).toEqual(['imediatasNoPrazo', 'repassesPendentes', 'semana', 'vencidas']);
    expect(r.vencidas).toBeGreaterThanOrEqual(1);
    // Quem notifica vê as suas, não as dos outros.
    await detalhe(ids.int, medica, 403);
    const minhas = (await t.http().get('/api/vigilancia/notificacoes/minhas').set(auth(medica)).expect(200)).body as { id: string }[];
    expect(minhas.map((m) => m.id)).toEqual(expect.arrayContaining([ids.coq, ids.oro]));
    expect(minhas.map((m) => m.id)).not.toContain(ids.int);
  });

  it('descarte: imediata só pela vigilância municipal; semanal pelo autor; a varredura não recria o descartado', async () => {
    await t.http().post(`/api/vigilancia/notificacoes/${ids.antiga}/descartar`).set(auth(medica)).send({ reason: 'Caso descartado após reavaliação clínica.' }).expect(403);
    await t.http().post(`/api/vigilancia/notificacoes/${ids.antiga}/descartar`).set(auth(vig)).send({ reason: 'curto' }).expect(400);
    const d = (await t.http().post(`/api/vigilancia/notificacoes/${ids.antiga}/descartar`).set(auth(vig)).send({ reason: 'Teste de descarte pela vigilância municipal.' }).expect(200)).body;
    expect(d).toMatchObject({ status: 'DESCARTADA', descarte: { motivo: 'Teste de descarte pela vigilância municipal.' } });
    const den = (await t.http().post(`/api/vigilancia/notificacoes/${ids.den}/descartar`).set(auth(medica)).send({ reason: 'Sorologia negativa, caso descartado.' }).expect(200)).body;
    expect(den.status).toBe('DESCARTADA');
    await t.http().post(`/api/vigilancia/notificacoes/${ids.den}/descartar`).set(auth(medica)).send({ reason: 'Sorologia negativa, caso descartado.' }).expect(422);
    await tarefa();
    expect(await db.notification.count({ where: { patientId: pacientes.den, conditionKey: 'dengue' } })).toBe(1);
    expect(await db.notification.count({ where: { patientId: pacientes.antiga } })).toBe(1);
    const descartes = (await t.http().get('/api/vigilancia/descartes').set(auth(vig)).expect(200)).body as { id: string; motivo: string }[];
    expect(descartes.map((x) => x.id)).toEqual(expect.arrayContaining([ids.antiga, ids.den]));
  });

  it('ESAVI a partir da vacina: notificação imediata ligada à dose aplicada', async () => {
    const pv = await novoPaciente('Vitor Vacina Teste', 'M', '2025-01-15');
    const ubs = await db.unit.findFirstOrThrow({ where: { name: 'UBS Centro' } });
    const prof = await db.user.findFirstOrThrow({ where: { assignments: { some: { unitId: ubs.id, role: 'ENFERMAGEM' } } } });
    const vac = await db.vaccination.create({
      data: {
        patientId: pv,
        unitId: ubs.id,
        professionalId: prof.id,
        vaccineCode: '22',
        vaccineName: 'Pentavalente',
        lot: 'LOTE-T1',
        manufacturer: 'Fabricante teste',
        dose: 'D1',
        route: 'IM',
        appliedAt: new Date(Date.now() - 6 * H),
      },
    });
    const d = (await t.http().post('/api/vigilancia/notificacoes').set(auth(medica)).send({ patientId: vac.patientId, conditionKey: 'esavi', vaccinationId: vac.id }).expect(201)).body;
    expect(d).toMatchObject({ origem: 'VACINA', agravo: { key: 'esavi' }, prazo: { tipo: 'IMEDIATA' } });
    expect([...d.prazo.esferas].sort()).toEqual(['MS', 'SES', 'SMS']);
    const outro = await novoPaciente('Paulo Outra Vacina Teste', 'M', '2000-01-01');
    await t.http().post('/api/vigilancia/notificacoes').set(auth(medica)).send({ patientId: outro, conditionKey: 'esavi', vaccinationId: vac.id }).expect(404);
  });

  it('de-para e versão municipal: homologar o código tira o aviso; versão local sobreposta é recusada', async () => {
    await t.http().post('/api/vigilancia/codigos').set(auth(medica)).send({ system: 'CID10', codePrefix: 'A90', groupKey: 'dengue', source: 'teste' }).expect(403);
    const propostos = (await t.http().get('/api/vigilancia/codigos?status=PROPOSTO&busca=A90').set(auth(vig)).expect(200)).body as { id: string; codePrefix: string }[];
    const a90 = propostos.find((m) => m.codePrefix === 'A90')!;
    expect(
      (
        await t
          .http()
          .post('/api/vigilancia/codigos/homologar')
          .set(auth(vig))
          .send({ ids: [a90.id] })
          .expect(200)
      ).body,
    ).toEqual({ homologados: 1 });
    const p = await novoPaciente('Duda Dengue Homologada Teste', 'M', '1999-03-03');
    const [c] = await assinar(await abrir(p), [{ system: 'CID10', code: 'A90' }]);
    expect(c!.naoHomologado).toBe(false);
    const nova = {
      scope: 'MUNICIPAL',
      act: 'Portaria SMS nº 1/2026 (teste)',
      validFrom: '2026-10-01',
      conditions: [{ key: 'toxoplasmose-adquirida', item: 101, name: 'Toxoplasmose adquirida (lista municipal)', immediateMs: false, immediateSes: false, immediateSms: false, weekly: true }],
    };
    await t
      .http()
      .post('/api/vigilancia/catalogo/versoes')
      .set(auth(vig))
      .send({ ...nova, conditions: [{ ...nova.conditions[0], immediateSms: true }] })
      .expect(400);
    const v = (await t.http().post('/api/vigilancia/catalogo/versoes').set(auth(vig)).send(nova).expect(201)).body;
    expect(v).toMatchObject({ escopo: 'MUNICIPAL', vigente: true, linhas: 1 });
    await t
      .http()
      .post('/api/vigilancia/catalogo/versoes')
      .set(auth(vig))
      .send({ ...nova, validFrom: '2026-10-15' })
      .expect(409);
    const r = (await t.http().get('/api/vigilancia/catalogo/vigente').set(auth(medica)).expect(200)).body;
    expect(r.condicoes).toHaveLength(82);
    const m = (await t.http().post('/api/vigilancia/notificacoes').set(auth(medica)).send({ patientId: p, conditionKey: 'toxoplasmose-adquirida' }).expect(201)).body;
    expect(m.prazo).toMatchObject({ tipo: 'SEMANAL', esferas: ['SMS'] });
  });

  // ───────────── correções da revisão da semana 23 ─────────────

  it('editar a ficha de quem está internado mantém o prazo contado do conhecimento', async () => {
    const p = await novoPaciente('Irene Internada Teste', 'F', '1993-01-01');
    const leito = await db.bed.findFirstOrThrow({ where: { status: 'VAGO', ward: { unit: { name: 'Hospital Municipal São Lucas' }, kind: 'CLINICA_MEDICA' } }, orderBy: { code: 'asc' } });
    const adm = (await t.http().post('/api/admissions').set(auth(nir)).send({ patientId: p, bedId: leito.id, mainCid: 'R509' }).expect(201)).body;
    expect(adm.notificacoes).toEqual([]);
    // Internada há três dias; a suspeita aparece hoje numa evolução assinada no hospital.
    await db.encounter.update({ where: { id: adm.encounterId }, data: { startedAt: new Date(Date.now() - 72 * H) } });
    const medicaHosp = await t.login('medica', 'Hospital Municipal São Lucas', 'MEDICO');
    const nota = (
      await t
        .http()
        .post(`/api/clinical/encounters/${adm.encounterId}/notes`)
        .set(auth(medicaHosp))
        .send({ kind: 'SOAP', subjective: 'Tosse paroxística.', objective: 'Sem febre.', assessment: 'Suspeita de coqueluche.', plan: 'Isolamento e coleta.', codes: [{ system: 'CID10', code: 'A37.9' }] })
        .expect(201)
    ).body;
    const [c] = (await t.http().post(`/api/clinical/notes/${nota.id}/sign`).set(auth(medicaHosp)).expect(200)).body.notificacoes as Criada[];
    const n = await db.notification.findUniqueOrThrow({ where: { id: c!.id } });
    expect(n.deadlineStart).toBe('CONHECIMENTO');
    const antes = n.dueAt!.getTime();
    const e = (
      await t
        .http()
        .patch(`/api/vigilancia/notificacoes/${n.id}`)
        .set(auth(nucleo))
        .send({ ficha: { CS_GESTANT: '5' } })
        .expect(200)
    ).body;
    expect(e.prazo.marco).toBe('CONHECIMENTO');
    expect(Date.parse(e.prazo.venceEm)).toBe(antes);
    expect(e.prazo.porEsfera.find((x: { esfera: string }) => x.esfera === 'SMS').situacao).not.toBe('VENCIDO');
  });

  it('gestante com HIV abre também a linha da gestação; T63 é só peçonhento; agressão X99 é violência', async () => {
    const g = await novoPaciente('Gabi Gestante HIV Teste', 'F', '1999-02-02');
    await db.patientCondition.create({ data: { patientId: g, system: 'CID10', code: 'Z34', description: 'Gestação', lineOfCare: 'GESTANTE', active: true } });
    const hiv = await assinar(await abrir(g), [{ system: 'CID10', code: 'Z21' }]);
    const chaves = (await db.notification.findMany({ where: { id: { in: hiv.map((x) => x.id) } } })).map((x) => x.conditionKey).sort();
    expect(chaves).toEqual(['hiv', 'hiv-gestacao']);
    expect(hiv.every((x) => x.sigiloso)).toBe(true);
    const c = await novoPaciente('Caio Cobra Teste', 'M', '1980-03-03');
    const cobra = await assinar(await abrir(c), [{ system: 'CID10', code: 'T63.0' }]);
    expect((await db.notification.findMany({ where: { patientId: c } })).map((x) => x.conditionKey)).toEqual(['acidente-animal-peconhento']);
    expect(cobra).toHaveLength(1);
    const v = await novoPaciente('Vania Violencia Teste', 'F', '1985-04-04');
    const [viol] = await assinar(await abrir(v), [{ system: 'CID10', code: 'X99' }]);
    expect(viol).toMatchObject({ sigiloso: true });
    expect((await db.notification.findUniqueOrThrow({ where: { id: viol!.id } })).groupKey).toBe('violencia');
  });

  it('subitem: o autor não rebaixa imediata para semanal; trocar não duplica na varredura; o descartado não volta no mesmo atendimento', async () => {
    const p = await novoPaciente('Chico Chikungunya Teste', 'M', '1977-05-05');
    const encId = await abrir(p);
    const [c] = await assinar(encId, [{ system: 'CID10', code: 'A92.0' }]);
    expect(c).toMatchObject({ prazo: 'SEMANAL' });
    // Município sem transmissão: o autor passa para a linha imediata (mais rigorosa) e não pode voltar sozinho.
    const imediata = (await t.http().patch(`/api/vigilancia/notificacoes/${c!.id}`).set(auth(medica)).send({ conditionKey: 'chikungunya-sem-transmissao' }).expect(200)).body;
    expect(imediata.prazo.tipo).toBe('IMEDIATA');
    await t.http().patch(`/api/vigilancia/notificacoes/${c!.id}`).set(auth(medica)).send({ conditionKey: 'chikungunya' }).expect(403);
    await t.http().post(`/api/vigilancia/notificacoes/${c!.id}/descartar`).set(auth(medica)).send({ reason: 'Tentativa de descarte pelo autor.' }).expect(403);
    await tarefa();
    expect(await db.notification.count({ where: { patientId: p, groupKey: 'chikungunya' } })).toBe(1);
    await t.http().post(`/api/vigilancia/notificacoes/${c!.id}/descartar`).set(auth(vig)).send({ reason: 'Sorologia negativa para chikungunya.' }).expect(200);
    expect(await assinar(encId, [{ system: 'CID10', code: 'A92.0' }])).toEqual([]);
    await tarefa();
    expect(await db.notification.count({ where: { patientId: p, groupKey: 'chikungunya' } })).toBe(1);
  });

  it('repasse à SES conta da comunicação por telefone à SMS, mesmo sem ciência no painel', async () => {
    const p = await novoPaciente('Paula Repasse Teste', 'F', '1950-06-06');
    const [c] = await assinar(await abrir(p), [{ system: 'CID10', code: 'A37.9' }]);
    await t.http().post(`/api/vigilancia/notificacoes/${c!.id}/confirmar`).set(auth(medica)).expect(200);
    const ligou = new Date(Date.now() - 60 * 60_000);
    const d = (
      await t
        .http()
        .post(`/api/vigilancia/notificacoes/${c!.id}/comunicacoes`)
        .set(auth(vig))
        .send({ target: 'SMS', channel: 'TELEFONE', communicatedAt: ligou.toISOString(), counterpartName: 'Plantão da vigilância municipal' })
        .expect(201)
    ).body;
    const ses = d.prazo.porEsfera.find((e: { esfera: string }) => e.esfera === 'SES');
    expect(ses.situacao).toBe('NO_PRAZO');
    expect(Date.parse(ses.venceEm)).toBe(ligou.getTime() + 24 * H);
  });

  it('item 60 não é confirmado sem a data de confirmação; confirmações simultâneas valem uma vez', async () => {
    const p = await novoPaciente('Caco Confirma Teste', 'M', '1960-07-07');
    const d = (await t.http().post('/api/vigilancia/notificacoes').set(auth(medica)).send({ patientId: p, conditionKey: 'sg-covid-confirmada' }).expect(201)).body;
    const erro = (await t.http().post(`/api/vigilancia/notificacoes/${d.id}/confirmar`).set(auth(medica)).expect(400)).body;
    expect(erro.message).toContain('data de confirmação');
    const e = (
      await t
        .http()
        .patch(`/api/vigilancia/notificacoes/${d.id}`)
        .set(auth(medica))
        .send({ confirmedAt: new Date(Date.now() - H).toISOString() })
        .expect(200)
    ).body;
    expect(e.criterio).toBe('CONFIRMADO');
    const [a, b] = await Promise.all([t.http().post(`/api/vigilancia/notificacoes/${d.id}/confirmar`).set(auth(medica)), t.http().post(`/api/vigilancia/notificacoes/${d.id}/confirmar`).set(auth(medica))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db.notificationEvent.count({ where: { notificationId: d.id, kind: 'CONFIRMADA' } })).toBe(1);
    expect(await db.notificationCommunication.count({ where: { notificationId: d.id, channel: 'SISTEMA' } })).toBe(1);
  });

  it('falha do gatilho no encerramento é reprocessada a partir da auditoria', async () => {
    const p = await novoPaciente('Elias Encerramento Teste', 'M', '1966-08-08');
    const encId = await abrir(p);
    await assinar(encId, [{ system: 'CID10', code: 'R50.9' }]);
    const spy = vi.spyOn(t.app.get(CatalogoVigilanciaService), 'retrato').mockRejectedValueOnce(new Error('falha simulada no encerramento'));
    const r = (await t.http().post(`/api/clinical/encounters/${encId}/close`).set(auth(medica)).send({ outcome: 'ALTA', mainCid: 'A379' }).expect(200)).body;
    spy.mockRestore();
    expect(r.notificacoes).toEqual([]);
    expect(await db.notification.count({ where: { patientId: p } })).toBe(0);
    expect((await tarefa()).recuperadas).toBeGreaterThanOrEqual(1);
    expect(await db.notification.findFirstOrThrow({ where: { patientId: p } })).toMatchObject({ origin: 'VARREDURA', conditionKey: 'coqueluche', encounterId: encId });
    await tarefa();
    expect(await db.notification.count({ where: { patientId: p } })).toBe(1);
  });

  it('listas: a notificação sigilosa de acesso restrito não mostra prazo, origem nem unidade; listar sigilosas fica auditado; tempo real só leva o id', async () => {
    const lista = (await t.http().get(`/api/vigilancia/pacientes/${pacientes.hiv}/notificacoes`).set(auth(cardio)).expect(200)).body;
    expect(lista[0]).toMatchObject({ agravo: 'Agravo de acesso restrito', prazo: null, origem: null, unidade: null, situacaoSms: null, esferas: [], repasses: [], podeAbrir: false });
    const antes = await db.auditEntry.count({ where: { action: 'notificacao.listar_sensivel' } });
    await t.http().get('/api/vigilancia/painel').set(auth(vig)).expect(200);
    expect(await db.auditEntry.count({ where: { action: 'notificacao.listar_sensivel' } })).toBeGreaterThan(antes);
    const eventos = t.app.get(RealtimeService).recent.filter((e) => e.event.startsWith('vigilancia:'));
    expect(eventos.length).toBeGreaterThan(0);
    expect(eventos.every((e) => Object.keys(e.payload as object).join() === 'id')).toBe(true);
  });

  it('ESAVI: o prazo conta do conhecimento do evento, não da dose; a mesma dose não é notificada duas vezes', async () => {
    const p = await novoPaciente('Valter Vacina Antiga Teste', 'M', '2024-05-05');
    const encVac = await abrir(p, new Date(Date.now() - 10 * 24 * H));
    const ubs = await db.unit.findFirstOrThrow({ where: { name: 'UBS Centro' } });
    const prof = await db.user.findFirstOrThrow({ where: { assignments: { some: { unitId: ubs.id, role: 'ENFERMAGEM' } } } });
    const vac = await db.vaccination.create({
      data: {
        patientId: p,
        unitId: ubs.id,
        professionalId: prof.id,
        encounterId: encVac,
        vaccineCode: '22',
        vaccineName: 'Pentavalente',
        lot: 'LOTE-T2',
        manufacturer: 'Fabricante teste',
        dose: 'D2',
        route: 'IM',
        appliedAt: new Date(Date.now() - 10 * 24 * H),
      },
    });
    const d = (await t.http().post('/api/vigilancia/notificacoes').set(auth(medica)).send({ patientId: p, conditionKey: 'esavi', vaccinationId: vac.id }).expect(201)).body;
    expect(d.prazo.marco).toBe('CONHECIMENTO');
    expect(Date.parse(d.prazo.venceEm)).toBeGreaterThan(Date.now() + 23 * H);
    expect((await db.notification.findUniqueOrThrow({ where: { id: d.id } })).encounterId).toBeNull();
    const dup = (await t.http().post('/api/vigilancia/notificacoes').set(auth(medica)).send({ patientId: p, conditionKey: 'esavi', vaccinationId: vac.id }).expect(409)).body;
    expect(dup.message).toContain(d.numero);
  });

  it('lista local não substitui nem entra num grupo nacional; a curadoria nacional é sincronizada quando muda', async () => {
    const base = { scope: 'ESTADUAL', act: 'Portaria SES nº 9/2026 (teste)', validFrom: '2026-09-01' };
    const sifilis = (
      await t
        .http()
        .post('/api/vigilancia/catalogo/versoes')
        .set(auth(vig))
        .send({ ...base, conditions: [{ key: 'sifilis', item: 56, name: 'Sífilis (imediata no estado)', immediateMs: false, immediateSes: false, immediateSms: true, weekly: false }] })
        .expect(400)
    ).body;
    expect(sifilis.code).toBe('AGRAVO_NACIONAL');
    await t
      .http()
      .post('/api/vigilancia/catalogo/versoes')
      .set(auth(vig))
      .send({ ...base, conditions: [{ key: 'est-violencia-extra', groupKey: 'violencia', item: 99, name: 'Violência (linha estadual)', immediateMs: false, immediateSes: false, immediateSms: false, weekly: true }] })
      .expect(400);
    // Linha nacional alterada no banco (ou curadoria antiga): a próxima carga restaura a do código.
    const versao = await db.notifiableListVersion.findFirstOrThrow({ where: { nationalId: 'PRT-GM-MS-11211-2026' } });
    await db.notifiableCondition.updateMany({ where: { versionId: versao.id, key: 'caxumba' }, data: { weekly: false, immediateSms: true } });
    await db.notifiableListVersion.update({ where: { id: versao.id }, data: { contentHash: null } });
    t.app.get(CatalogoVigilanciaService).esquecer((await t.app.get(TenantsService).resolve(t.slug)).id);
    const r = (await t.http().get('/api/vigilancia/catalogo/vigente').set(auth(medica)).expect(200)).body;
    expect(r.condicoes.find((x: { key: string }) => x.key === 'caxumba')).toMatchObject({ weekly: true, immediateSms: false });
  });
});
