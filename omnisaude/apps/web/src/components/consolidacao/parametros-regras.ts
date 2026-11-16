/*
 * Parâmetros da semana 27 nas configurações da vigilância (GET e PATCH /vigilancia/configuracoes, `vigilancia.catalogo`):
 * prazo, meta e janelas da notificação negativa, semanas incompletas e validade da prévia da consolidação, e os dias do
 * evento inusitado do surto. Sem React (testadas em apps/web/test/telas27-parametros.test.ts). Os limites são os do
 * zod da API; o PATCH vai campo a campo (o que não mudou não vai).
 */

/** Bloco da notificação negativa nas configurações. */
export interface ParametrosNegativa {
  /** Dia do prazo na semana seguinte à SE: 0 = domingo … 6 = sábado. */
  prazoDiaSemana: number;
  /** HH:MM, no fuso da instituição. */
  prazoHora: string;
  contaAtrasada: boolean;
  metaPercentual: number;
  semanasSilenciosa: number;
  semanasSoNegativa: number;
  semanasRegularidadeMunicipal: number;
  semanasAtesto: number;
}

export interface ParametrosConsolidacao {
  semanasIncompletas: number;
  expiraPreviaHoras: number;
}

/** O que a tela lê de GET /vigilancia/configuracoes (a resposta traz também o plantão e os prazos de encerramento). */
export interface ConfiguracoesDaVigilancia {
  negativa: ParametrosNegativa;
  consolidacao: ParametrosConsolidacao;
  surto: { diasInusitado: number };
}

/** Corpo do PATCH: só os blocos e os campos que mudaram. */
export interface MudancaParametros {
  negativa?: Partial<ParametrosNegativa>;
  consolidacao?: Partial<ParametrosConsolidacao>;
  surto?: { diasInusitado?: number };
}

/** Formulário (números como texto digitado). */
export interface FormParametros {
  prazoDiaSemana: string;
  prazoHora: string;
  contaAtrasada: boolean;
  metaPercentual: string;
  semanasSilenciosa: string;
  semanasSoNegativa: string;
  semanasRegularidadeMunicipal: string;
  semanasAtesto: string;
  semanasIncompletas: string;
  expiraPreviaHoras: string;
  diasInusitado: string;
}

export const DIAS_DA_SEMANA = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'] as const;

type CampoNumerico = Exclude<keyof FormParametros, 'prazoHora' | 'contaAtrasada'>;

/** Limites dos campos numéricos (os mesmos da API) e o rótulo usado nas mensagens. */
export const LIMITES_PARAMETROS: Record<CampoNumerico, { min: number; max: number; rotulo: string }> = {
  prazoDiaSemana: { min: 0, max: 6, rotulo: 'Dia do prazo' },
  metaPercentual: { min: 1, max: 100, rotulo: 'Meta de unidades com informação (%)' },
  semanasSilenciosa: { min: 1, max: 52, rotulo: 'Semanas para a unidade ser silenciosa' },
  semanasSoNegativa: { min: 1, max: 52, rotulo: 'Semanas para "só negativas"' },
  semanasRegularidadeMunicipal: { min: 1, max: 52, rotulo: 'Semanas da regularidade do município' },
  semanasAtesto: { min: 1, max: 52, rotulo: 'Semanas que ainda se pode atestar' },
  semanasIncompletas: { min: 0, max: 8, rotulo: 'Semanas incompletas' },
  expiraPreviaHoras: { min: 1, max: 168, rotulo: 'Validade da prévia (horas)' },
  diasInusitado: { min: 30, max: 3650, rotulo: 'Dias sem caso para o evento inusitado' },
};

const CAMPOS_NEGATIVA = ['prazoDiaSemana', 'metaPercentual', 'semanasSilenciosa', 'semanasSoNegativa', 'semanasRegularidadeMunicipal', 'semanasAtesto'] as const;
const CAMPOS_CONSOLIDACAO = ['semanasIncompletas', 'expiraPreviaHoras'] as const;

/** Hora HH:MM de 00:00 a 23:59, com dois dígitos na hora (o formato que a API aceita). */
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Inteiro digitado; null quando vazio ou não inteiro. */
function inteiro(s: string): number | null {
  const t = s.trim();
  return /^\d{1,6}$/.test(t) ? Number(t) : null;
}

export function formParametros(c: ConfiguracoesDaVigilancia): FormParametros {
  const n = c.negativa;
  return {
    prazoDiaSemana: String(n.prazoDiaSemana),
    prazoHora: n.prazoHora,
    contaAtrasada: n.contaAtrasada,
    metaPercentual: String(n.metaPercentual),
    semanasSilenciosa: String(n.semanasSilenciosa),
    semanasSoNegativa: String(n.semanasSoNegativa),
    semanasRegularidadeMunicipal: String(n.semanasRegularidadeMunicipal),
    semanasAtesto: String(n.semanasAtesto),
    semanasIncompletas: String(c.consolidacao.semanasIncompletas),
    expiraPreviaHoras: String(c.consolidacao.expiraPreviaHoras),
    diasInusitado: String(c.surto.diasInusitado),
  };
}

/** O que impede gravar (as mesmas regras do zod da API). */
export function errosParametros(f: FormParametros): string[] {
  const erros: string[] = [];
  for (const [campo, l] of Object.entries(LIMITES_PARAMETROS) as [CampoNumerico, (typeof LIMITES_PARAMETROS)[CampoNumerico]][]) {
    const v = inteiro(f[campo]);
    if (v === null || v < l.min || v > l.max) erros.push(`${l.rotulo}: número inteiro de ${l.min.toLocaleString('pt-BR')} a ${l.max.toLocaleString('pt-BR')}.`);
  }
  if (!HORA.test(f.prazoHora.trim())) erros.push('Hora do prazo: HH:MM, de 00:00 a 23:59.');
  return erros;
}

/** Só o que mudou, campo a campo; null quando nada mudou (ou o formulário tem erro). */
export function corpoParametros(c: ConfiguracoesDaVigilancia, f: FormParametros): MudancaParametros | null {
  if (errosParametros(f).length) return null;
  const corpo: MudancaParametros = {};
  const negativa: Partial<ParametrosNegativa> = {};
  for (const campo of CAMPOS_NEGATIVA) {
    const v = inteiro(f[campo])!;
    if (v !== c.negativa[campo]) negativa[campo] = v;
  }
  const hora = f.prazoHora.trim();
  if (hora !== c.negativa.prazoHora) negativa.prazoHora = hora;
  if (f.contaAtrasada !== c.negativa.contaAtrasada) negativa.contaAtrasada = f.contaAtrasada;
  if (Object.keys(negativa).length) corpo.negativa = negativa;
  const consolidacao: Partial<ParametrosConsolidacao> = {};
  for (const campo of CAMPOS_CONSOLIDACAO) {
    const v = inteiro(f[campo])!;
    if (v !== c.consolidacao[campo]) consolidacao[campo] = v;
  }
  if (Object.keys(consolidacao).length) corpo.consolidacao = consolidacao;
  const dias = inteiro(f.diasInusitado)!;
  if (dias !== c.surto.diasInusitado) corpo.surto = { diasInusitado: dias };
  return Object.keys(corpo).length ? corpo : null;
}

/** O prazo do atesto em texto: "segunda-feira às 14:00 da semana seguinte à SE atestada". */
export function textoDoPrazo(f: Pick<FormParametros, 'prazoDiaSemana' | 'prazoHora'>): string | null {
  const dia = inteiro(f.prazoDiaSemana);
  if (dia === null || dia > 6 || !HORA.test(f.prazoHora.trim())) return null;
  return `${DIAS_DA_SEMANA[dia]!.toLowerCase()} às ${f.prazoHora.trim()} da semana seguinte à SE atestada (fuso da instituição)`;
}
