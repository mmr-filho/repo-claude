import { Injectable } from '@nestjs/common';
import { classificarPeDiabetico, classificarRiscoGestacional, localDateString, pontuarMchat, PROGRAMA_POR_CODIGO, PROGRAMAS_APS, SIGTAP_APS, type CodigoPrograma, type TipoEstratificacao } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import { recordProduction } from '../../core/production';
import { carregarDadosEquipe, carregarDadosUnidade } from '../indicators/indicators.service';
import { listarPrograma, type DadosPrograma, type Estratificacao, type LinhaPrograma } from './programs-calc';

type Escopo = { teamId?: string; unitId?: string };

/** Programas da APS: listas de acompanhamento e faltosos, estratificações de risco e ligação com a busca ativa. */
@Injectable()
export class ProgramsService {
  constructor(private readonly audit: AuditService) {}

  programas() {
    return PROGRAMAS_APS;
  }

  /** Equipes eSF/eAP ativas para escolher o escopo da lista (todas as unidades, começando pela do contexto). */
  async equipes(ctx: RequestContext) {
    const rows = await ctx.db.team.findMany({
      where: { active: true, typeCode: { in: ['70', '76'] } },
      select: { id: true, name: true, ine: true, unitId: true, unit: { select: { name: true } } },
      orderBy: [{ unit: { name: 'asc' } }, { name: 'asc' }],
    });
    const units = await ctx.db.unit.findMany({ where: { active: true, type: { in: ['UBS', 'POLICLINICA'] } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    return { unidadeAtual: ctx.session.unitId, unidades: units, equipes: rows.map((t) => ({ id: t.id, name: t.name, ine: t.ine, unitId: t.unitId, unitName: t.unit.name })) };
  }

  private async dados(ctx: RequestContext, escopo: Escopo, asOf: Date): Promise<{ dados: DadosPrograma; escopoNome: string }> {
    if (escopo.teamId) {
      const team = await ctx.db.team.findUnique({ where: { id: escopo.teamId }, include: { members: { where: { active: true, userId: { not: null } }, select: { userId: true } } } });
      if (!team) throw notFound('Equipe');
      const base = await carregarDadosEquipe(ctx.db, { id: team.id, typeCode: team.typeCode, name: team.name, unitId: team.unitId }, new Set(team.members.map((m) => m.userId as string)), asOf);
      return {
        dados: {
          ...base,
          estratificacoes: await this.estratificacoesDe(
            ctx,
            base.pessoas.map((p) => p.id),
          ),
        },
        escopoNome: team.name,
      };
    }
    const unitId = escopo.unitId ?? ctx.session.unitId;
    const unit = await ctx.db.unit.findUnique({ where: { id: unitId } });
    if (!unit) throw notFound('Unidade');
    const base = await carregarDadosUnidade(ctx.db, { id: unit.id, name: unit.name }, asOf);
    return {
      dados: {
        ...base,
        estratificacoes: await this.estratificacoesDe(
          ctx,
          base.pessoas.map((p) => p.id),
        ),
      },
      escopoNome: unit.name,
    };
  }

  private async estratificacoesDe(ctx: RequestContext, ids: string[]): Promise<Estratificacao[]> {
    const out: Estratificacao[] = [];
    for (let i = 0; i < ids.length; i += 5000) {
      const rows = await ctx.db.riskStratification.findMany({
        where: { patientId: { in: ids.slice(i, i + 5000) } },
        select: { patientId: true, kind: true, result: true, score: true, assessedAt: true, nextDueAt: true },
      });
      out.push(...rows.map((r) => ({ patientId: r.patientId, kind: r.kind as TipoEstratificacao, result: r.result, score: r.score, assessedAt: r.assessedAt, nextDueAt: r.nextDueAt })));
    }
    return out;
  }

  /** Resumo de todos os programas no escopo (população e faltosos). */
  async resumo(ctx: RequestContext, escopo: Escopo) {
    const asOf = new Date();
    const { dados, escopoNome } = await this.dados(ctx, escopo, asOf);
    return {
      escopo: escopoNome,
      ate: asOf.toISOString(),
      programas: PROGRAMAS_APS.map((p) => {
        const r = listarPrograma(p.codigo, dados, asOf);
        return { codigo: p.codigo, titulo: p.titulo, populacao: r.populacao, faltosos: r.faltosos, indicadores: p.indicadores };
      }),
    };
  }

  /** Lista de um programa: quem está em acompanhamento, o que falta e se já está em busca ativa. */
  async lista(ctx: RequestContext, codigo: CodigoPrograma, escopo: Escopo, apenasFaltosos: boolean) {
    const programa = PROGRAMA_POR_CODIGO[codigo];
    if (!programa) throw notFound('Programa');
    const asOf = new Date();
    const { dados, escopoNome } = await this.dados(ctx, escopo, asOf);
    const r = listarPrograma(codigo, dados, asOf);
    const ids = r.pessoas.map((p) => p.patientId);
    const casos = ids.length ? await ctx.db.activeSearchCase.findMany({ where: { patientId: { in: ids }, status: { not: 'ENCERRADO' } }, select: { id: true, patientId: true, lineOfCare: true, status: true } }) : [];
    const pessoas: (LinhaPrograma & { buscaAtiva: { id: string; lineOfCare: string; status: string } | null })[] = r.pessoas
      .filter((p) => !apenasFaltosos || p.faltas.length > 0)
      .map((p) => {
        const caso = casos.find((c) => c.patientId === p.patientId && (p.linhas as string[]).includes(c.lineOfCare));
        return { ...p, buscaAtiva: caso ? { id: caso.id, lineOfCare: caso.lineOfCare, status: caso.status } : null };
      });
    await this.audit.record(ctx, ctx.db, { action: 'programas.lista', entityType: 'Program', entityId: undefined, payload: { codigo, escopo: escopoNome, pessoas: pessoas.length, apenasFaltosos } });
    return { codigo, titulo: programa.titulo, escopo: escopoNome, ate: asOf.toISOString(), populacao: r.populacao, faltosos: r.faltosos, indicadores: programa.indicadores, pessoas };
  }

  /** Aplica um instrumento de estratificação e guarda o resultado; a avaliação do pé registra a produção do exame. */
  async estratificar(ctx: RequestContext, input: { patientId: string; kind: TipoEstratificacao; answers: unknown; encounterId?: string; notes?: string }) {
    const patient = await ctx.db.patient.findUnique({ where: { id: input.patientId } });
    if (!patient) throw notFound('Paciente');
    const hoje = new Date();
    let result: string;
    let score: number | null = null;
    let nextDueAt: Date | null = null;
    let detalhe: Record<string, unknown> = {};
    if (input.kind === 'GESTANTE') {
      const criterios = Array.isArray(input.answers) ? (input.answers as unknown[]).filter((c): c is string => typeof c === 'string') : [];
      const r = classificarRiscoGestacional(criterios);
      result = r.resultado;
      detalhe = { criterios, altoRisco: r.altoRisco, atencao: r.atencao, orientacao: r.orientacao };
    } else if (input.kind === 'PE_DIABETICO') {
      const itens = Array.isArray(input.answers) ? (input.answers as unknown[]).filter((c): c is string => typeof c === 'string') : [];
      const r = classificarPeDiabetico(itens);
      result = String(r.grau);
      score = r.grau;
      nextDueAt = new Date(hoje.getTime() + r.retornoMeses * 30.4375 * 86_400_000);
      detalhe = { itens, descricao: r.descricao, retornoMeses: r.retornoMeses, orientacao: r.orientacao };
    } else if (input.kind === 'MCHAT') {
      const respostas = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers) ? (input.answers as Record<string, boolean>) : {};
      let r: ReturnType<typeof pontuarMchat>;
      try {
        r = pontuarMchat(respostas);
      } catch (e) {
        throw new DomainError('MCHAT_INCOMPLETO', (e as Error).message, 400);
      }
      result = r.resultado;
      score = r.pontos;
      detalhe = { respostas, itensRisco: r.itensRisco, orientacao: r.orientacao };
    } else {
      throw new DomainError('ESTRATIFICACAO_INVALIDA', `Instrumento desconhecido: ${String(input.kind)}`, 400);
    }
    return ctx.db.$transaction(async (tx) => {
      const row = await tx.riskStratification.create({
        data: {
          patientId: patient.id,
          encounterId: input.encounterId ?? null,
          kind: input.kind,
          result,
          score,
          answers: detalhe as object,
          notes: input.notes?.trim() || null,
          nextDueAt,
          assessedBy: ctx.session.userId,
        },
      });
      if (input.kind === 'PE_DIABETICO') await recordProduction(tx, ctx, { procedureCode: SIGTAP_APS.EXAME_PE_DIABETICO, instrument: 'BPA_I', encounterId: input.encounterId, patientId: patient.id, at: hoje });
      await this.audit.record(ctx, tx, { action: 'programas.estratificar', entityType: 'Patient', entityId: patient.id, payload: { kind: input.kind, result, score } });
      return { ...row, nextDueAt: row.nextDueAt ? localDateString(row.nextDueAt, 'UTC') : null, detalhe };
    });
  }

  async estratificacoes(ctx: RequestContext, patientId: string) {
    if (!(await ctx.db.patient.findUnique({ where: { id: patientId }, select: { id: true } }))) throw notFound('Paciente');
    const rows = await ctx.db.riskStratification.findMany({ where: { patientId }, orderBy: { assessedAt: 'desc' }, take: 50 });
    const users = new Map((await ctx.db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.assessedBy))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      result: r.result,
      score: r.score,
      answers: r.answers,
      notes: r.notes,
      nextDueAt: r.nextDueAt ? localDateString(r.nextDueAt, 'UTC') : null,
      assessedAt: r.assessedAt.toISOString(),
      assessedBy: users.get(r.assessedBy) ?? null,
    }));
  }
}
