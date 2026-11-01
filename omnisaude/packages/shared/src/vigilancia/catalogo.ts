/**
 * Catálogo da Lista Nacional de Notificação Compulsória (Anexo 1 do Anexo V da PRC GM/MS nº 4/2017) e regras de
 * notificação: versão aplicável na data, sobreposição estadual e municipal, escolha do subitem pelo contexto,
 * prazos (art. 2º, VII e VIII, art. 4º e parágrafo único) e idade no formato da ficha do Sinan.
 */

export type ContextoAgravo = 'CASO' | 'OBITO' | 'GESTANTE' | 'ANOMALIA_CONGENITA' | 'OUTRO';
export type CriterioNotificacao = 'SUSPEITA' | 'CONFIRMACAO';
export type MarcoPrazo = 'ATENDIMENTO' | 'CONHECIMENTO' | 'CONFIRMACAO';
export type SituacaoNormativa = 'VIGENTE' | 'EM_REVISAO';
export type Esfera = 'SMS' | 'SES' | 'MS';
export type TipoPrazo = 'IMEDIATA' | 'SEMANAL';
export type EscopoLista = 'NACIONAL' | 'ESTADUAL' | 'MUNICIPAL';

export interface CondicaoLnnc {
  key: string;
  group: string;
  item: number;
  subitem: string | null;
  name: string;
  context: ContextoAgravo;
  immediateMs: boolean;
  immediateSes: boolean;
  immediateSms: boolean;
  weekly: boolean;
  notifyOn: CriterioNotificacao;
  deadlineStart: MarcoPrazo;
  sensitive: boolean;
  /** Notificada uma vez por pessoa (doença crônica ou única): o gatilho não repete. */
  once: boolean;
  normativeStatus: SituacaoNormativa;
  normativeNote: string | null;
  sinanCode: string | null;
}

export interface VersaoNacionalLnnc {
  id: string;
  act: string;
  publishedIn: string;
  actUrl: string;
  validFrom: string;
  validTo: string | null;
  notes: string;
  sourceUrl: string;
  sourceSha256: string;
  consultedAt: string;
  conditions: CondicaoLnnc[];
}

export const ESFERA_LABEL: Record<Esfera, string> = { SMS: 'Secretaria Municipal de Saúde', SES: 'Secretaria Estadual de Saúde', MS: 'Ministério da Saúde' };
export const CONTEXTO_LABEL: Record<ContextoAgravo, string> = { CASO: 'Caso', OBITO: 'Óbito', GESTANTE: 'Gestante', ANOMALIA_CONGENITA: 'Anomalia congênita', OUTRO: 'Outro' };
export const MARCO_LABEL: Record<MarcoPrazo, string> = { ATENDIMENTO: 'primeiro atendimento', CONHECIMENTO: 'conhecimento da ocorrência', CONFIRMACAO: 'confirmação do caso' };

/** Janela em que o gatilho não repete a mesma notificação para a mesma pessoa (mesmo episódio). Decisão de projeto. */
export const REPETICAO_DIAS = 30;
/** Antecedência do alerta de prazo próximo. Parâmetro local. */
export const ALERTA_PRAZO_HORAS = 6;
const HORA = 3_600_000;

/** UF (código IBGE de 2 dígitos) da Amazônia Legal: RO, AC, AM, RR, PA, AP, TO, MA, MT. */
export const UF_AMAZONIA_LEGAL = new Set(['11', '12', '13', '14', '15', '16', '17', '21', '51']);

/** Esferas da notificação imediata marcadas no Anexo 1 para a linha. */
export function esferasImediatas(c: Pick<CondicaoLnnc, 'immediateMs' | 'immediateSes' | 'immediateSms'>): Esfera[] {
  return [...(c.immediateSms ? (['SMS'] as const) : []), ...(c.immediateSes ? (['SES'] as const) : []), ...(c.immediateMs ? (['MS'] as const) : [])];
}

export function tipoPrazo(c: Pick<CondicaoLnnc, 'weekly'>): TipoPrazo {
  return c.weekly ? 'SEMANAL' : 'IMEDIATA';
}

/** Versão vigente na data (AAAA-MM-DD). Antes da mais antiga carregada, vale a mais antiga (com aviso). */
export function versaoNaData<V extends { validFrom: string; validTo: string | null }>(versoes: V[], dia: string): { versao: V; anteriorAoCatalogo: boolean } | null {
  if (!versoes.length) return null;
  const vigente = versoes.find((v) => v.validFrom <= dia && (!v.validTo || dia <= v.validTo));
  if (vigente) return { versao: vigente, anteriorAoCatalogo: false };
  const ordenadas = [...versoes].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  if (dia < ordenadas[0]!.validFrom) return { versao: ordenadas[0]!, anteriorAoCatalogo: true };
  return { versao: ordenadas[ordenadas.length - 1]!, anteriorAoCatalogo: false };
}

/** Retrato do catálogo na data: nacional vigente, depois estadual e municipal vigentes; mesma chave local substitui a nacional. */
export function mesclarCatalogo<C extends { key: string }>(nacional: C[], estadual: C[] = [], municipal: C[] = []): C[] {
  const porChave = new Map<string, C>();
  for (const c of [...nacional, ...estadual, ...municipal]) porChave.set(c.key, c);
  return [...porChave.values()];
}

export interface ContextoPaciente {
  obito?: boolean;
  gestante?: boolean;
  /** UF do município de atendimento na Amazônia Legal (malária). */
  amazoniaLegal?: boolean;
  /** Contexto indicado pelo próprio código (ex.: P35.4 → anomalia congênita). */
  dica?: ContextoAgravo | null;
}

/**
 * Escolhe a linha do grupo pelo contexto: óbito > anomalia (dica do código) > gestante > caso.
 * Malária: região amazônica (CASO) ou extra-amazônica (OUTRO) pela UF do atendimento.
 */
export function escolherCondicao<C extends Pick<CondicaoLnnc, 'group' | 'context' | 'item'>>(catalogo: C[], grupo: string, ctx: ContextoPaciente): C | null {
  const doGrupo = catalogo.filter((c) => c.group === grupo).sort((a, b) => a.item - b.item);
  if (!doGrupo.length) return null;
  const com = (contexto: ContextoAgravo) => doGrupo.find((c) => c.context === contexto) ?? null;
  if (grupo === 'malaria') return (ctx.amazoniaLegal === false ? com('OUTRO') : com('CASO')) ?? doGrupo[0]!;
  if (ctx.obito && com('OBITO')) return com('OBITO');
  if (ctx.dica && com(ctx.dica)) return com(ctx.dica);
  if (ctx.gestante && com('GESTANTE')) return com('GESTANTE');
  return com('CASO') ?? doGrupo[0]!;
}

export interface Marcos {
  /** Início do primeiro atendimento. */
  atendimento: Date | null;
  /** Conhecimento da ocorrência (assinatura do registro ou data informada). */
  conhecimento: Date;
  /** Confirmação do caso (quando o agravo só se notifica confirmado). */
  confirmacao: Date | null;
  /** Atendimento de internação: a suspeita pode surgir dias depois da admissão (decisão a validar pela vigilância). */
  internacao?: boolean;
}

export interface PrazoNotificacao {
  tipo: TipoPrazo;
  esferas: Esfera[];
  marco: MarcoPrazo;
  inicio: Date | null;
  vence: Date | null;
  aguardandoConfirmacao: boolean;
}

/** Prazo legal: imediata em 24 h e semanal em 7 dias, contados do marco do agravo (art. 2º, VII e VIII; art. 4º). */
export function calcularPrazo(c: Pick<CondicaoLnnc, 'weekly' | 'immediateMs' | 'immediateSes' | 'immediateSms' | 'deadlineStart'>, m: Marcos): PrazoNotificacao {
  const tipo = tipoPrazo(c);
  let marco = c.deadlineStart;
  if (marco === 'ATENDIMENTO' && (m.internacao || !m.atendimento)) marco = 'CONHECIMENTO';
  const inicio = marco === 'ATENDIMENTO' ? m.atendimento : marco === 'CONFIRMACAO' ? m.confirmacao : m.conhecimento;
  const horas = tipo === 'IMEDIATA' ? 24 : 7 * 24;
  return {
    tipo,
    esferas: tipo === 'IMEDIATA' ? esferasImediatas(c) : ['SMS'],
    marco,
    inicio,
    vence: inicio ? new Date(inicio.getTime() + horas * HORA) : null,
    aguardandoConfirmacao: marco === 'CONFIRMACAO' && !inicio,
  };
}

/** Repasse da SMS às demais esferas: 24 h a partir do recebimento (art. 4º, parágrafo único). */
export function prazoRepasse(recebidaEm: Date): Date {
  return new Date(recebidaEm.getTime() + 24 * HORA);
}

export type SituacaoPrazoNotificacao = 'CUMPRIDO' | 'NO_PRAZO' | 'A_VENCER' | 'VENCIDO' | 'SEM_PRAZO';

export function situacaoDoPrazo(vence: Date | null, cumpridoEm: Date | null, agora: Date = new Date(), alertaHoras = ALERTA_PRAZO_HORAS): SituacaoPrazoNotificacao {
  if (cumpridoEm) return 'CUMPRIDO';
  if (!vence) return 'SEM_PRAZO';
  const resta = vence.getTime() - agora.getTime();
  if (resta < 0) return 'VENCIDO';
  return resta <= alertaHoras * HORA ? 'A_VENCER' : 'NO_PRAZO';
}

/** "CID10:A37.9", "A379" ou "CIAP2:A70" → sistema e código normalizado (sem ponto, maiúsculo). */
export function normalizarCodigo(bruto: string): { system: 'CID10' | 'CIAP2'; code: string } | null {
  const m = /^(?:(CID10|CIAP2|CIAP|CID):)?\s*([A-Za-z][0-9A-Za-z.]{1,6})$/.exec(bruto.trim());
  if (!m) return null;
  const system = m[1] === 'CIAP2' || m[1] === 'CIAP' ? 'CIAP2' : 'CID10';
  return { system, code: m[2]!.toUpperCase().replace(/\./g, '') };
}

/** Mapeamento de código para agravo pelo prefixo mais longo. */
export function mapearCodigo<M extends { system: string; codePrefix: string }>(mapas: M[], system: string, code: string): M[] {
  const candidatos = mapas.filter((m) => m.system === system && code.startsWith(m.codePrefix));
  if (!candidatos.length) return [];
  const maior = Math.max(...candidatos.map((m) => m.codePrefix.length));
  return candidatos.filter((m) => m.codePrefix.length === maior);
}

/**
 * Idade da ficha do Sinan (campo 9 da FIN): valor com unidade H (horas), D (dias), M (meses) ou A (anos),
 * calculada do nascimento até a data de referência; o código numérico é a unidade (1 a 4) seguida de 3 dígitos.
 */
export function idadeSinan(nascimento: Date, referencia: Date): { valor: number; unidade: 'H' | 'D' | 'M' | 'A'; codigo: string } {
  const ms = referencia.getTime() - nascimento.getTime();
  const horas = Math.floor(ms / HORA);
  const pad = (n: number) => String(Math.max(0, n)).padStart(3, '0');
  if (horas < 24) return { valor: horas, unidade: 'H', codigo: `1${pad(horas)}` };
  const dias = Math.floor(horas / 24);
  const n = nascimento;
  const r = referencia;
  let meses = (r.getUTCFullYear() - n.getUTCFullYear()) * 12 + (r.getUTCMonth() - n.getUTCMonth());
  if (r.getUTCDate() < n.getUTCDate()) meses -= 1;
  if (meses < 1) return { valor: dias, unidade: 'D', codigo: `2${pad(dias)}` };
  if (meses < 12) return { valor: meses, unidade: 'M', codigo: `3${pad(meses)}` };
  const anos = Math.floor(meses / 12);
  return { valor: anos, unidade: 'A', codigo: `4${pad(anos)}` };
}
