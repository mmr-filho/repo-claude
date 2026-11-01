import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { tenantSettings, type MasterClient, type TenantClient, type VigilanciaSettings } from '@omnisaude/database';
import { buildSurveillanceAlertTemplate, normalizeBrazilPhone } from '@omnisaude/messaging';
import {
  calcularPrazo,
  CONTEXTO_LABEL,
  escolherCondicao,
  ESFERA_LABEL,
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
import { DomainError, forbidden, notFound } from '../../core/errors';
import { RealtimeService } from '../../core/realtime.service';
import { JobsService } from '../integrations/jobs.service';
import { MessagingService, type SystemContext } from '../integrations/messaging.service';
import { CatalogoVigilanciaService, type CondicaoNoRetrato } from './catalogo.service';
import { CAMPOS_EDITAVEIS, montarFicha, semanasDaFicha, validarFicha, type Ficha } from './ficha';

const DIA = 86_400_000;
const RESTRITO = 'Agravo de acesso restrito';

type Comunicacao = Awaited<ReturnType<TenantClient['notificationCommunication']['findMany']>>[number];
type Origem = 'ATENDIMENTO' | 'OBITO' | 'INTERNACAO' | 'MANUAL' | 'VACINA' | 'VARREDURA';

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
    return this.protegido(ctx, nota.encounterId, () =>
      this.processarCodigos(ctx, { encounterId: nota.encounterId, noteId: nota.id, codes: nota.codes, conhecimento: nota.signedAt ?? new Date(), origem: 'ATENDIMENTO', autor: this.autor(ctx) }),
    );
  }

  /** Encerramento do atendimento: CID principal e, se óbito, as linhas de óbito dos agravos já notificados. */
  async aoEncerrarAtendimento(ctx: RequestContext, encontro: { id: string; mainCid: string | null; outcome: string | null }): Promise<RascunhoCriado[]> {
    return this.protegido(ctx, encontro.id, async () => {
      const autor = this.autor(ctx);
      // Primeiro o óbito ligado aos casos já notificados (guarda a relação); depois o CID principal, que não repete.
      const criados = encontro.outcome === 'OBITO' ? await this.obitosLigados(ctx, encontro.id, autor) : [];
      if (encontro.mainCid)
        criados.push(...(await this.processarCodigos(ctx, { encounterId: encontro.id, codes: [encontro.mainCid], conhecimento: new Date(), origem: encontro.outcome === 'OBITO' ? 'OBITO' : 'ATENDIMENTO', autor })));
      return criados;
    });
  }

  /** Internação: CID principal, com o prazo contado do conhecimento (a suspeita pode surgir dias depois). */
  async aoInternar(ctx: RequestContext, internacao: { id: string; encounterId: string; mainCid: string }): Promise<RascunhoCriado[]> {
    return this.protegido(ctx, internacao.encounterId, () =>
      this.processarCodigos(ctx, { encounterId: internacao.encounterId, admissionId: internacao.id, codes: [internacao.mainCid], conhecimento: new Date(), origem: 'INTERNACAO', autor: this.autor(ctx) }),
    );
  }

  /** O gatilho nunca impede o atendimento: a falha fica registrada e a varredura da tarefa periódica recupera. */
  private async protegido(ctx: RequestContext, encounterId: string, fn: () => Promise<RascunhoCriado[]>): Promise<RascunhoCriado[]> {
    try {
      return await fn();
    } catch (err) {
      const erro = (err as Error).message;
      this.logger.error(`Gatilho de notificação falhou no atendimento ${encounterId}: ${erro}`);
      await this.audit.recordStandalone(ctx, { action: 'vigilancia.erro_gatilho', entityType: 'Encounter', entityId: encounterId, payload: { erro: erro.slice(0, 500) } }).catch(() => undefined);
      return [];
    }
  }

  private autor(ctx: RequestContext): Autor {
    return { userId: ctx.session.userId, role: ctx.session.role, cbo: ctx.cbo ?? null, unitId: ctx.session.unitId };
  }

  private async processarCodigos(sys: SystemContext, p: { encounterId: string; noteId?: string; admissionId?: string; codes: string[]; conhecimento: Date; origem: Origem; autor: Autor }): Promise<RascunhoCriado[]> {
    const e = await sys.db.encounter.findUnique({ where: { id: p.encounterId }, include: { unit: true, patient: { select: { id: true, deceasedAt: true } } } });
    if (!e) return [];
    const dia = localDateString(e.startedAt, sys.tenant.timeZone);
    const { catalogo } = await this.catalogo.retrato(sys, dia);
    const gestante = (await sys.db.patientCondition.count({ where: { patientId: e.patientId, active: true, lineOfCare: 'GESTANTE' } })) > 0;
    const criados: RascunhoCriado[] = [];
    const vistos = new Set<string>();
    for (const bruto of p.codes) {
      const cod = normalizarCodigo(bruto);
      if (!cod) continue;
      const mapas = await this.catalogo.gruposDoCodigo(sys, cod.system, cod.code);
      for (const m of mapas) {
        const condicao = escolherCondicao(catalogo, m.groupKey, {
          obito: p.origem === 'OBITO' || e.outcome === 'OBITO' || !!e.patient.deceasedAt,
          gestante,
          amazoniaLegal: UF_AMAZONIA_LEGAL.has(e.unit.ibgeCode.slice(0, 2)),
          dica: (m.context as ContextoAgravo | null) ?? null,
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
          mapStatus: m.status as 'PROPOSTO' | 'HOMOLOGADO',
          primeiroAtendimento: e.startedAt,
          conhecimento: p.conhecimento,
          internacao: e.kind === 'INTERNACAO' || p.origem === 'INTERNACAO',
          // U07.1 já é covid-19 confirmada por laboratório: o prazo do item 60 conta da confirmação.
          confirmacao: condicao.notifyOn === 'CONFIRMACAO' && cod.code === 'U071' ? p.conhecimento : null,
          gestante,
        });
        if (r) criados.push(r);
      }
    }
    return criados;
  }

  /** Óbito: para cada agravo notificado no atendimento cujo grupo tem linha de óbito, cria a notificação do óbito ligada. */
  private async obitosLigados(sys: SystemContext, encounterId: string, autor: Autor): Promise<RascunhoCriado[]> {
    const e = await sys.db.encounter.findUniqueOrThrow({ where: { id: encounterId }, include: { unit: true } });
    const casos = await sys.db.notification.findMany({ where: { encounterId, status: { not: 'DESCARTADA' } }, include: { condition: true } });
    const { catalogo } = await this.catalogo.retrato(sys, localDateString(e.startedAt, sys.tenant.timeZone));
    const criados: RascunhoCriado[] = [];
    for (const caso of casos) {
      if (caso.condition.context === 'OBITO') continue;
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
    // A varredura só recupera o que o gatilho deixou de criar: não recria o que a vigilância já descartou.
    if (p.origem === 'VARREDURA' && p.encounterId && (await sys.db.notification.findFirst({ where: { encounterId: p.encounterId, conditionKey: c.key } }))) return null;
    if (!p.manual) {
      // Mesmo episódio: não repete a mesma notificação da mesma pessoa (uma vez por pessoa nos agravos crônicos).
      const anterior = await sys.db.notification.findFirst({
        where: { patientId: p.patientId, conditionKey: c.key, status: { not: 'DESCARTADA' }, ...(c.once ? {} : { createdAt: { gte: new Date(Date.now() - REPETICAO_DIAS * DIA) } }) },
      });
      if (anterior) return null;
    }
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
            residenceIbge: patient.ibgeCode,
            residenceLat: ficha.ID_GEO1,
            residenceLng: ficha.ID_GEO2,
            outOfMunicipality: !!patient.ibgeCode && patient.ibgeCode !== unit.ibgeCode,
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
        const code = (err as { code?: string; meta?: { target?: unknown } }).code;
        if (code !== 'P2002') throw err;
        // Mesmo atendimento e agravo já tem rascunho ativo (índice único): idempotência do gatilho.
        if (p.encounterId && (await sys.db.notification.findFirst({ where: { encounterId: p.encounterId, conditionKey: c.key, status: { not: 'DESCARTADA' } } }))) return null;
      }
    }
    throw new DomainError('NUMERACAO_INDISPONIVEL', 'Não foi possível numerar a notificação; tente de novo');
  }

  /** Evento em tempo real sem dado pessoal (número, agravo ou "restrito", unidade). */
  private avisar(sys: { tenant: { id: string } }, n: { id: string; number: string; unitId: string; status: string; deadlineKind: string; sensitive: boolean }) {
    const payload = { id: n.id, numero: n.number, status: n.status, prazo: n.deadlineKind, sigiloso: n.sensitive };
    this.realtime.emitToTenant(sys.tenant.id, 'vigilancia:notificacao', payload);
    this.realtime.emitToUnit(sys.tenant.id, n.unitId, 'vigilancia:notificacao', payload);
  }

  // ───────────────────────────── notificação manual ─────────────────────────────

  async criarManual(ctx: RequestContext, input: { patientId: string; conditionKey: string; encounterId?: string | null; vaccinationId?: string | null; knownAt?: string | null; symptomsOnset?: string | null }) {
    const agora = new Date();
    const conhecimento = input.knownAt ? new Date(input.knownAt) : agora;
    if (conhecimento.getTime() > agora.getTime() + 60_000) throw new DomainError('DATA_FUTURA', 'A data de conhecimento não pode ser futura', HttpStatus.BAD_REQUEST);
    const paciente = await ctx.db.patient.findUnique({ where: { id: input.patientId } });
    if (!paciente || paciente.mergedIntoId) throw notFound('Paciente');
    let encontro = input.encounterId ? await ctx.db.encounter.findUnique({ where: { id: input.encounterId } }) : null;
    if (input.encounterId && (!encontro || encontro.patientId !== input.patientId)) throw notFound('Atendimento');
    if (input.vaccinationId) {
      const vac = await ctx.db.vaccination.findUnique({ where: { id: input.vaccinationId } });
      if (!vac || vac.patientId !== input.patientId) throw notFound('Vacinação');
      if (!encontro && vac.encounterId) encontro = await ctx.db.encounter.findUnique({ where: { id: vac.encounterId } });
    }
    const { catalogo } = await this.catalogo.retrato(ctx, localDateString(conhecimento, ctx.tenant.timeZone));
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
    n: { id: string; deadlineKind: string; targets: string[]; dueAt: Date | null; notifiedAt: Date | null; smsReceivedAt: Date | null; status: string },
    agora = new Date(),
    carregadas?: Map<string, Comunicacao[]>,
  ) {
    const comunicacoes = carregadas ? (carregadas.get(n.id) ?? []) : await db.notificationCommunication.findMany({ where: { notificationId: n.id }, orderBy: { communicatedAt: 'asc' } });
    const primeiraFora = (alvo: string) => comunicacoes.find((c) => c.target === alvo && c.channel !== 'SISTEMA')?.communicatedAt ?? null;
    const smsCumprida = n.deadlineKind === 'IMEDIATA' ? ([n.smsReceivedAt, primeiraFora('SMS')].filter(Boolean).sort((a, b) => a!.getTime() - b!.getTime())[0] ?? null) : n.status === 'NOTIFICADA' ? n.notifiedAt : null;
    const lista = (n.targets.length ? n.targets : ['SMS']).map((alvo) => {
      if (alvo === 'SMS')
        return { esfera: 'SMS' as const, rotulo: ESFERA_LABEL.SMS, venceEm: n.dueAt?.toISOString() ?? null, cumpridaEm: smsCumprida?.toISOString() ?? null, situacao: situacaoDoPrazo(n.dueAt, smsCumprida, agora) };
      const vence = n.smsReceivedAt ? prazoRepasse(n.smsReceivedAt) : null;
      const feita = primeiraFora(alvo);
      return {
        esfera: alvo as Esfera,
        rotulo: ESFERA_LABEL[alvo as Esfera],
        venceEm: vence?.toISOString() ?? null,
        cumpridaEm: feita?.toISOString() ?? null,
        situacao: n.smsReceivedAt ? situacaoDoPrazo(vence, feita, agora) : feita ? 'CUMPRIDO' : 'SEM_PRAZO',
      };
    });
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
          where: { id: { in: [...new Set([n.notifierId, ...eventos.map((e) => e.userId), ...esferas.comunicacoes.map((c) => c.userId), n.smsReceivedBy].filter((x): x is string => !!x))] } },
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
      permissoes: {
        editar: n.status !== 'DESCARTADA' && (n.notifierId === ctx.session.userId || ctx.session.role === 'VIGILANCIA_EPIDEMIOLOGICA' || ctx.session.role === 'NUCLEO_VIGILANCIA'),
        confirmar: n.status === 'RASCUNHO',
        descartar: n.status !== 'DESCARTADA' && (this.pode(ctx, 'notificacao.descartar') || (n.status === 'RASCUNHO' && n.deadlineKind === 'SEMANAL' && n.notifierId === ctx.session.userId)),
        ciencia: n.status === 'NOTIFICADA' && !n.smsReceivedAt && this.pode(ctx, 'vigilancia.ciencia'),
        comunicar: n.status === 'NOTIFICADA' && this.pode(ctx, 'vigilancia.comunicar'),
      },
      aviso: 'O OmniSaúde não envia esta ficha ao Sinan: o registro no sistema oficial é feito por digitação (fila da semana 24).',
    };
  }

  /** Edita a ficha (rascunho ou notificada): subitem do mesmo grupo, critério, datas e os campos editáveis da FIN. */
  async editar(
    ctx: RequestContext,
    id: string,
    input: { conditionKey?: string; basis?: 'SUSPEITA' | 'CONFIRMADO'; confirmedAt?: string | null; symptomsOnset?: string | null; ficha?: Partial<Record<(typeof CAMPOS_EDITAVEIS)[number], string | null>> },
  ) {
    const n = await this.carregar(ctx, id);
    if (n.status === 'DESCARTADA') throw new DomainError('DESCARTADA', 'Notificação descartada', HttpStatus.UNPROCESSABLE_ENTITY);
    if (!(n.notifierId === ctx.session.userId || ctx.session.role === 'VIGILANCIA_EPIDEMIOLOGICA' || ctx.session.role === 'NUCLEO_VIGILANCIA')) throw forbidden('Só o autor ou a vigilância editam a ficha');
    const hoje = localDateString(new Date(), ctx.tenant.timeZone);
    if (input.symptomsOnset && input.symptomsOnset > hoje) throw new DomainError('DATA_FUTURA', 'A data dos primeiros sintomas não pode ser futura', HttpStatus.BAD_REQUEST);
    if (input.confirmedAt && new Date(input.confirmedAt).getTime() > Date.now() + 60_000) throw new DomainError('DATA_FUTURA', 'A data de confirmação não pode ser futura', HttpStatus.BAD_REQUEST);
    let condicao = { ...n.condition, group: n.condition.groupKey } as CondicaoNoRetrato;
    if (input.conditionKey && input.conditionKey !== n.conditionKey) {
      const { catalogo } = await this.catalogo.retrato(ctx, localDateString(n.deadlineStartAt ?? n.knownAt, ctx.tenant.timeZone));
      const nova = catalogo.find((c) => c.key === input.conditionKey && c.groupKey === n.groupKey);
      if (!nova) throw new DomainError('SUBITEM_INVALIDO', 'Escolha um subitem do mesmo agravo', HttpStatus.BAD_REQUEST);
      condicao = nova;
    }
    const confirmedAt = input.confirmedAt !== undefined ? (input.confirmedAt ? new Date(input.confirmedAt) : null) : n.confirmedAt;
    const prazo = calcularPrazo(condicao, { atendimento: n.firstCareAt, conhecimento: n.knownAt, confirmacao: confirmedAt, internacao: n.origin === 'INTERNACAO' });
    const ficha = { ...(n.form as unknown as Ficha) };
    for (const campo of CAMPOS_EDITAVEIS) if (input.ficha && campo in input.ficha) (ficha as unknown as Record<string, unknown>)[campo] = input.ficha[campo] ?? null;
    ficha.ID_AGRAVO = { ...ficha.ID_AGRAVO, nome: condicao.name, item: condicao.item, subitem: condicao.subitem };
    const sintomas = input.symptomsOnset !== undefined ? input.symptomsOnset : (n.symptomsOnset?.toISOString().slice(0, 10) ?? null);
    if (sintomas) ficha.DT_SIN_PRI = sintomas;
    const antes = { condicao: n.conditionKey, criterio: n.basis, confirmacao: n.confirmedAt?.toISOString() ?? null, sintomas: n.symptomsOnset?.toISOString().slice(0, 10) ?? null };
    const depois = { condicao: condicao.key, criterio: input.basis ?? n.basis, confirmacao: confirmedAt?.toISOString() ?? null, sintomas };
    await ctx.db.notification.update({
      where: { id },
      data: {
        conditionId: condicao.id,
        conditionKey: condicao.key,
        sensitive: condicao.sensitive,
        basis: input.basis ?? n.basis,
        confirmedAt,
        deadlineStart: prazo.marco,
        deadlineKind: prazo.tipo,
        targets: prazo.esferas,
        deadlineStartAt: prazo.inicio,
        dueAt: prazo.vence,
        symptomsOnset: sintomas ? new Date(`${sintomas}T00:00:00Z`) : null,
        epiWeekOnset: sintomas ? semanasDaFicha(null, sintomas).SEM_PRI : null,
        form: ficha as object,
        events: { create: { kind: condicao.key !== n.conditionKey ? 'SUBITEM_ALTERADO' : 'EDITADA', userId: ctx.session.userId, data: { antes, depois, ficha: input.ficha ?? null } } },
      },
    });
    if (n.status === 'NOTIFICADA') await this.audit.recordStandalone(ctx, { action: 'notificacao.editar', entityType: 'Notification', entityId: id, payload: { antes, depois } });
    return this.detalhe(ctx, id);
  }

  /** Confirma a notificação: valida a FIN, grava a data, a semana epidemiológica e a comunicação à SMS pelo sistema. */
  async confirmar(ctx: RequestContext, id: string) {
    const n = await this.carregar(ctx, id);
    if (n.status !== 'RASCUNHO') throw new DomainError('NAO_E_RASCUNHO', 'Só um rascunho pode ser confirmado', HttpStatus.UNPROCESSABLE_ENTITY);
    if (!(n.notifierId === ctx.session.userId || ctx.session.role === 'VIGILANCIA_EPIDEMIOLOGICA' || ctx.session.role === 'NUCLEO_VIGILANCIA')) throw forbidden('Só o autor ou a vigilância confirmam');
    const agora = new Date();
    const hoje = localDateString(agora, ctx.tenant.timeZone);
    const ficha = { ...(n.form as unknown as Ficha), DT_NOTIFIC: hoje };
    const sintomas = n.symptomsOnset?.toISOString().slice(0, 10) ?? null;
    const erros = validarFicha(ficha, { notificadaEm: agora, sintomas, hoje });
    if (erros.length) throw new DomainError('FICHA_INVALIDA', erros.join('; '), HttpStatus.BAD_REQUEST, { erros });
    const semanas = semanasDaFicha(hoje, sintomas);
    await ctx.db.$transaction(async (tx) => {
      await tx.notification.update({ where: { id }, data: { status: 'NOTIFICADA', notifiedAt: agora, epiWeekNotified: semanas.SEM_NOT, epiWeekOnset: semanas.SEM_PRI, form: ficha as object } });
      await tx.notificationCommunication.create({
        data: { notificationId: id, target: 'SMS', channel: 'SISTEMA', communicatedAt: agora, counterpartName: 'Vigilância epidemiológica municipal (painel do OmniSaúde)', userId: ctx.session.userId },
      });
      await tx.notificationEvent.create({ data: { notificationId: id, kind: 'CONFIRMADA', userId: ctx.session.userId, data: { semana: semanas.SEM_NOT } } });
      await this.audit.record(ctx, tx, { action: 'notificacao.confirmar', entityType: 'Notification', entityId: id, payload: { numero: n.number, agravo: n.conditionKey } });
    });
    this.avisar(ctx, { ...n, status: 'NOTIFICADA' });
    return this.detalhe(ctx, id);
  }

  /** Descarte com motivo; imediata ou já confirmada só pela vigilância municipal. */
  async descartar(ctx: RequestContext, id: string, motivo: string) {
    const n = await this.carregar(ctx, id);
    if (n.status === 'DESCARTADA') throw new DomainError('JA_DESCARTADA', 'Notificação já descartada', HttpStatus.UNPROCESSABLE_ENTITY);
    const exigeVigilancia = n.status === 'NOTIFICADA' || n.deadlineKind === 'IMEDIATA';
    if (exigeVigilancia && !this.pode(ctx, 'notificacao.descartar')) throw forbidden('Notificação imediata ou já confirmada só é descartada pela vigilância municipal');
    if (!exigeVigilancia && n.notifierId !== ctx.session.userId && !this.pode(ctx, 'notificacao.descartar')) throw forbidden('Só o autor descarta o próprio rascunho');
    await ctx.db.$transaction(async (tx) => {
      await tx.notification.update({ where: { id }, data: { status: 'DESCARTADA', discardReason: motivo.trim(), discardedBy: ctx.session.userId, discardedAt: new Date() } });
      await tx.notificationEvent.create({ data: { notificationId: id, kind: 'DESCARTADA', userId: ctx.session.userId, notes: motivo.trim() } });
      await this.audit.record(ctx, tx, { action: 'notificacao.descartar', entityType: 'Notification', entityId: id, payload: { numero: n.number, motivo } });
    });
    this.avisar(ctx, { ...n, status: 'DESCARTADA' });
    return this.detalhe(ctx, id);
  }

  /** Ciência da SMS (vigilância municipal): cumpre a imediata perante a SMS e abre o prazo de 24 h do repasse. */
  async ciencia(ctx: RequestContext, id: string) {
    const n = await this.carregar(ctx, id);
    if (n.status !== 'NOTIFICADA') throw new DomainError('NAO_NOTIFICADA', 'Confirme a notificação antes de dar ciência', HttpStatus.UNPROCESSABLE_ENTITY);
    if (n.smsReceivedAt) throw new DomainError('JA_CIENTE', 'A vigilância já deu ciência', HttpStatus.UNPROCESSABLE_ENTITY);
    const agora = new Date();
    await ctx.db.$transaction(async (tx) => {
      await tx.notification.update({ where: { id }, data: { smsReceivedAt: agora, smsReceivedBy: ctx.session.userId } });
      await tx.notificationEvent.create({
        data: { notificationId: id, kind: 'CIENCIA_SMS', userId: ctx.session.userId, data: { repasseAte: n.targets.some((t) => t !== 'SMS') ? prazoRepasse(agora).toISOString() : null } },
      });
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
      target: Esfera;
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
    if (n.status !== 'NOTIFICADA') throw new DomainError('NAO_NOTIFICADA', 'Confirme a notificação antes de registrar comunicações', HttpStatus.UNPROCESSABLE_ENTITY);
    if (ctx.session.role === 'NUCLEO_VIGILANCIA' && input.target !== 'SMS') throw forbidden('O núcleo do estabelecimento comunica à SMS; o repasse à SES e ao MS é da vigilância municipal');
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
    const saida = [];
    for (const n of rows) {
      const aberto = !n.sensitive || this.abreSigiloso(ctx, n);
      const esferas = await this.esferas(ctx.db, n, agora, comunicacoes);
      const sms = esferas.lista.find((e) => e.esfera === 'SMS')!;
      const repasses = esferas.lista.filter((e) => e.esfera !== 'SMS');
      saida.push({
        id: n.id,
        numero: n.number,
        status: n.status,
        origem: n.origin,
        agravo: aberto ? n.condition.name : RESTRITO,
        grupo: aberto ? n.groupKey : null,
        sigiloso: n.sensitive,
        naoHomologado: n.mapStatus === 'PROPOSTO',
        paciente: aberto ? (pacientes.get(n.patientId) ?? null) : null,
        unidade: unidades.get(n.unitId) ?? null,
        prazo: n.deadlineKind,
        esferas: n.targets,
        venceEm: n.dueAt?.toISOString() ?? null,
        situacaoSms: n.status === 'DESCARTADA' ? 'SEM_PRAZO' : sms.situacao,
        repasses: repasses.map((r) => ({ esfera: r.esfera, situacao: r.situacao, venceEm: r.venceEm })),
        ciencia: !!n.smsReceivedAt,
        escalada: !!n.escalatedAt,
        semana: n.epiWeekNotified,
        criadaEm: n.createdAt.toISOString(),
      });
    }
    return saida;
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
    const where = {
      ...this.where(ctx),
      ...(q.status ? { status: q.status as 'RASCUNHO' } : { status: { not: 'DESCARTADA' as const } }),
      ...(q.grupo ? { groupKey: q.grupo } : {}),
      ...(q.unitId && ctx.session.role === 'VIGILANCIA_EPIDEMIOLOGICA' ? { unitId: q.unitId } : {}),
      ...(q.semana ? { epiWeekNotified: q.semana } : {}),
    };
    const linhas = (await this.linhas(ctx, await this.buscar(ctx, where, 300))).filter((l) => {
      if (!q.situacao) return true;
      if (q.situacao === 'VENCIDO') return l.situacaoSms === 'VENCIDO' || l.repasses.some((r) => r.situacao === 'VENCIDO');
      if (q.situacao === 'REPASSE') return l.repasses.some((r) => r.situacao !== 'CUMPRIDO');
      return l.situacaoSms === q.situacao;
    });
    const abertas = await this.linhas(ctx, await this.buscar(ctx, { ...this.where(ctx), status: { in: ['RASCUNHO', 'NOTIFICADA'] } }, 500));
    const descartes = await ctx.db.notification.count({ where: { ...this.where(ctx), status: 'DESCARTADA', discardedAt: { gte: new Date(Date.now() - 30 * DIA) } } });
    return {
      cartoes: {
        imediatasAguardandoCiencia: abertas.filter((l) => l.status === 'NOTIFICADA' && l.prazo === 'IMEDIATA' && !l.ciencia).length,
        rascunhosImediatos: abertas.filter((l) => l.status === 'RASCUNHO' && l.prazo === 'IMEDIATA').length,
        repassesPendentes: abertas.filter((l) => l.repasses.some((r) => r.situacao !== 'CUMPRIDO')).length,
        vencidas: abertas.filter((l) => l.situacaoSms === 'VENCIDO' || l.repasses.some((r) => r.situacao === 'VENCIDO')).length,
        semanaisAVencer: abertas.filter((l) => l.prazo === 'SEMANAL' && (l.situacaoSms === 'A_VENCER' || l.situacaoSms === 'NO_PRAZO') && l.status === 'RASCUNHO').length,
        descartes30d: descartes,
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

  /** Gestão: só contagens, sem lista nominal. */
  async resumo(ctx: RequestContext) {
    const abertas = await ctx.db.notification.findMany({
      where: { status: { in: ['RASCUNHO', 'NOTIFICADA'] } },
      select: { id: true, status: true, deadlineKind: true, targets: true, dueAt: true, notifiedAt: true, smsReceivedAt: true },
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
      if (sms.situacao === 'VENCIDO' || e.lista.some((x) => x.situacao === 'VENCIDO')) vencidas++;
      else if (n.deadlineKind === 'IMEDIATA') noPrazo++;
      if (e.lista.some((x) => x.esfera !== 'SMS' && x.situacao !== 'CUMPRIDO')) repasses++;
    }
    return { imediatasNoPrazo: noPrazo, vencidas, repassesPendentes: repasses, semana: semanaEpidemiologica(new Date(), ctx.tenant.timeZone).codigo };
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
    };
    await this.master.tenant.update({ where: { id: ctx.tenant.id }, data: { settings: { ...atual, vigilancia } as object } });
    this.tenants.connections.invalidate(ctx.tenant.slug);
    this.tenants.connections.invalidate(ctx.tenant.id);
    await this.audit.recordStandalone(ctx, {
      action: 'vigilancia.configuracoes',
      entityType: 'Tenant',
      entityId: ctx.tenant.id,
      payload: { ackMinutes: vigilancia.ackMinutes, telefones: vigilancia.onCallPhones.length, whatsappAlerts: vigilancia.whatsappAlerts },
    });
    return { ...vigilancia, whatsappEnabled: atual.whatsappEnabled };
  }

  // ───────────────────────────── tarefa periódica ─────────────────────────────

  /** A cada 5 minutos: varredura de recuperação do gatilho, escalonamento ao plantão e prazos vencidos. */
  async tarefa(sys: SystemContext, agora = new Date()) {
    const resultado = { recuperadas: 0, escaladas: 0, vencidas: 0 };
    // 1. Varredura: registros assinados nas últimas 48 h com códigos (o gatilho é idempotente).
    const notas = await sys.db.clinicalNote.findMany({
      where: { status: 'ASSINADO', signedAt: { gte: new Date(agora.getTime() - 2 * DIA) }, NOT: { codes: { isEmpty: true } } },
      take: 500,
      orderBy: { signedAt: 'desc' },
    });
    await this.catalogo.garantir(sys);
    const mapas = await sys.db.notifiableCodeMap.findMany({ where: { status: { not: 'INATIVO' } }, select: { system: true, codePrefix: true } });
    const notificavel = (bruto: string) => {
      const cod = normalizarCodigo(bruto);
      return !!cod && mapearCodigo(mapas, cod.system, cod.code).length > 0;
    };
    for (const nota of notas.filter((x) => x.codes.some(notificavel))) {
      try {
        const e = await sys.db.encounter.findUnique({ where: { id: nota.encounterId }, select: { unitId: true } });
        if (!e) continue;
        const autor =
          (await sys.db.userAssignment.findFirst({ where: { userId: nota.authorId, unitId: e.unitId }, select: { role: true, cbo: true } })) ??
          (await sys.db.userAssignment.findFirst({ where: { userId: nota.authorId }, select: { role: true, cbo: true } }));
        if (!autor) continue;
        const criados = await this.processarCodigos(sys, {
          encounterId: nota.encounterId,
          noteId: nota.id,
          codes: nota.codes,
          conhecimento: nota.signedAt ?? agora,
          origem: 'VARREDURA',
          autor: { userId: nota.authorId, role: autor.role as Role, cbo: nota.cbo ?? autor.cbo, unitId: e.unitId },
        });
        resultado.recuperadas += criados.length;
      } catch (err) {
        this.logger.warn(`Varredura da nota ${nota.id}: ${(err as Error).message}`);
      }
    }
    // 2. Escalonamento: imediata confirmada sem ciência depois de ackMinutes.
    const ack = sys.tenant.settings.vigilancia.ackMinutes;
    const semCiencia = await sys.db.notification.findMany({
      where: { status: 'NOTIFICADA', deadlineKind: 'IMEDIATA', smsReceivedAt: null, escalatedAt: null, notifiedAt: { lte: new Date(agora.getTime() - ack * 60_000) } },
      include: { condition: true },
    });
    for (const n of semCiencia) {
      const esf = await this.esferas(sys.db, n, agora);
      if (esf.lista.find((x) => x.esfera === 'SMS')?.cumpridaEm) continue;
      await sys.db.notification.update({ where: { id: n.id }, data: { escalatedAt: agora, events: { create: { kind: 'ESCALADA', data: { minutos: ack } } } } });
      this.realtime.emitToTenant(sys.tenant.id, 'vigilancia:escalada', { id: n.id, numero: n.number, sigiloso: n.sensitive });
      await this.alertarPlantao(sys, n);
      resultado.escaladas++;
    }
    // 3. Prazo vencido sem cumprimento perante a SMS.
    const abertas = await sys.db.notification.findMany({ where: { status: { in: ['RASCUNHO', 'NOTIFICADA'] }, overdueAt: null, dueAt: { lt: agora } } });
    for (const n of abertas) {
      const esf = await this.esferas(sys.db, n, agora);
      if (esf.lista.find((x) => x.esfera === 'SMS')?.situacao !== 'VENCIDO') continue;
      await sys.db.notification.update({ where: { id: n.id }, data: { overdueAt: agora, events: { create: { kind: 'PRAZO_VENCIDO' } } } });
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
