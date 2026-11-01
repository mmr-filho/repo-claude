import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { tenantSettings, type MasterClient, type TenantClient, type VigilanciaSettings } from '@omnisaude/database';
import { buildSurveillanceAlertTemplate, normalizeBrazilPhone } from '@omnisaude/messaging';
import {
  agenteHepatite,
  calcularPrazo,
  CLASSIFICACAO_FINAL,
  CRITERIO_CONFIRMACAO,
  camposDeConclusao,
  cidRespiratorioAgudo,
  exameVigilancia,
  POSITIVO,
  sinaisDeSrag,
  type ResultadoQualitativo,
  EVOLUCAO_CASO,
  numeracaoConclusao,
  usaConclusaoEsus,
  exigeComunicacaoPolicial,
  orientacaoViolencia,
  ageInYears,
  numeroOficialValido,
  validarConclusao,
  validarEncerramento,
  PRAZO_POLICIAL_HORAS,
  SISTEMA_INFO,
  SITUACAO_ROTA_LABEL,
  type SistemaOficial,
  CONTEXTO_LABEL,
  escolherCondicao,
  ESFERA_LABEL,
  gruposDaGestacao,
  JANELA_UNICA_DIAS,
  localDateString,
  MARCO_LABEL,
  mapearCodigo,
  normalizarCodigo,
  prazoRepasse,
  REPETICAO_DIAS,
  roleHasPermission,
  semanaEpidemiologica,
  situacaoDoPrazo,
  UF_AMAZONIA_LEGAL,
  type ContextoAgravo,
  type Esfera,
  type Role,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { MASTER_DB, TenantsService } from '../../core/database';
import { conflict, DomainError, forbidden, notFound } from '../../core/errors';
import { RealtimeService } from '../../core/realtime.service';
import { JobsService } from '../integrations/jobs.service';
import { MessagingService, type SystemContext } from '../integrations/messaging.service';
import { CatalogoVigilanciaService, type CondicaoNoRetrato } from './catalogo.service';
import { CAMPOS_EDITAVEIS, montarFicha, semanasDaFicha, validarFicha, type Ficha } from './ficha';

const DIA = 86_400_000;
const RESTRITO = 'Agravo de acesso restrito';
/** Teto das notificações pendentes lidas de uma vez (cartões, filtro de prazo, resumo). */
const LIMITE_PENDENTES = 2000;
/** Sem comunicação à SMS por meio rápido (telefone, e-mail, formulário...): a do painel não conta. */
const SEM_COMUNICACAO_SMS = { communications: { none: { target: 'SMS' as const, channel: { not: 'SISTEMA' as const } } } };

type Comunicacao = Awaited<ReturnType<TenantClient['notificationCommunication']['findMany']>>[number];
type DestinoComunicacao = Esfera | 'AUTORIDADE_POLICIAL';
interface LinhaEsfera {
  esfera: DestinoComunicacao;
  rotulo: string;
  venceEm: string | null;
  cumpridaEm: string | null;
  situacao: ReturnType<typeof situacaoDoPrazo>;
}
const REPASSE = (e: { esfera: string }) => e.esfera === 'SES' || e.esfera === 'MS';
type Origem = 'ATENDIMENTO' | 'OBITO' | 'INTERNACAO' | 'MANUAL' | 'VACINA' | 'VARREDURA' | 'EXAME';
/** Catálogo e de-para carregados uma vez por execução da tarefa periódica. */
interface Memo {
  retratos: Map<string, CondicaoNoRetrato[]>;
  mapas?: { system: string; codePrefix: string; groupKey: string; context: string | null; status: string }[];
}

interface Autor {
  userId: string;
  role: Role;
  cbo: string | null;
  unitId: string;
}

export interface RascunhoCriado {
  id: string;
  numero: string;
  agravo: string;
  prazo: 'IMEDIATA' | 'SEMANAL';
  esferas: Esfera[];
  venceEm: string | null;
  sigiloso: boolean;
  naoHomologado: boolean;
}

/**
 * Notificação compulsória (VIG-1a), conforme o Anexo V da PRC GM/MS nº 4/2017:
 * - quem atende notifica a suspeita ou a confirmação (art. 3º); o sistema abre o rascunho sozinho ao assinar um
 *   registro com código notificável, no óbito e na internação, sem bloquear o atendimento;
 * - imediata em 24 h a partir do primeiro atendimento (art. 4º) e semanal em 7 dias do conhecimento (art. 2º, VIII);
 * - quem recebe (SMS) repassa às demais esferas em 24 h (art. 4º, parágrafo único);
 * - sigilo (art. 7º) para HIV, sífilis e violências: só o autor e a vigilância abrem, e cada leitura é auditada.
 * Não há envio automático aos sistemas federais: o registro no Sinan e nos demais é a fila de digitação (semana 24).
 */
@Injectable()
export class NotificacaoService implements OnModuleInit {
  private readonly logger = new Logger('Vigilancia');

  constructor(
    private readonly catalogo: CatalogoVigilanciaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly messaging: MessagingService,
    private readonly jobs: JobsService,
    @Inject(MASTER_DB) private readonly master: MasterClient,
    private readonly tenants: TenantsService,
  ) {}

  onModuleInit() {
    this.jobs.register('vigilancia', (sys) => this.tarefa(sys));
  }

  // ───────────────────────────── gatilho ─────────────────────────────

  /** Depois da assinatura de um registro clínico: um rascunho por agravo notificável encontrado nos códigos. */
  async aoAssinarRegistro(ctx: RequestContext, nota: { id: string; encounterId: string; codes: string[]; signedAt: Date | null }): Promise<RascunhoCriado[]> {
    return this.protegido(ctx, { entityType: 'Encounter', id: nota.encounterId }, () =>
      this.processarCodigos(ctx, { encounterId: nota.encounterId, noteId: nota.id, codes: nota.codes, conhecimento: nota.signedAt ?? new Date(), origem: 'ATENDIMENTO', autor: this.autor(ctx) }),
    );
  }

  /** Encerramento do atendimento: CID principal e, se óbito, as linhas de óbito dos agravos já notificados. */
  async aoEncerrarAtendimento(ctx: RequestContext, encontro: { id: string; mainCid: string | null; outcome: string | null }): Promise<RascunhoCriado[]> {
    return this.protegido(ctx, { entityType: 'Encounter', id: encontro.id }, () => this.encerramento(ctx, encontro, this.autor(ctx), new Date(), 'ATENDIMENTO'));
  }

  private async encerramento(sys: SystemContext, encontro: { id: string; mainCid: string | null; outcome: string | null }, autor: Autor, quando: Date, origem: Origem, memo?: Memo) {
    // Primeiro o óbito ligado aos casos já notificados (guarda a relação); depois o CID principal, que não repete.
    const criados = encontro.outcome === 'OBITO' ? await this.obitosLigados(sys, encontro.id, autor, memo) : [];
    if (encontro.mainCid)
      criados.push(
        ...(await this.processarCodigos(
          sys,
          { encounterId: encontro.id, codes: [encontro.mainCid], conhecimento: quando, origem: encontro.outcome === 'OBITO' && origem !== 'VARREDURA' ? 'OBITO' : origem, autor },
          memo,
        )),
      );
    return criados;
  }

  /** Internação: CID principal, com o prazo contado do conhecimento (a suspeita pode surgir dias depois). */
  async aoInternar(ctx: RequestContext, internacao: { id: string; encounterId: string; mainCid: string }): Promise<RascunhoCriado[]> {
    return this.protegido(ctx, { entityType: 'Admission', id: internacao.id }, () => this.internacao(ctx, internacao, this.autor(ctx), new Date(), 'INTERNACAO'));
  }

  private async internacao(sys: SystemContext, internacao: { id: string; encounterId: string; mainCid: string }, autor: Autor, quando: Date, origem: Origem, memo?: Memo) {
    const criados = await this.processarCodigos(sys, { encounterId: internacao.encounterId, admissionId: internacao.id, codes: [internacao.mainCid], conhecimento: quando, origem, autor }, memo);
    const srag = await this.sragNaInternacao(sys, internacao, autor, quando, origem, memo);
    if (srag) criados.push(srag);
    return criados;
  }

  /** Sinais de Srag na triagem mais recente do paciente (até 48 h antes da internação). */
  private async sinaisDaTriagem(sys: SystemContext, patientId: string, ate: Date) {
    const t = await sys.db.triage.findFirst({
      where: { encounter: { patientId }, classifiedAt: { gte: new Date(ate.getTime() - 2 * DIA), lte: new Date(ate.getTime() + 60_000) } },
      orderBy: { classifiedAt: 'desc' },
      include: { encounter: { select: { patient: { select: { birthDate: true } } } } },
    });
    if (!t) return [];
    const nasc = t.encounter.patient.birthDate;
    const meses = (ate.getUTCFullYear() - nasc.getUTCFullYear()) * 12 + (ate.getUTCMonth() - nasc.getUTCMonth());
    return sinaisDeSrag({ spo2: t.spo2, frequenciaRespiratoria: t.respiratoryRate, desconfortoRespiratorio: t.flags.includes('desconforto_respiratorio') }, meses);
  }

  /**
   * Srag hospitalizada (item 59, c): internação com CID respiratório agudo e sinal de gravidade na triagem abre o
   * rascunho (destino Sivep-Gripe). Só um dos dois vira sugestão no painel da vigilância.
   */
  private async sragNaInternacao(sys: SystemContext, internacao: { id: string; encounterId: string; mainCid: string }, autor: Autor, quando: Date, origem: Origem, memo?: Memo) {
    if (!cidRespiratorioAgudo(internacao.mainCid)) return null;
    const e = await sys.db.encounter.findUnique({ where: { id: internacao.encounterId }, include: { unit: true } });
    if (!e) return null;
    const sinais = await this.sinaisDaTriagem(sys, e.patientId, quando);
    if (!sinais.length) return null;
    const catalogo = await this.catalogoDoDia(sys, localDateString(e.startedAt, sys.tenant.timeZone), memo);
    const condicao = escolherCondicao(catalogo, 'srag-coronavirus', { obito: false, gestante: false, amazoniaLegal: true, dica: null });
    if (!condicao) return null;
    const cod = normalizarCodigo(internacao.mainCid);
    return this.criarRascunho(sys, {
      condicao,
      patientId: e.patientId,
      encounterId: e.id,
      admissionId: internacao.id,
      unitId: e.unitId,
      autor,
      origem,
      codigo: cod ? { system: cod.system, code: cod.code } : null,
      mapStatus: null,
      primeiroAtendimento: e.startedAt,
      conhecimento: quando,
      internacao: true,
      confirmacao: null,
      gestante: false,
    });
  }

  /** Internações recentes com indício de Srag ainda sem notificação: CID respiratório ou sinal de gravidade, não os dois. */
  async sugestoesSrag(ctx: RequestContext) {
    const desde = new Date(Date.now() - 10 * DIA);
    const adm = await ctx.db.admission.findMany({
      where: { admittedAt: { gte: desde }, ...(ctx.session.role === 'NUCLEO_VIGILANCIA' ? { encounter: { unitId: ctx.session.unitId } } : {}) },
      include: { encounter: { include: { unit: { select: { name: true } }, patient: { select: { id: true, name: true, socialName: true } } } } },
      orderBy: { admittedAt: 'desc' },
      take: 200,
    });
    const saida = [];
    for (const a of adm) {
      const ja = await ctx.db.notification.findFirst({ where: { patientId: a.encounter.patientId, groupKey: 'srag-coronavirus', createdAt: { gte: new Date(a.admittedAt.getTime() - 30 * DIA) } }, select: { id: true } });
      if (ja) continue;
      const respiratorio = cidRespiratorioAgudo(a.mainCid);
      const sinais = await this.sinaisDaTriagem(ctx, a.encounter.patientId, a.admittedAt);
      if (!respiratorio && !sinais.length) continue;
      saida.push({
        admissionId: a.id,
        encounterId: a.encounterId,
        patientId: a.encounter.patientId,
        paciente: a.encounter.patient.socialName ?? a.encounter.patient.name,
        unidade: a.encounter.unit.name,
        internadoEm: a.admittedAt.toISOString(),
        cid: a.mainCid,
        cidRespiratorio: respiratorio,
        sinais,
      });
    }
    return saida;
  }

  // ───────────────────────────── resultado de exame ─────────────────────────────

  /**
   * Resultado positivo de exame de vigilância: confirma a notificação ativa do agravo (o item notificado na
   * confirmação passa a ter prazo contado do resultado) ou abre uma nova, já confirmada.
   */
  async aoResultadoExame(ctx: RequestContext, exame: { id: string; patientId: string; encounterId: string | null; examKey: string | null; qualitative: string | null; resultAt: Date | null }): Promise<RascunhoCriado[]> {
    const cat = exameVigilancia(exame.examKey);
    if (!cat || !exame.qualitative || !POSITIVO.includes(exame.qualitative as ResultadoQualitativo)) return [];
    return this.protegido(ctx, { entityType: 'ExamRequest', id: exame.id }, () => this.resultadoPositivo(ctx, exame, this.autor(ctx), 'EXAME'));
  }

  private async resultadoPositivo(
    sys: SystemContext,
    exame: { id: string; patientId: string; encounterId: string | null; examKey: string | null; resultAt: Date | null },
    autor: Autor,
    origem: Origem,
    memo?: Memo,
  ): Promise<RascunhoCriado[]> {
    const cat = exameVigilancia(exame.examKey)!;
    const resultado = exame.resultAt ?? new Date();
    const ativa = await sys.db.notification.findFirst({
      where: { patientId: exame.patientId, groupKey: cat.grupo, status: { in: ['RASCUNHO', 'NOTIFICADA'] }, condition: { context: { not: 'OBITO' } }, createdAt: { gte: new Date(Date.now() - REPETICAO_DIAS * DIA) } },
      include: { condition: true },
      orderBy: { createdAt: 'desc' },
    });
    if (ativa) {
      if (ativa.basis === 'CONFIRMADO' && ativa.confirmedAt) return [];
      const prazo = calcularPrazo(ativa.condition, { atendimento: ativa.firstCareAt, conhecimento: ativa.knownAt, confirmacao: resultado, internacao: ativa.origin === 'INTERNACAO' || !!ativa.admissionId });
      // Só o item que se notifica na confirmação muda de prazo; os demais mantêm o prazo da suspeita.
      const muda = ativa.deadlineStart === 'CONFIRMACAO';
      const { count } = await sys.db.notification.updateMany({
        where: { id: ativa.id, updatedAt: ativa.updatedAt },
        data: { basis: 'CONFIRMADO', confirmedAt: resultado, ...(muda ? { deadlineStartAt: prazo.inicio, dueAt: prazo.vence } : {}) },
      });
      if (count === 1) {
        await sys.db.notificationEvent.create({ data: { notificationId: ativa.id, kind: 'RESULTADO_EXAME', userId: autor.userId, data: { exame: cat.key, examRequestId: exame.id } } });
        this.avisar(sys, ativa);
      }
      return [];
    }
    const e = exame.encounterId ? await sys.db.encounter.findUnique({ where: { id: exame.encounterId }, include: { unit: true } }) : null;
    const catalogo = await this.catalogoDoDia(sys, localDateString(e?.startedAt ?? resultado, sys.tenant.timeZone), memo);
    const gestante = (await sys.db.patientCondition.count({ where: { patientId: exame.patientId, active: true, lineOfCare: 'GESTANTE' } })) > 0;
    const paciente = await sys.db.patient.findUniqueOrThrow({ where: { id: exame.patientId }, select: { deceasedAt: true } });
    const unidade = e?.unit ?? (await sys.db.unit.findUniqueOrThrow({ where: { id: autor.unitId } }));
    const condicao = escolherCondicao(catalogo, cat.grupo, { obito: !!paciente.deceasedAt, gestante, amazoniaLegal: UF_AMAZONIA_LEGAL.has(unidade.ibgeCode.slice(0, 2)), dica: null });
    if (!condicao) return [];
    const r = await this.criarRascunho(sys, {
      condicao,
      patientId: exame.patientId,
      encounterId: e?.id ?? null,
      unitId: e?.unitId ?? autor.unitId,
      autor,
      origem,
      codigo: { system: 'CID10', code: cat.cid },
      mapStatus: null,
      primeiroAtendimento: e?.startedAt ?? null,
      conhecimento: resultado,
      internacao: e?.kind === 'INTERNACAO',
      confirmacao: resultado,
      gestante,
    });
    return r ? [r] : [];
  }

  /**
   * O gatilho nunca impede o atendimento: a falha fica na trilha de auditoria (atendimento ou internação) e a tarefa
   * periódica reprocessa a partir dela por 48 h; os registros assinados também são varridos.
   */
  private async protegido(ctx: RequestContext, alvo: { entityType: 'Encounter' | 'Admission' | 'ExamRequest'; id: string }, fn: () => Promise<RascunhoCriado[]>): Promise<RascunhoCriado[]> {
    try {
      return await fn();
    } catch (err) {
      const erro = (err as Error).message;
      this.logger.error(`Gatilho de notificação falhou (${alvo.entityType} ${alvo.id}): ${erro}`);
      await this.audit.recordStandalone(ctx, { action: 'vigilancia.erro_gatilho', entityType: alvo.entityType, entityId: alvo.id, payload: { erro: erro.slice(0, 500) } }).catch(() => undefined);
      return [];
    }
  }

  private autor(ctx: RequestContext): Autor {
    return { userId: ctx.session.userId, role: ctx.session.role, cbo: ctx.cbo ?? null, unitId: ctx.session.unitId };
  }

  /** Catálogo e de-para reaproveitados dentro de uma execução da tarefa periódica. */
  private async catalogoDoDia(sys: SystemContext, dia: string, memo?: Memo) {
    const pronto = memo?.retratos.get(dia);
    if (pronto) return pronto;
    const { catalogo } = await this.catalogo.retrato(sys, dia);
    memo?.retratos.set(dia, catalogo);
    return catalogo;
  }

  private async mapasDoCodigo(sys: SystemContext, system: 'CID10' | 'CIAP2', code: string, memo?: Memo) {
    if (!memo) return this.catalogo.gruposDoCodigo(sys, system, code);
    memo.mapas ??= await sys.db.notifiableCodeMap.findMany({ where: { status: { not: 'INATIVO' } } });
    return mapearCodigo(memo.mapas, system, code);
  }

  private async processarCodigos(
    sys: SystemContext,
    p: { encounterId: string; noteId?: string; admissionId?: string; codes: string[]; conhecimento: Date; origem: Origem; autor: Autor },
    memo?: Memo,
  ): Promise<RascunhoCriado[]> {
    const e = await sys.db.encounter.findUnique({ where: { id: p.encounterId }, include: { unit: true, patient: { select: { id: true, deceasedAt: true } } } });
    if (!e) return [];
    const catalogo = await this.catalogoDoDia(sys, localDateString(e.startedAt, sys.tenant.timeZone), memo);
    const gestante = (await sys.db.patientCondition.count({ where: { patientId: e.patientId, active: true, lineOfCare: 'GESTANTE' } })) > 0;
    const criados: RascunhoCriado[] = [];
    const vistos = new Set<string>();
    for (const bruto of p.codes) {
      const cod = normalizarCodigo(bruto);
      if (!cod) continue;
      const mapas = await this.mapasDoCodigo(sys, cod.system, cod.code, memo);
      const candidatos = mapas.map((m) => ({ groupKey: m.groupKey, context: m.context as ContextoAgravo | null, status: m.status as 'PROPOSTO' | 'HOMOLOGADO' }));
      // Gestante: o mesmo código abre também a linha própria da gestação (HIV, hepatite B, HTLV, toxoplasmose).
      if (gestante)
        for (const g of gruposDaGestacao(
          cod.system,
          cod.code,
          mapas.map((m) => m.groupKey),
        ))
          candidatos.push({ groupKey: g, context: null, status: (mapas[0]?.status as 'PROPOSTO' | 'HOMOLOGADO' | undefined) ?? 'PROPOSTO' });
      for (const m of candidatos) {
        const condicao = escolherCondicao(catalogo, m.groupKey, {
          obito: p.origem === 'OBITO' || e.outcome === 'OBITO' || !!e.patient.deceasedAt,
          gestante,
          amazoniaLegal: UF_AMAZONIA_LEGAL.has(e.unit.ibgeCode.slice(0, 2)),
          dica: m.context,
        });
        if (!condicao || vistos.has(condicao.key)) continue;
        vistos.add(condicao.key);
        const r = await this.criarRascunho(sys, {
          condicao,
          patientId: e.patientId,
          encounterId: e.id,
          noteId: p.noteId,
          admissionId: p.admissionId,
          unitId: e.unitId,
          autor: p.autor,
          origem: p.origem,
          codigo: { system: cod.system, code: cod.code },
          mapStatus: m.status,
          primeiroAtendimento: e.startedAt,
          conhecimento: p.conhecimento,
          internacao: e.kind === 'INTERNACAO' || p.origem === 'INTERNACAO' || !!p.admissionId,
          // U07.1 já é covid-19 confirmada por laboratório: o prazo do item 60 conta da confirmação.
          confirmacao: condicao.notifyOn === 'CONFIRMACAO' && cod.code === 'U071' ? p.conhecimento : null,
          gestante,
        });
        if (r) criados.push(r);
      }
    }
    return criados;
  }

  /**
   * Óbito: para cada caso ativo da pessoa (neste atendimento ou nos últimos 30 dias, inclusive em outra unidade) cujo
   * grupo tem linha de óbito, abre a notificação do óbito neste atendimento, ligada ao caso.
   */
  private async obitosLigados(sys: SystemContext, encounterId: string, autor: Autor, memo?: Memo): Promise<RascunhoCriado[]> {
    const e = await sys.db.encounter.findUniqueOrThrow({ where: { id: encounterId }, include: { unit: true } });
    const casos = await sys.db.notification.findMany({
      where: {
        patientId: e.patientId,
        status: { not: 'DESCARTADA' },
        condition: { context: { not: 'OBITO' } },
        OR: [{ encounterId }, { createdAt: { gte: new Date(Date.now() - REPETICAO_DIAS * DIA) } }],
      },
      orderBy: { createdAt: 'desc' },
    });
    const catalogo = await this.catalogoDoDia(sys, localDateString(e.startedAt, sys.tenant.timeZone), memo);
    const criados: RascunhoCriado[] = [];
    const grupos = new Set<string>();
    for (const caso of casos) {
      if (grupos.has(caso.groupKey)) continue;
      grupos.add(caso.groupKey);
      const obito = catalogo.find((c) => c.groupKey === caso.groupKey && c.context === 'OBITO');
      if (!obito) continue;
      const r = await this.criarRascunho(sys, {
        condicao: obito,
        patientId: e.patientId,
        encounterId,
        unitId: e.unitId,
        autor,
        origem: 'OBITO',
        codigo: caso.codeSystem && caso.code ? { system: caso.codeSystem as 'CID10' | 'CIAP2', code: caso.code } : null,
        mapStatus: caso.mapStatus as 'PROPOSTO' | 'HOMOLOGADO' | null,
        primeiroAtendimento: e.startedAt,
        conhecimento: new Date(),
        internacao: e.kind === 'INTERNACAO',
        confirmacao: null,
        gestante: false,
        relacionada: caso.id,
      });
      if (r) criados.push(r);
    }
    return criados;
  }

  /**
   * Já existe notificação deste agravo para o caso? Compara pelo grupo (trocar o subitem não abre outra), separando
   * a linha de óbito. No mesmo atendimento vale qualquer situação: o que a vigilância descartou não é reaberto pelo
   * próximo registro (só à mão). Na mesma pessoa, 30 dias; "uma vez por pessoa" sem prazo (tuberculose, 180 dias;
   * hepatites, por agente).
   */
  private async jaNotificada(sys: SystemContext, c: CondicaoNoRetrato, p: { patientId: string; encounterId?: string | null; codigo: { code: string } | null }) {
    const classe = { groupKey: c.groupKey, condition: { context: c.context === 'OBITO' ? ('OBITO' as const) : { not: 'OBITO' as const } } };
    if (p.encounterId && (await sys.db.notification.findFirst({ where: { encounterId: p.encounterId, ...classe }, select: { id: true } }))) return true;
    const janela = c.once ? (JANELA_UNICA_DIAS[c.groupKey] ?? null) : REPETICAO_DIAS;
    const anteriores = await sys.db.notification.findMany({
      where: { patientId: p.patientId, status: { not: 'DESCARTADA' }, ...classe, ...(janela ? { createdAt: { gte: new Date(Date.now() - janela * DIA) } } : {}) },
      select: { code: true },
    });
    if (c.groupKey === 'hepatites-virais') return anteriores.some((a) => agenteHepatite(a.code) === agenteHepatite(p.codigo?.code));
    return anteriores.length > 0;
  }

  private async criarRascunho(
    sys: SystemContext,
    p: {
      condicao: CondicaoNoRetrato;
      patientId: string;
      encounterId?: string | null;
      noteId?: string;
      admissionId?: string;
      vaccinationId?: string;
      unitId: string;
      autor: Autor;
      origem: Origem;
      codigo: { system: 'CID10' | 'CIAP2'; code: string } | null;
      mapStatus: 'PROPOSTO' | 'HOMOLOGADO' | null;
      primeiroAtendimento: Date | null;
      conhecimento: Date;
      internacao: boolean;
      confirmacao: Date | null;
      gestante: boolean;
      relacionada?: string;
      sintomas?: string | null;
      manual?: boolean;
    },
  ): Promise<RascunhoCriado | null> {
    const c = p.condicao;
    if (!p.manual && (await this.jaNotificada(sys, c, p))) return null;
    const [patient, unit, autor, household] = await Promise.all([
      sys.db.patient.findUniqueOrThrow({ where: { id: p.patientId } }),
      sys.db.unit.findUniqueOrThrow({ where: { id: p.unitId } }),
      sys.db.user.findUniqueOrThrow({ where: { id: p.autor.userId }, select: { name: true, socialName: true } }),
      sys.db.patient.findUnique({ where: { id: p.patientId }, select: { family: { select: { household: { select: { latitude: true, longitude: true } } } } } }),
    ]);
    const prazo = calcularPrazo(c, { atendimento: p.primeiroAtendimento, conhecimento: p.conhecimento, confirmacao: p.confirmacao, internacao: p.internacao });
    const ficha = montarFicha({
      condicao: { name: c.name, item: c.item, subitem: c.subitem },
      codigo: p.codigo?.code ?? null,
      unidade: { cnes: unit.cnes, name: unit.name, ibgeCode: unit.ibgeCode },
      paciente: {
        name: patient.name,
        birthDate: patient.birthDate,
        sex: patient.sex,
        racaCor: patient.racaCor,
        education: patient.education,
        cns: patient.cns,
        motherName: patient.motherName,
        ibgeCode: patient.ibgeCode,
        district: patient.district,
        street: patient.street,
        number: patient.number,
        complement: patient.complement,
        cep: patient.cep,
        phone: patient.phone,
      },
      gestante: p.gestante,
      residencia: { lat: household?.family?.household.latitude ?? null, lng: household?.family?.household.longitude ?? null },
      notificador: { nome: autor.socialName ?? autor.name, cbo: p.autor.cbo, funcao: p.autor.role },
      referencia: p.conhecimento,
    });
    if (p.sintomas) ficha.DT_SIN_PRI = p.sintomas;
    // Violência interpessoal contra a mulher de 18 a 59 anos (exceto lesão autoprovocada): autoridade policial em 24 h.
    const policial = exigeComunicacaoPolicial({ groupKey: c.groupKey, code: p.codigo?.code ?? null }, patient.sex, ageInYears(patient.birthDate, p.conhecimento));
    // Município de residência só com o código IBGE de 7 dígitos (o cadastro aceita outros formatos).
    const ibgeResidencia = patient.ibgeCode && /^\d{7}$/.test(patient.ibgeCode) ? patient.ibgeCode : null;
    const ano = Number(localDateString(new Date(), sys.tenant.timeZone).slice(0, 4));
    for (let tentativa = 0; tentativa < 6; tentativa++) {
      const ultimo = await sys.db.notification.findFirst({ where: { year: ano }, orderBy: { seq: 'desc' }, select: { seq: true } });
      const seq = (ultimo?.seq ?? 0) + 1 + tentativa;
      try {
        const n = await sys.db.notification.create({
          data: {
            year: ano,
            seq,
            number: `${ano}/${String(seq).padStart(6, '0')}`,
            origin: p.origem,
            conditionId: c.id,
            conditionKey: c.key,
            groupKey: c.groupKey,
            basis: p.confirmacao ? 'CONFIRMADO' : 'SUSPEITA',
            codeSystem: p.codigo?.system ?? null,
            code: p.codigo?.code ?? null,
            mapStatus: p.mapStatus,
            patientId: p.patientId,
            encounterId: p.encounterId ?? null,
            noteId: p.noteId ?? null,
            admissionId: p.admissionId ?? null,
            vaccinationId: p.vaccinationId ?? null,
            relatedNotificationId: p.relacionada ?? null,
            unitId: p.unitId,
            notifierId: p.autor.userId,
            notifierCbo: p.autor.cbo,
            notifierRole: p.autor.role,
            firstCareAt: p.primeiroAtendimento,
            knownAt: p.conhecimento,
            confirmedAt: p.confirmacao,
            deadlineStart: prazo.marco,
            deadlineKind: prazo.tipo,
            targets: prazo.esferas,
            deadlineStartAt: prazo.inicio,
            dueAt: prazo.vence,
            symptomsOnset: p.sintomas ? new Date(`${p.sintomas}T00:00:00Z`) : null,
            epiWeekOnset: p.sintomas ? semanasDaFicha(null, p.sintomas).SEM_PRI : null,
            sensitive: c.sensitive,
            form: ficha as object,
            residenceIbge: ibgeResidencia,
            residenceLat: ficha.ID_GEO1,
            residenceLng: ficha.ID_GEO2,
            outOfMunicipality: !!ibgeResidencia && ibgeResidencia !== unit.ibgeCode,
            policeRequired: policial,
            policeDueAt: policial ? new Date(p.conhecimento.getTime() + PRAZO_POLICIAL_HORAS * 3_600_000) : null,
            createdBy: p.autor.userId,
            events: {
              create: {
                kind: p.manual ? 'CRIADA_MANUAL' : 'GERADA_PELO_GATILHO',
                userId: p.autor.userId,
                data: { origem: p.origem, codigo: p.codigo ? `${p.codigo.system}:${p.codigo.code}` : null, mapeamento: p.mapStatus },
              },
            },
          },
        });
        this.avisar(sys, n);
        return {
          id: n.id,
          numero: n.number,
          agravo: c.name,
          prazo: prazo.tipo,
          esferas: prazo.esferas,
          venceEm: prazo.vence?.toISOString() ?? null,
          sigiloso: c.sensitive,
          naoHomologado: p.mapStatus === 'PROPOSTO',
        };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'P2002') throw err;
        // Mesmo atendimento e agravo já tem rascunho ativo (índice único): idempotência do gatilho.
        if (p.encounterId && (await sys.db.notification.findFirst({ where: { encounterId: p.encounterId, conditionKey: c.key, status: { not: 'DESCARTADA' } } }))) return null;
      }
    }
    throw new DomainError('NUMERACAO_INDISPONIVEL', 'Não foi possível numerar a notificação; tente de novo');
  }

  /**
   * Evento em tempo real só com o id: as salas do tenant e da unidade incluem a recepção e os painéis de TV, então
   * nada que indique o agravo (nem "sigiloso" ou o prazo) vai no evento; a tela recarrega pela API, que aplica o alcance.
   */
  private avisar(sys: { tenant: { id: string } }, n: { id: string; unitId: string }) {
    this.realtime.emitToTenant(sys.tenant.id, 'vigilancia:notificacao', { id: n.id });
    this.realtime.emitToUnit(sys.tenant.id, n.unitId, 'vigilancia:notificacao', { id: n.id });
  }

  // ───────────────────────────── notificação manual ─────────────────────────────

  async criarManual(ctx: RequestContext, input: { patientId: string; conditionKey: string; encounterId?: string | null; vaccinationId?: string | null; knownAt?: string | null; symptomsOnset?: string | null }) {
    const agora = new Date();
    const conhecimento = input.knownAt ? new Date(input.knownAt) : agora;
    if (conhecimento.getTime() > agora.getTime() + 60_000) throw new DomainError('DATA_FUTURA', 'A data de conhecimento não pode ser futura', HttpStatus.BAD_REQUEST);
    if (input.symptomsOnset && input.symptomsOnset > localDateString(agora, ctx.tenant.timeZone)) throw new DomainError('DATA_FUTURA', 'A data dos primeiros sintomas não pode ser futura', HttpStatus.BAD_REQUEST);
    const paciente = await ctx.db.patient.findUnique({ where: { id: input.patientId } });
    if (!paciente || paciente.mergedIntoId) throw notFound('Paciente');
    // O atendimento é o do caso (para o ESAVI, o do evento adverso, não o da aplicação da dose).
    const encontro = input.encounterId ? await ctx.db.encounter.findUnique({ where: { id: input.encounterId } }) : null;
    if (input.encounterId && (!encontro || encontro.patientId !== input.patientId)) throw notFound('Atendimento');
    if (input.vaccinationId) {
      const vac = await ctx.db.vaccination.findUnique({ where: { id: input.vaccinationId } });
      if (!vac || vac.patientId !== input.patientId) throw notFound('Vacinação');
      const ativa = await ctx.db.notification.findFirst({ where: { vaccinationId: vac.id, status: { not: 'DESCARTADA' } }, select: { number: true } });
      if (ativa) throw new DomainError('JA_NOTIFICADA', `Esta dose já tem a notificação ${ativa.number}`, HttpStatus.CONFLICT);
    }
    // Lista vigente na data do primeiro atendimento; sem atendimento, na do conhecimento.
    const catalogo = await this.catalogoDoDia(ctx, localDateString(encontro?.startedAt ?? conhecimento, ctx.tenant.timeZone));
    const condicao = catalogo.find((c) => c.key === input.conditionKey);
    if (!condicao) throw new DomainError('AGRAVO_FORA_DA_LISTA', 'Agravo não consta da lista vigente na data', HttpStatus.BAD_REQUEST);
    const gestante = (await ctx.db.patientCondition.count({ where: { patientId: input.patientId, active: true, lineOfCare: 'GESTANTE' } })) > 0;
    const r = await this.criarRascunho(ctx, {
      condicao,
      patientId: input.patientId,
      encounterId: encontro?.id ?? null,
      vaccinationId: input.vaccinationId ?? undefined,
      unitId: ctx.session.unitId,
      autor: this.autor(ctx),
      origem: input.vaccinationId ? 'VACINA' : 'MANUAL',
      codigo: null,
      mapStatus: null,
      primeiroAtendimento: encontro?.startedAt ?? null,
      conhecimento,
      internacao: encontro?.kind === 'INTERNACAO',
      confirmacao: null,
      gestante,
      sintomas: input.symptomsOnset ?? null,
      manual: true,
    });
    if (!r) throw new DomainError('JA_NOTIFICADA', 'Já existe notificação ativa deste agravo neste atendimento', HttpStatus.CONFLICT);
    return this.detalhe(ctx, r.id);
  }

  // ───────────────────────────── alcance e sigilo ─────────────────────────────

  private pode(ctx: RequestContext, p: Parameters<typeof roleHasPermission>[1]) {
    return roleHasPermission(ctx.session.role, p);
  }

  /** Quem vê a notificação: a vigilância municipal (todas), o núcleo (da unidade) e o autor (as suas). */
  private alcance(ctx: RequestContext, n: { notifierId: string; unitId: string }) {
    if (ctx.session.role === 'VIGILANCIA_EPIDEMIOLOGICA') return true;
    if (ctx.session.role === 'NUCLEO_VIGILANCIA') return n.unitId === ctx.session.unitId;
    return n.notifierId === ctx.session.userId;
  }

  /** Sigilo (art. 7º): agravo sensível só abre para o autor, a vigilância municipal e o núcleo da unidade. */
  private abreSigiloso(ctx: RequestContext, n: { notifierId: string; unitId: string }) {
    if (n.notifierId === ctx.session.userId) return true;
    if (!this.pode(ctx, 'notificacao.sensivel')) return false;
    return ctx.session.role === 'VIGILANCIA_EPIDEMIOLOGICA' || (ctx.session.role === 'NUCLEO_VIGILANCIA' && n.unitId === ctx.session.unitId);
  }

  private where(ctx: RequestContext) {
    if (ctx.session.role === 'VIGILANCIA_EPIDEMIOLOGICA') return {};
    if (ctx.session.role === 'NUCLEO_VIGILANCIA') return { unitId: ctx.session.unitId };
    return { notifierId: ctx.session.userId };
  }

  private async carregar(ctx: RequestContext, id: string, opts: { leitura?: boolean } = {}) {
    const n = await ctx.db.notification.findUnique({ where: { id }, include: { condition: true } });
    if (!n) throw notFound('Notificação');
    if (!this.alcance(ctx, n)) throw forbidden('Notificação fora do seu alcance');
    if (n.sensitive && !this.abreSigiloso(ctx, n)) throw forbidden('Agravo de acesso restrito');
    if (n.sensitive && opts.leitura) {
      await this.audit.recordStandalone(ctx, { action: 'notificacao.ler_sensivel', entityType: 'Notification', entityId: n.id, payload: { numero: n.number } });
    }
    return n;
  }

  // ───────────────────────────── telas ─────────────────────────────

  /** Situação do prazo por esfera: SMS (ciência ou comunicação pelo meio mais rápido) e repasse à SES e ao MS. */
  private async esferas(
    db: TenantClient,
    n: {
      id: string;
      deadlineKind: string;
      targets: string[];
      dueAt: Date | null;
      notifiedAt: Date | null;
      smsReceivedAt: Date | null;
      status: string;
      policeRequired?: boolean;
      policeDueAt?: Date | null;
      policeWaiver?: string | null;
    },
    agora = new Date(),
    carregadas?: Map<string, Comunicacao[]>,
  ): Promise<{ lista: LinhaEsfera[]; comunicacoes: Comunicacao[] }> {
    const comunicacoes = carregadas ? (carregadas.get(n.id) ?? []) : await db.notificationCommunication.findMany({ where: { notificationId: n.id }, orderBy: { communicatedAt: 'asc' } });
    const primeiraFora = (alvo: string) => comunicacoes.find((c) => c.target === alvo && c.channel !== 'SISTEMA')?.communicatedAt ?? null;
    const notificada = n.status === 'NOTIFICADA' || n.status === 'ENCERRADA';
    const smsCumprida = n.deadlineKind === 'IMEDIATA' ? ([n.smsReceivedAt, primeiraFora('SMS')].filter(Boolean).sort((a, b) => a!.getTime() - b!.getTime())[0] ?? null) : notificada ? n.notifiedAt : null;
    const lista: LinhaEsfera[] = (n.targets.length ? n.targets : ['SMS']).map((alvo) => {
      if (alvo === 'SMS')
        return { esfera: 'SMS' as const, rotulo: ESFERA_LABEL.SMS, venceEm: n.dueAt?.toISOString() ?? null, cumpridaEm: smsCumprida?.toISOString() ?? null, situacao: situacaoDoPrazo(n.dueAt, smsCumprida, agora) };
      // A SMS recebeu na ciência ou na primeira comunicação por meio rápido, o que veio antes (art. 4º, parágrafo único).
      const recebida = n.deadlineKind === 'IMEDIATA' ? smsCumprida : null;
      const vence = recebida ? prazoRepasse(recebida) : null;
      const feita = primeiraFora(alvo);
      return {
        esfera: alvo as Esfera,
        rotulo: ESFERA_LABEL[alvo as Esfera],
        venceEm: vence?.toISOString() ?? null,
        cumpridaEm: feita?.toISOString() ?? null,
        situacao: recebida ? situacaoDoPrazo(vence, feita, agora) : feita ? 'CUMPRIDO' : 'SEM_PRAZO',
      };
    });
    if (n.policeRequired && !n.policeWaiver) {
      const feita = comunicacoes.find((c) => c.target === 'AUTORIDADE_POLICIAL')?.communicatedAt ?? null;
      const vence = n.policeDueAt ?? null;
      lista.push({ esfera: 'AUTORIDADE_POLICIAL', rotulo: 'Autoridade policial', venceEm: vence?.toISOString() ?? null, cumpridaEm: feita?.toISOString() ?? null, situacao: situacaoDoPrazo(vence, feita, agora) });
    }
    return { lista, comunicacoes };
  }

  /** Comunicações de várias notificações numa consulta só (painel, resumo e tarefa periódica). */
  private async comunicacoesDe(db: TenantClient, ids: string[]) {
    const mapa = new Map<string, Comunicacao[]>();
    if (!ids.length) return mapa;
    for (const c of await db.notificationCommunication.findMany({ where: { notificationId: { in: ids } }, orderBy: { communicatedAt: 'asc' } })) {
      const lista = mapa.get(c.notificationId) ?? [];
      lista.push(c);
      mapa.set(c.notificationId, lista);
    }
    return mapa;
  }

  async detalhe(ctx: RequestContext, id: string) {
    const n = await this.carregar(ctx, id, { leitura: true });
    const [paciente, unidade, eventos, esferas, contatos] = await Promise.all([
      ctx.db.patient.findUniqueOrThrow({ where: { id: n.patientId }, select: { id: true, name: true, socialName: true, cns: true, birthDate: true } }),
      ctx.db.unit.findUniqueOrThrow({ where: { id: n.unitId }, select: { id: true, name: true, cnes: true } }),
      ctx.db.notificationEvent.findMany({ where: { notificationId: n.id }, orderBy: { at: 'asc' } }),
      this.esferas(ctx.db, n),
      ctx.db.surveillanceContact.findMany({ where: { active: true }, orderBy: [{ sphere: 'asc' }, { sort: 'asc' }] }),
    ]);
    const usuarios = new Map(
      (
        await ctx.db.user.findMany({
          where: { id: { in: [...new Set([n.notifierId, ...eventos.map((e) => e.userId), ...esferas.comunicacoes.map((c) => c.userId), n.smsReceivedBy, n.enteredBy, n.closedBy].filter((x): x is string => !!x))] } },
          select: { id: true, name: true },
        })
      ).map((u) => [u.id, u.name]),
    );
    const { catalogo } = await this.catalogo.retrato(ctx, localDateString(n.deadlineStartAt ?? n.knownAt, ctx.tenant.timeZone));
    return {
      id: n.id,
      numero: n.number,
      status: n.status,
      origem: n.origin,
      agravo: {
        id: n.conditionId,
        key: n.conditionKey,
        grupo: n.groupKey,
        nome: n.condition.name,
        item: n.condition.item,
        subitem: n.condition.subitem,
        contexto: n.condition.context,
        contextoLabel: CONTEXTO_LABEL[n.condition.context],
        marcas: { MS: n.condition.immediateMs, SES: n.condition.immediateSes, SMS: n.condition.immediateSms, semanal: n.condition.weekly },
        criterio: n.condition.notifyOn,
        emRevisao: n.condition.normativeStatus === 'EM_REVISAO',
        notaNormativa: n.condition.normativeNote,
      },
      subitens: catalogo
        .filter((c) => c.groupKey === n.groupKey)
        .map((c) => ({ key: c.key, nome: c.name, contexto: CONTEXTO_LABEL[c.context], marcas: { MS: c.immediateMs, SES: c.immediateSes, SMS: c.immediateSms, semanal: c.weekly } })),
      codigo: n.code ? { sistema: n.codeSystem, codigo: n.code } : null,
      naoHomologado: n.mapStatus === 'PROPOSTO',
      criterio: n.basis,
      sigiloso: n.sensitive,
      paciente: { id: paciente.id, nome: paciente.socialName ?? paciente.name, cns: paciente.cns },
      unidade,
      notificador: usuarios.get(n.notifierId) ?? null,
      prazo: {
        tipo: n.deadlineKind,
        esferas: n.targets,
        marco: n.deadlineStart,
        marcoLabel: MARCO_LABEL[n.deadlineStart],
        inicio: n.deadlineStartAt?.toISOString() ?? null,
        venceEm: n.dueAt?.toISOString() ?? null,
        aguardandoConfirmacao: n.deadlineStart === 'CONFIRMACAO' && !n.confirmedAt,
        porEsfera: esferas.lista,
      },
      datas: {
        primeiroAtendimento: n.firstCareAt?.toISOString() ?? null,
        conhecimento: n.knownAt.toISOString(),
        confirmacao: n.confirmedAt?.toISOString() ?? null,
        notificacao: n.notifiedAt?.toISOString() ?? null,
        sintomas: n.symptomsOnset?.toISOString().slice(0, 10) ?? null,
        semanaNotificacao: n.epiWeekNotified,
        semanaSintomas: n.epiWeekOnset,
      },
      ciencia: n.smsReceivedAt ? { em: n.smsReceivedAt.toISOString(), por: n.smsReceivedBy ? (usuarios.get(n.smsReceivedBy) ?? null) : null } : null,
      ficha: n.form as unknown as Ficha,
      foraDoMunicipio: n.outOfMunicipality,
      descarte: n.discardedAt ? { em: n.discardedAt.toISOString(), motivo: n.discardReason } : null,
      comunicacoes: esferas.comunicacoes.map((c) => ({
        id: c.id,
        esfera: c.target,
        meio: c.channel,
        em: c.communicatedAt.toISOString(),
        interlocutor: c.counterpartName,
        orgao: c.counterpartOrg,
        contato: c.contactValue,
        protocolo: c.protocol,
        notas: c.notes,
        por: usuarios.get(c.userId) ?? null,
      })),
      eventos: eventos.map((e) => ({ id: e.id, tipo: e.kind, em: e.at.toISOString(), por: e.userId ? (usuarios.get(e.userId) ?? null) : null, notas: e.notes })),
      contatos: contatos.map((c) => ({ id: c.id, esfera: c.sphere, nome: c.label, telefone: c.phone, email: c.email, formulario: c.formUrl, horario: c.hours, plantao: c.onCall })),
      saida: n.officialSystem
        ? {
            sistema: n.officialSystem,
            sistemaLabel: SISTEMA_INFO[n.officialSystem as SistemaOficial].label,
            digitacao: n.entryStatus,
            numero: n.officialNumber,
            lote: n.officialBatch,
            digitadaPor: n.enteredBy ? (usuarios.get(n.enteredBy) ?? null) : null,
            digitadaEm: n.enteredAt?.toISOString() ?? null,
            dicaNumero: SISTEMA_INFO[n.officialSystem as SistemaOficial].numero.dica,
            rota: await this.catalogo
              .rotaNaData(ctx, { key: n.conditionKey, groupKey: n.groupKey }, localDateString(n.notifiedAt ?? n.knownAt, ctx.tenant.timeZone))
              .then((r) => ({ ...r, situacaoLabel: SITUACAO_ROTA_LABEL[r.situacao] })),
          }
        : null,
      encerramento: {
        investigadaEm: n.investigatedAt?.toISOString().slice(0, 10) ?? null,
        classificacao: n.finalClass,
        classificacaoLabel: n.finalClass ? (CLASSIFICACAO_FINAL[n.finalClass] ?? n.finalClass) : null,
        criterio: n.criterion,
        criterioLabel: n.criterion ? (CRITERIO_CONFIRMACAO[n.criterion] ?? n.criterion) : null,
        evolucao: n.evolution,
        evolucaoLabel: n.evolution ? (EVOLUCAO_CASO[n.evolution] ?? n.evolution) : null,
        obitoEm: n.deathDate?.toISOString().slice(0, 10) ?? null,
        encerradaEm: n.closedAt?.toISOString().slice(0, 10) ?? null,
        encerradaPor: n.closedBy ? (usuarios.get(n.closedBy) ?? null) : null,
        conclusao: (n.conclusion as Record<string, string> | null) ?? null,
        camposConclusao: camposDeConclusao(n.groupKey),
        numeracao: numeracaoConclusao(n.groupKey),
        fichaEsus: usaConclusaoEsus(n.groupKey),
        prazoDias: ctx.tenant.settings.vigilancia.prazosEncerramento[n.groupKey] ?? null,
      },
      policial: n.policeRequired ? { venceEm: n.policeDueAt?.toISOString() ?? null, dispensa: n.policeWaiver } : null,
      orientacaoViolencia: orientacaoViolencia({ groupKey: n.groupKey, code: n.code }, ageInYears(paciente.birthDate, n.knownAt)),
      permissoes: {
        editar: n.status !== 'DESCARTADA' && n.status !== 'ENCERRADA' && (n.notifierId === ctx.session.userId || ctx.session.role === 'VIGILANCIA_EPIDEMIOLOGICA' || ctx.session.role === 'NUCLEO_VIGILANCIA'),
        confirmar: n.status === 'RASCUNHO',
        descartar: n.status !== 'DESCARTADA' && (this.pode(ctx, 'notificacao.descartar') || (n.status === 'RASCUNHO' && n.deadlineKind === 'SEMANAL' && n.notifierId === ctx.session.userId)),
        ciencia: n.status === 'NOTIFICADA' && !n.smsReceivedAt && this.pode(ctx, 'vigilancia.ciencia'),
        comunicar: (n.status === 'NOTIFICADA' || n.status === 'ENCERRADA') && this.pode(ctx, 'vigilancia.comunicar'),
        comunicarPolicia: n.status !== 'DESCARTADA' && n.policeRequired && !n.policeWaiver,
        digitar: n.entryStatus === 'PENDENTE' && this.pode(ctx, 'vigilancia.digitar'),
        desfazerDigitacao: n.entryStatus === 'DIGITADA' && ctx.session.role === 'VIGILANCIA_EPIDEMIOLOGICA',
        encerrar: n.status === 'NOTIFICADA' && this.pode(ctx, 'vigilancia.investigar'),
        reabrir: n.status === 'ENCERRADA' && ctx.session.role === 'VIGILANCIA_EPIDEMIOLOGICA',
      },
      aviso: n.officialSystem
        ? `O OmniSaúde não envia a ficha aos sistemas oficiais (não há API de escrita): ela fica na fila de digitação do ${SISTEMA_INFO[n.officialSystem as SistemaOficial].label} até o número oficial ser informado.`
        : 'O OmniSaúde não envia a ficha aos sistemas oficiais: ao confirmar, ela entra na fila de digitação do sistema de destino.',
    };
  }

  /**
   * Edita a ficha (rascunho ou notificada): subitem do mesmo grupo, critério, datas e os campos editáveis da FIN.
   * Trocar o subitem não pode afrouxar a notificação (de imediata para semanal, menos esferas ou sem sigilo) sem a
   * vigilância municipal. A gravação só vale se ninguém mudou a notificação desde a leitura.
   */
  async editar(
    ctx: RequestContext,
    id: string,
    input: {
      conditionKey?: string;
      basis?: 'SUSPEITA' | 'CONFIRMADO';
      confirmedAt?: string | null;
      symptomsOnset?: string | null;
      ficha?: Partial<Record<(typeof CAMPOS_EDITAVEIS)[number], string | null>>;
      /** Dispensa justificada da comunicação policial (ex.: lesão autoprovocada); nulo restaura a exigência. */
      policial?: { dispensa: string | null };
    },
  ) {
    const n = await this.carregar(ctx, id);
    const dispensa = input.policial === undefined ? undefined : (input.policial.dispensa?.trim() ?? null);
    if (dispensa !== undefined && !n.policeRequired) throw new DomainError('SEM_COMUNICACAO_POLICIAL', 'Esta notificação não exige comunicação à autoridade policial', HttpStatus.UNPROCESSABLE_ENTITY);
    if (dispensa && dispensa.length < 10) throw new DomainError('MOTIVO_CURTO', 'Explique a dispensa da comunicação policial (mínimo de 10 caracteres)', HttpStatus.BAD_REQUEST);
    if (n.status === 'DESCARTADA') throw new DomainError('DESCARTADA', 'Notificação descartada', HttpStatus.UNPROCESSABLE_ENTITY);
    if (n.status === 'ENCERRADA') throw new DomainError('ENCERRADA', 'Notificação encerrada: a vigilância municipal reabre para editar', HttpStatus.UNPROCESSABLE_ENTITY);
    if (!(n.notifierId === ctx.session.userId || ctx.session.role === 'VIGILANCIA_EPIDEMIOLOGICA' || ctx.session.role === 'NUCLEO_VIGILANCIA')) throw forbidden('Só o autor ou a vigilância editam a ficha');
    const hoje = localDateString(new Date(), ctx.tenant.timeZone);
    if (input.symptomsOnset && input.symptomsOnset > hoje) throw new DomainError('DATA_FUTURA', 'A data dos primeiros sintomas não pode ser futura', HttpStatus.BAD_REQUEST);
    if (input.confirmedAt && new Date(input.confirmedAt).getTime() > Date.now() + 60_000) throw new DomainError('DATA_FUTURA', 'A data de confirmação não pode ser futura', HttpStatus.BAD_REQUEST);
    let condicao = { ...n.condition, group: n.condition.groupKey } as CondicaoNoRetrato;
    if (input.conditionKey && input.conditionKey !== n.conditionKey) {
      const catalogo = await this.catalogoDoDia(ctx, localDateString(n.firstCareAt ?? n.knownAt, ctx.tenant.timeZone));
      const nova = catalogo.find((c) => c.key === input.conditionKey && c.groupKey === n.groupKey);
      if (!nova) throw new DomainError('SUBITEM_INVALIDO', 'Escolha um subitem do mesmo agravo', HttpStatus.BAD_REQUEST);
      if (n.sensitive && !nova.sensitive) throw new DomainError('SIGILO', 'Não é possível tirar o sigilo da notificação trocando o subitem', HttpStatus.BAD_REQUEST);
      condicao = nova;
    }
    const confirmedAt = input.confirmedAt !== undefined ? (input.confirmedAt ? new Date(input.confirmedAt) : null) : n.confirmedAt;
    // Mesmo critério da abertura: atendimento de internação conta o prazo do conhecimento.
    const encontro = n.encounterId ? await ctx.db.encounter.findUnique({ where: { id: n.encounterId }, select: { kind: true } }) : null;
    const internacao = n.origin === 'INTERNACAO' || !!n.admissionId || encontro?.kind === 'INTERNACAO';
    const prazo = calcularPrazo(condicao, { atendimento: n.firstCareAt, conhecimento: n.knownAt, confirmacao: confirmedAt, internacao });
    const afrouxa = (n.deadlineKind === 'IMEDIATA' && prazo.tipo === 'SEMANAL') || n.targets.some((t) => !prazo.esferas.includes(t as Esfera));
    if (afrouxa && !this.pode(ctx, 'notificacao.descartar')) throw forbidden('Trocar para um subitem com prazo ou esferas menores é decisão da vigilância municipal');
    const ficha = { ...(n.form as unknown as Ficha) };
    for (const campo of CAMPOS_EDITAVEIS) if (input.ficha && campo in input.ficha) (ficha as unknown as Record<string, unknown>)[campo] = input.ficha[campo] ?? null;
    ficha.ID_AGRAVO = { ...ficha.ID_AGRAVO, nome: condicao.name, item: condicao.item, subitem: condicao.subitem };
    const sintomas = input.symptomsOnset !== undefined ? input.symptomsOnset : (n.symptomsOnset?.toISOString().slice(0, 10) ?? null);
    ficha.DT_SIN_PRI = sintomas ?? null;
    // Data de confirmação informada: o caso é confirmado.
    const basis = input.basis ?? (input.confirmedAt ? 'CONFIRMADO' : n.basis);
    const antes = { condicao: n.conditionKey, criterio: n.basis, confirmacao: n.confirmedAt?.toISOString() ?? null, sintomas: n.symptomsOnset?.toISOString().slice(0, 10) ?? null, dispensaPolicial: n.policeWaiver };
    const depois = { condicao: condicao.key, criterio: basis, confirmacao: confirmedAt?.toISOString() ?? null, sintomas, dispensaPolicial: dispensa === undefined ? n.policeWaiver : dispensa };
    // Notificada e ainda não digitada: o novo subitem pode ir para outro sistema oficial.
    const rota = condicao.key !== n.conditionKey && n.entryStatus === 'PENDENTE' && n.notifiedAt ? await this.catalogo.rotaNaData(ctx, condicao, localDateString(n.notifiedAt, ctx.tenant.timeZone)) : null;
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.notification.updateMany({
        where: { id, updatedAt: n.updatedAt, status: n.status },
        data: {
          conditionId: condicao.id,
          conditionKey: condicao.key,
          sensitive: condicao.sensitive,
          basis,
          confirmedAt,
          deadlineStart: prazo.marco,
          deadlineKind: prazo.tipo,
          targets: prazo.esferas,
          deadlineStartAt: prazo.inicio,
          dueAt: prazo.vence,
          symptomsOnset: sintomas ? new Date(`${sintomas}T00:00:00Z`) : null,
          epiWeekOnset: sintomas ? semanasDaFicha(null, sintomas).SEM_PRI : null,
          form: ficha as object,
          ...(dispensa !== undefined ? { policeWaiver: dispensa } : {}),
          ...(rota ? { officialSystem: rota.sistema, entryStatus: SISTEMA_INFO[rota.sistema].digitacao ? ('PENDENTE' as const) : ('LEMBRETE' as const) } : {}),
        },
      });
      if (count !== 1) throw conflict('A notificação mudou enquanto você editava; abra de novo');
      await tx.notificationEvent.create({
        data: { notificationId: id, kind: condicao.key !== n.conditionKey ? 'SUBITEM_ALTERADO' : 'EDITADA', userId: ctx.session.userId, data: { antes, depois, ficha: input.ficha ?? null } },
      });
      if (n.status === 'NOTIFICADA' || afrouxa || dispensa !== undefined) await this.audit.record(ctx, tx, { action: 'notificacao.editar', entityType: 'Notification', entityId: id, payload: { antes, depois } });
    });
    this.avisar(ctx, n);
    return this.detalhe(ctx, id);
  }

  /** Confirma a notificação: valida a FIN, grava a data, a semana epidemiológica e a comunicação à SMS pelo sistema. */
  async confirmar(ctx: RequestContext, id: string) {
    const n = await this.carregar(ctx, id);
    if (n.status !== 'RASCUNHO') throw new DomainError('NAO_E_RASCUNHO', 'Só um rascunho pode ser confirmado', HttpStatus.UNPROCESSABLE_ENTITY);
    if (!(n.notifierId === ctx.session.userId || ctx.session.role === 'VIGILANCIA_EPIDEMIOLOGICA' || ctx.session.role === 'NUCLEO_VIGILANCIA')) throw forbidden('Só o autor ou a vigilância confirmam');
    const agora = new Date();
    const hoje = localDateString(agora, ctx.tenant.timeZone);
    const sintomas = n.symptomsOnset?.toISOString().slice(0, 10) ?? null;
    const ficha = { ...(n.form as unknown as Ficha), DT_NOTIFIC: hoje, DT_SIN_PRI: sintomas };
    const erros = validarFicha(ficha, { notificadaEm: agora, sintomas, hoje });
    // Agravo notificado só na confirmação (item 60): sem a data, não há caso a notificar nem prazo.
    if (n.deadlineStart === 'CONFIRMACAO' && !n.confirmedAt) erros.push('Este agravo é notificado na confirmação do caso: informe a data de confirmação');
    if (erros.length) throw new DomainError('FICHA_INVALIDA', erros.join('; '), HttpStatus.BAD_REQUEST, { erros });
    const semanas = semanasDaFicha(hoje, sintomas);
    // Sistema oficial de destino na data da notificação: entra na fila de digitação (ou vira lembrete da DNV/DO).
    const rota = await this.catalogo.rotaNaData(ctx, { key: n.conditionKey, groupKey: n.groupKey }, hoje);
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.notification.updateMany({
        where: { id, status: 'RASCUNHO' },
        data: {
          status: 'NOTIFICADA',
          notifiedAt: agora,
          epiWeekNotified: semanas.SEM_NOT,
          epiWeekOnset: semanas.SEM_PRI,
          form: ficha as object,
          officialSystem: rota.sistema,
          entryStatus: SISTEMA_INFO[rota.sistema].digitacao ? 'PENDENTE' : 'LEMBRETE',
        },
      });
      if (count !== 1) throw conflict('A notificação já foi confirmada ou descartada');
      await tx.notificationCommunication.create({
        data: { notificationId: id, target: 'SMS', channel: 'SISTEMA', communicatedAt: agora, counterpartName: 'Vigilância epidemiológica municipal (painel do OmniSaúde)', userId: ctx.session.userId },
      });
      await tx.notificationEvent.create({ data: { notificationId: id, kind: 'CONFIRMADA', userId: ctx.session.userId, data: { semana: semanas.SEM_NOT, sistema: rota.sistema } } });
      await this.audit.record(ctx, tx, { action: 'notificacao.confirmar', entityType: 'Notification', entityId: id, payload: { numero: n.number, agravo: n.conditionKey } });
    });
    this.avisar(ctx, n);
    return this.detalhe(ctx, id);
  }

  /** Descarte com motivo; imediata ou já confirmada só pela vigilância municipal. */
  async descartar(ctx: RequestContext, id: string, motivo: string) {
    const n = await this.carregar(ctx, id);
    if (n.status === 'DESCARTADA') throw new DomainError('JA_DESCARTADA', 'Notificação já descartada', HttpStatus.UNPROCESSABLE_ENTITY);
    const exigeVigilancia = n.status !== 'RASCUNHO' || n.deadlineKind === 'IMEDIATA';
    if (exigeVigilancia && !this.pode(ctx, 'notificacao.descartar')) throw forbidden('Notificação imediata ou já confirmada só é descartada pela vigilância municipal');
    if (!exigeVigilancia && n.notifierId !== ctx.session.userId && !this.pode(ctx, 'notificacao.descartar')) throw forbidden('Só o autor descarta o próprio rascunho');
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.notification.updateMany({ where: { id, status: n.status }, data: { status: 'DESCARTADA', discardReason: motivo.trim(), discardedBy: ctx.session.userId, discardedAt: new Date() } });
      if (count !== 1) throw conflict('A notificação mudou de situação; abra de novo');
      await tx.notificationEvent.create({ data: { notificationId: id, kind: 'DESCARTADA', userId: ctx.session.userId, notes: motivo.trim() } });
      await this.audit.record(ctx, tx, { action: 'notificacao.descartar', entityType: 'Notification', entityId: id, payload: { numero: n.number, motivo } });
    });
    this.avisar(ctx, n);
    return this.detalhe(ctx, id);
  }

  /** Ciência da SMS (vigilância municipal): cumpre a imediata perante a SMS e abre o prazo de 24 h do repasse. */
  async ciencia(ctx: RequestContext, id: string) {
    const n = await this.carregar(ctx, id);
    if (n.status !== 'NOTIFICADA') throw new DomainError('NAO_NOTIFICADA', 'Confirme a notificação antes de dar ciência', HttpStatus.UNPROCESSABLE_ENTITY);
    if (n.smsReceivedAt) throw new DomainError('JA_CIENTE', 'A vigilância já deu ciência', HttpStatus.UNPROCESSABLE_ENTITY);
    const agora = new Date();
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.notification.updateMany({ where: { id, status: 'NOTIFICADA', smsReceivedAt: null }, data: { smsReceivedAt: agora, smsReceivedBy: ctx.session.userId } });
      if (count !== 1) throw conflict('A vigilância já deu ciência');
      await tx.notificationEvent.create({ data: { notificationId: id, kind: 'CIENCIA_SMS', userId: ctx.session.userId } });
      await this.audit.record(ctx, tx, { action: 'notificacao.ciencia', entityType: 'Notification', entityId: id, payload: { numero: n.number } });
    });
    this.avisar(ctx, n);
    return this.detalhe(ctx, id);
  }

  /** Registro de comunicação a uma esfera (telefone, e-mail, formulário...): o sistema não liga nem envia e-mail. */
  async comunicar(
    ctx: RequestContext,
    id: string,
    input: {
      target: DestinoComunicacao;
      channel: 'TELEFONE' | 'EMAIL' | 'FORMULARIO' | 'PRESENCIAL' | 'OUTRO';
      communicatedAt: string;
      counterpartName: string;
      counterpartOrg?: string | null;
      contactId?: string | null;
      contactValue?: string | null;
      protocol?: string | null;
      notes?: string | null;
    },
  ) {
    const n = await this.carregar(ctx, id);
    const policia = input.target === 'AUTORIDADE_POLICIAL';
    if (policia) {
      // Comunicação policial (art. 14-A): é da unidade que atendeu; vale com a notificação ainda em rascunho.
      if (n.status === 'DESCARTADA') throw new DomainError('DESCARTADA', 'Notificação descartada', HttpStatus.UNPROCESSABLE_ENTITY);
      if (!n.policeRequired) throw new DomainError('SEM_COMUNICACAO_POLICIAL', 'Esta notificação não exige comunicação à autoridade policial', HttpStatus.UNPROCESSABLE_ENTITY);
    } else {
      if (!this.pode(ctx, 'vigilancia.comunicar')) throw forbidden('Comunicação às esferas é da vigilância');
      if (n.status !== 'NOTIFICADA' && n.status !== 'ENCERRADA') throw new DomainError('NAO_NOTIFICADA', 'Confirme a notificação antes de registrar comunicações', HttpStatus.UNPROCESSABLE_ENTITY);
      if (ctx.session.role === 'NUCLEO_VIGILANCIA' && input.target !== 'SMS') throw forbidden('O núcleo do estabelecimento comunica à SMS; o repasse à SES e ao MS é da vigilância municipal');
    }
    const em = new Date(input.communicatedAt);
    if (em.getTime() > Date.now() + 60_000) throw new DomainError('DATA_FUTURA', 'A comunicação não pode ter data futura', HttpStatus.BAD_REQUEST);
    if (em.getTime() < n.createdAt.getTime() - DIA) throw new DomainError('DATA_INVALIDA', 'A comunicação não pode ser anterior à notificação', HttpStatus.BAD_REQUEST);
    const contato = input.contactId ? await ctx.db.surveillanceContact.findUnique({ where: { id: input.contactId } }) : null;
    await ctx.db.$transaction(async (tx) => {
      await tx.notificationCommunication.create({
        data: {
          notificationId: id,
          target: input.target,
          channel: input.channel,
          communicatedAt: em,
          counterpartName: input.counterpartName.trim(),
          counterpartOrg: input.counterpartOrg ?? contato?.label ?? null,
          contactId: contato?.id ?? null,
          contactValue: input.contactValue ?? contato?.phone ?? contato?.email ?? null,
          protocol: input.protocol ?? null,
          notes: input.notes ?? null,
          userId: ctx.session.userId,
        },
      });
      await tx.notificationEvent.create({ data: { notificationId: id, kind: 'COMUNICACAO', userId: ctx.session.userId, data: { esfera: input.target, meio: input.channel } } });
      await this.audit.record(ctx, tx, { action: 'notificacao.comunicar', entityType: 'Notification', entityId: id, payload: { esfera: input.target, meio: input.channel } });
    });
    this.avisar(ctx, n);
    return this.detalhe(ctx, id);
  }

  /**
   * Linhas das listas. Quem não abre a notificação (fora do alcance ou sem acesso ao sigilo) não vê nada que indique
   * o agravo sigiloso: nem nome, nem prazo, esferas, origem ou unidade. Listar agravos sigilosos abertos fica auditado.
   */
  private async linhas(ctx: RequestContext, rows: Awaited<ReturnType<typeof this.buscar>>) {
    const agora = new Date();
    const unidades = new Map((await ctx.db.unit.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.unitId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const pacientes = new Map(
      (await ctx.db.patient.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.patientId))] } }, select: { id: true, name: true, socialName: true } })).map((p) => [p.id, p.socialName ?? p.name]),
    );
    const comunicacoes = await this.comunicacoesDe(
      ctx.db,
      rows.map((r) => r.id),
    );
    const prontuario = this.pode(ctx, 'prontuario.ler');
    const sigilosasAbertas: string[] = [];
    const saida = [];
    for (const n of rows) {
      const podeAbrir = this.alcance(ctx, n) && (!n.sensitive || this.abreSigiloso(ctx, n));
      // Fora do alcance, quem cuida do paciente (prontuário) vê o agravo não sigiloso, para não notificar de novo.
      const mostra = podeAbrir || (!n.sensitive && prontuario);
      if (podeAbrir && n.sensitive && n.notifierId !== ctx.session.userId) sigilosasAbertas.push(n.id);
      if (!mostra) {
        saida.push({
          id: n.id,
          numero: n.number,
          status: n.status,
          origem: null,
          agravo: RESTRITO,
          grupo: null,
          sigiloso: true,
          naoHomologado: false,
          paciente: null,
          unidade: null,
          prazo: null,
          esferas: [],
          venceEm: null,
          situacaoSms: null,
          repasses: [],
          ciencia: false,
          escalada: false,
          semana: null,
          criadaEm: n.createdAt.toISOString(),
          podeAbrir: false,
          policial: null,
          sistemaOficial: null,
          digitacao: null,
          numeroOficial: null,
        });
        continue;
      }
      const esferas = await this.esferas(ctx.db, n, agora, comunicacoes);
      const sms = esferas.lista.find((e) => e.esfera === 'SMS')!;
      const repasses = esferas.lista.filter(REPASSE);
      const policia = esferas.lista.find((e) => e.esfera === 'AUTORIDADE_POLICIAL');
      saida.push({
        id: n.id,
        numero: n.number,
        status: n.status,
        origem: n.origin,
        agravo: n.condition.name,
        grupo: n.groupKey,
        sigiloso: n.sensitive,
        naoHomologado: n.mapStatus === 'PROPOSTO',
        paciente: pacientes.get(n.patientId) ?? null,
        unidade: unidades.get(n.unitId) ?? null,
        prazo: n.deadlineKind,
        esferas: n.targets,
        venceEm: n.dueAt?.toISOString() ?? null,
        situacaoSms: n.status === 'DESCARTADA' ? 'SEM_PRAZO' : sms.situacao,
        repasses: n.status === 'DESCARTADA' ? [] : repasses.map((r) => ({ esfera: r.esfera, situacao: r.situacao, venceEm: r.venceEm })),
        ciencia: !!n.smsReceivedAt,
        escalada: !!n.escalatedAt,
        semana: n.epiWeekNotified,
        criadaEm: n.createdAt.toISOString(),
        podeAbrir,
        policial: n.status === 'DESCARTADA' || !policia ? null : { situacao: policia.situacao, venceEm: policia.venceEm },
        sistemaOficial: n.officialSystem,
        digitacao: n.entryStatus,
        numeroOficial: n.officialNumber,
      });
    }
    if (sigilosasAbertas.length) await this.audit.recordStandalone(ctx, { action: 'notificacao.listar_sensivel', entityType: 'Notification', payload: { ids: sigilosasAbertas } });
    return saida;
  }

  /**
   * Notificações com alguma pendência: rascunho, imediata sem recebimento pela SMS ou repasse à SES ou ao MS sem
   * comunicação. Os cartões e o filtro de prazo olham este conjunto inteiro (não só as mais recentes).
   */
  private pendentes(escopo: object) {
    const semComunicacao = (alvo: Esfera) => ({ communications: { none: { target: alvo, channel: { not: 'SISTEMA' as const } } } });
    return {
      ...escopo,
      OR: [
        { status: 'RASCUNHO' as const },
        { status: 'NOTIFICADA' as const, deadlineKind: 'IMEDIATA' as const, smsReceivedAt: null, ...semComunicacao('SMS') },
        { status: 'NOTIFICADA' as const, targets: { has: 'SES' as const }, ...semComunicacao('SES') },
        { status: 'NOTIFICADA' as const, targets: { has: 'MS' as const }, ...semComunicacao('MS') },
        { status: { not: 'DESCARTADA' as const }, policeRequired: true, policeWaiver: null, communications: { none: { target: 'AUTORIDADE_POLICIAL' as const } } },
      ],
    };
  }

  private buscar(ctx: RequestContext, where: object, take = 200) {
    return ctx.db.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }], take, include: { condition: true } });
  }

  async minhas(ctx: RequestContext, q: { status?: string; de?: string; ate?: string }) {
    const rows = await this.buscar(ctx, {
      notifierId: ctx.session.userId,
      ...(q.status ? { status: q.status as 'RASCUNHO' } : {}),
      ...(q.de || q.ate ? { createdAt: { ...(q.de ? { gte: new Date(`${q.de}T00:00:00Z`) } : {}), ...(q.ate ? { lte: new Date(`${q.ate}T23:59:59Z`) } : {}) } } : {}),
    });
    return this.linhas(ctx, rows);
  }

  /** Notificações do paciente (evita duplicar): as de acesso restrito aparecem sem o agravo. */
  async doPaciente(ctx: RequestContext, patientId: string) {
    const rows = await this.buscar(ctx, { patientId }, 50);
    return this.linhas(ctx, rows);
  }

  /** Painel da vigilância: municipal vê todas; núcleo vê a unidade. */
  async painel(ctx: RequestContext, q: { status?: string; grupo?: string; unitId?: string; situacao?: string; semana?: string }) {
    const filtros = {
      ...this.where(ctx),
      ...(q.status ? { status: q.status as 'RASCUNHO' } : { status: { not: 'DESCARTADA' as const } }),
      ...(q.grupo ? { groupKey: q.grupo } : {}),
      ...(q.unitId && ctx.session.role === 'VIGILANCIA_EPIDEMIOLOGICA' ? { unitId: q.unitId } : {}),
      ...(q.semana ? { epiWeekNotified: q.semana } : {}),
    };
    // Filtro de prazo: sobre todas as pendentes (as vencidas antigas não podem sumir atrás das recentes).
    const linhas = q.situacao
      ? (await this.linhas(ctx, await this.buscar(ctx, this.pendentes(filtros), LIMITE_PENDENTES))).filter((l) => {
          if (q.situacao === 'VENCIDO') return l.situacaoSms === 'VENCIDO' || l.repasses.some((r) => r.situacao === 'VENCIDO');
          if (q.situacao === 'REPASSE') return l.repasses.some((r) => r.situacao !== 'CUMPRIDO');
          return l.situacaoSms === q.situacao;
        })
      : await this.linhas(ctx, await this.buscar(ctx, filtros, 300));
    const abertas = await this.buscar(ctx, this.pendentes(this.where(ctx)), LIMITE_PENDENTES);
    if (abertas.length === LIMITE_PENDENTES) this.logger.warn(`Painel da vigilância: mais de ${LIMITE_PENDENTES} notificações pendentes; os cartões mostram as ${LIMITE_PENDENTES} mais recentes`);
    const pend = await this.linhas(ctx, abertas);
    const descartes = await ctx.db.notification.count({ where: { ...this.where(ctx), status: 'DESCARTADA', discardedAt: { gte: new Date(Date.now() - 30 * DIA) } } });
    return {
      cartoes: {
        imediatasAguardandoCiencia: pend.filter((l) => l.status === 'NOTIFICADA' && l.prazo === 'IMEDIATA' && !l.ciencia && l.situacaoSms !== 'CUMPRIDO').length,
        rascunhosImediatos: pend.filter((l) => l.status === 'RASCUNHO' && l.prazo === 'IMEDIATA').length,
        repassesPendentes: pend.filter((l) => l.repasses.some((r) => r.situacao !== 'CUMPRIDO')).length,
        vencidas: pend.filter((l) => l.situacaoSms === 'VENCIDO' || l.repasses.some((r) => r.situacao === 'VENCIDO')).length,
        semanaisAVencer: pend.filter((l) => l.prazo === 'SEMANAL' && l.status === 'RASCUNHO').length,
        descartes30d: descartes,
        comunicacoesPoliciais: pend.filter((l) => l.policial && l.policial.situacao !== 'CUMPRIDO').length,
        pendentesDigitacao: await ctx.db.notification.count({ where: { ...this.where(ctx), status: { in: ['NOTIFICADA', 'ENCERRADA'] }, entryStatus: 'PENDENTE' } }),
        encerramentoVencido: await this.encerramentosVencidos(ctx),
      },
      notificacoes: linhas,
      semanaAtual: semanaEpidemiologica(new Date(), ctx.tenant.timeZone).codigo,
    };
  }

  async descartes(ctx: RequestContext) {
    const rows = await this.buscar(ctx, { ...this.where(ctx), status: 'DESCARTADA' }, 100);
    const linhas = await this.linhas(ctx, rows);
    return linhas.map((l, i) => ({ ...l, motivo: rows[i]!.sensitive && !this.abreSigiloso(ctx, rows[i]!) ? null : rows[i]!.discardReason, descartadaEm: rows[i]!.discardedAt?.toISOString() ?? null }));
  }

  /** Gestão: só contagens, sem lista nominal (sobre as notificações com pendência). */
  async resumo(ctx: RequestContext) {
    const abertas = await ctx.db.notification.findMany({
      where: this.pendentes({}),
      select: { id: true, status: true, deadlineKind: true, targets: true, dueAt: true, notifiedAt: true, smsReceivedAt: true, policeRequired: true, policeDueAt: true, policeWaiver: true },
      orderBy: { createdAt: 'desc' },
      take: LIMITE_PENDENTES,
    });
    let noPrazo = 0;
    let vencidas = 0;
    let repasses = 0;
    const comunicacoes = await this.comunicacoesDe(
      ctx.db,
      abertas.map((n) => n.id),
    );
    for (const n of abertas) {
      const e = await this.esferas(ctx.db, n, new Date(), comunicacoes);
      const sms = e.lista.find((x) => x.esfera === 'SMS')!;
      if (e.lista.some((x) => x.situacao === 'VENCIDO')) vencidas++;
      else if (n.deadlineKind === 'IMEDIATA' && sms.situacao !== 'CUMPRIDO') noPrazo++;
      if (e.lista.some((x) => REPASSE(x) && x.situacao !== 'CUMPRIDO')) repasses++;
    }
    return { imediatasNoPrazo: noPrazo, vencidas, repassesPendentes: repasses, semana: semanaEpidemiologica(new Date(), ctx.tenant.timeZone).codigo };
  }

  // ───────────────────────────── saída para os sistemas oficiais ─────────────────────────────

  /** Escopo público para os serviços irmãos (exportação, PDF): mesmas regras de alcance e sigilo. */
  async acessar(ctx: RequestContext, id: string, opts: { leitura?: boolean } = {}) {
    return this.carregar(ctx, id, opts);
  }

  escopo(ctx: RequestContext) {
    return this.where(ctx);
  }

  /** Fila de digitação por sistema oficial: o que foi notificado e ainda não tem o número do sistema de destino. */
  async fila(ctx: RequestContext, q: { sistema?: SistemaOficial; situacao?: 'PENDENTE' | 'DIGITADA' | 'LEMBRETE' }) {
    const base = { ...this.where(ctx), status: { in: ['NOTIFICADA' as const, 'ENCERRADA' as const] } };
    const contagem = await ctx.db.notification.groupBy({ by: ['officialSystem', 'entryStatus'], where: base, _count: { _all: true } });
    const sistemas = (Object.keys(SISTEMA_INFO) as SistemaOficial[]).map((sistema) => ({
      sistema,
      label: SISTEMA_INFO[sistema].label,
      digitacao: SISTEMA_INFO[sistema].digitacao,
      dicaNumero: SISTEMA_INFO[sistema].numero.dica,
      pendentes: contagem.find((c) => c.officialSystem === sistema && c.entryStatus === 'PENDENTE')?._count._all ?? 0,
      lembretes: contagem.find((c) => c.officialSystem === sistema && c.entryStatus === 'LEMBRETE')?._count._all ?? 0,
      digitadas: contagem.find((c) => c.officialSystem === sistema && c.entryStatus === 'DIGITADA')?._count._all ?? 0,
    }));
    const rows = await ctx.db.notification.findMany({
      where: { ...base, ...(q.sistema ? { officialSystem: q.sistema } : {}), entryStatus: q.situacao ?? 'PENDENTE' },
      orderBy: [{ notifiedAt: 'asc' }],
      take: LIMITE_PENDENTES,
      include: { condition: true },
    });
    const linhas = await this.linhas(ctx, rows);
    return { sistemas, notificacoes: linhas.map((l, i) => ({ ...l, notificadaEm: rows[i]!.notifiedAt?.toISOString() ?? null, lote: rows[i]!.officialBatch })) };
  }

  /** Número gerado no sistema oficial: tira da fila. O mesmo número não vale para duas notificações do sistema. */
  async informarNumero(ctx: RequestContext, id: string, input: { numero: string; lote?: string | null }) {
    const n = await this.carregar(ctx, id);
    if (n.entryStatus !== 'PENDENTE' || !n.officialSystem) throw new DomainError('FORA_DA_FILA', 'A notificação não está na fila de digitação', HttpStatus.UNPROCESSABLE_ENTITY);
    const sistema = n.officialSystem as SistemaOficial;
    const numero = input.numero.trim();
    if (!numeroOficialValido(sistema, numero)) throw new DomainError('NUMERO_INVALIDO', `Número fora do formato do ${SISTEMA_INFO[sistema].label} (${SISTEMA_INFO[sistema].numero.dica})`, HttpStatus.BAD_REQUEST);
    try {
      await ctx.db.$transaction(async (tx) => {
        if (sistema === 'SINAN_NET') {
          // NU_NOTIFIC é da unidade: a chave do Sinan Net é número + data da notificação + município + agravo.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sinan-net:${numero}`}))`;
          const chave = (x: { groupKey: string; form: unknown; notifiedAt: Date | null; knownAt: Date }) => {
            const f = (x.form ?? {}) as Partial<Ficha>;
            return [x.groupKey, f.DT_NOTIFIC ?? localDateString(x.notifiedAt ?? x.knownAt, ctx.tenant.timeZone), f.ID_MUNICIP ?? ''].join('|');
          };
          const mesmos = await tx.notification.findMany({
            where: { officialSystem: 'SINAN_NET', officialNumber: numero, id: { not: id } },
            select: { groupKey: true, form: true, notifiedAt: true, knownAt: true, number: true },
          });
          const repetida = mesmos.find((x) => chave(x) === chave(n));
          if (repetida) throw conflict(`O NU_NOTIFIC ${numero} já foi informado para a notificação ${repetida.number} (mesmo agravo, data e município)`);
        }
        const { count } = await tx.notification.updateMany({
          where: { id, entryStatus: 'PENDENTE' },
          data: { entryStatus: 'DIGITADA', officialNumber: numero, officialBatch: input.lote?.trim() || null, enteredBy: ctx.session.userId, enteredAt: new Date() },
        });
        if (count !== 1) throw conflict('Outra pessoa já informou o número desta notificação');
        await tx.notificationEvent.create({ data: { notificationId: id, kind: 'DIGITADA', userId: ctx.session.userId, data: { sistema, numero, lote: input.lote ?? null } } });
        await this.audit.record(ctx, tx, { action: 'notificacao.numero_oficial', entityType: 'Notification', entityId: id, payload: { sistema, numero } });
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw conflict(`O número ${numero} já foi informado para outra notificação do ${SISTEMA_INFO[sistema].label}`);
      throw err;
    }
    this.avisar(ctx, n);
    return this.detalhe(ctx, id);
  }

  /** Correção de digitação (só a vigilância municipal): devolve à fila. */
  async desfazerNumero(ctx: RequestContext, id: string, motivo: string) {
    const n = await this.carregar(ctx, id);
    if (ctx.session.role !== 'VIGILANCIA_EPIDEMIOLOGICA') throw forbidden('Só a vigilância municipal desfaz a digitação');
    if (n.entryStatus !== 'DIGITADA') throw new DomainError('NAO_DIGITADA', 'A notificação não tem número oficial', HttpStatus.UNPROCESSABLE_ENTITY);
    await ctx.db.$transaction(async (tx) => {
      await tx.notification.update({ where: { id }, data: { entryStatus: 'PENDENTE', officialNumber: null, officialBatch: null, enteredBy: null, enteredAt: null } });
      await tx.notificationEvent.create({ data: { notificationId: id, kind: 'DIGITACAO_DESFEITA', userId: ctx.session.userId, notes: motivo.trim(), data: { numeroAnterior: n.officialNumber } } });
      await this.audit.record(ctx, tx, { action: 'notificacao.numero_desfeito', entityType: 'Notification', entityId: id, payload: { numero: n.officialNumber, motivo } });
    });
    this.avisar(ctx, n);
    return this.detalhe(ctx, id);
  }

  /** Investigação e encerramento: bloco "notificação/conclusão" do Sinan Net v5 e, no e-SUS Sinan, a conclusão da NT. */
  async encerrar(
    ctx: RequestContext,
    id: string,
    input: { investigadaEm: string; classificacao: string; criterio?: string | null; evolucao?: string | null; obitoEm?: string | null; encerradaEm: string; conclusao?: Record<string, string | null> | null },
  ) {
    const n = await this.carregar(ctx, id);
    if (n.status !== 'NOTIFICADA') throw new DomainError('NAO_NOTIFICADA', 'Só a notificação confirmada (e não encerrada) pode ser encerrada', HttpStatus.UNPROCESSABLE_ENTITY);
    const hoje = localDateString(new Date(), ctx.tenant.timeZone);
    const e = {
      investigadaEm: input.investigadaEm,
      classificacao: input.classificacao,
      criterio: input.criterio ?? null,
      evolucao: input.evolucao ?? null,
      obitoEm: input.obitoEm ?? null,
      encerradaEm: input.encerradaEm,
    };
    const erros = [
      ...validarEncerramento(e, { notificadaEm: localDateString(n.notifiedAt ?? n.knownAt, ctx.tenant.timeZone), sintomas: n.symptomsOnset?.toISOString().slice(0, 10) ?? null, hoje, grupo: n.groupKey }),
      ...validarConclusao(n.groupKey, input.conclusao ?? {}, e.classificacao),
    ];
    if (erros.length) throw new DomainError('ENCERRAMENTO_INVALIDO', erros.join('; '), HttpStatus.BAD_REQUEST, { erros });
    const data = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`) : null);
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.notification.updateMany({
        where: { id, status: 'NOTIFICADA' },
        data: {
          status: 'ENCERRADA',
          investigatedAt: data(e.investigadaEm),
          finalClass: e.classificacao,
          criterion: e.criterio,
          evolution: e.evolucao,
          deathDate: data(e.obitoEm),
          closedAt: data(e.encerradaEm),
          closedBy: ctx.session.userId,
          conclusion: (input.conclusao ?? undefined) as object | undefined,
          // Confirmado no encerramento: o critério da notificação acompanha.
          ...(e.classificacao === '1' ? { basis: 'CONFIRMADO' as const } : {}),
        },
      });
      if (count !== 1) throw conflict('A notificação mudou de situação; abra de novo');
      await tx.notificationEvent.create({ data: { notificationId: id, kind: 'ENCERRADA', userId: ctx.session.userId, data: { classificacao: e.classificacao, criterio: e.criterio, evolucao: e.evolucao } } });
      await this.audit.record(ctx, tx, { action: 'notificacao.encerrar', entityType: 'Notification', entityId: id, payload: { numero: n.number, classificacao: e.classificacao } });
    });
    this.avisar(ctx, n);
    return this.detalhe(ctx, id);
  }

  async reabrir(ctx: RequestContext, id: string, motivo: string) {
    const n = await this.carregar(ctx, id);
    if (ctx.session.role !== 'VIGILANCIA_EPIDEMIOLOGICA') throw forbidden('Só a vigilância municipal reabre a investigação');
    if (n.status !== 'ENCERRADA') throw new DomainError('NAO_ENCERRADA', 'A notificação não está encerrada', HttpStatus.UNPROCESSABLE_ENTITY);
    await ctx.db.$transaction(async (tx) => {
      await tx.notification.update({ where: { id }, data: { status: 'NOTIFICADA', closedAt: null, closedBy: null } });
      await tx.notificationEvent.create({ data: { notificationId: id, kind: 'REABERTA', userId: ctx.session.userId, notes: motivo.trim() } });
      await this.audit.record(ctx, tx, { action: 'notificacao.reabrir', entityType: 'Notification', entityId: id, payload: { numero: n.number, motivo } });
    });
    this.avisar(ctx, n);
    return this.detalhe(ctx, id);
  }

  /** Notificadas além do prazo de encerramento definido pela vigilância para o grupo (sem prazo definido, não conta). */
  private async encerramentosVencidos(ctx: RequestContext) {
    const prazos = Object.entries(ctx.tenant.settings.vigilancia.prazosEncerramento ?? {}).filter(([, dias]) => Number.isFinite(dias) && dias > 0);
    if (!prazos.length) return null;
    let total = 0;
    for (const [grupo, dias] of prazos) {
      total += await ctx.db.notification.count({ where: { ...this.where(ctx), status: 'NOTIFICADA', groupKey: grupo, notifiedAt: { lt: new Date(Date.now() - dias * DIA) } } });
    }
    return total;
  }

  // ───────────────────────────── contatos e configuração ─────────────────────────────

  async contatos(ctx: RequestContext) {
    await this.catalogo.garantir(ctx);
    return ctx.db.surveillanceContact.findMany({ orderBy: [{ sphere: 'asc' }, { sort: 'asc' }, { label: 'asc' }] });
  }

  async salvarContato(
    ctx: RequestContext,
    id: string | null,
    input: { sphere: Esfera; label: string; phone?: string | null; email?: string | null; formUrl?: string | null; hours?: string | null; onCall?: boolean; active?: boolean; sort?: number },
  ) {
    const data = {
      sphere: input.sphere,
      label: input.label.trim(),
      phone: input.phone ?? null,
      email: input.email ?? null,
      formUrl: input.formUrl ?? null,
      hours: input.hours ?? null,
      onCall: input.onCall ?? false,
      active: input.active ?? true,
      sort: input.sort ?? 0,
    };
    const c = id ? await ctx.db.surveillanceContact.update({ where: { id }, data }) : await ctx.db.surveillanceContact.create({ data });
    await this.audit.recordStandalone(ctx, { action: 'vigilancia.contato', entityType: 'SurveillanceContact', entityId: c.id, payload: data });
    return c;
  }

  configuracoes(ctx: RequestContext) {
    return { ...ctx.tenant.settings.vigilancia, whatsappEnabled: ctx.tenant.settings.whatsappEnabled };
  }

  /** Plantão e escalonamento: gravados nas configurações da instituição (banco mestre), como a política de MFA. */
  async salvarConfiguracoes(ctx: RequestContext, input: Partial<VigilanciaSettings>) {
    const telefones = input.onCallPhones?.map((t) => normalizeBrazilPhone(t));
    if (telefones?.some((t) => !t)) throw new DomainError('TELEFONE_INVALIDO', 'Informe celulares com DDD', HttpStatus.BAD_REQUEST);
    const t = await this.master.tenant.findUniqueOrThrow({ where: { id: ctx.tenant.id } });
    const atual = tenantSettings(t.settings);
    const vigilancia: VigilanciaSettings = {
      ackMinutes: input.ackMinutes ?? atual.vigilancia.ackMinutes,
      onCallPhones: telefones ? [...new Set(telefones as string[])] : atual.vigilancia.onCallPhones,
      whatsappAlerts: input.whatsappAlerts ?? atual.vigilancia.whatsappAlerts,
      relEnabled: input.relEnabled ?? atual.vigilancia.relEnabled,
      prazosEncerramento: input.prazosEncerramento
        ? Object.fromEntries(Object.entries(input.prazosEncerramento).filter(([grupo, dias]) => /^[a-z0-9-]{2,40}$/.test(grupo) && Number.isInteger(dias) && dias > 0 && dias <= 365))
        : atual.vigilancia.prazosEncerramento,
      modeloPolicial: input.modeloPolicial !== undefined ? input.modeloPolicial?.trim() || null : atual.vigilancia.modeloPolicial,
    };
    // Só a chave "vigilancia", de forma atômica: não desfaz uma mudança simultânea da política de MFA.
    await this.master.$executeRaw`UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{vigilancia}', ${JSON.stringify(vigilancia)}::jsonb) WHERE id = ${ctx.tenant.id}::uuid`;
    this.tenants.connections.invalidate(ctx.tenant.slug);
    this.tenants.connections.invalidate(ctx.tenant.id);
    await this.audit.recordStandalone(ctx, {
      action: 'vigilancia.configuracoes',
      entityType: 'Tenant',
      entityId: ctx.tenant.id,
      payload: { ackMinutes: vigilancia.ackMinutes, telefones: vigilancia.onCallPhones.length, whatsappAlerts: vigilancia.whatsappAlerts, relEnabled: vigilancia.relEnabled, prazos: vigilancia.prazosEncerramento },
    });
    return { ...vigilancia, whatsappEnabled: atual.whatsappEnabled };
  }

  // ───────────────────────────── tarefa periódica ─────────────────────────────

  /** Autor de uma ação recuperada: a lotação na unidade (ou qualquer lotação do usuário) dá o papel e o CBO. */
  private async autorRecuperado(sys: SystemContext, userId: string, unitId: string, papel?: string | null): Promise<Autor | null> {
    const lotacao =
      (await sys.db.userAssignment.findFirst({ where: { userId, unitId, ...(papel ? { role: papel as Role } : {}) }, select: { role: true, cbo: true } })) ??
      (await sys.db.userAssignment.findFirst({ where: { userId }, select: { role: true, cbo: true } }));
    return lotacao ? { userId, role: lotacao.role as Role, cbo: lotacao.cbo, unitId } : null;
  }

  /**
   * A cada 5 minutos: recupera o que o gatilho deixou de abrir, escala ao plantão e marca prazos vencidos.
   * Tudo idempotente (execuções sobrepostas não duplicam rascunho, alerta nem evento).
   */
  async tarefa(sys: SystemContext, agora = new Date()) {
    const resultado = { recuperadas: 0, escaladas: 0, vencidas: 0 };
    const desde = new Date(agora.getTime() - 2 * DIA);
    await this.catalogo.garantir(sys);
    const memo: Memo = { retratos: new Map() };
    memo.mapas = await sys.db.notifiableCodeMap.findMany({ where: { status: { not: 'INATIVO' } } });

    // 1a. Registros assinados nas últimas 48 h com código notificável (filtrado no banco, antes do limite).
    const cid = memo.mapas.filter((m) => m.system === 'CID10').map((m) => m.codePrefix);
    const ciap = memo.mapas.filter((m) => m.system === 'CIAP2').map((m) => m.codePrefix);
    const padrao = `^(?:(?:CID10:|CID:)?(?:${cid.join('|') || '$^'})|(?:CIAP2:|CIAP:)(?:${ciap.join('|') || '$^'}))`;
    const ids = await sys.db.$queryRaw<{ id: string }[]>`
      SELECT n.id FROM clinical_notes n
      WHERE n.status = 'ASSINADO' AND n.signed_at >= ${desde}
        AND EXISTS (SELECT 1 FROM unnest(n.codes) AS c WHERE upper(replace(c, '.', '')) ~ ${padrao})
      ORDER BY n.signed_at DESC LIMIT ${LIMITE_PENDENTES}`;
    if (ids.length === LIMITE_PENDENTES) this.logger.warn(`Varredura da vigilância: mais de ${LIMITE_PENDENTES} registros notificáveis em 48 h; ficam para a próxima execução os mais antigos`);
    const notas = ids.length ? await sys.db.clinicalNote.findMany({ where: { id: { in: ids.map((r) => r.id) } } }) : [];
    for (const nota of notas) {
      try {
        const e = await sys.db.encounter.findUnique({ where: { id: nota.encounterId }, select: { unitId: true } });
        const autor = e ? await this.autorRecuperado(sys, nota.authorId, e.unitId) : null;
        if (!autor) continue;
        const criados = await this.processarCodigos(
          sys,
          { encounterId: nota.encounterId, noteId: nota.id, codes: nota.codes, conhecimento: nota.signedAt ?? agora, origem: 'VARREDURA', autor: { ...autor, cbo: nota.cbo ?? autor.cbo } },
          memo,
        );
        resultado.recuperadas += criados.length;
      } catch (err) {
        this.logger.warn(`Varredura da nota ${nota.id}: ${(err as Error).message}`);
      }
    }

    // 1b. Falhas do gatilho no encerramento (CID principal e óbito) e na internação, registradas na auditoria.
    const falhas = await sys.db.auditEntry.findMany({ where: { action: 'vigilancia.erro_gatilho', at: { gte: desde } }, orderBy: { seq: 'asc' }, take: 500 });
    for (const f of falhas) {
      if (!f.entityId || !f.userId) continue;
      try {
        if (f.entityType === 'Admission') {
          const adm = await sys.db.admission.findUnique({ where: { id: f.entityId }, include: { encounter: { select: { unitId: true } } } });
          const autor = adm ? await this.autorRecuperado(sys, f.userId, f.unitId ?? adm.encounter.unitId, f.role) : null;
          if (!adm || !autor) continue;
          resultado.recuperadas += (await this.internacao(sys, adm, autor, f.at, 'VARREDURA', memo)).length;
        } else if (f.entityType === 'Encounter') {
          const e = await sys.db.encounter.findUnique({ where: { id: f.entityId }, select: { id: true, unitId: true, status: true, mainCid: true, outcome: true } });
          if (!e || (e.status !== 'ENCERRADO' && e.status !== 'EVADIU') || (!e.mainCid && e.outcome !== 'OBITO')) continue;
          const autor = await this.autorRecuperado(sys, f.userId, f.unitId ?? e.unitId, f.role);
          if (!autor) continue;
          resultado.recuperadas += (await this.encerramento(sys, e, autor, f.at, 'VARREDURA', memo)).length;
        } else if (f.entityType === 'ExamRequest') {
          const x = await sys.db.examRequest.findUnique({ where: { id: f.entityId } });
          if (!x || !x.qualitative || !POSITIVO.includes(x.qualitative as ResultadoQualitativo) || !exameVigilancia(x.examKey)) continue;
          const autor = await this.autorRecuperado(sys, f.userId, f.unitId ?? '', f.role);
          if (!autor) continue;
          resultado.recuperadas += (await this.resultadoPositivo(sys, x, autor, 'VARREDURA', memo)).length;
        }
      } catch (err) {
        this.logger.warn(`Reprocessamento de ${f.entityType} ${f.entityId}: ${(err as Error).message}`);
      }
    }

    // 2. Escalonamento: imediata confirmada sem recebimento pela SMS depois de ackMinutes.
    const ack = sys.tenant.settings.vigilancia.ackMinutes;
    const semCiencia = await sys.db.notification.findMany({
      where: { status: 'NOTIFICADA', deadlineKind: 'IMEDIATA', smsReceivedAt: null, escalatedAt: null, notifiedAt: { lte: new Date(agora.getTime() - ack * 60_000) }, ...SEM_COMUNICACAO_SMS },
      select: { id: true, number: true, unitId: true, status: true, deadlineKind: true, targets: true, dueAt: true, notifiedAt: true, smsReceivedAt: true, sensitive: true, condition: { select: { name: true } } },
    });
    const comSemCiencia = await this.comunicacoesDe(
      sys.db,
      semCiencia.map((n) => n.id),
    );
    for (const n of semCiencia) {
      const esf = await this.esferas(sys.db, n, agora, comSemCiencia);
      if (esf.lista.find((x) => x.esfera === 'SMS')?.cumpridaEm) continue;
      const { count } = await sys.db.notification.updateMany({ where: { id: n.id, escalatedAt: null }, data: { escalatedAt: agora } });
      if (count !== 1) continue;
      await sys.db.notificationEvent.create({ data: { notificationId: n.id, kind: 'ESCALADA', data: { minutos: ack } } });
      this.realtime.emitToTenant(sys.tenant.id, 'vigilancia:escalada', { id: n.id });
      await this.alertarPlantao(sys, n);
      resultado.escaladas++;
    }

    // 3. Prazo vencido perante a SMS: só o que ainda não cumpriu (rascunho, ou imediata sem ciência nem comunicação
    // por meio rápido); cada linha lida é marcada uma vez e não volta.
    const vencendo = await sys.db.notification.findMany({
      where: {
        overdueAt: null,
        dueAt: { lt: agora },
        OR: [{ status: 'RASCUNHO' }, { status: 'NOTIFICADA', deadlineKind: 'IMEDIATA', smsReceivedAt: null, ...SEM_COMUNICACAO_SMS }],
      },
      select: { id: true, unitId: true, status: true, deadlineKind: true, targets: true, dueAt: true, notifiedAt: true, smsReceivedAt: true },
    });
    const comVencendo = await this.comunicacoesDe(
      sys.db,
      vencendo.map((n) => n.id),
    );
    for (const n of vencendo) {
      const esf = await this.esferas(sys.db, n, agora, comVencendo);
      if (esf.lista.find((x) => x.esfera === 'SMS')?.situacao !== 'VENCIDO') continue;
      const { count } = await sys.db.notification.updateMany({ where: { id: n.id, overdueAt: null }, data: { overdueAt: agora } });
      if (count !== 1) continue;
      await sys.db.notificationEvent.create({ data: { notificationId: n.id, kind: 'PRAZO_VENCIDO' } });
      this.avisar(sys, n);
      resultado.vencidas++;
    }
    return resultado;
  }

  /** Alerta ao plantão por WhatsApp: número, agravo (ou "restrito") e unidade; nunca nome, CPF, CNS ou endereço. */
  private async alertarPlantao(sys: SystemContext, n: { number: string; unitId: string; dueAt: Date | null; sensitive: boolean; condition: { name: string } }) {
    const cfg = sys.tenant.settings.vigilancia;
    if (!sys.tenant.settings.whatsappEnabled || !cfg.whatsappAlerts || !cfg.onCallPhones.length) return;
    const unidade = await sys.db.unit.findUnique({ where: { id: n.unitId }, select: { name: true } });
    const template = buildSurveillanceAlertTemplate({
      number: n.number,
      condition: n.sensitive ? 'agravo de acesso restrito' : n.condition.name,
      unitName: unidade?.name ?? 'unidade',
      dueAt: n.dueAt,
      timeZone: sys.tenant.timeZone,
    });
    for (const tel of cfg.onCallPhones) {
      const phone = normalizeBrazilPhone(tel);
      if (phone) await this.messaging.sendTemplateNow(sys, null, phone, template);
    }
  }
}
