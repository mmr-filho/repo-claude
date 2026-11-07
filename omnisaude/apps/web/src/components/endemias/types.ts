import type { ProgressoBloqueio, StatusOrdem } from '@omnisaude/shared';

/** Pacote do app de campo do ACE (GET /endemias/campo/pacote), guardado no aparelho para trabalhar sem internet. */
export interface PacoteCampo {
  ciclo: { ano: number; ciclo: number; chave: string; inicio: string; fim: string };
  zonas: { id: string; nome: string; quarteiroes: string[] }[];
  ordens: {
    id: string;
    numero: string;
    status: StatusOrdem;
    abertaEm: string;
    raioM: number;
    conferirImovel: boolean;
    quarteiroes: { id: string; ocorrencia: boolean }[];
    visitados: Record<string, { situacao: string; em: string }>;
  }[];
  quarteiroes: { id: string; numero: string; localidade: string | null; bairro: string | null; centro: { lat: number; lng: number }; geometria: unknown; ativo: boolean }[];
  imoveis: ImovelCampoView[];
  /**
   * Catálogo dos insumos de controle vetorial ativos, com ou sem saldo: o agente registra o produto usado mesmo sem lote
   * no pacote (a baixa fica pendente). Ausente no pacote guardado por versões anteriores do app.
   */
  produtos?: ProdutoCampo[];
  /** Só os lotes com saldo no depósito de endemias da unidade (sugestão de lote), do mais perto de vencer. */
  estoque: LoteCampo[];
  servidorEm: string;
}

export interface ProdutoCampo {
  id: string;
  codigo: string;
  descricao: string;
  unidade: string;
  tipo: 'LARVICIDA' | 'ADULTICIDA' | null;
}

export interface ImovelCampoView {
  id: string;
  quarteiraoId: string | null;
  sequencia: string | null;
  endereco: string;
  tipo: string;
  tipoLabel: string;
  lat: number | null;
  lng: number | null;
  posicaoAproximada: boolean;
  precisaoLabel: string;
  observacao: string | null;
  noCiclo: { situacao: string; em: string } | null;
  /** Criado no aparelho e ainda não enviado (o id é o clientId). */
  pendente?: boolean;
  /** Imóvel novo recusado no envio: a mensagem do servidor (corrigir na aba Fila). */
  erroNaFila?: string | null;
}

export interface LoteCampo {
  produtoId: string;
  produto: string;
  unidade: string;
  tipo: 'LARVICIDA' | 'ADULTICIDA' | null;
  loteId: string;
  lote: string;
  validade: string;
  vencido: boolean;
  saldo: number;
  deposito: string;
}

export interface OrdemResumo {
  id: string;
  numero: string;
  status: StatusOrdem;
  statusLabel: string;
  abertaEm: string;
  iniciadaEm: string | null;
  concluidaEm: string | null;
  raioM: number;
  /** Agravos dos casos; vem vazio para quem não vê o mapa de casos (só a vigilância vê o agravo). */
  grupos: string[];
  casos: number;
  casosDescartados: number;
  conferirImovel: boolean;
  atrasada: boolean;
  quarteiroes: number;
  agentes: { id: string; nome: string | null }[];
  progresso: ProgressoBloqueio;
}

export interface OrdemDetalhe extends Omit<OrdemResumo, 'quarteiroes' | 'casos' | 'casosDescartados' | 'agentes'> {
  abertaPor: 'manual' | 'notificacao';
  concluidaPor: string | null;
  conclusao: string | null;
  canceladaEm: string | null;
  canceladaPor: string | null;
  motivoCancelamento: string | null;
  unificadaEm: string | null;
  casos: { ativos: number; semPosicao: number; descartados: { motivo: string | null; em: string | null }[]; primeiraData: string | null; ultimaData: string | null };
  agentes: { id: string; nome: string | null; designadoEm: string }[];
  quarteiroes: {
    id: string;
    numero: string;
    localidade: string | null;
    bairro: string | null;
    /**
     * Distância até a residência do caso: null para quem não vê o mapa de casos (a distância até as bordas devolveria o
     * ponto). Sem ela, a lista vem pelo quarteirão de ocorrência e depois pelo número.
     */
    distanciaM: number | null;
    ocorrencia: boolean;
    geometria: unknown;
    centro: { lat: number; lng: number } | null;
    progresso: ProgressoBloqueio & { blockId: string };
  }[];
}

export interface AgenteEndemias {
  id: string;
  nome: string;
  papeis: string[];
  unidades: string[];
}

/** Depósito de endemias (painel do estoque). */
export interface DepositoEndemias {
  id: string;
  nome: string;
  /** Nome da unidade dona do depósito. */
  unidade: string;
  unitId: string;
}

/** Saldo de um lote num depósito de endemias. */
export interface LoteDeposito {
  loteId: string;
  lote: string;
  validade: string;
  vencido: boolean;
  fabricacao: string | null;
  depositoId: string;
  deposito: string;
  unidade: string;
  saldo: number;
}

/** Painel do estoque vetorial (GET /endemias/estoque). */
export interface PainelEstoque {
  depositos: DepositoEndemias[];
  produtos: {
    id: string;
    codigo: string;
    descricao: string;
    principioAtivo: string | null;
    concentracao: string | null;
    forma: string | null;
    unidade: string;
    tipo: 'LARVICIDA' | 'ADULTICIDA';
    ativo: boolean;
    consumo30d: number;
    baixasPendentes: number;
    lotes: LoteDeposito[];
  }[];
}

/** Entrada por remessa (GET /endemias/estoque/entradas), com o estorno quando houver. */
export interface EntradaRemessa {
  id: string;
  documento: string;
  origem: string;
  produto: string | null;
  unidade: string | null;
  lote: string | null;
  loteId: string;
  quantidade: number;
  deposito: string | null;
  unidadeDeposito: string | null;
  recebidaEm: string;
  recebidaPor: string | null;
  estornadaEm: string | null;
  estornadaPor: string | null;
  motivoEstorno: string | null;
  observacao: string | null;
}

/** Baixa de larvicida que ficou pendente (GET /endemias/estoque/pendentes). */
export interface BaixaPendente {
  id: string;
  visitaId: string;
  visitadoEm: string;
  agente: string | null;
  imovel: string | null;
  /** Unidade em que a visita foi registrada. */
  unidadeVisita: string | null;
  /** Depósito da baixa; null quando a unidade da visita não tinha depósito de endemias. */
  depositoId: string | null;
  deposito: string | null;
  produtoId: string;
  produto: string;
  unidade: string;
  loteId: string | null;
  lote: string | null;
  quantidade: number;
  motivo: string | null;
  motivoLabel: string | null;
}

export const GRUPO_LABEL: Record<string, string> = { dengue: 'Dengue', chikungunya: 'Chikungunya', zika: 'Zika', 'febre-amarela': 'Febre amarela' };

export const TOM_STATUS: Record<StatusOrdem, 'amber' | 'blue' | 'green' | 'slate' | 'red'> = {
  AGUARDANDO_LOCALIZACAO: 'amber',
  ABERTA: 'blue',
  EM_CAMPO: 'green',
  CONCLUIDA: 'slate',
  CANCELADA: 'slate',
};
