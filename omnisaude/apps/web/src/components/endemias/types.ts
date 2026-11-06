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
  estoque: LoteCampo[];
  servidorEm: string;
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
    distanciaM: number;
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

export const GRUPO_LABEL: Record<string, string> = { dengue: 'Dengue', chikungunya: 'Chikungunya', zika: 'Zika', 'febre-amarela': 'Febre amarela' };

export const TOM_STATUS: Record<StatusOrdem, 'amber' | 'blue' | 'green' | 'slate' | 'red'> = {
  AGUARDANDO_LOCALIZACAO: 'amber',
  ABERTA: 'blue',
  EM_CAMPO: 'green',
  CONCLUIDA: 'slate',
  CANCELADA: 'slate',
};
