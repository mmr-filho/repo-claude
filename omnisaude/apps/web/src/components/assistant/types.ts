export interface AssistantPainel {
  conversas7d: number;
  mensagensRecebidas7d: number;
  aguardandoAtendente: number;
  agendamentos30d: number;
  triagens30d: Record<string, number>;
  intencoes30d: { intencao: string; total: number }[];
  assistente: { ativo: boolean; nome: string; comIa: boolean; faq: number };
}

export interface ConversaResumo {
  id: string;
  telefone: string | null;
  paciente: { id: string; nome: string } | null;
  status: 'ABERTA' | 'AGUARDANDO_ATENDENTE' | 'ENCERRADA';
  motivo: string | null;
  triagem: string | null;
  mensagens: number;
  ultima: { texto: string; direcao: 'ENTRADA' | 'SAIDA'; em: string } | null;
  ultimaEntradaEm: string;
}

export interface Conversa {
  id: string;
  telefone: string | null;
  paciente: { id: string; nome: string; cns: string | null } | null;
  status: 'ABERTA' | 'AGUARDANDO_ATENDENTE' | 'ENCERRADA';
  motivo: string | null;
  triagem: string | null;
  mensagens: { id: string; direcao: 'ENTRADA' | 'SAIDA'; texto: string; intencao: string | null; em: string; autor: string | null; detalhes: Record<string, unknown> | null }[];
  abertaEm: string;
}
