import type { PrioridadeRegulacao } from './regulacao';

// ───────────────────────────── Regulação de leitos da rede (REG-7) ─────────────────────────────

export type TipoLeito = 'CLINICA_MEDICA' | 'CIRURGICA' | 'UTI_ADULTO' | 'UTI_PEDIATRICA' | 'PEDIATRIA' | 'OBSTETRICIA' | 'OBSERVACAO';
export const TIPO_LEITO: Record<TipoLeito, string> = {
  CLINICA_MEDICA: 'Clínica médica',
  CIRURGICA: 'Clínica cirúrgica',
  UTI_ADULTO: 'UTI adulto',
  UTI_PEDIATRICA: 'UTI pediátrica',
  PEDIATRIA: 'Pediatria',
  OBSTETRICIA: 'Obstetrícia',
  OBSERVACAO: 'Observação',
};

/** Prioridade da vaga: o prazo é em horas (a regulação de leitos é mais curta que a ambulatorial). */
export const PRIORIDADE_LEITO: Record<PrioridadeRegulacao, { label: string; descricao: string; prazoHoras: number; ordem: number }> = {
  VERMELHA: { label: 'Emergência', descricao: 'Risco de vida iminente: vaga imediata (UTI, suporte avançado)', prazoHoras: 2, ordem: 0 },
  AMARELA: { label: 'Urgência', descricao: 'Instabilidade ou agravamento previsível em horas', prazoHoras: 6, ordem: 1 },
  VERDE: { label: 'Prioritária', descricao: 'Estável, mas precisa de internação nas próximas 24 h', prazoHoras: 24, ordem: 2 },
  AZUL: { label: 'Eletiva', descricao: 'Internação programada (cirurgia eletiva, investigação)', prazoHoras: 72, ordem: 3 },
};

export type StatusSolicitacaoLeito = 'PENDENTE' | 'EM_ANALISE' | 'DEVOLVIDA' | 'AUTORIZADA' | 'EM_TRANSFERENCIA' | 'INTERNADA' | 'NEGADA' | 'CANCELADA';
export const STATUS_SOLICITACAO_LEITO: Record<StatusSolicitacaoLeito, string> = {
  PENDENTE: 'Aguardando regulação',
  EM_ANALISE: 'Em análise',
  DEVOLVIDA: 'Devolvida com pendência',
  AUTORIZADA: 'Vaga autorizada',
  EM_TRANSFERENCIA: 'Em transferência',
  INTERNADA: 'Internada',
  NEGADA: 'Negada',
  CANCELADA: 'Cancelada',
};
/** Situações em que a solicitação ainda ocupa a fila do regulador. */
export const STATUS_LEITO_NA_FILA: StatusSolicitacaoLeito[] = ['PENDENTE', 'EM_ANALISE'];
/** Situações em que a solicitação está viva (ainda pode ser cancelada). */
export const STATUS_LEITO_ABERTOS: StatusSolicitacaoLeito[] = ['PENDENTE', 'EM_ANALISE', 'DEVOLVIDA', 'AUTORIZADA', 'EM_TRANSFERENCIA'];

export type TransporteTransferencia = 'AMBULANCIA_UTI' | 'AMBULANCIA_BASICA' | 'VEICULO_SANITARIO' | 'PROPRIO';
export const TRANSPORTE_TRANSFERENCIA: Record<TransporteTransferencia, string> = {
  AMBULANCIA_UTI: 'Ambulância de suporte avançado (UTI móvel)',
  AMBULANCIA_BASICA: 'Ambulância de suporte básico',
  VEICULO_SANITARIO: 'Veículo sanitário',
  PROPRIO: 'Meios próprios',
};

export type NivelConsciencia = 'ALERTA' | 'CONFUSO' | 'VOZ' | 'DOR' | 'IRRESPONSIVO';
export const NIVEL_CONSCIENCIA: Record<NivelConsciencia, string> = { ALERTA: 'Alerta', CONFUSO: 'Confusão nova', VOZ: 'Responde à voz', DOR: 'Responde à dor', IRRESPONSIVO: 'Irresponsivo' };

export interface SinaisVitais {
  pas?: number | null;
  pad?: number | null;
  fc?: number | null;
  fr?: number | null;
  sato2?: number | null;
  temp?: number | null;
  consciencia?: NivelConsciencia | null;
  /** Em uso de oxigênio suplementar. */
  oxigenio?: boolean | null;
}

export interface Suporte {
  ventilacaoMecanica?: boolean;
  drogaVasoativa?: boolean;
  oxigenio?: boolean;
  dialise?: boolean;
}

export interface News2 {
  pontos: number;
  /** Pontuação de cada parâmetro informado. */
  componentes: Partial<Record<'fr' | 'sato2' | 'oxigenio' | 'pas' | 'fc' | 'consciencia' | 'temp', number>>;
  /** Parâmetros faltantes (a pontuação parcial subestima o risco). */
  faltando: string[];
  risco: 'BAIXO' | 'BAIXO_MEDIO' | 'MEDIO' | 'ALTO';
}

const faixa = (v: number, cortes: [number, number][]): number => {
  for (const [limite, pontos] of cortes) if (v <= limite) return pontos;
  return cortes[cortes.length - 1]![1];
};

/** NEWS2 (Royal College of Physicians, 2017), escala 1 de SpO2. Qualquer parâmetro com 3 pontos eleva o risco a baixo-médio. */
export function news2(v: SinaisVitais): News2 {
  const c: News2['componentes'] = {};
  const faltando: string[] = [];
  if (v.fr != null) c.fr = v.fr <= 8 ? 3 : v.fr <= 11 ? 1 : v.fr <= 20 ? 0 : v.fr <= 24 ? 2 : 3;
  else faltando.push('frequência respiratória');
  if (v.sato2 != null) c.sato2 = v.sato2 <= 91 ? 3 : v.sato2 <= 93 ? 2 : v.sato2 <= 95 ? 1 : 0;
  else faltando.push('saturação');
  c.oxigenio = v.oxigenio ? 2 : 0;
  if (v.pas != null) c.pas = v.pas <= 90 ? 3 : v.pas <= 100 ? 2 : v.pas <= 110 ? 1 : v.pas <= 219 ? 0 : 3;
  else faltando.push('pressão arterial');
  if (v.fc != null) c.fc = v.fc <= 40 ? 3 : v.fc <= 50 ? 1 : v.fc <= 90 ? 0 : v.fc <= 110 ? 1 : v.fc <= 130 ? 2 : 3;
  else faltando.push('frequência cardíaca');
  if (v.consciencia) c.consciencia = v.consciencia === 'ALERTA' ? 0 : 3;
  else faltando.push('nível de consciência');
  if (v.temp != null) c.temp = faixa(v.temp, [[35.0, 3], [36.0, 1], [38.0, 0], [39.0, 1], [999, 2]]);
  else faltando.push('temperatura');
  const valores = Object.values(c);
  const pontos = valores.reduce((s, x) => s + x, 0);
  const risco: News2['risco'] = pontos >= 7 ? 'ALTO' : pontos >= 5 ? 'MEDIO' : valores.some((x) => x === 3) ? 'BAIXO_MEDIO' : 'BAIXO';
  return { pontos, componentes: c, faltando, risco };
}

/** Prioridade sugerida ao solicitante a partir do NEWS2, do suporte em uso e do tipo de leito. */
export function prioridadeLeitoSugerida(n: News2 | null, suporte: Suporte, tipo: TipoLeito, eletiva = false): PrioridadeRegulacao {
  if (suporte.ventilacaoMecanica || suporte.drogaVasoativa || tipo === 'UTI_ADULTO' || tipo === 'UTI_PEDIATRICA') return 'VERMELHA';
  if (n && n.risco === 'ALTO') return 'VERMELHA';
  if ((n && n.risco === 'MEDIO') || suporte.oxigenio || suporte.dialise) return 'AMARELA';
  if (eletiva && (!n || n.risco === 'BAIXO')) return 'AZUL';
  return 'VERDE';
}

export interface ItemFilaLeito {
  priority: PrioridadeRegulacao;
  createdAt: Date | string;
}

/** Fila da central: prioridade e, dentro dela, quem espera há mais tempo. */
export function ordenarFilaLeitos<T extends ItemFilaLeito>(itens: T[]): T[] {
  return [...itens].sort((a, b) => PRIORIDADE_LEITO[a.priority].ordem - PRIORIDADE_LEITO[b.priority].ordem || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export function prazoMetaLeito(prioridade: PrioridadeRegulacao, createdAt: Date | string): Date {
  return new Date(new Date(createdAt).getTime() + PRIORIDADE_LEITO[prioridade].prazoHoras * 3_600_000);
}

export function horasEmFila(createdAt: Date | string, ate: Date | string = new Date()): number {
  return Math.round(((new Date(ate).getTime() - new Date(createdAt).getTime()) / 3_600_000) * 10) / 10;
}

export function numeroProtocoloLeito(ano: number, sequencia: number): string {
  return `LEI-${ano}-${String(sequencia).padStart(6, '0')}`;
}

// ───────────────────────────── AIH (SIH/SUS) ─────────────────────────────

export type StatusAih = 'PENDENTE' | 'AUTORIZADA' | 'NEGADA' | 'CANCELADA';
export const STATUS_AIH: Record<StatusAih, string> = { PENDENTE: 'Aguardando autorização', AUTORIZADA: 'Autorizada', NEGADA: 'Negada', CANCELADA: 'Cancelada' };

/** Especialidade do leito no SIH/SUS (campo "especialidade" da AIH). */
export const ESPECIALIDADE_AIH: Record<string, string> = {
  '01': 'Cirurgia',
  '02': 'Obstetrícia',
  '03': 'Clínica médica',
  '04': 'Cuidados prolongados (crônicos)',
  '05': 'Psiquiatria',
  '06': 'Pneumologia sanitária (tisiologia)',
  '07': 'Pediatria',
  '08': 'Reabilitação',
};
/** Caráter de atendimento da internação (tabela do SIH/SUS). */
export const CARATER_INTERNACAO: Record<string, string> = {
  '01': 'Eletivo',
  '02': 'Urgência',
  '03': 'Acidente no local de trabalho ou a serviço da empresa',
  '04': 'Acidente no trajeto para o trabalho',
  '05': 'Outros tipos de acidente de trânsito',
  '06': 'Outros tipos de lesões e envenenamentos (agentes químicos ou físicos)',
};
/** Tipo de AIH: 1 = principal (nova internação), 5 = longa permanência (continuidade). */
export const TIPO_AIH: Record<string, string> = { '1': 'AIH principal', '5': 'AIH de longa permanência' };
/** Especialidade de leito da AIH sugerida a partir do tipo de leito da rede. */
export const ESPECIALIDADE_POR_TIPO_LEITO: Record<TipoLeito, string> = { CLINICA_MEDICA: '03', CIRURGICA: '01', UTI_ADULTO: '03', UTI_PEDIATRICA: '07', PEDIATRIA: '07', OBSTETRICIA: '02', OBSERVACAO: '03' };

/** Código IBGE da UF (os dois primeiros dígitos do número da AIH). */
export const CODIGO_UF: Record<string, string> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17', MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41', SC: '42', RS: '43', MS: '50', MT: '51', GO: '52', DF: '53',
};

/**
 * Dígito verificador do número da AIH (módulo 11 sobre os 12 primeiros dígitos, pesos 2 a 9 da direita para a
 * esquerda; resto 0 ou 1 vira dígito 0). A faixa numérica em si é distribuída pelo gestor (SIH/SUS).
 */
export function dvAih(doze: string): string {
  if (!/^\d{12}$/.test(doze)) throw new Error('Informe os 12 dígitos iniciais da AIH');
  let peso = 2;
  let soma = 0;
  for (let i = doze.length - 1; i >= 0; i--) {
    soma += Number(doze[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  const dv = 11 - resto;
  return String(dv >= 10 ? 0 : dv);
}

/** Monta o número de 13 dígitos: UF (2) + ano (2) + tipo (1) + sequencial (7) + DV. */
export function numeroAih(uf: string, ano: number, tipo: '1' | '5', sequencial: number): string {
  const cod = CODIGO_UF[uf.toUpperCase()];
  if (!cod) throw new Error(`UF inválida: ${uf}`);
  if (sequencial < 1 || sequencial > 9_999_999) throw new Error('Sequencial fora da faixa');
  const doze = `${cod}${String(ano % 100).padStart(2, '0')}${tipo}${String(sequencial).padStart(7, '0')}`;
  return `${doze}${dvAih(doze)}`;
}

export function validarNumeroAih(numero: string): { ok: boolean; motivo?: string } {
  const n = numero.replace(/\D/g, '');
  if (n.length !== 13) return { ok: false, motivo: 'O número da AIH tem 13 dígitos' };
  if (!Object.values(CODIGO_UF).includes(n.slice(0, 2))) return { ok: false, motivo: 'Os dois primeiros dígitos devem ser o código da UF' };
  if (!['1', '3', '5'].includes(n[4]!)) return { ok: false, motivo: 'O quinto dígito é o tipo da AIH (1, 3 ou 5)' };
  if (dvAih(n.slice(0, 12)) !== n[12]) return { ok: false, motivo: 'Dígito verificador inválido' };
  return { ok: true };
}

/** Validade padrão do laudo autorizado: a internação precisa iniciar em até 30 dias (eletiva). */
export function validadeAih(autorizadaEm: Date, dias = 30): Date {
  return new Date(autorizadaEm.getTime() + dias * 86_400_000);
}
