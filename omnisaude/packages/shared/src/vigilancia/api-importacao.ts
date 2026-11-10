/**
 * Contratos da API de importação das exportações oficiais e de conciliação com as notificações do OmniSaúde
 * (VIG-1c, §4.1 do desenho; frente F2). Rotas em /api/vigilancia, permissão `vigilancia.importar` em todas.
 * Datas em AAAA-MM-DD; instantes em ISO 8601; semanas em AAAASS.
 */
import type { GravidadeCaso, SituacaoCaso, TipoArquivoOficial, TipoRegistroOficial } from './agravos-sinan';
import type { SistemaOficial } from './sistemas';

// ───────────── Arquivos e codificação ─────────────

/** Código de página do DBF (byte 29 do cabeçalho; 0x00 = escolhido pela pontuação das letras). */
export type CodigoPagina = 'CP850' | 'CP437' | 'CP860' | 'CP1252';

/** Codificação usada na leitura: a do DBF ou, no CSV, UTF-8 (com recuo para CP1252, com aviso). */
export type CodificacaoArquivo = CodigoPagina | 'UTF8';

export const ROTULO_CODIFICACAO: Record<CodificacaoArquivo, string> = {
  CP850: 'CP850 (DOS, Europa Ocidental)',
  CP437: 'CP437 (DOS, EUA)',
  CP860: 'CP860 (DOS, Português)',
  CP1252: 'Windows-1252',
  UTF8: 'UTF-8',
};

/** Um arquivo do envio (o zip pode trazer vários). Gravado em official_imports.files. */
export interface ArquivoDetectado {
  /** Nome do arquivo (dentro do zip, se veio compactado). */
  nome: string;
  tipo: TipoArquivoOficial;
  sistema: SistemaOficial | null;
  tipoRegistro: TipoRegistroOficial | null;
  tamanhoBytes: number;
  /** Registros lidos (fora os apagados do DBF). */
  registros: number;
  codificacao: CodificacaoArquivo | null;
  /** Como a codificação foi escolhida: cabeçalho do DBF, pontuação das letras, informada na tela ou UTF-8 válido. */
  origemCodificacao: 'CABECALHO' | 'PONTUACAO' | 'INFORMADA' | 'UTF8' | null;
  /** Agravos normalizados presentes. */
  agravos: string[];
  /** Menor e maior data de notificação do arquivo. */
  periodo: { de: string; ate: string } | null;
  /** O arquivo traz a identificação do paciente. */
  identificado: boolean;
  /** Arquivo sem registro (tabela do Sinan, desconhecido): fica fora, com aviso. */
  ignorado: boolean;
  avisos: string[];
}

/** Contagens da prévia e da aplicação. Gravado em official_imports.counts. */
export interface ContagensImportacao {
  lidos: number;
  novos: number;
  alterados: number;
  iguais: number;
  recusados: number;
  /** Mesma chave mais de uma vez no envio (fica a versão com mais campos preenchidos). */
  duplicadosNoArquivo: number;
  /** Registros do mesmo sistema, tipo, agravos e período que estão no banco e não vieram. */
  ausentesPrevistos: number;
  /** Recusados por motivo (texto curto → quantidade). */
  motivosRecusa: Record<string, number>;
  /** Registros por tipo (individual, negativa, surto). */
  porTipo: Partial<Record<TipoRegistroOficial, number>>;
}

/** Identificação do paciente no registro oficial (CPF e CNS só dígitos). */
export interface IdentificacaoRegistro {
  nome: string | null;
  nascimento: string | null;
  sexo: string | null;
  mae: string | null;
  cns: string | null;
  cpf: string | null;
}

/** Registro lido e normalizado (importacao/normalizar.ts). Vai no payload da prévia (JSON com gzip). */
export interface RegistroOficialNormalizado {
  /** Chave natural (`chaveNatural`). */
  chave: string;
  sistema: SistemaOficial;
  tipo: TipoRegistroOficial;
  tipoArquivo: TipoArquivoOficial;
  numero: string;
  notificadoEm: string;
  /** SEM_NOT quando vier; senão a SE da data. */
  semanaNotificacao: string | null;
  /** IBGE de notificação (6 ou 7 dígitos, como veio). */
  municipioNotificacao: string | null;
  cnes: string | null;
  /** Agravo normalizado (`normalizarAgravo`). */
  agravo: string | null;
  /** CS_SUSPEIT (B09 e G03.9). */
  tipoSuspeita: string | null;
  grupo: string | null;
  inicioSintomas: string | null;
  /** SEM_PRI quando vier; senão a SE do início dos sintomas. */
  semanaSintomas: string | null;
  municipioResidencia: string | null;
  bairroCodigo: string | null;
  bairroNome: string | null;
  classificacao: string | null;
  criterio: string | null;
  evolucao: string | null;
  encerradoEm: string | null;
  obitoEm: string | null;
  situacao: SituacaoCaso;
  gravidade: GravidadeCaso | null;
  /** Cancelado (e-SUS Notifica), excluída (e-SUS Sinan) ou NDUPLIC_N = 2. */
  excluido: boolean;
  /** Grupo sigiloso do catálogo. */
  sigiloso: boolean;
  identificacao: IdentificacaoRegistro | null;
  /** Demais campos normalizados (sem contato: telefone, e-mail, endereço e notificante ficam fora). */
  extras: Record<string, string | number | boolean | null>;
  /**
   * Campos deste registro que o arquivo de origem traz, com valor ou vazios ("classificacao", "nome",
   * "extras.cs_raca"...). É a base da mescla por campo: o vazio só apaga o que o mesmo tipo de arquivo gravou.
   */
  colunas: string[];
}

// ───────────── Prévia ─────────────

/** Linha de amostra da prévia (máximo de 200 por lista). */
export interface AmostraRegistro {
  chave: string;
  tipo: TipoRegistroOficial;
  numero: string;
  notificadoEm: string;
  agravo: string | null;
  grupo: string | null;
  cnes: string | null;
  situacao: SituacaoCaso;
  /** Nome do paciente; null quando sigiloso para quem não tem `notificacao.sensivel` ou sem identificação. */
  paciente: string | null;
  /** Grupo sigiloso do catálogo (aids, HIV, sífilis, violências). */
  sigiloso: boolean;
}

export interface AmostraAlteracao extends AmostraRegistro {
  /** Campos que mudam (os de identificação ficam fora quando o registro é sigiloso e quem vê não tem `notificacao.sensivel`). */
  campos: { campo: string; antes: string | null; depois: string | null }[];
}

export interface AmostraRecusa {
  arquivo: string;
  /** Linha (CSV) ou registro (DBF), a partir de 1. */
  linha: number;
  numero: string | null;
  motivo: string;
}

export interface AmostraDuplicado {
  chave: string;
  arquivo: string;
  linhas: number[];
  /** Linha que ficou (a com mais campos preenchidos). */
  mantida: number;
}

/** Amostras para a tela. Gravado em official_imports.preview. */
export interface PreviaImportacao {
  novos: AmostraRegistro[];
  alterados: AmostraAlteracao[];
  recusados: AmostraRecusa[];
  duplicados: AmostraDuplicado[];
  ausentes: AmostraRegistro[];
}

// ───────────── Importações ─────────────

export type StatusImportacao = 'PREVIA' | 'APLICADA' | 'DESCARTADA';

export const ROTULO_STATUS_IMPORTACAO: Record<StatusImportacao, string> = { PREVIA: 'Prévia', APLICADA: 'Aplicada', DESCARTADA: 'Descartada' };

/**
 * POST /vigilancia/importacoes: o corpo é o arquivo cru (zip, dbf ou csv; até 95 MB). Estes são os parâmetros da
 * consulta. Para trocar a codificação, a tela envia o mesmo arquivo de novo com `codificacao`.
 */
export interface ConsultaEnvioImportacao {
  nome: string;
  /** Período declarado do envio (senão, o das datas de notificação lidas). */
  de?: string;
  ate?: string;
  codificacao?: CodificacaoArquivo;
}

/** Linha da lista de importações. GET /vigilancia/importacoes. */
export interface ResumoImportacao {
  id: string;
  sistema: SistemaOficial;
  status: StatusImportacao;
  arquivo: string;
  tamanhoBytes: number;
  periodo: { de: string; ate: string } | null;
  periodoDeclarado: boolean;
  identificado: boolean;
  contagens: ContagensImportacao;
  criadoEm: string;
  criadoPor: string | null;
  aplicadoEm: string | null;
  aplicadoPor: string | null;
  descartadoEm: string | null;
  descartadoPor: string | null;
  /** Prévia descartada por tempo (sem ação de usuário). */
  expirada: boolean;
}

export type ListaImportacoes = ResumoImportacao[];

/** GET /vigilancia/importacoes/:id e resposta do envio quando a prévia é criada. */
export interface DetalheImportacao extends ResumoImportacao {
  sha256: string;
  arquivos: ArquivoDetectado[];
  /** null depois de aplicar, descartar ou expirar (as amostras saem junto com o payload). */
  previa: PreviaImportacao | null;
  avisos: string[];
  /** Prévia: até quando pode ser aplicada. */
  expiraEm: string | null;
}

/** Mesmo arquivo (SHA-256) já aplicado: nada é criado. */
export interface ArquivoJaImportado {
  jaImportado: { id: string; aplicadoEm: string };
}

/** Resposta de POST /vigilancia/importacoes. */
export type RespostaEnvioImportacao = DetalheImportacao | ArquivoJaImportado;

/** Resposta de POST /vigilancia/importacoes/:id/aplicar. */
export interface ResultadoAplicacao {
  id: string;
  aplicadoEm: string;
  contagens: ContagensImportacao;
  /** Registros que passaram a ter `absent_since`. */
  ausentesMarcados: number;
  /** Registros que voltaram (absent_since limpo). */
  voltaram: number;
  /** Registros ligados à unidade pelo CNES. */
  unidadesLigadas: number;
  /** Vínculos automáticos da conciliação (degraus 1 e 2). */
  vinculadosAutomaticamente: number;
  /** Atestos de negativa cancelados pela reconciliação. */
  negativasCanceladas: number;
  avisos: string[];
}

/** Resposta de POST /vigilancia/importacoes/:id/descartar. */
export interface ResultadoDescarte {
  id: string;
  status: 'DESCARTADA';
  descartadoEm: string;
}

// ───────────── Conciliação ─────────────

export type MetodoVinculo = 'NUMERO_OFICIAL' | 'IDENTIDADE' | 'MANUAL';

export const ROTULO_METODO_VINCULO: Record<MetodoVinculo, string> = { NUMERO_OFICIAL: 'Número oficial', IDENTIDADE: 'CNS ou CPF', MANUAL: 'Manual' };

/** Filtro das listas da conciliação (consulta). */
export interface FiltroConciliacao {
  sistema?: SistemaOficial;
  grupo?: string;
  de?: string;
  ate?: string;
  /** Número, nome ou CNS. */
  busca?: string;
  /** A partir de 1. */
  pagina?: number;
}

/** Paciente como aparece nas listas (null quando sigiloso para quem não tem `notificacao.sensivel`). */
export interface PacienteConciliacao {
  nome: string | null;
  nascimento: string | null;
  sexo: string | null;
}

/** Registro oficial nas listas. */
export interface RegistroOficialResumo {
  id: string;
  sistema: SistemaOficial;
  tipo: TipoRegistroOficial;
  numero: string;
  notificadoEm: string;
  semanaNotificacao: string | null;
  agravo: string | null;
  grupo: string | null;
  /** Nome do agravo (catálogo ou tabela do Sinan). */
  agravoNome: string | null;
  unidade: { id: string | null; cnes: string | null; nome: string | null };
  situacao: SituacaoCaso;
  gravidade: GravidadeCaso | null;
  evolucao: string | null;
  encerradoEm: string | null;
  paciente: PacienteConciliacao | null;
  sigiloso: boolean;
  excluido: boolean;
  ausenteDesde: string | null;
  vinculo: { notificationId: string; numero: string; metodo: MetodoVinculo; em: string | null } | null;
}

/** Notificação do OmniSaúde nas listas. */
export interface NotificacaoParaConciliar {
  id: string;
  /** Numeração interna AAAA/NNNNNN. */
  numero: string;
  status: string;
  grupo: string;
  agravo: string;
  notificadaEm: string | null;
  inicioSintomas: string | null;
  unidade: { id: string; nome: string };
  paciente: PacienteConciliacao | null;
  sigilosa: boolean;
  sistemaOficial: SistemaOficial | null;
  numeroOficial: string | null;
  situacao: SituacaoCaso;
}

/** GET /vigilancia/conciliacao/resumo. */
export interface ResumoConciliacao {
  registros: number;
  vinculados: number;
  soOficial: number;
  soOmnisaude: number;
  divergentes: number;
  sugestoes: number;
  bairrosSemCorrespondencia: number;
  porSistema: { sistema: SistemaOficial; registros: number; vinculados: number; soOficial: number; soOmnisaude: number }[];
  /**
   * Sistemas e períodos cobertos por importação aplicada (o "só no OmniSaúde" só vale dentro deles). `grupos`: no
   * Sinan Online, que sai num arquivo por agravo (DENGON, CHIKON), só os grupos que vieram; null = todos do sistema.
   */
  cobertura: { sistema: SistemaOficial; grupos: string[] | null; de: string; ate: string }[];
  ultimaImportacao: { id: string; sistema: SistemaOficial; aplicadoEm: string } | null;
}

/** Página de uma lista. */
export interface PaginaConciliacao<T> {
  total: number;
  pagina: number;
  itens: T[];
}

/** GET /vigilancia/conciliacao/so-oficial. */
export type ListaSoOficial = PaginaConciliacao<RegistroOficialResumo>;

/** GET /vigilancia/conciliacao/so-omnisaude (NOTIFICADA/ENCERRADA não descartadas, de sistema e período cobertos, sem vínculo). */
export type ListaSoOmnisaude = PaginaConciliacao<NotificacaoParaConciliar>;

/** Diferença gravada no par vinculado. */
export interface DivergenciaPar {
  campo: 'situacao' | 'evolucao' | 'encerramento';
  oficial: string | null;
  omnisaude: string | null;
}

export interface ParConciliado {
  registro: RegistroOficialResumo;
  notificacao: NotificacaoParaConciliar;
  divergencias: DivergenciaPar[];
}

/** GET /vigilancia/conciliacao/divergentes. */
export type ListaDivergentes = PaginaConciliacao<ParConciliado>;

/** Par sugerido (degrau 3: nome, nascimento e sexo; ou candidato não único nos degraus 1 e 2). */
export interface SugestaoVinculo {
  registro: RegistroOficialResumo;
  notificacao: NotificacaoParaConciliar;
  degrau: 1 | 2 | 3;
  /** Por que o par foi sugerido (ex.: "mesmo nome, nascimento e sexo"). */
  motivo: string;
}

/** GET /vigilancia/conciliacao/sugestoes. */
export type ListaSugestoesVinculo = PaginaConciliacao<SugestaoVinculo>;

/** Nome de bairro dos registros sem correspondência no território. */
export interface BairroSemCorrespondencia {
  nome: string;
  /** Nome normalizado com o `normalizarNome` do território (o dos apelidos de bairro). */
  nomeNormalizado: string;
  codigo: string | null;
  registros: number;
  /** Bairros parecidos do território, para escolher o apelido. */
  candidatos: { neighborhoodId: string; nome: string; localidade: string | null }[];
}

/** GET /vigilancia/conciliacao/bairros. */
export type ListaBairrosSemCorrespondencia = BairroSemCorrespondencia[];

/** POST /vigilancia/conciliacao/vincular (vínculo manual, auditado). */
export interface CorpoVincular {
  recordId: string;
  notificationId: string;
  motivo?: string | null;
  /** Preencher o número oficial da notificação que ainda não tem (regra de `notificacoes/:id/numero-oficial`). */
  preencherNumeroOficial?: boolean;
}

export interface RespostaVincular {
  recordId: string;
  notificationId: string;
  metodo: MetodoVinculo;
  numeroOficialPreenchido: boolean;
  divergencias: DivergenciaPar[];
}

/** POST /vigilancia/conciliacao/desvincular. */
export interface CorpoDesvincular {
  recordId: string;
  motivo: string;
}

/** POST /vigilancia/conciliacao/rejeitar ("não é o mesmo caso": não é sugerido de novo). */
export interface CorpoRejeitarVinculo {
  recordId: string;
  notificationId: string;
  motivo: string;
}

/** POST /vigilancia/conciliacao/bairros/apelido (exige também `territorio.editar`). */
export interface CorpoApelidoBairro {
  nome: string;
  neighborhoodId: string;
}

export interface RespostaApelidoBairro {
  neighborhoodId: string;
  apelidos: string[];
  /** Registros que passam a cair no bairro. */
  registros: number;
}
