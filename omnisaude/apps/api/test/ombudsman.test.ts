import { createHmac } from 'node:crypto';
import { cnsFromBase, completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantsService } from '../src/core/database';
import { RndsService } from '../src/modules/integrations/rnds.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();
const APP_SECRET = 'segredo-ouvidoria';

describe.runIf(enabled)('Ouvidoria, pesquisa de satisfação e Meu SUS Digital (CID-3/CID-4)', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let recepcao: string;
  let gestora: string;
  let medica: string;
  let pacienteId = '';
  let cpf = '';
  let cidadao = '';
  let unitId = '';
  let manifestacaoId = '';
  const birthDate = '1968-09-09';
  const FONE = '5563977770901';
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const address = { cep: '77405070', street: 'Rua da Ouvidoria', number: '10', district: 'Centro', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };
  let seq = 0;
  const webhook = (from: string, message: Record<string, unknown>) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1' }, messages: [{ from, id: `wamid.o${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] } },
        ],
      },
    ],
  });
  const postWebhook = async (from: string, message: Record<string, unknown>) => {
    const raw = JSON.stringify(webhook(from, message));
    const sig = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
    await t.http().post(`/api/webhooks/whatsapp/${t.slug}`).set('content-type', 'application/json').set('x-hub-signature-256', sig).send(raw).expect(200);
    await new Promise((r) => setTimeout(r, 50));
  };
  const ultimaParaFone = () => mocks.state.whatsapp.filter((m) => m.to === FONE).at(-1)!;
  const textoDe = (m: { payload: Record<string, unknown> }) => ((m.payload.text as { body?: string })?.body ?? (m.payload.interactive as { body?: { text?: string } })?.body?.text ?? '') as string;

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('ouvidoria', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws`, WHATSAPP_APP_SECRET: APP_SECRET, RNDS_REQUESTER_CPF: '52998224725' });
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    gestora = await t.login('gestora', 'UBS Centro', 'GESTOR');
    medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    cpf = completeCpf('479000901');
    pacienteId = (
      await t
        .http()
        .post('/api/patients')
        .set(auth(recepcao))
        .send({ name: 'Olinda Ouvidoria Teste', birthDate, sex: 'F', cpf, cns: cnsFromBase('27900000901'), motherName: 'Mae Olinda Teste', phone: '(63) 97777-0901', whatsappOptIn: true, address })
        .expect(201)
    ).body.id;
    unitId = (await t.http().get('/api/auth/me').set(auth(recepcao)).expect(200)).body.context.unitId;
    const cod = (await t.http().post('/api/cidadao/codigos').set(auth(recepcao)).send({ patientId: pacienteId }).expect(201)).body.codigo;
    cidadao = (await t.http().post('/api/cidadao/acesso/confirmar').send({ tenant: t.slug, cpf, birthDate, codigo: cod }).expect(200)).body.token;
  });

  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('recepção registra manifestação presencial com protocolo e prazo de 30 dias; médica não acessa', async () => {
    const m = (
      await t
        .http()
        .post('/api/ouvidoria/manifestacoes')
        .set(auth(recepcao))
        .send({ kind: 'RECLAMACAO', channel: 'PRESENCIAL', subject: 'TEMPO_ESPERA', text: 'Esperei mais de quatro horas na recepção sem ser chamada e ninguém informou nada.', unitId, patientId: pacienteId })
        .expect(201)
    ).body;
    expect(m.protocolo).toMatch(/^OUV-\d{4}-\d{6}$/);
    expect(m).toMatchObject({ tipoLabel: 'Reclamação', canalLabel: 'Presencial', assuntoLabel: 'Tempo de espera', status: 'RECEBIDA', identificado: true, pessoa: { nome: 'Olinda Ouvidoria Teste' } });
    expect(Math.round((Date.parse(m.venceEm) - Date.parse(m.recebidaEm)) / 86_400_000)).toBe(30);
    expect(m.prazo.situacao).toBe('NO_PRAZO');
    manifestacaoId = m.id;
    await t.http().post('/api/ouvidoria/manifestacoes').set(auth(recepcao)).send({ kind: 'ELOGIO', channel: 'TELEFONE', subject: 'ASSUNTO_INVALIDO', text: 'Texto qualquer com tamanho suficiente.' }).expect(422);
    await t.http().get('/api/ouvidoria/manifestacoes').set(auth(medica)).expect(403);
    await t.http().post(`/api/ouvidoria/manifestacoes/${manifestacaoId}/responder`).set(auth(recepcao)).send({ text: 'Recepção não responde.' }).expect(403);
  });

  it('cidadão registra pelo app (anônima: a equipe não vê a identidade) e acompanha as suas', async () => {
    const anon = (
      await t
        .http()
        .post('/api/cidadao/ouvidoria')
        .set(auth(cidadao))
        .send({ kind: 'DENUNCIA', subject: 'CONDUTA_PROFISSIONAL', text: 'Fui destratada por um profissional na sala de curativos na última terça-feira.', unitId, anonymous: true })
        .expect(201)
    ).body;
    expect(anon).toMatchObject({ anonima: true, status: 'RECEBIDA', tipoLabel: 'Denúncia' });
    const lista = (await t.http().get('/api/ouvidoria/manifestacoes?status=ABERTAS').set(auth(gestora)).expect(200)).body as { id: string; identificado: boolean; pessoa: unknown }[];
    expect(lista.find((m) => m.id === anon.id)).toMatchObject({ identificado: false, pessoa: null });
    expect(lista.find((m) => m.id === manifestacaoId)).toMatchObject({ identificado: true });
    const minhas = (await t.http().get('/api/cidadao/ouvidoria').set(auth(cidadao)).expect(200)).body as { id: string }[];
    expect(minhas.map((m) => m.id)).toEqual(expect.arrayContaining([anon.id, manifestacaoId]));
    // Busca por nome não encontra manifestação anônima.
    const busca = (await t.http().get('/api/ouvidoria/manifestacoes?busca=Olinda').set(auth(gestora)).expect(200)).body as { id: string }[];
    expect(busca.map((m) => m.id)).toContain(manifestacaoId);
    expect(busca.map((m) => m.id)).not.toContain(anon.id);
  });

  it('gestora encaminha, prorroga uma única vez, responde (aviso por WhatsApp) e o cidadão avalia', async () => {
    const enc = (await t.http().post(`/api/ouvidoria/manifestacoes/${manifestacaoId}/encaminhar`).set(auth(gestora)).send({ unitId, notes: 'Verificar com a coordenação da recepção' }).expect(200)).body;
    expect(enc.status).toBe('EM_ANALISE');
    expect(enc.eventos.map((e: { tipo: string }) => e.tipo)).toEqual(['RECEBIDA', 'ENCAMINHADA']);
    const pror = (await t.http().post(`/api/ouvidoria/manifestacoes/${manifestacaoId}/prorrogar`).set(auth(gestora)).send({ reason: 'Aguardando apuração com a equipe do turno da tarde.' }).expect(200)).body;
    expect(pror).toMatchObject({ status: 'PRORROGADA', prorrogada: true });
    expect(Math.round((Date.parse(pror.venceEm) - Date.parse(pror.recebidaEm)) / 86_400_000)).toBe(60);
    await t.http().post(`/api/ouvidoria/manifestacoes/${manifestacaoId}/prorrogar`).set(auth(gestora)).send({ reason: 'Segunda tentativa não permitida pela lei.' }).expect(422);
    await t.http().post(`/api/ouvidoria/manifestacoes/${manifestacaoId}/encerrar`).set(auth(gestora)).send({}).expect(422);
    const resp = (
      await t
        .http()
        .post(`/api/ouvidoria/manifestacoes/${manifestacaoId}/responder`)
        .set(auth(gestora))
        .send({ text: 'Pedimos desculpas pela espera. Reorganizamos a chamada por classificação de risco e ampliamos a equipe da tarde.' })
        .expect(200)
    ).body;
    expect(resp).toMatchObject({ status: 'RESPONDIDA', resposta: { por: expect.any(String) } });
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    const db = await tenants.client(tenant.id);
    const avisos = await db.messageLog.findMany({ where: { refId: manifestacaoId } });
    expect(avisos.map((a) => (a.payload as { template: { name: string } }).template.name)).toEqual(['ouvidoria_resposta', 'ouvidoria_resposta']);
    expect((avisos.at(-1)!.payload as { template: { bodyParams: string[] } }).template.bodyParams[2]).toBe('respondida');
    const minha = (await t.http().get('/api/cidadao/ouvidoria').set(auth(cidadao)).expect(200)).body.find((m: { id: string }) => m.id === manifestacaoId);
    expect(minha).toMatchObject({ status: 'RESPONDIDA', podeAvaliar: true });
    expect(minha.resposta.texto).toContain('Pedimos desculpas');
    const avaliada = (await t.http().post(`/api/cidadao/ouvidoria/${manifestacaoId}/avaliar`).set(auth(cidadao)).send({ nota: 4, comentario: 'Resposta clara, obrigada.' }).expect(200)).body;
    expect(avaliada).toMatchObject({ status: 'ENCERRADA', avaliacao: 4, podeAvaliar: false });
    await t.http().post(`/api/cidadao/ouvidoria/${manifestacaoId}/avaliar`).set(auth(cidadao)).send({ nota: 5 }).expect(422);
    const painel = (await t.http().get('/api/ouvidoria/painel').set(auth(gestora)).expect(200)).body;
    expect(painel.abertas).toBeGreaterThanOrEqual(1);
    expect(painel.respondidas30d).toBe(1);
    expect(painel.respondidasNoPrazo30d).toBe(1);
    expect(painel.avaliacaoMedia).toBe(4);
  });

  it('pelo WhatsApp a reclamação vira manifestação com protocolo', async () => {
    await postWebhook(FONE, { type: 'text', text: { body: 'Quero fazer uma reclamação: o banheiro da unidade estava sujo e sem papel hoje de manhã.' } });
    const resposta = textoDe(ultimaParaFone());
    expect(resposta).toMatch(/Registrei sua reclamação na ouvidoria\. Protocolo OUV-\d{4}-\d{6}/);
    const lista = (await t.http().get('/api/ouvidoria/manifestacoes?kind=RECLAMACAO').set(auth(gestora)).expect(200)).body as { canal: string; assunto: string; pessoa: { nome: string } | null }[];
    expect(lista.find((m) => m.canal === 'WHATSAPP')).toMatchObject({ assunto: 'ESTRUTURA', pessoa: { nome: 'Olinda Ouvidoria Teste' } });
  });

  it('pesquisa de satisfação: criada ao encerrar o atendimento, respondida por botão com comentário e pelo app; painel por unidade', async () => {
    const enc = (await t.http().post('/api/reception/check-in').set(auth(recepcao)).send({ patientId: pacienteId, kind: 'AMBULATORIAL' }).expect(201)).body;
    await t.http().post(`/api/clinical/encounters/${enc.id}/start`).set(auth(medica)).expect(200);
    const note = (
      await t
        .http()
        .post(`/api/clinical/encounters/${enc.id}/notes`)
        .set(auth(medica))
        .send({
          kind: 'SOAP',
          subjective: 'Dor lombar há 3 dias.',
          objective: 'Sem sinais de alarme.',
          assessment: 'Lombalgia mecânica.',
          plan: 'Analgesia e orientação postural.',
          codes: [{ system: 'CID10', code: 'M545' }],
        })
        .expect(201)
    ).body;
    await t.http().post(`/api/clinical/notes/${note.id}/sign`).set(auth(medica)).expect(200);
    mocks.state.whatsapp.length = 0;
    await t.http().post(`/api/clinical/encounters/${enc.id}/close`).set(auth(medica)).send({ outcome: 'ALTA' }).expect(200);
    const pendentes = (await t.http().get('/api/cidadao/avaliacoes').set(auth(cidadao)).expect(200)).body as { id: string; status: string; unidade: string; profissional: string | null }[];
    expect(pendentes[0]).toMatchObject({ status: 'PENDENTE', unidade: 'UBS Centro', profissional: expect.any(String) });
    const surveyId = pendentes[0]!.id;
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    const db = await tenants.client(tenant.id);
    const log = await db.messageLog.findFirstOrThrow({ where: { refId: surveyId } });
    const tpl = (log.payload as { template: { name: string; buttons: { payload: string }[] } }).template;
    expect(tpl.name).toBe('pesquisa_satisfacao');
    expect(tpl.buttons.map((b) => b.payload)).toEqual([`ASSIST:SURVEY:${surveyId}_5`, `ASSIST:SURVEY:${surveyId}_3`, `ASSIST:SURVEY:${surveyId}_1`]);
    expect(log.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
    // Resposta pelo botão do WhatsApp (modelo de resposta rápida) e comentário na mensagem seguinte.
    await postWebhook(FONE, { type: 'button', button: { payload: `ASSIST:SURVEY:${surveyId}_5`, text: 'Ótimo' } });
    expect(textoDe(ultimaParaFone())).toContain('Obrigado pela avaliação (ótimo)');
    await postWebhook(FONE, { type: 'text', text: { body: 'A doutora explicou tudo com calma e fui atendida rápido.' } });
    expect(textoDe(ultimaParaFone())).toContain('comentário foi registrado');
    await postWebhook(FONE, { type: 'button', button: { payload: `ASSIST:SURVEY:${surveyId}_1`, text: 'Ruim' } });
    expect(textoDe(ultimaParaFone())).toContain('Já recebemos sua avaliação');
    const respondida = (await t.http().get('/api/cidadao/avaliacoes').set(auth(cidadao)).expect(200)).body[0];
    expect(respondida).toMatchObject({ status: 'RESPONDIDA', nota: 5, notaLabel: 'Ótimo', comentario: 'A doutora explicou tudo com calma e fui atendida rápido.' });
    await t.http().post(`/api/cidadao/avaliacoes/${surveyId}`).set(auth(cidadao)).send({ nota: 3 }).expect(422);
    // Segundo atendimento respondido pelo app com NPS.
    const enc2 = (await t.http().post('/api/reception/check-in').set(auth(recepcao)).send({ patientId: pacienteId, kind: 'AMBULATORIAL' }).expect(201)).body;
    await t.http().post(`/api/clinical/encounters/${enc2.id}/start`).set(auth(medica)).expect(200);
    const note2 = (
      await t
        .http()
        .post(`/api/clinical/encounters/${enc2.id}/notes`)
        .set(auth(medica))
        .send({ kind: 'SOAP', subjective: 'Retorno.', objective: 'Melhora.', assessment: 'Lombalgia em resolução.', plan: 'Alta.', codes: [{ system: 'CID10', code: 'M545' }] })
        .expect(201)
    ).body;
    await t.http().post(`/api/clinical/notes/${note2.id}/sign`).set(auth(medica)).expect(200);
    await t.http().post(`/api/clinical/encounters/${enc2.id}/close`).set(auth(medica)).send({ outcome: 'ALTA' }).expect(200);
    const pend2 = (await t.http().get('/api/cidadao/avaliacoes').set(auth(cidadao)).expect(200)).body.find((p: { status: string }) => p.status === 'PENDENTE');
    const depois = (await t.http().post(`/api/cidadao/avaliacoes/${pend2.id}`).set(auth(cidadao)).send({ nota: 4, recomendaria: 9, comentario: 'Boa unidade.' }).expect(200)).body;
    expect(depois.find((p: { id: string }) => p.id === pend2.id)).toMatchObject({ status: 'RESPONDIDA', nota: 4, recomendaria: 9 });
    const painel = (await t.http().get(`/api/ouvidoria/satisfacao?unitId=${unitId}`).set(auth(gestora)).expect(200)).body;
    expect(painel.geral).toMatchObject({ enviadas: 2, respondidas: 2, taxaResposta: 100, media: 4.5, nps: 100 });
    expect(painel.porCanal).toEqual({ whatsapp: 1, app: 1 });
    expect(painel.porUnidade[0]).toMatchObject({ unidade: 'UBS Centro', media: 4.5 });
    expect(painel.porProfissional[0]).toMatchObject({ respondidas: 2, media: 4.5 });
    expect(painel.comentarios).toHaveLength(2);
    const semGerir = (await t.http().get('/api/ouvidoria/satisfacao').set(auth(recepcao)).expect(200)).body;
    expect(semGerir.porProfissional).toEqual([]);
  });

  it('Meu SUS Digital: prontidão por CPF/CNS e registros enviados à RNDS por tipo', async () => {
    const antes = (await t.http().get('/api/cidadao/meu-sus-digital').set(auth(cidadao)).expect(200)).body;
    expect(antes.prontidao).toMatchObject({ cpf: true, cns: true, rndsAtiva: true, pronto: true, pendencias: [] });
    expect(antes.link).toContain('meususdigital');
    expect(antes.pendentes + antes.enviados.total).toBeGreaterThanOrEqual(2); // os dois atendimentos geraram RAC
    const tenants = t.app.get(TenantsService);
    const tenant = await tenants.resolve(t.slug);
    const db = await tenants.client(tenant.id);
    // O RAC espera um período de carência antes do envio (correções do registro): adianta o relógio.
    const resultado = await t.app.get(RndsService).dispatchDue({ tenant, db }, new Date(Date.now() + 3 * 86_400_000));
    const erros = await db.outboxMessage.findMany({ where: { kind: 'RNDS_RAC', status: { not: 'ENVIADO' } }, select: { status: true, lastError: true } });
    expect(erros, JSON.stringify(resultado)).toEqual([]);
    expect(resultado.sent).toBeGreaterThanOrEqual(1);
    const depois = (await t.http().get(`/api/patients/${pacienteId}/meu-sus-digital`).set(auth(recepcao)).expect(200)).body;
    expect(depois.enviados.atendimentos).toBeGreaterThanOrEqual(1);
    expect(depois.enviados.total).toBe(depois.enviados.atendimentos + depois.enviados.vacinas + depois.enviados.dispensacoes + depois.enviados.altas + depois.enviados.regulacao);
    expect(depois.ultimoEnvio).toBeTruthy();
    const semCpf = (
      await t.http().post('/api/patients').set(auth(recepcao)).send({ name: 'Sem Cpf Meu Sus Teste', birthDate: '1990-01-01', sex: 'M', motherName: 'Mae Sem Cpf Teste', address, confirmNotDuplicate: true }).expect(201)
    ).body;
    const pend = (await t.http().get(`/api/patients/${semCpf.id}/meu-sus-digital`).set(auth(recepcao)).expect(200)).body;
    expect(pend.prontidao.pronto).toBe(false);
    expect(pend.prontidao.pendencias[0]).toContain('CPF');
  });
});
