export type SituacaoPrazo = 'CUMPRIDO' | 'NO_PRAZO' | 'A_VENCER' | 'VENCIDO' | 'SEM_PRAZO';
export type Esfera = 'SMS' | 'SES' | 'MS';
export type Destino = Esfera | 'AUTORIDADE_POLICIAL';
export type SistemaOficial = 'SINAN_NET' | 'SINAN_ONLINE' | 'ESUS_SINAN' | 'ESUS_NOTIFICA' | 'SIVEP_GRIPE' | 'SINASC_SIM';

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
  /** null quando a notificação é de acesso restrito para quem consulta. */
  origem: string | null;
  agravo: string;
  grupo: string | null;
  sigiloso: boolean;
  naoHomologado: boolean;
  paciente: string | null;
  unidade: string | null;
  prazo: 'IMEDIATA' | 'SEMANAL' | null;
  esferas: Esfera[];
  venceEm: string | null;
  situacaoSms: SituacaoPrazo | null;
  repasses: { esfera: Esfera; situacao: SituacaoPrazo; venceEm: string | null }[];
  ciencia: boolean;
  escalada: boolean;
  semana: string | null;
  criadaEm: string;
  /** A pessoa pode abrir a ficha (alcance e sigilo). */
  podeAbrir: boolean;
  policial: { situacao: SituacaoPrazo; venceEm: string | null } | null;
  sistemaOficial: SistemaOficial | null;
  digitacao: 'PENDENTE' | 'DIGITADA' | 'LEMBRETE' | null;
  numeroOficial: string | null;
}

export interface PainelVigilancia {
  cartoes: {
    imediatasAguardandoCiencia: number;
    rascunhosImediatos: number;
    repassesPendentes: number;
    vencidas: number;
    semanaisAVencer: number;
    descartes30d: number;
    comunicacoesPoliciais: number;
    pendentesDigitacao: number;
    encerramentoVencido: number | null;
  };
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
  status: 'RASCUNHO' | 'NOTIFICADA' | 'DESCARTADA' | 'ENCERRADA';
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
    porEsfera: { esfera: Destino; rotulo: string; venceEm: string | null; cumpridaEm: string | null; situacao: SituacaoPrazo }[];
  };
  datas: { primeiroAtendimento: string | null; conhecimento: string; confirmacao: string | null; notificacao: string | null; sintomas: string | null; semanaNotificacao: string | null; semanaSintomas: string | null };
  ciencia: { em: string; por: string | null } | null;
  ficha: FichaFin;
  foraDoMunicipio: boolean;
  descarte: { em: string; motivo: string | null } | null;
  comunicacoes: { id: string; esfera: Destino; meio: string; em: string; interlocutor: string; orgao: string | null; contato: string | null; protocolo: string | null; notas: string | null; por: string | null }[];
  eventos: { id: string; tipo: string; em: string; por: string | null; notas: string | null }[];
  contatos: Contato[];
  saida: {
    sistema: SistemaOficial;
    sistemaLabel: string;
    digitacao: 'PENDENTE' | 'DIGITADA' | 'LEMBRETE' | null;
    numero: string | null;
    lote: string | null;
    digitadaPor: string | null;
    digitadaEm: string | null;
    dicaNumero: string;
    rota: { sistema: SistemaOficial; situacao: string; situacaoLabel: string; fonte: string; nota: string | null };
  } | null;
  encerramento: {
    investigadaEm: string | null;
    classificacao: string | null;
    classificacaoLabel: string | null;
    criterio: string | null;
    criterioLabel: string | null;
    evolucao: string | null;
    evolucaoLabel: string | null;
    obitoEm: string | null;
    encerradaEm: string | null;
    encerradaPor: string | null;
    conclusao: Record<string, string> | null;
    camposConclusao: { campo: string; rotulo: string; obrigatorio: boolean; obrigatorioSe?: string; tipo: 'texto' | 'data' | 'opcao'; opcoes?: Record<string, string> }[];
    numeracao: { investigacao: string; classificacao: string; criterio: string; evolucao: string; obito: string; encerramento: string };
    fichaEsus: boolean;
    prazoDias: number | null;
  };
  policial: { venceEm: string | null; dispensa: string | null } | null;
  /** Vítima fora do art. 14-A (menor de 18 anos ou idosa): a comunicação segue o ECA ou o Estatuto da Pessoa Idosa. */
  orientacaoViolencia: string | null;
  permissoes: {
    editar: boolean;
    confirmar: boolean;
    descartar: boolean;
    ciencia: boolean;
    comunicar: boolean;
    comunicarPolicia: boolean;
    digitar: boolean;
    desfazerDigitacao: boolean;
    encerrar: boolean;
    reabrir: boolean;
  };
  aviso: string;
}

export interface LinhaEspelho {
  bloco: 'NOTIFICACAO' | 'CONCLUSAO' | 'CONCLUSAO_ESUS';
  numero: string;
  variavel: string;
  rotulo: string;
  valor: string;
  exportado: string;
}

export interface FilaDigitacao {
  sistemas: { sistema: SistemaOficial; label: string; digitacao: boolean; dicaNumero: string; pendentes: number; lembretes: number; digitadas: number }[];
  notificacoes: (NotificacaoResumo & { notificadaEm: string | null; lote: string | null })[];
}

export interface RotaSistema {
  id: string;
  grupo: string;
  chave: string | null;
  sistema: SistemaOficial;
  sistemaLabel: string;
  situacao: string;
  situacaoLabel: string;
  vigenteDe: string;
  vigenteAte: string | null;
  vigente: boolean;
  fonte: string;
  notas: string | null;
}

export interface SugestaoSrag {
  admissionId: string;
  encounterId: string;
  patientId: string;
  paciente: string;
  unidade: string;
  internadoEm: string;
  cid: string;
  cidRespiratorio: boolean;
  sinais: string[];
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
export const STATUS: Record<string, { label: string; tone: 'amber' | 'green' | 'slate' | 'blue' }> = {
  RASCUNHO: { label: 'Rascunho', tone: 'amber' },
  NOTIFICADA: { label: 'Notificada', tone: 'green' },
  ENCERRADA: { label: 'Encerrada', tone: 'blue' },
  DESCARTADA: { label: 'Descartada', tone: 'slate' },
};
export const DIGITACAO: Record<string, { label: string; tone: 'amber' | 'green' | 'blue' }> = {
  PENDENTE: { label: 'Pendente de digitação', tone: 'amber' },
  DIGITADA: { label: 'Digitada', tone: 'green' },
  LEMBRETE: { label: 'Registrar na DNV/DO', tone: 'blue' },
};
export const ORIGEM: Record<string, string> = {
  ATENDIMENTO: 'Atendimento',
  OBITO: 'Óbito',
  INTERNACAO: 'Internação',
  MANUAL: 'Manual',
  VACINA: 'Vacina (ESAVI)',
  VARREDURA: 'Recuperada pela varredura',
  EXAME: 'Resultado de exame',
};
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
  DIGITADA: 'Número oficial informado',
  DIGITACAO_DESFEITA: 'Digitação desfeita',
  ENCERRADA: 'Investigação encerrada',
  REABERTA: 'Investigação reaberta',
  RESULTADO_EXAME: 'Confirmada por resultado de exame',
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
