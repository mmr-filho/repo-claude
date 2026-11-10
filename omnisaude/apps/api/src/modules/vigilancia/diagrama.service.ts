import { HttpStatus, Injectable } from '@nestjs/common';
import type { TenantPrisma } from '@omnisaude/database';
import {
  calcularCanal,
  csvDoCanal,
  curvaObservada,
  RECEITAS_MODELO,
  ROTULO_FONTE_POPULACAO,
  semanaDaData,
  semanaDoCanal,
  semanaEpidemiologica,
  semanasCompletas,
  semanasNoAno,
  statusDaSemana,
  sugerirAnosEpidemicos,
  type AnoExcluido,
  type CanalCalculado,
  type CanalCongelado,
  type CanalDoAno,
  type ChaveReceitaModelo,
  type ConfiguracaoDiagrama,
  type ConsultaDiagrama,
  type CorpoCongelarCanal,
  type CorpoConfiguracaoDiagrama,
  type ExcessoTerritorio,
  type FontePopulacao,
  type NivelTerritorio,
  type PontoDiagrama,
  type PontoObservado,
  type PopulacaoUsada,
  type ReceitaCanal,
  type RespostaAnosEpidemicos,
  type RespostaCongelarCanal,
  type RespostaDiagrama,
  type SemanaCanal,
  type SerieAnual,
  type StatusSemana,
  type TerritorioRef,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';
import type { SystemContext } from '../integrations/messaging.service';
import { CatalogoVigilanciaService } from './catalogo.service';
import { ConsolidadoService, type BaseConsolidada } from './consolidado.service';
import { avisosDaPopulacao, escolherFonte, PopulacaoService, populacaoUsada, type EstimativaBase, type FonteEscolhida } from './populacao.service';

type Db = TenantPrisma.TransactionClient;

const MODELO_PADRAO: ChaveReceitaModelo = 'MS_2025';
const ANO_MINIMO = 2000;
const pad = (n: number) => String(n).padStart(2, '0');

/** Canal congelado gravado (control_channels). */
interface CanalGravado {
  id: string;
  year: number;
  level: NivelTerritorio;
  territoryId: string | null;
  version: number;
  recipe: unknown;
  populationSource: FontePopulacao | null;
  populationVersion: string | null;
  referenceYears: number[];
  weeks: unknown;
  notes: string | null;
  computedBy: string;
  computedAt: Date;
}

/** Um ano do diagrama já montado: canal (congelado ou prévia), curva observada e população usada. */
export interface AnoMontado {
  ano: number;
  canal: CanalCalculado;
  congelado: CanalCongelado | null;
  observado: PontoObservado[];
  populacao: PopulacaoUsada[];
  /** População do próprio ano (a da curva observada). */
  populacaoDoAno: number | null;
  fonte: FonteEscolhida | null;
  avisos: string[];
}

/** Diagrama de um território em um ou mais anos, com o que a tela e a contingência precisam. */
export interface DiagramaMontado {
  configuracao: ConfiguracaoDiagrama;
  anos: AnoMontado[];
  base: BaseConsolidada;
  semanaAtual: string;
  incompletas: string[];
  ultimaCompleta: string;
  semSemanaSintomas: number;
  bairrosSemCorrespondencia: number;
  avisos: string[];
}

/** Anos de referência da janela da receita (antes de tirar os excluídos e os sem cobertura). */
export function janelaDeReferencia(ano: number, receita: ReceitaCanal): number[] {
  const n = Math.max(0, Math.trunc(receita.anos));
  const anos = Array.from({ length: n }, (_, i) => ano - n + i);
  if (receita.incluiAnoEmAnalise) anos.push(ano);
  return anos;
}

/** Receita completa a partir do que foi gravado (campos que faltarem vêm do modelo padrão). */
function receitaGravada(r: unknown): ReceitaCanal {
  return { ...RECEITAS_MODELO[MODELO_PADRAO].receita, ...((r && typeof r === 'object' ? r : {}) as Partial<ReceitaCanal>) };
}

/** Modelo de onde a receita veio, quando é igual a um deles; null = receita própria. */
export function modeloDaReceita(r: ReceitaCanal): ChaveReceitaModelo | null {
  const campos = Object.keys(RECEITAS_MODELO[MODELO_PADRAO].receita) as (keyof ReceitaCanal)[];
  for (const [chave, m] of Object.entries(RECEITAS_MODELO) as [ChaveReceitaModelo, (typeof RECEITAS_MODELO)[ChaveReceitaModelo]][]) if (campos.every((c) => m.receita[c] === r[c])) return chave;
  return null;
}

/** Regras que o Excel e os documentos do MS impõem à receita, além do formato (zod no controller). */
export function validarConfiguracao(receita: ReceitaCanal, anosExcluidos: AnoExcluido[], anoAtual: number): string[] {
  const erros: string[] = [];
  if (receita.metodo === 'QUARTIS' && receita.janela === 'AGRUPADA_5')
    erros.push('Com mediana e quartis, a janela de 5 semanas é a suavizada (cada ano suavizado antes dos quartis): a agrupada é só da média e desvio-padrão (Diretrizes 2009).');
  if (receita.metodo === 'QUARTIS' && receita.quartil === 'EXC' && receita.anos < 3) erros.push('O QUARTIL.EXC precisa de pelo menos 3 anos de referência.');
  if (receita.metodo === 'QUARTIS' && receita.anos < 2) erros.push('Mediana e quartis precisam de pelo menos 2 anos de referência.');
  if (receita.metodo === 'MEDIA_DP' && receita.janela === 'NENHUMA' && receita.anos < 2) erros.push('O desvio-padrão amostral precisa de pelo menos 2 anos de referência.');
  if (receita.metodo === 'MEDIA_DP' && !(receita.k > 0)) erros.push('Informe o multiplicador do desvio-padrão (k maior que zero).');
  const vistos = new Set<number>();
  for (const a of anosExcluidos) {
    if (vistos.has(a.ano)) erros.push(`O ano ${a.ano} aparece duas vezes nos anos excluídos.`);
    vistos.add(a.ano);
    if (a.ano > anoAtual) erros.push(`O ano ${a.ano} ainda não terminou: não pode ser excluído da referência.`);
  }
  return erros;
}

/** Canal congelado como o cálculo devolveria (receita, anos de referência e as 52 semanas gravadas). */
function canalDoCongelado(c: CanalGravado): CanalCalculado {
  return { receita: receitaGravada(c.recipe), anosReferencia: [...c.referenceYears], semanas: c.weeks as SemanaCanal[], avisos: [] };
}

/** Casos de cada SE do ano, com as semanas que ainda não chegaram em null (ano em curso ou futuro). */
function semAsFuturas(semanas: (number | null)[] | undefined, ano: number, semanaAtual: string): (number | null)[] {
  const atualAno = Number(semanaAtual.slice(0, 4));
  const atualSe = Number(semanaAtual.slice(4));
  return Array.from({ length: 53 }, (_, i) => (ano > atualAno || (ano === atualAno && i + 1 > atualSe) ? null : (semanas?.[i] ?? null)));
}

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Diagrama de controle (VIG-1c, §4.2; frente F3): canal congelado ativo ou prévia calculada na hora, curva observada,
 * status por semana, semanas incompletas, população usada, cobertura e avisos; CSV para refazer no Excel; congelar uma
 * nova versão; receita por agravo; anos epidêmicos sugeridos.
 */
@Injectable()
export class DiagramaService {
  /** Relógio do serviço (os testes trocam por uma data fixa). */
  agora: () => Date = () => new Date();

  constructor(
    private readonly audit: AuditService,
    private readonly consolidado: ConsolidadoService,
    private readonly populacao: PopulacaoService,
    private readonly catalogo: CatalogoVigilanciaService,
  ) {}

  // ───────────── consultas ─────────────

  /** GET /vigilancia/diagrama. */
  async diagrama(ctx: RequestContext, consulta: ConsultaDiagrama): Promise<RespostaDiagrama> {
    const eixo = consulta.eixo ?? 'EPIDEMIOLOGICO';
    const territorio = await this.territorio(ctx.db, consulta.nivel, consulta.territorio ?? null);
    const agravo = await this.nomeDoAgravo(ctx, consulta.grupo);
    this.validarAno(ctx, consulta.ano);
    const anos = eixo === 'SAZONAL' ? [consulta.ano, consulta.ano + 1] : [consulta.ano];
    const m = await this.montar(ctx, consulta.grupo, territorio, anos, semanaEpidemiologica(this.agora(), ctx.tenant.timeZone).codigo);
    const incompletas = new Set(m.incompletas);
    const pontosDoAno = (a: AnoMontado, de: number, ate: number): PontoDiagrama[] =>
      Array.from({ length: Math.max(0, ate - de + 1) }, (_, i) => {
        const semana = de + i;
        const o = a.observado[semana - 1];
        const sc = semanaDoCanal(a.canal, semana);
        return {
          ano: a.ano,
          semana,
          rotulo: `${pad(semana)}/${a.ano}`,
          casos: o?.casos ?? null,
          valor: o?.valor ?? null,
          canal: sc ? { centro: sc.centro, li: sc.li, ls: sc.ls } : null,
          status: statusDaSemana(o?.valor ?? null, sc),
          incompleta: incompletas.has(`${a.ano}${pad(semana)}`),
        };
      });
    const [primeiro, segundo] = m.anos;
    const pontos = eixo === 'SAZONAL' ? [...pontosDoAno(primeiro!, 27, semanasNoAno(primeiro!.ano)), ...pontosDoAno(segundo!, 1, 26)] : pontosDoAno(primeiro!, 1, semanasNoAno(primeiro!.ano));
    const populacao = new Map<number, PopulacaoUsada>();
    for (const a of m.anos) for (const p of a.populacao) if (!populacao.has(p.ano) || p.ano === a.ano) populacao.set(p.ano, p);
    return {
      grupo: consulta.grupo,
      agravo,
      territorio,
      ano: consulta.ano,
      eixo,
      configuracao: m.configuracao,
      canais: m.anos.map((a): CanalDoAno => ({ ano: a.ano, canal: a.canal, congelado: a.congelado, observado: a.observado })),
      pontos,
      semanasIncompletas: m.incompletas,
      populacao: [...populacao.values()].sort((a, b) => a.ano - b.ano),
      cobertura: m.base.cobertura,
      semSemanaSintomas: m.semSemanaSintomas,
      bairrosSemCorrespondencia: m.bairrosSemCorrespondencia,
      avisos: m.avisos,
    };
  }

  /** GET /vigilancia/diagrama.csv (o conteúdo já começa com o BOM). Sempre o canal do ano epidemiológico pedido. */
  async csv(ctx: RequestContext, consulta: ConsultaDiagrama): Promise<{ fileName: string; content: string }> {
    const territorio = await this.territorio(ctx.db, consulta.nivel, consulta.territorio ?? null);
    const agravo = await this.nomeDoAgravo(ctx, consulta.grupo);
    this.validarAno(ctx, consulta.ano);
    const agora = this.agora();
    const m = await this.montar(ctx, consulta.grupo, territorio, [consulta.ano], semanaEpidemiologica(agora, ctx.tenant.timeZone).codigo);
    const a = m.anos[0]!;
    const fonte = a.canal.receita.unidade === 'CASOS' || !a.fonte ? null : `${ROTULO_FONTE_POPULACAO[a.fonte.fonte]}${a.fonte.versao ? `, versão ${a.fonte.versao}` : ''}`;
    const content = csvDoCanal(a.canal, a.observado, { titulo: `${agravo}, ${territorio.nome}, ${consulta.ano}`, fontePopulacao: fonte, geradoEm: agora.toISOString() });
    const lugar = territorio.nivel === 'MUNICIPIO' ? 'municipio' : slug(territorio.nome) || territorio.nivel.toLowerCase();
    return { fileName: `diagrama-${consulta.grupo}-${lugar}-${consulta.ano}.csv`, content };
  }

  /** GET /vigilancia/diagrama/configuracao/:grupo. */
  async configuracao(ctx: RequestContext, grupo: string): Promise<ConfiguracaoDiagrama> {
    await this.nomeDoAgravo(ctx, grupo);
    return this.configuracaoDe(ctx.db, grupo);
  }

  /** GET /vigilancia/diagrama/anos-epidemicos?grupo=&ano=: regra da SES-GO sobre a série do município. */
  async anosEpidemicos(ctx: RequestContext, consulta: { grupo: string; ano: number }): Promise<RespostaAnosEpidemicos> {
    await this.nomeDoAgravo(ctx, consulta.grupo);
    this.validarAno(ctx, consulta.ano);
    const config = await this.configuracaoDe(ctx.db, consulta.grupo);
    const anos = Array.from({ length: Math.max(0, Math.trunc(config.receita.anos)) }, (_, i) => consulta.ano - Math.trunc(config.receita.anos) + i);
    const municipio = { nivel: 'MUNICIPIO' as const, territorioId: null };
    const [base, est] = await Promise.all([this.consolidado.carregar(ctx, consulta.grupo, anos, false), this.populacao.estimativas(ctx.db)]);
    const pop = populacaoUsada(est, municipio, anos, escolherFonte(est, municipio, anos, { fonte: config.fontePopulacao, versao: config.versaoPopulacao }), consulta.ano);
    const casos = this.consolidado.agregar(base, { nivel: 'MUNICIPIO', territorioId: null, base: config.receita.base, anos });
    const series: SerieAnual[] = anos.map((ano) => ({ ano, semanas: casos.porAno.get(ano) ?? [], populacao: pop.find((p) => p.ano === ano)?.populacao ?? null }));
    return { grupo: consulta.grupo, ano: consulta.ano, sugestao: sugerirAnosEpidemicos(series, consulta.ano, config.receita.anos), excluidos: config.anosExcluidos };
  }

  /**
   * Territórios (bairro e localidade) acima do limite superior do próprio canal na última semana completa, para as
   * sugestões de surto da frente F4. `hoje` em AAAA-MM-DD. Território sem canal (sem população ou sem histórico) não
   * entra.
   */
  async excessos(sys: SystemContext, grupos: string[], hoje: string): Promise<ExcessoTerritorio[]> {
    const semanaAtual = semanaDaData(hoje).codigo;
    const { ultimaCompleta } = semanasCompletas(semanaAtual, sys.tenant.settings.vigilancia.consolidacao.semanasIncompletas);
    const ano = Number(ultimaCompleta.slice(0, 4));
    const semana = Number(ultimaCompleta.slice(4));
    const [bairros, locs] = await Promise.all([
      sys.db.neighborhood.findMany({ where: { active: true }, select: { id: true, name: true } }),
      sys.db.locality.findMany({ where: { status: 'ATIVA' }, select: { id: true, name: true } }),
    ]);
    const territorios: TerritorioRef[] = [...locs.map((l) => ({ nivel: 'LOCALIDADE' as const, id: l.id, nome: l.name })), ...bairros.map((b) => ({ nivel: 'BAIRRO' as const, id: b.id, nome: b.name }))];
    if (!territorios.length) return [];
    const out: ExcessoTerritorio[] = [];
    for (const grupo of [...new Set(grupos)]) {
      const conhecido = await this.nomeDoAgravo(sys, grupo).then(
        () => true,
        (e: unknown) => {
          if (e instanceof DomainError) return false;
          throw e;
        },
      );
      if (!conhecido) continue;
      const config = await this.configuracaoDe(sys.db, grupo);
      const congelados = await sys.db.controlChannel.findMany({ where: { groupKey: grupo, year: ano, active: true, level: { in: ['BAIRRO', 'LOCALIDADE'] } } });
      const anos = [...new Set([...janelaDeReferencia(ano, config.receita), ano])];
      const [base, est] = await Promise.all([
        this.consolidado.carregar(sys, grupo, anos, true),
        this.populacao.estimativas(
          sys.db,
          territorios.map((t) => ({ nivel: t.nivel, territorioId: t.id })),
        ),
      ]);
      for (const t of territorios) {
        const congelado = congelados.find((c) => c.level === t.nivel && c.territoryId === t.id) ?? null;
        const a = this.montarAno(config, congelado, t, ano, base, est, semanaAtual, null);
        const ponto = a.observado[semana - 1];
        const sc = semanaDoCanal(a.canal, semana);
        if (ponto?.valor == null || sc?.ls == null || statusDaSemana(ponto.valor, sc) !== 'ACIMA_LS') continue;
        out.push({ grupo, nivel: t.nivel, territorioId: t.id, territorioNome: t.nome, semana: ultimaCompleta, casos: ponto.casos ?? 0, valor: ponto.valor, ls: sc.ls });
      }
    }
    return out;
  }

  // ───────────── gravações ─────────────

  /** POST /vigilancia/diagrama/congelar: canal calculado agora vira a versão ativa (a anterior fica inativa). */
  async congelar(ctx: RequestContext, corpo: CorpoCongelarCanal): Promise<RespostaCongelarCanal> {
    const territorio = await this.territorio(ctx.db, corpo.nivel, corpo.territorio ?? null);
    await this.nomeDoAgravo(ctx, corpo.grupo);
    this.validarAno(ctx, corpo.ano);
    const semanaAtual = semanaEpidemiologica(this.agora(), ctx.tenant.timeZone).codigo;
    const m = await this.montar(ctx, corpo.grupo, territorio, [corpo.ano], semanaAtual, { ignorarCongelado: true });
    const a = m.anos[0]!;
    if (!a.canal.anosReferencia.length) throw new DomainError('SEM_REFERENCIA', `Sem anos de referência com dados: o canal de ${corpo.ano} não pode ser congelado.`, HttpStatus.UNPROCESSABLE_ENTITY, a.canal.avisos);
    const r = m.configuracao.receita;
    return ctx.db.$transaction(async (tx) => {
      const onde = { groupKey: corpo.grupo, level: territorio.nivel, territoryId: territorio.id, year: corpo.ano };
      const anterior = await tx.controlChannel.findFirst({ where: { ...onde, active: true }, select: { id: true, version: true } });
      const ultima = await tx.controlChannel.aggregate({ where: onde, _max: { version: true } });
      if (anterior) await tx.controlChannel.update({ where: { id: anterior.id }, data: { active: false } });
      const novo = await tx.controlChannel.create({
        data: {
          ...onde,
          version: (ultima._max.version ?? 0) + 1,
          active: true,
          recipe: r as unknown as TenantPrisma.InputJsonValue,
          populationSource: r.unidade === 'INCIDENCIA' ? (a.fonte?.fonte ?? null) : null,
          populationVersion: r.unidade === 'INCIDENCIA' ? (a.fonte?.versao ?? null) : null,
          referenceYears: a.canal.anosReferencia,
          weeks: a.canal.semanas as unknown as TenantPrisma.InputJsonValue,
          notes: corpo.nota?.trim() || null,
          computedBy: ctx.session.userId,
        },
      });
      await this.audit.record(ctx, tx, {
        action: 'vigilancia.canal_congelado',
        entityType: 'ControlChannel',
        entityId: novo.id,
        payload: { grupo: corpo.grupo, nivel: territorio.nivel, territorioId: territorio.id, ano: corpo.ano, versao: novo.version, anterior, receita: r, anosReferencia: a.canal.anosReferencia, fonte: a.fonte },
      });
      return { id: novo.id, versao: novo.version, ano: corpo.ano, anterior: anterior ? { id: anterior.id, versao: anterior.version } : null };
    });
  }

  /** PUT /vigilancia/diagrama/configuracao/:grupo: receita a partir de um modelo, anos excluídos e fonte da população. */
  async salvarConfiguracao(ctx: RequestContext, grupo: string, corpo: CorpoConfiguracaoDiagrama): Promise<ConfiguracaoDiagrama> {
    await this.nomeDoAgravo(ctx, grupo);
    const atual = await this.configuracaoDe(ctx.db, grupo);
    const receita: ReceitaCanal = { ...(corpo.modelo ? RECEITAS_MODELO[corpo.modelo].receita : atual.receita), ...(corpo.receita ?? {}) };
    const anoAtual = semanaEpidemiologica(this.agora(), ctx.tenant.timeZone).ano;
    const anosExcluidos = [...corpo.anosExcluidos].map((a) => ({ ano: a.ano, motivo: a.motivo.trim() })).sort((a, b) => a.ano - b.ano);
    const erros = validarConfiguracao(receita, anosExcluidos, anoAtual);
    if (corpo.versaoPopulacao && !corpo.fontePopulacao) erros.push('Informe a fonte da população junto com a versão.');
    if (corpo.fontePopulacao) {
      const existe = await ctx.db.populationEstimate.findFirst({
        where: { level: 'MUNICIPIO', source: corpo.fontePopulacao, ...(corpo.versaoPopulacao !== null ? { version: corpo.versaoPopulacao } : {}) },
        select: { id: true },
      });
      if (!existe) erros.push(`Não há população do município da fonte ${ROTULO_FONTE_POPULACAO[corpo.fontePopulacao]}${corpo.versaoPopulacao !== null ? `, versão ${corpo.versaoPopulacao}` : ''}: cadastre-a antes.`);
    }
    if (erros.length) throw new DomainError('CONFIGURACAO_INVALIDA', erros[0]!, HttpStatus.UNPROCESSABLE_ENTITY, erros);
    const dados = {
      recipe: receita as unknown as TenantPrisma.InputJsonValue,
      excludedYears: anosExcluidos as unknown as TenantPrisma.InputJsonValue,
      populationSource: corpo.fontePopulacao,
      populationVersion: corpo.fontePopulacao ? corpo.versaoPopulacao : null,
      updatedBy: ctx.session.userId,
    };
    await ctx.db.$transaction(async (tx) => {
      await tx.diagramSetting.upsert({ where: { groupKey: grupo }, create: { groupKey: grupo, ...dados }, update: dados });
      await this.audit.record(ctx, tx, {
        action: 'vigilancia.diagrama_configurado',
        entityType: 'DiagramSetting',
        entityId: grupo,
        payload: { grupo, modelo: corpo.modelo, receita, anosExcluidos, fontePopulacao: corpo.fontePopulacao, versaoPopulacao: dados.populationVersion, anterior: atual.padrao ? null : atual.receita },
      });
    });
    return this.configuracaoDe(ctx.db, grupo);
  }

  // ───────────── montagem ─────────────

  /**
   * Monta o diagrama do território nos anos pedidos (um no eixo epidemiológico, dois no sazonal): carrega a base
   * consolidada dos anos de referência e dos anos em análise uma vez só e calcula cada canal (o congelado ativo do
   * ano, se houver e não for para ignorá-lo).
   */
  async montar(sys: SystemContext, grupo: string, territorio: TerritorioRef, anos: number[], semanaAtual: string, opcoes: { ignorarCongelado?: boolean } = {}): Promise<DiagramaMontado> {
    const configuracao = await this.configuracaoDe(sys.db, grupo);
    const congelados: CanalGravado[] = opcoes.ignorarCongelado
      ? []
      : await sys.db.controlChannel.findMany({ where: { groupKey: grupo, level: territorio.nivel, territoryId: territorio.id, year: { in: anos }, active: true } });
    const doAno = (ano: number) => congelados.find((c) => c.year === ano) ?? null;
    const necessarios = new Set<number>();
    for (const ano of anos) {
      necessarios.add(ano);
      const c = doAno(ano);
      if (!c) for (const a of janelaDeReferencia(ano, configuracao.receita)) necessarios.add(a);
    }
    const [base, est] = await Promise.all([
      this.consolidado.carregar(sys, grupo, [...necessarios], territorio.nivel !== 'MUNICIPIO'),
      this.populacao.estimativas(sys.db, [{ nivel: territorio.nivel, territorioId: territorio.id }]),
    ]);
    const nomes = await this.nomesDosUsuarios(
      sys.db,
      congelados.map((c) => c.computedBy),
    );
    const montados = anos.map((ano) => this.montarAno(configuracao, doAno(ano), territorio, ano, base, est, semanaAtual, nomes));
    const { incompletas, ultimaCompleta } = semanasCompletas(semanaAtual, sys.tenant.settings.vigilancia.consolidacao.semanasIncompletas);
    const meta = this.consolidado.agregar(base, { nivel: territorio.nivel, territorioId: territorio.id, base: configuracao.receita.base, anos: base.anos });
    const avisos = [...new Set([...montados.flatMap((a) => a.avisos), ...meta.avisos])];
    return { configuracao, anos: montados, base, semanaAtual, incompletas, ultimaCompleta, semSemanaSintomas: meta.semSemanaSintomas, bairrosSemCorrespondencia: meta.bairrosSemCorrespondencia, avisos };
  }

  /**
   * Um ano: série de cada ano de referência com a população daquele ano (mesma fonte e versão em todos), canal pela
   * receita (ou o congelado, com a receita e a fonte com que foi congelado) e curva observada na mesma unidade.
   */
  private montarAno(
    config: ConfiguracaoDiagrama,
    congelado: CanalGravado | null,
    territorio: TerritorioRef,
    ano: number,
    base: BaseConsolidada,
    est: EstimativaBase[],
    semanaAtual: string,
    nomes: Map<string, string> | null,
  ): AnoMontado {
    const receita = congelado ? receitaGravada(congelado.recipe) : config.receita;
    const referencia = congelado ? [...congelado.referenceYears] : janelaDeReferencia(ano, receita);
    const t = { nivel: territorio.nivel, territorioId: territorio.id };
    const anosPop = [...new Set([...referencia, ano])];
    const pedida = congelado ? { fonte: congelado.populationSource, versao: congelado.populationVersion } : { fonte: config.fontePopulacao, versao: config.versaoPopulacao };
    const fonte = escolherFonte(est, t, anosPop, pedida);
    const populacao = populacaoUsada(est, t, anosPop, fonte, ano);
    const popDe = (y: number) => populacao.find((p) => p.ano === y)?.populacao ?? null;
    const casos = this.consolidado.agregar(base, { ...t, base: receita.base, anos: anosPop });
    const doAnalise = receita.anoEmAnaliseTodosNotificados ? this.consolidado.agregar(base, { ...t, base: 'NOTIFICADOS', anos: [ano] }) : casos;
    const serieAnalise: SerieAnual = { ano, semanas: semAsFuturas(doAnalise.porAno.get(ano), ano, semanaAtual), populacao: popDe(ano) };
    let canal: CanalCalculado;
    if (congelado) canal = canalDoCongelado(congelado);
    else {
      const series: SerieAnual[] = referencia.filter((y) => y !== ano).map((y) => ({ ano: y, semanas: semAsFuturas(casos.porAno.get(y), y, semanaAtual), populacao: popDe(y) }));
      // Com o ano em análise na referência (Tabela 1 da NT 1/2023), entra a série dele na base da receita.
      if (receita.incluiAnoEmAnalise) series.push({ ano, semanas: semAsFuturas(casos.porAno.get(ano), ano, semanaAtual), populacao: popDe(ano) });
      canal = calcularCanal(
        series,
        ano,
        receita,
        config.anosExcluidos.map((a) => a.ano),
      );
    }
    const avisos = [...canal.avisos];
    if (receita.unidade === 'INCIDENCIA') {
      avisos.push(...avisosDaPopulacao(populacao, ano));
      if (!pedida.fonte && fonte)
        avisos.push(`Fonte da população escolhida pelo sistema: ${ROTULO_FONTE_POPULACAO[fonte.fonte]}${fonte.versao ? `, versão ${fonte.versao}` : ''}. Defina a fonte na configuração do agravo.`);
    }
    if (congelado) {
      const excluidosDepois = config.anosExcluidos.filter((a) => congelado.referenceYears.includes(a.ano)).map((a) => a.ano);
      if (excluidosDepois.length) avisos.push(`Canal congelado com ${excluidosDepois.join(', ')} na referência, anos excluídos depois: congele de novo para aplicar.`);
      // A série de população é revista todo ano (RIPSA): o canal congelado guarda a que usou.
      const mudaram = receita.unidade === 'INCIDENCIA' ? (canal.semanas[0]?.valores ?? []).filter((v) => v.populacao !== popDe(v.ano)).map((v) => v.ano) : [];
      if (mudaram.length) avisos.push(`A população de ${mudaram.join(', ')} mudou depois do congelamento: o canal congelado segue com a antiga (congele de novo para usar a atual).`);
    }
    return {
      ano,
      canal,
      congelado: congelado
        ? {
            id: congelado.id,
            versao: congelado.version,
            calculadoEm: congelado.computedAt.toISOString(),
            calculadoPor: nomes?.get(congelado.computedBy) ?? null,
            nota: congelado.notes,
            fontePopulacao: congelado.populationSource,
            versaoPopulacao: congelado.populationVersion,
          }
        : null,
      observado: curvaObservada(serieAnalise, receita),
      populacao,
      populacaoDoAno: popDe(ano),
      fonte,
      avisos,
    };
  }

  /**
   * Status de cada SE do ano em análise no canal do território, de SE 1 até a semana atual (ou até o fim do ano, se ele
   * já acabou), com a marca de semana completa. Para os critérios do plano de contingência.
   */
  statusDasSemanas(a: AnoMontado, semanaAtual: string, incompletas: string[]): { semana: string; status: StatusSemana; completa: boolean }[] {
    const atualAno = Number(semanaAtual.slice(0, 4));
    const ultima = a.ano < atualAno ? semanasNoAno(a.ano) : a.ano === atualAno ? Number(semanaAtual.slice(4)) : 0;
    const abertas = new Set(incompletas);
    return Array.from({ length: ultima }, (_, i) => {
      const codigo = `${a.ano}${pad(i + 1)}`;
      return { semana: codigo, status: statusDaSemana(a.observado[i]?.valor ?? null, semanaDoCanal(a.canal, i + 1)), completa: !abertas.has(codigo) && codigo <= semanaAtual };
    });
  }

  // ───────────── apoio ─────────────

  /** Receita gravada do agravo; sem gravação, a do modelo MS 2025 (`padrao: true`). */
  async configuracaoDe(db: Db, grupo: string): Promise<ConfiguracaoDiagrama> {
    const row = await db.diagramSetting.findUnique({ where: { groupKey: grupo } });
    if (!row)
      return {
        grupo,
        modelo: MODELO_PADRAO,
        receita: { ...RECEITAS_MODELO[MODELO_PADRAO].receita },
        anosExcluidos: [],
        fontePopulacao: null,
        versaoPopulacao: null,
        atualizadoEm: null,
        atualizadoPor: null,
        padrao: true,
      };
    const receita = receitaGravada(row.recipe);
    const nomes = row.updatedBy ? await this.nomesDosUsuarios(db, [row.updatedBy]) : new Map<string, string>();
    return {
      grupo,
      modelo: modeloDaReceita(receita),
      receita,
      anosExcluidos: Array.isArray(row.excludedYears) ? (row.excludedYears as unknown as AnoExcluido[]) : [],
      fontePopulacao: row.populationSource,
      versaoPopulacao: row.populationVersion,
      atualizadoEm: row.updatedAt.toISOString(),
      atualizadoPor: row.updatedBy ? (nomes.get(row.updatedBy) ?? null) : null,
      padrao: false,
    };
  }

  /** Território dos filtros: o município (sem id), uma localidade ou um bairro. */
  async territorio(db: Db, nivel: NivelTerritorio, id: string | null): Promise<TerritorioRef> {
    if (nivel === 'MUNICIPIO') {
      if (id) throw new DomainError('TERRITORIO_INVALIDO', 'No nível do município não se informa território', HttpStatus.BAD_REQUEST);
      return { nivel, id: null, nome: 'Município' };
    }
    if (!id) throw new DomainError('TERRITORIO_INVALIDO', `Informe ${nivel === 'BAIRRO' ? 'o bairro' : 'a localidade'}`, HttpStatus.BAD_REQUEST);
    const t = nivel === 'BAIRRO' ? await db.neighborhood.findUnique({ where: { id }, select: { id: true, name: true } }) : await db.locality.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!t) throw notFound(nivel === 'BAIRRO' ? 'Bairro' : 'Localidade');
    return { nivel, id: t.id, nome: t.name };
  }

  /** Nome do agravo pelo catálogo do tenant (a linha de casos do grupo); grupo fora do catálogo: 404. */
  async nomeDoAgravo(sys: SystemContext, grupo: string): Promise<string> {
    // O catálogo nacional é gravado no banco do tenant na primeira consulta à vigilância.
    await this.catalogo.garantir(sys);
    const linhas = await sys.db.notifiableCondition.findMany({ where: { groupKey: grupo }, select: { key: true, name: true, context: true }, take: 50 });
    const l = linhas.find((x) => x.key === grupo) ?? linhas.find((x) => x.context === 'CASO') ?? linhas[0];
    if (!l) throw notFound('Agravo do catálogo');
    return l.name.replace(/\s+-\s+Casos$/i, '');
  }

  private validarAno(sys: SystemContext, ano: number) {
    const atual = semanaEpidemiologica(this.agora(), sys.tenant.timeZone).ano;
    if (ano < ANO_MINIMO || ano > atual + 1) throw new DomainError('ANO_INVALIDO', `Ano fora do intervalo (${ANO_MINIMO} a ${atual + 1})`, HttpStatus.BAD_REQUEST);
  }

  private async nomesDosUsuarios(db: Db, ids: string[]): Promise<Map<string, string>> {
    const unicos = [...new Set(ids.filter(Boolean))];
    if (!unicos.length) return new Map();
    const us = await db.user.findMany({ where: { id: { in: unicos } }, select: { id: true, name: true, socialName: true } });
    return new Map(us.map((u) => [u.id, u.socialName ?? u.name]));
  }
}
