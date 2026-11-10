import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { TenantPrisma, type TenantClient, type TenantModels } from '@omnisaude/database';
import {
  AGRAVOS_SINAN,
  CLASSIFICACAO_CASO_SURTO,
  CRITERIO_CASO_SURTO,
  DELIMITACAO_SURTO,
  detectarAglomerados,
  idadeSinan,
  LOCAL_INICIAL_SURTO,
  localDateString,
  MODO_TRANSMISSAO,
  PRAZO_SURTO_HORAS,
  REGRAS_SURTO_PADRAO,
  roleHasPermission,
  semanaDaData,
  SINAN_SEXO,
  SINAN_ZONA,
  SINDROMES_SURTO,
  situacaoDoPrazo,
  validarSurto,
  VEICULO_TRANSMISSAO,
  type BlocoDta,
  type CampoEspelho,
  type CasoParaSurto,
  type CasoSurto,
  type CategoriaSurto,
  type CorpoCasoSurto,
  type CorpoComunicacaoSurto,
  type CorpoDescartarSurto,
  type CorpoDispensarSugestao,
  type CorpoEditarSurto,
  type CorpoEncerrarSurto,
  type CorpoNovoSurto,
  type CorpoNumeroOficialSurto,
  type DadosSurtoValidacao,
  type DetalheSurto,
  type EspelhoSurto,
  type EventoSurto,
  type ExcessoTerritorio,
  type ListaSurtos,
  type LocalSurto,
  type PrazoSurto,
  type RespostaCasoSurto,
  type RespostaOk,
  type RespostaSugestoesSurto,
  type StatusSurto,
  type SugestaoSurto,
  type SugestaoSurtoTela,
  type SurtoResumo,
  type TipoEventoSurto,
} from '@omnisaude/shared';
import { AuditService } from '../../core/audit.service';
import type { RequestContext } from '../../core/context';
import { conflict, DomainError, forbidden, notFound } from '../../core/errors';
import type { SystemContext } from '../integrations/messaging.service';
import { LocalizadorService, PRECISAO_LIGA_QUARTEIRAO } from '../territorio/localizador.service';
import { DiagramaService } from './diagrama.service';
import { MapaCasosService } from './mapa.service';
import { NegativaService } from './negativa.service';
import { NotificacaoService } from './notificacao.service';

const DIA = 86_400_000;
const HORA = 3_600_000;
/** Janela das notificações olhadas pelas sugestões (as regras usam janelas menores dentro dela). */
const JANELA_SUGESTOES_DIAS = 30;
/** Teto de notificações lidas pelas sugestões. */
const LIMITE_SUGESTOES = 5000;
/** Arboviroses: o excesso aparece no diagrama de controle por território (frente F3), não nas regras de vizinhança. */
const GRUPOS_DIAGRAMA = ['dengue', 'chikungunya', 'zika'];

const dataIso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const comoData = (iso: string) => new Date(`${iso}T00:00:00Z`);
const ddmmaaaa = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : null);
/** CID guardado sem ponto ("A059"); exibido com ponto ("A05.9"). */
const cidGuardado = (cid: string | null | undefined) =>
  cid
    ? cid
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '') || null
    : null;
const cidExibido = (cid: string) => (cid.length > 3 ? `${cid.slice(0, 3)}.${cid.slice(3)}` : cid);
/** "código - rótulo" do domínio da ficha (como o espelho da ficha individual). */
const comRotulo = (dominio: Record<string, string>, v: string | null | undefined) => (v ? `${v} - ${dominio[v] ?? ''}` : null);
const simNao = (v: boolean | null | undefined) => (v === true ? '1' : v === false ? '2' : '9');

const PARTICULAS = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'di', 'du', 'del']);

/** Iniciais do nome para a planilha (sem as partículas: "João da Silva Souza" → "JSS"). */
export function iniciais(nome: string | null | undefined): string | null {
  if (!nome) return null;
  const s = nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s+/)
    .filter((p) => p && !PARTICULAS.has(p.toLowerCase()))
    .map((p) => p[0]!.toUpperCase())
    .join('')
    .replace(/[^A-Z]/g, '');
  return s ? s.slice(0, 15) : null;
}

const UNIDADE_IDADE: Record<string, { codigo: string; um: string; varios: string; max: number }> = {
  H: { codigo: '1', um: 'hora', varios: 'horas', max: 23 },
  D: { codigo: '2', um: 'dia', varios: 'dias', max: 31 },
  M: { codigo: '3', um: 'mês', varios: 'meses', max: 11 },
  A: { codigo: '4', um: 'ano', varios: 'anos', max: 130 },
};

/**
 * Idade da linha da planilha guardada como número + unidade do Sinan (H, D, M, A): "34", "34 anos", "34A" → "34A";
 * "5 meses", "5m" → "5M"; "10 dias" → "10D"; "12 horas" → "12H". Nulo quando o texto não é idade.
 */
export function normalizarIdade(texto: string): string | null {
  const t = texto.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const m = /^(\d{1,3})\s*([a-z]*)\.?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const u = ['', 'a', 'ano', 'anos'].includes(m[2]!) ? 'A' : ['m', 'mes', 'meses'].includes(m[2]!) ? 'M' : ['d', 'dia', 'dias'].includes(m[2]!) ? 'D' : ['h', 'hora', 'horas'].includes(m[2]!) ? 'H' : null;
  if (!u || n > UNIDADE_IDADE[u]!.max) return null;
  return `${n}${u}`;
}

const idadeLegivel = (canon: string | null) => {
  const m = canon ? /^(\d+)([HDMA])$/.exec(canon) : null;
  if (!m) return canon;
  const u = UNIDADE_IDADE[m[2]!]!;
  return `${m[1]} ${Number(m[1]) === 1 ? u.um : u.varios}`;
};
/** NU_IDADE_N do Sinan: unidade (1 hora, 2 dia, 3 mês, 4 ano) e 3 dígitos. */
const idadeCodigo = (canon: string | null) => {
  const m = canon ? /^(\d+)([HDMA])$/.exec(canon) : null;
  return m ? `${UNIDADE_IDADE[m[2]!]!.codigo}${m[1]!.padStart(3, '0')}` : null;
};

/** Rótulos das variáveis da ficha de surto de DTA (campos 27 a 60) que o espelho reconhece; as demais saem pelo nome. */
const ROTULO_DTA: Record<string, string> = {
  NU_ENTR: 'Nº de entrevistados',
  NU_ENT_DOE: 'Nº de doentes entrevistados',
  NU_TOT: 'Total de doentes',
  NU_TOT_HOS: 'Nº de hospitalizados',
  NU_OBITO: 'Nº de óbitos',
  DS_ETIOLOG: 'Agente etiológico',
  DS_ALICAUS: 'Alimento causador',
  TP_PRO_PRE: 'Local de produção/preparação',
  ST_ALIMEN: 'Local de ingestão',
  CRITERIO: 'Critério de confirmação',
  DT_ENCERRA: 'Data de encerramento (DTA)',
};

type Outbreak = TenantModels.Outbreak;
type OutbreakCase = TenantModels.OutbreakCase;
type OutbreakEvent = TenantModels.OutbreakEvent;
type DadosCaso = Omit<OutbreakCase, 'id' | 'outbreakId' | 'caseNumber' | 'createdAt' | 'createdBy'>;
type InfoGrupo = { nome: string; sinanCode: string | null };
type ValorEvento = string | number | boolean | null;
/** Linha da planilha pronta para gravar, com os avisos e o que vai para o evento. */
type CasoPreparado = { dados: DadosCaso; avisos: string[]; evento: Record<string, ValorEvento> };
/** Campos do local de ocorrência (campos 20 a 33 da ficha). */
type DadosLocal = Partial<Pick<Outbreak, 'occurrenceIbge' | 'localityId' | 'neighborhoodId' | 'address' | 'reference' | 'zone' | 'lat' | 'lng'>>;

/** Código do agravo no Sinan a partir do grupo do catálogo (tabela dos agravos da semana 27). */
function codigoDoGrupo(grupo: string): string | null {
  for (const [codigo, info] of Object.entries(AGRAVOS_SINAN)) if (info.grupo === grupo) return codigo;
  return null;
}

/**
 * Notificação de surto e sugestões (VIG-1c, §4.3; frente F4). O núcleo só vê e cria surtos das unidades em que está
 * lotado (a do contexto ativo, como o escopo das notificações). Prazo imediato (24 h do conhecimento) para a SMS; com
 * ESP, também SES e MS. `validarSurto` em cada etapa. Ao criar ou incluir caso, reconcilia a negativa da unidade e
 * semana (NegativaService.reconciliar). O surto não substitui a notificação individual dos agravos da lista.
 */
@Injectable()
export class SurtoService {
  private readonly logger = new Logger('Surto');

  /** Relógio do serviço (os testes trocam por uma data fixa ou deslocada). */
  agora: () => Date = () => new Date();

  constructor(
    private readonly audit: AuditService,
    private readonly negativas: NegativaService,
    private readonly notificacoes: NotificacaoService,
    private readonly mapa: MapaCasosService,
    private readonly localizador: LocalizadorService,
    private readonly diagramas: DiagramaService,
  ) {}

  // ───────────────────────────── alcance e apoio ─────────────────────────────

  private vigilanciaMunicipal(ctx: RequestContext) {
    return ctx.session.role === 'VIGILANCIA_EPIDEMIOLOGICA';
  }

  /** Filtro das listas: a vigilância municipal vê tudo; o núcleo, a unidade em que está lotado. */
  private escopo(ctx: RequestContext): { unitId?: string } {
    return this.vigilanciaMunicipal(ctx) ? {} : { unitId: ctx.session.unitId };
  }

  private async carregar(ctx: RequestContext, id: string): Promise<Outbreak> {
    const o = await ctx.db.outbreak.findUnique({ where: { id } });
    if (!o) throw notFound('Surto');
    if (!this.vigilanciaMunicipal(ctx) && o.unitId !== ctx.session.unitId) throw forbidden('Surto de outra unidade: fora do seu alcance');
    return o;
  }

  private exigirAberto(o: { status: string }) {
    if (o.status !== 'ABERTO') throw new DomainError('SURTO_FECHADO', o.status === 'DESCARTADO' ? 'Surto descartado' : 'Surto encerrado', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  /** Nome e código do Sinan de cada grupo do catálogo (a linha "casos" do grupo, como no diagrama). */
  private async grupos(db: TenantClient, chaves: string[]): Promise<Map<string, InfoGrupo>> {
    const unicas = [...new Set(chaves.filter(Boolean))];
    if (!unicas.length) return new Map();
    const linhas = await db.notifiableCondition.findMany({ where: { groupKey: { in: unicas } }, select: { key: true, groupKey: true, name: true, context: true, sinanCode: true } });
    const mapa = new Map<string, InfoGrupo>();
    for (const g of unicas) {
      const doGrupo = linhas.filter((l) => l.groupKey === g);
      const l = doGrupo.find((x) => x.key === g) ?? doGrupo.find((x) => x.context === 'CASO') ?? doGrupo[0];
      if (l) mapa.set(g, { nome: l.name.replace(/\s+-\s+Casos$/i, ''), sinanCode: doGrupo.find((x) => x.sinanCode)?.sinanCode ?? null });
    }
    return mapa;
  }

  private agravoTexto(o: { groupKey: string | null; syndrome: string | null; cid: string | null; agentText: string | null }, grupos: Map<string, InfoGrupo>) {
    const base = (o.groupKey ? (grupos.get(o.groupKey)?.nome ?? o.groupKey) : null) ?? (o.syndrome ? (SINDROMES_SURTO[o.syndrome]?.nome ?? o.syndrome) : null) ?? o.agentText ?? null;
    if (!base) return o.cid ? `CID ${cidExibido(o.cid)}` : 'Agravo não informado';
    return o.cid ? `${base} (CID ${cidExibido(o.cid)})` : base;
  }

  /** Categoria × agravo: a da lista exige grupo do catálogo; a sindrômica, uma das síndromes; fora da lista, nenhum grupo. */
  private async validarAgravo(db: TenantClient, d: { categoria: CategoriaSurto; grupo: string | null; sindrome: string | null }) {
    if (d.sindrome && !SINDROMES_SURTO[d.sindrome]) throw new DomainError('SINDROME_INVALIDA', 'Síndrome fora da lista do Sinan', HttpStatus.BAD_REQUEST);
    const doCatalogo = d.grupo ? (await this.grupos(db, [d.grupo])).has(d.grupo) : false;
    if (d.grupo && !doCatalogo) throw new DomainError('AGRAVO_FORA_DO_CATALOGO', 'Agravo fora do catálogo da lista nacional: use a categoria "Doença fora da lista" com o CID', HttpStatus.BAD_REQUEST);
    if (d.categoria === 'DA_LISTA' && !d.grupo) throw new DomainError('AGRAVO_OBRIGATORIO', 'Surto de doença da lista: informe o agravo do catálogo', HttpStatus.BAD_REQUEST);
    if (d.categoria === 'SINDROMICO' && !d.sindrome) throw new DomainError('SINDROME_OBRIGATORIA', 'Agravo inusitado: informe a síndrome', HttpStatus.BAD_REQUEST);
    if (d.categoria === 'FORA_DA_LISTA' && d.grupo) throw new DomainError('AGRAVO_DA_LISTA', 'O agravo é da lista nacional: use a categoria "Doença da lista"', HttpStatus.BAD_REQUEST);
  }

  /** Bairro e localidade do local de ocorrência existem no território. */
  private async validarLocal(db: TenantClient, local: Partial<LocalSurto> | undefined) {
    if (!local) return;
    if (local.bairroId && !(await db.neighborhood.count({ where: { id: local.bairroId } }))) throw notFound('Bairro');
    if (local.localidadeId && !(await db.locality.count({ where: { id: local.localidadeId } }))) throw notFound('Localidade');
  }

  private dadosLocal(local: Partial<LocalSurto> | undefined): DadosLocal {
    if (!local) return {};
    const d: DadosLocal = {};
    if (local.municipioIbge !== undefined) d.occurrenceIbge = local.municipioIbge;
    if (local.localidadeId !== undefined) d.localityId = local.localidadeId;
    if (local.bairroId !== undefined) d.neighborhoodId = local.bairroId;
    if (local.endereco !== undefined) d.address = local.endereco;
    if (local.referencia !== undefined) d.reference = local.referencia;
    if (local.zona !== undefined) d.zone = local.zona;
    if (local.lat !== undefined) d.lat = local.lat;
    if (local.lng !== undefined) d.lng = local.lng;
    return d;
  }

  private dadosValidacao(o: Outbreak): DadosSurtoValidacao {
    return {
      notificadoEm: dataIso(o.notifiedOn),
      unitId: o.unitId,
      grupo: o.groupKey,
      sindrome: o.syndrome,
      cid: o.cid,
      primeirosSintomasEm: dataIso(o.firstSymptomsOn),
      casos: o.casesCount,
      localInicial: o.initialPlace,
      localInicialTexto: o.initialPlaceText,
      investigadoEm: dataIso(o.investigatedOn),
      delimitacao: o.delimitation,
      delimitacaoTexto: o.delimitationText,
      encerradoEm: dataIso(o.closedOn),
    };
  }

  private exigirValido(erros: string[]) {
    if (erros.length) throw new DomainError('SURTO_INVALIDO', erros.join('; '), HttpStatus.BAD_REQUEST, { erros });
  }

  /** Negativa (RQ003): a semana da unidade passou a ter surto. Falha não desfaz o surto (o job reconcilia depois). */
  private async reconciliarNegativa(ctx: RequestContext, unitId: string, dia: Date) {
    const semana = semanaDaData(dataIso(dia)!).codigo;
    try {
      await this.negativas.reconciliar(ctx.db, { unitIds: [unitId], semanas: [semana] });
    } catch (err) {
      this.logger.error(`Reconciliação da negativa da unidade ${unitId} na semana ${semana}: ${(err as Error).message}`);
    }
  }

  /**
   * Quarteirão, bairro e localidade da residência de cada notificação: a posição do imóvel (ou o retrato da ficha), como
   * no mapa de casos; posição precisa sem quarteirão ligado é localizada na malha.
   */
  private async territorioDasNotificacoes(db: TenantClient, ns: { id: string; patientId: string; residenceLat: number | null; residenceLng: number | null; residencePrecision: string | null }[]) {
    const residencias = await this.mapa.residencias(db, ns);
    const quarteiroes = new Map<string, string | null>();
    for (const n of ns) {
      const r = residencias.get(n.id);
      if (!r) quarteiroes.set(n.id, null);
      else quarteiroes.set(n.id, r.blockId ?? (PRECISAO_LIGA_QUARTEIRAO.includes(r.precisao) ? ((await this.localizador.quarteiraoDoPonto(db, r.lat, r.lng))?.id ?? null) : null));
    }
    const ids = [...new Set([...quarteiroes.values()].filter((b): b is string => !!b))];
    const blocos = ids.length ? await db.block.findMany({ where: { id: { in: ids } }, select: { id: true, number: true, neighborhoodId: true, localityId: true } }) : [];
    const porId = new Map(blocos.map((b) => [b.id, b]));
    return new Map(
      ns.map((n) => {
        const b = quarteiroes.get(n.id) ? porId.get(quarteiroes.get(n.id)!) : undefined;
        return [n.id, { blockId: b?.id ?? null, neighborhoodId: b?.neighborhoodId ?? null, localityId: b?.localityId ?? null, temPosicao: residencias.get(n.id) != null }];
      }),
    );
  }

  // ───────────────────────────── montagem das respostas ─────────────────────────────

  /** Prazo por esfera: SMS sempre; SES e MS quando ESP. A SMS cumpre com a comunicação ou quando ela mesma registrou. */
  private prazos(o: Pick<Outbreak, 'esp' | 'dueAt' | 'createdAt'>, eventos: Pick<OutbreakEvent, 'kind' | 'payload'>[], agora: Date): PrazoSurto[] {
    const criado = eventos.find((e) => e.kind === 'CRIADO')?.payload as { papel?: string } | undefined;
    const pelaSms = criado?.papel === 'VIGILANCIA_EPIDEMIOLOGICA';
    const esferas: PrazoSurto['esfera'][] = o.esp ? ['SMS', 'SES', 'MS'] : ['SMS'];
    return esferas.map((esfera) => {
      const feitas = eventos
        .filter((e) => e.kind === 'COMUNICADO' && (e.payload as { alvo?: string }).alvo === esfera)
        .map((e) => new Date(String((e.payload as { em?: string }).em)))
        .filter((d) => !Number.isNaN(d.getTime()))
        .sort((a, b) => a.getTime() - b.getTime());
      const cumprido = feitas[0] ?? (esfera === 'SMS' && pelaSms ? o.createdAt : null);
      return { esfera, venceEm: o.dueAt.toISOString(), cumpridoEm: cumprido?.toISOString() ?? null, situacao: situacaoDoPrazo(o.dueAt, cumprido, agora) };
    });
  }

  private avisos(o: Pick<Outbreak, 'category' | 'casesCount' | 'status' | 'officialNumber'>, casos: { notificationId: string | null; officialRecordId: string | null }[], grupoDaLista: boolean): string[] {
    const avisos: string[] = [];
    const individuais = casos.filter((c) => c.notificationId || c.officialRecordId).length;
    const total = Math.max(o.casesCount, casos.length);
    if (o.category === 'DA_LISTA' && individuais * 10 < total)
      avisos.push(`Surto de doença da lista em registro agregado: o manual do Sinan (5.3.1) pede acordo entre os gestores e notificação individual de ao menos 10% dos casos (${individuais} de ${total}).`);
    const sem = grupoDaLista ? casos.filter((c) => !c.notificationId && !c.officialRecordId).length : 0;
    if (sem && o.category !== 'DA_LISTA') avisos.push(`${sem} caso(s) da planilha sem notificação individual: o surto não substitui a notificação individual dos agravos da lista.`);
    if (o.status === 'ENCERRADO' && !o.officialNumber) avisos.push('Sem o número do Sinan: digite a notificação de surto no Sinan Net e informe o número.');
    return avisos;
  }

  private resumo(
    o: Outbreak & { unit: { id: string; name: string; cnes: string }; cases: { notificationId: string | null; officialRecordId: string | null }[]; events: Pick<OutbreakEvent, 'kind' | 'payload'>[] },
    grupos: Map<string, InfoGrupo>,
    agora: Date,
  ): SurtoResumo {
    const grupoDaLista = !!o.groupKey && grupos.has(o.groupKey);
    return {
      id: o.id,
      numero: o.number,
      status: o.status as StatusSurto,
      categoria: o.category as CategoriaSurto,
      grupo: o.groupKey,
      agravo: this.agravoTexto(o, grupos),
      sindrome: o.syndrome,
      cid: o.cid,
      unidade: { id: o.unit.id, nome: o.unit.name, cnes: o.unit.cnes },
      notificadoEm: dataIso(o.notifiedOn)!,
      conhecidoEm: o.knownAt.toISOString(),
      primeirosSintomasEm: dataIso(o.firstSymptomsOn)!,
      casos: o.casesCount,
      casosNaPlanilha: o.cases.length,
      localInicial: o.initialPlace,
      esp: o.esp,
      prazos: o.status === 'DESCARTADO' ? [] : this.prazos(o, o.events, agora),
      numeroOficial: o.officialNumber,
      encerradoEm: dataIso(o.closedOn),
      avisos: o.status === 'DESCARTADO' ? [] : this.avisos(o, o.cases, grupoDaLista),
    };
  }

  private montarEspelho(o: Outbreak & { unit: { name: string; cnes: string; ibgeCode: string } }, grupos: Map<string, InfoGrupo>, planilha: CasoSurto[], bairroNome: string | null): EspelhoSurto {
    const avisos: string[] = [];
    const sindrome = o.syndrome ? (SINDROMES_SURTO[o.syndrome] ?? null) : null;
    const codigo = o.cid ?? cidGuardado(sindrome?.codigo) ?? (o.groupKey ? (cidGuardado(grupos.get(o.groupKey)?.sinanCode) ?? codigoDoGrupo(o.groupKey)) : null);
    if (!o.cid && sindrome) avisos.push('O código da síndrome vem de fonte secundária: confira no Sinan Net antes de digitar.');
    if (!codigo) avisos.push('Sem o código do agravo (ID_AGRAVO): informe o CID do surto.');
    if (!o.officialNumber) avisos.push('Sem o número do Sinan (NU_NOTIFIC): digite a notificação no Sinan Net e informe o número.');
    if (planilha.some((c) => c.criterio)) avisos.push('Critério do caso pelo dicionário de dados (1 a 5); a legenda da planilha impressa diverge: confira com um NSURTNET real.');
    const notificado = dataIso(o.notifiedOn)!;
    const sintomas = dataIso(o.firstSymptomsOn)!;
    const ibge = o.unit.ibgeCode.replace(/\D/g, '');
    const ocorrencia = (o.occurrenceIbge ?? '').replace(/\D/g, '');
    const c = (variavel: string, rotulo: string, valor: string | number | null | undefined): CampoEspelho => ({ variavel, rotulo, valor: valor === null || valor === undefined || valor === '' ? null : String(valor) });
    const campos: CampoEspelho[] = [
      c('NU_NOTIFIC', 'Número da notificação', o.officialNumber),
      c('TP_NOT', 'Tipo de notificação', '3 - Surto'),
      c('ID_AGRAVO', 'Agravo/doença ou síndrome (CID)', codigo ? `${codigo} - ${this.agravoTexto({ ...o, cid: null }, grupos)}` : null),
      c('DT_NOTIFIC', 'Data da notificação', ddmmaaaa(notificado)),
      c('SEM_NOT', 'Semana epidemiológica da notificação', semanaDaData(notificado).codigo),
      c('NU_ANO', 'Ano da notificação', notificado.slice(0, 4)),
      c('SG_UF_NOT', 'UF de notificação', ibge.slice(0, 2)),
      c('ID_MUNICIP', 'Município de notificação', ibge.slice(0, 6)),
      c('ID_UNIDADE', 'Unidade notificante (CNES)', `${o.unit.cnes} - ${o.unit.name}`),
      c('DT_SIN_PRI', 'Data dos primeiros sintomas do 1º caso suspeito', ddmmaaaa(sintomas)),
      c('SEM_PRI', 'Semana epidemiológica dos primeiros sintomas', semanaDaData(sintomas).codigo),
      c('QT_TOTAL_C', 'Nº de casos suspeitos/expostos', o.casesCount),
      c('CS_LOCAL', 'Local inicial de ocorrência', comRotulo(LOCAL_INICIAL_SURTO, o.initialPlace)),
      c('NM_LOCAL', 'Local inicial de ocorrência (outros)', o.initialPlaceText),
      c('SG_UF', 'UF de ocorrência', ocorrencia.slice(0, 2)),
      c('ID_MUNI_RE', 'Município de ocorrência', ocorrencia.slice(0, 6)),
      c('NM_BAIRRO', 'Bairro de ocorrência', bairroNome),
      c('NM_LOGRADO', 'Logradouro e número', o.address),
      c('NM_REFEREN', 'Ponto de referência', o.reference),
      c('CS_ZONA', 'Zona', comRotulo(SINAN_ZONA, o.zone)),
      c('ID_GEO1', 'Geo campo 1 (latitude)', o.lat),
      c('ID_GEO2', 'Geo campo 2 (longitude)', o.lng),
      c('DT_INVEST', 'Data da investigação', ddmmaaaa(dataIso(o.investigatedOn))),
      c('CS_TRANS', 'Modo provável de transmissão', comRotulo(MODO_TRANSMISSAO, o.transmission)),
      c('TP_INDIRET', 'Veículo de transmissão', comRotulo(VEICULO_TRANSMISSAO, o.vehicle)),
      c('CS_VEICULO', 'Veículo de transmissão (outro)', o.vehicleText),
      c('DS_OBS', 'Observações', o.observations),
      c('DELIMITA', 'Delimitação do surto', comRotulo(DELIMITACAO_SURTO, o.delimitation)),
      c('DT_ENCERRA', 'Data do encerramento', ddmmaaaa(dataIso(o.closedOn))),
    ];
    // Planilha de acompanhamento: valores como vão para o Sinan (códigos).
    const linhas = planilha.map((p) => ({
      NU_CASO: String(p.numero),
      NM_CASO: p.iniciais,
      CS_SEXO: p.sexo,
      NU_IDADE_N: idadeCodigo(normalizarIdade(p.idade ?? '') ?? null),
      ID_MN_RESI: p.municipioResidencia ? p.municipioResidencia.slice(0, 6) : null,
      NM_BAIRRO: p.bairroNome,
      DT_SIN_PRI: ddmmaaaa(p.inicioSintomas),
      ID_HOSP: simNao(p.hospitalizado),
      OBITO: simNao(p.obito),
      CLASSI_FIN: p.classificacao,
      CRITERIO: p.criterio,
      DIAG_FINAL: p.cidFinal,
    }));
    const dta = o.dta && typeof o.dta === 'object' ? Object.entries(o.dta as BlocoDta).map(([k, v]) => c(k, ROTULO_DTA[k] ?? k, v)) : [];
    return { campos, planilha: linhas, dta, avisos };
  }

  private casoDto(c: OutbreakCase, numeros: Map<string, string>, bairros: Map<string, string>, grupoDaLista: boolean): CasoSurto {
    return {
      id: c.id,
      numero: c.caseNumber,
      notificationId: c.notificationId,
      notificacaoNumero: c.notificationId ? (numeros.get(c.notificationId) ?? null) : null,
      officialRecordId: c.officialRecordId,
      iniciais: c.initials,
      sexo: c.sex,
      idade: idadeLegivel(c.ageText),
      municipioResidencia: c.residenceIbge,
      bairroId: c.neighborhoodId,
      bairroNome: c.neighborhoodId ? (bairros.get(c.neighborhoodId) ?? null) : null,
      inicioSintomas: dataIso(c.onsetOn),
      hospitalizado: c.hospitalized,
      obito: c.died,
      classificacao: c.finalClass,
      criterio: c.criterion,
      cidFinal: c.finalCid,
      semNotificacaoIndividual: grupoDaLista && !c.notificationId && !c.officialRecordId,
    };
  }

  private async montarDetalhe(ctx: RequestContext, id: string): Promise<DetalheSurto> {
    const o = await ctx.db.outbreak.findUniqueOrThrow({
      where: { id },
      include: { unit: { select: { id: true, name: true, cnes: true, ibgeCode: true } }, cases: { orderBy: { caseNumber: 'asc' } }, events: { orderBy: [{ at: 'asc' }, { id: 'asc' }] } },
    });
    const agora = this.agora();
    const grupos = await this.grupos(ctx.db, o.groupKey ? [o.groupKey] : []);
    const grupoDaLista = !!o.groupKey && grupos.has(o.groupKey);
    const notificacoesIds = o.cases.map((c) => c.notificationId).filter((x): x is string => !!x);
    const bairrosIds = [...o.cases.map((c) => c.neighborhoodId), o.neighborhoodId].filter((x): x is string => !!x);
    const usuariosIds = [o.notifierId, o.discardedBy, ...o.events.map((e) => e.byUser)].filter((x): x is string => !!x);
    const [notifs, bairros, usuarios] = await Promise.all([
      notificacoesIds.length ? ctx.db.notification.findMany({ where: { id: { in: notificacoesIds } }, select: { id: true, number: true } }) : [],
      bairrosIds.length ? ctx.db.neighborhood.findMany({ where: { id: { in: [...new Set(bairrosIds)] } }, select: { id: true, name: true } }) : [],
      ctx.db.user.findMany({ where: { id: { in: [...new Set(usuariosIds)] } }, select: { id: true, name: true, socialName: true } }),
    ]);
    const numeros = new Map(notifs.map((n) => [n.id, n.number]));
    const nomesBairros = new Map(bairros.map((b) => [b.id, b.name]));
    const nomes = new Map(usuarios.map((u) => [u.id, u.socialName ?? u.name]));
    const planilha = o.cases.map((c) => this.casoDto(c, numeros, nomesBairros, grupoDaLista));
    const eventos: EventoSurto[] = o.events.map((e) => ({
      id: e.id,
      tipo: e.kind as TipoEventoSurto,
      em: e.at.toISOString(),
      por: e.byUser ? (nomes.get(e.byUser) ?? null) : null,
      dados: (e.payload ?? {}) as Record<string, unknown>,
    }));
    const aberto = o.status === 'ABERTO';
    return {
      ...this.resumo(o, grupos, agora),
      venceEm: o.dueAt.toISOString(),
      notificador: nomes.get(o.notifierId) ?? null,
      agente: o.agentText,
      localInicialTexto: o.initialPlaceText,
      local: { municipioIbge: o.occurrenceIbge, localidadeId: o.localityId, bairroId: o.neighborhoodId, endereco: o.address, referencia: o.reference, zona: o.zone, lat: o.lat, lng: o.lng },
      investigacao: {
        investigadoEm: dataIso(o.investigatedOn),
        modoTransmissao: o.transmission,
        veiculo: o.vehicle,
        veiculoTexto: o.vehicleText,
        observacoes: o.observations,
        investigadorNome: o.investigatorName,
        investigadorFuncao: o.investigatorRole,
      },
      dta: (o.dta as BlocoDta | null) ?? null,
      delimitacao: o.delimitation,
      delimitacaoTexto: o.delimitationText,
      notasEncerramento: o.closingNotes,
      descarte: o.status === 'DESCARTADO' ? { motivo: o.discardReason ?? '', em: o.discardedAt?.toISOString() ?? '', por: o.discardedBy ? (nomes.get(o.discardedBy) ?? null) : null } : null,
      sinal: (o.signal as Record<string, unknown> | null) ?? null,
      planilha,
      eventos,
      espelho: this.montarEspelho(o, grupos, planilha, o.neighborhoodId ? (nomesBairros.get(o.neighborhoodId) ?? null) : null),
      pendencias: o.status === 'DESCARTADO' ? [] : validarSurto(this.dadosValidacao(o), o.status === 'ENCERRADO' ? 'ENCERRAMENTO' : 'INVESTIGACAO'),
      permissoes: {
        editar: aberto,
        encerrar: aberto,
        descartar: aberto && this.vigilanciaMunicipal(ctx),
        numeroOficial: o.status !== 'DESCARTADO' && roleHasPermission(ctx.session.role, 'vigilancia.digitar'),
      },
    };
  }

  // ───────────────────────────── planilha de acompanhamento ─────────────────────────────

  /**
   * Linha da planilha a partir de uma notificação (com as regras de alcance e sigilo dela), de um registro oficial
   * individual ou de uma linha manual. Devolve os dados da linha, os avisos e o que vai para o evento.
   */
  private async prepararCaso(ctx: RequestContext, surto: { id: string | null; grupo: string | null; grupoDaLista: boolean; categoria: CategoriaSurto }, corpo: CorpoCasoSurto): Promise<CasoPreparado> {
    const avisos: string[] = [];
    const vazio: DadosCaso = {
      notificationId: null,
      officialRecordId: null,
      initials: null,
      sex: null,
      ageText: null,
      residenceIbge: null,
      neighborhoodId: null,
      onsetOn: null,
      hospitalized: null,
      died: null,
      finalClass: null,
      criterion: null,
      finalCid: null,
    };
    if ('notificationId' in corpo) {
      const n = await this.notificacoes.acessar(ctx, corpo.notificationId, { leitura: true });
      if (n.status === 'DESCARTADA') throw new DomainError('NOTIFICACAO_DESCARTADA', `A notificação ${n.number} foi descartada: não entra na planilha`, HttpStatus.UNPROCESSABLE_ENTITY);
      if (surto.id && (await ctx.db.outbreakCase.count({ where: { outbreakId: surto.id, notificationId: n.id } }))) throw conflict(`A notificação ${n.number} já está na planilha deste surto`);
      const outros = await ctx.db.outbreakCase.findMany({
        where: { notificationId: n.id, outbreak: { status: 'ABERTO' }, ...(surto.id ? { outbreakId: { not: surto.id } } : {}) },
        select: { outbreak: { select: { number: true } } },
      });
      for (const x of outros) avisos.push(`A notificação ${n.number} também está no surto ${x.outbreak.number}.`);
      if (surto.grupo && n.groupKey !== surto.grupo) avisos.push(`O agravo da notificação ${n.number} (${n.condition.name}) é diferente do agravo do surto.`);
      if (n.status === 'RASCUNHO') avisos.push(`A notificação ${n.number} ainda é rascunho: confirme-a.`);
      const paciente = await ctx.db.patient.findUnique({ where: { id: n.patientId }, select: { name: true, sex: true, birthDate: true } });
      const territorio = (await this.territorioDasNotificacoes(ctx.db, [n])).get(n.id);
      const idade = paciente?.birthDate ? idadeSinan(paciente.birthDate, n.symptomsOnset ?? n.knownAt) : null;
      return {
        dados: {
          ...vazio,
          notificationId: n.id,
          initials: iniciais(paciente?.name),
          sex: paciente?.sex ?? null,
          ageText: idade ? `${idade.valor}${idade.unidade}` : null,
          residenceIbge: n.residenceIbge,
          neighborhoodId: territorio?.neighborhoodId ?? null,
          onsetOn: n.symptomsOnset,
          hospitalized: n.admissionId ? true : null,
          died: n.evolution === '2' || n.evolution === '3' || n.deathDate ? true : n.evolution === '1' ? false : null,
          finalClass: n.finalClass === '1' ? '1' : n.finalClass === '2' ? '2' : n.finalClass === '8' ? '3' : null,
          finalCid: n.codeSystem === 'CID10' && n.code ? cidGuardado(n.code) : null,
        },
        avisos,
        evento: { notificacao: n.number },
      };
    }
    if ('officialRecordId' in corpo) {
      const r = await ctx.db.officialRecord.findUnique({ where: { id: corpo.officialRecordId } });
      if (!r) throw notFound('Registro oficial');
      if (r.type !== 'INDIVIDUAL' || r.excluded) throw new DomainError('REGISTRO_INVALIDO', 'Só registro individual (não excluído) entra na planilha', HttpStatus.UNPROCESSABLE_ENTITY);
      if (!this.vigilanciaMunicipal(ctx)) {
        const minha = await ctx.db.unit.findUnique({ where: { id: ctx.session.unitId }, select: { cnes: true } });
        if (r.unitId !== ctx.session.unitId && r.unitCnes !== minha?.cnes) throw forbidden('Registro oficial de outra unidade: fora do seu alcance');
      }
      if (r.sensitive && !roleHasPermission(ctx.session.role, 'notificacao.sensivel')) throw forbidden('Agravo de acesso restrito');
      if (surto.id && (await ctx.db.outbreakCase.count({ where: { outbreakId: surto.id, officialRecordId: r.id } }))) throw conflict(`O registro ${r.number} já está na planilha deste surto`);
      if (surto.grupo && r.groupKey && r.groupKey !== surto.grupo) avisos.push(`O agravo do registro ${r.number} é diferente do agravo do surto.`);
      const idade = r.birthDate ? idadeSinan(r.birthDate, r.symptomsOnset ?? r.notifiedOn) : null;
      return {
        dados: {
          ...vazio,
          officialRecordId: r.id,
          initials: iniciais(r.patientName),
          sex: r.sex === 'M' || r.sex === 'F' ? r.sex : r.sex ? 'I' : null,
          ageText: idade ? `${idade.valor}${idade.unidade}` : null,
          residenceIbge: r.residenceIbge,
          onsetOn: r.symptomsOnset,
          died: r.evolution === '2' || r.evolution === '3' || r.deathOn ? true : r.evolution === '1' ? false : null,
          finalClass: r.situation === 'CONFIRMADO' ? '1' : r.situation === 'DESCARTADO' ? '2' : r.situation === 'INCONCLUSIVO' ? '3' : null,
          finalCid: cidGuardado(r.agravo),
        },
        avisos,
        evento: { registro: r.number, sistema: r.system },
      };
    }
    const l = corpo.linha;
    const hoje = localDateString(this.agora(), ctx.tenant.timeZone);
    const idade = l.idade?.trim() ? normalizarIdade(l.idade) : null;
    if (l.idade?.trim() && !idade) throw new DomainError('IDADE_INVALIDA', 'Idade inválida: use número e unidade (ex.: 34 anos, 5 meses, 10 dias)', HttpStatus.BAD_REQUEST);
    if (l.inicioSintomas && l.inicioSintomas > hoje) throw new DomainError('DATA_FUTURA', 'O início dos sintomas não pode ser futuro', HttpStatus.BAD_REQUEST);
    if (l.bairroId && !(await ctx.db.neighborhood.count({ where: { id: l.bairroId } }))) throw notFound('Bairro');
    if (l.classificacao && !CLASSIFICACAO_CASO_SURTO[l.classificacao]) throw new DomainError('CLASSIFICACAO_INVALIDA', 'Classificação do caso: 1, 2 ou 3', HttpStatus.BAD_REQUEST);
    if (l.criterio && !CRITERIO_CASO_SURTO[l.criterio]) throw new DomainError('CRITERIO_INVALIDO', 'Critério do caso: 1 a 5', HttpStatus.BAD_REQUEST);
    if (surto.grupoDaLista)
      avisos.push(
        surto.categoria === 'DA_LISTA'
          ? 'Caso de agravo da lista sem notificação individual: o registro agregado exige acordo entre os gestores e ao menos 10% dos casos notificados individualmente.'
          : 'Caso de agravo da lista sem notificação individual: notifique o caso (o surto não substitui a notificação individual).',
      );
    return {
      dados: {
        ...vazio,
        initials: l.iniciais?.trim().toUpperCase() || null,
        sex: l.sexo ?? null,
        ageText: idade,
        residenceIbge: l.municipioResidencia ?? null,
        neighborhoodId: l.bairroId ?? null,
        onsetOn: l.inicioSintomas ? comoData(l.inicioSintomas) : null,
        hospitalized: l.hospitalizado ?? null,
        died: l.obito ?? null,
        finalClass: l.classificacao ?? null,
        criterion: l.criterio ?? null,
        finalCid: cidGuardado(l.cidFinal),
      },
      avisos,
      evento: { manual: true },
    };
  }

  // ───────────────────────────── surtos ─────────────────────────────

  /** GET /vigilancia/surtos?status=. */
  async listar(ctx: RequestContext, consulta: { status?: StatusSurto }): Promise<ListaSurtos> {
    const rows = await ctx.db.outbreak.findMany({
      where: { ...this.escopo(ctx), ...(consulta.status ? { status: consulta.status } : {}) },
      include: {
        unit: { select: { id: true, name: true, cnes: true } },
        cases: { select: { notificationId: true, officialRecordId: true } },
        events: { where: { kind: { in: ['CRIADO', 'COMUNICADO'] } }, select: { kind: true, payload: true } },
      },
      orderBy: [{ notifiedOn: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    const grupos = await this.grupos(
      ctx.db,
      rows.map((o) => o.groupKey).filter((g): g is string => !!g),
    );
    const agora = this.agora();
    return rows.map((o) => this.resumo(o, grupos, agora));
  }

  /** POST /vigilancia/surtos (de uma sugestão, com a assinatura e os casos, ou manual). */
  async criar(ctx: RequestContext, corpo: CorpoNovoSurto): Promise<DetalheSurto> {
    const agora = this.agora();
    const hoje = localDateString(agora, ctx.tenant.timeZone);
    const unidade = await ctx.db.unit.findUnique({ where: { id: corpo.unitId }, select: { id: true, cnes: true } });
    if (!unidade) throw notFound('Unidade');
    if (!this.vigilanciaMunicipal(ctx) && unidade.id !== ctx.session.unitId) throw forbidden('O núcleo notifica surto só da unidade em que está lotado');
    const conhecido = new Date(corpo.conhecidoEm);
    if (Number.isNaN(conhecido.getTime())) throw new DomainError('DATA_INVALIDA', 'Instante do conhecimento inválido', HttpStatus.BAD_REQUEST);
    if (conhecido.getTime() > agora.getTime() + 60_000) throw new DomainError('DATA_FUTURA', 'O conhecimento do surto não pode ser futuro', HttpStatus.BAD_REQUEST);
    if (corpo.notificadoEm > hoje) throw new DomainError('DATA_FUTURA', 'A data da notificação não pode ser futura', HttpStatus.BAD_REQUEST);
    const grupo = corpo.grupo ?? null;
    const sindrome = corpo.sindrome ?? null;
    const cid = cidGuardado(corpo.cid);
    await this.validarAgravo(ctx.db, { categoria: corpo.categoria, grupo, sindrome });
    this.exigirValido(
      validarSurto(
        {
          notificadoEm: corpo.notificadoEm,
          unitId: unidade.id,
          grupo,
          sindrome,
          cid,
          primeirosSintomasEm: corpo.primeirosSintomasEm,
          casos: corpo.casos,
          localInicial: corpo.localInicial,
          localInicialTexto: corpo.localInicialTexto ?? null,
        },
        'NOTIFICACAO',
      ),
    );
    await this.validarLocal(ctx.db, corpo.local);
    const grupoDaLista = grupo ? (await this.grupos(ctx.db, [grupo])).has(grupo) : false;
    // Casos indicados (sugestão): conferidos antes da gravação, com as regras de alcance e sigilo de cada notificação.
    const preparados: CasoPreparado[] = [];
    const vistos = new Set<string>();
    for (const c of corpo.casosIndicados ?? []) {
      const k = c.notificationId ?? c.officialRecordId;
      if (!k || vistos.has(k)) continue;
      vistos.add(k);
      preparados.push(await this.prepararCaso(ctx, { id: null, grupo, grupoDaLista, categoria: corpo.categoria }, c.notificationId ? { notificationId: c.notificationId } : { officialRecordId: c.officialRecordId! }));
    }
    const ano = Number(hoje.slice(0, 4));
    const sinal = corpo.assinatura ? { assinatura: corpo.assinatura, regra: corpo.assinatura.split('|')[0] ?? null, casos: [...vistos] } : null;
    const o = await ctx.db.$transaction(async (tx) => {
      // Número do ano sem colisão: a trava do tenant e do ano põe em fila as criações simultâneas (como na notificação).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`surto-numero:${ctx.tenant.id}:${ano}`}))`;
      const ultimo = await tx.outbreak.findFirst({ where: { year: ano }, orderBy: { seq: 'desc' }, select: { seq: true } });
      const seq = (ultimo?.seq ?? 0) + 1;
      const criado = await tx.outbreak.create({
        data: {
          year: ano,
          seq,
          number: `${ano}/${String(seq).padStart(4, '0')}`,
          category: corpo.categoria,
          groupKey: grupo,
          syndrome: sindrome,
          cid,
          agentText: corpo.agente?.trim() || null,
          notifiedOn: comoData(corpo.notificadoEm),
          knownAt: conhecido,
          dueAt: new Date(conhecido.getTime() + PRAZO_SURTO_HORAS * HORA),
          esp: corpo.esp ?? false,
          unitId: unidade.id,
          notifierId: ctx.session.userId,
          firstSymptomsOn: comoData(corpo.primeirosSintomasEm),
          casesCount: corpo.casos,
          initialPlace: corpo.localInicial,
          initialPlaceText: corpo.localInicialTexto?.trim() || null,
          ...this.dadosLocal(corpo.local),
          signal: sinal ?? undefined,
          createdBy: ctx.session.userId,
        },
      });
      await tx.outbreakEvent.create({
        data: { outbreakId: criado.id, kind: 'CRIADO', payload: { papel: ctx.session.role, categoria: corpo.categoria, casos: corpo.casos, assinatura: corpo.assinatura ?? null }, byUser: ctx.session.userId, at: agora },
      });
      for (const [i, p] of preparados.entries()) {
        await tx.outbreakCase.create({ data: { ...p.dados, outbreakId: criado.id, caseNumber: i + 1, createdBy: ctx.session.userId } });
        await tx.outbreakEvent.create({ data: { outbreakId: criado.id, kind: 'CASO_VINCULADO', payload: { caso: i + 1, ...p.evento }, byUser: ctx.session.userId, at: agora } });
      }
      await this.audit.record(ctx, tx, {
        action: 'vigilancia.surto_criar',
        entityType: 'Outbreak',
        entityId: criado.id,
        payload: { numero: criado.number, unidade: unidade.cnes, categoria: corpo.categoria, grupo, assinatura: corpo.assinatura ?? null, casos: preparados.length },
      });
      return criado;
    });
    await this.reconciliarNegativa(ctx, o.unitId, o.notifiedOn);
    const detalhe = await this.montarDetalhe(ctx, o.id);
    // Avisos dos casos indicados (ex.: notificação que já está em outro surto aberto) voltam junto, na criação.
    const extras = preparados.flatMap((p) => p.avisos);
    return extras.length ? { ...detalhe, avisos: [...new Set([...detalhe.avisos, ...extras])] } : detalhe;
  }

  /** GET /vigilancia/surtos/:id (com casos, eventos e espelho). */
  async detalhe(ctx: RequestContext, id: string): Promise<DetalheSurto> {
    const o = await this.carregar(ctx, id);
    return this.montarDetalhe(ctx, o.id);
  }

  /** PATCH /vigilancia/surtos/:id: campos da notificação, local, investigação e bloco DTA (só surto aberto). */
  async editar(ctx: RequestContext, id: string, corpo: CorpoEditarSurto): Promise<DetalheSurto> {
    const o = await this.carregar(ctx, id);
    this.exigirAberto(o);
    const hoje = localDateString(this.agora(), ctx.tenant.timeZone);
    const categoria = corpo.categoria ?? (o.category as CategoriaSurto);
    const grupo = corpo.grupo !== undefined ? corpo.grupo : o.groupKey;
    const sindrome = corpo.sindrome !== undefined ? corpo.sindrome : o.syndrome;
    const cid = corpo.cid !== undefined ? cidGuardado(corpo.cid) : o.cid;
    if (corpo.categoria !== undefined || corpo.grupo !== undefined || corpo.sindrome !== undefined) await this.validarAgravo(ctx.db, { categoria, grupo, sindrome });
    for (const [rotulo, v] of [
      ['notificação', corpo.notificadoEm],
      ['investigação', corpo.investigacao?.investigadoEm],
    ] as const)
      if (v && v > hoje) throw new DomainError('DATA_FUTURA', `A data da ${rotulo} não pode ser futura`, HttpStatus.BAD_REQUEST);
    const inv = corpo.investigacao;
    const veiculo = inv?.veiculo !== undefined ? inv.veiculo : o.vehicle;
    const veiculoTexto = inv?.veiculoTexto !== undefined ? inv.veiculoTexto : o.vehicleText;
    if (veiculo === '6' && !veiculoTexto?.trim()) throw new DomainError('SURTO_INVALIDO', 'Descreva o veículo de transmissão (Outro)', HttpStatus.BAD_REQUEST);
    if (corpo.dta && !(categoria === 'DTA' || veiculo === '1'))
      throw new DomainError('DTA_FORA_DE_LUGAR', 'O bloco de DTA é da ficha de surto de DTA (categoria DTA ou veículo alimento/água)', HttpStatus.UNPROCESSABLE_ENTITY);
    const investigadoEm = inv?.investigadoEm !== undefined ? inv.investigadoEm : dataIso(o.investigatedOn);
    const dados: DadosSurtoValidacao = {
      ...this.dadosValidacao(o),
      notificadoEm: corpo.notificadoEm ?? dataIso(o.notifiedOn),
      grupo,
      sindrome,
      cid,
      primeirosSintomasEm: corpo.primeirosSintomasEm ?? dataIso(o.firstSymptomsOn),
      casos: corpo.casos ?? o.casesCount,
      localInicial: corpo.localInicial ?? o.initialPlace,
      localInicialTexto: corpo.localInicialTexto !== undefined ? corpo.localInicialTexto : o.initialPlaceText,
      investigadoEm,
    };
    this.exigirValido(validarSurto(dados, investigadoEm ? 'INVESTIGACAO' : 'NOTIFICACAO'));
    await this.validarLocal(ctx.db, corpo.local);
    const data: TenantPrisma.OutbreakUpdateManyMutationInput = {
      category: categoria,
      groupKey: grupo,
      syndrome: sindrome,
      cid,
      ...(corpo.agente !== undefined ? { agentText: corpo.agente?.trim() || null } : {}),
      notifiedOn: comoData(dados.notificadoEm!),
      ...(corpo.esp !== undefined ? { esp: corpo.esp } : {}),
      firstSymptomsOn: comoData(dados.primeirosSintomasEm!),
      casesCount: dados.casos!,
      initialPlace: dados.localInicial!,
      initialPlaceText: dados.localInicialTexto?.trim() || null,
      ...this.dadosLocal(corpo.local),
    };
    if (inv) {
      if (inv.investigadoEm !== undefined) data.investigatedOn = inv.investigadoEm ? comoData(inv.investigadoEm) : null;
      if (inv.modoTransmissao !== undefined) data.transmission = inv.modoTransmissao;
      if (inv.veiculo !== undefined) data.vehicle = inv.veiculo;
      if (inv.veiculoTexto !== undefined) data.vehicleText = inv.veiculoTexto?.trim() || null;
      if (inv.observacoes !== undefined) data.observations = inv.observacoes;
      if (inv.investigadorNome !== undefined) data.investigatorName = inv.investigadorNome;
      if (inv.investigadorFuncao !== undefined) data.investigatorRole = inv.investigadorFuncao;
    }
    if (corpo.dta !== undefined) data.dta = corpo.dta === null ? TenantPrisma.DbNull : corpo.dta;
    const investigou = inv?.investigadoEm && inv.investigadoEm !== dataIso(o.investigatedOn);
    const campos = Object.keys(corpo).filter((k) => (corpo as Record<string, unknown>)[k] !== undefined);
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.outbreak.updateMany({ where: { id, status: 'ABERTO', updatedAt: o.updatedAt }, data });
      if (count !== 1) throw conflict('O surto mudou desde a leitura; abra de novo');
      await tx.outbreakEvent.create({
        data: { outbreakId: id, kind: investigou ? 'INVESTIGADO' : 'EDITADO', payload: { campos, ...(investigou ? { investigadoEm: inv!.investigadoEm } : {}) }, byUser: ctx.session.userId, at: this.agora() },
      });
      await this.audit.record(ctx, tx, { action: 'vigilancia.surto_editar', entityType: 'Outbreak', entityId: id, payload: { numero: o.number, campos } });
    });
    if (corpo.notificadoEm && corpo.notificadoEm !== dataIso(o.notifiedOn)) await this.reconciliarNegativa(ctx, o.unitId, comoData(corpo.notificadoEm));
    return this.montarDetalhe(ctx, id);
  }

  /** POST /vigilancia/surtos/:id/casos: notificação, registro oficial ou linha manual (NU_CASO sequencial). */
  async incluirCaso(ctx: RequestContext, id: string, corpo: CorpoCasoSurto): Promise<RespostaCasoSurto> {
    const o = await this.carregar(ctx, id);
    this.exigirAberto(o);
    const grupoDaLista = o.groupKey ? (await this.grupos(ctx.db, [o.groupKey])).has(o.groupKey) : false;
    const p = await this.prepararCaso(ctx, { id: o.id, grupo: o.groupKey, grupoDaLista, categoria: o.category as CategoriaSurto }, corpo);
    let casoId: string;
    try {
      casoId = await ctx.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`surto-caso:${o.id}`}))`;
        const ultimo = await tx.outbreakCase.findFirst({ where: { outbreakId: o.id }, orderBy: { caseNumber: 'desc' }, select: { caseNumber: true } });
        const numero = (ultimo?.caseNumber ?? 0) + 1;
        const c = await tx.outbreakCase.create({ data: { ...p.dados, outbreakId: o.id, caseNumber: numero, createdBy: ctx.session.userId }, select: { id: true } });
        await tx.outbreakEvent.create({ data: { outbreakId: o.id, kind: 'CASO_VINCULADO', payload: { caso: numero, ...p.evento }, byUser: ctx.session.userId, at: this.agora() } });
        await this.audit.record(ctx, tx, { action: 'vigilancia.surto_caso', entityType: 'Outbreak', entityId: o.id, payload: { numero: o.number, caso: numero, ...p.evento } });
        return c.id;
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw conflict('A notificação já está na planilha deste surto');
      throw err;
    }
    await this.reconciliarNegativa(ctx, o.unitId, o.notifiedOn);
    const detalhe = await this.montarDetalhe(ctx, o.id);
    return { caso: detalhe.planilha.find((c) => c.id === casoId)!, avisos: p.avisos };
  }

  /** DELETE /vigilancia/surtos/:id/casos/:caseId (o número do caso não é reaproveitado). */
  async retirarCaso(ctx: RequestContext, id: string, caseId: string): Promise<RespostaOk> {
    const o = await this.carregar(ctx, id);
    this.exigirAberto(o);
    const c = await ctx.db.outbreakCase.findFirst({ where: { id: caseId, outbreakId: o.id }, include: { notification: { select: { number: true } } } });
    if (!c) throw notFound('Caso do surto');
    await ctx.db.$transaction(async (tx) => {
      await tx.outbreakCase.delete({ where: { id: c.id } });
      const payload = { caso: c.caseNumber, notificacao: c.notification?.number ?? null, registro: c.officialRecordId };
      await tx.outbreakEvent.create({ data: { outbreakId: o.id, kind: 'CASO_RETIRADO', payload, byUser: ctx.session.userId, at: this.agora() } });
      await this.audit.record(ctx, tx, { action: 'vigilancia.surto_caso_retirar', entityType: 'Outbreak', entityId: o.id, payload: { numero: o.number, ...payload } });
    });
    return { ok: true };
  }

  /** POST /vigilancia/surtos/:id/comunicacoes (vira evento COMUNICADO). O núcleo comunica à SMS; SES e MS, a vigilância. */
  async comunicar(ctx: RequestContext, id: string, corpo: CorpoComunicacaoSurto): Promise<DetalheSurto> {
    const o = await this.carregar(ctx, id);
    if (o.status === 'DESCARTADO') throw new DomainError('SURTO_FECHADO', 'Surto descartado', HttpStatus.UNPROCESSABLE_ENTITY);
    if (!this.vigilanciaMunicipal(ctx) && corpo.alvo !== 'SMS') throw forbidden('O núcleo do estabelecimento comunica à SMS; o repasse à SES e ao MS é da vigilância municipal');
    const em = new Date(corpo.em);
    if (Number.isNaN(em.getTime())) throw new DomainError('DATA_INVALIDA', 'Instante da comunicação inválido', HttpStatus.BAD_REQUEST);
    if (em.getTime() > this.agora().getTime() + 60_000) throw new DomainError('DATA_FUTURA', 'A comunicação não pode ter data futura', HttpStatus.BAD_REQUEST);
    if (em.getTime() < o.knownAt.getTime()) throw new DomainError('DATA_INVALIDA', 'A comunicação não pode ser anterior ao conhecimento do surto', HttpStatus.BAD_REQUEST);
    const payload = { alvo: corpo.alvo, canal: corpo.canal, contraparte: corpo.contraparte.trim(), protocolo: corpo.protocolo ?? null, nota: corpo.nota ?? null, em: em.toISOString() };
    await ctx.db.$transaction(async (tx) => {
      await tx.outbreakEvent.create({ data: { outbreakId: o.id, kind: 'COMUNICADO', payload, byUser: ctx.session.userId, at: this.agora() } });
      await this.audit.record(ctx, tx, { action: 'vigilancia.surto_comunicar', entityType: 'Outbreak', entityId: o.id, payload: { numero: o.number, alvo: corpo.alvo, canal: corpo.canal } });
    });
    return this.montarDetalhe(ctx, o.id);
  }

  /** POST /vigilancia/surtos/:id/encerrar: delimitação (texto quando 11) e data ≥ notificação; exige a investigação. */
  async encerrar(ctx: RequestContext, id: string, corpo: CorpoEncerrarSurto): Promise<DetalheSurto> {
    const o = await this.carregar(ctx, id);
    this.exigirAberto(o);
    if (corpo.data > localDateString(this.agora(), ctx.tenant.timeZone)) throw new DomainError('DATA_FUTURA', 'O encerramento não pode ter data futura', HttpStatus.BAD_REQUEST);
    const texto = corpo.texto?.trim() || null;
    this.exigirValido(validarSurto({ ...this.dadosValidacao(o), delimitacao: corpo.delimitacao, delimitacaoTexto: texto, encerradoEm: corpo.data }, 'ENCERRAMENTO'));
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.outbreak.updateMany({
        where: { id: o.id, status: 'ABERTO' },
        data: { status: 'ENCERRADO', delimitation: corpo.delimitacao, delimitationText: texto, closedOn: comoData(corpo.data), closingNotes: corpo.notas?.trim() || null, closedBy: ctx.session.userId },
      });
      if (count !== 1) throw conflict('O surto mudou desde a leitura; abra de novo');
      await tx.outbreakEvent.create({ data: { outbreakId: o.id, kind: 'ENCERRADO', payload: { delimitacao: corpo.delimitacao, data: corpo.data }, byUser: ctx.session.userId, at: this.agora() } });
      await this.audit.record(ctx, tx, { action: 'vigilancia.surto_encerrar', entityType: 'Outbreak', entityId: o.id, payload: { numero: o.number, delimitacao: corpo.delimitacao, data: corpo.data } });
    });
    return this.montarDetalhe(ctx, o.id);
  }

  /** POST /vigilancia/surtos/:id/descartar (só a vigilância municipal; motivo com 10 ou mais caracteres). */
  async descartar(ctx: RequestContext, id: string, corpo: CorpoDescartarSurto): Promise<DetalheSurto> {
    if (!this.vigilanciaMunicipal(ctx)) throw forbidden('O descarte do surto é da vigilância epidemiológica municipal');
    const o = await this.carregar(ctx, id);
    this.exigirAberto(o);
    const motivo = corpo.motivo.trim();
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.outbreak.updateMany({ where: { id: o.id, status: 'ABERTO' }, data: { status: 'DESCARTADO', discardReason: motivo, discardedBy: ctx.session.userId, discardedAt: this.agora() } });
      if (count !== 1) throw conflict('O surto mudou desde a leitura; abra de novo');
      await tx.outbreakEvent.create({ data: { outbreakId: o.id, kind: 'DESCARTADO', payload: { motivo }, byUser: ctx.session.userId, at: this.agora() } });
      await this.audit.record(ctx, tx, { action: 'vigilancia.surto_descartar', entityType: 'Outbreak', entityId: o.id, payload: { numero: o.number, motivo } });
    });
    return this.montarDetalhe(ctx, o.id);
  }

  /** POST /vigilancia/surtos/:id/numero-oficial: NU_NOTIFIC do Sinan Net (1 a 7 dígitos). */
  async informarNumero(ctx: RequestContext, id: string, corpo: CorpoNumeroOficialSurto): Promise<DetalheSurto> {
    const numero = corpo.numero.trim();
    if (!/^\d{1,7}$/.test(numero)) throw new DomainError('NUMERO_INVALIDO', 'O número da notificação de surto no Sinan Net tem de 1 a 7 dígitos', HttpStatus.BAD_REQUEST);
    if (!roleHasPermission(ctx.session.role, 'vigilancia.digitar')) throw forbidden('O número do Sinan é informado por quem digita');
    const o = await this.carregar(ctx, id);
    if (o.status === 'DESCARTADO') throw new DomainError('SURTO_FECHADO', 'Surto descartado', HttpStatus.UNPROCESSABLE_ENTITY);
    // No Sinan Net, o número é da unidade: o mesmo número, na mesma unidade e data, é a mesma notificação.
    const repetido = await ctx.db.outbreak.findFirst({
      where: { id: { not: o.id }, officialNumber: numero, unitId: o.unitId, notifiedOn: o.notifiedOn, status: { not: 'DESCARTADO' } },
      select: { number: true },
    });
    if (repetido) throw conflict(`O número ${numero} já foi informado para o surto ${repetido.number} (mesma unidade e data)`);
    await ctx.db.$transaction(async (tx) => {
      await tx.outbreak.update({ where: { id: o.id }, data: { officialNumber: numero, enteredBy: ctx.session.userId, enteredAt: this.agora() } });
      await tx.outbreakEvent.create({ data: { outbreakId: o.id, kind: 'NUMERO_OFICIAL', payload: { numero, anterior: o.officialNumber }, byUser: ctx.session.userId, at: this.agora() } });
      await this.audit.record(ctx, tx, { action: 'vigilancia.surto_numero_oficial', entityType: 'Outbreak', entityId: o.id, payload: { numero: o.number, sinan: numero, anterior: o.officialNumber } });
    });
    return this.montarDetalhe(ctx, o.id);
  }

  /** GET /vigilancia/surtos/:id/espelho: as variáveis do dicionário de dados do Sinan (surto e planilha). */
  async espelho(ctx: RequestContext, id: string): Promise<EspelhoSurto> {
    const o = await this.carregar(ctx, id);
    return (await this.montarDetalhe(ctx, o.id)).espelho;
  }

  // ───────────────────────────── sugestões ─────────────────────────────

  /**
   * Casos para as regras: notificações não descartadas (nem encerradas como descartadas) conhecidas nos últimos 30 dias,
   * sem agravo sigiloso, com quarteirão e bairro pela residência e a unidade (hospitalar ou não). O histórico do evento
   * inusitado olha as notificações e os registros oficiais anteriores à janela; sem nenhum histórico, não é avaliado.
   */
  private async calcularSugestoes(ctx: RequestContext) {
    const agora = this.agora();
    const tz = ctx.tenant.timeZone;
    const hoje = localDateString(agora, tz);
    const desde = new Date(agora.getTime() - JANELA_SUGESTOES_DIAS * DIA);
    const avisos: string[] = [];
    const rows = await ctx.db.notification.findMany({
      where: {
        ...this.escopo(ctx),
        status: { in: ['RASCUNHO', 'NOTIFICADA', 'ENCERRADA'] },
        NOT: { status: 'ENCERRADA', finalClass: '2' },
        sensitive: false,
        knownAt: { gte: desde, lte: agora },
      },
      select: {
        id: true,
        number: true,
        groupKey: true,
        knownAt: true,
        symptomsOnset: true,
        unitId: true,
        patientId: true,
        residenceLat: true,
        residenceLng: true,
        residencePrecision: true,
        condition: { select: { name: true } },
      },
      orderBy: { knownAt: 'desc' },
      take: LIMITE_SUGESTOES,
    });
    if (rows.length === LIMITE_SUGESTOES) avisos.push(`Mais de ${LIMITE_SUGESTOES} notificações nos últimos ${JANELA_SUGESTOES_DIAS} dias: só as mais recentes entraram nas sugestões.`);
    const [territorio, unidades, emSurto] = await Promise.all([
      this.territorioDasNotificacoes(ctx.db, rows),
      ctx.db.unit.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.unitId))] } }, select: { id: true, name: true, type: true } }),
      ctx.db.outbreakCase.findMany({ where: { notificationId: { in: rows.map((r) => r.id) }, outbreak: { status: 'ABERTO' } }, select: { notificationId: true } }),
    ]);
    const semPosicao = rows.filter((r) => !territorio.get(r.id)?.temPosicao).length;
    if (semPosicao) avisos.push(`${semPosicao} notificação(ões) sem posição da residência ficaram fora das regras de quarteirão e bairro.`);
    const unidadePorId = new Map(unidades.map((u) => [u.id, u]));
    const jaEmSurto = new Set(emSurto.map((c) => c.notificationId));
    const casos: CasoParaSurto[] = rows.map((r) => ({
      id: r.id,
      numero: r.number,
      grupo: r.groupKey,
      conhecidoEm: r.knownAt.toISOString(),
      inicioSintomas: dataIso(r.symptomsOnset),
      blockId: territorio.get(r.id)?.blockId ?? null,
      neighborhoodId: territorio.get(r.id)?.neighborhoodId ?? null,
      unitId: r.unitId,
      unidadeHospitalar: unidadePorId.get(r.unitId)?.type === 'HOSPITAL',
      jaEmSurto: jaEmSurto.has(r.id),
    }));
    const grupos = [...new Set(casos.map((c) => c.grupo))];
    const historicoPorGrupo: Record<string, string | null> = {};
    const temHistorico = (await ctx.db.notification.count({ where: { knownAt: { lt: desde }, status: { not: 'DESCARTADA' } } })) > 0 || (await ctx.db.officialRecord.count({ where: { type: 'INDIVIDUAL' } })) > 0;
    if (!temHistorico) avisos.push(`Sem histórico anterior aos últimos ${JANELA_SUGESTOES_DIAS} dias: o evento inusitado (agravo ausente há muito tempo) não é avaliado.`);
    else if (grupos.length) {
      const limite = localDateString(desde, tz);
      const [omni, oficiais] = await Promise.all([
        ctx.db.$queryRaw<{ grupo: string; ultimo: Date | null }[]>`
          SELECT group_key AS grupo, max(COALESCE(symptoms_onset, (known_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date)) AS ultimo
          FROM notifications WHERE group_key = ANY(${grupos}::text[]) AND status <> 'DESCARTADA' AND known_at < ${desde} GROUP BY group_key`,
        ctx.db.$queryRaw<{ grupo: string; ultimo: Date | null }[]>`
          SELECT group_key AS grupo, max(COALESCE(symptoms_onset, notified_on)) AS ultimo
          FROM official_records WHERE type = 'INDIVIDUAL' AND NOT excluded AND group_key = ANY(${grupos}::text[]) AND COALESCE(symptoms_onset, notified_on) < ${limite}::date GROUP BY group_key`,
      ]);
      for (const g of grupos) {
        const datas = [...omni, ...oficiais].filter((x) => x.grupo === g && x.ultimo).map((x) => dataIso(x.ultimo)!);
        historicoPorGrupo[g] = datas.length ? datas.sort().at(-1)! : null;
      }
    }
    const dispensas = await ctx.db.outbreakDismissal.findMany({ select: { signature: true, untilKnownAt: true } });
    const cfg = ctx.tenant.settings.vigilancia.surto;
    const sugestoes = detectarAglomerados(casos, cfg.regras ?? REGRAS_SURTO_PADRAO, {
      hoje,
      dispensas: dispensas.map((d) => ({ assinatura: d.signature, ateConhecimento: d.untilKnownAt.toISOString() })),
      diasInusitado: cfg.diasInusitado,
      historicoPorGrupo,
    });
    return { sugestoes, rows, territorio, unidadePorId, avisos, hoje };
  }

  /** Excesso no diagrama por bairro e localidade (frente F3), isolado: a falha vira aviso, nunca derruba as sugestões. */
  private async excessosDoDiagrama(sys: SystemContext, hoje: string): Promise<{ excessos: ExcessoTerritorio[]; aviso: string | null }> {
    try {
      return { excessos: await this.diagramas.excessos(sys, GRUPOS_DIAGRAMA, hoje), aviso: null };
    } catch (err) {
      this.logger.warn(`Excessos do diagrama por território: ${(err as Error).message}`);
      return { excessos: [], aviso: 'O diagrama de controle por território não pôde ser calculado agora: os excessos de dengue, chikungunya e Zika ficaram de fora.' };
    }
  }

  /** GET /vigilancia/surtos/sugestoes: `detectarAglomerados` + excessos do diagrama por território. */
  async sugestoes(ctx: RequestContext): Promise<RespostaSugestoesSurto> {
    const { sugestoes, rows, territorio, unidadePorId, avisos, hoje } = await this.calcularSugestoes(ctx);
    const blocosIds = [...new Set(sugestoes.filter((s) => s.vinculo.tipo === 'QUARTEIRAO').map((s) => s.vinculo.id))];
    const bairrosIds = [...new Set([...sugestoes.filter((s) => s.vinculo.tipo === 'BAIRRO').map((s) => s.vinculo.id), ...[...territorio.values()].map((t) => t.neighborhoodId).filter((x): x is string => !!x)])];
    const [blocos, bairros] = await Promise.all([
      blocosIds.length ? ctx.db.block.findMany({ where: { id: { in: blocosIds } }, select: { id: true, number: true, locality: { select: { name: true } } } }) : [],
      bairrosIds.length ? ctx.db.neighborhood.findMany({ where: { id: { in: bairrosIds } }, select: { id: true, name: true } }) : [],
    ]);
    const nomeBloco = new Map(blocos.map((b) => [b.id, `Quarteirão ${b.number} (${b.locality.name})`]));
    const nomeBairro = new Map(bairros.map((b) => [b.id, b.name]));
    const porId = new Map(rows.map((r) => [r.id, r]));
    const tela: SugestaoSurtoTela[] = sugestoes.map((s: SugestaoSurto) => ({
      ...s,
      vinculoNome:
        s.vinculo.tipo === 'QUARTEIRAO'
          ? (nomeBloco.get(s.vinculo.id) ?? 'Quarteirão')
          : s.vinculo.tipo === 'BAIRRO'
            ? (nomeBairro.get(s.vinculo.id) ?? 'Bairro')
            : s.vinculo.tipo === 'UNIDADE'
              ? (unidadePorId.get(s.vinculo.id)?.name ?? 'Unidade')
              : 'Município',
      casosDetalhe: s.casos
        .map((id) => porId.get(id))
        .filter((r): r is NonNullable<typeof r> => !!r)
        .map((r) => ({
          id: r.id,
          numero: r.number,
          agravo: r.condition.name,
          unidade: unidadePorId.get(r.unitId)?.name ?? '',
          bairro: territorio.get(r.id)?.neighborhoodId ? (nomeBairro.get(territorio.get(r.id)!.neighborhoodId!) ?? null) : null,
          inicioSintomas: dataIso(r.symptomsOnset),
          conhecidoEm: r.knownAt.toISOString(),
        })),
    }));
    const { excessos, aviso } = await this.excessosDoDiagrama(ctx, hoje);
    return { sugestoes: tela, excessos, avisos: aviso ? [...avisos, aviso] : avisos };
  }

  /** POST /vigilancia/surtos/sugestoes/dispensar: vale até aparecer caso conhecido depois do último da sugestão. */
  async dispensarSugestao(ctx: RequestContext, corpo: CorpoDispensarSugestao): Promise<RespostaOk> {
    const { sugestoes } = await this.calcularSugestoes(ctx);
    const s = sugestoes.find((x) => x.assinatura === corpo.assinatura);
    if (!s) throw new DomainError('NAO_ENCONTRADO', 'Sugestão não encontrada: já dispensada, já virou surto ou ficou sem casos', HttpStatus.NOT_FOUND);
    const motivo = corpo.motivo.trim();
    await ctx.db.$transaction(async (tx) => {
      const d = await tx.outbreakDismissal.create({
        data: {
          signature: s.assinatura,
          ruleId: s.regra.slice(0, 40),
          groupKey: s.grupo.slice(0, 40),
          linkKind: s.vinculo.tipo,
          linkId: s.vinculo.id,
          untilKnownAt: new Date(s.ultimoConhecimento),
          reason: motivo,
          dismissedBy: ctx.session.userId,
          dismissedAt: this.agora(),
        },
        select: { id: true },
      });
      await this.audit.record(ctx, tx, { action: 'vigilancia.surto_sugestao_dispensar', entityType: 'OutbreakDismissal', entityId: d.id, payload: { assinatura: s.assinatura, casos: s.casos.length, motivo } });
    });
    return { ok: true };
  }
}
