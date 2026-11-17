/**
 * Notificação de surto (VIG-1c): tipo 3 da Ficha de Notificação do Sinan Net, sem paciente, com a planilha de
 * acompanhamento (uma linha por caso) e a investigação. Domínios da ficha e do dicionário de dados (Investigação de
 * Surto v5), regras de sugestão de aglomerado (o sistema sugere, a vigilância confirma) e a validação de cada etapa
 * pelo Manual de Normas e Rotinas do Sinan (2007), item 5.3.1. Ver contingencia-surto-negativa.md, A13 a A26.
 */
import { localDateString } from '../dates';

/** Campo 19 da ficha (CS_LOCAL): local inicial de ocorrência. */
export const LOCAL_INICIAL_SURTO: Record<string, string> = {
  '1': 'Residência',
  '2': 'Hospital/Unidade de Saúde',
  '3': 'Creche/Escola',
  '4': 'Asilo',
  '5': 'Outras instituições',
  '6': 'Restaurante/Padaria',
  '7': 'Eventos',
  '8': 'Casos dispersos no bairro',
  '9': 'Casos dispersos pelo município',
  '10': 'Casos dispersos em mais de um município',
  '11': 'Outros',
};

/** Delimitação espacial no encerramento (DELIMITA): as mesmas 11 categorias do local inicial. */
export const DELIMITACAO_SURTO: Record<string, string> = { ...LOCAL_INICIAL_SURTO };

/** Campo 25 (CS_TRANS): modo provável de transmissão. */
export const MODO_TRANSMISSAO: Record<string, string> = { '1': 'Direta', '2': 'Indireta', '9': 'Ignorado' };

/** Campo 26 (TP_INDIRET guarda o código; CS_VEICULO, o texto do "outro"): veículo de transmissão. */
export const VEICULO_TRANSMISSAO: Record<string, string> = {
  '1': 'Alimento/água',
  '2': 'Recursos hídricos contaminados',
  '3': 'Vetor',
  '4': 'Produto',
  '5': 'Fômite',
  '6': 'Outro',
  '9': 'Ignorado',
};

/**
 * Síndromes do surto de agravo inusitado (abordagem sindrômica do Sinan). O código vem só de fonte secundária (tabela
 * de agravos de um Sinan Net de terceiros): conferir com um NSURTNET real antes de exportar.
 */
export const SINDROMES_SURTO: Record<string, { nome: string; codigo: string | null }> = {
  DIARREICA_AGUDA_SANGUINOLENTA: { nome: 'Síndrome diarreica aguda sanguinolenta', codigo: 'A08' },
  ICTERICA_AGUDA: { nome: 'Síndrome ictérica aguda', codigo: 'R17' },
  FEBRE_HEMORRAGICA_AGUDA: { nome: 'Síndrome de febre hemorrágica aguda', codigo: 'D699' },
  RESPIRATORIA_AGUDA: { nome: 'Síndrome respiratória aguda', codigo: 'J07' },
  NEUROLOGICA_AGUDA: { nome: 'Síndrome neurológica aguda', codigo: 'G043' },
  INSUFICIENCIA_RENAL_AGUDA: { nome: 'Síndrome da insuficiência renal aguda', codigo: 'N199' },
  OUTRAS: { nome: 'Outras síndromes', codigo: 'R699' },
};

/** Planilha de acompanhamento (CLASSI_FIN do caso). */
export const CLASSIFICACAO_CASO_SURTO: Record<string, string> = { '1': 'Confirmado', '2': 'Descartado', '3': 'Inconclusivo' };

/**
 * Critério de confirmação do caso, pelo dicionário de dados. A legenda da planilha impressa diverge (1 laboratorial,
 * 2 clínico-epidemiológico, 3 clínico): conferir com um NSURTNET real.
 */
export const CRITERIO_CASO_SURTO: Record<string, string> = {
  '1': 'Clínico-epidemiológico',
  '2': 'Laboratorial clínico',
  '3': 'Laboratorial bromatológico',
  '4': 'Laboratorial clínico-bromatológico',
  '5': 'Inconclusivo',
};

/** Unidade da idade na planilha (NU_IDADE_N do Sinan: 1 hora, 2 dia, 3 mês, 4 ano) e o máximo aceito em cada uma. */
export const UNIDADES_IDADE_CASO: Record<'H' | 'D' | 'M' | 'A', { codigo: string; um: string; varios: string; max: number }> = {
  H: { codigo: '1', um: 'hora', varios: 'horas', max: 23 },
  D: { codigo: '2', um: 'dia', varios: 'dias', max: 31 },
  M: { codigo: '3', um: 'mês', varios: 'meses', max: 11 },
  A: { codigo: '4', um: 'ano', varios: 'anos', max: 130 },
};

/**
 * Idade da linha da planilha como número + unidade do Sinan (H, D, M, A): "34", "34 anos", "34A" → "34A"; "5 meses",
 * "5m" → "5M"; "10 dias" → "10D"; "12 horas" → "12H". Nulo quando o texto não é idade ou passa do máximo da unidade.
 */
export function normalizarIdade(texto: string): string | null {
  const t = texto.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const m = /^(\d{1,3})\s*([a-z]*)\.?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const u = ['', 'a', 'ano', 'anos'].includes(m[2]!) ? 'A' : ['m', 'mes', 'meses'].includes(m[2]!) ? 'M' : ['d', 'dia', 'dias'].includes(m[2]!) ? 'D' : ['h', 'hora', 'horas'].includes(m[2]!) ? 'H' : null;
  if (!u || n > UNIDADES_IDADE_CASO[u].max) return null;
  return `${n}${u}`;
}

/** A idade digitada na linha manual é aceita (a mesma regra da API: número e unidade, dentro do máximo da unidade). */
export function idadeValida(texto: string): boolean {
  return normalizarIdade(texto) !== null;
}

/** Tipo do campo do bloco DTA: inteiro, texto livre, data (AAAA-MM-DD) ou critério (código do dicionário). */
export type TipoCampoDta = 'numero' | 'texto' | 'data' | 'criterio';

/**
 * Bloco da ficha de surto de DTA, resumido (campos 27 a 60): as variáveis do dicionário que o sistema conhece
 * (DIC_DADOS_Surto_DTA_v5). Gravadas com datas em AAAA-MM-DD e o critério com os códigos do dicionário; o espelho
 * mostra as datas em dd/mm/aaaa. Outras variáveis podem ser gravadas, sem conferência de tipo.
 */
export const CAMPOS_DTA: { variavel: string; rotulo: string; tipo: TipoCampoDta }[] = [
  { variavel: 'NU_ENTR', rotulo: 'Nº de entrevistados', tipo: 'numero' },
  { variavel: 'NU_ENT_DOE', rotulo: 'Nº de doentes entrevistados', tipo: 'numero' },
  { variavel: 'NU_TOT', rotulo: 'Total de doentes', tipo: 'numero' },
  { variavel: 'NU_TOT_HOS', rotulo: 'Nº de hospitalizados', tipo: 'numero' },
  { variavel: 'NU_OBITO', rotulo: 'Nº de óbitos', tipo: 'numero' },
  { variavel: 'TP_PRO_PRE', rotulo: 'Local de produção/preparação', tipo: 'texto' },
  { variavel: 'ST_ALIMEN', rotulo: 'Local de ingestão', tipo: 'texto' },
  { variavel: 'DS_ETIOLOG', rotulo: 'Agente etiológico', tipo: 'texto' },
  { variavel: 'DS_ALICAUS', rotulo: 'Alimento causador', tipo: 'texto' },
  { variavel: 'CRITERIO', rotulo: 'Critério de confirmação', tipo: 'criterio' },
  { variavel: 'DT_ENCERRA', rotulo: 'Data de encerramento (DTA)', tipo: 'data' },
];

/** Data civil AAAA-MM-DD que existe no calendário (31/02 não). */
function dataCivilValida(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}

/**
 * Erros do bloco DTA nas variáveis conhecidas (`CAMPOS_DTA`): número inteiro de 0 a 9.999.999, data AAAA-MM-DD válida
 * e não futura (`hoje` no fuso da instituição) e critério do dicionário (1 a 5). Valor vazio ou nulo não é conferido.
 */
export function errosDta(dta: Record<string, string | number | null>, hoje: string): string[] {
  const erros: string[] = [];
  for (const campo of CAMPOS_DTA) {
    const bruto = dta[campo.variavel];
    if (bruto === null || bruto === undefined) continue;
    const v = typeof bruto === 'number' ? bruto : bruto.trim();
    if (v === '') continue;
    if (campo.tipo === 'numero' && !(typeof v === 'number' ? Number.isInteger(v) && v >= 0 && v <= 9_999_999 : /^\d{1,7}$/.test(v))) erros.push(`DTA, ${campo.rotulo}: número inteiro.`);
    if (campo.tipo === 'data' && (typeof v !== 'string' || !dataCivilValida(v) || v > hoje)) erros.push(`DTA, ${campo.rotulo}: data válida e não futura.`);
    if (campo.tipo === 'criterio' && !CRITERIO_CASO_SURTO[String(v)]) erros.push(`DTA, ${campo.rotulo}: código de 1 a 5.`);
  }
  return erros;
}

/** Por que o surto vai ao módulo de surto do Sinan (manual 3.1.1 e 5.3.1). */
export type CategoriaSurto = 'SINDROMICO' | 'FORA_DA_LISTA' | 'DA_LISTA' | 'DTA';

export const CATEGORIA_SURTO: Record<CategoriaSurto, string> = {
  SINDROMICO: 'Agravo inusitado (pela síndrome)',
  FORA_DA_LISTA: 'Doença fora da lista nacional',
  DA_LISTA: 'Doença da lista (registro agregado)',
  DTA: 'Doença transmitida por alimento (DTA)',
};

export type StatusSurto = 'ABERTO' | 'ENCERRADO' | 'DESCARTADO';

export const ROTULO_STATUS_SURTO: Record<StatusSurto, string> = { ABERTO: 'Aberto', ENCERRADO: 'Encerrado', DESCARTADO: 'Descartado' };

/** Eventos da linha do tempo do surto. */
export type TipoEventoSurto = 'CRIADO' | 'EDITADO' | 'COMUNICADO' | 'CASO_VINCULADO' | 'CASO_RETIRADO' | 'INVESTIGADO' | 'ENCERRADO' | 'DESCARTADO' | 'NUMERO_OFICIAL';

export const ROTULO_EVENTO_SURTO: Record<TipoEventoSurto, string> = {
  CRIADO: 'Notificação do surto',
  EDITADO: 'Edição',
  COMUNICADO: 'Comunicação',
  CASO_VINCULADO: 'Caso incluído',
  CASO_RETIRADO: 'Caso retirado',
  INVESTIGADO: 'Investigação',
  ENCERRADO: 'Encerramento',
  DESCARTADO: 'Descarte',
  NUMERO_OFICIAL: 'Número do Sinan',
};

/** Prazo da notificação de surto à SMS, contado do conhecimento (imediata; ESP também à SES e ao MS). */
export const PRAZO_SURTO_HORAS = 24;

/** Vínculo entre os casos de um aglomerado. */
export type TipoVinculoSurto = 'QUARTEIRAO' | 'BAIRRO' | 'UNIDADE';

/** Regra de sugestão de surto. */
export interface RegraSurto {
  id: string;
  /** Grupos do catálogo; ['*'] = qualquer. */
  grupos: string[];
  excetoGrupos?: string[];
  vinculo: TipoVinculoSurto;
  /** Casos na janela para sugerir. */
  minimo: number;
  janelaDias: number;
  /** Só unidade hospitalar (ex.: varicela em ambiente hospitalar). Acréscimo da fundação ao desenho; a F1 pode trocar. */
  soUnidadeHospitalar?: boolean;
  descricao: string;
  fonte: string;
}

/**
 * Grupos que nunca viram sugestão de surto: violências, agravos relacionados ao trabalho e condições crônicas ou
 * congênitas, em que dois casos perto não indicam transmissão (o surto é de doença transmissível: Manual de Normas e
 * Rotinas do Sinan, 2007, Anexo A). Ficam fora das regras de quarteirão e bairro e do evento inusitado.
 */
export const GRUPOS_SEM_SUGESTAO_DE_SURTO = [
  'violencia',
  'violencia-sexual-suicidio',
  'acidente-trabalho',
  'acidente-trabalho-biologico',
  'cancer-trabalho',
  'dermatoses-ocupacionais',
  'disturbio-voz-trabalho',
  'ler-dort',
  'perda-auditiva-trabalho',
  'pneumoconioses-trabalho',
  'transtornos-mentais-trabalho',
  'aids',
  'hiv',
  'hiv-gestacao',
  'htlv',
  'htlv-gestacao',
  'sifilis',
  'hepatite-b-gestacao',
  'chagas-cronica',
  'hanseniase',
  'tuberculose',
  'anomalias-congenitas',
  'doenca-falciforme',
  'obito-infantil-materno',
];

const GVS_V1 = 'Guia de Vigilância em Saúde, 6ª ed. revisada (MS, 2024), v. 1';

/**
 * Regras padrão (configuráveis em `vigilancia.surto.regras`). Dengue, chikungunya e Zika ficam fora das regras de
 * vizinhança: o excesso delas aparece no diagrama de controle por território.
 */
export const REGRAS_SURTO_PADRAO: RegraSurto[] = [
  {
    id: 'quarteirao-7d',
    grupos: ['*'],
    excetoGrupos: ['dengue', 'chikungunya', 'zika', ...GRUPOS_SEM_SUGESTAO_DE_SURTO],
    vinculo: 'QUARTEIRAO',
    minimo: 2,
    janelaDias: 7,
    descricao: 'Dois ou mais casos do mesmo agravo no mesmo quarteirão em 7 dias',
    fonte: `${GVS_V1}: surto de DDA com 2 ou mais casos relacionados (p. 397) e definição geral de surto (p. 426); o quarteirão e a janela de 7 dias são parâmetros locais`,
  },
  {
    id: 'bairro-7d',
    grupos: ['*'],
    excetoGrupos: ['dengue', 'chikungunya', 'zika', ...GRUPOS_SEM_SUGESTAO_DE_SURTO],
    vinculo: 'BAIRRO',
    minimo: 2,
    janelaDias: 7,
    descricao: 'Dois ou mais casos do mesmo agravo no mesmo bairro em 7 dias',
    fonte: `${GVS_V1}: surto de DDA com 2 ou mais casos relacionados (p. 397) e definição geral de surto (p. 426); o bairro e a janela de 7 dias são parâmetros locais`,
  },
  {
    id: 'varicela-hospitalar',
    grupos: ['varicela'],
    vinculo: 'UNIDADE',
    minimo: 1,
    janelaDias: 21,
    soUnidadeHospitalar: true,
    descricao: 'Caso de varicela atendido em unidade hospitalar',
    fonte: `${GVS_V1}: em ambiente hospitalar, um único caso confirmado de varicela já é surto (p. 354); o surto é controlado após 21 dias sem casos novos (p. 357)`,
  },
  {
    id: 'sindrome-gripal-unidade-7d',
    grupos: ['covid'],
    vinculo: 'UNIDADE',
    minimo: 3,
    janelaDias: 7,
    descricao: 'Três ou mais casos de síndrome gripal (covid-19) na mesma unidade em 7 dias',
    fonte: `${GVS_V1}: surto de síndrome gripal com pelo menos 3 casos em ambiente fechado ou restrito e até 7 dias entre os inícios dos sintomas (p. 93)`,
  },
];

/** Caso candidato a aglomerado (notificação não descartada). Datas: `conhecidoEm` ISO; `inicioSintomas` AAAA-MM-DD. */
export interface CasoParaSurto {
  id: string;
  numero: string;
  grupo: string;
  conhecidoEm: string;
  inicioSintomas: string | null;
  blockId: string | null;
  neighborhoodId: string | null;
  unitId: string;
  unidadeHospitalar: boolean;
  /**
   * Já ligado a surto (aberto, encerrado ou descartado): não entra nas sugestões, mas conta como caso anterior do
   * grupo no evento inusitado.
   */
  jaEmSurto: boolean;
}

/**
 * Sugestão dispensada: vale enquanto todos os casos foram conhecidos até `ateConhecimento` (ISO). `unitId` é o escopo
 * de quem dispensou: nulo (ou ausente) para a vigilância municipal, que vale para todos; com a unidade do núcleo, só
 * esconde a sugestão cujos casos sejam todos daquela unidade (quem chama passa só as dispensas da visão de quem lê).
 */
export interface DispensaSurto {
  assinatura: string;
  ateConhecimento: string;
  unitId?: string | null;
}

export interface OpcoesDeteccaoSurto {
  /** AAAA-MM-DD, no fuso da instituição. */
  hoje: string;
  /** Fuso da instituição (IANA): o dia em que o caso sem início dos sintomas foi conhecido é o dia local. */
  fuso: string;
  dispensas: DispensaSurto[];
  /** Dias sem caso do grupo para o primeiro caso virar "evento inusitado". */
  diasInusitado: number;
  /** Último caso de cada grupo antes da janela (AAAA-MM-DD; null = nunca visto). */
  historicoPorGrupo: Record<string, string | null>;
  /**
   * Datas (AAAA-MM-DD) dos outros casos do grupo na janela que não entram nas sugestões de quem lê (de outra unidade,
   * na visão do núcleo, ou sob sigilo): contam só como caso anterior no evento inusitado.
   */
  outrosCasosPorGrupo?: Record<string, string[]>;
  /**
   * Datas (AAAA-MM-DD) dos outros casos do grupo na janela que quem lê não vê e que já estão ligados a surto: contam
   * como caso anterior no evento inusitado qualquer que seja a data (como o `jaEmSurto` dos casos que ele vê).
   */
  outrosEmSurtoPorGrupo?: Record<string, string[]>;
}

/**
 * Grupos que as regras de vizinhança alcançam. Com uma regra para qualquer grupo (['*']), todos menos `exceto`; sem
 * ela, só `grupos`. Quem lê as notificações para as regras deixa os demais de fora (eles só entram no evento inusitado).
 */
export type AlcanceRegrasSurto = { todos: true; exceto: string[] } | { todos: false; grupos: string[] };

/** Alcance das regras em vigor (as da instituição ou as padrão): ver `AlcanceRegrasSurto`. */
export function alcanceDasRegras(regras: RegraSurto[]): AlcanceRegrasSurto {
  const alcanca = (r: RegraSurto, grupo: string) => (r.grupos.includes('*') || r.grupos.includes(grupo)) && !r.excetoGrupos?.includes(grupo);
  if (regras.some((r) => r.grupos.includes('*'))) {
    // Só o grupo de fora de todas as regras gerais (e de nenhuma específica) fica sem regra.
    const candidatos = new Set(regras.flatMap((r) => r.excetoGrupos ?? []));
    return { todos: true, exceto: [...candidatos].filter((g) => !regras.some((r) => alcanca(r, g))).sort() };
  }
  return { todos: false, grupos: [...new Set(regras.flatMap((r) => r.grupos.filter((g) => alcanca(r, g))))].sort() };
}

/** O grupo é alcançado por alguma regra (pelo resultado de `alcanceDasRegras`). */
export function grupoNoAlcance(alcance: AlcanceRegrasSurto, grupo: string): boolean {
  return alcance.todos ? !alcance.exceto.includes(grupo) : alcance.grupos.includes(grupo);
}

/** Sugestão de surto. Assinatura = `${regra}|${vinculo}:${id}|${grupo}`. O evento inusitado usa o vínculo MUNICIPIO. */
export interface SugestaoSurto {
  assinatura: string;
  regra: string;
  descricao: string;
  grupo: string;
  vinculo: { tipo: TipoVinculoSurto | 'MUNICIPIO'; id: string };
  /** Ids das notificações. */
  casos: string[];
  primeiroSintoma: string | null;
  ultimoConhecimento: string;
  fonte: string;
}

const DIA = 86_400_000;
const dia = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/**
 * Aglomerado mais recente: casos em cadeia (cada um a até `janelaDias` do anterior) com pelo menos `minimo` deles
 * dentro de uma mesma janela de `janelaDias`. A cadeia inteira entra na sugestão (o surto em curso passa da janela).
 */
function aglomeradoMaisRecente(casos: CasoParaSurto[], minimo: number, janelaDias: number, data: (c: CasoParaSurto) => number): CasoParaSurto[] | null {
  const ordenados = [...casos].sort((a, b) => data(a) - data(b) || Date.parse(a.conhecidoEm) - Date.parse(b.conhecidoEm));
  const cadeias: CasoParaSurto[][] = [];
  for (const c of ordenados) {
    const ultima = cadeias[cadeias.length - 1];
    if (ultima && data(c) - data(ultima[ultima.length - 1]!) <= janelaDias * DIA) ultima.push(c);
    else cadeias.push([c]);
  }
  for (let i = cadeias.length - 1; i >= 0; i--) {
    const cadeia = cadeias[i]!;
    for (let fim = 0, ini = 0; fim < cadeia.length; fim++) {
      while (data(cadeia[fim]!) - data(cadeia[ini]!) > janelaDias * DIA) ini++;
      if (fim - ini + 1 >= Math.max(1, minimo)) return cadeia;
    }
  }
  return null;
}

function sugestao(regra: string, descricao: string, fonte: string, grupo: string, vinculo: SugestaoSurto['vinculo'], casos: CasoParaSurto[]): SugestaoSurto {
  const sintomas = casos.map((c) => c.inicioSintomas).filter((d): d is string => !!d);
  return {
    assinatura: `${regra}|${vinculo.tipo}:${vinculo.id}|${grupo}`,
    regra,
    descricao,
    grupo,
    vinculo,
    casos: casos.map((c) => c.id),
    primeiroSintoma: sintomas.length ? sintomas.reduce((a, b) => (b < a ? b : a)) : null,
    ultimoConhecimento: casos.reduce((a, c) => (Date.parse(c.conhecidoEm) > Date.parse(a.conhecidoEm) ? c : a)).conhecidoEm,
    fonte,
  };
}

/**
 * Sugestões de surto (o sistema sugere, a vigilância confirma). Casos já ligados a surto (de qualquer situação) não
 * entram; uma sugestão por (regra, vínculo, grupo), com o aglomerado mais recente; a dispensada volta quando aparece
 * caso conhecido depois do `ateConhecimento`, e a do núcleo só esconde sugestão com todos os casos da unidade dele.
 * Evento inusitado: o primeiro caso de um grupo depois de `diasInusitado` dias sem casos (ou nunca visto) vira sugestão
 * própria; caso anterior é o do histórico, o de `outrosCasosPorGrupo` com data até a do primeiro e todo caso da janela
 * já ligado a surto (`jaEmSurto` e `outrosEmSurtoPorGrupo`), qualquer que seja a data: o evento que já virou surto não
 * volta como "primeiro caso", nem quando a busca ativa acha depois um caso com início anterior. Grupo fora de
 * `historicoPorGrupo` não é avaliado. A data do caso é o início dos sintomas ou, sem ele, o dia (no `fuso`) em que foi
 * conhecido; caso com data depois de `hoje` (erro de digitação) fica de fora das sugestões.
 */
export function detectarAglomerados(casos: CasoParaSurto[], regras: RegraSurto[], opcoes: OpcoesDeteccaoSurto): SugestaoSurto[] {
  const hoje = dia(opcoes.hoje);
  const datas = new Map(casos.map((c) => [c.id, dia(c.inicioSintomas ?? localDateString(new Date(c.conhecidoEm), opcoes.fuso))]));
  const data = (c: CasoParaSurto) => datas.get(c.id)!;
  const datados = casos.filter((c) => data(c) <= hoje);
  const validos = datados.filter((c) => !c.jaEmSurto);
  const porId = new Map(validos.map((c) => [c.id, c]));
  const sugestoes: SugestaoSurto[] = [];
  for (const regra of regras) {
    const grupos = new Map<string, { id: string; grupo: string; casos: CasoParaSurto[] }>();
    for (const c of validos) {
      if (!(regra.grupos.includes('*') || regra.grupos.includes(c.grupo)) || regra.excetoGrupos?.includes(c.grupo)) continue;
      if (regra.soUnidadeHospitalar && !c.unidadeHospitalar) continue;
      const id = regra.vinculo === 'QUARTEIRAO' ? c.blockId : regra.vinculo === 'BAIRRO' ? c.neighborhoodId : c.unitId;
      if (!id) continue;
      const chave = `${id}|${c.grupo}`;
      const g = grupos.get(chave) ?? { id, grupo: c.grupo, casos: [] };
      g.casos.push(c);
      grupos.set(chave, g);
    }
    for (const g of grupos.values()) {
      const aglomerado = aglomeradoMaisRecente(g.casos, regra.minimo, regra.janelaDias, data);
      if (aglomerado) sugestoes.push(sugestao(regra.id, regra.descricao, regra.fonte, g.grupo, { tipo: regra.vinculo, id: g.id }, aglomerado));
    }
  }
  // Evento inusitado: o caso já ligado a surto não vira sugestão, mas é caso anterior em qualquer data (sur-4): o caso
  // seguinte não é o "primeiro", e o achado depois com início anterior ao do surto também não.
  const porGrupo = new Map<string, CasoParaSurto[]>();
  for (const c of datados) if (!c.jaEmSurto && !GRUPOS_SEM_SUGESTAO_DE_SURTO.includes(c.grupo)) porGrupo.set(c.grupo, [...(porGrupo.get(c.grupo) ?? []), c]);
  const emSurtoPorGrupo = new Map<string, number[]>();
  for (const c of casos) if (c.jaEmSurto) emSurtoPorGrupo.set(c.grupo, [...(emSurtoPorGrupo.get(c.grupo) ?? []), data(c)]);
  for (const [grupo, lista] of porGrupo) {
    if (!(grupo in opcoes.historicoPorGrupo)) continue;
    const candidatos = lista.sort((a, b) => data(a) - data(b) || Date.parse(a.conhecidoEm) - Date.parse(b.conhecidoEm));
    const primeiro = data(candidatos[0]!);
    const historico = opcoes.historicoPorGrupo[grupo];
    const anteriores = [
      ...(historico ? [dia(historico)] : []),
      ...(emSurtoPorGrupo.get(grupo) ?? []),
      ...(opcoes.outrosEmSurtoPorGrupo?.[grupo] ?? []).map(dia),
      ...(opcoes.outrosCasosPorGrupo?.[grupo] ?? []).map(dia).filter((d) => d <= primeiro),
    ];
    const ultimo = anteriores.length ? Math.max(...anteriores) : null;
    const intervalo = ultimo === null ? Infinity : (primeiro - ultimo) / DIA;
    if (intervalo > opcoes.diasInusitado)
      sugestoes.push(
        sugestao(
          'inusitado',
          ultimo === null ? 'Primeiro caso do agravo registrado no município: evento inusitado' : `Primeiro caso do agravo depois de ${opcoes.diasInusitado} dias sem casos: evento inusitado`,
          'Manual de Normas e Rotinas do Sinan (2007), Anexo A, p. 55: um só caso de doença transmissível ausente há muito tempo, ou nova na região, pede notificação imediata e investigação',
          grupo,
          { tipo: 'MUNICIPIO', id: 'municipio' },
          candidatos,
        ),
      );
  }
  const dispensada = (s: SugestaoSurto) =>
    opcoes.dispensas.some(
      (d) =>
        d.assinatura === s.assinatura &&
        s.casos.every((id) => {
          const c = porId.get(id)!;
          return Date.parse(c.conhecidoEm) <= Date.parse(d.ateConhecimento) && (!d.unitId || c.unitId === d.unitId);
        }),
    );
  return sugestoes.filter((s) => !dispensada(s)).sort((a, b) => Date.parse(b.ultimoConhecimento) - Date.parse(a.ultimoConhecimento) || a.assinatura.localeCompare(b.assinatura));
}

export type EtapaSurto = 'NOTIFICACAO' | 'INVESTIGACAO' | 'ENCERRAMENTO';

/** Campos que a validação lê (datas AAAA-MM-DD). */
export interface DadosSurtoValidacao {
  notificadoEm: string | null;
  unitId: string | null;
  grupo: string | null;
  sindrome: string | null;
  cid: string | null;
  primeirosSintomasEm: string | null;
  casos: number | null;
  localInicial: string | null;
  localInicialTexto: string | null;
  investigadoEm?: string | null;
  delimitacao?: string | null;
  delimitacaoTexto?: string | null;
  encerradoEm?: string | null;
}

/**
 * Pendências da etapa (manual 5.3.1 i): data, unidade, agravo/síndrome ou CID, primeiros sintomas do 1º caso, nº de
 * casos ≥ 1, local inicial 1-11 (texto quando 11); investigação exige DT_INVEST (não antes da notificação);
 * encerramento exige delimitação (texto quando 11) e data ≥ notificação; sintomas ≤ notificação. As etapas acumulam:
 * a investigação também confere a notificação, e o encerramento confere as duas.
 */
export function validarSurto(s: DadosSurtoValidacao, etapa: EtapaSurto): string[] {
  const erros: string[] = [];
  const data = (v: string | null | undefined) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  // Notificação (manual 5.3.1 i): campos sem os quais a notificação não entra no Sinan.
  if (!data(s.notificadoEm)) erros.push('Informe a data da notificação');
  if (!s.unitId) erros.push('Informe a unidade notificante');
  if (!s.grupo && !s.sindrome && !s.cid?.trim()) erros.push('Informe o agravo, a síndrome ou o CID do surto');
  if (!data(s.primeirosSintomasEm)) erros.push('Informe a data dos primeiros sintomas do primeiro caso');
  else if (data(s.notificadoEm) && s.primeirosSintomasEm! > s.notificadoEm!) erros.push('Os primeiros sintomas não podem ser depois da notificação');
  if (s.casos === null || !Number.isInteger(s.casos) || s.casos < 1) erros.push('Informe o número de casos suspeitos (1 ou mais)');
  if (!s.localInicial || !LOCAL_INICIAL_SURTO[s.localInicial]) erros.push('Informe o local inicial de ocorrência (1 a 11)');
  else if (s.localInicial === '11' && !s.localInicialTexto?.trim()) erros.push('Descreva o local inicial de ocorrência (Outros)');
  if (etapa === 'NOTIFICACAO') return erros;
  // Investigação: a data é obrigatória na ficha de investigação de surto.
  if (!data(s.investigadoEm)) erros.push('Informe a data da investigação');
  else if (data(s.notificadoEm) && s.investigadoEm! < s.notificadoEm!) erros.push('A investigação não pode ser antes da notificação');
  if (etapa === 'INVESTIGACAO') return erros;
  // Encerramento: delimitação do surto e data, que deve ser igual ou posterior à notificação (dicionário de surto v5).
  if (!s.delimitacao || !DELIMITACAO_SURTO[s.delimitacao]) erros.push('Informe a delimitação do surto (1 a 11)');
  else if (s.delimitacao === '11' && !s.delimitacaoTexto?.trim()) erros.push('Descreva a delimitação do surto (Outros)');
  if (!data(s.encerradoEm)) erros.push('Informe a data do encerramento');
  else if (data(s.notificadoEm) && s.encerradoEm! < s.notificadoEm!) erros.push('O encerramento não pode ser antes da notificação');
  return erros;
}
