export interface Unidade {
  id: string;
  nome: string;
  endereco: string | null;
  telefone: string | null;
}

export interface Eu {
  cidadao: { id: string; nome: string; primeiroNome: string; nascimento: string; idade: number; cns: string | null; cpf: string | null; telefone: string | null; whatsapp: boolean };
  unidadeReferencia: { id: string; name: string; address: string | null; phone: string | null; openingHours: string | null } | null;
  proximoAgendamento: { id: string; servico: string; quando: string; unidade: string | null; status: string; statusLabel: string } | null;
  pendencias: { examesNovos: number; vacinasAtrasadas: number; solicitacoesEmAndamento: number };
  senhaHoje: Senha | null;
}

export interface Agendamento {
  id: string;
  servico: string;
  tipo: string;
  quando: string;
  fim: string;
  unidade: Unidade | null;
  profissional: string | null;
  status: string;
  statusLabel: string;
  confirmadoEm: string | null;
  podeCancelar: boolean;
  podeConfirmar: boolean;
  futuro: boolean;
}

export interface Agenda {
  proximos: Agendamento[];
  historico: Agendamento[];
  lembretes: { whatsapp: boolean; telefone: string | null; horasAntes: number };
}

export interface Exame {
  id: string;
  nome: string;
  status: string;
  statusLabel: string;
  solicitadoEm: string;
  solicitante: string | null;
  unidade: string | null;
  resultado: { valor: number | null; unidade: string | null; texto: string | null; em: string | null; novo: boolean } | null;
}

export interface Vacinas {
  doses: { id: string; vacina: string; dose: string; lote: string | null; fabricante: string | null; aplicadaEm: string; proximaEm: string | null; unidade: string | null; transcrita: boolean }[];
  proximas: { vacina: string; nome: string; dose: string; previstaPara: string | null; situacao: string }[];
  atrasadas: number;
  certificadoDisponivel: boolean;
}

export interface Medicamentos {
  itens: {
    id: string;
    medicamento: string;
    posologia: string;
    usoContinuo: boolean;
    prescritoEm: string;
    prescritor: string | null;
    ultimaRetirada: string | null;
    disponivelEm: { unidade: string; quantidade: number }[];
    cadastradoNaFarmacia: boolean;
  }[];
  retiradas: { id: string; em: string; unidade: string | null; itens: { medicamento: string; quantidade: number; unidade: string }[] }[];
}

export interface Regulacao {
  solicitacoes: {
    id: string;
    protocolo: string;
    procedimento: string;
    prioridade: string;
    status: string;
    statusLabel: string;
    posicaoNaFila: number | null;
    unidadeSolicitante: string | null;
    unidadeExecutante: string | null;
    agendadoPara: string | null;
    devolutiva: string | null;
    em: string;
  }[];
  leitos: { id: string; protocolo: string; tipo: string; especialidade: string; prioridade: string; status: string; statusLabel: string; origem: string | null; destino: string | null; em: string }[];
  tfd: {
    id: string;
    protocolo: string;
    procedimento: string;
    destino: string;
    status: string;
    statusLabel: string;
    transporte: string;
    atendimento: { em: string; local: string | null } | null;
    ajudaCusto: { total: number; paga: boolean } | null;
    viagem: { data: string; saida: string | null; veiculo: string; motorista: string; telefoneMotorista: string | null } | null;
    em: string;
  }[];
}

export interface Senha {
  id: string;
  senha: string;
  tipo: string;
  setor: string;
  unidade: string;
  status: string;
  statusLabel: string;
  guiche: string | null;
  posicao: number | null;
  chamadaEm: string | null;
}

export interface UnidadeRede {
  id: string;
  name: string;
  type: string;
  tipoLabel: string;
  address: string | null;
  phone: string | null;
  openingHours: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface Manifestacao {
  id: string;
  protocolo: string;
  tipo: string;
  tipoLabel: string;
  assunto: string;
  assuntoLabel: string;
  unidade: string | null;
  anonima: boolean;
  texto: string;
  status: string;
  statusLabel: string;
  recebidaEm: string;
  venceEm: string;
  prorrogada: boolean;
  resposta: { texto: string; em: string | null } | null;
  avaliacao: number | null;
  podeAvaliar: boolean;
}

export interface Avaliacao {
  id: string;
  unidade: string;
  profissional: string | null;
  atendimentoEm: string;
  status: 'PENDENTE' | 'RESPONDIDA' | 'EXPIRADA';
  nota: number | null;
  notaLabel: string | null;
  recomendaria: number | null;
  comentario: string | null;
  validaAte: string;
}

export interface MeuSusDigital {
  prontidao: { cpf: boolean; cns: boolean; rndsAtiva: boolean; pronto: boolean; pendencias: string[] };
  enviados: { atendimentos: number; vacinas: number; dispensacoes: number; altas: number; regulacao: number; total: number };
  pendentes: number;
  falhas: number;
  descartados: number;
  ultimoEnvio: string | null;
  link: string;
}
