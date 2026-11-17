import { Inject, Injectable } from '@nestjs/common';
import { TenantPrisma, type MasterClient } from '@omnisaude/database';
import {
  faixasDeSemanas,
  infoAgravoSinan,
  inicioAnoEpidemiologico,
  intervaloDaSemana,
  normalizarNome,
  semanaDaData,
  semanaEpidemiologica,
  semanasNoAno,
  situacaoOmni,
  type ArquivoDetectado,
  type CoberturaAno,
  type GravidadeCaso,
  type NivelTerritorio,
  type ReceitaCanal,
  type SituacaoCaso,
} from '@omnisaude/shared';
import { MASTER_DB } from '../../core/database';
import type { SystemContext } from '../integrations/messaging.service';
import { LocalizadorService, PRECISAO_LIGA_QUARTEIRAO } from '../territorio/localizador.service';
import { arquivoCobre, cnesDoArquivo, gruposDoMesmoAgravo, periodoCoberto, primeirosEnvios } from './cobertura-importacao';
import { MapaCasosService } from './mapa.service';

/** Consulta da base consolidada. */
export interface ConsultaCasosPorSemana {
  grupo: string;
  nivel: NivelTerritorio;
  /** null no município. */
  territorioId: string | null;
  anos: number[];
  base: ReceitaCanal['base'];
}

export interface CasosPorSemana {
  /** Casos por ano epidemiológico: índice 0 = SE 1 … 52 = SE 53; null = sem cobertura (o ano todo, se não houver), diferente de 0. */
  porAno: Map<number, (number | null)[]>;
  cobertura: CoberturaAno[];
  /** Casos sem SE de início dos sintomas (contados pela SE da notificação). */
  semSemanaSintomas: number;
  /** Nomes de bairro dos registros oficiais sem correspondência no território. */
  bairrosSemCorrespondencia: number;
  avisos: string[];
}

/** Indicadores do agravo no ano epidemiológico, até a semana de referência (para a contingência). */
export interface IndicadoresConsolidados {
  provaveis: number;
  graves: number;
  sinaisAlarme: number;
  obitosAgravo: number;
  obitosInvestigacao: number;
}

/** Casos iguais em tudo o que a agregação usa (o registro oficial vem agrupado do banco; a notificação, um a um). */
export interface LinhaCasos {
  origem: 'OFICIAL' | 'OMNISAUDE';
  ano: number;
  semana: number;
  /** Sem SE de início dos sintomas: contado pela SE da notificação. */
  pelaNotificacao: boolean;
  situacao: SituacaoCaso;
  gravidade: GravidadeCaso | null;
  obito: 'AGRAVO' | 'INVESTIGACAO' | null;
  /** Residência no município do tenant; null = desconhecida (registro oficial sem município de residência). */
  noMunicipio: boolean | null;
  bairroId: string | null;
  localidadeId: string | null;
  /** Nome de bairro sem correspondência no território (normalizado). */
  bairroSemCorrespondencia: string | null;
  n: number;
}

/** Base consolidada de um agravo, carregada uma vez e agregada por território e base de casos. */
export interface BaseConsolidada {
  grupo: string;
  anos: number[];
  linhas: LinhaCasos[];
  cobertura: CoberturaAno[];
  /** SE cobertas de cada ano (índice 0 = SE 1 … 52 = SE 53). SE sem cobertura fica null, diferente de 0. */
  semanasCobertas: Map<number, boolean[]>;
  /** As linhas trazem bairro e localidade (consulta por território). */
  territorial: boolean;
}

export interface FiltroAgregacao {
  nivel: NivelTerritorio;
  territorioId: string | null;
  base: ReceitaCanal['base'];
  anos: number[];
}

type Territorio = { bairroId: string | null; localidadeId: string | null; semCorrespondencia: string | null };
type Db = TenantPrisma.TransactionClient;
const { sql } = TenantPrisma;

const semZeros = (s: string | null | undefined) => (s ?? '').trim().replace(/^0+(?=\d)/, '');
const pad = (n: number) => String(n).padStart(2, '0');
const ss = (codigo: string) => `${codigo.slice(4)}/${codigo.slice(0, 4)}`;
/** Código de classificação ou evolução sem espaço nem zero à esquerda ('02' e ' 2' viram '2'). */
const codigo = (v: string | null | undefined) => {
  const t = (v ?? '').trim();
  return /^\d+$/.test(t) ? String(Number(t)) : t;
};
const SEMANA = /^(\d{4})(\d{2})$/;
/** Último dia (sábado) do ano epidemiológico. */
const fimDoAno = (ano: number) => new Date(inicioAnoEpidemiologico(ano + 1) - 86_400_000).toISOString().slice(0, 10);
const inicioDoAno = (ano: number) => new Date(inicioAnoEpidemiologico(ano)).toISOString().slice(0, 10);

function anoESemana(codigoSemana: string | null): { ano: number; semana: number } | null {
  const m = SEMANA.exec(codigoSemana ?? '');
  if (!m) return null;
  const ano = Number(m[1]);
  const semana = Number(m[2]);
  return semana >= 1 && semana <= semanasNoAno(ano) ? { ano, semana } : null;
}

/** Óbito pelo agravo ou em investigação pela EVOLUCAO do registro oficial (o código muda de agravo para agravo). */
function obitoOficial(agravo: string | null, evolucao: string | null): LinhaCasos['obito'] {
  const e = codigo(evolucao);
  if (!e) return null;
  const info = infoAgravoSinan(agravo);
  if ((info?.obitoAgravo ?? ['2']).includes(e)) return 'AGRAVO';
  if ((info?.obitoInvestigacao ?? []).includes(e)) return 'INVESTIGACAO';
  return null;
}

/**
 * Base consolidada sem dupla contagem (VIG-1c, §4.2; frente F3): registros oficiais INDIVIDUAL não excluídos e não
 * ausentes + notificações do OmniSaúde NOTIFICADA/ENCERRADA, não descartadas, sem vínculo com registro oficial (o par
 * vinculado conta uma vez, pelo registro oficial: no grupo da notificação quando os dois são do mesmo agravo do Sinan,
 * senão no grupo do registro). Semana = SE de início dos sintomas; sem ela, a da notificação
 * (contada à parte, como aviso). A notificação do óbito ligada ao caso (linha de óbito do catálogo) não é outro caso:
 * só diz se houve óbito. Território: o município pela residência; bairro e localidade pelo código ou pelo nome/apelido
 * do bairro (registro oficial) e pelo quarteirão da residência (notificação; sem quarteirão, o bairro da ficha).
 */
@Injectable()
export class ConsolidadoService {
  private readonly municipios = new Map<string, string>();

  constructor(
    private readonly mapa: MapaCasosService,
    private readonly localizador: LocalizadorService,
    @Inject(MASTER_DB) private readonly master: MasterClient,
  ) {}

  /** IBGE do município do tenant com 6 dígitos (como o Sinan compara). */
  async municipio(sys: SystemContext): Promise<string> {
    const cache = this.municipios.get(sys.tenant.id);
    if (cache) return cache;
    const t = await this.master.tenant.findUniqueOrThrow({ where: { id: sys.tenant.id }, select: { ibgeCode: true } });
    const ibge = t.ibgeCode.replace(/\D/g, '').slice(0, 6);
    this.municipios.set(sys.tenant.id, ibge);
    return ibge;
  }

  async casosPorSemana(sys: SystemContext, consulta: ConsultaCasosPorSemana): Promise<CasosPorSemana> {
    const base = await this.carregar(sys, consulta.grupo, consulta.anos, consulta.nivel !== 'MUNICIPIO');
    return this.agregar(base, consulta);
  }

  /** `ateSemana` em AAAASS; sem `territorio`, o município. */
  async indicadores(sys: SystemContext, grupo: string, ano: number, ateSemana: string, territorio?: { nivel: NivelTerritorio; territorioId: string | null }): Promise<IndicadoresConsolidados> {
    const t = territorio ?? { nivel: 'MUNICIPIO' as const, territorioId: null };
    const base = await this.carregar(sys, grupo, [ano], t.nivel !== 'MUNICIPIO');
    return this.indicadoresDaBase(base, t, ano, ateSemana);
  }

  /** Indicadores sobre uma base já carregada: casos prováveis do ano até a semana, com gravidade e óbitos. */
  indicadoresDaBase(base: BaseConsolidada, territorio: { nivel: NivelTerritorio; territorioId: string | null }, ano: number, ateSemana: string): IndicadoresConsolidados {
    const r: IndicadoresConsolidados = { provaveis: 0, graves: 0, sinaisAlarme: 0, obitosAgravo: 0, obitosInvestigacao: 0 };
    for (const l of base.linhas) {
      if (l.ano !== ano || `${l.ano}${String(l.semana).padStart(2, '0')}` > ateSemana) continue;
      if (l.situacao === 'DESCARTADO' || !this.noTerritorio(l, territorio.nivel, territorio.territorioId)) continue;
      r.provaveis += l.n;
      if (l.gravidade === 'GRAVE') r.graves += l.n;
      if (l.gravidade === 'SINAIS_ALARME') r.sinaisAlarme += l.n;
      if (l.obito === 'AGRAVO') r.obitosAgravo += l.n;
      if (l.obito === 'INVESTIGACAO') r.obitosInvestigacao += l.n;
    }
    return r;
  }

  private noTerritorio(l: LinhaCasos, nivel: NivelTerritorio, territorioId: string | null): boolean {
    if (l.noMunicipio !== true) return false;
    if (nivel === 'BAIRRO') return l.bairroId === territorioId;
    if (nivel === 'LOCALIDADE') return l.localidadeId === territorioId;
    return true;
  }

  /** Casos por semana do território e da base pedida, nos anos pedidos (SE sem cobertura: null; coberta sem caso: 0). */
  agregar(base: BaseConsolidada, filtro: FiltroAgregacao): CasosPorSemana {
    const porAno = new Map<number, (number | null)[]>();
    for (const ano of new Set(filtro.anos)) {
      const total = semanasNoAno(ano);
      const cobertas = base.semanasCobertas.get(ano);
      porAno.set(
        ano,
        Array.from({ length: 53 }, (_, i) => (i < total && cobertas?.[i] ? 0 : null)),
      );
    }
    let semSemanaSintomas = 0;
    let semMunicipio = 0;
    let semBairro = 0;
    const nomesSemCorrespondencia = new Set<string>();
    for (const l of base.linhas) {
      const semanas = porAno.get(l.ano);
      if (!semanas || semanas[l.semana - 1] === null) continue;
      if (filtro.base === 'PROVAVEIS' && l.situacao === 'DESCARTADO') continue;
      if (filtro.base === 'CONFIRMADOS' && l.situacao !== 'CONFIRMADO') continue;
      if (l.noMunicipio === null) {
        semMunicipio += l.n;
        continue;
      }
      if (filtro.nivel !== 'MUNICIPIO' && l.noMunicipio && !l.bairroId && !l.localidadeId) {
        semBairro += l.n;
        if (l.bairroSemCorrespondencia) nomesSemCorrespondencia.add(l.bairroSemCorrespondencia);
      }
      if (!this.noTerritorio(l, filtro.nivel, filtro.territorioId)) continue;
      semanas[l.semana - 1] = (semanas[l.semana - 1] ?? 0) + l.n;
      if (l.pelaNotificacao) semSemanaSintomas += l.n;
    }
    const avisos: string[] = [];
    if (semSemanaSintomas) avisos.push(`${semSemanaSintomas} caso(s) sem data de início dos sintomas: contados pela semana da notificação.`);
    if (semMunicipio) avisos.push(`${semMunicipio} registro(s) oficial(is) sem município de residência ficaram fora.`);
    if (semBairro)
      avisos.push(
        `${semBairro} caso(s) do município sem bairro identificado${nomesSemCorrespondencia.size ? ` (${nomesSemCorrespondencia.size} nome(s) de bairro sem correspondência: cadastre os apelidos na conciliação)` : ''}.`,
      );
    return {
      porAno,
      cobertura: base.cobertura.filter((c) => porAno.has(c.ano)),
      semSemanaSintomas,
      bairrosSemCorrespondencia: filtro.nivel === 'MUNICIPIO' ? 0 : nomesSemCorrespondencia.size,
      avisos,
    };
  }

  /**
   * Carrega os casos do agravo nos anos (todas as bases e territórios), com a cobertura de cada ano. `territorial`
   * resolve o bairro e a localidade de cada caso (o município não precisa).
   */
  async carregar(sys: SystemContext, grupo: string, anos: number[], territorial: boolean): Promise<BaseConsolidada> {
    const lista = [...new Set(anos)].sort((a, b) => a - b);
    if (!lista.length) return { grupo, anos: [], linhas: [], cobertura: [], semanasCobertas: new Map(), territorial };
    const de = `${lista[0]}01`;
    const ate = `${lista[lista.length - 1]}53`;
    const municipio = await this.municipio(sys);
    const resolver = territorial ? await this.resolvedorDeBairro(sys) : null;
    const linhas = [...(await this.oficiais(sys, grupo, de, ate, lista, municipio, resolver)), ...(await this.doOmniSaude(sys, grupo, de, ate, lista, resolver))].filter((l) => lista.includes(l.ano));
    const { cobertura, semanas } = await this.cobertura(sys, grupo, lista, linhas);
    return { grupo, anos: lista, linhas, cobertura, semanasCobertas: semanas, territorial };
  }

  /** Aviso do ano coberto só em parte (para o canal que usa o ano na referência); null quando o ano está todo coberto ou sem cobertura. */
  avisoCoberturaParcial(base: BaseConsolidada, ano: number): string | null {
    const marcas = base.semanasCobertas.get(ano);
    if (!marcas || !base.cobertura.find((c) => c.ano === ano)?.parcial) return null;
    return `Ano ${ano} coberto só nas SE ${faixasDeSemanas(marcas.flatMap((m, i) => (m ? [i + 1] : [])))}: as SE sem base importada nem OmniSaúde em uso ficam fora do canal.`;
  }

  /**
   * Registros oficiais agrupados no banco (o volume do Sinan pede agregação: dengue passa de dezenas de milhares). O
   * registro ligado a uma notificação conta no grupo dela quando os dois grupos são do mesmo agravo do Sinan
   * (`gruposDoMesmoAgravo`: o Y09 ligado à violência sexual ou à tentativa de suicídio fica na série dela, e não na da
   * violência interpessoal); nos demais casos, no grupo do registro, que é a verdade oficial (a dengue reclassificada
   * como chikungunya conta em chikungunya).
   */
  private async oficiais(sys: SystemContext, grupo: string, de: string, ate: string, anos: number[], municipio: string, resolver: ((codigo: string | null, nome: string | null) => Territorio) | null) {
    const familia = gruposDoMesmoAgravo(grupo);
    // O registro só entra na série de um grupo da própria família; dentro dela, vale o grupo da notificação ligada.
    const doGrupo = sql`r.group_key = ANY(${familia}::text[]) AND (CASE WHEN n.group_key = ANY(${familia}::text[]) THEN n.group_key ELSE r.group_key END) = ${grupo}`;
    const grupos = await sys.db.$queryRaw<
      {
        semana: string;
        pelaNotificacao: boolean;
        situacao: string;
        gravidade: string | null;
        evolucao: string | null;
        agravo: string | null;
        residencia: string | null;
        bairroCodigo: string | null;
        bairroNome: string | null;
        n: number;
      }[]
    >`
      SELECT COALESCE(r.epi_week_onset, r.epi_week_notified) AS semana, (r.epi_week_onset IS NULL) AS "pelaNotificacao", r.situation AS situacao,
             r.severity AS gravidade, r.evolution AS evolucao, r.agravo, left(r.residence_ibge, 6) AS residencia,
             r.neighborhood_code AS "bairroCodigo", r.neighborhood_name AS "bairroNome", count(*)::int AS n
      FROM official_records r LEFT JOIN notifications n ON n.id = r.notification_id
      WHERE r.type = 'INDIVIDUAL' AND ${doGrupo} AND NOT r.excluded AND r.absent_since IS NULL
        AND COALESCE(r.epi_week_onset, r.epi_week_notified) BETWEEN ${de} AND ${ate}
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9`;
    // Sem semana nenhuma (raro): a SE pela data da notificação (a mesma regra do grupo).
    const soData = await sys.db.$queryRaw<
      { dia: string; situacao: string; gravidade: string | null; evolucao: string | null; agravo: string | null; residencia: string | null; bairroCodigo: string | null; bairroNome: string | null }[]
    >`
      SELECT r.notified_on::text AS dia, r.situation AS situacao, r.severity AS gravidade, r.evolution AS evolucao, r.agravo, left(r.residence_ibge, 6) AS residencia,
             r.neighborhood_code AS "bairroCodigo", r.neighborhood_name AS "bairroNome"
      FROM official_records r LEFT JOIN notifications n ON n.id = r.notification_id
      WHERE r.type = 'INDIVIDUAL' AND ${doGrupo} AND NOT r.excluded AND r.absent_since IS NULL AND r.epi_week_onset IS NULL AND r.epi_week_notified IS NULL
        AND r.notified_on BETWEEN ${inicioDoAno(anos[0]!)}::date AND ${fimDoAno(anos[anos.length - 1]!)}::date`;
    const todas = [
      ...grupos,
      ...soData.map((r) => ({
        semana: semanaDaData(r.dia).codigo,
        pelaNotificacao: true,
        situacao: r.situacao,
        gravidade: r.gravidade,
        evolucao: r.evolucao,
        agravo: r.agravo,
        residencia: r.residencia || null,
        bairroCodigo: r.bairroCodigo,
        bairroNome: r.bairroNome,
        n: 1,
      })),
    ];
    const out: LinhaCasos[] = [];
    for (const g of todas) {
      const se = anoESemana(g.semana);
      if (!se) continue;
      const noMunicipio = g.residencia ? g.residencia === municipio : null;
      const t = resolver && noMunicipio ? resolver(g.bairroCodigo, g.bairroNome) : { bairroId: null, localidadeId: null, semCorrespondencia: null };
      out.push({
        origem: 'OFICIAL',
        ...se,
        pelaNotificacao: g.pelaNotificacao,
        situacao: g.situacao as SituacaoCaso,
        gravidade: g.gravidade === 'GRAVE' || g.gravidade === 'SINAIS_ALARME' ? g.gravidade : null,
        obito: obitoOficial(g.agravo, g.evolucao),
        noMunicipio,
        bairroId: t.bairroId,
        localidadeId: t.localidadeId,
        bairroSemCorrespondencia: t.semCorrespondencia,
        n: g.n,
      });
    }
    return out;
  }

  /**
   * Notificações do OmniSaúde sem registro oficial ligado. A notificação do óbito ligada ao caso (linha de óbito) fica
   * no caso: se ela ou o caso estiverem ligados a um registro oficial, o caso já conta pelo registro.
   */
  private async doOmniSaude(sys: SystemContext, grupo: string, de: string, ate: string, anos: number[], resolver: ((codigo: string | null, nome: string | null) => Territorio) | null) {
    const inicio = new Date(inicioAnoEpidemiologico(anos[0]!));
    const fim = new Date(inicioAnoEpidemiologico(anos[anos.length - 1]! + 1));
    const ns = await sys.db.notification.findMany({
      where: {
        groupKey: grupo,
        status: { in: ['NOTIFICADA', 'ENCERRADA'] },
        OR: [{ epiWeekOnset: { gte: de, lte: ate } }, { epiWeekOnset: null, epiWeekNotified: { gte: de, lte: ate } }, { epiWeekOnset: null, epiWeekNotified: null, knownAt: { gte: inicio, lt: fim } }],
      },
      select: {
        id: true,
        status: true,
        finalClass: true,
        evolution: true,
        relatedNotificationId: true,
        epiWeekOnset: true,
        epiWeekNotified: true,
        knownAt: true,
        outOfMunicipality: true,
        patientId: true,
        residenceLat: true,
        residenceLng: true,
        residencePrecision: true,
        condition: { select: { context: true } },
        _count: { select: { officialRecords: true } },
      },
    });
    const porId = new Map(ns.map((n) => [n.id, n]));
    // Casos ligados aos óbitos e que ficaram fora da consulta (outra semana): o óbito continua sendo deles.
    const faltantes = [...new Set(ns.map((n) => n.relatedNotificationId).filter((id): id is string => !!id && !porId.has(id)))];
    // Só o caso que conta na base (notificado ou encerrado) leva o óbito; com o caso em rascunho ou descartado, o óbito é o caso.
    const forasDaConsulta = faltantes.length ? await sys.db.notification.findMany({ where: { id: { in: faltantes }, status: { in: ['NOTIFICADA', 'ENCERRADA'] } }, select: { id: true } }) : [];
    const casoExiste = (id: string | null) => !!id && (porId.has(id) || forasDaConsulta.some((x) => x.id === id));
    const doCaso = (n: (typeof ns)[number]) => (n.condition.context === 'OBITO' && casoExiste(n.relatedNotificationId) ? n.relatedNotificationId! : n.id);
    const obitosDe = new Map<string, typeof ns>();
    for (const n of ns) {
      const caso = doCaso(n);
      if (caso !== n.id) (obitosDe.get(caso) ?? obitosDe.set(caso, []).get(caso)!).push(n);
    }
    const casos = ns.filter((n) => doCaso(n) === n.id && !n._count.officialRecords && !(obitosDe.get(n.id) ?? []).some((o) => o._count.officialRecords > 0));

    const residencias = resolver
      ? await this.mapa.residencias(
          sys.db,
          casos.filter((c) => !c.outOfMunicipality),
        )
      : new Map();
    // Quarteirão da residência: o do imóvel; a posição da ficha sem quarteirão ligado é localizada na malha, em lote (um
    // número fixo de consultas, e não uma por notificação).
    const quarteiroes = new Map<string, string | null>();
    const aLocalizar: { id: string; lat: number; lng: number }[] = [];
    for (const c of casos) {
      const r = residencias.get(c.id);
      if (!r) continue;
      if (r.blockId) quarteiroes.set(c.id, r.blockId);
      else if (PRECISAO_LIGA_QUARTEIRAO.includes(r.precisao)) aLocalizar.push({ id: c.id, lat: r.lat, lng: r.lng });
      else quarteiroes.set(c.id, null);
    }
    const achados = await this.localizador.quarteiroesDosPontos(sys.db, aLocalizar);
    aLocalizar.forEach((p, i) => quarteiroes.set(p.id, achados[i]?.id ?? null));
    const idsDosBlocos = [...new Set([...quarteiroes.values()].filter((b): b is string => !!b))];
    const blocos = idsDosBlocos.length ? await sys.db.block.findMany({ where: { id: { in: idsDosBlocos } }, select: { id: true, neighborhoodId: true, localityId: true } }) : [];
    const doBloco = new Map(blocos.map((b) => [b.id, b]));
    // Sem quarteirão, o bairro escrito na ficha: só o NM_BAIRRO (texto), não a ficha inteira de cada notificação.
    const semQuarteirao = resolver ? casos.filter((c) => !c.outOfMunicipality && !doBloco.has(quarteiroes.get(c.id) ?? '')).map((c) => c.id) : [];
    const bairroDaFicha = new Map(
      semQuarteirao.length
        ? (
            await sys.db.$queryRaw<{ id: string; bairro: string | null }[]>`
              SELECT id::text AS id, CASE WHEN jsonb_typeof(form->'NM_BAIRRO') = 'string' THEN form->>'NM_BAIRRO' END AS bairro
              FROM notifications WHERE id = ANY(${semQuarteirao}::uuid[])`
          ).map((r) => [r.id, r.bairro])
        : [],
    );

    const out: LinhaCasos[] = [];
    for (const c of casos) {
      const se = anoESemana(c.epiWeekOnset) ?? anoESemana(c.epiWeekNotified) ?? anoESemana(semanaEpidemiologica(c.knownAt, sys.tenant.timeZone).codigo);
      if (!se) continue;
      const obitos = obitosDe.get(c.id) ?? [];
      const agravo = codigo(c.evolution) === '2' || obitos.some((o) => codigo(o.evolution) === '2' || (o.status === 'ENCERRADA' && codigo(o.finalClass) === '1'));
      // Óbito por confirmar: a notificação do óbito ainda aberta (o caso que é ele mesmo um óbito também).
      const emInvestigacao = !agravo && (obitos.some((o) => o.status === 'NOTIFICADA') || (c.condition.context === 'OBITO' && c.status === 'NOTIFICADA'));
      let t: Territorio = { bairroId: null, localidadeId: null, semCorrespondencia: null };
      if (resolver && !c.outOfMunicipality) {
        const bloco = doBloco.get(quarteiroes.get(c.id) ?? '');
        if (bloco) t = { bairroId: bloco.neighborhoodId, localidadeId: bloco.localityId, semCorrespondencia: null };
        else t = resolver(null, bairroDaFicha.get(c.id) ?? null);
      }
      out.push({
        origem: 'OMNISAUDE',
        ...se,
        pelaNotificacao: !anoESemana(c.epiWeekOnset),
        situacao: situacaoOmni({ status: c.status, finalClass: c.finalClass }),
        gravidade: null,
        obito: agravo ? 'AGRAVO' : emInvestigacao ? 'INVESTIGACAO' : null,
        noMunicipio: !c.outOfMunicipality,
        bairroId: t.bairroId,
        localidadeId: t.localidadeId,
        bairroSemCorrespondencia: t.semCorrespondencia,
        n: 1,
      });
    }
    return out;
  }

  /**
   * Bairro e localidade pelo código ou pelo nome/apelido (normalizados), lidos na hora: o apelido novo vale na próxima
   * consulta. Nome que casa com dois bairros é ambíguo e fica sem correspondência; sem bairro, vale o nome da
   * localidade.
   */
  private async resolvedorDeBairro(sys: SystemContext): Promise<(codigo: string | null, nome: string | null) => Territorio> {
    const [bairros, locs] = await Promise.all([
      sys.db.neighborhood.findMany({ select: { id: true, localityId: true, name: true, code: true, aliases: true, active: true } }),
      sys.db.locality.findMany({ select: { id: true, name: true } }),
    ]);
    const indice = <T>(pares: [string, T][]) => {
      const m = new Map<string, T[]>();
      for (const [k, v] of pares) if (k) (m.get(k) ?? m.set(k, []).get(k)!).push(v);
      return m;
    };
    // Bairro ativo vale mais que o inativo com o mesmo nome (o histórico fica com o inativo só se não houver outro).
    const ativosPrimeiro = [...bairros].sort((a, b) => Number(b.active) - Number(a.active));
    const porCodigo = indice(ativosPrimeiro.filter((b) => b.code).map((b) => [semZeros(b.code), b]));
    const porNome = indice(ativosPrimeiro.flatMap((b) => [b.name, ...b.aliases].map((n): [string, (typeof bairros)[number]] => [normalizarNome(n), b])));
    const locPorNome = indice(locs.map((l) => [normalizarNome(l.name), l]));
    const unico = <T extends { id: string }>(xs: T[] | undefined) => (xs && new Set(xs.map((x) => x.id)).size === 1 ? xs[0]! : null);
    const umAtivo = <T extends { id: string; active: boolean }>(xs: T[] | undefined) => unico(xs?.some((x) => x.active) ? xs.filter((x) => x.active) : xs);
    return (cod, nome) => {
      const b = (cod ? umAtivo(porCodigo.get(semZeros(cod))) : null) ?? (nome ? umAtivo(porNome.get(normalizarNome(nome))) : null);
      if (b) return { bairroId: b.id, localidadeId: b.localityId, semCorrespondencia: null };
      const l = nome ? unico(locPorNome.get(normalizarNome(nome))) : null;
      if (l) return { bairroId: null, localidadeId: l.id, semCorrespondencia: null };
      return { bairroId: null, localidadeId: null, semCorrespondencia: nome ? normalizarNome(nome) || null : null };
    };
  }

  /** Grupos dos registros que cada importação do e-SUS Notifica gravou (para o arquivo sem `grupos`, de envios anteriores). */
  private async gruposGravados(db: Db, importacoes: string[]): Promise<Map<string, string[]>> {
    if (!importacoes.length) return new Map();
    const linhas = await db.$queryRaw<{ imp: string; grupos: string[] }[]>`
      SELECT imp, array_agg(DISTINCT g ORDER BY g) AS grupos FROM (
        SELECT first_import_id AS imp, group_key AS g FROM official_records
        WHERE system = 'ESUS_NOTIFICA' AND type = 'INDIVIDUAL' AND group_key IS NOT NULL AND first_import_id = ANY(${importacoes}::uuid[])
        UNION ALL
        SELECT last_import_id AS imp, group_key AS g FROM official_records
        WHERE system = 'ESUS_NOTIFICA' AND type = 'INDIVIDUAL' AND group_key IS NOT NULL AND last_import_id = ANY(${importacoes}::uuid[])
      ) x GROUP BY imp`;
    return new Map(linhas.map((l) => [l.imp, l.grupos]));
  }

  /**
   * Cobertura por SE (a pesquisa: "ano ou período sem base importada é nulo e fica fora do conjunto"). A SE está coberta
   * quando cai no período de um arquivo de importação aplicada (só a APLICADA: a SUBSTITUIDA não cobre nada) que cobre o
   * agravo (`arquivoCobre` e `periodoCoberto`, os mesmos da conciliação: o período declarado no envio vale mais que o
   * lido no arquivo, e o fim não passa da data do primeiro envio do mesmo arquivo), quando o OmniSaúde já estava em uso
   * (da SE em que a primeira notificação notificada ou encerrada, de
   * qualquer agravo, entrou no sistema em diante) ou quando tem caso do agravo (o caso nunca se perde). O arquivo de um
   * CNES só (exportação de um estabelecimento) não cobre a SE do município nem a do território: os registros dele
   * continuam contando. O período lido no arquivo é a menor e a maior data de notificação: num DBF de agravo raro ele
   * pode ser menor que o exportado, e as SE das pontas ficam fora (o envio com período declarado resolve).
   */
  private async cobertura(sys: SystemContext, grupo: string, anos: number[], linhas: LinhaCasos[]): Promise<{ cobertura: CoberturaAno[]; semanas: Map<number, boolean[]> }> {
    const [importacoes, primeira] = await Promise.all([
      sys.db.officialImport.findMany({
        where: { status: 'APLICADA' },
        select: { id: true, fileName: true, sha256: true, periodFrom: true, periodTo: true, declaredPeriod: true, createdAt: true, files: true },
      }),
      // Quando a ficha entrou no sistema (não a data de conhecimento, que aceita qualquer dia passado: uma carga
      // retroativa cobriria com zeros anos inteiros de todo agravo).
      sys.db.notification.findFirst({ where: { status: { in: ['NOTIFICADA', 'ENCERRADA'] } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);
    const arquivos = (imp: (typeof importacoes)[number]) => (Array.isArray(imp.files) ? (imp.files as unknown as ArquivoDetectado[]) : []);
    const [gravados, primeiros] = await Promise.all([
      this.gruposGravados(
        sys.db,
        importacoes.filter((i) => arquivos(i).some((a) => a.tipo === 'ESUS_NOTIFICA_CSV' && !a.grupos)).map((i) => i.id),
      ),
      primeirosEnvios(
        sys.db,
        importacoes.map((i) => i.sha256),
      ),
    ]);
    const periodos: { de: string; ate: string; nome: string }[] = [];
    for (const imp of importacoes)
      for (const a of arquivos(imp)) {
        if (cnesDoArquivo(a) || !arquivoCobre(a, grupo, gravados.get(imp.id))) continue;
        const p = periodoCoberto(imp, a, sys.tenant.timeZone, primeiros.get(imp.sha256));
        if (p) periodos.push({ de: p.de, ate: p.ate, nome: imp.fileName });
      }
    const omniDesde = primeira ? semanaEpidemiologica(primeira.createdAt, sys.tenant.timeZone).codigo : null;
    const comCaso = new Set(linhas.map((l) => `${l.ano}${pad(l.semana)}`));
    const semanas = new Map<number, boolean[]>();
    const cobertura = anos.map((ano): CoberturaAno => {
      const total = semanasNoAno(ano);
      const marcas = Array.from({ length: 53 }, () => false);
      const arquivosDoAno = new Set<string>();
      let porOmni = false;
      let soPorCaso = false;
      for (let se = 1; se <= total; se++) {
        const codigo = `${ano}${pad(se)}`;
        const { inicio, fim } = intervaloDaSemana(ano, se);
        const imps = periodos.filter((p) => p.de <= fim && p.ate >= inicio);
        const omni = omniDesde !== null && codigo >= omniDesde;
        for (const p of imps) arquivosDoAno.add(p.nome);
        if (omni) porOmni = true;
        if (!imps.length && !omni && comCaso.has(codigo)) soPorCaso = true;
        marcas[se - 1] = imps.length > 0 || omni || comCaso.has(codigo);
      }
      semanas.set(ano, marcas);
      const cobertas = marcas.filter(Boolean).length;
      if (!cobertas) return { ano, coberto: false, parcial: false, semanasCobertas: 0, motivo: 'Nenhuma base cobre o ano: fica fora do canal' };
      const fontes = [
        ...(arquivosDoAno.size ? [`importação aplicada: ${[...arquivosDoAno].join(', ')}`] : []),
        ...(porOmni ? [omniDesde! > `${ano}01` ? `OmniSaúde em uso desde a SE ${ss(omniDesde!)}` : 'OmniSaúde em uso'] : []),
        ...(soPorCaso ? ['SE com caso do agravo'] : []),
      ].join('; ');
      if (cobertas === total) return { ano, coberto: true, parcial: false, semanasCobertas: cobertas, motivo: `Coberto o ano todo (${fontes})` };
      const lista = marcas.flatMap((m, i) => (m ? [i + 1] : []));
      return { ano, coberto: true, parcial: true, semanasCobertas: cobertas, motivo: `Coberto só nas SE ${faixasDeSemanas(lista)} (${fontes}); as demais SE ficam fora do canal` };
    });
    return { cobertura, semanas };
  }
}
