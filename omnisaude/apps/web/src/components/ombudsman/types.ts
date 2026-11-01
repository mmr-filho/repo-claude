export interface OuvidoriaPainel {
  abertas: number;
  noPrazo: number;
  vencendo: number;
  vencidas: number;
  respondidas30d: number;
  respondidasNoPrazo30d: number;
  tempoMedioRespostaDias: number | null;
  porTipo: { tipo: string; label: string; total: number }[];
  porAssunto: { assunto: string; label: string; total: number }[];
  porUnidade: { unitId: string | null; unidade: string; total: number }[];
  avaliacaoMedia: number | null;
  avaliacoes: number;
}

export interface ManifestacaoResumo {
  id: string;
  protocolo: string;
  tipo: string;
  tipoLabel: string;
  canal: string;
  assunto: string;
  assuntoLabel: string;
  unidade: { id: string; nome: string } | null;
  status: string;
  statusLabel: string;
  recebidaEm: string;
  venceEm: string;
  prazo: { situacao: 'NO_PRAZO' | 'VENCE_EM_BREVE' | 'VENCIDA'; diasRestantes: number } | null;
  resumo: string;
  avaliacao: number | null;
  identificado: boolean;
  pessoa: { id: string | null; nome: string } | null;
  contato: string | null;
}

export interface ManifestacaoDetalhe extends Omit<ManifestacaoResumo, 'resumo' | 'avaliacao'> {
  canalLabel: string;
  unidadeDestino: { id: string; nome: string } | null;
  responsavel: string | null;
  texto: string;
  prorrogada: boolean;
  justificativaProrrogacao: string | null;
  resposta: { texto: string; em: string | null; por: string | null } | null;
  avaliacao: { nota: number; comentario: string | null; em: string | null } | null;
  eventos: { id: string; tipo: string; notas: string | null; por: string | null; em: string }[];
}

export interface SatisfacaoPainel {
  periodo: { de: string; ate: string };
  geral: Resumo;
  porCanal: { whatsapp: number; app: number };
  porUnidade: ({ unitId: string; unidade: string } & Resumo)[];
  porProfissional: ({ id: string; nome: string } & Resumo)[];
  comentarios: { id: string; unidade: string; nota: number | null; comentario: string | null; em: string | null }[];
}

export interface Resumo {
  enviadas: number;
  respondidas: number;
  taxaResposta: number | null;
  media: number | null;
  distribuicao: Record<'1' | '2' | '3' | '4' | '5', number>;
  nps: number | null;
}
