/*
 * Tipos do módulo. O perfil (camada 1) vem de etl/coleta_siconfi.py; a análise (camada 2) é o que o motor de regras
 * calcula; o parecer (camada 4) é o texto do agente, sempre conferido contra a análise.
 */

export interface Minimo {
  valor?: number;
  minimo_pct?: number;
  aplicado_pct?: number;
}

export interface Rreo14 {
  ano: number;
  bimestre: number;
  simplificado: boolean;
  rcl?: number;
  mde?: Minimo;
  fundeb70?: Minimo;
  asps?: Minimo;
}

export interface Rgf5 {
  ano: number;
  periodicidade: string;
  periodo: number;
  simplificado: boolean;
  linhas: Record<string, { bruta?: number; liquida?: number; liquida_apos_rp?: number }>;
}

export interface ReceitasAno {
  meses: number;
  /** fonte de recursos (3 dígitos, ex.: "540") → receita realizada no período, em R$ */
  por_fonte: Record<string, number>;
  /** natureza de receita (8 dígitos) → fonte → R$; só transferências (naturezas 17 e 24) */
  por_natureza: Record<string, Record<string, number>>;
}

/** perfil_municipio_<ibge>.json */
export interface Perfil {
  versao: number;
  ibge: number;
  nome: string;
  uf: string;
  populacao: number;
  faixa_populacional: string;
  consultado_em: string;
  fonte: string;
  rreo14: Record<string, Rreo14>;
  rgf5: Rgf5 | null;
  receitas: Record<string, ReceitasAno>;
  caixa: { ano: number; mes: number; por_fonte: Record<string, number> } | null;
  faltas: string[];
}

export type Eixo = 'Educação' | 'Saúde' | 'Assistência Social';
export type Nivel = 'Crítico' | 'Alerta' | 'Oportunidade';
export type Confianca = 'alta' | 'média' | 'baixa';

export interface Impacto {
  /** R$ por mês; null quando o valor não se reparte por mês (ex.: diferença de um exercício já encerrado) */
  mensal: number | null;
  anual: number;
  natureza: 'perda_de_repasse' | 'ganho_potencial' | 'valor_a_aplicar' | 'recurso_parado';
  /** frase curta com o cálculo, para quem confere */
  metodo: string;
  confianca: Confianca;
}

export interface PassoAPasso {
  responsavel: string;
  sistema: string;
  acao: string;
  prazo: string;
}

/** Norma usada pela regra que não está no corpus (texto não verificado pelo módulo). */
export interface NormaExterna {
  rotulo: string;
  observacao: string;
}

export interface Achado {
  id: string;
  regra: string;
  eixo: Eixo;
  nivel: Nivel;
  titulo: string;
  diagnostico: string;
  /** valor atual e parâmetro, já formatados */
  atual: string;
  parametro: string;
  impacto: Impacto;
  /** ids de trechos do corpus que fundamentam a regra */
  base_legal: string[];
  normas_externas: NormaExterna[];
  /** consultas ao corpus para trazer contexto complementar */
  consultas: string[];
  passos: PassoAPasso;
  /** de onde vieram os números */
  fontes_dados: string[];
}

export interface Pendencia {
  eixo: Eixo;
  tema: string;
  por_que: string;
  onde: string;
  quem: string;
}

export interface Indicador {
  rotulo: string;
  unidade: 'R$/hab' | 'meses' | '%' | 'R$';
  valor: number | null;
  grupo: string;
  n: number;
  p25: number | null;
  mediana: number | null;
  p75: number | null;
}

export interface Trecho {
  id: string;
  sigla: string;
  norma: string;
  artigo: string;
  rotulo: string;
  dispositivo: string;
  caminho: string[];
  texto: string;
  contexto?: string;
  url: string;
}

export interface Analise {
  versao: number;
  ibge: number;
  nome: string;
  populacao: number;
  faixa: string;
  gerado_em: string;
  referencia: { ano_base: number | null; ano_corrente: number | null; meses_corrente: number | null; caixa_em: string | null };
  totais: { perda_anual: number; ganho_anual: number; a_aplicar: number; parado: number; criticos: number; alertas: number; oportunidades: number };
  achados: Achado[];
  pendencias: Pendencia[];
  indicadores: Record<string, Indicador>;
  /** trechos do corpus citados nos achados, para mostrar o texto da norma sem outra consulta */
  trechos: Record<string, Trecho>;
  receitas_federais: { fonte: string; rotulo: string; eixo: Eixo | 'Outras'; ano_base: number | null; corrente: number | null; caixa: number | null }[];
  faltas: string[];
}

/** Bloco do parecer, no formato pedido para os cards (camada 4). */
export interface Gargalo {
  achado_id: string;
  eixo: Eixo;
  nivel_criticidade: Nivel;
  diagnostico_direto: string;
  impacto_financeiro: string;
  base_legal: { trecho_id: string; citacao: string }[];
  passo_a_passo_operacional: {
    responsavel_tecnico: string;
    sistema_oficial: string;
    acao_corretiva_exata: string;
    prazo_competencia_limite: string;
  };
}

export interface Parecer {
  ibge: number;
  gerado_em: string;
  origem: 'agente' | 'motor';
  modelo: string | null;
  resumo_executivo: string;
  gargalos: Gargalo[];
  /** o que a conferência automática trocou ou removeu do texto do agente */
  ajustes: string[];
}
