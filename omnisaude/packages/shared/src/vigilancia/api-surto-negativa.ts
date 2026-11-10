/**
 * Contratos da API de surtos, sugestões de surto, notificação negativa, grade unidade × semana e unidades
 * notificantes (VIG-1c, §4.3 do desenho; frente F4). Rotas em /api/vigilancia. Surtos: `vigilancia.surto` (o núcleo
 * só vê os das unidades em que está lotado). Atesto: `notificacao.negativa` (e designação ativa). Grade: leitura com
 * `vigilancia.resumo` ou `vigilancia.painel`. Unidades notificantes e responsáveis: `vigilancia.consolidacao`.
 * Datas em AAAA-MM-DD; instantes em ISO 8601; semanas em AAAASS.
 */
import type { ExcessoTerritorio } from './api-diagrama';
import type { SituacaoPrazoNotificacao } from './catalogo';
import type { AnaliseGrade, SituacaoUnidadeSemana, StatusAtesto, TipoResponsavelNegativa } from './negativa';
import type { CategoriaSurto, StatusSurto, SugestaoSurto, TipoEventoSurto } from './surto';

// ───────────── Surtos ─────────────

/** Unidade como aparece nas respostas. */
export interface UnidadeRef {
  id: string;
  nome: string;
  cnes: string;
}

/**
 * Prazo da comunicação do surto a uma esfera (imediata: 24 h do conhecimento). A SMS cumpre com a primeira
 * comunicação registrada a ela ou, quando a própria vigilância municipal registrou o surto, no registro; SES e MS (só
 * com ESP) cumprem com a comunicação registrada.
 */
export interface PrazoSurto {
  esfera: 'SMS' | 'SES' | 'MS';
  venceEm: string;
  cumpridoEm: string | null;
  situacao: SituacaoPrazoNotificacao;
}

/** GET /vigilancia/surtos?status= (linha). */
export interface SurtoResumo {
  id: string;
  /** Numeração interna AAAA/NNNN. */
  numero: string;
  status: StatusSurto;
  categoria: CategoriaSurto;
  grupo: string | null;
  /** Agravo, síndrome ou CID, como texto para a lista. */
  agravo: string;
  sindrome: string | null;
  cid: string | null;
  unidade: UnidadeRef;
  notificadoEm: string;
  conhecidoEm: string;
  primeirosSintomasEm: string;
  /** Nº de casos suspeitos/expostos informado (campo 18). */
  casos: number;
  /** Linhas da planilha de acompanhamento. */
  casosNaPlanilha: number;
  localInicial: string;
  esp: boolean;
  /** SMS sempre; SES e MS quando `esp`. */
  prazos: PrazoSurto[];
  numeroOficial: string | null;
  encerradoEm: string | null;
  avisos: string[];
}

export type ListaSurtos = SurtoResumo[];

/** Local de ocorrência do surto (campos 20 a 33 da ficha). */
export interface LocalSurto {
  municipioIbge: string | null;
  localidadeId: string | null;
  bairroId: string | null;
  endereco: string | null;
  referencia: string | null;
  /** CS_ZONA: 1 urbana, 2 rural, 3 periurbana, 9 ignorado. */
  zona: string | null;
  lat: number | null;
  lng: number | null;
}

/** Investigação (campos 24 a 26 e observações). */
export interface InvestigacaoSurto {
  investigadoEm: string | null;
  /** CS_TRANS. */
  modoTransmissao: string | null;
  /** TP_INDIRET (código) e CS_VEICULO (texto do "outro"). */
  veiculo: string | null;
  veiculoTexto: string | null;
  observacoes: string | null;
  investigadorNome: string | null;
  investigadorFuncao: string | null;
}

/** Bloco da ficha de surto de DTA (campos 27 a 60), quando o veículo é alimento/água. Chaves = variáveis do dicionário. */
export type BlocoDta = Record<string, string | number | null>;

/** Linha da planilha de acompanhamento (uma por caso). */
export interface CasoSurto {
  id: string;
  /** NU_CASO. */
  numero: number;
  notificationId: string | null;
  /** Número interno da notificação individual ligada. */
  notificacaoNumero: string | null;
  officialRecordId: string | null;
  iniciais: string | null;
  sexo: string | null;
  /** Idade legível ("34 anos", "5 meses", "10 dias", "12 horas"). */
  idade: string | null;
  municipioResidencia: string | null;
  bairroId: string | null;
  bairroNome: string | null;
  inicioSintomas: string | null;
  hospitalizado: boolean | null;
  obito: boolean | null;
  classificacao: string | null;
  criterio: string | null;
  cidFinal: string | null;
  /** Caso de agravo da lista sem notificação individual (o surto não a substitui). */
  semNotificacaoIndividual: boolean;
}

/** Evento da linha do tempo. */
export interface EventoSurto {
  id: string;
  tipo: TipoEventoSurto;
  em: string;
  por: string | null;
  dados: Record<string, unknown>;
}

/**
 * Variável do espelho (nome do dicionário de dados do Sinan). Valor: datas em dd/mm/aaaa; campos com domínio como
 * "código - rótulo" (ex.: "3 - Creche/Escola"); nulo quando não preenchido.
 */
export interface CampoEspelho {
  variavel: string;
  rotulo: string;
  valor: string | null;
}

/** GET /vigilancia/surtos/:id/espelho: TP_NOT=3, ID_AGRAVO, DT_NOTIFIC, ID_UNIDADE, DT_SIN_PRI, QT_TOTAL_C, CS_LOCAL... */
export interface EspelhoSurto {
  campos: CampoEspelho[];
  /**
   * Planilha, com os valores como vão para o Sinan (códigos): NU_CASO, NM_CASO, CS_SEXO, NU_IDADE_N, ID_MN_RESI,
   * NM_BAIRRO, DT_SIN_PRI, ID_HOSP e OBITO (1 sim, 2 não, 9 ignorado), CLASSI_FIN, CRITERIO, DIAG_FINAL.
   */
  planilha: Record<string, string | null>[];
  /** Bloco DTA, quando houver. */
  dta: CampoEspelho[];
  avisos: string[];
}

/** GET /vigilancia/surtos/:id. */
export interface DetalheSurto extends SurtoResumo {
  venceEm: string;
  notificador: string | null;
  agente: string | null;
  localInicialTexto: string | null;
  local: LocalSurto;
  investigacao: InvestigacaoSurto;
  dta: BlocoDta | null;
  delimitacao: string | null;
  delimitacaoTexto: string | null;
  notasEncerramento: string | null;
  descarte: { motivo: string; em: string; por: string | null } | null;
  /** Sugestão que originou o surto (assinatura, regra, casos). */
  sinal: Record<string, unknown> | null;
  planilha: CasoSurto[];
  eventos: EventoSurto[];
  espelho: EspelhoSurto;
  /** Pendências de `validarSurto` na etapa atual. */
  pendencias: string[];
  permissoes: { editar: boolean; encerrar: boolean; descartar: boolean; numeroOficial: boolean };
}

/** Caso indicado na criação a partir de uma sugestão. */
export interface CasoIndicado {
  notificationId?: string;
  officialRecordId?: string;
}

/** POST /vigilancia/surtos (de uma sugestão, com `assinatura` e os casos, ou manual). */
export interface CorpoNovoSurto {
  assinatura?: string | null;
  casosIndicados?: CasoIndicado[];
  categoria: CategoriaSurto;
  grupo?: string | null;
  sindrome?: string | null;
  cid?: string | null;
  agente?: string | null;
  notificadoEm: string;
  /** Instante em que a vigilância soube do surto (início do prazo). */
  conhecidoEm: string;
  esp?: boolean;
  unitId: string;
  primeirosSintomasEm: string;
  casos: number;
  localInicial: string;
  localInicialTexto?: string | null;
  local?: Partial<LocalSurto>;
}

/** PATCH /vigilancia/surtos/:id (campos da notificação, local, investigação e bloco DTA). */
export interface CorpoEditarSurto {
  categoria?: CategoriaSurto;
  grupo?: string | null;
  sindrome?: string | null;
  cid?: string | null;
  agente?: string | null;
  notificadoEm?: string;
  esp?: boolean;
  primeirosSintomasEm?: string;
  casos?: number;
  localInicial?: string;
  localInicialTexto?: string | null;
  local?: Partial<LocalSurto>;
  investigacao?: Partial<InvestigacaoSurto>;
  dta?: BlocoDta | null;
}

/** Linha manual da planilha. */
export interface LinhaCasoSurto {
  iniciais?: string | null;
  /** M, F ou I. */
  sexo?: string | null;
  /** Número e unidade: "34", "34 anos", "34A", "5 meses", "10 dias", "12 horas". */
  idade?: string | null;
  municipioResidencia?: string | null;
  bairroId?: string | null;
  inicioSintomas?: string | null;
  hospitalizado?: boolean | null;
  obito?: boolean | null;
  classificacao?: string | null;
  criterio?: string | null;
  cidFinal?: string | null;
}

/** POST /vigilancia/surtos/:id/casos: uma notificação, um registro oficial ou uma linha manual. */
export type CorpoCasoSurto = { notificationId: string } | { officialRecordId: string } | { linha: LinhaCasoSurto };

export interface RespostaCasoSurto {
  caso: CasoSurto;
  avisos: string[];
}

/** POST /vigilancia/surtos/:id/comunicacoes. */
export interface CorpoComunicacaoSurto {
  alvo: 'SMS' | 'SES' | 'MS';
  canal: 'TELEFONE' | 'EMAIL' | 'FORMULARIO' | 'PRESENCIAL' | 'OUTRO';
  contraparte: string;
  protocolo?: string | null;
  nota?: string | null;
  /** Instante da comunicação. */
  em: string;
}

/** POST /vigilancia/surtos/:id/encerrar. */
export interface CorpoEncerrarSurto {
  /** DELIMITA (1 a 11). */
  delimitacao: string;
  /** Texto quando a delimitação é 11 (outros). */
  texto?: string | null;
  data: string;
  notas?: string | null;
}

/** POST /vigilancia/surtos/:id/descartar (motivo com pelo menos 10 caracteres). */
export interface CorpoDescartarSurto {
  motivo: string;
}

/** POST /vigilancia/surtos/:id/numero-oficial (1 a 7 dígitos). */
export interface CorpoNumeroOficialSurto {
  numero: string;
}

/** Caso de uma sugestão, para a tela. */
export interface CasoDaSugestao {
  id: string;
  numero: string;
  agravo: string;
  unidade: string;
  bairro: string | null;
  inicioSintomas: string | null;
  conhecidoEm: string;
}

export interface SugestaoSurtoTela extends SugestaoSurto {
  /** Nome do quarteirão, bairro ou unidade do vínculo. */
  vinculoNome: string;
  casosDetalhe: CasoDaSugestao[];
}

/** GET /vigilancia/surtos/sugestoes. */
export interface RespostaSugestoesSurto {
  sugestoes: SugestaoSurtoTela[];
  /** Dengue, chikungunya e Zika acima do limite superior do canal do território na última semana completa. */
  excessos: ExcessoTerritorio[];
  avisos: string[];
}

/** POST /vigilancia/surtos/sugestoes/dispensar (motivo com pelo menos 10 caracteres). */
export interface CorpoDispensarSugestao {
  assinatura: string;
  motivo: string;
}

// ───────────── Notificação negativa ─────────────

/** Atesto da negativa. */
export interface AtestoNegativa {
  id: string;
  unitId: string;
  unidade: string;
  cnes: string;
  semana: string;
  status: StatusAtesto;
  atestadoEm: string;
  atestadoPor: string;
  funcao: string | null;
  emNome: boolean;
  motivoEmNome: string | null;
  atrasado: boolean;
  declaracao: string;
  canceladoEm: string | null;
  motivoCancelamento: string | null;
  /** O que cancelou o atesto (RQ003). */
  causa: { tipo: 'NOTIFICACAO' | 'REGISTRO_OFICIAL' | 'SURTO'; id: string } | null;
  /** Negativa do Sinan (NNEGANET) casada com o atesto. */
  registroOficialId: string | null;
}

/** Semana fechada da unidade do responsável. */
export interface SemanaParaAtestar {
  semana: string;
  inicio: string;
  fim: string;
  situacao: SituacaoUnidadeSemana;
  prazo: string;
  prazoPassou: boolean;
  podeAtestar: boolean;
  /** Por que não pode atestar (ex.: a unidade tem notificação na semana). */
  motivo: string | null;
  atesto: AtestoNegativa | null;
  /** Texto do atesto, à vista antes de atestar. */
  texto: string;
}

export interface UnidadeDoResponsavel {
  unidade: UnidadeRef;
  tipo: TipoResponsavelNegativa;
  semanas: SemanaParaAtestar[];
}

/** GET /vigilancia/negativas/minhas. */
export interface RespostaMinhasNegativas {
  unidades: UnidadeDoResponsavel[];
  historico: AtestoNegativa[];
}

/** POST /vigilancia/negativas (só semana terminada, dentro de `semanasAtesto`). Em nome da unidade: `vigilancia.consolidacao` com motivo. */
export interface CorpoAtestarNegativa {
  unitId: string;
  semana: string;
  emNome?: { motivo: string };
}

/** POST /vigilancia/negativas/:id/anular. */
export interface CorpoAnularNegativa {
  motivo: string;
}

/** Consulta de GET /vigilancia/negativas/grade. */
export interface ConsultaGradeNegativa {
  /** Quantas semanas (padrão 12). */
  semanas?: number;
  /** Última semana da grade (AAAASS; padrão a semana em curso). */
  ate?: string;
}

/** De onde veio a situação da célula. */
export interface FontesCelula {
  notificacoes: number;
  surtos: number;
  registrosOficiais: number;
  atesto: { id: string; atrasado: boolean } | null;
  /** Negativa digitada no Sinan (NNEGANET). Sem atesto, ela sozinha deixa a célula como negativa (no prazo). */
  negativaSinan: boolean;
}

export interface CelulaGrade {
  semana: string;
  situacao: SituacaoUnidadeSemana;
  fontes: FontesCelula;
}

export interface LinhaGradeNegativa {
  unidade: UnidadeRef;
  tipoUnidade: string;
  celulas: CelulaGrade[];
}

/** Semana (coluna) da grade. */
export interface ColunaGrade {
  semana: string;
  inicio: string;
  fim: string;
  fechada: boolean;
  prazo: string;
}

/** Diferença entre o atesto do OmniSaúde e a negativa digitada no Sinan. */
export interface DiferencaSinan {
  unidade: UnidadeRef;
  semana: string;
  atestoId: string | null;
  registroOficialId: string | null;
}

/** GET /vigilancia/negativas/grade?semanas=12&ate=AAAASS. */
export interface RespostaGradeNegativa {
  colunas: ColunaGrade[];
  linhas: LinhaGradeNegativa[];
  analise: AnaliseGrade;
  metaPercentual: number;
  /** Atestado no OmniSaúde e não digitado no Sinan. */
  atestadoSemSinan: DiferencaSinan[];
  /** Digitado no Sinan sem atesto no OmniSaúde. */
  sinanSemAtesto: DiferencaSinan[];
  avisos: string[];
}

// ───────────── Unidades notificantes e responsáveis ─────────────

export interface PeriodoNotificante {
  id: string;
  desde: string;
  ate: string | null;
  motivoFim: string | null;
}

export interface ResponsavelNegativa {
  id: string;
  userId: string;
  nome: string;
  tipo: TipoResponsavelNegativa;
  desde: string;
  ate: string | null;
  designadoEm: string;
  designadoPor: string | null;
}

export interface UnidadeNotificante {
  unidade: UnidadeRef;
  tipoUnidade: string;
  ativa: boolean;
  periodoAtual: PeriodoNotificante | null;
  periodos: PeriodoNotificante[];
  responsaveis: ResponsavelNegativa[];
  /** Unidade ativa sem nenhum período de notificante. */
  semConfiguracao: boolean;
}

/** GET /vigilancia/unidades-notificantes. */
export type ListaUnidadesNotificantes = UnidadeNotificante[];

/** POST /vigilancia/unidades-notificantes (abre período). */
export interface CorpoAbrirPeriodoNotificante {
  unitId: string;
  desde: string;
}

/** POST /vigilancia/unidades-notificantes/:unitId/encerrar. */
export interface CorpoEncerrarPeriodoNotificante {
  ate: string;
  motivo: string;
}

/** POST /vigilancia/unidades-notificantes/:unitId/responsaveis (o usuário precisa de lotação ativa na unidade). */
export interface CorpoDesignarResponsavel {
  userId: string;
  tipo: TipoResponsavelNegativa;
  desde: string;
}

/**
 * Usuário ativo com lotação ativa na unidade: quem pode ser designado responsável. Acréscimo ao desenho: a tela busca
 * o usuário lotado, e o GET /admin/users exige `cadastros.profissionais`, que a vigilância não tem.
 */
export interface UsuarioLotado {
  userId: string;
  nome: string;
  /** Papéis das lotações ativas na unidade (Role). */
  papeis: string[];
  /** CBO de uma das lotações ativas. */
  cbo: string | null;
  /** Designação ativa na unidade, se já houver. */
  responsavel: TipoResponsavelNegativa | null;
}

/** GET /vigilancia/unidades-notificantes/:unitId/lotados?busca= (nome ou CPF; até 50, por nome). */
export type ListaUsuariosLotados = UsuarioLotado[];
