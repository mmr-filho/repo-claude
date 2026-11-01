export type SituacaoPrazo = 'CUMPRIDO' | 'NO_PRAZO' | 'A_VENCER' | 'VENCIDO' | 'SEM_PRAZO';
export type Esfera = 'SMS' | 'SES' | 'MS';

/** Rascunho aberto pelo gatilho (resposta da assinatura, do encerramento e da internação). */
export interface NotificacaoCriada {
  id: string;
  numero: string;
  agravo: string;
  prazo: 'IMEDIATA' | 'SEMANAL';
  esferas: Esfera[];
  venceEm: string | null;
  sigiloso: boolean;
  naoHomologado: boolean;
}

export interface NotificacaoResumo {
  id: string;
  numero: string;
  status: 'RASCUNHO' | 'NOTIFICADA' | 'DESCARTADA';
  origem: string;
  agravo: string;
  grupo: string | null;
  sigiloso: boolean;
  naoHomologado: boolean;
  paciente: string | null;
  unidade: string | null;
  prazo: 'IMEDIATA' | 'SEMANAL';
  esferas: Esfera[];
  venceEm: string | null;
  situacaoSms: SituacaoPrazo;
  repasses: { esfera: Esfera; situacao: SituacaoPrazo; venceEm: string | null }[];
  ciencia: boolean;
  escalada: boolean;
  semana: string | null;
  criadaEm: string;
}

export interface PainelVigilancia {
  cartoes: { imediatasAguardandoCiencia: number; rascunhosImediatos: number; repassesPendentes: number; vencidas: number; semanaisAVencer: number; descartes30d: number };
  notificacoes: NotificacaoResumo[];
  semanaAtual: string;
}

export interface FichaFin {
  formVersion: string;
  TP_NOT: string;
  ID_AGRAVO: { nome: string; cid: string | null; item: number; subitem: string | null };
  ID_UNIDADE: { cnes: string; nome: string };
  NU_IDADE_N: { valor: number; unidade: 'H' | 'D' | 'M' | 'A'; codigo: string } | null;
  notificador: { nome: string; cbo: string | null; funcao: string };
  [campo: string]: unknown;
}

export interface Contato {
  id: string;
  esfera: Esfera;
  nome: string;
  telefone: string | null;
  email: string | null;
  formulario: string | null;
  horario: string | null;
  plantao: boolean;
}

export interface NotificacaoDetalhe {
  id: string;
  numero: string;
  status: 'RASCUNHO' | 'NOTIFICADA' | 'DESCARTADA';
  origem: string;
  agravo: {
    id: string;
    key: string;
    grupo: string;
    nome: string;
    item: number;
    subitem: string | null;
    contexto: string;
    contextoLabel: string;
    marcas: { MS: boolean; SES: boolean; SMS: boolean; semanal: boolean };
    criterio: 'SUSPEITA' | 'CONFIRMACAO';
    emRevisao: boolean;
    notaNormativa: string | null;
  };
  subitens: { key: string; nome: string; contexto: string; marcas: { MS: boolean; SES: boolean; SMS: boolean; semanal: boolean } }[];
  codigo: { sistema: string; codigo: string } | null;
  naoHomologado: boolean;
  criterio: 'SUSPEITA' | 'CONFIRMADO';
  sigiloso: boolean;
  paciente: { id: string; nome: string; cns: string | null };
  unidade: { id: string; name: string; cnes: string };
  notificador: string | null;
  prazo: {
    tipo: 'IMEDIATA' | 'SEMANAL';
    esferas: Esfera[];
    marco: string;
    marcoLabel: string;
    inicio: string | null;
    venceEm: string | null;
    aguardandoConfirmacao: boolean;
    porEsfera: { esfera: Esfera; rotulo: string; venceEm: string | null; cumpridaEm: string | null; situacao: SituacaoPrazo }[];
  };
  datas: { primeiroAtendimento: string | null; conhecimento: string; confirmacao: string | null; notificacao: string | null; sintomas: string | null; semanaNotificacao: string | null; semanaSintomas: string | null };
  ciencia: { em: string; por: string | null } | null;
  ficha: FichaFin;
  foraDoMunicipio: boolean;
  descarte: { em: string; motivo: string | null } | null;
  comunicacoes: { id: string; esfera: Esfera; meio: string; em: string; interlocutor: string; orgao: string | null; contato: string | null; protocolo: string | null; notas: string | null; por: string | null }[];
  eventos: { id: string; tipo: string; em: string; por: string | null; notas: string | null }[];
  contatos: Contato[];
  permissoes: { editar: boolean; confirmar: boolean; descartar: boolean; ciencia: boolean; comunicar: boolean };
  aviso: string;
}

export interface CondicaoCatalogo {
  id: string;
  key: string;
  groupKey: string;
  item: number;
  subitem: string | null;
  name: string;
  context: string;
  immediateMs: boolean;
  immediateSes: boolean;
  immediateSms: boolean;
  weekly: boolean;
  notifyOn: 'SUSPEITA' | 'CONFIRMACAO';
  deadlineStart: string;
  sensitive: boolean;
  once: boolean;
  normativeStatus: 'VIGENTE' | 'EM_REVISAO';
  normativeNote: string | null;
}

export interface RetratoCatalogo {
  versaoNacional: { id: string; ato: string } | null;
  anteriorAoCatalogo: boolean;
  locais: { id: string; ato: string; escopo: string }[];
  condicoes: CondicaoCatalogo[];
}

export interface VersaoCatalogo {
  id: string;
  escopo: 'NACIONAL' | 'ESTADUAL' | 'MUNICIPAL';
  uf: string | null;
  ibgeCode: string | null;
  ato: string;
  publicacao: string | null;
  atoUrl: string | null;
  fonte: string | null;
  hashFonte: string | null;
  consultadoEm: string | null;
  vigenteDe: string;
  vigenteAte: string | null;
  vigente: boolean;
  notas: string | null;
  linhas: number;
}

export interface MapaCodigo {
  id: string;
  system: 'CID10' | 'CIAP2';
  codePrefix: string;
  groupKey: string;
  context: string | null;
  status: 'PROPOSTO' | 'HOMOLOGADO' | 'INATIVO';
  source: string;
  homologatedAt: string | null;
}

export const SITUACAO: Record<SituacaoPrazo, { label: string; tone: 'green' | 'amber' | 'red' | 'blue' | 'slate' }> = {
  CUMPRIDO: { label: 'Cumprido', tone: 'green' },
  NO_PRAZO: { label: 'No prazo', tone: 'blue' },
  A_VENCER: { label: 'Vence em até 6 h', tone: 'amber' },
  VENCIDO: { label: 'Vencido', tone: 'red' },
  SEM_PRAZO: { label: 'Sem prazo', tone: 'slate' },
};
export const STATUS: Record<string, { label: string; tone: 'amber' | 'green' | 'slate' }> = {
  RASCUNHO: { label: 'Rascunho', tone: 'amber' },
  NOTIFICADA: { label: 'Notificada', tone: 'green' },
  DESCARTADA: { label: 'Descartada', tone: 'slate' },
};
export const ORIGEM: Record<string, string> = { ATENDIMENTO: 'Atendimento', OBITO: 'Óbito', INTERNACAO: 'Internação', MANUAL: 'Manual', VACINA: 'Vacina (ESAVI)', VARREDURA: 'Recuperada pela varredura' };
export const MEIO: Record<string, string> = { SISTEMA: 'Painel do OmniSaúde', TELEFONE: 'Telefone', EMAIL: 'E-mail', FORMULARIO: 'Formulário eletrônico', PRESENCIAL: 'Presencial', OUTRO: 'Outro' };
export const EVENTO: Record<string, string> = {
  GERADA_PELO_GATILHO: 'Rascunho aberto pelo sistema',
  CRIADA_MANUAL: 'Notificação aberta manualmente',
  EDITADA: 'Ficha editada',
  SUBITEM_ALTERADO: 'Subitem alterado',
  CONFIRMADA: 'Notificação confirmada',
  CIENCIA_SMS: 'Ciência da vigilância municipal',
  COMUNICACAO: 'Comunicação registrada',
  ESCALADA: 'Escalada ao plantão',
  PRAZO_VENCIDO: 'Prazo vencido',
  DESCARTADA: 'Descartada',
};

/** "vence em 3 h 20 min" ou "vencido há 2 h". */
export function tempoAte(iso: string | null, agora = Date.now()): string {
  if (!iso) return 'sem prazo';
  const diff = Date.parse(iso) - agora;
  const abs = Math.abs(diff);
  const d = Math.floor(abs / 86_400_000);
  const h = Math.floor((abs % 86_400_000) / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const txt = d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
  return diff >= 0 ? `vence em ${txt}` : `vencido há ${txt}`;
}
