import { HttpStatus, Injectable } from '@nestjs/common';
import type { TenantPrisma } from '@omnisaude/database';
import { ROTULO_FONTE_POPULACAO, type CorpoPopulacao, type FontePopulacao, type ListaPopulacao, type NivelTerritorio, type PopulacaoUsada, type RespostaOk, type RespostaPopulacao } from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { DomainError, notFound } from '../../core/errors';

type Db = TenantPrisma.TransactionClient;

/** Linha de population_estimates usada no cálculo. */
export interface EstimativaBase {
  year: number;
  level: NivelTerritorio;
  territoryId: string | null;
  population: number;
  source: FontePopulacao;
  version: string;
}

export interface TerritorioPopulacao {
  nivel: NivelTerritorio;
  territorioId: string | null;
}

export interface FonteEscolhida {
  fonte: FontePopulacao;
  versao: string;
}

/** Ordem de preferência quando a fonte não foi escolhida: a dos indicadores de saúde primeiro. */
const PRIORIDADE_FONTE: FontePopulacao[] = ['RIPSA', 'IBGE_DOU', 'MANUAL', 'CENSO_2022'];
const ANO_CENSO = 2022;

const doTerritorio = (e: EstimativaBase, t: TerritorioPopulacao) => e.level === t.nivel && (e.territoryId ?? null) === (t.territorioId ?? null);
const municipal: TerritorioPopulacao = { nivel: 'MUNICIPIO', territorioId: null };
/** Versões em ordem decrescente, com números comparados como números ("2025" > "2024", "v10" > "v9"). */
const versaoDecrescente = (a: string, b: string) => b.localeCompare(a, 'pt-BR', { numeric: true });

/**
 * Fonte e versão da série anual do território. Pedida pela configuração: a fonte pedida e, sem versão, a versão dela
 * que cobre mais anos. Sem pedido: o par (fonte, versão) que cobre mais anos; empate pela prioridade das fontes e pela
 * versão mais nova. Bairro e localidade sem série própria usam a do município (proporção do Censo 2022). O Censo 2022
 * de bairro e de localidade é base da proporção, não série anual.
 */
export function escolherFonte(est: EstimativaBase[], territorio: TerritorioPopulacao, anos: number[], pedida: { fonte: FontePopulacao | null; versao: string | null }): FonteEscolhida | null {
  const alvo = new Set(anos);
  const proprias = territorio.nivel === 'MUNICIPIO' ? [] : est.filter((e) => doTerritorio(e, territorio) && e.source !== 'CENSO_2022');
  const candidatas = [...proprias, ...est.filter((e) => doTerritorio(e, municipal))];
  const cobertura = new Map<string, { fonte: FontePopulacao; versao: string; anos: Set<number> }>();
  for (const e of candidatas) {
    if (pedida.fonte && e.source !== pedida.fonte) continue;
    if (pedida.fonte && pedida.versao !== null && e.version !== pedida.versao) continue;
    const k = `${e.source}|${e.version}`;
    const c = cobertura.get(k) ?? cobertura.set(k, { fonte: e.source, versao: e.version, anos: new Set() }).get(k)!;
    if (alvo.has(e.year)) c.anos.add(e.year);
  }
  const ordenadas = [...cobertura.values()].sort((a, b) => b.anos.size - a.anos.size || PRIORIDADE_FONTE.indexOf(a.fonte) - PRIORIDADE_FONTE.indexOf(b.fonte) || versaoDecrescente(a.versao, b.versao));
  if (ordenadas[0]) return { fonte: ordenadas[0].fonte, versao: ordenadas[0].versao };
  // A fonte pedida ainda não tem linha: todos os anos ficam sem população (com aviso de quem chama).
  return pedida.fonte ? { fonte: pedida.fonte, versao: pedida.versao ?? '' } : null;
}

/** Fração do território na população do município pelo Censo 2022 (mesma versão nos dois, quando houver). */
function proporcaoCenso(est: EstimativaBase[], territorio: TerritorioPopulacao): number | null {
  const doCenso = (t: TerritorioPopulacao) => est.filter((e) => e.source === 'CENSO_2022' && e.year === ANO_CENSO && doTerritorio(e, t)).sort((a, b) => versaoDecrescente(a.version, b.version));
  const t = doCenso(territorio)[0];
  const ms = doCenso(municipal);
  const m = ms.find((x) => x.version === t?.version) ?? ms[0];
  return t && m && m.population > 0 ? t.population / m.population : null;
}

/** Valor da fonte e versão no ano, ou do último ano anterior (repetido) quando `repetir`. */
function valorDoAno(est: EstimativaBase[], territorio: TerritorioPopulacao, ano: number, f: FonteEscolhida, repetir: boolean): { populacao: number; repetida: boolean } | null {
  const serie = est.filter((e) => doTerritorio(e, territorio) && e.source === f.fonte && e.version === f.versao);
  const exato = serie.find((e) => e.year === ano);
  if (exato) return { populacao: exato.population, repetida: false };
  if (!repetir) return null;
  const anterior = serie.filter((e) => e.year < ano).sort((a, b) => b.year - a.year)[0];
  return anterior ? { populacao: anterior.population, repetida: true } : null;
}

/**
 * População de cada ano, toda da mesma fonte e versão (a armadilha do VigiEPI é misturar fontes entre os anos). A
 * partir do ano em análise, ano sem estimativa usa a do último ano da mesma série (REPETIDA). Bairro e localidade sem
 * estimativa própria: estimativa do município no ano × fração do território no Censo 2022 (ESTIMADA). Ano de
 * referência sem estimativa fica sem população (AUSENTE) e sai do canal.
 */
export function populacaoUsada(est: EstimativaBase[], territorio: TerritorioPopulacao, anos: number[], f: FonteEscolhida | null, anoAnalise: number): PopulacaoUsada[] {
  const proporcao = territorio.nivel === 'MUNICIPIO' ? null : proporcaoCenso(est, territorio);
  return [...new Set(anos)]
    .sort((a, b) => a - b)
    .map((ano): PopulacaoUsada => {
      if (!f) return { ano, populacao: null, fonte: null, versao: null, origem: 'AUSENTE' };
      const repetir = ano >= anoAnalise;
      const proprio = valorDoAno(est, territorio, ano, f, repetir && territorio.nivel === 'MUNICIPIO');
      const base = { ano, fonte: f.fonte, versao: f.versao };
      if (proprio) return { ...base, populacao: proprio.populacao, origem: proprio.repetida ? 'REPETIDA' : 'OFICIAL' };
      if (territorio.nivel !== 'MUNICIPIO') {
        // Série própria do território (rara): repete a última antes de cair na proporção do município.
        const repetidaPropria = repetir ? valorDoAno(est, territorio, ano, f, true) : null;
        if (repetidaPropria) return { ...base, populacao: repetidaPropria.populacao, origem: 'REPETIDA' };
        const doMunicipio = valorDoAno(est, municipal, ano, f, repetir);
        if (doMunicipio && proporcao !== null) return { ...base, populacao: Math.max(1, Math.round(doMunicipio.populacao * proporcao)), origem: 'ESTIMADA' };
      }
      return { ...base, populacao: null, origem: 'AUSENTE' };
    });
}

/** Avisos da população usada (anos repetidos, estimados e ausentes), para a tela e o CSV. */
export function avisosDaPopulacao(linhas: PopulacaoUsada[], anoAnalise: number): string[] {
  const avisos: string[] = [];
  const anos = (o: PopulacaoUsada['origem']) => linhas.filter((l) => l.origem === o).map((l) => l.ano);
  const fonte = linhas.find((l) => l.fonte)?.fonte;
  const versao = linhas.find((l) => l.fonte)?.versao;
  const nomeFonte = fonte ? `${ROTULO_FONTE_POPULACAO[fonte]}${versao ? `, versão ${versao}` : ''}` : null;
  if (!nomeFonte) return ['Sem estimativa de população: cadastre a população do município (ou use a receita em número de casos).'];
  const repetidas = anos('REPETIDA');
  if (repetidas.length) avisos.push(`População repetida do último ano disponível (${nomeFonte}) em ${repetidas.join(', ')}.`);
  const estimadas = anos('ESTIMADA');
  if (estimadas.length) avisos.push(`População estimada pela proporção do Censo 2022 sobre a estimativa do município em ${estimadas.join(', ')}.`);
  const ausentes = anos('AUSENTE');
  const ausentesReferencia = ausentes.filter((a) => a < anoAnalise);
  if (ausentesReferencia.length) avisos.push(`Sem população de ${nomeFonte} em ${ausentesReferencia.join(', ')}: esses anos ficam fora do canal na incidência.`);
  if (ausentes.some((a) => a >= anoAnalise)) avisos.push(`Sem população de ${nomeFonte} no ano em análise: a curva observada fica sem incidência.`);
  return avisos;
}

/** "Município", o nome da localidade ou o do bairro. */
async function nomesDosTerritorios(db: Db, linhas: { level: NivelTerritorio; territoryId: string | null }[]): Promise<Map<string, string>> {
  const ids = (n: NivelTerritorio) => [...new Set(linhas.filter((l) => l.level === n && l.territoryId).map((l) => l.territoryId!))];
  const [locs, bairros] = await Promise.all([
    ids('LOCALIDADE').length ? db.locality.findMany({ where: { id: { in: ids('LOCALIDADE') } }, select: { id: true, name: true } }) : [],
    ids('BAIRRO').length ? db.neighborhood.findMany({ where: { id: { in: ids('BAIRRO') } }, select: { id: true, name: true } }) : [],
  ]);
  return new Map([...locs, ...bairros].map((t) => [t.id, t.name]));
}

const chave = (l: { year: number; level: string; territoryId: string | null; source: string; version: string }) => `${l.year}|${l.level}|${l.territoryId ?? ''}|${l.source}|${l.version}`;

/**
 * População por território, ano, fonte e versão (VIG-1c, §4.2; frente F3). A incidência de cada ano usa a população
 * daquele ano, da mesma fonte e versão em todos os anos. Ano em análise sem estimativa: a última da mesma fonte
 * (REPETIDA). Bairro ou localidade sem estimativa anual: proporção do Censo 2022 × estimativa do município (ESTIMADA).
 */
@Injectable()
export class PopulacaoService {
  constructor(private readonly audit: AuditService) {}

  /** GET /vigilancia/populacao?nivel=&territorio=. */
  async listar(ctx: RequestContext, consulta: { nivel?: NivelTerritorio; territorio?: string }): Promise<ListaPopulacao> {
    const linhas = await ctx.db.populationEstimate.findMany({
      where: { ...(consulta.nivel ? { level: consulta.nivel } : {}), ...(consulta.territorio ? { territoryId: consulta.territorio } : {}) },
      orderBy: [{ level: 'asc' }, { territoryId: 'asc' }, { source: 'asc' }, { version: 'asc' }, { year: 'asc' }],
    });
    const nomes = await nomesDosTerritorios(ctx.db, linhas);
    return linhas.map((l) => ({
      id: l.id,
      ano: l.year,
      nivel: l.level,
      territorioId: l.territoryId,
      territorioNome: l.territoryId ? (nomes.get(l.territoryId) ?? 'Território removido') : 'Município',
      populacao: l.population,
      fonte: l.source,
      versao: l.version,
      nota: l.notes,
      atualizadoEm: l.updatedAt.toISOString(),
    }));
  }

  /** PUT /vigilancia/populacao: grava o lote (atualiza a linha da mesma chave: ano, território, fonte e versão). */
  async salvar(ctx: RequestContext, corpo: CorpoPopulacao): Promise<RespostaPopulacao> {
    const linhas = corpo.linhas.map((l) => ({
      year: l.ano,
      level: l.nivel,
      territoryId: l.territorioId ?? null,
      population: l.populacao,
      source: l.fonte,
      version: (l.versao ?? '').trim(),
      notes: l.nota?.trim() || null,
    }));
    const erros: string[] = [];
    const vistas = new Set<string>();
    for (const [i, l] of linhas.entries()) {
      const onde = `Linha ${i + 1} (${l.year})`;
      if ((l.level === 'MUNICIPIO') !== (l.territoryId === null)) erros.push(`${onde}: ${l.level === 'MUNICIPIO' ? 'o município não tem território' : 'informe a localidade ou o bairro'}`);
      if (l.source === 'CENSO_2022' && l.year !== ANO_CENSO) erros.push(`${onde}: o Censo 2022 só vale para o ano de 2022`);
      const k = chave(l);
      if (vistas.has(k)) erros.push(`${onde}: repetida no lote (mesmo ano, território, fonte e versão)`);
      vistas.add(k);
    }
    const ids = (n: NivelTerritorio) => [...new Set(linhas.filter((l) => l.level === n && l.territoryId).map((l) => l.territoryId!))];
    const [locs, bairros] = await Promise.all([
      ctx.db.locality.findMany({ where: { id: { in: ids('LOCALIDADE') } }, select: { id: true } }),
      ctx.db.neighborhood.findMany({ where: { id: { in: ids('BAIRRO') } }, select: { id: true } }),
    ]);
    const existentes = new Set([...locs, ...bairros].map((t) => t.id));
    for (const id of [...ids('LOCALIDADE'), ...ids('BAIRRO')]) if (!existentes.has(id)) erros.push(`Território não encontrado: ${id}`);
    if (erros.length) throw new DomainError('POPULACAO_INVALIDA', erros[0]!, HttpStatus.BAD_REQUEST, erros);

    return ctx.db.$transaction(async (tx) => {
      const atuais = await tx.populationEstimate.findMany({ where: { year: { in: [...new Set(linhas.map((l) => l.year))] }, source: { in: [...new Set(linhas.map((l) => l.source))] } } });
      const porChave = new Map(atuais.map((a) => [chave(a), a]));
      let criadas = 0;
      let atualizadas = 0;
      for (const l of linhas) {
        const atual = porChave.get(chave(l));
        if (atual) {
          if (atual.population !== l.population || atual.notes !== l.notes) {
            await tx.populationEstimate.update({ where: { id: atual.id }, data: { population: l.population, notes: l.notes } });
            atualizadas++;
          }
        } else {
          await tx.populationEstimate.create({ data: { ...l, createdBy: ctx.session.userId } });
          criadas++;
        }
      }
      await this.audit.record(ctx, tx, {
        action: 'vigilancia.populacao_gravada',
        entityType: 'PopulationEstimate',
        payload: { criadas, atualizadas, linhas: linhas.map((l) => ({ ano: l.year, nivel: l.level, territorioId: l.territoryId, fonte: l.source, versao: l.version, populacao: l.population })) },
      });
      return { criadas, atualizadas };
    });
  }

  /** DELETE /vigilancia/populacao/:id. */
  async remover(ctx: RequestContext, id: string): Promise<RespostaOk> {
    return ctx.db.$transaction(async (tx) => {
      const atual = await tx.populationEstimate.findUnique({ where: { id } });
      if (!atual) throw notFound('Estimativa de população');
      await tx.populationEstimate.delete({ where: { id } });
      await this.audit.record(ctx, tx, {
        action: 'vigilancia.populacao_removida',
        entityType: 'PopulationEstimate',
        entityId: id,
        payload: { ano: atual.year, nivel: atual.level, territorioId: atual.territoryId, fonte: atual.source, versao: atual.version, populacao: atual.population },
      });
      return { ok: true as const };
    });
  }

  /** Estimativas do município e do território (com o Censo 2022 da proporção), para o cálculo em memória. */
  async estimativas(db: Db, territorios: TerritorioPopulacao[] = []): Promise<EstimativaBase[]> {
    const ids = [...new Set(territorios.map((t) => t.territorioId).filter((x): x is string => !!x))];
    const linhas = await db.populationEstimate.findMany({
      where: { OR: [{ level: 'MUNICIPIO' }, ...(ids.length ? [{ territoryId: { in: ids } }] : [])] },
      select: { year: true, level: true, territoryId: true, population: true, source: true, version: true },
    });
    return linhas;
  }

  /** População usada em cada ano do canal (mesma fonte e versão). */
  async populacaoDosAnos(
    db: TenantPrisma.TransactionClient,
    territorio: { nivel: NivelTerritorio; territorioId: string | null },
    anos: number[],
    fonte: { fonte: FontePopulacao | null; versao: string | null },
    anoAnalise: number,
  ): Promise<PopulacaoUsada[]> {
    const est = await this.estimativas(db, [territorio]);
    return populacaoUsada(est, territorio, anos, escolherFonte(est, territorio, anos, fonte), anoAnalise);
  }
}
