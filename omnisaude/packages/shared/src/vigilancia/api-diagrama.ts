/**
 * Contratos da API de população, diagrama de controle e plano de contingência (VIG-1c, §4.2 do desenho; frente F3).
 * Rotas em /api/vigilancia. Leitura: `vigilancia.resumo` ou `vigilancia.painel`; gravação do diagrama e da população:
 * `vigilancia.consolidacao`; do plano e dos acionamentos: `vigilancia.contingencia`. Datas em AAAA-MM-DD; instantes
 * em ISO 8601; semanas em AAAASS.
 */
import type { AvaliacaoPlano, EixoAcao, IndicadoresAgravo, PlanoContingencia, StatusAcao } from './contingencia';
import type { AnoExcluido, AnosEpidemicosSugeridos, CanalCalculado, ChaveReceitaModelo, PontoObservado, ReceitaCanal, StatusSemana } from './diagrama';

// ───────────── Território e população ─────────────

export type NivelTerritorio = 'MUNICIPIO' | 'LOCALIDADE' | 'BAIRRO';

export const ROTULO_NIVEL_TERRITORIO: Record<NivelTerritorio, string> = { MUNICIPIO: 'Município', LOCALIDADE: 'Localidade', BAIRRO: 'Bairro' };

export type FontePopulacao = 'IBGE_DOU' | 'RIPSA' | 'CENSO_2022' | 'MANUAL';

export const ROTULO_FONTE_POPULACAO: Record<FontePopulacao, string> = {
  IBGE_DOU: 'IBGE (estimativa publicada no DOU)',
  RIPSA: 'RIPSA/MS (estimativas para indicadores de saúde)',
  CENSO_2022: 'Censo 2022',
  MANUAL: 'Informada pela vigilância',
};

/** Território dos filtros (null no município). */
export interface TerritorioRef {
  nivel: NivelTerritorio;
  id: string | null;
  nome: string;
}

/** GET /vigilancia/populacao?nivel=&territorio= (linha). */
export interface EstimativaPopulacao {
  id: string;
  ano: number;
  nivel: NivelTerritorio;
  territorioId: string | null;
  territorioNome: string;
  populacao: number;
  fonte: FontePopulacao;
  versao: string;
  nota: string | null;
  atualizadoEm: string;
}

export type ListaPopulacao = EstimativaPopulacao[];

/** Linha do lote gravado (a tela aceita colar "ano;população"). */
export interface LinhaPopulacao {
  ano: number;
  nivel: NivelTerritorio;
  territorioId: string | null;
  populacao: number;
  fonte: FontePopulacao;
  versao?: string;
  nota?: string | null;
}

/** PUT /vigilancia/populacao. */
export interface CorpoPopulacao {
  linhas: LinhaPopulacao[];
}

export interface RespostaPopulacao {
  criadas: number;
  atualizadas: number;
}

/** População usada em cada ano do canal. REPETIDA: ano em análise sem estimativa, usa a última da mesma fonte; ESTIMADA: proporção do Censo 2022. */
export interface PopulacaoUsada {
  ano: number;
  populacao: number | null;
  fonte: FontePopulacao | null;
  versao: string | null;
  origem: 'OFICIAL' | 'REPETIDA' | 'ESTIMADA' | 'AUSENTE';
}

// ───────────── Diagrama ─────────────

export type EixoDiagrama = 'EPIDEMIOLOGICO' | 'SAZONAL';

/**
 * Consulta de GET /vigilancia/diagrama e de GET /vigilancia/diagrama.csv. Sem `nivel`, o município. O CSV traz sempre
 * o canal do ano epidemiológico pedido, também no eixo sazonal.
 */
export interface ConsultaDiagrama {
  grupo: string;
  nivel: NivelTerritorio;
  territorio?: string;
  ano: number;
  eixo?: EixoDiagrama;
}

/** Receita gravada para o agravo (diagram_settings); sem gravação, a do modelo MS_2025 (`padrao: true`). */
export interface ConfiguracaoDiagrama {
  grupo: string;
  modelo: ChaveReceitaModelo | null;
  receita: ReceitaCanal;
  anosExcluidos: AnoExcluido[];
  fontePopulacao: FontePopulacao | null;
  versaoPopulacao: string | null;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
  padrao: boolean;
}

/** Canal congelado (control_channels): versão ativa do ano. */
export interface CanalCongelado {
  id: string;
  versao: number;
  calculadoEm: string;
  calculadoPor: string | null;
  nota: string | null;
  fontePopulacao: FontePopulacao | null;
  versaoPopulacao: string | null;
}

/** Canal de um ano: o congelado ativo ou, sem ele, a prévia calculada na hora (`congelado: null`). */
export interface CanalDoAno {
  ano: number;
  canal: CanalCalculado;
  congelado: CanalCongelado | null;
  observado: PontoObservado[];
}

/** Ponto do gráfico, na ordem do eixo (sazonal: SE 27 a 53 do ano e 1 a 26 do seguinte), com o canal do próprio ano. */
export interface PontoDiagrama {
  ano: number;
  semana: number;
  /** "SS/AAAA". */
  rotulo: string;
  casos: number | null;
  valor: number | null;
  canal: { centro: number | null; li: number | null; ls: number | null } | null;
  status: StatusSemana;
  incompleta: boolean;
}

/** Cobertura de cada ano da série (sem cobertura = fora do canal). */
export interface CoberturaAno {
  ano: number;
  coberto: boolean;
  motivo: string;
}

/** GET /vigilancia/diagrama. */
export interface RespostaDiagrama {
  grupo: string;
  agravo: string;
  territorio: TerritorioRef;
  ano: number;
  eixo: EixoDiagrama;
  configuracao: ConfiguracaoDiagrama;
  /** Um canal no eixo epidemiológico; dois no sazonal. */
  canais: CanalDoAno[];
  pontos: PontoDiagrama[];
  semanasIncompletas: string[];
  populacao: PopulacaoUsada[];
  cobertura: CoberturaAno[];
  /** Casos sem semana de início dos sintomas (contados pela SE da notificação). */
  semSemanaSintomas: number;
  /** Nomes de bairro dos registros oficiais sem correspondência no território (BAIRRO e LOCALIDADE). */
  bairrosSemCorrespondencia: number;
  avisos: string[];
}

/** PUT /vigilancia/diagrama/configuracao/:grupo. */
export interface CorpoConfiguracaoDiagrama {
  /** Parte de um modelo; `receita` ajusta campos dele. */
  modelo: ChaveReceitaModelo | null;
  receita?: Partial<ReceitaCanal>;
  anosExcluidos: AnoExcluido[];
  fontePopulacao: FontePopulacao | null;
  versaoPopulacao: string | null;
}

/** POST /vigilancia/diagrama/congelar: nova versão ativa (a anterior fica inativa). */
export interface CorpoCongelarCanal {
  grupo: string;
  nivel: NivelTerritorio;
  territorio: string | null;
  ano: number;
  nota?: string | null;
}

export interface RespostaCongelarCanal {
  id: string;
  versao: number;
  ano: number;
  anterior: { id: string; versao: number } | null;
}

/** GET /vigilancia/diagrama/anos-epidemicos?grupo=&ano=. */
export interface RespostaAnosEpidemicos {
  grupo: string;
  ano: number;
  sugestao: AnosEpidemicosSugeridos;
  /** Anos já excluídos na configuração. */
  excluidos: AnoExcluido[];
}

/** Território acima do limite superior na última semana completa (usado pelas sugestões de surto da frente F4). */
export interface ExcessoTerritorio {
  grupo: string;
  nivel: NivelTerritorio;
  territorioId: string | null;
  territorioNome: string;
  semana: string;
  casos: number;
  valor: number;
  ls: number;
}

// ───────────── Contingência ─────────────

export type StatusPlano = 'RASCUNHO' | 'VIGENTE' | 'ARQUIVADO';

export const ROTULO_STATUS_PLANO: Record<StatusPlano, string> = { RASCUNHO: 'Rascunho', VIGENTE: 'Vigente', ARQUIVADO: 'Arquivado' };

/** GET /vigilancia/contingencia/planos (linha). */
export interface PlanoResumo {
  id: string;
  escopo: string;
  nome: string;
  versao: number;
  status: StatusPlano;
  vigenteDesde: string | null;
  vigenteAte: string | null;
  fonte: string | null;
  atualizadoEm: string;
}

export type ListaPlanos = PlanoResumo[];

/** Plano com a definição: GET /vigilancia/contingencia/planos/:id e resposta de criar, editar e pôr em vigor. */
export interface DetalhePlano extends PlanoResumo {
  definicao: PlanoContingencia;
}

/** POST /vigilancia/contingencia/planos: a partir do modelo do MS ou cópia de outro plano. Nasce RASCUNHO. */
export type CorpoNovoPlano = { modelo: 'MS_2025'; nome?: string } | { copiarDe: string; nome?: string };

/** PUT /vigilancia/contingencia/planos/:id (só RASCUNHO; a definição é validada). */
export interface CorpoEditarPlano {
  nome?: string;
  fonte?: string | null;
  definicao: PlanoContingencia;
}

/** POST /vigilancia/contingencia/planos/:id/vigencia: VIGENTE desde a data; o anterior do mesmo escopo é arquivado. */
export interface CorpoVigenciaPlano {
  desde: string;
}

/** Acionamento de estágio (vigências sem sobreposição). */
export interface AcionamentoResumo {
  id: string;
  estagio: string;
  estagioNome: string;
  inicio: string;
  semanaInicio: string;
  fim: string | null;
  semanaFim: string | null;
  justificativa: string;
  ato: string | null;
  decididoPor: string | null;
  decididoEm: string;
  /** Retrato dos indicadores no acionamento. */
  indicadores: IndicadoresAgravo[];
}

/** Ação do checklist do acionamento aberto. */
export interface AcaoChecklist {
  id: string;
  estagio: string;
  eixo: EixoAcao;
  descricao: string;
  status: StatusAcao;
  responsavel: string | null;
  nota: string | null;
  atualizadoEm: string;
  atualizadoPor: string | null;
}

/** Resposta da vigilância a critério manual na semana. */
export interface RespostaManualCriterio {
  semana: string;
  criterio: string;
  atendido: boolean;
  nota: string | null;
  respondidoPor: string | null;
  respondidoEm: string;
}

/** GET /vigilancia/contingencia?nivel=&territorio=. */
export interface SituacaoContingencia {
  territorio: TerritorioRef;
  plano: DetalhePlano | null;
  /**
   * Estágio em vigor: o do acionamento aberto do território, de qualquer versão do plano (trocar o plano não desfaz a
   * decisão); NORMALIDADE quando não há acionamento.
   */
  estagioAtual: { chave: string; nome: string; desde: string | null; acionamentoId: string | null };
  semanaReferencia: string;
  semanasIncompletas: string[];
  indicadores: IndicadoresAgravo[];
  /** null sem plano vigente. */
  avaliacao: AvaliacaoPlano | null;
  respostas: RespostaManualCriterio[];
  historico: AcionamentoResumo[];
  checklist: AcaoChecklist[];
  avisos: string[];
}

/** POST /vigilancia/contingencia/respostas. */
export interface CorpoRespostaCriterio {
  semana: string;
  criterio: string;
  atendido: boolean;
  nota?: string | null;
  nivel?: NivelTerritorio;
  territorio?: string | null;
}

/**
 * POST /vigilancia/contingencia/acionar: fecha o acionamento aberto do território, de qualquer versão do plano (fim =
 * véspera), e abre o novo com o checklist. O mesmo estágio do plano vigente já em vigor: 409.
 */
export interface CorpoAcionar {
  estagio: string;
  /** Pelo menos 20 caracteres. */
  justificativa: string;
  ato?: string | null;
  nivel: NivelTerritorio;
  territorio: string | null;
}

export interface RespostaAcionar {
  acionamento: AcionamentoResumo;
  anteriorEncerrado: { id: string; fim: string } | null;
  acoesCriadas: number;
}

/** PATCH /vigilancia/contingencia/acoes/:id. */
export interface CorpoAtualizarAcao {
  status?: StatusAcao;
  responsavel?: string | null;
  nota?: string | null;
}
