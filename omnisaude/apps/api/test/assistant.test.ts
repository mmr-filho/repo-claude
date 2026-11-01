import { createHmac } from 'node:crypto';
import { FakeLlmClient } from '@omnisaude/ai-engine';
import { cnsFromBase, completeCpf } from '@omnisaude/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiService } from '../src/modules/integrations/ai.service';
import { pgAvailable, startTestApp, type TestApp } from './harness';
import { startMocks } from './mocks';

const enabled = await pgAvailable();
const APP_SECRET = 'segredo-assistente';

describe.runIf(enabled)('Assistente do cidadão no WhatsApp (CID-2)', () => {
  let t: TestApp;
  let mocks: Awaited<ReturnType<typeof startMocks>>;
  let recepcao: string;
  let pacienteId = '';
  const FONE = '5563988880701';
  const auth = (tk: string) => ({ authorization: `Bearer ${tk}` });
  const address = { cep: '77405070', street: 'Rua do Assistente', number: '10', district: 'Centro', city: 'Gurupi', uf: 'TO', ibgeCode: '1709500' };
  let seq = 0;

  const webhook = (from: string, message: Record<string, unknown>) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '1' },
              contacts: [{ wa_id: from, profile: { name: 'Cidadão Teste' } }],
              messages: [{ from, id: `wamid.a${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
            },
          },
        ],
      },
    ],
  });
  const enviar = async (from: string, texto: string) => {
    const raw = JSON.stringify(webhook(from, { type: 'text', text: { body: texto } }));
    const sig = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
    await t.http().post(`/api/webhooks/whatsapp/${t.slug}`).set('content-type', 'application/json').set('x-hub-signature-256', sig).send(raw).expect(200);
    await new Promise((r) => setTimeout(r, 50));
  };
  const botao = async (from: string, id: string, title = 'botão') => {
    const raw = JSON.stringify(webhook(from, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } }));
    const sig = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
    await t.http().post(`/api/webhooks/whatsapp/${t.slug}`).set('content-type', 'application/json').set('x-hub-signature-256', sig).send(raw).expect(200);
    await new Promise((r) => setTimeout(r, 50));
  };
  const enviadas = () => mocks.state.whatsapp.filter((m) => m.to === FONE);
  const ultima = () => enviadas().at(-1)!;
  const textoDe = (m: { payload: Record<string, unknown> }) => ((m.payload.text as { body?: string })?.body ?? (m.payload.interactive as { body?: { text?: string } })?.body?.text ?? '') as string;
  const botoesDe = (m: { payload: Record<string, unknown> }) =>
    ((m.payload.interactive as { action?: { buttons?: { reply: { id: string; title: string } }[] } })?.action?.buttons ?? []).map((b) => b.reply) as { id: string; title: string }[];

  beforeAll(async () => {
    mocks = await startMocks();
    t = await startTestApp('assistente', { MOCKS_URL: mocks.url, CEP_API_URL: `${mocks.url}/ws`, WHATSAPP_APP_SECRET: APP_SECRET });
    recepcao = await t.login('recepcao', 'UBS Centro', 'RECEPCAO');
    pacienteId = (
      await t
        .http()
        .post('/api/patients')
        .set(auth(recepcao))
        .send({
          name: 'Antonia Assistente Teste',
          birthDate: '1972-03-03',
          sex: 'F',
          cpf: completeCpf('478000701'),
          cns: cnsFromBase('27800000701'),
          motherName: 'Mae Antonia Teste',
          phone: '(63) 98888-0701',
          whatsappOptIn: true,
          address,
        })
        .expect(201)
    ).body.id;
    mocks.state.whatsapp.length = 0;
  });

  afterAll(async () => {
    await t?.close();
    await mocks?.close();
  });

  it('número desconhecido: menu e orientação sem dados pessoais; unidades e triagem funcionam', async () => {
    await enviar('5563977770000', 'oi');
    expect(textoDe(mocks.state.whatsapp.at(-1)!)).toContain('Sou Vida');
    await enviar('5563977770000', 'quero ver minha agenda');
    expect(textoDe(mocks.state.whatsapp.at(-1)!)).toContain('Não encontrei um cadastro');
    await enviar('5563977770000', 'qual o horário da UBS Centro?');
    expect(textoDe(mocks.state.whatsapp.at(-1)!)).toContain('UBS Centro');
    await enviar('5563977770000', 'estou com dor no peito e falta de ar');
    const emergencia = textoDe(mocks.state.whatsapp.at(-1)!);
    expect(emergencia).toContain('192');
    expect(emergencia).toContain('UPA 24h Norte');
  });

  it('cidadão identificado pelo telefone: menu com nome, agenda vazia, marcação por botões e confirmação', async () => {
    await enviar(FONE, 'Bom dia');
    expect(textoDe(ultima())).toContain('Olá, Antonia! Sou Vida');
    await enviar(FONE, '1');
    expect(textoDe(ultima())).toContain('não tem consultas marcadas');
    await enviar(FONE, 'quero marcar uma consulta');
    const oferta = ultima();
    expect(oferta.type).toBe('interactive');
    expect(textoDe(oferta)).toContain('Horários livres na UBS Centro');
    const botoes = botoesDe(oferta);
    expect(botoes.length).toBeGreaterThanOrEqual(1);
    expect(botoes[0]!.id).toMatch(/^ASSIST:SLOT:[0-9a-f-]{36}_\d+$/);
    await botao(FONE, botoes[0]!.id, botoes[0]!.title);
    expect(textoDe(ultima())).toContain('Pronto! Consulta marcada');
    const appts = (await t.http().get(`/api/scheduling/appointments?patientId=${pacienteId}`).set(auth(recepcao)).expect(200)).body as { id: string; status: string; notes: string | null }[];
    expect(appts).toHaveLength(1);
    expect(appts[0]!.notes).toContain('assistente do WhatsApp');
    // Botão repetido: a oferta já foi consumida.
    await botao(FONE, botoes[0]!.id, botoes[0]!.title);
    expect(textoDe(ultima())).toContain('já venceu');
    await enviar(FONE, 'confirmo');
    expect(textoDe(ultima())).toContain('Presença confirmada');
    // Nova oferta não traz o mesmo dia na mesma agenda (a agenda aceita um horário por pessoa por dia).
    const marcada = (await t.http().get(`/api/scheduling/appointments?patientId=${pacienteId}`).set(auth(recepcao)).expect(200)).body[0] as { scheduleId: string; startsAt: string };
    const dia = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
    await enviar(FONE, 'quero marcar outra consulta');
    for (const b of botoesDe(ultima())) {
      const [, scheduleId, epoch] = /^ASSIST:SLOT:([0-9a-f-]{36})_(\d+)$/.exec(b.id)!;
      if (scheduleId === marcada.scheduleId) expect(dia(new Date(Number(epoch) * 1000))).not.toBe(dia(new Date(marcada.startsAt)));
    }
    await enviar(FONE, '1');
    const agenda = ultima();
    expect(textoDe(agenda)).toContain('Suas próximas consultas');
    expect(botoesDe(agenda).map((b) => b.title)).toEqual(expect.arrayContaining(['Remarcar', 'Cancelar']));
  });

  it('cancelamento por botão libera a vaga; exames, vacinas, remédios, fila e senha respondem com dados reais', async () => {
    await enviar(FONE, 'preciso cancelar');
    const pergunta = ultima();
    expect(textoDe(pergunta)).toContain('Cancelar a consulta');
    const sim = botoesDe(pergunta).find((b) => b.title.startsWith('Sim'))!;
    await botao(FONE, sim.id, sim.title);
    expect(textoDe(ultima())).toContain('cancelada');
    const appts = (await t.http().get(`/api/scheduling/appointments?patientId=${pacienteId}`).set(auth(recepcao)).expect(200)).body as { status: string; cancelReason: string | null }[];
    expect(appts[0]).toMatchObject({ status: 'CANCELADO' });
    expect(appts[0]!.cancelReason).toContain('assistente do WhatsApp');
    await enviar(FONE, 'saiu meu exame?');
    expect(textoDe(ultima())).toContain('Não há exames');
    await enviar(FONE, 'vacina');
    expect(textoDe(ultima())).toContain('Doses registradas: 0');
    await enviar(FONE, 'remedio');
    expect(textoDe(ultima())).toContain('Não há receita ativa');
    await enviar(FONE, 'fila');
    expect(textoDe(ultima())).toContain('Não há encaminhamento');
    await t.http().post('/api/reception/tickets').set(auth(recepcao)).send({ kind: 'NORMAL', patientId: pacienteId }).expect(201);
    await enviar(FONE, 'qual minha senha?');
    expect(textoDe(ultima())).toMatch(/Sua senha hoje é N\d{3} na UBS Centro/);
  });

  it('pedido de atendente vai para a equipe, que responde pela tela e encerra', async () => {
    await enviar(FONE, 'quero falar com um atendente');
    expect(textoDe(ultima())).toContain('Avisei a equipe');
    const lista = (await t.http().get('/api/assistente/conversas?status=AGUARDANDO_ATENDENTE').set(auth(recepcao)).expect(200)).body as {
      id: string;
      paciente: { nome: string } | null;
      telefone: string;
      motivo: string;
    }[];
    const conv = lista.find((c) => c.paciente?.nome === 'Antonia Assistente Teste')!;
    expect(conv).toMatchObject({ telefone: '(63) *****-0701', motivo: 'PEDIDO_DO_CIDADAO' });
    const detalhe = (await t.http().get(`/api/assistente/conversas/${conv.id}`).set(auth(recepcao)).expect(200)).body;
    expect(detalhe.mensagens.length).toBeGreaterThan(10);
    expect(detalhe.mensagens.filter((m: { direcao: string }) => m.direcao === 'ENTRADA').at(-1).intencao).toBe('ATENDENTE');
    const resp = (await t.http().post(`/api/assistente/conversas/${conv.id}/responder`).set(auth(recepcao)).send({ texto: 'Olá, Antonia! Aqui é a Ana, da recepção. Como posso ajudar?' }).expect(200)).body;
    expect(resp.status).toBe('ABERTA');
    expect(textoDe(ultima())).toContain('Aqui é a Ana');
    expect(resp.mensagens.at(-1)).toMatchObject({ direcao: 'SAIDA', intencao: 'ATENDENTE_RESPOSTA', autor: expect.any(String) });
    const painel = (await t.http().get('/api/assistente/painel').set(auth(recepcao)).expect(200)).body;
    expect(painel.conversas7d).toBeGreaterThanOrEqual(2);
    expect(painel.agendamentos30d).toBe(1);
    expect(painel.assistente).toMatchObject({ ativo: true, nome: 'Vida', comIa: false });
    const medica = await t.login('medica', 'UBS Centro', 'MEDICO');
    await t.http().get('/api/assistente/conversas').set(auth(medica)).expect(403);
    const fechada = (await t.http().post(`/api/assistente/conversas/${conv.id}/encerrar`).set(auth(recepcao)).expect(200)).body;
    expect(fechada.status).toBe('ENCERRADA');
  });

  it('com IA ativada o modelo entende texto livre, mas sinais de alerta e o cadastro prevalecem', async () => {
    const ai = t.app.get(AiService);
    const llm = new FakeLlmClient((req) => {
      const content = String(req.content).split('Mensagem atual do cidadão:').pop() ?? '';
      if (/receita azul/.test(content))
        return {
          intencao: 'DUVIDA',
          resposta: 'A receita azul (controle especial) é emitida pelo médico na consulta; leve um documento com foto para retirar o remédio.',
          gravidade: null,
          sinais: [],
          especialidade: null,
          precisaHumano: false,
        };
      if (/boca torta/.test(content)) return { intencao: 'TRIAGEM', resposta: 'Observe e procure a unidade amanhã.', gravidade: 'NAO_URGENTE', sinais: ['boca torta'], especialidade: null, precisaHumano: false };
      if (/consultas? marcad/.test(content)) return { intencao: 'AGENDA', resposta: '', gravidade: null, sinais: [], especialidade: null, precisaHumano: false };
      return { intencao: 'DUVIDA', resposta: 'Posso ajudar com consultas, exames, vacinas e unidades.', gravidade: null, sinais: [], especialidade: null, precisaHumano: true };
    });
    ai.client = llm;
    try {
      await enviar(FONE, 'como faço para pegar a receita azul?');
      expect(textoDe(ultima())).toContain('receita azul');
      expect(llm.calls.at(-1)!.system).toContain('Cidadão identificado: Antonia');
      expect(llm.calls.at(-1)!.system).toContain('UBS Centro');
      // Sinal de alerta: o modelo disse "não urgente", mas a regra manda para a emergência.
      await enviar(FONE, 'minha mãe está com a boca torta e a fala enrolada');
      expect(textoDe(ultima())).toContain('192');
      await enviar(FONE, 'tenho consultas marcadas?');
      expect(textoDe(ultima())).toContain('não tem consultas marcadas');
      // Pedido vago com precisaHumano: responde e sinaliza a equipe.
      await enviar(FONE, 'quero reclamar de uma coisa que aconteceu');
      const conv = (await t.http().get('/api/assistente/conversas?status=AGUARDANDO_ATENDENTE').set(auth(recepcao)).expect(200)).body.find(
        (c: { paciente: { nome: string } | null }) => c.paciente?.nome === 'Antonia Assistente Teste',
      );
      expect(conv).toBeTruthy();
    } finally {
      ai.client = null;
    }
  });
});
