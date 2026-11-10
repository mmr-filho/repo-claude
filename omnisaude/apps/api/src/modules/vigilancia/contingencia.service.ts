import { HttpStatus, Injectable } from '@nestjs/common';
import type { TenantPrisma } from '@omnisaude/database';
import {
  avaliarPlano,
  localDateString,
  PLANO_MODELO_MS_2025,
  semanaDaData,
  semanaEpidemiologica,
  semanasCompletas,
  semanasNoAno,
  type AcaoChecklist,
  type AcionamentoResumo,
  type CorpoAcionar,
  type CorpoAtualizarAcao,
  type CorpoEditarPlano,
  type CorpoNovoPlano,
  type CorpoRespostaCriterio,
  type CorpoVigenciaPlano,
  type DetalhePlano,
  type EixoAcao,
  type IndicadoresAgravo,
  type ListaPlanos,
  type NivelTerritorio,
  type PlanoContingencia,
  type PlanoResumo,
  type RespostaAcionar,
  type RespostaManualCriterio,
  type SituacaoContingencia,
  type StatusAcao,
  type StatusPlano,
  type TerritorioRef,
  type TipoCriterio,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { conflict, DomainError, notFound } from '../../core/errors';
import type { SystemContext } from '../integrations/messaging.service';
import { ConsolidadoService } from './consolidado.service';
import { DiagramaService } from './diagrama.service';

type Db = TenantPrisma.TransactionClient;

/** Escopo do plano das arboviroses (o único desta semana). */
const ESCOPO = 'ARBOVIROSES';
const FONTE_MODELO = 'Plano de Contingência Nacional para Dengue, Chikungunya e Zika (MS, 2025), Apêndice B (orientação para os planos municipais)';
const NOME_MODELO = 'Plano de contingência das arboviroses (modelo do MS, 2025)';
const DIA = 86_400_000;

const CANAL: TipoCriterio[] = ['CANAL_ACIMA_CENTRO', 'CANAL_ENTRE_CENTRO_E_LS', 'CANAL_ACIMA_LS'];
const PERCENTUAIS: TipoCriterio[] = ['PERCENTUAL_GRAVES', 'LETALIDADE', 'LETALIDADE_GRAVES', 'OBITOS_INVESTIGACAO_PERCENTUAL'];

const dia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const dataCivil = (iso: string) => new Date(`${iso}T00:00:00Z`);
const vespera = (iso: string) => new Date(Date.parse(`${iso}T12:00:00Z`) - DIA).toISOString().slice(0, 10);
const copia = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
/** Definição gravada (jsonb) como o tipo do plano. */
const definicaoDe = (j: unknown) => j as PlanoContingencia;

/**
 * Regras do plano além do formato (zod no controller): estágios e critérios únicos, normalidade sem critério, agravos
 * do critério dentro dos do plano, semanas nos critérios de canal, limiar nos numéricos e ações de estágios que existem.
 */
export function validarDefinicao(d: PlanoContingencia): string[] {
  const erros: string[] = [];
  const chaves = d.estagios.map((e) => e.chave);
  if (new Set(chaves).size !== chaves.length) erros.push('Há estágios com a mesma chave.');
  if (new Set(d.estagios.map((e) => e.ordem)).size !== d.estagios.length) erros.push('Há estágios com a mesma ordem.');
  const menor = Math.min(...d.estagios.map((e) => e.ordem));
  if (menor !== 0) erros.push('O primeiro estágio (normalidade) tem ordem 0.');
  const ordem = new Map(d.estagios.map((e) => [e.chave, e.ordem]));
  if (new Set(d.agravos).size !== d.agravos.length) erros.push('Há agravos repetidos no plano.');
  const ids = new Set<string>();
  for (const c of d.criterios) {
    const onde = `Critério ${c.id}`;
    if (ids.has(c.id)) erros.push(`${onde}: identificador repetido.`);
    ids.add(c.id);
    if (!ordem.has(c.estagio)) erros.push(`${onde}: estágio ${c.estagio} não existe no plano.`);
    else if (ordem.get(c.estagio) === 0) erros.push(`${onde}: a normalidade não tem critério (é o estado padrão).`);
    const fora = c.agravos.filter((a) => !d.agravos.includes(a));
    if (fora.length) erros.push(`${onde}: agravo(s) fora do plano (${fora.join(', ')}).`);
    if (CANAL.includes(c.tipo)) {
      if (c.modo === 'K_DE_N') {
        const n = c.n ?? c.semanas;
        if (!c.k || !n) erros.push(`${onde}: informe k e n (pelo menos k das últimas n semanas).`);
        else if (c.k > n) erros.push(`${onde}: k não pode ser maior que n.`);
      } else if (!c.semanas) erros.push(`${onde}: informe quantas semanas seguidas o critério pede.`);
    } else if (c.tipo !== 'MANUAL') {
      if (c.limiar === undefined || c.limiar === null) erros.push(`${onde}: informe o limiar.`);
      else if (PERCENTUAIS.includes(c.tipo) && c.limiar > 100) erros.push(`${onde}: o limiar é um percentual (até 100).`);
    }
  }
  for (const a of d.acoes) if (!ordem.has(a.estagio)) erros.push(`Ação "${a.descricao}": estágio ${a.estagio} não existe no plano.`);
  return erros;
}

/** Ações do checklist: as do estágio e as dos anteriores ("manter e intensificar"), na ordem dos estágios. */
export function acoesDoEstagio(d: PlanoContingencia, estagio: string): PlanoContingencia['acoes'] {
  const ordem = new Map(d.estagios.map((e) => [e.chave, e.ordem]));
  const limite = ordem.get(estagio);
  if (limite === undefined) return [];
  return d.acoes
    .map((a, i) => ({ a, i, o: ordem.get(a.estagio) }))
    .filter((x) => x.o !== undefined && x.o <= limite)
    .sort((x, y) => x.o! - y.o! || x.i - y.i)
    .map((x) => x.a);
}

type PlanoRow = { id: string; scope: string; name: string; version: number; status: StatusPlano; validFrom: Date | null; validTo: Date | null; source: string | null; definition: unknown; updatedAt: Date };

function resumo(p: PlanoRow): PlanoResumo {
  return { id: p.id, escopo: p.scope, nome: p.name, versao: p.version, status: p.status, vigenteDesde: dia(p.validFrom), vigenteAte: dia(p.validTo), fonte: p.source, atualizadoEm: p.updatedAt.toISOString() };
}

const detalhe = (p: PlanoRow): DetalhePlano => ({ ...resumo(p), definicao: definicaoDe(p.definition) });

/**
 * Plano de contingência (VIG-1c, §4.2; frente F3): estágio em vigor, sugestão da semana de referência
 * (`avaliarPlano`), respostas manuais, histórico de acionamentos e checklist do acionamento aberto. Escrita com
 * `vigilancia.contingencia`. O sistema sugere; a vigilância decide e registra o acionamento (Plano 2025, item 7.1).
 * O estágio em vigor é o do acionamento aberto do território, de qualquer versão do plano: trocar o plano não desfaz a
 * decisão, e o próximo acionamento fecha o aberto (vigências sem sobreposição).
 */
@Injectable()
export class ContingenciaService {
  /** Relógio do serviço (os testes trocam por uma data fixa). */
  agora: () => Date = () => new Date();

  constructor(
    private readonly audit: AuditService,
    private readonly diagramas: DiagramaService,
    private readonly consolidado: ConsolidadoService,
  ) {}

  // ───────────── leitura ─────────────

  /** GET /vigilancia/contingencia?nivel=&territorio=. */
  async situacao(ctx: RequestContext, consulta: { nivel?: NivelTerritorio; territorio?: string }): Promise<SituacaoContingencia> {
    const territorio = await this.diagramas.territorio(ctx.db, consulta.nivel ?? 'MUNICIPIO', consulta.territorio ?? null);
    const plano = await this.vigente(ctx.db);
    const definicao = plano ? definicaoDe(plano.definition) : null;
    const semanaAtual = semanaEpidemiologica(this.agora(), ctx.tenant.timeZone).codigo;
    const { incompletas, ultimaCompleta } = semanasCompletas(semanaAtual, ctx.tenant.settings.vigilancia.consolidacao.semanasIncompletas);
    const avisos: string[] = [];
    const indicadores = await this.indicadores(ctx, definicao?.agravos ?? PLANO_MODELO_MS_2025.agravos, territorio, semanaAtual, avisos);
    const acionamentos = await ctx.db.contingencyActivation.findMany({
      where: { level: territorio.nivel, territoryId: territorio.id },
      include: { plan: { select: { definition: true } } },
      orderBy: [{ startedOn: 'desc' }, { decidedAt: 'desc' }],
    });
    const aberto = acionamentos.find((a) => a.endedOn === null) ?? null;
    const nomes = await this.nomes(
      ctx.db,
      acionamentos.map((a) => a.decidedBy),
    );
    const normalidade = [...(definicao?.estagios ?? PLANO_MODELO_MS_2025.estagios)].sort((a, b) => a.ordem - b.ordem)[0]!;
    const estagioAtual = aberto
      ? { chave: aberto.stage, nome: this.nomeDoEstagio(definicaoDe(aberto.plan.definition), aberto.stage), desde: dia(aberto.startedOn), acionamentoId: aberto.id }
      : { chave: normalidade.chave, nome: normalidade.nome, desde: null, acionamentoId: null };
    const respostas = plano ? await this.respostasDaSemana(ctx.db, plano.id, territorio, ultimaCompleta) : [];
    const avaliacao = definicao
      ? avaliarPlano(
          definicao,
          indicadores,
          respostas.map((r) => ({ criterio: r.criterio, atendido: r.atendido })),
          estagioAtual.chave,
        )
      : null;
    if (!plano) avisos.unshift('Sem plano de contingência em vigor: crie um a partir do modelo do MS e ponha em vigor para ter a sugestão de estágio.');
    if (aberto && definicao && aberto.planId !== plano!.id && !definicao.estagios.some((e) => e.chave === aberto.stage))
      avisos.push(`O estágio em vigor (${estagioAtual.nome}) é de outra versão do plano e não existe no plano vigente: registre um novo acionamento.`);
    const checklist = aberto ? await this.checklist(ctx.db, aberto.id, definicaoDe(aberto.plan.definition)) : [];
    return {
      territorio,
      plano: plano ? detalhe(plano) : null,
      estagioAtual,
      semanaReferencia: ultimaCompleta,
      semanasIncompletas: incompletas,
      indicadores,
      avaliacao,
      respostas,
      historico: acionamentos.map((a) => this.acionamentoResumo(a, definicaoDe(a.plan.definition), nomes)),
      checklist,
      avisos,
    };
  }

  /** GET /vigilancia/contingencia/planos. */
  async planos(ctx: RequestContext): Promise<ListaPlanos> {
    const planos = await ctx.db.contingencyPlan.findMany({ orderBy: [{ updatedAt: 'desc' }] });
    const ordem: Record<StatusPlano, number> = { VIGENTE: 0, RASCUNHO: 1, ARQUIVADO: 2 };
    return planos.sort((a, b) => ordem[a.status] - ordem[b.status]).map(resumo);
  }

  /** GET /vigilancia/contingencia/planos/:id: plano com a definição (para a tela de edição). */
  async plano(ctx: RequestContext, id: string): Promise<DetalhePlano> {
    const p = await ctx.db.contingencyPlan.findUnique({ where: { id } });
    if (!p) throw notFound('Plano de contingência');
    return detalhe(p);
  }

  // ───────────── plano ─────────────

  /** POST /vigilancia/contingencia/planos: nasce RASCUNHO, do modelo do MS ou cópia de outro plano. */
  async criarPlano(ctx: RequestContext, corpo: CorpoNovoPlano): Promise<DetalhePlano> {
    let definicao: PlanoContingencia;
    let nome: string;
    let fonte: string | null;
    let origem: string | null = null;
    if ('copiarDe' in corpo) {
      const base = await ctx.db.contingencyPlan.findUnique({ where: { id: corpo.copiarDe } });
      if (!base) throw notFound('Plano de contingência');
      definicao = copia(definicaoDe(base.definition));
      nome = corpo.nome?.trim() || base.name;
      fonte = base.source;
      origem = base.id;
    } else {
      definicao = copia(PLANO_MODELO_MS_2025);
      nome = corpo.nome?.trim() || NOME_MODELO;
      fonte = FONTE_MODELO;
    }
    return ctx.db.$transaction(async (tx) => {
      const ultima = await tx.contingencyPlan.aggregate({ where: { scope: ESCOPO }, _max: { version: true } });
      const p = await tx.contingencyPlan.create({
        data: {
          scope: ESCOPO,
          name: nome,
          version: (ultima._max.version ?? 0) + 1,
          status: 'RASCUNHO',
          source: fonte,
          definition: definicao as unknown as TenantPrisma.InputJsonValue,
          createdBy: ctx.session.userId,
          updatedBy: ctx.session.userId,
        },
      });
      await this.audit.record(ctx, tx, {
        action: 'vigilancia.plano_criado',
        entityType: 'ContingencyPlan',
        entityId: p.id,
        payload: { nome, versao: p.version, modelo: 'modelo' in corpo ? corpo.modelo : null, copiaDe: origem },
      });
      return detalhe(p);
    });
  }

  /** PUT /vigilancia/contingencia/planos/:id (só RASCUNHO; a definição é validada). */
  async editarPlano(ctx: RequestContext, id: string, corpo: CorpoEditarPlano): Promise<DetalhePlano> {
    const erros = validarDefinicao(corpo.definicao);
    if (erros.length) throw new DomainError('PLANO_INVALIDO', erros[0]!, HttpStatus.UNPROCESSABLE_ENTITY, erros);
    return ctx.db.$transaction(async (tx) => {
      const atual = await tx.contingencyPlan.findUnique({ where: { id } });
      if (!atual) throw notFound('Plano de contingência');
      if (atual.status !== 'RASCUNHO') throw conflict(`Só o rascunho pode ser editado: este plano está ${atual.status === 'VIGENTE' ? 'em vigor' : 'arquivado'}. Faça uma cópia para mudar.`);
      const p = await tx.contingencyPlan.update({
        where: { id },
        data: {
          ...(corpo.nome?.trim() ? { name: corpo.nome.trim() } : {}),
          ...(corpo.fonte !== undefined ? { source: corpo.fonte?.trim() || null } : {}),
          definition: corpo.definicao as unknown as TenantPrisma.InputJsonValue,
          updatedBy: ctx.session.userId,
        },
      });
      await this.audit.record(ctx, tx, { action: 'vigilancia.plano_editado', entityType: 'ContingencyPlan', entityId: id, payload: { nome: p.name, versao: p.version, anterior: atual.definition } });
      return detalhe(p);
    });
  }

  /** POST /vigilancia/contingencia/planos/:id/vigencia: o anterior do mesmo escopo vira ARQUIVADO na véspera. */
  async porEmVigencia(ctx: RequestContext, id: string, corpo: CorpoVigenciaPlano): Promise<DetalhePlano> {
    const hoje = localDateString(this.agora(), ctx.tenant.timeZone);
    if (corpo.desde > hoje) throw new DomainError('DATA_FUTURA', 'A vigência começa hoje ou numa data passada', HttpStatus.BAD_REQUEST);
    return ctx.db.$transaction(async (tx) => {
      const p = await tx.contingencyPlan.findUnique({ where: { id } });
      if (!p) throw notFound('Plano de contingência');
      if (p.status !== 'RASCUNHO') throw conflict(p.status === 'VIGENTE' ? 'O plano já está em vigor' : 'Plano arquivado não volta a vigorar: faça uma cópia');
      const erros = validarDefinicao(definicaoDe(p.definition));
      if (erros.length) throw new DomainError('PLANO_INVALIDO', erros[0]!, HttpStatus.UNPROCESSABLE_ENTITY, erros);
      const anterior = await tx.contingencyPlan.findFirst({ where: { scope: p.scope, status: 'VIGENTE' } });
      if (anterior?.validFrom && corpo.desde < dia(anterior.validFrom)!)
        throw new DomainError('VIGENCIA_INVALIDA', `O plano em vigor vale desde ${dia(anterior.validFrom)}: o novo não pode começar antes`, HttpStatus.UNPROCESSABLE_ENTITY);
      if (anterior) await tx.contingencyPlan.update({ where: { id: anterior.id }, data: { status: 'ARQUIVADO', validTo: dataCivil(vespera(corpo.desde)), updatedBy: ctx.session.userId } });
      const novo = await tx.contingencyPlan.update({ where: { id }, data: { status: 'VIGENTE', validFrom: dataCivil(corpo.desde), validTo: null, updatedBy: ctx.session.userId } });
      await this.audit.record(ctx, tx, {
        action: 'vigilancia.plano_vigente',
        entityType: 'ContingencyPlan',
        entityId: id,
        payload: { desde: corpo.desde, versao: novo.version, arquivado: anterior ? { id: anterior.id, versao: anterior.version, ate: vespera(corpo.desde) } : null },
      });
      return detalhe(novo);
    });
  }

  // ───────────── semana e acionamento ─────────────

  /** POST /vigilancia/contingencia/respostas: resposta da vigilância a um critério manual na semana (regrava a anterior). */
  async responder(ctx: RequestContext, corpo: CorpoRespostaCriterio): Promise<RespostaManualCriterio> {
    const territorio = await this.diagramas.territorio(ctx.db, corpo.nivel ?? 'MUNICIPIO', corpo.territorio ?? null);
    const plano = await this.vigente(ctx.db);
    if (!plano) throw new DomainError('SEM_PLANO', 'Não há plano de contingência em vigor', HttpStatus.UNPROCESSABLE_ENTITY);
    const criterio = definicaoDe(plano.definition).criterios.find((c) => c.id === corpo.criterio);
    if (!criterio) throw new DomainError('CRITERIO_INVALIDO', `O critério ${corpo.criterio} não existe no plano em vigor`, HttpStatus.BAD_REQUEST);
    if (criterio.tipo !== 'MANUAL') throw new DomainError('CRITERIO_AUTOMATICO', 'Este critério é avaliado pelo sistema: não recebe resposta manual', HttpStatus.BAD_REQUEST);
    const semanaAtual = semanaEpidemiologica(this.agora(), ctx.tenant.timeZone).codigo;
    const se = Number(corpo.semana.slice(4));
    if (se < 1 || se > semanasNoAno(Number(corpo.semana.slice(0, 4)))) throw new DomainError('SEMANA_INVALIDA', `A semana ${corpo.semana} não existe`, HttpStatus.BAD_REQUEST);
    if (corpo.semana > semanaAtual) throw new DomainError('SEMANA_FUTURA', 'A semana ainda não começou', HttpStatus.BAD_REQUEST);
    const nota = corpo.nota?.trim() || null;
    const r = await ctx.db.$transaction(async (tx) => {
      const onde = { planId: plano.id, level: territorio.nivel, territoryId: territorio.id, epiWeek: corpo.semana, criterionId: corpo.criterio };
      const atual = await tx.contingencyInput.findFirst({ where: onde });
      const dados = { met: corpo.atendido, note: nota, answeredBy: ctx.session.userId, answeredAt: new Date() };
      const gravada = atual ? await tx.contingencyInput.update({ where: { id: atual.id }, data: dados }) : await tx.contingencyInput.create({ data: { ...onde, ...dados } });
      await this.audit.record(ctx, tx, {
        action: 'vigilancia.criterio_respondido',
        entityType: 'ContingencyInput',
        entityId: gravada.id,
        payload: { plano: plano.id, territorio: { nivel: territorio.nivel, id: territorio.id }, semana: corpo.semana, criterio: corpo.criterio, atendido: corpo.atendido, anterior: atual ? atual.met : null },
      });
      return gravada;
    });
    const nomes = await this.nomes(ctx.db, [r.answeredBy]);
    return { semana: r.epiWeek, criterio: r.criterionId, atendido: r.met, nota: r.note, respondidoPor: nomes.get(r.answeredBy) ?? null, respondidoEm: r.answeredAt.toISOString() };
  }

  /**
   * POST /vigilancia/contingencia/acionar: fecha o acionamento aberto do território (fim = véspera), abre o novo com o
   * retrato dos indicadores e cria o checklist com as ações do estágio e dos anteriores ("manter e intensificar").
   */
  async acionar(ctx: RequestContext, corpo: CorpoAcionar): Promise<RespostaAcionar> {
    const territorio = await this.diagramas.territorio(ctx.db, corpo.nivel, corpo.territorio ?? null);
    const plano = await this.vigente(ctx.db);
    if (!plano) throw new DomainError('SEM_PLANO', 'Não há plano de contingência em vigor', HttpStatus.UNPROCESSABLE_ENTITY);
    const definicao = definicaoDe(plano.definition);
    const estagio = definicao.estagios.find((e) => e.chave === corpo.estagio);
    if (!estagio) throw new DomainError('ESTAGIO_INVALIDO', `O estágio ${corpo.estagio} não existe no plano em vigor`, HttpStatus.BAD_REQUEST);
    const justificativa = corpo.justificativa.trim();
    if (justificativa.length < 20) throw new DomainError('JUSTIFICATIVA_CURTA', 'Escreva a justificativa com pelo menos 20 caracteres', HttpStatus.BAD_REQUEST);
    const agora = this.agora();
    const hoje = localDateString(agora, ctx.tenant.timeZone);
    const semanaAtual = semanaDaData(hoje).codigo;
    const indicadores = await this.indicadores(ctx, definicao.agravos, territorio, semanaAtual, []);
    const acoes = acoesDoEstagio(definicao, estagio.chave);
    const r = await ctx.db.$transaction(async (tx) => {
      const abertos = await tx.contingencyActivation.findMany({ where: { level: territorio.nivel, territoryId: territorio.id, endedOn: null }, orderBy: { startedOn: 'desc' } });
      if (abertos.some((a) => a.planId === plano.id && a.stage === estagio.chave)) throw conflict(`O estágio ${estagio.nome} já está em vigor`);
      const fim = vespera(hoje);
      for (const a of abertos) await tx.contingencyActivation.update({ where: { id: a.id }, data: { endedOn: dataCivil(fim), endedWeek: semanaDaData(fim).codigo } });
      const novo = await tx.contingencyActivation.create({
        data: {
          planId: plano.id,
          level: territorio.nivel,
          territoryId: territorio.id,
          stage: estagio.chave,
          startedOn: dataCivil(hoje),
          startedWeek: semanaAtual,
          justification: justificativa,
          act: corpo.ato?.trim() || null,
          indicators: indicadores as unknown as TenantPrisma.InputJsonValue,
          decidedBy: ctx.session.userId,
          decidedAt: agora,
        },
      });
      if (acoes.length)
        await tx.contingencyActionItem.createMany({ data: acoes.map((a) => ({ activationId: novo.id, stage: a.estagio, axis: a.eixo, description: a.descricao, status: 'PENDENTE', updatedBy: ctx.session.userId })) });
      await this.audit.record(ctx, tx, {
        action: 'vigilancia.contingencia_acionada',
        entityType: 'ContingencyActivation',
        entityId: novo.id,
        payload: {
          plano: plano.id,
          territorio: { nivel: territorio.nivel, id: territorio.id },
          estagio: estagio.chave,
          justificativa,
          ato: novo.act,
          encerrados: abertos.map((a) => ({ id: a.id, estagio: a.stage, fim })),
          acoes: acoes.length,
        },
      });
      return { novo, anterior: abertos[0] ? { id: abertos[0].id, fim } : null };
    });
    const nomes = await this.nomes(ctx.db, [r.novo.decidedBy]);
    return { acionamento: this.acionamentoResumo(r.novo, definicao, nomes), anteriorEncerrado: r.anterior, acoesCriadas: acoes.length };
  }

  /** PATCH /vigilancia/contingencia/acoes/:id: situação, responsável e nota (só no acionamento aberto). */
  async atualizarAcao(ctx: RequestContext, id: string, corpo: CorpoAtualizarAcao): Promise<AcaoChecklist> {
    const item = await ctx.db.$transaction(async (tx) => {
      const atual = await tx.contingencyActionItem.findUnique({ where: { id }, include: { activation: { select: { endedOn: true } } } });
      if (!atual) throw notFound('Ação do plano');
      if (atual.activation.endedOn) throw conflict('O acionamento desta ação já foi encerrado: a lista não muda mais');
      const dados = {
        ...(corpo.status !== undefined ? { status: corpo.status } : {}),
        ...(corpo.responsavel !== undefined ? { responsible: corpo.responsavel?.trim() || null } : {}),
        ...(corpo.nota !== undefined ? { note: corpo.nota?.trim() || null } : {}),
        updatedBy: ctx.session.userId,
      };
      const novo = await tx.contingencyActionItem.update({ where: { id }, data: dados });
      await this.audit.record(ctx, tx, {
        action: 'vigilancia.acao_atualizada',
        entityType: 'ContingencyActionItem',
        entityId: id,
        payload: { antes: { status: atual.status, responsavel: atual.responsible, nota: atual.note }, depois: { status: novo.status, responsavel: novo.responsible, nota: novo.note } },
      });
      return novo;
    });
    const nomes = await this.nomes(ctx.db, [item.updatedBy ?? '']);
    return this.acao(item, nomes);
  }

  // ───────────── apoio ─────────────

  /**
   * Indicadores de cada agravo no território: status de cada SE do ano em análise (o da última semana completa) no
   * canal do agravo, e casos prováveis, graves, com sinais de alarme e óbitos do ano até a última semana completa. A
   * gravidade e o óbito em investigação só vêm dos registros oficiais (a notificação do OmniSaúde não os tem).
   */
  private async indicadores(sys: SystemContext, agravos: string[], territorio: TerritorioRef, semanaAtual: string, avisos: string[]): Promise<IndicadoresAgravo[]> {
    const { incompletas, ultimaCompleta } = semanasCompletas(semanaAtual, sys.tenant.settings.vigilancia.consolidacao.semanasIncompletas);
    const ano = Number(ultimaCompleta.slice(0, 4));
    const out: IndicadoresAgravo[] = [];
    for (const grupo of agravos) {
      try {
        await this.diagramas.nomeDoAgravo(sys, grupo);
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;
        avisos.push(`O agravo ${grupo} do plano não está no catálogo: sem indicadores.`);
        continue;
      }
      const m = await this.diagramas.montar(sys, grupo, territorio, [ano], semanaAtual);
      const a = m.anos[0]!;
      const ind = this.consolidado.indicadoresDaBase(m.base, { nivel: territorio.nivel, territorioId: territorio.id }, ano, ultimaCompleta);
      out.push({
        grupo,
        semanas: this.diagramas.statusDasSemanas(a, semanaAtual, incompletas),
        ...ind,
        incidenciaAcumulada: a.populacaoDoAno ? (ind.provaveis * 100_000) / a.populacaoDoAno : null,
      });
      for (const x of a.avisos) avisos.push(`${grupo}: ${x}`);
    }
    return out;
  }

  private vigente(db: Db) {
    return db.contingencyPlan.findFirst({ where: { scope: ESCOPO, status: 'VIGENTE' } });
  }

  private async respostasDaSemana(db: Db, planId: string, territorio: TerritorioRef, semana: string): Promise<RespostaManualCriterio[]> {
    const rs = await db.contingencyInput.findMany({ where: { planId, level: territorio.nivel, territoryId: territorio.id, epiWeek: semana }, orderBy: { criterionId: 'asc' } });
    const nomes = await this.nomes(
      db,
      rs.map((r) => r.answeredBy),
    );
    return rs.map((r) => ({ semana: r.epiWeek, criterio: r.criterionId, atendido: r.met, nota: r.note, respondidoPor: nomes.get(r.answeredBy) ?? null, respondidoEm: r.answeredAt.toISOString() }));
  }

  /** Ações do acionamento na ordem do plano (estágio e posição da ação na definição). */
  private async checklist(db: Db, activationId: string, definicao: PlanoContingencia): Promise<AcaoChecklist[]> {
    const itens = await db.contingencyActionItem.findMany({ where: { activationId } });
    const ordem = new Map((definicao.estagios ?? []).map((e) => [e.chave, e.ordem]));
    const posicao = (i: (typeof itens)[number]) => {
      const p = (definicao.acoes ?? []).findIndex((a) => a.estagio === i.stage && a.eixo === i.axis && a.descricao === i.description);
      return p === -1 ? Number.MAX_SAFE_INTEGER : p;
    };
    itens.sort((a, b) => (ordem.get(a.stage) ?? 99) - (ordem.get(b.stage) ?? 99) || posicao(a) - posicao(b) || a.description.localeCompare(b.description, 'pt-BR'));
    const nomes = await this.nomes(
      db,
      itens.map((i) => i.updatedBy ?? ''),
    );
    return itens.map((i) => this.acao(i, nomes));
  }

  private acao(
    i: { id: string; stage: string; axis: string; description: string; status: string; responsible: string | null; note: string | null; updatedAt: Date; updatedBy: string | null },
    nomes: Map<string, string>,
  ): AcaoChecklist {
    return {
      id: i.id,
      estagio: i.stage,
      eixo: i.axis as EixoAcao,
      descricao: i.description,
      status: i.status as StatusAcao,
      responsavel: i.responsible,
      nota: i.note,
      atualizadoEm: i.updatedAt.toISOString(),
      atualizadoPor: i.updatedBy ? (nomes.get(i.updatedBy) ?? null) : null,
    };
  }

  private acionamentoResumo(
    a: {
      id: string;
      stage: string;
      startedOn: Date;
      startedWeek: string;
      endedOn: Date | null;
      endedWeek: string | null;
      justification: string;
      act: string | null;
      decidedBy: string;
      decidedAt: Date;
      indicators: unknown;
    },
    definicao: PlanoContingencia,
    nomes: Map<string, string>,
  ): AcionamentoResumo {
    return {
      id: a.id,
      estagio: a.stage,
      estagioNome: this.nomeDoEstagio(definicao, a.stage),
      inicio: dia(a.startedOn)!,
      semanaInicio: a.startedWeek,
      fim: dia(a.endedOn),
      semanaFim: a.endedWeek,
      justificativa: a.justification,
      ato: a.act,
      decididoPor: nomes.get(a.decidedBy) ?? null,
      decididoEm: a.decidedAt.toISOString(),
      indicadores: Array.isArray(a.indicators) ? (a.indicators as IndicadoresAgravo[]) : [],
    };
  }

  private nomeDoEstagio(definicao: PlanoContingencia | null, chave: string): string {
    return definicao?.estagios?.find((e) => e.chave === chave)?.nome ?? chave;
  }

  private async nomes(db: Db, ids: string[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids.filter(Boolean))];
    if (!unicos.length) return new Map();
    const us = await db.user.findMany({ where: { id: { in: unicos } }, select: { id: true, name: true, socialName: true } });
    return new Map(us.map((u) => [u.id, u.socialName ?? u.name]));
  }
}
