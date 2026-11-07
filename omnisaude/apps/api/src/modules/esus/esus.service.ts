import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { TenantClient, TenantPrisma } from '@omnisaude/database';
import { buildDadoTransporte, buildZip, CBO_POR_MODELO, encodeLedi, PecClient, PecError, structForTipo, TIPO_DADO_LABEL, validateFicha, type Instalacao, type LediIssue, type Lotacao } from '@omnisaude/esus';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { TenantsService } from '../../core/database';
import { conflict, DomainError, notFound } from '../../core/errors';
import { IntegrationConfigService } from '../integrations/integration-config.service';
import {
  emLotes,
  fichasAtendimento,
  fichasCadastroDomiciliar,
  fichasCadastroIndividual,
  fichasProcedimentos,
  fichasVacinacao,
  fichasVisitaDomiciliar,
  fichasVisitaVetorial,
  LOTE_IDS,
  localDate,
  type FichaGerada,
  type FonteContexto,
} from './esus-fontes';

const APP_VERSION = '0.1';
type Db = TenantClient;
type RecordStatus = 'GERADA' | 'INVALIDA' | 'ENVIADA' | 'ACEITA' | 'REJEITADA';
const json = (v: unknown) => v as TenantPrisma.InputJsonValue;
/** Cadastros são atualizações (voltam a ser enviados quando mudam) e ficam fora do registro do que já foi exportado. */
const CADASTROS = new Set(['Patient', 'Household']);
/** Fichas por inserção: cada ficha leva cerca de uma dúzia de parâmetros, abaixo do limite de 32.767 do PostgreSQL. */
const FICHAS_POR_INSERCAO = 500;

/** Fontes das fichas, cada uma isolada: a falha de uma não derruba o lote, e as fichas dela entram num próximo lote. */
export const FONTES_ESUS: { nome: string; origens: string[]; gerar: (c: FonteContexto) => Promise<FichaGerada[]> }[] = [
  { nome: 'cadastro individual', origens: ['Patient'], gerar: fichasCadastroIndividual },
  { nome: 'cadastro domiciliar e territorial', origens: ['Household'], gerar: fichasCadastroDomiciliar },
  { nome: 'atendimento individual e odontológico', origens: ['ClinicalNote'], gerar: fichasAtendimento },
  { nome: 'procedimentos (classificação de risco)', origens: ['Triage'], gerar: fichasProcedimentos },
  { nome: 'vacinação', origens: ['Vaccination'], gerar: fichasVacinacao },
  { nome: 'visita domiciliar do ACS', origens: ['HomeVisit'], gerar: fichasVisitaDomiciliar },
  { nome: 'visita do agente de endemias', origens: ['VectorVisit'], gerar: fichasVisitaVetorial },
];
type Falha = { nome: string; origens: string[] };

/** Começo do aviso do lote quando uma fonte falhou na geração; o envio o mantém para continuar visível. */
const AVISO_FONTES = 'Fichas não geradas neste lote';
const avisoFontes = (falhas: Falha[]) => (falhas.length ? `${AVISO_FONTES} (falha ao ler ${falhas.map((f) => f.nome).join(', ')}): gere outro lote do mesmo período para incluí-las` : null);
const avisoDaGeracao = (lastError: string | null) => (lastError?.startsWith(AVISO_FONTES) ? lastError : null);
const unicoViolado = (err: unknown) =>
  (err as { code?: string } | null)?.code === 'P2002' || (err as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } } | null)?.meta?.driverAdapterError?.cause?.originalCode === '23505';

/**
 * Lotes de fichas do e-SUS APS: geração a partir dos registros (cadastro individual e domiciliar, atendimento
 * individual e odontológico, procedimentos, vacinação), validação prévia, arquivo .zip para importação manual,
 * envio pela API do PEC e reprocessamento das recusadas.
 */
@Injectable()
export class EsusService {
  private readonly logger = new Logger('eSUS');

  constructor(
    private readonly tenants: TenantsService,
    private readonly audit: AuditService,
    private readonly integrations: IntegrationConfigService,
  ) {}

  private async instalacao(ctx: RequestContext): Promise<Instalacao> {
    const tenant = await this.tenants.master.tenant.findUnique({ where: { id: ctx.tenant.id } });
    return { contraChave: `OmniSaude - ${APP_VERSION}`, uuidInstalacao: ctx.tenant.id, cpfOuCnpj: tenant?.cnpj ?? '00000000000000', nomeOuRazaoSocial: tenant?.name ?? ctx.tenant.name, versaoSistema: APP_VERSION };
  }

  /** Limites do dia local (início do primeiro dia e fim do último) no fuso da instituição. */
  private periodBounds(from: string, to: string, timeZone: string): { from: Date; to: Date } {
    const offsetMinutes = (day: string) => {
      const noon = new Date(`${day}T12:00:00Z`);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(noon);
      const h = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
      const m = Number(parts.find((p) => p.type === 'minute')?.value);
      return (h - 12) * 60 + m;
    };
    const start = new Date(new Date(`${from}T00:00:00Z`).getTime() - offsetMinutes(from) * 60_000);
    const end = new Date(new Date(`${to}T23:59:59.999Z`).getTime() - offsetMinutes(to) * 60_000);
    if (end < start) throw new DomainError('PERIODO_INVALIDO', 'A data final é anterior à inicial');
    return { from: start, to: end };
  }

  /** Lotação de quem gera o lote na unidade, com CBO aceita nas fichas de cadastro; senão, outro profissional da unidade. */
  private async cadastroLotacao(ctx: RequestContext, unitId: string, cnes: string): Promise<Lotacao & { userName: string }> {
    const mine = await ctx.db.userAssignment.findFirst({ where: { userId: ctx.session.userId, unitId, active: true }, include: { user: true } });
    const accepted = (cbo: string) => CBO_POR_MODELO.CADASTRO_INDIVIDUAL.includes(cbo) && CBO_POR_MODELO.CADASTRO_DOMICILIAR.includes(cbo);
    let chosen = mine && mine.user.cns && accepted(mine.cbo) ? mine : null;
    if (!chosen) {
      const candidates = await ctx.db.userAssignment.findMany({ where: { unitId, active: true, user: { active: true, cns: { not: null } } }, include: { user: true }, orderBy: { role: 'asc' } });
      chosen = candidates.find((a) => a.role === 'ENFERMAGEM' && accepted(a.cbo)) ?? candidates.find((a) => accepted(a.cbo)) ?? mine ?? candidates[0] ?? null;
    }
    const team = chosen ? await ctx.db.teamMember.findFirst({ where: { userId: chosen.userId, active: true, team: { unitId, active: true } }, include: { team: true } }) : null;
    return { cns: chosen?.user.cns ?? '', cbo: chosen?.cbo ?? '', cnes, ine: team?.team.ine ?? null, userName: chosen?.user.name ?? '' };
  }

  private async previousUuids(db: Db, unitId: string): Promise<Map<string, string>> {
    const rows = await db.esusRecord.findMany({
      where: { sourceType: { in: ['Patient', 'Household'] }, status: { in: ['ACEITA', 'ENVIADA'] }, batch: { unitId } },
      orderBy: { createdAt: 'asc' },
      select: { sourceType: true, sourceId: true, uuid: true },
    });
    const map = new Map<string, string>();
    for (const r of rows) {
      const k = `${r.sourceType}:${r.sourceId}`;
      if (!map.has(k)) map.set(k, r.uuid);
    }
    return map;
  }

  private async contexto(ctx: RequestContext, unitId: string, period: { from: Date; to: Date }, reprocesso?: FonteContexto['reprocesso']): Promise<FonteContexto & { lotacaoNome: string }> {
    const unit = await ctx.db.unit.findUnique({ where: { id: unitId } });
    if (!unit) throw notFound('Unidade');
    const codigoIbge = unit.ibgeCode.replace(/\D/g, '');
    const lot = await this.cadastroLotacao(ctx, unit.id, unit.cnes);
    const previous = await this.previousUuids(ctx.db, unit.id);
    return {
      db: ctx.db,
      unit: { id: unit.id, cnes: unit.cnes, ibgeCode: unit.ibgeCode, type: unit.type },
      codigoIbge: codigoIbge.length === 6 ? `${codigoIbge}${ibgeCheckDigit(codigoIbge)}` : codigoIbge,
      timeZone: ctx.tenant.timeZone,
      from: period.from,
      to: period.to,
      cadastroLotacao: { cns: lot.cns, cbo: lot.cbo, cnes: lot.cnes, ine: lot.ine },
      lotacaoNome: lot.userName,
      previousUuid: (t, id) => previous.get(`${t}:${id}`),
      reprocesso,
      estatistica: { jaExportados: 0 },
    };
  }

  /** Gera as fichas de cada fonte; a que falhar fica de fora (com o erro no log) e é devolvida em `falhas`. */
  private async gerarFichas(c: FonteContexto): Promise<{ fichas: FichaGerada[]; falhas: Falha[] }> {
    const fichas: FichaGerada[] = [];
    const falhas: Falha[] = [];
    for (const fonte of FONTES_ESUS) {
      if (c.reprocesso && !fonte.origens.some((o) => c.reprocesso!.ids.has(o))) continue;
      try {
        fichas.push(...(await fonte.gerar(c)));
      } catch (err) {
        this.logger.error(`Fonte ${fonte.nome} do e-SUS falhou na unidade ${c.unit.cnes}: ${err instanceof Error ? err.message : String(err)}`);
        falhas.push({ nome: fonte.nome, origens: fonte.origens });
      }
    }
    return { fichas, falhas };
  }

  private serializar(f: FichaGerada, cnes: string, codIbge: string, numLote: number, instalacao: Instalacao): { status: RecordStatus; issues: LediIssue[]; payload: Uint8Array<ArrayBuffer> | null } {
    const issues = validateFicha(f.kind, f.ficha);
    if (issues.length) return { status: 'INVALIDA', issues, payload: null };
    try {
      const bytes = encodeLedi(structForTipo(f.kind), f.ficha);
      const payload = buildDadoTransporte({ uuid: f.uuid, tipo: f.kind as 2, cnes, codIbge, ine: f.ine, numLote, ficha: bytes, instalacao });
      return { status: 'GERADA', issues: [], payload: new Uint8Array(payload) };
    } catch (err) {
      return { status: 'INVALIDA', issues: [{ path: '$', message: err instanceof Error ? err.message : String(err) }], payload: null };
    }
  }

  async generate(ctx: RequestContext, input: { unitId: string; from: string; to: string }) {
    const period = this.periodBounds(input.from, input.to, ctx.tenant.timeZone);
    const c = await this.contexto(ctx, input.unitId, period);
    const { fichas, falhas } = await this.gerarFichas(c);
    if (!fichas.length) {
      if (falhas.length) throw new DomainError('FONTE_INDISPONIVEL', `Não foi possível ler os registros de ${falhas.map((f) => f.nome).join(', ')}: tente de novo em alguns minutos`, HttpStatus.SERVICE_UNAVAILABLE);
      if (c.estatistica.jaExportados)
        throw new DomainError(
          'SEM_FICHAS',
          `Todos os registros da unidade no período já foram exportados em lotes anteriores (${c.estatistica.jaExportados} já em fichas): um lote novo leva só o que ainda não foi para nenhuma ficha, e os cadastros quando são alterados`,
        );
      throw new DomainError('SEM_FICHAS', 'Nenhum registro da unidade no período gera ficha do e-SUS (atendimentos encerrados com registro assinado, cadastros atualizados, classificações de risco ou vacinas)');
    }
    const instalacao = await this.instalacao(ctx);
    const last = await ctx.db.esusBatch.findFirst({ where: { unitId: c.unit.id }, orderBy: { number: 'desc' }, select: { number: true } });
    const number = (last?.number ?? 0) + 1;
    // Serializa antes de abrir a transação: o trabalho de CPU não segura a conexão.
    const registros = fichas.map((f) => ({ f, s: this.serializar(f, c.unit.cnes, c.codigoIbge, number, instalacao) }));
    const aviso = avisoFontes(falhas);
    try {
      const batch = await ctx.db.$transaction(
        async (tx) => {
          const b = await tx.esusBatch.create({ data: { unitId: c.unit.id, periodStart: period.from, periodEnd: period.to, number, createdBy: ctx.session.userId, lastError: aviso } });
          const idPorUuid = new Map<string, string>();
          for (let i = 0; i < registros.length; i += FICHAS_POR_INSERCAO) {
            const criados = await tx.esusRecord.createManyAndReturn({
              data: registros.slice(i, i + FICHAS_POR_INSERCAO).map(({ f, s }) => ({
                batchId: b.id,
                kind: f.kind,
                uuid: f.uuid,
                sourceType: f.sourceType,
                sourceId: f.sourceId,
                patientId: f.patientId,
                cnes: c.unit.cnes,
                ine: f.ine,
                status: s.status,
                issues: json(s.issues),
                payload: s.payload,
                summary: json(f.summary),
              })),
              select: { id: true, uuid: true },
            });
            for (const r of criados) idPorUuid.set(r.uuid, r.id);
          }
          // Cada registro de origem fica ligado à ficha que o levou: outro lote não o repete (a chave primária garante).
          const itens = fichas.flatMap((f) => f.itens.map((sourceId) => ({ kind: f.kind, sourceType: f.sourceType, sourceId, recordId: idPorUuid.get(f.uuid)! })));
          for (let i = 0; i < itens.length; i += LOTE_IDS) await tx.esusRecordItem.createMany({ data: itens.slice(i, i + LOTE_IDS) });
          await this.audit.record(ctx, tx, {
            action: 'esus.lote.gerar',
            entityType: 'EsusBatch',
            entityId: b.id,
            payload: { unitId: c.unit.id, number, from: input.from, to: input.to, fichas: fichas.length, registros: itens.length, jaExportados: c.estatistica.jaExportados, fontesComFalha: falhas.map((f) => f.nome) },
          });
          // Ação própria na trilha, para a falha de uma fonte aparecer sem abrir o lote.
          if (falhas.length) await this.audit.record(ctx, tx, { action: 'esus.lote.fonte_com_falha', entityType: 'EsusBatch', entityId: b.id, payload: { fontes: falhas.map((f) => f.nome) } });
          return b;
        },
        { timeout: 120_000 },
      );
      return this.get(ctx, batch.id);
    } catch (err) {
      if (unicoViolado(err)) throw conflict('Outro lote com registros deste período acabou de ser gerado para a unidade: confira a lista e gere de novo se faltar algo');
      throw err;
    }
  }

  async units(ctx: RequestContext) {
    return ctx.db.unit.findMany({ where: { active: true }, orderBy: [{ type: 'asc' }, { name: 'asc' }], select: { id: true, name: true, cnes: true, type: true, ibgeCode: true } });
  }

  async list(ctx: RequestContext, unitId?: string) {
    const batches = await ctx.db.esusBatch.findMany({
      where: unitId ? { unitId } : {},
      include: { unit: { select: { name: true, cnes: true } }, creator: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const counts = await ctx.db.esusRecord.groupBy({ by: ['batchId', 'status'], _count: { _all: true }, where: { batchId: { in: batches.map((b) => b.id) } } });
    return batches.map((b) => ({
      id: b.id,
      number: b.number,
      unit: b.unit,
      createdBy: b.creator.name,
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      status: b.status,
      createdAt: b.createdAt,
      sentAt: b.sentAt,
      lastError: b.lastError,
      counts: Object.fromEntries(counts.filter((c) => c.batchId === b.id).map((c) => [c.status, c._count._all])) as Record<string, number>,
    }));
  }

  async get(ctx: RequestContext, id: string) {
    const b = await ctx.db.esusBatch.findUnique({
      where: { id },
      include: {
        unit: { select: { name: true, cnes: true } },
        creator: { select: { name: true } },
        records: { orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }], select: { id: true, kind: true, uuid: true, sourceType: true, sourceId: true, status: true, issues: true, summary: true, sentAt: true, ine: true } },
      },
    });
    if (!b) throw notFound('Lote');
    const counts: Record<string, number> = {};
    const byKind: Record<string, Record<string, number>> = {};
    for (const r of b.records) {
      counts[r.status] = (counts[r.status] ?? 0) + 1;
      byKind[r.kind] ??= {};
      byKind[r.kind]![r.status] = (byKind[r.kind]![r.status] ?? 0) + 1;
    }
    return {
      id: b.id,
      number: b.number,
      unit: b.unit,
      createdBy: b.creator.name,
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      status: b.status,
      createdAt: b.createdAt,
      sentAt: b.sentAt,
      lastError: b.lastError,
      counts,
      byKind: Object.entries(byKind).map(([kind, c]) => ({ kind: Number(kind), label: TIPO_DADO_LABEL[Number(kind)] ?? kind, counts: c })),
      records: b.records.map((r) => ({ ...r, label: TIPO_DADO_LABEL[r.kind] ?? String(r.kind) })),
    };
  }

  async zip(ctx: RequestContext, id: string): Promise<{ data: Buffer; fileName: string; fichas: number }> {
    const b = await ctx.db.esusBatch.findUnique({
      where: { id },
      include: { unit: { select: { cnes: true } }, records: { where: { status: { not: 'INVALIDA' }, payload: { not: null } }, select: { uuid: true, payload: true, createdAt: true } } },
    });
    if (!b) throw notFound('Lote');
    if (!b.records.length) throw new DomainError('SEM_FICHAS_VALIDAS', 'O lote não tem fichas válidas para exportar');
    const data = buildZip(b.records.map((r) => ({ name: `${r.uuid}.esus`, data: r.payload!, modified: r.createdAt })));
    await this.audit.recordStandalone(ctx, { action: 'esus.lote.baixar', entityType: 'EsusBatch', entityId: b.id, payload: { fichas: b.records.length } });
    return { data, fileName: `esus-${b.unit.cnes}-lote-${String(b.number).padStart(4, '0')}.zip`, fichas: b.records.length };
  }

  async status(ctx: RequestContext) {
    const pec = await this.integrations.pec(ctx.tenant.id);
    const batches = await ctx.db.esusBatch.count();
    const records = await ctx.db.esusRecord.groupBy({ by: ['status'], _count: { _all: true } });
    return {
      pec: pec ? { configured: true, url: pec.url, usuario: pec.usuario, simulado: pec.simulado } : { configured: false, url: null, usuario: null, simulado: false },
      ledi: '8.7.0',
      batches,
      records: Object.fromEntries(records.map((r) => [r.status, r._count._all])) as Record<string, number>,
    };
  }

  /** Envia ao PEC as fichas geradas (e as reprocessadas) do lote, uma a uma; recusas viram REJEITADA com a mensagem. */
  async send(ctx: RequestContext, id: string) {
    const b = await ctx.db.esusBatch.findUnique({ where: { id } });
    if (!b) throw notFound('Lote');
    const pec = await this.integrations.pec(ctx.tenant.id);
    if (!pec) throw new DomainError('PEC_NAO_CONFIGURADO', 'Informe o endereço do PEC e a credencial de integração (PEC_URL, PEC_USUARIO e PEC_SENHA)');
    const pending = await ctx.db.esusRecord.findMany({ where: { batchId: id, status: { in: ['GERADA', 'REJEITADA'] }, payload: { not: null } }, orderBy: { createdAt: 'asc' } });
    if (!pending.length) throw new DomainError('NADA_A_ENVIAR', 'O lote não tem fichas pendentes de envio');
    await ctx.db.esusBatch.update({ where: { id }, data: { status: 'ENVIANDO', lastError: avisoDaGeracao(b.lastError) } });
    const client = new PecClient({ url: pec.url, usuario: pec.usuario, senha: pec.senha });
    const result = { sent: 0, accepted: 0, rejected: 0, error: null as string | null };
    try {
      for (const r of pending) {
        const res = await client.sendFicha(r.uuid, r.payload!);
        result.sent++;
        if (res.ok) {
          result.accepted++;
          await ctx.db.esusRecord.update({ where: { id: r.id }, data: { status: 'ACEITA', sentAt: new Date(), issues: [] } });
        } else {
          result.rejected++;
          await ctx.db.esusRecord.update({ where: { id: r.id }, data: { status: 'REJEITADA', sentAt: new Date(), issues: json([{ path: 'PEC', message: res.message }]) } });
        }
      }
    } catch (err) {
      result.error = err instanceof PecError ? err.message : err instanceof Error ? err.message : String(err);
      this.logger.warn(`Envio ao PEC interrompido: ${result.error}`);
    }
    const remaining = await ctx.db.esusRecord.count({ where: { batchId: id, status: { in: ['GERADA', 'REJEITADA', 'INVALIDA'] } } });
    const status = result.error ? 'ERRO' : remaining === 0 ? 'ENVIADO' : 'PARCIAL';
    await ctx.db.$transaction(async (tx) => {
      await tx.esusBatch.update({ where: { id }, data: { status, sentAt: new Date(), lastError: result.error ?? avisoDaGeracao(b.lastError) } });
      await this.audit.record(ctx, tx, { action: 'esus.lote.enviar', entityType: 'EsusBatch', entityId: id, payload: { ...result, pec: pec.url } });
    });
    return { ...result, status, batch: await this.get(ctx, id) };
  }

  /**
   * Regera as fichas inválidas e recusadas do lote a partir dos registros atuais (mesmo uuid), cada uma exatamente com os
   * registros dela: a visita sincronizada depois não entra na ficha antiga, e registros de fichas diferentes não se
   * misturam. O registro que não gera mais ficha, ou que mudou de dia ou de profissional, sai da ficha e fica livre para
   * um próximo lote.
   */
  async reprocess(ctx: RequestContext, id: string) {
    const b = await ctx.db.esusBatch.findUnique({ where: { id } });
    if (!b) throw notFound('Lote');
    const failed = await ctx.db.esusRecord.findMany({
      where: { batchId: id, status: { in: ['INVALIDA', 'REJEITADA'] } },
      select: { id: true, uuid: true, kind: true, sourceType: true, sourceId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!failed.length) throw new DomainError('NADA_A_REPROCESSAR', 'O lote não tem fichas inválidas ou recusadas');
    // Registros de cada ficha: os itens (atendimentos, vacinas, visitas) ou, no cadastro, a própria origem.
    const itensDaFicha = new Map<string, { kind: number; sourceType: string; sourceId: string }[]>();
    const itens = await emLotes(
      failed.filter((r) => !CADASTROS.has(r.sourceType)).map((r) => r.id),
      (lote) => ctx.db.esusRecordItem.findMany({ where: { recordId: { in: lote } }, select: { recordId: true, kind: true, sourceType: true, sourceId: true } }),
    );
    for (const it of itens) {
      const lista = itensDaFicha.get(it.recordId) ?? [];
      lista.push(it);
      itensDaFicha.set(it.recordId, lista);
    }
    const ids = new Map<string, string[]>();
    const fichaDoRegistro = new Map<string, { id: string; uuid: string }>();
    const chave = (kind: number, sourceType: string, sourceId: string) => `${kind}:${sourceType}:${sourceId}`;
    for (const r of failed) {
      const origens = CADASTROS.has(r.sourceType) ? [{ kind: r.kind, sourceType: r.sourceType, sourceId: r.sourceId }] : (itensDaFicha.get(r.id) ?? []);
      for (const o of origens) {
        const lista = ids.get(o.sourceType) ?? [];
        lista.push(o.sourceId);
        ids.set(o.sourceType, lista);
        fichaDoRegistro.set(chave(o.kind, o.sourceType, o.sourceId), { id: r.id, uuid: r.uuid });
      }
    }
    const c = await this.contexto(ctx, b.unitId, { from: b.periodStart, to: b.periodEnd }, { ids, fichaDe: (kind, sourceType, sourceId) => fichaDoRegistro.get(chave(kind, sourceType, sourceId)) });
    const { fichas: fresh, falhas } = await this.gerarFichas(c);
    const instalacao = await this.instalacao(ctx);
    // Cada ficha nova junta registros de uma só ficha antiga; se os registros se dividiram, a maior parte fica com ela.
    const novas = new Map<string, FichaGerada>();
    for (const f of fresh) {
      const antiga = fichaDoRegistro.get(chave(f.kind, f.sourceType, f.itens[0] ?? f.sourceId));
      if (!antiga) continue;
      const atual = novas.get(antiga.id);
      if (!atual || f.itens.length > atual.itens.length) novas.set(antiga.id, f);
    }
    const semFonte = new Set(falhas.flatMap((f) => f.origens));
    // O que fazer com cada ficha, calculado (e serializado) antes da transação, que só grava. Sem `data`, a ficha fica
    // como estava: a fonte dela falhou agora, e ela pode ser reprocessada de novo depois.
    const plano = failed.map((r): { r: (typeof failed)[number]; saem: string[]; data: TenantPrisma.EsusRecordUncheckedUpdateInput | null; valida: boolean } => {
      if (semFonte.has(r.sourceType)) return { r, saem: [], data: null, valida: false };
      const f = novas.get(r.id);
      const evento = !CADASTROS.has(r.sourceType);
      const ficam = new Set(f?.itens ?? []);
      const deles = itensDaFicha.get(r.id) ?? [];
      const saem = evento ? deles.filter((i) => !ficam.has(i.sourceId)).map((i) => i.sourceId) : [];
      if (!f) {
        // Ficha sem registros: eles saíram num reprocessamento anterior (e ficaram livres) ou já estavam em outra ficha.
        const message =
          evento && !deles.length
            ? 'A ficha ficou sem registros: eles saíram dela num reprocessamento anterior ou já estão em outra ficha do e-SUS'
            : 'O registro de origem não gera mais ficha (excluído, não encerrado ou fora da unidade)';
        return { r, saem, data: { status: 'INVALIDA', issues: json([{ path: '$', message }]), payload: null }, valida: false };
      }
      const sr = this.serializar({ ...f, uuid: r.uuid }, c.unit.cnes, c.codigoIbge, b.number, instalacao);
      return { r, saem, data: { status: sr.status, issues: json(sr.issues), payload: sr.payload, summary: json(f.summary), ine: f.ine, sourceId: f.sourceId, patientId: f.patientId }, valida: sr.status !== 'INVALIDA' };
    });
    const unchanged = plano.filter((p) => !p.data).length;
    const released = plano.reduce((n, p) => n + p.saem.length, 0);
    const regenerated = plano.filter((p) => p.valida).length;
    const stillInvalid = plano.length - unchanged - regenerated;
    await ctx.db.$transaction(
      async (tx) => {
        for (const p of plano) {
          if (!p.data) continue;
          for (let i = 0; i < p.saem.length; i += LOTE_IDS) await tx.esusRecordItem.deleteMany({ where: { recordId: p.r.id, sourceId: { in: p.saem.slice(i, i + LOTE_IDS) } } });
          await tx.esusRecord.update({ where: { id: p.r.id }, data: p.data });
        }
        const aviso = falhas.length ? `Fichas não reprocessadas (falha ao ler ${falhas.map((f) => f.nome).join(', ')}): reprocesse de novo em alguns minutos` : avisoDaGeracao(b.lastError);
        await tx.esusBatch.update({ where: { id }, data: { status: 'GERADO', lastError: aviso } });
        await this.audit.record(ctx, tx, {
          action: 'esus.lote.reprocessar',
          entityType: 'EsusBatch',
          entityId: id,
          payload: { regenerated, stillInvalid, unchanged, released, fontesComFalha: falhas.map((f) => f.nome) },
        });
        if (falhas.length) await this.audit.record(ctx, tx, { action: 'esus.lote.fonte_com_falha', entityType: 'EsusBatch', entityId: id, payload: { fontes: falhas.map((f) => f.nome), reprocessamento: true } });
      },
      { timeout: 120_000 },
    );
    return { regenerated, stillInvalid, unchanged, released, batch: await this.get(ctx, id) };
  }
}

function ibgeCheckDigit(six: string): string {
  const weights = [1, 2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    const p = Number(six[i]) * weights[i]!;
    sum += p > 9 ? p - 9 : p;
  }
  return String((10 - (sum % 10)) % 10);
}

export { localDate };
