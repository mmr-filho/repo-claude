import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  assistantOutputSchema,
  buildAssistantContent,
  buildAssistantSystemPrompt,
  gravidadeFinal,
  INTENCOES_PESSOAIS,
  interpretarPorRegras,
  orientacaoTriagem,
  TEXTO_ATENDENTE,
  TEXTO_DESPEDIDA,
  TEXTO_NAO_IDENTIFICADO,
  textoMenu,
  urgenciaNoTexto,
  type AssistantOutput,
  type AssistantUnidade,
  type Gravidade,
  type Intencao,
} from '@omnisaude/ai-engine';
import { encodeAssistantPayload, normalizeBrazilPhone, type InteractiveButtonsMessage } from '@omnisaude/messaging';
import { ESCALA_SATISFACAO, inferirAssuntoManifestacao, localDateString, inferirTipoManifestacao, manifestacaoTemConteudo, mascararTelefone, pedeAnonimato, TIPO_MANIFESTACAO, UNIT_TYPE_LABELS } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { CitizenContext, RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { RealtimeService } from '../../core/realtime.service';
import { CitizenService } from '../citizen/citizen.service';
import { AiService } from '../integrations/ai.service';
import { MessagingService, type AssistantEvent, type SystemContext } from '../integrations/messaging.service';
import { OmbudsmanService } from '../ombudsman/ombudsman.service';
import { SatisfactionService } from '../ombudsman/satisfaction.service';
import { SchedulingService } from '../scheduling/scheduling.service';

const DIA = 86_400_000;
const TIPOS_PUBLICO = ['UBS', 'UPA', 'POLICLINICA', 'HOSPITAL', 'CEO', 'CAPS', 'FARMACIA_CENTRAL'] as const;
const NOTA_AGENDAMENTO = 'Agendado pelo cidadão pelo assistente do WhatsApp';
/** Telefone guardado com o DDI (5563...): mostra só o DDD e o fim do número. */
const telefoneMascarado = (phone: string) => mascararTelefone(phone.replace(/^55(?=\d{10,11}$)/, ''));

interface Contexto {
  patientId?: string;
  chosenAt?: string;
  ofertas?: { scheduleId: string; startsAt: string }[];
  /** Pesquisa respondida por botão: a próxima mensagem livre (até o prazo) vira comentário. */
  pesquisaComentario?: string;
  pesquisaComentarioAte?: string;
  /** O cidadão anunciou uma manifestação sem contar o que houve: a próxima mensagem (até o prazo) traz os detalhes. */
  ouvidoriaAbertura?: string;
  ouvidoriaPendenteAte?: string;
}

/** Janela para o comentário da pesquisa ou os detalhes da manifestação. */
const JANELA_COMPLEMENTO_MS = 30 * 60_000;
const TEXTO_ANONIMA_NA_CONVERSA = '[Manifestação anônima enviada à ouvidoria: o conteúdo fica só na ouvidoria, sem identificação]';

interface Pessoa {
  id: string;
  name: string;
  socialName: string | null;
  phone: string | null;
}

type Resposta = ({ texto: string } | { botoes: InteractiveButtonsMessage }) & {
  intent: string;
  extra?: Record<string, unknown>;
  /** O que fica na transcrição vista pela equipe, quando não pode ser o texto enviado (manifestação anônima). */
  registro?: string;
};

/**
 * Assistente do cidadão no WhatsApp (CID-2): identifica a pessoa pelo telefone (só com WhatsApp autorizado),
 * entende a mensagem (regras sempre; modelo de linguagem quando a IA está ativada) e responde com os dados
 * reais da rede. O que é transacional (marcar, confirmar, cancelar, remarcar) passa pelas mesmas regras da
 * agenda; sinais de alerta sempre levam à orientação de emergência, independentemente do modelo.
 */
@Injectable()
export class AssistantService implements OnModuleInit {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly messaging: MessagingService,
    private readonly scheduling: SchedulingService,
    private readonly citizen: CitizenService,
    private readonly ai: AiService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
    private readonly ombudsman: OmbudsmanService,
    private readonly satisfaction: SatisfactionService,
  ) {}

  onModuleInit() {
    this.messaging.onAssistantEvent((sys, event) =>
      this.handle(sys, event).catch((err: Error) => {
        this.logger.error(`Falha ao atender ${event.from}: ${err.message}`);
      }),
    );
  }

  // ───────────────────────────── entrada ─────────────────────────────

  async handle(sys: SystemContext, event: AssistantEvent) {
    if (!sys.tenant.settings.whatsappEnabled || !sys.tenant.settings.assistantEnabled) return;
    const phone = normalizeBrazilPhone(event.from) ?? event.from.replace(/\D/g, '');
    const conv = await this.conversaDoTelefone(sys, phone, event.timestamp);
    const ctx = (conv.context ?? {}) as Contexto;
    const candidatos = await this.candidatos(sys, phone);
    const pessoa = this.escolher(candidatos, ctx);
    if (pessoa && conv.patientId !== pessoa.id) await sys.db.assistantConversation.update({ where: { id: conv.id }, data: { patientId: pessoa.id } });
    const textoIn = event.type === 'text' ? event.text : (event.title ?? `${event.action} ${event.arg}`);
    await sys.db.assistantMessage.create({
      data: { conversationId: conv.id, direction: 'ENTRADA', text: textoIn, providerMessageId: event.messageId, payload: event.type === 'button' ? { action: event.action, arg: event.arg } : undefined },
    });
    const resposta = event.type === 'button' ? await this.botao(sys, conv.id, ctx, pessoa, candidatos, event) : await this.texto(sys, conv.id, ctx, pessoa, candidatos, event.text);
    // Resposta a uma manifestação anônima não fica vinculada ao cadastro no registro de mensagens.
    await this.enviar(sys, conv.id, phone, resposta.extra?.anonima ? null : (pessoa?.id ?? null), resposta);
    await sys.db.assistantMessage.updateMany({ where: { conversationId: conv.id, providerMessageId: event.messageId, intent: null }, data: { intent: resposta.intent } });
    this.realtime.emitToTenant(sys.tenant.id, 'assistente.conversa', { id: conv.id });
  }

  private async conversaDoTelefone(sys: SystemContext, phone: string, at: Date) {
    const aberta = await sys.db.assistantConversation.findFirst({ where: { phone, status: { not: 'ENCERRADA' } }, orderBy: { lastInboundAt: 'desc' } });
    if (aberta && aberta.lastInboundAt.getTime() > at.getTime() - 7 * DIA) {
      return sys.db.assistantConversation.update({ where: { id: aberta.id }, data: { lastInboundAt: at, messagesCount: { increment: 1 } } });
    }
    if (aberta) await sys.db.assistantConversation.update({ where: { id: aberta.id }, data: { status: 'ENCERRADA', closedAt: new Date() } });
    return sys.db.assistantConversation.create({ data: { phone, lastInboundAt: at, messagesCount: 1 } });
  }

  /** Pessoas cadastradas com este telefone e WhatsApp autorizado (telefone compartilhado por uma família é comum). */
  private async candidatos(sys: SystemContext, phone: string): Promise<Pessoa[]> {
    const tail = phone.slice(-8);
    if (tail.length < 8) return [];
    const rows = await sys.db.$queryRaw<{ id: string }[]>`SELECT id FROM patients WHERE merged_into_id IS NULL AND whatsapp_opt_in = true AND regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE ${'%' + tail}`;
    if (!rows.length) return [];
    const pacientes = await sys.db.patient.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, name: true, socialName: true, phone: true }, orderBy: { name: 'asc' } });
    const exatos = pacientes.filter((p) => p.phone && normalizeBrazilPhone(p.phone) === phone);
    return exatos.length ? exatos : pacientes;
  }

  private escolher(candidatos: Pessoa[], ctx: Contexto): Pessoa | null {
    if (candidatos.length === 1) return candidatos[0]!;
    if (candidatos.length > 1 && ctx.patientId && ctx.chosenAt && Date.now() - Date.parse(ctx.chosenAt) < DIA) return candidatos.find((c) => c.id === ctx.patientId) ?? null;
    return null;
  }

  private cctx(sys: SystemContext, patientId: string): CitizenContext {
    return { tenant: sys.tenant, db: sys.db, patientId, ip: 'whatsapp' };
  }

  private async salvarContexto(sys: SystemContext, conversationId: string, ctx: Contexto, patch: Partial<Contexto>) {
    Object.assign(ctx, patch);
    await sys.db.assistantConversation.update({ where: { id: conversationId }, data: { context: ctx as object, ...(ctx.patientId ? { patientId: ctx.patientId } : {}) } });
  }

  // ───────────────────────────── mensagens de texto ─────────────────────────────

  private async texto(sys: SystemContext, conversationId: string, ctx: Contexto, pessoa: Pessoa | null, candidatos: Pessoa[], texto: string): Promise<Resposta> {
    const regras = interpretarPorRegras(texto);
    const agora = Date.now();
    // Comentário da pesquisa: só a mensagem seguinte ao botão, em até 30 minutos, e nunca uma reclamação ou denúncia
    // (essas vão para a ouvidoria, com protocolo e prazo legal). Qualquer outra mensagem encerra a janela.
    if (ctx.pesquisaComentario) {
      const id = ctx.pesquisaComentario;
      const valida = !!ctx.pesquisaComentarioAte && Date.parse(ctx.pesquisaComentarioAte) > agora;
      await this.salvarContexto(sys, conversationId, ctx, { pesquisaComentario: undefined, pesquisaComentarioAte: undefined });
      if (valida && (regras.intencao === 'OUTRO' || regras.intencao === 'DESPEDIDA')) {
        await this.satisfaction.comentar(sys, id, texto);
        return {
          texto: 'Obrigado! Seu comentário foi registrado junto com a avaliação e vai para a gestão da unidade. Se precisar de algo mais, responda 0 para ver o menu.',
          intent: 'PESQUISA_COMENTARIO',
          extra: { surveyId: id },
        };
      }
    }
    // Detalhes de uma manifestação anunciada na mensagem anterior ("quero fazer uma reclamação").
    if (ctx.ouvidoriaPendenteAte) {
      const abertura = ctx.ouvidoriaAbertura ?? '';
      const valida = Date.parse(ctx.ouvidoriaPendenteAte) > agora;
      await this.salvarContexto(sys, conversationId, ctx, { ouvidoriaAbertura: undefined, ouvidoriaPendenteAte: undefined });
      const desvio = regras.gravidade === 'EMERGENCIA' || regras.intencao === 'MENU' || regras.intencao === 'ATENDENTE' || /^\d$/.test(texto.trim());
      if (valida && !desvio && texto.trim().length >= 10) return this.ouvidoria(sys, conversationId, ctx, pessoa, `${abertura}\n${texto}`.trim(), true);
    }
    let intencao: Intencao = regras.intencao;
    let gravidade: Gravidade | null = regras.gravidade;
    let modelo: AssistantOutput | null = null;
    let modeloNome: string | null = null;
    if (sys.tenant.settings.aiEnabled && this.ai.client && regras.gravidade !== 'EMERGENCIA') {
      try {
        const r = await this.ai.client.generateStructured({
          system: await this.prompt(sys, pessoa),
          content: buildAssistantContent(await this.historico(sys, conversationId), texto),
          schema: assistantOutputSchema,
          maxTokens: 800,
          effort: 'low',
          task: 'assistente-whatsapp',
        });
        modelo = r.output;
        modeloNome = r.model;
        intencao = modelo.intencao;
        if (intencao === 'TRIAGEM') gravidade = gravidadeFinal(texto, modelo.gravidade).gravidade;
      } catch (err) {
        this.logger.warn(`Modelo indisponível, seguindo por regras: ${(err as Error).message}`);
      }
    }
    const extra = { intencao, modelo: modeloNome, gravidade };
    const prefixo = (r: Resposta): Resposta => ({ ...r, extra: { ...extra, ...r.extra } });

    if (INTENCOES_PESSOAIS.includes(intencao)) {
      if (!pessoa && candidatos.length > 1) return prefixo(this.perguntarPessoa(candidatos));
      if (!pessoa) return prefixo({ texto: TEXTO_NAO_IDENTIFICADO, intent: 'NAO_IDENTIFICADO' });
    }
    const resultado = await this.montarResposta(sys, conversationId, ctx, pessoa, intencao, { texto, gravidade, modelo });
    if (modelo?.precisaHumano && intencao !== 'ATENDENTE' && intencao !== 'TRIAGEM') await this.pedirAtendente(sys, conversationId, 'MODELO_SUGERIU');
    return prefixo(resultado);
  }

  private async montarResposta(
    sys: SystemContext,
    conversationId: string,
    ctx: Contexto,
    pessoa: Pessoa | null,
    intencao: Intencao,
    o: { texto: string; gravidade: Gravidade | null; modelo: AssistantOutput | null },
  ): Promise<Resposta> {
    const nome = pessoa ? (pessoa.socialName ?? pessoa.name).split(' ')[0] : null;
    switch (intencao) {
      case 'SAUDACAO':
      case 'MENU':
        return { texto: textoMenu(sys.tenant.settings.assistantName, nome), intent: 'MENU' };
      case 'DESPEDIDA':
        return { texto: TEXTO_DESPEDIDA, intent: 'DESPEDIDA' };
      case 'ATENDENTE': {
        await this.pedirAtendente(sys, conversationId, 'PEDIDO_DO_CIDADAO');
        const unidade = pessoa ? (await this.citizen.eu(this.cctx(sys, pessoa.id))).unidadeReferencia?.name : null;
        return { texto: TEXTO_ATENDENTE(unidade), intent: 'ATENDENTE' };
      }
      case 'OUVIDORIA':
        return this.ouvidoria(sys, conversationId, ctx, pessoa, o.texto, false);
      case 'TRIAGEM':
        return this.triagem(sys, conversationId, pessoa, o.texto, o.gravidade, o.modelo);
      case 'UNIDADES':
        return this.unidades(sys, o.texto, o.modelo);
      case 'AGENDA':
        return this.agenda(sys, pessoa!);
      case 'AGENDAR':
        return this.ofertarHorarios(sys, conversationId, ctx, pessoa!);
      case 'CONFIRMAR':
        return this.confirmar(sys, pessoa!);
      case 'CANCELAR':
        return this.perguntarCancelamento(sys, pessoa!);
      case 'REMARCAR':
        return this.remarcar(sys, conversationId, pessoa!);
      case 'EXAMES':
        return this.exames(sys, pessoa!);
      case 'VACINAS':
        return this.vacinas(sys, pessoa!);
      case 'REMEDIOS':
        return this.remedios(sys, pessoa!);
      case 'FILA':
        return this.fila(sys, pessoa!);
      case 'SENHA':
        return this.senha(sys, pessoa!);
      case 'DUVIDA':
      case 'OUTRO':
      default: {
        const resposta = o.modelo?.resposta?.trim();
        if (resposta) return { texto: resposta, intent: intencao };
        return { texto: `Não entendi bem. ${textoMenu(sys.tenant.settings.assistantName, nome)}`, intent: 'NAO_ENTENDI' };
      }
    }
  }

  // ───────────────────────────── botões ─────────────────────────────

  private async botao(sys: SystemContext, conversationId: string, ctx: Contexto, pessoa: Pessoa | null, candidatos: Pessoa[], ev: Extract<AssistantEvent, { type: 'button' }>): Promise<Resposta> {
    const nome = pessoa ? (pessoa.socialName ?? pessoa.name).split(' ')[0] : null;
    if (ctx.pesquisaComentario || ctx.ouvidoriaPendenteAte)
      await this.salvarContexto(sys, conversationId, ctx, { pesquisaComentario: undefined, pesquisaComentarioAte: undefined, ouvidoriaAbertura: undefined, ouvidoriaPendenteAte: undefined });
    switch (ev.action) {
      case 'PESSOA': {
        const escolhida = candidatos.find((c) => c.id === ev.arg);
        if (!escolhida) return { texto: 'Não reconheci a escolha. Vamos de novo:', intent: 'PESSOA_INVALIDA' };
        await this.salvarContexto(sys, conversationId, ctx, { patientId: escolhida.id, chosenAt: new Date().toISOString() });
        return {
          texto: `Certo, falando sobre ${escolhida.socialName ?? escolhida.name}. ${textoMenu(sys.tenant.settings.assistantName, (escolhida.socialName ?? escolhida.name).split(' ')[0])}`,
          intent: 'PESSOA_ESCOLHIDA',
        };
      }
      case 'MENU':
        return { texto: textoMenu(sys.tenant.settings.assistantName, nome), intent: 'MENU' };
      case 'AGENDAR':
        if (!pessoa) return { texto: TEXTO_NAO_IDENTIFICADO, intent: 'NAO_IDENTIFICADO' };
        return this.ofertarHorarios(sys, conversationId, ctx, pessoa);
      case 'SLOT':
        if (!pessoa) return { texto: TEXTO_NAO_IDENTIFICADO, intent: 'NAO_IDENTIFICADO' };
        return this.marcar(sys, conversationId, ctx, pessoa, ev.arg);
      case 'CONFIRM':
        if (!pessoa) return { texto: TEXTO_NAO_IDENTIFICADO, intent: 'NAO_IDENTIFICADO' };
        return this.confirmar(sys, pessoa, ev.arg);
      case 'CANCEL':
        if (!pessoa) return { texto: TEXTO_NAO_IDENTIFICADO, intent: 'NAO_IDENTIFICADO' };
        return this.cancelar(sys, pessoa, ev.arg);
      case 'RESCHED':
        if (!pessoa) return { texto: TEXTO_NAO_IDENTIFICADO, intent: 'NAO_IDENTIFICADO' };
        return this.remarcar(sys, conversationId, pessoa, ev.arg);
      case 'SURVEY':
        return this.pesquisa(sys, conversationId, ctx, ev.arg);
      default:
        return { texto: textoMenu(sys.tenant.settings.assistantName, nome), intent: 'MENU' };
    }
  }

  private perguntarPessoa(candidatos: Pessoa[]): Resposta {
    const buttons = candidatos.slice(0, 3).map((c) => ({ id: encodeAssistantPayload('PESSOA', c.id), title: (c.socialName ?? c.name).split(' ')[0]!.slice(0, 20) }));
    return { botoes: { body: 'Este número está no cadastro de mais de uma pessoa. Sobre quem você quer falar?', buttons }, intent: 'PERGUNTA_PESSOA' };
  }

  // ───────────────────────────── agenda ─────────────────────────────

  private quando(sys: SystemContext, d: Date | string) {
    return new Intl.DateTimeFormat('pt-BR', { timeZone: sys.tenant.timeZone, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date(d))
      .replace('.,', '')
      .replace(',', ' às');
  }

  private async agenda(sys: SystemContext, pessoa: Pessoa): Promise<Resposta> {
    const a = await this.citizen.agenda(this.cctx(sys, pessoa.id));
    if (!a.proximos.length) return { texto: 'Você não tem consultas marcadas. Quer marcar uma? Responda MARCAR (ou 2).', intent: 'AGENDA_VAZIA' };
    const linhas = a.proximos.slice(0, 3).map((p) => `• ${this.quando(sys, p.quando)}: ${p.servico}${p.profissional ? ` com ${p.profissional}` : ''}, ${p.unidade?.nome ?? ''} (${p.statusLabel.toLowerCase()})`);
    const primeiro = a.proximos[0]!;
    const buttons = [
      ...(primeiro.podeConfirmar ? [{ id: encodeAssistantPayload('CONFIRM', primeiro.id), title: 'Confirmar presença' }] : []),
      ...(primeiro.podeCancelar
        ? [
            { id: encodeAssistantPayload('RESCHED', primeiro.id), title: 'Remarcar' },
            { id: encodeAssistantPayload('CANCEL', primeiro.id), title: 'Cancelar' },
          ]
        : []),
    ].slice(0, 3);
    const body = `Suas próximas consultas:\n${linhas.join('\n')}${a.proximos.length > 3 ? `\n(e mais ${a.proximos.length - 3})` : ''}`;
    return buttons.length ? { botoes: { body: `${body}\nSobre a primeira:`, buttons }, intent: 'AGENDA' } : { texto: body, intent: 'AGENDA' };
  }

  private async ofertarHorarios(sys: SystemContext, conversationId: string, ctx: Contexto, pessoa: Pessoa): Promise<Resposta> {
    const eu = await this.citizen.eu(this.cctx(sys, pessoa.id));
    // Unidades candidatas: a de referência (se for UBS) e depois as UBS com agenda ativa, em ordem de nome.
    const comAgenda = await sys.db.unit.findMany({ where: { active: true, type: 'UBS', schedules: { some: { active: true } } }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
    const candidatas = [...(eu.unidadeReferencia ? comAgenda.filter((u) => u.id === eu.unidadeReferencia!.id) : []), ...comAgenda.filter((u) => u.id !== eu.unidadeReferencia?.id)];
    if (!candidatas.length) return { texto: 'Ainda não há unidade com agenda aberta para marcar por aqui. Procure a recepção da sua unidade de saúde.', intent: 'AGENDAR_SEM_UNIDADE' };
    for (const unit of candidatas.slice(0, 3)) {
      const schedules = await sys.db.schedule.findMany({ where: { unitId: unit.id, active: true }, orderBy: { name: 'asc' } });
      const profissionais = new Map(
        (await sys.db.user.findMany({ where: { id: { in: [...new Set(schedules.map((s) => s.professionalId))] } }, select: { id: true, name: true, socialName: true } })).map((u) => [u.id, u.socialName ?? u.name]),
      );
      const ordenadas = [...schedules].sort((a, b) => Number(b.cbo.startsWith('2251')) - Number(a.cbo.startsWith('2251')));
      // A agenda aceita um horário por pessoa por dia: não oferece dias em que ela já tem consulta naquela agenda.
      const ocupados = new Set(
        (
          await sys.db.appointment.findMany({
            where: { patientId: pessoa.id, scheduleId: { in: schedules.map((x) => x.id) }, status: { in: ['AGENDADO', 'CONFIRMADO'] }, startsAt: { gte: new Date() } },
            select: { scheduleId: true, startsAt: true },
          })
        ).map((a) => `${a.scheduleId}|${localDateString(a.startsAt, sys.tenant.timeZone)}`),
      );
      const ofertas: { scheduleId: string; startsAt: Date; profissional: string; servico: string }[] = [];
      for (const s of ordenadas.slice(0, 4)) {
        const slots = (await this.scheduling.nextFreeSlots(sys, s.id, 8)).filter((slot) => !ocupados.has(`${s.id}|${localDateString(slot.startsAt, sys.tenant.timeZone)}`)).slice(0, 2);
        for (const slot of slots) ofertas.push({ scheduleId: s.id, startsAt: slot.startsAt, profissional: profissionais.get(s.professionalId) ?? 'profissional da unidade', servico: s.name });
      }
      ofertas.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      const tres = ofertas.slice(0, 3);
      if (!tres.length) continue;
      await this.salvarContexto(sys, conversationId, ctx, { ofertas: tres.map((o) => ({ scheduleId: o.scheduleId, startsAt: o.startsAt.toISOString() })) });
      const buttons = tres.map((o) => ({ id: encodeAssistantPayload('SLOT', `${o.scheduleId}_${Math.floor(o.startsAt.getTime() / 1000)}`), title: this.quando(sys, o.startsAt).replace(' às', '').slice(0, 20) }));
      const body = `Horários livres na ${unit.name}:\n${tres.map((o) => `• ${this.quando(sys, o.startsAt)}: ${o.servico} (${o.profissional})`).join('\n')}\nToque no horário para marcar.`;
      return { botoes: { body, buttons }, intent: 'AGENDAR_OFERTA', extra: { unidade: unit.name, ofertas: tres.length } };
    }
    return { texto: `Não encontrei horários livres nos próximos 30 dias na ${candidatas[0]!.name}. Procure a recepção da unidade ou responda 9 para falar com um atendente.`, intent: 'AGENDAR_SEM_VAGA' };
  }

  private async marcar(sys: SystemContext, conversationId: string, ctx: Contexto, pessoa: Pessoa, arg: string): Promise<Resposta> {
    const m = /^([0-9a-f-]{36})_(\d{9,11})$/.exec(arg);
    const oferta = m ? ctx.ofertas?.find((o) => o.scheduleId === m[1] && Math.floor(Date.parse(o.startsAt) / 1000) === Number(m[2])) : null;
    if (!m || !oferta) return { texto: 'Essa oferta de horário já venceu. Responda MARCAR para ver os horários atuais.', intent: 'SLOT_INVALIDO' };
    const schedule = await sys.db.schedule.findUnique({ where: { id: oferta.scheduleId }, include: { unit: true } });
    const profissional = schedule ? await sys.db.user.findUnique({ where: { id: schedule.professionalId }, select: { name: true, socialName: true } }) : null;
    if (!schedule) return { texto: 'Essa agenda não está mais disponível. Responda MARCAR para ver outras opções.', intent: 'SLOT_INVALIDO' };
    const retorno = (await sys.db.appointment.count({ where: { patientId: pessoa.id, scheduleId: schedule.id, status: 'ATENDIDO', startsAt: { gte: new Date(Date.now() - 180 * DIA) } } })) > 0;
    try {
      const appt = await this.scheduling.book(
        sys,
        { scheduleId: schedule.id, patientId: pessoa.id, startsAt: oferta.startsAt, kind: retorno ? 'RETORNO' : 'PRIMEIRA_CONSULTA', notes: NOTA_AGENDAMENTO },
        schedule.professionalId,
      );
      await this.salvarContexto(sys, conversationId, ctx, { ofertas: [] });
      return {
        texto: `Pronto! Consulta marcada para ${this.quando(sys, appt.startsAt)} com ${profissional?.socialName ?? profissional?.name ?? 'a equipe'}, na ${schedule.unit.name}${schedule.unit.address ? ` (${schedule.unit.address})` : ''}.\nChegue 15 minutos antes com documento com foto e cartão do SUS. Para mudar, responda REMARCAR ou CANCELAR.`,
        intent: 'AGENDADO',
        extra: { appointmentId: appt.id },
      };
    } catch (err) {
      const msg = err instanceof DomainError ? err.message : 'não foi possível marcar';
      return { texto: `Esse horário não está mais disponível (${msg.toLowerCase()}). Responda MARCAR para ver outras opções.`, intent: 'AGENDAR_FALHOU', extra: { erro: msg } };
    }
  }

  private async proximoAgendamento(sys: SystemContext, pessoa: Pessoa, id?: string) {
    return sys.db.appointment.findFirst({
      where: { patientId: pessoa.id, status: { in: ['AGENDADO', 'CONFIRMADO'] }, startsAt: { gte: new Date() }, ...(id ? { id } : {}) },
      orderBy: { startsAt: 'asc' },
      include: { schedule: { select: { name: true, unit: { select: { name: true } } } } },
    });
  }

  private async confirmar(sys: SystemContext, pessoa: Pessoa, id?: string): Promise<Resposta> {
    const a = await this.proximoAgendamento(sys, pessoa, id);
    if (!a) return { texto: 'Não encontrei consulta futura para confirmar. Responda 1 para ver sua agenda.', intent: 'CONFIRMAR_NADA' };
    if (a.status === 'CONFIRMADO') return { texto: `Sua consulta de ${this.quando(sys, a.startsAt)} na ${a.schedule.unit.name} já está confirmada. Até lá!`, intent: 'CONFIRMAR_JA' };
    await this.scheduling.confirm(sys, a.id, 'WHATSAPP');
    return { texto: `Presença confirmada para ${this.quando(sys, a.startsAt)} (${a.schedule.name}, ${a.schedule.unit.name}). Obrigado!`, intent: 'CONFIRMADO', extra: { appointmentId: a.id } };
  }

  private async perguntarCancelamento(sys: SystemContext, pessoa: Pessoa): Promise<Resposta> {
    const futuros = await sys.db.appointment.findMany({
      where: { patientId: pessoa.id, status: { in: ['AGENDADO', 'CONFIRMADO'] }, startsAt: { gte: new Date() } },
      orderBy: { startsAt: 'asc' },
      take: 3,
      include: { schedule: { select: { unit: { select: { name: true } } } } },
    });
    if (!futuros.length) return { texto: 'Você não tem consulta futura para cancelar.', intent: 'CANCELAR_NADA' };
    if (futuros.length === 1) {
      const a = futuros[0]!;
      return {
        botoes: {
          body: `Cancelar a consulta de ${this.quando(sys, a.startsAt)} na ${a.schedule.unit.name}? A vaga será liberada para outra pessoa.`,
          buttons: [
            { id: encodeAssistantPayload('CANCEL', a.id), title: 'Sim, cancelar' },
            { id: encodeAssistantPayload('MENU', '0'), title: 'Manter' },
          ],
        },
        intent: 'CANCELAR_PERGUNTA',
      };
    }
    return {
      botoes: { body: 'Qual consulta você quer cancelar?', buttons: futuros.map((a) => ({ id: encodeAssistantPayload('CANCEL', a.id), title: this.quando(sys, a.startsAt).replace(' às', '').slice(0, 20) })) },
      intent: 'CANCELAR_PERGUNTA',
    };
  }

  private async cancelar(sys: SystemContext, pessoa: Pessoa, id: string): Promise<Resposta> {
    const a = await this.proximoAgendamento(sys, pessoa, id);
    if (!a) return { texto: 'Essa consulta não está mais ativa.', intent: 'CANCELAR_NADA' };
    await this.scheduling.cancel(sys, a.id, 'Cancelado pelo cidadão pelo assistente do WhatsApp');
    return { texto: `Consulta de ${this.quando(sys, a.startsAt)} cancelada. Quando quiser marcar outra, responda MARCAR.`, intent: 'CANCELADO', extra: { appointmentId: a.id } };
  }

  private async remarcar(sys: SystemContext, conversationId: string, pessoa: Pessoa, id?: string): Promise<Resposta> {
    const a = await this.proximoAgendamento(sys, pessoa, id);
    if (!a) return { texto: 'Não encontrei consulta futura para remarcar. Responda MARCAR para marcar uma nova.', intent: 'REMARCAR_NADA' };
    const slots = await this.scheduling.nextFreeSlots(sys, a.scheduleId, 3, new Date(a.startsAt.getTime() + 1));
    const outros = slots.filter((s) => s.startsAt.getTime() !== a.startsAt.getTime());
    if (!outros.length) return { texto: `Não há outros horários livres nessa agenda nos próximos 30 dias. Se precisar, responda CANCELAR ou procure a ${a.schedule.unit.name}.`, intent: 'REMARCAR_SEM_VAGA' };
    const message = this.messaging.buildRescheduleMessage(a.id, outros, a.schedule.unit.name, sys.tenant.timeZone);
    return { botoes: message, intent: 'REMARCAR_OFERTA', extra: { appointmentId: a.id, viaAgenda: true } };
  }

  // ───────────────────────────── informações ─────────────────────────────

  private async exames(sys: SystemContext, pessoa: Pessoa): Promise<Resposta> {
    const lista = await this.citizen.exames(this.cctx(sys, pessoa.id));
    if (!lista.length) return { texto: 'Não há exames solicitados no seu cadastro.', intent: 'EXAMES' };
    const linhas = lista
      .slice(0, 5)
      .map((e) => `• ${e.nome}: ${e.statusLabel.toLowerCase()}${e.resultado?.em ? ` (liberado em ${new Date(e.resultado.em).toLocaleDateString('pt-BR', { timeZone: sys.tenant.timeZone })})` : ''}`);
    return { texto: `Seus exames:\n${linhas.join('\n')}\nOs valores e laudos ficam no app do cidadão e na unidade; quem interpreta é o profissional na consulta.`, intent: 'EXAMES' };
  }

  private async vacinas(sys: SystemContext, pessoa: Pessoa): Promise<Resposta> {
    const v = await this.citizen.vacinas(this.cctx(sys, pessoa.id));
    const eu = await this.citizen.eu(this.cctx(sys, pessoa.id));
    const atrasadas = v.proximas.filter((p) => p.situacao === 'ATRASADA');
    const partes = [`Doses registradas: ${v.doses.length}.`];
    if (atrasadas.length)
      partes.push(
        `Vacinas atrasadas (${atrasadas.length}): ${atrasadas
          .slice(0, 4)
          .map((p) => p.nome)
          .join('; ')}${atrasadas.length > 4 ? ' e outras' : ''}.`,
        `Procure a sala de vacina${eu.unidadeReferencia ? ` da ${eu.unidadeReferencia.name}` : ' da sua unidade'} com documento: não precisa agendar.`,
      );
    else partes.push('Seu calendário está em dia para a sua idade.');
    partes.push('O cartão completo e o certificado estão no app do cidadão.');
    return { texto: partes.join('\n'), intent: 'VACINAS' };
  }

  private async remedios(sys: SystemContext, pessoa: Pessoa): Promise<Resposta> {
    const m = await this.citizen.medicamentos(this.cctx(sys, pessoa.id));
    if (!m.itens.length) return { texto: 'Não há receita ativa registrada na rede para você. Receitas de fora da rede não aparecem aqui.', intent: 'REMEDIOS' };
    const linhas = m.itens
      .slice(0, 5)
      .map((i) => `• ${i.medicamento} — ${i.posologia}${i.cadastradoNaFarmacia ? (i.disponivelEm.length ? ` (tem na ${i.disponivelEm.map((d) => d.unidade).join(', ')})` : ' (sem estoque na rede agora)') : ''}`);
    return { texto: `Seus remédios em uso:\n${linhas.join('\n')}\nLeve a receita e um documento para retirar na farmácia.`, intent: 'REMEDIOS' };
  }

  private async fila(sys: SystemContext, pessoa: Pessoa): Promise<Resposta> {
    const r = await this.citizen.regulacao(this.cctx(sys, pessoa.id));
    if (!r.solicitacoes.length && !r.tfd.length && !r.leitos.length) return { texto: 'Não há encaminhamento para especialista, exame regulado, leito ou TFD no seu nome.', intent: 'FILA' };
    const linhas = [
      ...r.solicitacoes
        .slice(0, 3)
        .map(
          (s) =>
            `• ${s.procedimento}: ${s.statusLabel.toLowerCase()}${s.posicaoNaFila ? `, você é o ${s.posicaoNaFila}º da fila` : ''}${s.agendadoPara ? `, agendado para ${this.quando(sys, s.agendadoPara)}${s.unidadeExecutante ? ` em ${s.unidadeExecutante}` : ''}` : ''}`,
        ),
      ...r.tfd.slice(0, 2).map((t) => `• TFD ${t.procedimento} (${t.destino}): ${t.statusLabel.toLowerCase()}${t.viagem ? `, viagem em ${new Date(t.viagem.data + 'T12:00:00Z').toLocaleDateString('pt-BR')}` : ''}`),
      ...r.leitos.slice(0, 1).map((l) => `• Vaga de leito (${l.especialidade}): ${l.statusLabel.toLowerCase()}`),
    ];
    return { texto: `Seus encaminhamentos:\n${linhas.join('\n')}\nA ordem da fila segue a gravidade clínica, não só a data. Qualquer mudança chega por aqui.`, intent: 'FILA' };
  }

  private async senha(sys: SystemContext, pessoa: Pessoa): Promise<Resposta> {
    const s = await this.citizen.senha(this.cctx(sys, pessoa.id));
    if (!s) return { texto: 'Você não tem senha de atendimento hoje. As senhas são retiradas na recepção da unidade.', intent: 'SENHA' };
    return { texto: `Sua senha hoje é ${s.senha} na ${s.unidade}: ${s.statusLabel.toLowerCase()}${s.posicao ? `, ${s.posicao}ª na fila` : ''}${s.guiche ? `, ${s.guiche}` : ''}.`, intent: 'SENHA' };
  }

  private async unidadesPublicas(sys: SystemContext): Promise<(AssistantUnidade & { type: string })[]> {
    const rows = await sys.db.unit.findMany({ where: { active: true, type: { in: [...TIPOS_PUBLICO] } }, orderBy: { name: 'asc' }, select: { name: true, type: true, address: true, phone: true, openingHours: true } });
    return rows.map((u) => ({ nome: u.name, tipo: UNIT_TYPE_LABELS[u.type] ?? u.type, type: u.type, endereco: u.address, telefone: u.phone, horario: u.openingHours }));
  }

  private async unidades(sys: SystemContext, texto: string, modelo: AssistantOutput | null): Promise<Resposta> {
    const todas = await this.unidadesPublicas(sys);
    const t = texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const tokens = t.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !['unidade', 'horario', 'funcionamento', 'telefone', 'endereco', 'qual', 'onde', 'fica', 'saude', 'posto'].includes(w));
    let lista = todas.filter((u) => {
      const n = u.nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      return tokens.some((w) => n.includes(w));
    });
    if (!lista.length && /\bupa\b|urgencia|24 ?h/.test(t)) lista = todas.filter((u) => u.type === 'UPA');
    if (!lista.length && /hospital|internac/.test(t)) lista = todas.filter((u) => u.type === 'HOSPITAL');
    if (!lista.length && /\bubs\b|posto/.test(t)) lista = todas.filter((u) => u.type === 'UBS');
    if (!lista.length) lista = todas;
    const resposta = modelo?.resposta?.trim();
    if (resposta && lista.length > 5) return { texto: resposta, intent: 'UNIDADES' };
    const linhas = lista.slice(0, 5).map((u) => `• ${u.nome} (${u.tipo})${u.endereco ? `: ${u.endereco}` : ''}${u.horario ? ` · ${u.horario}` : ''}${u.telefone ? ` · tel. ${u.telefone}` : ''}`);
    return {
      texto: `${lista.length > 5 ? `Encontrei ${lista.length} unidades; as primeiras:` : 'Unidades:'}\n${linhas.join('\n')}${lista.length > 5 ? '\nDiga o nome ou o bairro para eu filtrar.' : ''}`,
      intent: 'UNIDADES',
    };
  }

  private async triagem(sys: SystemContext, conversationId: string, pessoa: Pessoa | null, texto: string, gravidadeIn: Gravidade | null, modelo: AssistantOutput | null): Promise<Resposta> {
    const { gravidade, sinais } = gravidadeFinal(texto, gravidadeIn ?? modelo?.gravidade);
    const unidades = await this.unidadesPublicas(sys);
    const upa = unidades.find((u) => u.type === 'UPA') ?? unidades.find((u) => u.type === 'HOSPITAL') ?? null;
    const ubsRef = pessoa ? (await this.citizen.eu(this.cctx(sys, pessoa.id))).unidadeReferencia : null;
    const ubs = ubsRef ? { nome: ubsRef.name, tipo: 'UBS', endereco: ubsRef.address, telefone: ubsRef.phone, horario: ubsRef.openingHours } : (unidades.find((u) => u.type === 'UBS') ?? null);
    const orientacao = orientacaoTriagem(gravidade, { sinais: sinais.length ? sinais : (modelo?.sinais ?? []).slice(0, 4), upa, ubs });
    const complemento = gravidade !== 'EMERGENCIA' && modelo?.resposta?.trim() ? `\n${modelo.resposta.trim()}` : '';
    await sys.db.assistantConversation.update({ where: { id: conversationId }, data: { lastTriage: gravidade } });
    if (gravidade === 'EMERGENCIA') await this.pedirAtendente(sys, conversationId, 'EMERGENCIA');
    return { texto: `${orientacao}${complemento}`, intent: 'TRIAGEM', extra: { gravidade, sinais } };
  }

  private async pedirAtendente(sys: SystemContext, conversationId: string, motivo: string) {
    await sys.db.assistantConversation.update({ where: { id: conversationId }, data: { status: 'AGUARDANDO_ATENDENTE', handoffReason: motivo } });
    this.realtime.emitToTenant(sys.tenant.id, 'assistente.atendente', { id: conversationId, motivo });
  }

  // ───────────────────────────── ouvidoria e pesquisa ─────────────────────────────

  /**
   * Registra a manifestação com o texto da mensagem (tipo e assunto inferidos) e devolve o protocolo.
   * Anonimato só quando o cidadão pede: a manifestação guarda o cadastro para ele acompanhar pelo app, mas a equipe
   * não vê a autoria, e a transcrição da conversa (tela do assistente) não guarda o conteúdo nem o protocolo.
   * Remetente não identificado: registro identificado pelo telefone, para a resposta chegar por aqui.
   */
  private async ouvidoria(sys: SystemContext, conversationId: string, ctx: Contexto, pessoa: Pessoa | null, texto: string, detalhado: boolean): Promise<Resposta> {
    const t = texto.trim();
    if (!detalhado && !manifestacaoTemConteudo(t)) {
      await this.salvarContexto(sys, conversationId, ctx, { ouvidoriaAbertura: t, ouvidoriaPendenteAte: new Date(Date.now() + JANELA_COMPLEMENTO_MS).toISOString() });
      return {
        texto: 'Certo. Conte com suas palavras o que aconteceu (ou o elogio/sugestão), com a unidade e a data se souber, que eu registro na ouvidoria com protocolo. Se não quiser se identificar, diga "anônima".',
        intent: 'OUVIDORIA_PEDIR_TEXTO',
      };
    }
    const anonima = pedeAnonimato(t);
    const conv = await sys.db.assistantConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { phone: true } });
    const unidade = pessoa ? (await this.citizen.eu(this.cctx(sys, pessoa.id))).unidadeReferencia : null;
    const kind = inferirTipoManifestacao(t);
    const c = await this.ombudsman.registrar(sys, {
      kind,
      channel: 'WHATSAPP',
      subject: inferirAssuntoManifestacao(t),
      text: t,
      unitId: unidade?.id ?? null,
      patientId: pessoa?.id ?? null,
      anonymous: anonima,
      contactPhone: conv.phone,
    });
    const prazo = 'em até 30 dias, prorrogáveis uma vez por igual período com justificativa (Lei 13.460/2017)';
    const partes = [
      `Registrei sua ${TIPO_MANIFESTACAO[kind].toLowerCase()} na ouvidoria${anonima ? ', sem identificação para a equipe' : ''}. Protocolo ${c.protocol}.`,
      `A resposta chega por aqui${pessoa ? ' e no app do cidadão' : ''} ${prazo}. Se quiser falar com alguém agora, responda 9.`,
    ];
    // Sintomas que pedem atendimento hoje: a manifestação não substitui a orientação.
    if (urgenciaNoTexto(t)) {
      const unidades = await this.unidadesPublicas(sys);
      const upa = unidades.find((u) => u.type === 'UPA') ?? unidades.find((u) => u.type === 'HOSPITAL') ?? null;
      partes.unshift(orientacaoTriagem('URGENCIA', { upa }));
      await sys.db.assistantConversation.update({ where: { id: conversationId }, data: { lastTriage: 'URGENCIA' } });
      await this.pedirAtendente(sys, conversationId, 'URGENCIA');
    }
    if (anonima) {
      const textos = [t, ...t.split('\n')].filter(Boolean);
      await sys.db.assistantMessage.updateMany({ where: { conversationId, direction: 'ENTRADA', text: { in: textos } }, data: { text: TEXTO_ANONIMA_NA_CONVERSA } });
    }
    return {
      texto: partes.join('\n'),
      intent: 'OUVIDORIA',
      extra: anonima ? { tipo: kind, anonima: true } : { protocolo: c.protocol, tipo: kind },
      ...(anonima ? { registro: `Manifestação anônima registrada na ouvidoria (protocolo informado ao cidadão).${urgenciaNoTexto(t) ? ' Orientado a procurar atendimento hoje.' : ''}` } : {}),
    };
  }

  /** Botão da pesquisa de satisfação (Ótimo, Regular, Ruim) enviada depois do atendimento. */
  private async pesquisa(sys: SystemContext, conversationId: string, ctx: Contexto, arg: string): Promise<Resposta> {
    const m = /^([0-9a-f-]{36})_([1-5])$/.exec(arg);
    if (!m) return { texto: 'Não reconheci a avaliação. Responda com uma nota de 1 a 5.', intent: 'PESQUISA_INVALIDA' };
    try {
      await this.satisfaction.responder(sys, m[1]!, { score: Number(m[2]), channel: 'WHATSAPP' });
    } catch (err) {
      return {
        texto:
          err instanceof DomainError && err.code === 'JA_RESPONDIDA'
            ? 'Já recebemos sua avaliação. Obrigado!'
            : 'Esta pesquisa não está mais disponível, mas sua opinião continua valendo: responda 9 para falar com a equipe.',
        intent: 'PESQUISA_INDISPONIVEL',
      };
    }
    await this.salvarContexto(sys, conversationId, ctx, {
      pesquisaComentario: m[1]!,
      pesquisaComentarioAte: new Date(Date.now() + JANELA_COMPLEMENTO_MS).toISOString(),
      ouvidoriaAbertura: undefined,
      ouvidoriaPendenteAte: undefined,
    });
    return {
      texto: `Obrigado pela avaliação (${ESCALA_SATISFACAO[Number(m[2])]?.toLowerCase()})! Se quiser contar mais sobre o atendimento, é só responder com sua mensagem.`,
      intent: 'PESQUISA_RESPONDIDA',
      extra: { surveyId: m[1], nota: Number(m[2]) },
    };
  }

  // ───────────────────────────── modelo ─────────────────────────────

  private async prompt(sys: SystemContext, pessoa: Pessoa | null) {
    const unidades = await this.unidadesPublicas(sys);
    let cidadao: { primeiroNome: string; resumo: string[] } | null = null;
    if (pessoa) {
      const eu = await this.citizen.eu(this.cctx(sys, pessoa.id));
      cidadao = {
        primeiroNome: eu.cidadao.primeiroNome,
        resumo: [
          eu.proximoAgendamento
            ? `Próxima consulta: ${this.quando(sys, eu.proximoAgendamento.quando)}, ${eu.proximoAgendamento.servico}, ${eu.proximoAgendamento.unidade ?? ''} (${eu.proximoAgendamento.statusLabel})`
            : 'Sem consulta marcada',
          eu.unidadeReferencia ? `Unidade de referência: ${eu.unidadeReferencia.name}` : 'Sem unidade de referência',
          `Resultados novos de exames: ${eu.pendencias.examesNovos}; vacinas atrasadas: ${eu.pendencias.vacinasAtrasadas}; pedidos na regulação/TFD: ${eu.pendencias.solicitacoesEmAndamento}`,
          eu.senhaHoje ? `Senha de hoje: ${eu.senhaHoje.senha} (${eu.senhaHoje.statusLabel})` : 'Sem senha hoje',
        ],
      };
    }
    return buildAssistantSystemPrompt({
      instituicao: sys.tenant.name,
      nomeAssistente: sys.tenant.settings.assistantName,
      unidades: unidades.slice(0, 40),
      faq: sys.tenant.settings.assistantFaq,
      cidadao,
      agora: new Intl.DateTimeFormat('pt-BR', { timeZone: sys.tenant.timeZone, dateStyle: 'full', timeStyle: 'short' }).format(new Date()),
    });
  }

  private async historico(sys: SystemContext, conversationId: string) {
    const rows = await sys.db.assistantMessage.findMany({ where: { conversationId }, orderBy: { createdAt: 'desc' }, take: 7 });
    return rows
      .slice(1)
      .reverse()
      .map((m) => ({ de: m.direction === 'ENTRADA' ? ('CIDADAO' as const) : ('ASSISTENTE' as const), texto: m.text }));
  }

  // ───────────────────────────── saída ─────────────────────────────

  private async enviar(sys: SystemContext, conversationId: string, phone: string, patientId: string | null, r: Resposta) {
    const texto = r.registro ?? ('texto' in r ? r.texto : `${r.botoes.body}\n[${r.botoes.buttons.map((b) => b.title).join(' | ')}]`);
    const log =
      'texto' in r
        ? await this.messaging.sendTextNow(sys, patientId, phone, r.texto, conversationId)
        : r.extra?.viaAgenda
          ? await this.messaging.sendInteractiveNow(sys, patientId, phone, r.botoes, String(r.extra.appointmentId))
          : await this.messaging.sendAssistantButtonsNow(sys, patientId, phone, r.botoes, conversationId);
    await sys.db.assistantMessage.create({
      data: {
        conversationId,
        direction: 'SAIDA',
        text: texto,
        intent: r.intent,
        payload: { ...(r.extra ?? {}), entrega: log.status, erro: log.error ?? undefined, botoes: 'botoes' in r ? r.botoes.buttons.map((b) => b.id) : undefined } as object,
        providerMessageId: log.providerMessageId,
      },
    });
    await sys.db.assistantConversation.update({ where: { id: conversationId }, data: { lastOutboundAt: new Date(), messagesCount: { increment: 1 } } });
  }

  // ───────────────────────────── tela da equipe ─────────────────────────────

  async painel(ctx: RequestContext) {
    const d7 = new Date(Date.now() - 7 * DIA);
    const d30 = new Date(Date.now() - 30 * DIA);
    const [conversas7, mensagens7, aguardando, agendados30, triagens, intencoes] = await Promise.all([
      ctx.db.assistantConversation.count({ where: { lastInboundAt: { gte: d7 } } }),
      ctx.db.assistantMessage.count({ where: { createdAt: { gte: d7 }, direction: 'ENTRADA' } }),
      ctx.db.assistantConversation.count({ where: { status: 'AGUARDANDO_ATENDENTE' } }),
      ctx.db.appointment.count({ where: { notes: NOTA_AGENDAMENTO, createdAt: { gte: d30 } } }),
      ctx.db.assistantConversation.groupBy({ by: ['lastTriage'], where: { lastTriage: { not: null }, lastInboundAt: { gte: d30 } }, _count: { _all: true } }),
      ctx.db.assistantMessage.groupBy({ by: ['intent'], where: { direction: 'SAIDA', createdAt: { gte: d30 }, intent: { not: null } }, _count: { _all: true }, orderBy: { _count: { intent: 'desc' } }, take: 8 }),
    ]);
    return {
      conversas7d: conversas7,
      mensagensRecebidas7d: mensagens7,
      aguardandoAtendente: aguardando,
      agendamentos30d: agendados30,
      triagens30d: Object.fromEntries(triagens.map((t) => [t.lastTriage, t._count._all])),
      intencoes30d: intencoes.map((i) => ({ intencao: i.intent, total: i._count._all })),
      assistente: {
        ativo: ctx.tenant.settings.assistantEnabled && ctx.tenant.settings.whatsappEnabled,
        nome: ctx.tenant.settings.assistantName,
        comIa: ctx.tenant.settings.aiEnabled && !!this.ai.client,
        faq: ctx.tenant.settings.assistantFaq.length,
      },
    };
  }

  async conversas(ctx: RequestContext, q: { status?: string; busca?: string }) {
    const rows = await ctx.db.assistantConversation.findMany({
      where: {
        ...(q.status ? { status: q.status as 'ABERTA' } : {}),
        ...(q.busca ? { OR: [{ phone: { contains: q.busca.replace(/\D/g, '') || q.busca } }, { patient: { name: { contains: q.busca, mode: 'insensitive' } } }] } : {}),
      },
      orderBy: [{ status: 'asc' }, { lastInboundAt: 'desc' }],
      take: 100,
      include: { patient: { select: { id: true, name: true, socialName: true } }, messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    return rows.map((c) => ({
      id: c.id,
      telefone: telefoneMascarado(c.phone),
      paciente: c.patient ? { id: c.patient.id, nome: c.patient.socialName ?? c.patient.name } : null,
      status: c.status,
      motivo: c.handoffReason,
      triagem: c.lastTriage,
      mensagens: c.messagesCount,
      ultima: c.messages[0] ? { texto: c.messages[0].text.slice(0, 120), direcao: c.messages[0].direction, em: c.messages[0].createdAt.toISOString() } : null,
      ultimaEntradaEm: c.lastInboundAt.toISOString(),
    }));
  }

  async conversa(ctx: RequestContext, id: string) {
    const c = await ctx.db.assistantConversation.findUnique({
      where: { id },
      include: { patient: { select: { id: true, name: true, socialName: true, cns: true } }, messages: { orderBy: { createdAt: 'asc' }, take: 200 } },
    });
    if (!c) throw notFound('Conversa');
    const autores = new Map(
      (await ctx.db.user.findMany({ where: { id: { in: [...new Set(c.messages.map((m) => m.authorId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
    );
    return {
      id: c.id,
      telefone: telefoneMascarado(c.phone),
      paciente: c.patient ? { id: c.patient.id, nome: c.patient.socialName ?? c.patient.name, cns: c.patient.cns } : null,
      status: c.status,
      motivo: c.handoffReason,
      triagem: c.lastTriage,
      mensagens: c.messages.map((m) => ({
        id: m.id,
        direcao: m.direction,
        texto: m.text,
        intencao: m.intent,
        em: m.createdAt.toISOString(),
        autor: m.authorId ? (autores.get(m.authorId) ?? 'Equipe') : null,
        detalhes: m.payload,
      })),
      abertaEm: c.createdAt.toISOString(),
    };
  }

  /** Resposta de uma pessoa da equipe pela tela: vai pelo mesmo número e fica na conversa. */
  async responder(ctx: RequestContext, id: string, texto: string) {
    const c = await ctx.db.assistantConversation.findUnique({ where: { id } });
    if (!c) throw notFound('Conversa');
    if (c.status === 'ENCERRADA') throw new DomainError('CONVERSA_ENCERRADA', 'A conversa já foi encerrada', HttpStatus.UNPROCESSABLE_ENTITY);
    const sys: SystemContext = { tenant: ctx.tenant, db: ctx.db };
    const log = await this.messaging.sendTextNow(sys, c.patientId, c.phone, texto, c.id);
    if (log.status === 'FALHOU') throw new DomainError('ENVIO_FALHOU', `Não foi possível enviar pelo WhatsApp: ${log.error ?? 'erro desconhecido'}`, HttpStatus.BAD_GATEWAY);
    await ctx.db.assistantMessage.create({ data: { conversationId: c.id, direction: 'SAIDA', text: texto, intent: 'ATENDENTE_RESPOSTA', authorId: ctx.session.userId, providerMessageId: log.providerMessageId } });
    await ctx.db.assistantConversation.update({ where: { id: c.id }, data: { status: 'ABERTA', handoffReason: null, lastOutboundAt: new Date(), messagesCount: { increment: 1 } } });
    await this.audit.recordStandalone(ctx, { action: 'assistente.responder', entityType: 'AssistantConversation', entityId: c.id, payload: { tamanho: texto.length } });
    this.realtime.emitToTenant(ctx.tenant.id, 'assistente.conversa', { id: c.id });
    return this.conversa(ctx, c.id);
  }

  async encerrar(ctx: RequestContext, id: string) {
    const c = await ctx.db.assistantConversation.findUnique({ where: { id } });
    if (!c) throw notFound('Conversa');
    await ctx.db.assistantConversation.update({ where: { id }, data: { status: 'ENCERRADA', closedAt: new Date(), handoffReason: null } });
    await this.audit.recordStandalone(ctx, { action: 'assistente.encerrar', entityType: 'AssistantConversation', entityId: c.id, payload: {} });
    this.realtime.emitToTenant(ctx.tenant.id, 'assistente.conversa', { id });
    return this.conversa(ctx, id);
  }
}
