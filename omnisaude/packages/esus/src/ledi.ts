import { randomUUID } from 'node:crypto';
import { LEDI_VERSAO, TIPO_DADO, TIPO_LOGRADOURO_DNE, UF_DNE, type TipoDado } from './codes';
import { encodeLedi, type LediObject } from './thrift';

/**
 * Camada de transporte do LEDI e utilitários comuns às fichas: identificadores, datas em epoch (ms),
 * turno, normalização de nomes (regras do CADSUS) e endereço no padrão DNE.
 */

export interface Instalacao {
  /** "<Nome do software> - versão". */
  contraChave: string;
  uuidInstalacao: string;
  cpfOuCnpj: string;
  nomeOuRazaoSocial: string;
  fone?: string;
  email?: string;
  versaoSistema?: string;
}

export interface DadoTransporteInput {
  uuid: string;
  tipo: TipoDado;
  cnes: string;
  codIbge: string;
  ine?: string | null;
  numLote?: number;
  ficha: Uint8Array;
  instalacao: Instalacao;
}

const STRUCT_BY_TIPO: Record<number, string> = {
  [TIPO_DADO.CADASTRO_INDIVIDUAL]: 'CadastroIndividualThrift',
  [TIPO_DADO.CADASTRO_DOMICILIAR]: 'CadastroDomiciliarThrift',
  [TIPO_DADO.ATENDIMENTO_INDIVIDUAL]: 'FichaAtendimentoIndividualMasterThrift',
  [TIPO_DADO.ATENDIMENTO_ODONTOLOGICO]: 'FichaAtendimentoOdontologicoMasterThrift',
  [TIPO_DADO.ATIVIDADE_COLETIVA]: 'FichaAtividadeColetivaThrift',
  [TIPO_DADO.PROCEDIMENTOS]: 'FichaProcedimentoMasterThrift',
  [TIPO_DADO.VISITA_DOMICILIAR]: 'FichaVisitaDomiciliarMasterThrift',
  [TIPO_DADO.VACINACAO]: 'FichaVacinacaoMasterThrift',
};

/** Nome da estrutura Thrift (raiz) de cada tipo de dado serializado. */
export function structForTipo(tipo: number): string {
  const s = STRUCT_BY_TIPO[tipo];
  if (!s) throw new Error(`Tipo de dado serializado sem estrutura conhecida: ${tipo}`);
  return s;
}

/** uuidDadoSerializado/uuidFicha no formato recomendado: CNES + "-" + UUID (44 caracteres). */
export function lediUuid(cnes: string, uuid = randomUUID()): string {
  return `${cnes}-${uuid}`;
}

export function dadoInstalacao(i: Instalacao): LediObject {
  return { contraChave: i.contraChave, uuidInstalacao: i.uuidInstalacao, cpfOuCnpj: i.cpfOuCnpj, nomeOuRazaoSocial: i.nomeOuRazaoSocial, fone: i.fone, email: i.email, versaoSistema: i.versaoSistema };
}

/** Monta e serializa o DadoTransporte (o conteúdo de um arquivo .esus). */
export function buildDadoTransporte(input: DadoTransporteInput): Buffer {
  const instalacao = dadoInstalacao(input.instalacao);
  return encodeLedi('DadoTransporteThrift', {
    uuidDadoSerializado: input.uuid,
    tipoDadoSerializado: input.tipo,
    cnesDadoSerializado: input.cnes,
    codIbge: input.codIbge,
    ineDadoSerializado: input.ine ?? undefined,
    numLote: input.numLote,
    dadoSerializado: input.ficha,
    remetente: instalacao,
    originadora: instalacao,
    versao: { ...LEDI_VERSAO },
  });
}

/** Epoch em milissegundos (o LEDI usa Long com a data/hora em UTC). */
export const epochMs = (d: Date) => d.getTime();

/** Data (sem hora) em epoch ms, à meia-noite UTC, como o PEC espera para datas de nascimento. */
export function epochDate(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Hora local no fuso informado. */
function localHour(d: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(d);
  return Number(h) % 24;
}

/** Turno do atendimento pela hora local: manhã até 12h, tarde até 18h, noite depois. */
export function turnoFromDate(d: Date, timeZone: string): 1 | 2 | 3 {
  const h = localHour(d, timeZone);
  return h < 12 ? 1 : h < 18 ? 2 : 3;
}

/**
 * Nome no padrão do CADSUS/LEDI: maiúsculas, sem espaços duplicados, só letras (com acentos) e apóstrofo.
 * Devolve null quando o nome não atende às regras (um único termo, termos de uma letra etc.).
 */
export function normalizeName(name: string): string | null {
  const cleaned = name
    .normalize('NFC')
    .replace(/[^\p{L}' ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  const terms = cleaned.split(' ').filter(Boolean);
  if (cleaned.length < 3 || terms.length < 2) return null;
  if (terms[0]!.length === 1 && terms[1]!.length === 1) return null;
  if (terms.length === 2 && terms[0]!.length === 2 && terms[1]!.length === 2) return null;
  return cleaned;
}

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

const LOGRADOURO_BY_NAME = Object.entries(TIPO_LOGRADOURO_DNE)
  .map(([code, name]) => ({ code, name: strip(name) }))
  .sort((a, b) => b.name.length - a.name.length);

/**
 * Separa o tipo de logradouro (código DNE) do nome: "Rua de 14 Novembro" → { tipo: '081', nome: 'DE 14 NOVEMBRO' }.
 * Sem tipo reconhecível no início, assume RUA (081) e mantém o texto inteiro como nome.
 */
export function splitLogradouro(street: string): { tipo: string; nome: string } {
  const upper = strip(street).replace(/\s+/g, ' ');
  for (const t of LOGRADOURO_BY_NAME) {
    if (upper === t.name || upper.startsWith(`${t.name} `)) {
      const rest = upper.slice(t.name.length).trim();
      return { tipo: t.code, nome: rest || t.name };
    }
  }
  return { tipo: '081', nome: upper };
}

export function ufDne(uf: string | null | undefined): string | undefined {
  return uf ? UF_DNE[uf.toUpperCase()] : undefined;
}

/** Código IBGE com 7 dígitos (o cadastro pode guardar 6, sem o dígito verificador). */
export function ibge7(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  const digits = code.replace(/\D/g, '');
  if (digits.length === 7) return digits;
  if (digits.length !== 6) return undefined;
  // Dígito verificador do IBGE (módulo 10 com pesos 1,2,1,2,1,2).
  const weights = [1, 2, 1, 2, 1, 2];
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    const p = Number(digits[i]) * weights[i]!;
    sum += p > 9 ? p - 9 : p;
  }
  const dv = (10 - (sum % 10)) % 10;
  return `${digits}${dv}`;
}

/** Texto só com dígitos, ou undefined quando vazio. */
export const digits = (v: string | null | undefined) => {
  const d = (v ?? '').replace(/\D/g, '');
  return d || undefined;
};

/** Telefone com DDD (10 ou 11 dígitos), sem o código do país. */
export function phoneDigits(v: string | null | undefined): string | undefined {
  const d = digits(v);
  if (!d) return undefined;
  const local = d.length > 11 && d.startsWith('55') ? d.slice(2) : d;
  return local.length === 10 || local.length === 11 ? local : undefined;
}
