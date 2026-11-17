import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { tenantSettings, type MasterClient, type NegativaSettings, type TenantPrisma } from '@omnisaude/database';
import {
  analisarGrade,
  deslocarSemana,
  fromZonedParts,
  intervaloDaSemana,
  localDateString,
  prazoDaNegativa,
  regularidadeDoMunicipio,
  ROLE_LABELS,
  roleHasPermission,
  semanaDaData,
  semanaEpidemiologica,
  semanasEntre,
  SISTEMA_INFO,
  situacaoDaSemana,
  textoDoAtesto,
  type AnaliseGrade,
  type AtestoNegativa,
  type CelulaGrade,
  type ColunaGrade,
  type ConsultaGradeNegativa,
  type CorpoAbrirPeriodoNotificante,
  type CorpoAnularNegativa,
  type CorpoAtestarNegativa,
  type CorpoDesignarResponsavel,
  type CorpoEncerrarPeriodoNotificante,
  type DiferencaSinan,
  type LinhaGradeNegativa,
  type ListaUnidadesNotificantes,
  type ListaUsuariosLotados,
  type PeriodoNotificante,
  type ResponsavelNegativa,
  type RespostaGradeNegativa,
  type RespostaMinhasNegativas,
  type RespostaOk,
  type Role,
  type SemanaDoMunicipio,
  type SemanaParaAtestar,
  type SistemaOficial,
  type StatusAtesto,
  type TipoResponsavelNegativa,
  type UnidadeDoResponsavel,
  type UnidadeNotificante,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { MASTER_DB } from '../../core/database';
import { conflict, DomainError, forbidden, notFound } from '../../core/errors';
import { formatDateTime, renderDocument } from '../signatures/pdf';
import { municipioDoTenant } from './importacao/apoio';

type Db = TenantPrisma.TransactionClient;

const dataIso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const comoData = (iso: string) => new Date(`${iso}T00:00:00Z`);
const diaSeguinte = (iso: string) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + 1)).toISOString().slice(0, 10);
const inicioDoDia = (iso: string, tz: string) => fromZonedParts({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)), hour: 0, minute: 0, second: 0 }, tz);
const ddmmaaaa = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const rotuloSemana = (s: string) => `${s.slice(4)}/${s.slice(0, 4)}`;
const chave = (unitId: string, semana: string) => `${unitId}|${semana}`;
/** Tipos de unidade que não atendem e ficam fora da negativa (os mesmos da semeadura da migração 0031). */
const TIPOS_FORA_DA_NEGATIVA = ['FARMACIA_CENTRAL', 'ALMOXARIFADO', 'VIGILANCIA_SAUDE'] as const;
const intervalo = (s: string) => intervaloDaSemana(Number(s.slice(0, 4)), Number(s.slice(4)));
const listaNumeros = (refs: { numero: string }[]) => refs.map((r) => r.numero).join(', ');
/** O papel atesta a negativa (abre a tela e passa no guarda do atesto). */
const atestaNegativa = (role: string) => roleHasPermission(role as Role, 'notificacao.negativa');
/** Por que a designação do usuário desativado no cadastro não vale (ele não entra para atestar). */
const MOTIVO_ACESSO_DESATIVADO = 'Acesso desativado no cadastro';
/** Nomes numa frase: "A", "A e B", "A, B e C". */
const emFrase = (nomes: string[]) => (nomes.length <= 1 ? (nomes[0] ?? '') : `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`);

/** Semana AAAASS que existe no calendário epidemiológico. */
function exigirSemana(semana: string) {
  try {
    deslocarSemana(semana, 0);
  } catch {
    throw new DomainError('SEMANA_INVALIDA', `A semana ${semana} não existe`, HttpStatus.BAD_REQUEST);
  }
}

/** Motivo do fim do período de notificante e das designações quando a unidade é desativada no cadastro. */
export const MOTIVO_UNIDADE_DESATIVADA = 'Unidade desativada no cadastro';

/** Aviso da unidade reativada cujo período de notificante terminou na desativação (lista das unidades notificantes). */
export const AVISO_UNIDADE_REATIVADA = 'Unidade reativada: o período de notificante terminou na desativação. Abra um período novo se ela voltou a notificar.';

/**
 * Unidade ativa reativada depois da desativação no cadastro, sem período aberto nem com fim depois de hoje: o último
 * período terminou na desativação (motivo `MOTIVO_UNIDADE_DESATIVADA`) ou a desativação apagou o período planejado que
 * viria depois dele (`seguinteApagado`, a coluna next_removed_at; ex.: a reabertura depois da reforma). O período
 * aberto depois disso passa a ser o último e tira a marca. Nada se reabre sozinho: a lista e a grade avisam, e a
 * unidade conta como "sem configuração" até a vigilância abrir um período novo.
 */
function reativadaSemPeriodo(ativa: boolean, periodos: { desde: string; ate: string | null; motivoFim: string | null; seguinteApagado: boolean }[], hoje: string): boolean {
  if (!ativa || !periodos.length || periodos.some((p) => p.ate === null || p.ate > hoje)) return false;
  const ultimo = periodos.reduce((a, b) => (b.desde > a.desde ? b : a));
  return ultimo.motivoFim === MOTIVO_UNIDADE_DESATIVADA || ultimo.seguinteApagado;
}

/**
 * Encerra a unidade notificante em `ate` (AAAA-MM-DD, no fuso da instituição), na transação de quem chama, com as
 * auditorias das ações da tela. Usado na desativação da unidade no cadastro (AdminService.updateUnit).
 * - O período aberto e o encerrado com fim depois de `ate` (a vigilância pode encerrar com data futura) terminam em
 *   `ate`, com o motivo, quem e quando (`vigilancia.notificante_encerrar`; no encurtado, a trilha guarda o fim e o
 *   motivo anteriores).
 * - O período que só começaria depois de `ate` é apagado (`vigilancia.notificante_excluir`, com o que ele tinha), e o
 *   último período que restou ganha a marca next_removed_at: reativada, a unidade fica "sem configuração", com aviso,
 *   como a do período que terminou na desativação (reativadaSemPeriodo).
 * - As designações ativas de responsável terminam em `ate` (`vigilancia.negativa_revogar`); a que só começaria depois,
 *   é apagada (`vigilancia.negativa_designacao_excluir`).
 * Travas, nesta ordem: a da designação da unidade (a designação, a abertura e o encerramento do período feitos ao
 * mesmo tempo esperam e releem a unidade e os períodos), as linhas dos períodos (o encerramento feito ao mesmo tempo
 * pela vigilância espera e é relido) e, por último, a da trilha: as auditorias saem no fim, e quem chama não deve gravar
 * auditoria antes (a cadeia da trilha presa antes das outras travas fecharia um ciclo com a designação, que trava a
 * unidade e depois audita).
 * Na grade, a SE do fim continua notificante (o período alcança parte dela); as seguintes ficam "não notificante",
 * fora das silenciosas e do percentual.
 */
export async function encerrarUnidadeNotificante(
  tx: Db,
  auditar: (entrada: { action: string; entityType: string; entityId: string; payload: unknown }) => Promise<unknown>,
  p: { unitId: string; cnes: string; ate: string; motivo: string; userId: string; agora: Date },
): Promise<{ periodos: string[]; periodosExcluidos: string[]; designacoes: string[]; designacoesExcluidas: string[] }> {
  const fim = comoData(p.ate);
  const r = { periodos: [] as string[], periodosExcluidos: [] as string[], designacoes: [] as string[], designacoesExcluidas: [] as string[] };
  const trilha: { action: string; entityType: string; entityId: string; payload: unknown }[] = [];
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`negativa-responsavel:${p.unitId}`}))`;
  await tx.$queryRaw`SELECT id FROM notifying_units WHERE unit_id = ${p.unitId}::uuid FOR UPDATE`;
  const periodos = await tx.notifyingUnit.findMany({
    where: { unitId: p.unitId, OR: [{ until: null }, { until: { gt: fim } }] },
    select: { id: true, since: true, until: true, endReason: true },
    orderBy: { since: 'asc' },
  });
  for (const x of periodos) {
    const desde = dataIso(x.since)!;
    const fimAnterior = dataIso(x.until);
    if (desde > p.ate) {
      const { count } = await tx.notifyingUnit.deleteMany({ where: { id: x.id, since: x.since, until: x.until } });
      if (count !== 1) continue;
      r.periodosExcluidos.push(x.id);
      trilha.push({ action: 'vigilancia.notificante_excluir', entityType: 'NotifyingUnit', entityId: x.id, payload: { unidade: p.cnes, desde, ate: fimAnterior, motivoFim: x.endReason, motivo: p.motivo } });
      continue;
    }
    const { count } = await tx.notifyingUnit.updateMany({ where: { id: x.id, until: x.until }, data: { until: fim, endReason: p.motivo, endedBy: p.userId, endedAt: p.agora } });
    if (count !== 1) continue;
    r.periodos.push(x.id);
    trilha.push({
      action: 'vigilancia.notificante_encerrar',
      entityType: 'NotifyingUnit',
      entityId: x.id,
      payload: fimAnterior ? { unidade: p.cnes, ate: p.ate, motivo: p.motivo, fimAnterior, motivoAnterior: x.endReason } : { unidade: p.cnes, ate: p.ate, motivo: p.motivo },
    });
  }
  if (r.periodosExcluidos.length) {
    // A marca fica no último período que restou (todos terminam até `ate`); sem nenhum, a unidade reativada já conta
    // como "sem configuração" por nunca ter tido período.
    const ultimo = await tx.notifyingUnit.findFirst({ where: { unitId: p.unitId }, orderBy: { since: 'desc' }, select: { id: true } });
    if (ultimo) await tx.notifyingUnit.update({ where: { id: ultimo.id }, data: { nextRemovedAt: p.agora } });
  }
  const ativas = await tx.notifyingUnitResponsible.findMany({ where: { unitId: p.unitId, until: null }, select: { id: true, userId: true, kind: true, since: true }, orderBy: [{ designatedAt: 'asc' }, { id: 'asc' }] });
  for (const d of ativas) {
    const desde = dataIso(d.since)!;
    if (desde > p.ate) {
      const { count } = await tx.notifyingUnitResponsible.deleteMany({ where: { id: d.id, until: null } });
      if (count !== 1) continue;
      r.designacoesExcluidas.push(d.id);
      trilha.push({ action: 'vigilancia.negativa_designacao_excluir', entityType: 'NotifyingUnitResponsible', entityId: d.id, payload: { unidade: p.unitId, usuario: d.userId, tipo: d.kind, desde, motivo: p.motivo } });
      continue;
    }
    const { count } = await tx.notifyingUnitResponsible.updateMany({ where: { id: d.id, until: null }, data: { until: fim, revokedBy: p.userId, revokedAt: p.agora } });
    if (count !== 1) continue;
    r.designacoes.push(d.id);
    trilha.push({ action: 'vigilancia.negativa_revogar', entityType: 'NotifyingUnitResponsible', entityId: d.id, payload: { unidade: p.unitId, usuario: d.userId, tipo: d.kind, ate: p.ate, motivo: p.motivo } });
  }
  for (const e of trilha) await auditar(e);
  return r;
}

interface Ref {
  id: string;
  numero: string;
}

/** O que se sabe da unidade numa semana (pela SE da notificação, como o Sinan conta as semanas com informação). */
interface FatosSemana {
  /** Notificações individuais confirmadas (NOTIFICADA ou ENCERRADA) com SEM_NOT da semana. */
  notificacoes: Ref[];
  /** Rascunhos conhecidos na semana: impedem o atesto até serem confirmados ou descartados. */
  rascunhos: Ref[];
  /** Notificações de surto (não descartadas) com a data da notificação na semana. */
  surtos: Ref[];
  /** Registros oficiais individuais ou de surto com o CNES da unidade e SEM_NOT da semana. */
  registros: (Ref & { sistema: string })[];
  /** Negativas digitadas no Sinan (NNEGANET). */
  negativasSinan: Ref[];
  /** Atesto vigente (ATESTADA). */
  atesto: { id: string; late: boolean; officialRecordId: string | null } | null;
}

const vazio = (): FatosSemana => ({ notificacoes: [], rascunhos: [], surtos: [], registros: [], negativasSinan: [], atesto: null });

type LinhaAtesto = {
  id: string;
  unitId: string;
  epiWeek: string;
  status: string;
  attestedBy: string;
  attestedAt: Date;
  attesterName: string;
  attesterRole: string | null;
  attesterCbo: string | null;
  onBehalf: boolean;
  onBehalfReason: string | null;
  declaration: string;
  late: boolean;
  cancelledAt: Date | null;
  cancelReason: string | null;
  causeNotificationId: string | null;
  causeRecordId: string | null;
  causeOutbreakId: string | null;
  officialRecordId: string | null;
  unit: { name: string; cnes: string };
};

/**
 * Notificação negativa semanal (VIG-1c, §4.3; frente F4): atesto do responsável designado (RQ002: recusa se a unidade
 * tem notificação, surto ou registro oficial na semana), espelho em PDF, anulação, reconciliação (RQ003), grade
 * unidade × semana e cadastro das unidades notificantes e dos responsáveis. A semana de uma notificação é a SE da
 * notificação (SEM_NOT), como o Sinan conta as semanas com informação; o prazo do atesto é lido no fuso da instituição.
 */
@Injectable()
export class NegativaService {
  private readonly logger = new Logger('Negativa');

  /** Relógio do serviço (os testes trocam por uma data fixa). */
  agora: () => Date = () => new Date();

  constructor(
    private readonly audit: AuditService,
    @Inject(MASTER_DB) private readonly master: MasterClient,
  ) {}

  // ───────────────────────────── fatos da unidade na semana ─────────────────────────────

  /**
   * Notificações, rascunhos (só com `timeZone`), surtos, registros oficiais e atestos das unidades nas semanas, numa
   * consulta por tabela. Registro oficial excluído ou ausente da última exportação não conta.
   */
  private async fatos(db: Db, unidades: { id: string; cnes: string }[], semanas: string[], timeZone?: string): Promise<Map<string, FatosSemana>> {
    const mapa = new Map<string, FatosSemana>();
    const ordenadas = [...new Set(semanas)].sort();
    if (!unidades.length || !ordenadas.length) return mapa;
    const de = (u: string, s: string) => {
      const k = chave(u, s);
      let f = mapa.get(k);
      if (!f) mapa.set(k, (f = vazio()));
      return f;
    };
    const ids = unidades.map((u) => u.id);
    const porCnes = new Map(unidades.map((u) => [u.cnes, u.id]));
    const conjunto = new Set(ordenadas);
    const inicio = intervalo(ordenadas[0]!).inicio;
    const fim = intervalo(ordenadas[ordenadas.length - 1]!).fim;
    const [notificacoes, surtos, registros, atestos, rascunhos] = await Promise.all([
      db.notification.findMany({
        where: { unitId: { in: ids }, status: { in: ['NOTIFICADA', 'ENCERRADA'] }, epiWeekNotified: { in: ordenadas } },
        select: { id: true, number: true, unitId: true, epiWeekNotified: true },
        orderBy: { notifiedAt: 'asc' },
      }),
      db.outbreak.findMany({
        where: { unitId: { in: ids }, status: { not: 'DESCARTADO' }, notifiedOn: { gte: comoData(inicio), lte: comoData(fim) } },
        select: { id: true, number: true, unitId: true, notifiedOn: true },
        orderBy: { notifiedOn: 'asc' },
      }),
      db.officialRecord.findMany({
        where: {
          type: { in: ['INDIVIDUAL', 'SURTO', 'NEGATIVA'] },
          excluded: false,
          absentSince: null,
          epiWeekNotified: { in: ordenadas },
          OR: [{ unitId: { in: ids } }, { unitCnes: { in: [...porCnes.keys()] } }],
        },
        select: { id: true, number: true, type: true, system: true, unitId: true, unitCnes: true, epiWeekNotified: true },
        orderBy: { notifiedOn: 'asc' },
      }),
      db.negativeReport.findMany({ where: { unitId: { in: ids }, epiWeek: { in: ordenadas }, status: 'ATESTADA' }, select: { id: true, unitId: true, epiWeek: true, late: true, officialRecordId: true } }),
      timeZone
        ? db.notification.findMany({
            where: { unitId: { in: ids }, status: 'RASCUNHO', knownAt: { gte: inicioDoDia(inicio, timeZone), lt: inicioDoDia(diaSeguinte(fim), timeZone) } },
            select: { id: true, number: true, unitId: true, knownAt: true },
          })
        : Promise.resolve([] as { id: string; number: string; unitId: string; knownAt: Date }[]),
    ]);
    for (const n of notificacoes) de(n.unitId, n.epiWeekNotified!).notificacoes.push({ id: n.id, numero: n.number });
    for (const o of surtos) {
      const s = semanaDaData(dataIso(o.notifiedOn)!).codigo;
      if (conjunto.has(s)) de(o.unitId, s).surtos.push({ id: o.id, numero: o.number });
    }
    for (const r of registros) {
      const unitId = (r.unitId && ids.includes(r.unitId) ? r.unitId : null) ?? (r.unitCnes ? porCnes.get(r.unitCnes) : undefined);
      if (!unitId) continue;
      const f = de(unitId, r.epiWeekNotified!);
      if (r.type === 'NEGATIVA') f.negativasSinan.push({ id: r.id, numero: r.number });
      else f.registros.push({ id: r.id, numero: r.number, sistema: r.system });
    }
    for (const a of atestos) de(a.unitId, a.epiWeek).atesto = { id: a.id, late: a.late, officialRecordId: a.officialRecordId };
    if (timeZone)
      for (const r of rascunhos) {
        const s = semanaEpidemiologica(r.knownAt, timeZone).codigo;
        if (conjunto.has(s)) de(r.unitId, s).rascunhos.push({ id: r.id, numero: r.number });
      }
    return mapa;
  }

  /** A unidade era notificante em alguma parte da semana. */
  private notificante(periodos: { since: Date; until: Date | null }[], semana: string) {
    const { inicio, fim } = intervalo(semana);
    return periodos.some((p) => dataIso(p.since)! <= fim && (!p.until || dataIso(p.until)! >= inicio));
  }

  /** Por que a negativa não cabe na semana (RQ002 do Sinan), ou nulo. */
  private impedimento(f: FatosSemana): { codigo: string; mensagem: string } | null {
    if (f.notificacoes.length) return { codigo: 'SEMANA_COM_NOTIFICACAO', mensagem: `A unidade tem notificação na semana (${listaNumeros(f.notificacoes)}): a negativa não cabe` };
    if (f.surtos.length) return { codigo: 'SEMANA_COM_SURTO', mensagem: `A unidade tem notificação de surto na semana (${listaNumeros(f.surtos)}): a negativa não cabe` };
    if (f.registros.length) {
      const r = f.registros[0]!;
      const sistema = SISTEMA_INFO[r.sistema as SistemaOficial]?.label ?? r.sistema;
      return { codigo: 'SEMANA_COM_REGISTRO_OFICIAL', mensagem: `O ${sistema} tem notificação da unidade nesta semana (nº ${listaNumeros(f.registros)}): a negativa não cabe` };
    }
    if (f.rascunhos.length) return { codigo: 'SEMANA_COM_RASCUNHO', mensagem: `A unidade tem rascunho de notificação na semana (${listaNumeros(f.rascunhos)}): confirme ou descarte o rascunho antes` };
    return null;
  }

  /**
   * A configuração da negativa gravada no banco mestre, lida na hora: o catálogo da instituição fica em cache por até
   * 60 s em cada instância da API, e o que vira dado durável (o prazo e o "atrasado" do atesto) não pode sair de uma
   * configuração velha.
   */
  private async configuracaoNoMestre(ctx: RequestContext): Promise<NegativaSettings> {
    const t = await this.master.tenant.findUnique({ where: { id: ctx.tenant.id }, select: { settings: true } });
    return t ? tenantSettings(t.settings).vigilancia.negativa : ctx.tenant.settings.vigilancia.negativa;
  }

  private funcaoDe(l: { role: string; cbo: string } | null) {
    return l ? `${ROLE_LABELS[l.role as Role] ?? l.role}, CBO ${l.cbo}` : '';
  }

  /**
   * A lotação ativa na unidade que vale para o atesto: só papel com `notificacao.negativa` (a designação de quem perdeu
   * esse papel na unidade não vale); a do papel da sessão primeiro.
   */
  private lotacaoQueAtesta<T extends { role: string }>(lotacoes: T[], papelDaSessao: string): T | null {
    const validas = lotacoes.filter((l) => atestaNegativa(l.role));
    return validas.find((l) => l.role === papelDaSessao) ?? validas[0] ?? null;
  }

  /** Por que a designação não vale (sem lotação ativa, ou lotação só com papel que não atesta). */
  private semLotacaoQueAtesta(temLotacao: boolean) {
    return temLotacao ? 'Seu papel nesta unidade não atesta a negativa: a designação só vale com lotação em papel que atesta' : 'Sem lotação ativa na unidade: a designação não vale até a lotação ser reativada';
  }

  private atestoDto(r: LinhaAtesto): AtestoNegativa {
    return {
      id: r.id,
      unitId: r.unitId,
      unidade: r.unit.name,
      cnes: r.unit.cnes,
      semana: r.epiWeek,
      status: r.status as StatusAtesto,
      atestadoEm: r.attestedAt.toISOString(),
      atestadoPor: r.attesterName,
      funcao: r.attesterRole ? `${r.attesterRole}${r.attesterCbo ? ` · CBO ${r.attesterCbo}` : ''}` : null,
      emNome: r.onBehalf,
      motivoEmNome: r.onBehalfReason,
      atrasado: r.late,
      declaracao: r.declaration,
      canceladoEm: r.cancelledAt?.toISOString() ?? null,
      motivoCancelamento: r.cancelReason,
      causa: r.causeNotificationId
        ? { tipo: 'NOTIFICACAO', id: r.causeNotificationId }
        : r.causeOutbreakId
          ? { tipo: 'SURTO', id: r.causeOutbreakId }
          : r.causeRecordId
            ? { tipo: 'REGISTRO_OFICIAL', id: r.causeRecordId }
            : null,
      registroOficialId: r.officialRecordId,
    };
  }

  // ───────────────────────────── atesto ─────────────────────────────

  /** GET /vigilancia/negativas/minhas: as unidades em que o usuário é responsável ativo e as semanas a atestar. */
  async minhas(ctx: RequestContext): Promise<RespostaMinhasNegativas> {
    const agora = this.agora();
    const tz = ctx.tenant.timeZone;
    const cfg = ctx.tenant.settings.vigilancia.negativa;
    const hoje = localDateString(agora, tz);
    const semanaAtual = semanaEpidemiologica(agora, tz).codigo;
    const designacoes = await ctx.db.notifyingUnitResponsible.findMany({
      where: { userId: ctx.session.userId, until: null, since: { lte: comoData(hoje) } },
      include: { unit: { select: { id: true, name: true, cnes: true } } },
      orderBy: [{ designatedAt: 'asc' }],
    });
    const unidades = designacoes.map((d) => d.unit);
    const unitIds = unidades.map((u) => u.id);
    const semanas = Array.from({ length: Math.max(1, cfg.semanasAtesto) }, (_, i) => deslocarSemana(semanaAtual, -(i + 1)));
    const [usuario, lotacoes, periodos, fatos, atestos, historico] = await Promise.all([
      ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId }, select: { name: true, socialName: true } }),
      ctx.db.userAssignment.findMany({ where: { userId: ctx.session.userId, active: true, unitId: { in: unitIds } }, select: { unitId: true, role: true, cbo: true } }),
      ctx.db.notifyingUnit.findMany({ where: { unitId: { in: unitIds } }, select: { unitId: true, since: true, until: true } }),
      this.fatos(ctx.db, unidades, semanas, tz),
      ctx.db.negativeReport.findMany({ where: { unitId: { in: unitIds }, epiWeek: { in: semanas } }, include: { unit: { select: { name: true, cnes: true } } }, orderBy: { attestedAt: 'desc' } }),
      ctx.db.negativeReport.findMany({
        where: { OR: [{ unitId: { in: unitIds } }, { attestedBy: ctx.session.userId }] },
        include: { unit: { select: { name: true, cnes: true } } },
        orderBy: [{ epiWeek: 'desc' }, { attestedAt: 'desc' }],
        take: 100,
      }),
    ]);
    const nome = usuario.socialName ?? usuario.name;
    const lista: UnidadeDoResponsavel[] = designacoes.map((d) => {
      const daUnidade = lotacoes.filter((l) => l.unitId === d.unitId);
      const lotacao = this.lotacaoQueAtesta(daUnidade, ctx.session.role);
      const doPeriodo = periodos.filter((p) => p.unitId === d.unitId);
      const linhas: SemanaParaAtestar[] = semanas.map((s) => {
        const { inicio, fim } = intervalo(s);
        const f = fatos.get(chave(d.unitId, s)) ?? vazio();
        const prazo = prazoDaNegativa(s, cfg, tz);
        const prazoPassou = agora.getTime() > prazo.getTime();
        const notificante = this.notificante(doPeriodo, s);
        const positivas = f.notificacoes.length + f.surtos.length + f.registros.length;
        const situacao = situacaoDaSemana({ notificante, positivas, negativa: f.atesto ? { atrasada: f.atesto.late } : f.negativasSinan.length ? { atrasada: false } : null, emCurso: false, prazoPassou });
        const impedimento = this.impedimento(f);
        const motivo = !lotacao ? this.semLotacaoQueAtesta(daUnidade.length > 0) : !notificante ? 'A unidade não era notificante nesta semana' : f.atesto ? 'Semana já atestada' : (impedimento?.mensagem ?? null);
        const doAtesto = atestos.filter((a) => a.unitId === d.unitId && a.epiWeek === s);
        const atesto = doAtesto.find((a) => a.status === 'ATESTADA') ?? doAtesto[0] ?? null;
        return {
          semana: s,
          inicio,
          fim,
          situacao,
          prazo: prazo.toISOString(),
          prazoPassou,
          podeAtestar: motivo === null,
          motivo,
          atesto: atesto ? this.atestoDto(atesto) : null,
          texto: textoDoAtesto({ unidade: d.unit.name, cnes: d.unit.cnes, semana: s, inicio, fim, nome, funcao: this.funcaoDe(lotacao) }),
        };
      });
      return { unidade: { id: d.unit.id, nome: d.unit.name, cnes: d.unit.cnes }, tipo: d.kind as TipoResponsavelNegativa, semanas: linhas };
    });
    return { unidades: lista, historico: historico.map((h) => this.atestoDto(h)) };
  }

  /**
   * POST /vigilancia/negativas: só semana terminada e dentro de `semanasAtesto`; exige designação ativa (titular ou
   * substituto, com lotação ativa na unidade em papel que atesta) ou, em nome da unidade, `vigilancia.consolidacao` com motivo. RQ002:
   * recusa a semana com notificação, rascunho, surto ou registro oficial da unidade. Atesto ATESTADA já existente: 409.
   * A configuração (prazo e semanas do atesto) vem do banco mestre na hora, e o prazo usado fica gravado com o atesto.
   */
  async atestar(ctx: RequestContext, corpo: CorpoAtestarNegativa): Promise<AtestoNegativa> {
    exigirSemana(corpo.semana);
    const agora = this.agora();
    const tz = ctx.tenant.timeZone;
    const cfg = await this.configuracaoNoMestre(ctx);
    const hoje = localDateString(agora, tz);
    const unidade = await ctx.db.unit.findUnique({ where: { id: corpo.unitId }, select: { id: true, name: true, cnes: true } });
    if (!unidade) throw notFound('Unidade');
    const emNome = corpo.emNome?.motivo?.trim() || null;
    let lotacao: { role: string; cbo: string } | null;
    if (emNome) {
      if (!roleHasPermission(ctx.session.role, 'vigilancia.consolidacao')) throw forbidden('O atesto em nome da unidade é da vigilância epidemiológica municipal');
      lotacao = { role: ctx.session.role, cbo: ctx.cbo };
    } else {
      const [designacao, lotacoes] = await Promise.all([
        ctx.db.notifyingUnitResponsible.findFirst({ where: { unitId: unidade.id, userId: ctx.session.userId, until: null, since: { lte: comoData(hoje) } }, select: { id: true } }),
        ctx.db.userAssignment.findMany({ where: { userId: ctx.session.userId, unitId: unidade.id, active: true }, select: { role: true, cbo: true } }),
      ]);
      if (!designacao) throw forbidden('Você não é responsável designado pela notificação negativa desta unidade');
      lotacao = this.lotacaoQueAtesta(lotacoes, ctx.session.role);
      if (!lotacao) throw forbidden(this.semLotacaoQueAtesta(lotacoes.length > 0));
    }
    const semanaAtual = semanaEpidemiologica(agora, tz).codigo;
    if (corpo.semana >= semanaAtual) throw new DomainError('SEMANA_EM_CURSO', 'Só se atesta semana epidemiológica já terminada', HttpStatus.UNPROCESSABLE_ENTITY);
    const limite = deslocarSemana(semanaAtual, -Math.max(1, cfg.semanasAtesto));
    if (corpo.semana < limite) throw new DomainError('FORA_DO_PERIODO', `O atesto vale para as últimas ${cfg.semanasAtesto} semanas fechadas (desde a ${rotuloSemana(limite)})`, HttpStatus.UNPROCESSABLE_ENTITY);
    const periodos = await ctx.db.notifyingUnit.findMany({ where: { unitId: unidade.id }, select: { since: true, until: true } });
    if (!this.notificante(periodos, corpo.semana)) throw new DomainError('NAO_NOTIFICANTE', 'A unidade não era notificante nesta semana', HttpStatus.UNPROCESSABLE_ENTITY);
    const f = (await this.fatos(ctx.db, [unidade], [corpo.semana], tz)).get(chave(unidade.id, corpo.semana)) ?? vazio();
    if (f.atesto) throw conflict('Esta semana da unidade já tem atesto', { atestoId: f.atesto.id });
    const impedimento = this.impedimento(f);
    if (impedimento) throw new DomainError(impedimento.codigo, impedimento.mensagem, HttpStatus.UNPROCESSABLE_ENTITY);
    const usuario = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId }, select: { name: true, socialName: true } });
    const nome = usuario.socialName ?? usuario.name;
    const { inicio, fim } = intervalo(corpo.semana);
    const prazo = prazoDaNegativa(corpo.semana, cfg, tz);
    const atrasado = agora.getTime() > prazo.getTime();
    let declaracao = textoDoAtesto({ unidade: unidade.name, cnes: unidade.cnes, semana: corpo.semana, inicio, fim, nome, funcao: this.funcaoDe(lotacao) });
    if (emNome) declaracao += ` Registro feito pela vigilância epidemiológica municipal em nome da unidade. Motivo: ${emNome}`;
    let criado: { id: string };
    try {
      criado = await ctx.db.$transaction(async (tx) => {
        const r = await tx.negativeReport.create({
          data: {
            unitId: unidade.id,
            epiWeek: corpo.semana,
            status: 'ATESTADA',
            attestedBy: ctx.session.userId,
            attestedAt: agora,
            attesterName: nome,
            attesterRole: ROLE_LABELS[lotacao!.role as Role] ?? lotacao!.role,
            attesterCbo: /^\d{6}$/.test(lotacao!.cbo) ? lotacao!.cbo : null,
            onBehalf: !!emNome,
            onBehalfReason: emNome,
            declaration: declaracao,
            late: atrasado,
            deadlineAt: prazo,
            officialRecordId: f.negativasSinan[0]?.id ?? null,
          },
          select: { id: true },
        });
        await this.audit.record(ctx, tx, {
          action: 'vigilancia.negativa_atestar',
          entityType: 'NegativeReport',
          entityId: r.id,
          payload: { unidade: unidade.cnes, semana: corpo.semana, atrasado, emNome: !!emNome, motivo: emNome },
        });
        return r;
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw conflict('Esta semana da unidade já tem atesto');
      throw err;
    }
    return this.atestoDto(await ctx.db.negativeReport.findUniqueOrThrow({ where: { id: criado.id }, include: { unit: { select: { name: true, cnes: true } } } }));
  }

  /**
   * GET /vigilancia/negativas/:id/espelho.pdf (quem atestou, os responsáveis ativos da unidade ou a vigilância). O prazo
   * impresso é o gravado com o atesto (o que decidiu o "fora do prazo"), não o recalculado com a configuração de agora.
   */
  async espelhoPdf(ctx: RequestContext, id: string): Promise<{ data: Buffer; fileName: string }> {
    const r = await ctx.db.negativeReport.findUnique({ where: { id }, include: { unit: { select: { name: true, cnes: true, address: true } } } });
    if (!r) throw notFound('Atesto');
    if (r.attestedBy !== ctx.session.userId && !roleHasPermission(ctx.session.role, 'vigilancia.consolidacao')) {
      const responsavel = await ctx.db.notifyingUnitResponsible.findFirst({ where: { unitId: r.unitId, userId: ctx.session.userId, until: null }, select: { id: true } });
      if (!responsavel) throw forbidden('O espelho é de quem atestou, dos responsáveis da unidade e da vigilância');
    }
    const tz = ctx.tenant.timeZone;
    const agora = this.agora();
    const { inicio, fim } = intervalo(r.epiWeek);
    const prazo = r.deadlineAt;
    const emissor = await ctx.db.user.findUniqueOrThrow({ where: { id: ctx.session.userId }, select: { name: true, socialName: true, cpf: true } });
    const situacao: string[] = [];
    if (r.status === 'CANCELADA') situacao.push(`Atesto cancelado em ${formatDateTime(r.cancelledAt!, tz)}: ${r.cancelReason ?? 'a unidade passou a ter notificação na semana'}.`);
    if (r.status === 'ANULADA') situacao.push(`Atesto anulado pela vigilância em ${formatDateTime(r.cancelledAt!, tz)}. Motivo: ${r.cancelReason ?? ''}`);
    const data = await renderDocument({
      title: 'Notificação negativa semanal',
      unit: { name: r.unit.name, cnes: r.unit.cnes, address: r.unit.address },
      patient: null,
      professional: { name: r.attesterName, council: null, cbo: r.attesterCbo ?? '', roleLabel: r.attesterRole ?? 'Responsável pela notificação' },
      issuedAt: agora,
      timeZone: tz,
      sections: [
        {
          heading: 'Semana epidemiológica',
          paragraphs: [`SE ${rotuloSemana(r.epiWeek)}: de ${ddmmaaaa(inicio)} a ${ddmmaaaa(fim)}.`, `Unidade notificante: ${r.unit.name} (CNES ${r.unit.cnes}).`],
        },
        { heading: 'Declaração', paragraphs: [r.declaration] },
        {
          heading: 'Registro',
          paragraphs: [
            `Atestado em ${formatDateTime(r.attestedAt, tz)} por ${r.attesterName}${r.attesterRole ? `, ${r.attesterRole}` : ''}${r.attesterCbo ? ` (CBO ${r.attesterCbo})` : ''}.`,
            r.late ? `FORA DO PRAZO: o prazo era ${formatDateTime(prazo, tz)}.` : `No prazo (até ${formatDateTime(prazo, tz)}).`,
            ...(r.onBehalf ? [`Registrado pela vigilância em nome da unidade. Motivo: ${r.onBehalfReason ?? ''}`] : []),
            ...situacao,
          ],
        },
      ],
      footer: [`Atesto ${r.id} · espelho emitido em ${formatDateTime(agora, tz)} por ${emissor.socialName ?? emissor.name} · a negativa digitada no Sinan Net recebe o número lá (PRC nº 4/2017, Anexo V, art. 2º, IX)`],
      signer: { name: emissor.socialName ?? emissor.name, cpf: emissor.cpf },
    });
    await this.audit.recordStandalone(ctx, { action: 'vigilancia.negativa_espelho', entityType: 'NegativeReport', entityId: r.id, payload: { unidade: r.unit.cnes, semana: r.epiWeek } });
    return { data, fileName: `negativa-${r.unit.cnes}-${r.epiWeek}.pdf` };
  }

  /** POST /vigilancia/negativas/:id/anular (`vigilancia.consolidacao`): só o atesto vigente, com motivo. */
  async anular(ctx: RequestContext, id: string, corpo: CorpoAnularNegativa): Promise<AtestoNegativa> {
    const r = await ctx.db.negativeReport.findUnique({ where: { id }, select: { id: true, status: true, epiWeek: true, unit: { select: { cnes: true } } } });
    if (!r) throw notFound('Atesto');
    if (r.status !== 'ATESTADA') throw new DomainError('NAO_ATESTADA', 'Só o atesto vigente pode ser anulado', HttpStatus.UNPROCESSABLE_ENTITY);
    const motivo = corpo.motivo.trim();
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.negativeReport.updateMany({
        where: { id, status: 'ATESTADA' },
        data: { status: 'ANULADA', cancelledAt: this.agora(), cancelledBy: ctx.session.userId, cancelReason: motivo },
      });
      if (count !== 1) throw conflict('O atesto mudou desde a leitura; abra de novo');
      await this.audit.record(ctx, tx, { action: 'vigilancia.negativa_anular', entityType: 'NegativeReport', entityId: id, payload: { unidade: r.unit.cnes, semana: r.epiWeek, motivo } });
    });
    return this.atestoDto(await ctx.db.negativeReport.findUniqueOrThrow({ where: { id }, include: { unit: { select: { name: true, cnes: true } } } }));
  }

  /**
   * RQ003: cancela o ATESTADA da unidade e semana que passou a ter notificação NOTIFICADA/ENCERRADA, surto ou registro
   * oficial individual ou de surto, gravando a causa; casa os atestos com as negativas importadas (NNEGANET, pelo CNES
   * e SEM_NOT) e desfaz (ou troca) o casamento com a negativa que saiu do Sinan (ausente da última exportação ou
   * excluída). Sem filtro, olha todos os atestos vigentes. Devolve quantos atestos foram cancelados. Chamado pela
   * importação, pelo surto, pela confirmação da notificação e pelo job 'vigilancia'.
   */
  async reconciliar(db: Db, filtro?: { unitIds?: string[]; semanas?: string[] }): Promise<number> {
    if (filtro?.unitIds?.length === 0 || filtro?.semanas?.length === 0) return 0;
    const atestos = await db.negativeReport.findMany({
      where: { status: 'ATESTADA', ...(filtro?.unitIds ? { unitId: { in: [...new Set(filtro.unitIds)] } } : {}), ...(filtro?.semanas ? { epiWeek: { in: [...new Set(filtro.semanas)] } } : {}) },
      select: { id: true, unitId: true, epiWeek: true, officialRecordId: true, unit: { select: { cnes: true } } },
    });
    if (!atestos.length) return 0;
    const unidades = [...new Map(atestos.map((a) => [a.unitId, { id: a.unitId, cnes: a.unit.cnes }])).values()];
    const fatos = await this.fatos(
      db,
      unidades,
      atestos.map((a) => a.epiWeek),
    );
    let canceladas = 0;
    for (const a of atestos) {
      const f = fatos.get(chave(a.unitId, a.epiWeek)) ?? vazio();
      const n = f.notificacoes[0];
      const o = f.surtos[0];
      const r = f.registros[0];
      if (n || o || r) {
        const motivo = n
          ? `A unidade passou a ter a notificação ${n.numero} na semana (RQ003)`
          : o
            ? `A unidade passou a ter a notificação de surto ${o.numero} na semana (RQ003)`
            : `O ${SISTEMA_INFO[r!.sistema as SistemaOficial]?.label ?? r!.sistema} tem notificação da unidade na semana (nº ${r!.numero}; RQ003)`;
        const { count } = await db.negativeReport.updateMany({
          where: { id: a.id, status: 'ATESTADA' },
          data: { status: 'CANCELADA', cancelledAt: this.agora(), cancelReason: motivo, causeNotificationId: n?.id ?? null, causeOutbreakId: n ? null : (o?.id ?? null), causeRecordId: n || o ? null : r!.id },
        });
        canceladas += count;
        continue;
      }
      // A negativa vigente do Sinan (fatos() já deixa de fora a ausente e a excluída): mantém a casada se ainda vale;
      // senão casa com outra da mesma unidade e semana, ou desfaz.
      if (a.officialRecordId && f.negativasSinan.some((x) => x.id === a.officialRecordId)) continue;
      const novo = f.negativasSinan[0]?.id ?? null;
      if (novo !== a.officialRecordId) await db.negativeReport.updateMany({ where: { id: a.id, officialRecordId: a.officialRecordId }, data: { officialRecordId: novo } });
    }
    if (canceladas) this.logger.log(`Notificação negativa: ${canceladas} atesto(s) cancelado(s) pela RQ003`);
    return canceladas;
  }

  // ───────────────────────────── grade ─────────────────────────────

  /**
   * Semanas com alguma informação no município inteiro, para a regularidade (PRC nº 6/2017, art. 454-B): notificação
   * confirmada ou encerrada e surto não descartado de qualquer unidade (a da vigilância também), registro oficial
   * individual, de surto ou negativa do município (pelo IBGE da notificação, ou pelo CNES de uma unidade do cadastro)
   * com qualquer CNES, e atesto vigente. Uma consulta agrupada por tabela.
   */
  private async semanasComInformacao(db: Db, semanas: string[], ibge: string): Promise<Set<string>> {
    const ordenadas = [...new Set(semanas)].sort();
    const com = new Set<string>();
    if (!ordenadas.length) return com;
    const inicio = intervalo(ordenadas[0]!).inicio;
    const fim = intervalo(ordenadas[ordenadas.length - 1]!).fim;
    const cnes = (await db.unit.findMany({ select: { cnes: true } })).map((u) => u.cnes);
    // Sem o IBGE de 6 dígitos, só o CNES do cadastro diz que o registro é do município ("" casaria com qualquer um).
    const ibge6 = /^\d{6}/.test(ibge) ? ibge.slice(0, 6) : null;
    const [notificacoes, surtos, registros, atestos] = await Promise.all([
      db.notification.groupBy({ by: ['epiWeekNotified'], where: { status: { in: ['NOTIFICADA', 'ENCERRADA'] }, epiWeekNotified: { in: ordenadas } } }),
      db.outbreak.groupBy({ by: ['notifiedOn'], where: { status: { not: 'DESCARTADO' }, notifiedOn: { gte: comoData(inicio), lte: comoData(fim) } } }),
      db.officialRecord.groupBy({
        by: ['epiWeekNotified'],
        where: {
          type: { in: ['INDIVIDUAL', 'SURTO', 'NEGATIVA'] },
          excluded: false,
          absentSince: null,
          epiWeekNotified: { in: ordenadas },
          OR: [...(ibge6 ? [{ municipalityIbge: { startsWith: ibge6 } }] : []), { unitId: { not: null } }, { unitCnes: { in: cnes } }],
        },
      }),
      db.negativeReport.groupBy({ by: ['epiWeek'], where: { status: 'ATESTADA', epiWeek: { in: ordenadas } } }),
    ]);
    for (const n of notificacoes) if (n.epiWeekNotified) com.add(n.epiWeekNotified);
    for (const o of surtos) com.add(semanaDaData(dataIso(o.notifiedOn)!).codigo);
    for (const r of registros) if (r.epiWeekNotified) com.add(r.epiWeekNotified);
    for (const a of atestos) com.add(a.epiWeek);
    return com;
  }

  /**
   * GET /vigilancia/negativas/grade?semanas=12&ate=AAAASS: unidades notificantes × semanas com a situação e as fontes de
   * cada célula, a análise (silenciosas, só negativas, % por semana, regularidade municipal) e as diferenças com as
   * negativas digitadas no Sinan. A análise roda numa janela maior que a exibida (o maior entre as semanas pedidas e os
   * parâmetros da análise, mais as semanas ainda abertas no fim); a resposta traz só as semanas pedidas. A
   * regularidade usa os fatos do município inteiro, não só as linhas da grade.
   */
  async grade(ctx: RequestContext, consulta: ConsultaGradeNegativa): Promise<RespostaGradeNegativa> {
    const agora = this.agora();
    const tz = ctx.tenant.timeZone;
    const cfg = ctx.tenant.settings.vigilancia.negativa;
    const semanaAtual = semanaEpidemiologica(agora, tz).codigo;
    const hoje = localDateString(agora, tz);
    const avisos: string[] = [];
    let ate = consulta.ate ?? semanaAtual;
    exigirSemana(ate);
    if (ate > semanaAtual) {
      avisos.push(`A grade vai só até a semana em curso (${rotuloSemana(semanaAtual)}).`);
      ate = semanaAtual;
    }
    const n = Math.min(53, Math.max(1, Math.trunc(consulta.semanas ?? 12)));
    const prazo = (s: string) => prazoDaNegativa(s, cfg, tz);
    // Aberta: em curso ou antes do prazo do atesto. No fim da grade, no máximo a em curso e a anterior.
    const aberta = (s: string) => s >= semanaAtual || agora.getTime() <= prazo(s).getTime();
    let abertas = 0;
    for (let s = ate; abertas < 3 && aberta(s); s = deslocarSemana(s, -1)) abertas++;
    // Teto: os parâmetros vão até 52 semanas (PATCH /vigilancia/configuracoes); um valor gravado fora disso não estoura a consulta.
    const total = Math.min(60, Math.max(n, cfg.semanasSoNegativa, cfg.semanasSilenciosa, cfg.semanasRegularidadeMunicipal) + abertas);
    const todas: ColunaGrade[] = semanasEntre(deslocarSemana(ate, -(total - 1)), ate).map((s) => ({ semana: s, ...intervalo(s), fechada: s < semanaAtual, prazo: prazo(s).toISOString() }));
    const desloc = todas.length - n;
    const colunas = todas.slice(desloc);
    const inicio = todas[0]!.inicio;
    const fim = todas[todas.length - 1]!.fim;
    const [periodos, municipio] = await Promise.all([
      ctx.db.notifyingUnit.findMany({
        where: { since: { lte: comoData(fim) }, OR: [{ until: null }, { until: { gte: comoData(inicio) } }] },
        include: { unit: { select: { id: true, name: true, cnes: true, type: true, active: true } } },
      }),
      municipioDoTenant(this.master, ctx.tenant.id),
    ]);
    const unidades = [...new Map(periodos.map((p) => [p.unitId, p.unit])).values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    const semanas = todas.map((c) => c.semana);
    const [fatos, comInformacao] = await Promise.all([this.fatos(ctx.db, unidades, semanas), this.semanasComInformacao(ctx.db, semanas, municipio.ibge)]);
    // Todas as semanas da análise; as linhas exibidas são as das unidades notificantes em alguma semana pedida.
    const todasAsLinhas = unidades.map((u) => {
      const doPeriodo = periodos.filter((p) => p.unitId === u.id);
      const celulas: CelulaGrade[] = todas.map((c) => {
        const f = fatos.get(chave(u.id, c.semana)) ?? vazio();
        const negativaSinan = f.negativasSinan.length > 0;
        return {
          semana: c.semana,
          situacao: situacaoDaSemana({
            notificante: this.notificante(doPeriodo, c.semana),
            positivas: f.notificacoes.length + f.surtos.length + f.registros.length,
            negativa: f.atesto ? { atrasada: f.atesto.late } : negativaSinan ? { atrasada: false } : null,
            emCurso: c.semana >= semanaAtual,
            prazoPassou: agora.getTime() > Date.parse(c.prazo),
          }),
          fontes: {
            notificacoes: f.notificacoes.length,
            surtos: f.surtos.length,
            registrosOficiais: f.registros.length,
            atesto: f.atesto ? { id: f.atesto.id, atrasado: f.atesto.late } : null,
            negativaSinan,
          },
        };
      });
      return { u, doPeriodo, celulas };
    });
    const doMunicipio: SemanaDoMunicipio[] = todas.map((c) => ({
      comInformacao: comInformacao.has(c.semana),
      aberta: aberta(c.semana),
      comNotificante: periodos.some((p) => this.notificante([p], c.semana)),
    }));
    const completa = analisarGrade(
      todasAsLinhas.map((l) => ({ unitId: l.u.id, semanas: l.celulas.map((c) => c.situacao) })),
      cfg,
      doMunicipio,
    );
    const exibidas = todasAsLinhas.filter((l) => l.celulas.slice(desloc).some((c) => c.situacao !== 'NAO_NOTIFICANTE'));
    const ids = new Set(exibidas.map((l) => l.u.id));
    const analise: AnaliseGrade = {
      silenciosas: completa.silenciosas.filter((s) => ids.has(s.unitId)),
      soNegativas: completa.soNegativas.filter((s) => ids.has(s.unitId)),
      percentualPorSemana: completa.percentualPorSemana.slice(desloc).map((p, i) => ({ ...p, semana: i })),
      regularidadeMunicipal: completa.regularidadeMunicipal,
    };
    // Diferenças com o Sinan, só nas semanas pedidas. O atesto sem negativa vigente no Sinan entra mesmo que já tenha
    // casado com uma NNEGANET que depois saiu da exportação ou foi excluída.
    const atestadoSemSinan: DiferencaSinan[] = [];
    const sinanSemAtesto: DiferencaSinan[] = [];
    const linhas: LinhaGradeNegativa[] = exibidas.map(({ u, celulas }) => {
      const ref = { id: u.id, nome: u.name, cnes: u.cnes };
      for (const c of colunas) {
        const f = fatos.get(chave(u.id, c.semana)) ?? vazio();
        if (f.atesto && !f.negativasSinan.length) atestadoSemSinan.push({ unidade: ref, semana: c.semana, atestoId: f.atesto.id, registroOficialId: null });
        if (f.negativasSinan.length && !f.atesto) sinanSemAtesto.push({ unidade: ref, semana: c.semana, atestoId: null, registroOficialId: f.negativasSinan[0]!.id });
      }
      return { unidade: ref, tipoUnidade: u.type, ativa: u.active, celulas: celulas.slice(desloc) };
    });
    if (!linhas.length) avisos.push('Nenhuma unidade notificante no período: configure as unidades notificantes.');
    // Sem configuração: a ativa que atende e nunca teve período, e a reativada cujo último período terminou na
    // desativação no cadastro ou cuja desativação apagou o período planejado (a mesma regra da lista das unidades
    // notificantes).
    const [nuncaTiveram, comFimNaDesativacao] = await Promise.all([
      ctx.db.unit.count({ where: { active: true, type: { notIn: [...TIPOS_FORA_DA_NEGATIVA] }, notifyingPeriods: { none: {} } } }),
      ctx.db.unit.findMany({
        where: {
          active: true,
          AND: [
            { notifyingPeriods: { some: { OR: [{ endReason: MOTIVO_UNIDADE_DESATIVADA }, { nextRemovedAt: { not: null } }] } } },
            { notifyingPeriods: { none: { OR: [{ until: null }, { until: { gt: comoData(hoje) } }] } } },
          ],
        },
        select: { name: true, notifyingPeriods: { select: { since: true, until: true, endReason: true, nextRemovedAt: true } } },
        orderBy: { name: 'asc' },
      }),
    ]);
    const reativadas = comFimNaDesativacao
      .filter((u) =>
        reativadaSemPeriodo(
          true,
          u.notifyingPeriods.map((p) => ({ desde: dataIso(p.since)!, ate: dataIso(p.until), motivoFim: p.endReason, seguinteApagado: p.nextRemovedAt !== null })),
          hoje,
        ),
      )
      .map((u) => u.name);
    const semConfiguracao = nuncaTiveram + reativadas.length;
    if (semConfiguracao) avisos.push(`${semConfiguracao} unidade(s) ativa(s) sem período de unidade notificante: confira a configuração.`);
    if (reativadas.length === 1) avisos.push(`Unidade reativada: o período de notificante de ${reativadas[0]} terminou na desativação. Abra um período novo se ela voltou a notificar.`);
    else if (reativadas.length) avisos.push(`Unidades reativadas: o período de notificante de ${emFrase(reativadas)} terminou na desativação. Abra um período novo se elas voltaram a notificar.`);
    // Unidade inativa com o período ainda aberto (a desativação no cadastro já o encerra): continua na grade (silenciosa e
    // no denominador) até a vigilância encerrar o período na data da desativação. O mesmo com o período que termina
    // depois de hoje (dado anterior a esta versão): o encerramento da unidade inativa aceita esse período e encurta o fim
    // até hoje. Sem nenhum dos dois, não há o que encerrar.
    const inativas = exibidas.filter((l) => !l.u.active && l.doPeriodo.some((p) => !p.until)).map((l) => l.u.name);
    if (inativas.length === 1) avisos.push(`${inativas[0]} está inativa e com período de notificante aberto: entra como silenciosa e no percentual. Encerre o período na data da desativação.`);
    else if (inativas.length) avisos.push(`${emFrase(inativas)} estão inativas e com período de notificante aberto: entram como silenciosas e no percentual. Encerre o período na data da desativação.`);
    const comFimFuturo = exibidas
      .filter((l) => !l.u.active && !l.doPeriodo.some((p) => !p.until))
      .map((l) => ({ nome: l.u.name, ate: l.doPeriodo.map((p) => dataIso(p.until)!).reduce((a, b) => (b > a ? b : a), '') }))
      .filter((x) => x.ate > hoje);
    if (comFimFuturo.length === 1)
      avisos.push(`${comFimFuturo[0]!.nome} está inativa e com período de notificante até ${ddmmaaaa(comFimFuturo[0]!.ate)}: entra como silenciosa e no percentual até lá. Encerre o período na data da desativação.`);
    else if (comFimFuturo.length)
      avisos.push(
        `${emFrase(comFimFuturo.map((x) => x.nome))} estão inativas e com período de notificante que termina depois de hoje: entram como silenciosas e no percentual até o fim dele. Encerre o período na data da desativação.`,
      );
    const regularidade = regularidadeDoMunicipio(doMunicipio, cfg.semanasRegularidadeMunicipal);
    if (regularidade.semanasSemInformacao > 0) {
      avisos.push('A regularidade não lê as notificações de epizootia nem de tracoma (o OmniSaúde não importa EPIZONET nem NTRACOMA). Confira no Sinan.');
      if (regularidade.semDados && regularidade.parada !== null)
        avisos.push(`A regularidade conta desde a SE ${rotuloSemana(deslocarSemana(todas[regularidade.parada]!.semana, 1))}: antes dela, nenhuma unidade era notificante.`);
    }
    return { colunas, linhas, analise, metaPercentual: cfg.metaPercentual, atestadoSemSinan, sinanSemAtesto, avisos };
  }

  // ───────────────────────────── unidades notificantes e responsáveis ─────────────────────────────

  /**
   * Por que a designação ativa não vale, ou nulo: o usuário precisa estar ativo e ter lotação ativa na unidade num papel
   * que atesta a negativa (o mesmo que o atesto exige).
   */
  private motivoDesignacaoInvalida(usuarioAtivo: boolean, lotacoesNaUnidade: { role: string }[]): string | null {
    if (!usuarioAtivo) return MOTIVO_ACESSO_DESATIVADO;
    if (!lotacoesNaUnidade.length) return 'Sem lotação ativa na unidade';
    return lotacoesNaUnidade.some((l) => atestaNegativa(l.role)) ? null : 'Papel nesta unidade não atesta a negativa';
  }

  /**
   * Monta as unidades (todas as ativas e as que já tiveram período) com os períodos e os responsáveis (cada ativo com a
   * marca de válido). "Sem configuração": unidade ativa que atende (fora farmácia central, almoxarifado e vigilância) e
   * nunca teve período, ou a reativada cujo último período terminou na desativação no cadastro ou cuja desativação
   * apagou o período planejado, sem período aberto nem com fim depois de hoje (com aviso; nada se reabre sozinho).
   */
  private async montarUnidades(db: Db, timeZone: string, unitIds?: string[]): Promise<UnidadeNotificante[]> {
    const hoje = localDateString(this.agora(), timeZone);
    const unidades = await db.unit.findMany({
      where: unitIds ? { id: { in: unitIds } } : { OR: [{ active: true }, { notifyingPeriods: { some: {} } }] },
      select: {
        id: true,
        name: true,
        cnes: true,
        type: true,
        active: true,
        notifyingPeriods: { orderBy: { since: 'desc' } },
        notifyingResponsibles: { include: { user: { select: { name: true, socialName: true, active: true } } }, orderBy: [{ designatedAt: 'desc' }] },
      },
      orderBy: { name: 'asc' },
    });
    const designadores = await db.user.findMany({
      where: { id: { in: [...new Set(unidades.flatMap((u) => u.notifyingResponsibles.map((r) => r.designatedBy)))] } },
      select: { id: true, name: true, socialName: true },
    });
    const nomeDe = new Map(designadores.map((u) => [u.id, u.socialName ?? u.name]));
    // Lotações ativas dos responsáveis ativos nas unidades da lista (a validade de cada designação).
    const ativos = unidades.flatMap((u) => u.notifyingResponsibles.filter((r) => r.until === null).map((r) => ({ unitId: u.id, userId: r.userId })));
    const lotacoes = ativos.length
      ? await db.userAssignment.findMany({
          where: { active: true, unitId: { in: [...new Set(ativos.map((a) => a.unitId))] }, userId: { in: [...new Set(ativos.map((a) => a.userId))] } },
          select: { userId: true, unitId: true, role: true },
        })
      : [];
    return unidades.map((u) => {
      const periodos: PeriodoNotificante[] = u.notifyingPeriods.map((p) => ({ id: p.id, desde: dataIso(p.since)!, ate: dataIso(p.until), motivoFim: p.endReason }));
      const atual = periodos.find((p) => p.ate === null) ?? periodos.find((p) => p.desde <= hoje && (p.ate ?? '9999-12-31') >= hoje) ?? null;
      // Ativos primeiro; depois o histórico, do mais recente para o mais antigo.
      const responsaveis: ResponsavelNegativa[] = [...u.notifyingResponsibles]
        .sort((a, b) => Number(a.until !== null) - Number(b.until !== null) || b.designatedAt.getTime() - a.designatedAt.getTime())
        .map((r) => {
          const motivoInvalido =
            r.until === null
              ? this.motivoDesignacaoInvalida(
                  r.user.active,
                  lotacoes.filter((l) => l.userId === r.userId && l.unitId === u.id),
                )
              : null;
          return {
            id: r.id,
            userId: r.userId,
            nome: r.user.socialName ?? r.user.name,
            tipo: r.kind as TipoResponsavelNegativa,
            desde: dataIso(r.since)!,
            ate: dataIso(r.until),
            designadoEm: r.designatedAt.toISOString(),
            designadoPor: nomeDe.get(r.designatedBy) ?? null,
            valido: r.until === null ? motivoInvalido === null : null,
            motivoInvalido,
          };
        });
      const avisos: string[] = [];
      // A desativação no cadastro já encerra o período; o aviso fica para a unidade inativa que ainda tenha um aberto,
      // ou um que termina depois de hoje (dado anterior a esta versão): os dois a tela deixa encerrar, com fim até hoje.
      const fimFuturo = periodos.find((p) => p.ate !== null && p.ate > hoje);
      if (!u.active && periodos.some((p) => p.ate === null)) avisos.push('Unidade inativa com período de notificante aberto. Encerre o período na data da desativação.');
      else if (!u.active && fimFuturo) avisos.push(`Unidade inativa com período de notificante até ${ddmmaaaa(fimFuturo.ate!)}, depois de hoje. Encerre o período na data da desativação.`);
      const reativada = reativadaSemPeriodo(
        u.active,
        u.notifyingPeriods.map((p) => ({ desde: dataIso(p.since)!, ate: dataIso(p.until), motivoFim: p.endReason, seguinteApagado: p.nextRemovedAt !== null })),
        hoje,
      );
      if (reativada) avisos.push(AVISO_UNIDADE_REATIVADA);
      const titularInvalido = responsaveis.find((r) => r.tipo === 'TITULAR' && r.valido === false);
      if (titularInvalido)
        avisos.push(
          titularInvalido.motivoInvalido === MOTIVO_ACESSO_DESATIVADO
            ? 'Titular com o acesso desativado no cadastro: a designação não vale.'
            : 'Titular sem lotação ativa na unidade em papel que atesta: a designação não vale.',
        );
      return {
        unidade: { id: u.id, nome: u.name, cnes: u.cnes },
        tipoUnidade: u.type,
        ativa: u.active,
        periodoAtual: atual,
        periodos,
        responsaveis,
        semConfiguracao: reativada || (u.active && periodos.length === 0 && !(TIPOS_FORA_DA_NEGATIVA as readonly string[]).includes(u.type)),
        avisos,
      };
    });
  }

  private async umaUnidade(ctx: RequestContext, unitId: string): Promise<UnidadeNotificante> {
    const [u] = await this.montarUnidades(ctx.db, ctx.tenant.timeZone, [unitId]);
    if (!u) throw notFound('Unidade');
    return u;
  }

  /** GET /vigilancia/unidades-notificantes. */
  async unidadesNotificantes(ctx: RequestContext): Promise<ListaUnidadesNotificantes> {
    return this.montarUnidades(ctx.db, ctx.tenant.timeZone);
  }

  /**
   * Trava a unidade e as linhas dos períodos dela, na ordem de encerrarUnidadeNotificante: a desativação no cadastro,
   * a abertura e o encerramento feitos ao mesmo tempo entram em fila, e quem vem depois relê a unidade e os períodos.
   */
  private async travarPeriodos(tx: Db, unitId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`negativa-responsavel:${unitId}`}))`;
    await tx.$queryRaw`SELECT id FROM notifying_units WHERE unit_id = ${unitId}::uuid FOR UPDATE`;
  }

  /**
   * POST /vigilancia/unidades-notificantes: abre período (um aberto por unidade; sem sobrepor o anterior). As
   * conferências (unidade ativa, período aberto, sobreposição) rodam na transação, depois das travas da unidade e dos
   * períodos: a desativação feita ao mesmo tempo espera a abertura e encerra o período novo, ou é esperada, e a abertura
   * encontra a unidade inativa (422).
   */
  async abrirPeriodo(ctx: RequestContext, corpo: CorpoAbrirPeriodoNotificante): Promise<UnidadeNotificante> {
    try {
      await ctx.db.$transaction(async (tx) => {
        await this.travarPeriodos(tx, corpo.unitId);
        const unidade = await tx.unit.findUnique({ where: { id: corpo.unitId }, select: { id: true, cnes: true, active: true } });
        if (!unidade) throw notFound('Unidade');
        if (!unidade.active) throw new DomainError('UNIDADE_INATIVA', 'Unidade inativa não é notificante', HttpStatus.UNPROCESSABLE_ENTITY);
        const periodos = await tx.notifyingUnit.findMany({ where: { unitId: unidade.id }, orderBy: { since: 'desc' } });
        const aberto = periodos.find((p) => !p.until);
        if (aberto) throw conflict(`A unidade já é notificante desde ${ddmmaaaa(dataIso(aberto.since)!)}: encerre o período antes de abrir outro`);
        const sobreposto = periodos.find((p) => dataIso(p.until)! >= corpo.desde);
        if (sobreposto) throw new DomainError('PERIODO_SOBREPOSTO', `O novo período não pode começar antes do fim do anterior (${ddmmaaaa(dataIso(sobreposto.until)!)})`, HttpStatus.UNPROCESSABLE_ENTITY);
        const p = await tx.notifyingUnit.create({ data: { unitId: unidade.id, since: comoData(corpo.desde), createdBy: ctx.session.userId }, select: { id: true } });
        await this.audit.record(ctx, tx, { action: 'vigilancia.notificante_abrir', entityType: 'NotifyingUnit', entityId: p.id, payload: { unidade: unidade.cnes, desde: corpo.desde } });
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw conflict('A unidade já tem período aberto');
      throw err;
    }
    return this.umaUnidade(ctx, corpo.unitId);
  }

  /**
   * POST /vigilancia/unidades-notificantes/:unitId/encerrar: fecha o período aberto (o histórico não é recalculado). Na
   * unidade inativa, o fim não passa de hoje, no fuso da instituição (422 FIM_DEPOIS_DE_HOJE): depois de hoje, ela
   * seguiria silenciosa e no denominador sem atender. Nela também se encerra o período que ainda termina depois de hoje
   * (dado anterior a esta versão): o fim encurta para a data informada, e a trilha guarda o fim e o motivo anteriores.
   * As conferências rodam na transação, depois das travas da unidade e dos períodos (como a abertura).
   */
  async encerrarPeriodo(ctx: RequestContext, unitId: string, corpo: CorpoEncerrarPeriodoNotificante): Promise<UnidadeNotificante> {
    const agora = this.agora();
    const hoje = localDateString(agora, ctx.tenant.timeZone);
    await ctx.db.$transaction(async (tx) => {
      await this.travarPeriodos(tx, unitId);
      const unidade = await tx.unit.findUnique({ where: { id: unitId }, select: { id: true, cnes: true, active: true } });
      if (!unidade) throw notFound('Unidade');
      const periodos = await tx.notifyingUnit.findMany({ where: { unitId, OR: [{ until: null }, { until: { gt: comoData(hoje) } }] }, orderBy: { since: 'desc' } });
      const alvo = periodos.find((p) => !p.until) ?? (unidade.active ? undefined : periodos[0]);
      if (!alvo) throw new DomainError('SEM_PERIODO_ABERTO', 'A unidade não tem período de notificante aberto', HttpStatus.UNPROCESSABLE_ENTITY);
      if (corpo.ate < dataIso(alvo.since)!) throw new DomainError('DATA_INVALIDA', 'O fim não pode ser antes do início do período', HttpStatus.BAD_REQUEST);
      if (!unidade.active && corpo.ate > hoje)
        throw new DomainError('FIM_DEPOIS_DE_HOJE', `A unidade está inativa: o fim do período não pode passar de hoje (${ddmmaaaa(hoje)}). Use a data da desativação.`, HttpStatus.UNPROCESSABLE_ENTITY);
      const { count } = await tx.notifyingUnit.updateMany({
        where: { id: alvo.id, until: alvo.until },
        data: { until: comoData(corpo.ate), endReason: corpo.motivo.trim(), endedBy: ctx.session.userId, endedAt: agora },
      });
      if (count !== 1) throw conflict('O período mudou desde a leitura; abra de novo');
      const fimAnterior = dataIso(alvo.until);
      await this.audit.record(ctx, tx, {
        action: 'vigilancia.notificante_encerrar',
        entityType: 'NotifyingUnit',
        entityId: alvo.id,
        payload: fimAnterior ? { unidade: unidade.cnes, ate: corpo.ate, motivo: corpo.motivo, fimAnterior, motivoAnterior: alvo.endReason } : { unidade: unidade.cnes, ate: corpo.ate, motivo: corpo.motivo },
      });
    });
    return this.umaUnidade(ctx, unitId);
  }

  /**
   * GET /vigilancia/unidades-notificantes/:unitId/lotados?busca=: usuários ativos com lotação ativa na unidade, para a
   * busca da tela de designação (`vigilancia.consolidacao`), com a marca de quem pode atestar (papel com
   * `notificacao.negativa` na unidade). Busca pelo nome (sem diferenciar maiúsculas); pelo CPF, só com os 11 dígitos
   * e por igualdade: a vigilância não lê CPF de profissional, e o prefixo deixaria descobrir o CPF (o login) aos poucos.
   */
  async lotados(ctx: RequestContext, unitId: string, busca?: string): Promise<ListaUsuariosLotados> {
    const unidade = await ctx.db.unit.findUnique({ where: { id: unitId }, select: { id: true } });
    if (!unidade) throw notFound('Unidade');
    const termo = busca?.trim() ?? '';
    const digitos = termo.replace(/\D/g, '');
    const porCpf = /^[\d.\-\s]+$/.test(termo) && digitos.length === 11;
    const usuarios = await ctx.db.user.findMany({
      where: {
        active: true,
        assignments: { some: { unitId, active: true } },
        ...(porCpf ? { cpf: digitos } : termo ? { OR: [{ name: { contains: termo, mode: 'insensitive' as const } }, { socialName: { contains: termo, mode: 'insensitive' as const } }] } : {}),
      },
      select: { id: true, name: true, socialName: true, assignments: { where: { unitId, active: true }, select: { role: true, cbo: true } } },
      orderBy: { name: 'asc' },
      take: 50,
    });
    const ativos = await ctx.db.notifyingUnitResponsible.findMany({ where: { unitId, until: null, userId: { in: usuarios.map((u) => u.id) } }, select: { userId: true, kind: true } });
    return usuarios.map((u) => {
      const queAtesta = u.assignments.find((a) => atestaNegativa(a.role));
      return {
        userId: u.id,
        nome: u.socialName ?? u.name,
        papeis: [...new Set(u.assignments.map((a) => a.role))],
        cbo: (queAtesta ?? u.assignments[0])?.cbo ?? null,
        podeAtestar: !!queAtesta,
        responsavel: (ativos.find((a) => a.userId === u.id)?.kind as TipoResponsavelNegativa | undefined) ?? null,
      };
    });
  }

  /**
   * POST /vigilancia/unidades-notificantes/:unitId/responsaveis: o usuário precisa de lotação ativa na unidade, com
   * papel que atesta a negativa (`notificacao.negativa`: quem não tem esse papel não abre a tela nem atesta, e
   * travaria a vaga de titular), e a unidade precisa ser notificante; um titular ativo por unidade (substitutos,
   * quantos forem precisos). O titular cuja designação não vale (sem lotação ativa na unidade em papel que atesta, ou
   * com o acesso desativado) não trava a vaga: a designação dele termina hoje na mesma transação, com auditoria.
   */
  async designarResponsavel(ctx: RequestContext, unitId: string, corpo: CorpoDesignarResponsavel): Promise<UnidadeNotificante> {
    const unidade = await ctx.db.unit.findUnique({ where: { id: unitId }, select: { id: true, cnes: true } });
    if (!unidade) throw notFound('Unidade');
    const usuario = await ctx.db.user.findUnique({ where: { id: corpo.userId }, select: { id: true, active: true, name: true, socialName: true } });
    if (!usuario || !usuario.active) throw notFound('Usuário');
    const lotacoes = await ctx.db.userAssignment.findMany({ where: { userId: usuario.id, unitId, active: true }, select: { role: true } });
    if (!lotacoes.length) throw new DomainError('SEM_LOTACAO', 'O usuário precisa ter lotação ativa na unidade', HttpStatus.UNPROCESSABLE_ENTITY);
    if (!lotacoes.some((l) => atestaNegativa(l.role)))
      throw new DomainError(
        'PAPEL_SEM_NEGATIVA',
        `O papel de ${usuario.socialName ?? usuario.name} nesta unidade (${emFrase([...new Set(lotacoes.map((l) => ROLE_LABELS[l.role as Role] ?? l.role))])}) não atesta a negativa. Escolha alguém com papel que atesta.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    const naoNotificante = () => new DomainError('NAO_NOTIFICANTE', 'A unidade não é notificante: abra o período antes de designar responsáveis', HttpStatus.UNPROCESSABLE_ENTITY);
    if (!(await ctx.db.notifyingUnit.count({ where: { unitId, until: null } }))) throw naoNotificante();
    const agora = this.agora();
    const hoje = localDateString(agora, ctx.tenant.timeZone);
    try {
      await ctx.db.$transaction(async (tx) => {
        // Um titular ativo por unidade: a trava da unidade põe em fila as designações simultâneas (sem índice para isso)
        // e a desativação da unidade no cadastro, que encerra o período (relido aqui, depois da trava).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`negativa-responsavel:${unitId}`}))`;
        if (!(await tx.notifyingUnit.count({ where: { unitId, until: null } }))) throw naoNotificante();
        const ativos = await tx.notifyingUnitResponsible.findMany({ where: { unitId, until: null }, include: { user: { select: { name: true, active: true } } } });
        const jaE = ativos.find((a) => a.userId === usuario.id);
        if (jaE) throw conflict(`${usuario.name} já é ${jaE.kind === 'TITULAR' ? 'titular' : 'substituto(a)'} desta unidade`);
        const titular = ativos.find((a) => a.kind === 'TITULAR');
        if (corpo.tipo === 'TITULAR' && titular) {
          const lotacoesDoTitular = await tx.userAssignment.findMany({ where: { userId: titular.userId, unitId, active: true }, select: { role: true } });
          const invalida = this.motivoDesignacaoInvalida(titular.user.active, lotacoesDoTitular);
          if (!invalida) throw conflict(`A unidade já tem titular (${titular.user.name}): revogue a designação antes`);
          // O titular atual não vale (sem lotação ativa na unidade em papel que atesta, ou sem acesso): a designação
          // dele termina hoje (no próprio início, se ainda não começou), como na revogação, e o novo titular entra.
          const ate = hoje < dataIso(titular.since)! ? dataIso(titular.since)! : hoje;
          const { count } = await tx.notifyingUnitResponsible.updateMany({ where: { id: titular.id, until: null }, data: { until: comoData(ate), revokedBy: ctx.session.userId, revokedAt: agora } });
          if (count !== 1) throw conflict('A designação mudou desde a leitura; abra de novo');
          await this.audit.record(ctx, tx, {
            action: 'vigilancia.negativa_revogar',
            entityType: 'NotifyingUnitResponsible',
            entityId: titular.id,
            payload: { unidade: unitId, usuario: titular.userId, tipo: titular.kind, ate, motivo: `Novo titular designado: a designação não valia (${invalida.toLowerCase()})` },
          });
        }
        const r = await tx.notifyingUnitResponsible.create({
          data: { unitId, userId: usuario.id, kind: corpo.tipo, since: comoData(corpo.desde), designatedBy: ctx.session.userId, designatedAt: agora },
          select: { id: true },
        });
        await this.audit.record(ctx, tx, {
          action: 'vigilancia.negativa_designar',
          entityType: 'NotifyingUnitResponsible',
          entityId: r.id,
          payload: { unidade: unidade.cnes, usuario: usuario.id, tipo: corpo.tipo, desde: corpo.desde },
        });
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw conflict('O usuário já é responsável desta unidade');
      throw err;
    }
    return this.umaUnidade(ctx, unitId);
  }

  /** POST /vigilancia/responsaveis/:id/revogar: a designação termina hoje (o atesto já feito continua valendo). */
  async revogarResponsavel(ctx: RequestContext, id: string): Promise<RespostaOk> {
    const r = await ctx.db.notifyingUnitResponsible.findUnique({ where: { id }, select: { id: true, until: true, unitId: true, userId: true, kind: true, since: true } });
    if (!r) throw notFound('Designação');
    if (r.until) throw new DomainError('JA_REVOGADA', 'A designação já terminou', HttpStatus.UNPROCESSABLE_ENTITY);
    const agora = this.agora();
    const hoje = localDateString(agora, ctx.tenant.timeZone);
    // A designação que ainda não começou termina no próprio início (o fim nunca fica antes do início).
    const ate = hoje < dataIso(r.since)! ? dataIso(r.since)! : hoje;
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.notifyingUnitResponsible.updateMany({ where: { id, until: null }, data: { until: comoData(ate), revokedBy: ctx.session.userId, revokedAt: agora } });
      if (count !== 1) throw conflict('A designação mudou desde a leitura; abra de novo');
      await this.audit.record(ctx, tx, { action: 'vigilancia.negativa_revogar', entityType: 'NotifyingUnitResponsible', entityId: id, payload: { unidade: r.unitId, usuario: r.userId, tipo: r.kind } });
    });
    return { ok: true };
  }
}
