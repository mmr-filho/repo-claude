/**
 * Notificação negativa semanal (VIG-1c): "comunicação semanal realizada pelo responsável pelo estabelecimento de
 * saúde à autoridade de saúde" (PRC GM/MS nº 4/2017, Anexo V, art. 2º, IX). A unidade notificante atesta que não
 * identificou caso na semana; a grade unidade × semana mostra as silenciosas e a regularidade do município (PRC GM/MS
 * nº 6/2017, arts. 454-A a 454-E, na redação da PRT GM/MS nº 1.573/2023). Ver contingencia-surto-negativa.md, A27 a A40.
 */
import { fromZonedParts } from '../dates';
import { intervaloDaSemana } from './semana';

/** Situação de uma unidade numa semana epidemiológica. */
export type SituacaoUnidadeSemana = 'POSITIVA' | 'NEGATIVA' | 'NEGATIVA_ATRASADA' | 'SEM_INFORMACAO' | 'AGUARDANDO' | 'NAO_NOTIFICANTE' | 'EM_CURSO';

export const ROTULO_SITUACAO_UNIDADE_SEMANA: Record<SituacaoUnidadeSemana, string> = {
  POSITIVA: 'Positiva',
  NEGATIVA: 'Negativa',
  NEGATIVA_ATRASADA: 'Atrasada',
  SEM_INFORMACAO: 'Sem informação',
  AGUARDANDO: 'Aguardando',
  NAO_NOTIFICANTE: 'Não notificante',
  EM_CURSO: 'Em curso',
};

/** Situação do atesto. */
export type StatusAtesto = 'ATESTADA' | 'CANCELADA' | 'ANULADA';

export const ROTULO_STATUS_ATESTO: Record<StatusAtesto, string> = { ATESTADA: 'Atestada', CANCELADA: 'Cancelada', ANULADA: 'Anulada' };

/** Responsável pela negativa da unidade. */
export type TipoResponsavelNegativa = 'TITULAR' | 'SUBSTITUTO';

export const ROTULO_TIPO_RESPONSAVEL: Record<TipoResponsavelNegativa, string> = { TITULAR: 'Titular', SUBSTITUTO: 'Substituto' };

/** Prazo do atesto: dia da semana (0 = domingo … 6 = sábado) e hora (HH:MM, fuso da instituição) na semana seguinte à SE. */
export interface PrazoNegativa {
  prazoDiaSemana: number;
  prazoHora: string;
}

/** Parâmetros da análise da grade (as configurações da vigilância servem direto). */
export interface ParametrosGrade {
  /** Semanas fechadas seguidas sem informação para a unidade aparecer como silenciosa. */
  semanasSilenciosa: number;
  /** Semanas fechadas só com negativa para a unidade aparecer em "só negativas". */
  semanasSoNegativa: number;
  /** Semanas fechadas seguidas sem nenhuma informação no município (regularidade do Sinan: 8). */
  semanasRegularidadeMunicipal: number;
  /** O atesto fora do prazo conta como informação no percentual. */
  contaAtrasada: boolean;
}

/**
 * Instante do prazo do atesto da semana `semana` (AAAASS), no fuso da instituição: o dia `prazoDiaSemana` (0 = domingo)
 * da semana seguinte à SE, na hora `prazoHora`. Ex.: segunda-feira às 14h, como na NT SESPA nº 01/2025.
 */
export function prazoDaNegativa(semana: string, cfg: PrazoNegativa, timeZone: string): Date {
  if (!/^\d{6}$/.test(semana)) throw new Error(`Semana ${semana} inválida`);
  const hora = /^(\d{1,2}):(\d{2})$/.exec(cfg.prazoHora.trim());
  if (!hora || Number(hora[1]) > 23 || Number(hora[2]) > 59) throw new Error(`Hora do prazo inválida: ${cfg.prazoHora}`);
  if (!Number.isInteger(cfg.prazoDiaSemana) || cfg.prazoDiaSemana < 0 || cfg.prazoDiaSemana > 6) throw new Error(`Dia do prazo inválido: ${cfg.prazoDiaSemana}`);
  const { fim } = intervaloDaSemana(Number(semana.slice(0, 4)), Number(semana.slice(4)));
  const [a, m, d] = fim.split('-').map(Number);
  // O sábado que fecha a SE + 1 dia = o domingo da semana seguinte; somar o dia do prazo.
  const dia = new Date(Date.UTC(a!, m! - 1, d! + 1 + cfg.prazoDiaSemana, 12));
  return fromZonedParts({ year: dia.getUTCFullYear(), month: dia.getUTCMonth() + 1, day: dia.getUTCDate(), hour: Number(hora[1]), minute: Number(hora[2]), second: 0 }, timeZone);
}

/** Dados do texto do atesto. `inicio` e `fim` em AAAA-MM-DD. */
export interface DadosAtesto {
  unidade: string;
  cnes: string;
  /** AAAASS. */
  semana: string;
  inicio: string;
  fim: string;
  nome: string;
  funcao: string;
}

const dataBr = (iso: string, comAno: boolean) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}${comAno ? `/${iso.slice(0, 4)}` : ''}`;

/** Texto da declaração do responsável (citando a PRC nº 4/2017, Anexo V, art. 2º, IX). */
export function textoDoAtesto(d: DadosAtesto): string {
  const quem = d.funcao.trim() ? `${d.nome.trim()}, ${d.funcao.trim()},` : `${d.nome.trim()},`;
  // Na virada do ano (ex.: SE 53/2025, de 28/12/2025 a 03/01/2026) o início também leva o ano.
  const inicio = dataBr(d.inicio, d.inicio.slice(0, 4) !== d.fim.slice(0, 4));
  return (
    `Eu, ${quem} declaro, como responsável pela notificação da unidade ${d.unidade.trim()} (CNES ${d.cnes.trim()}), que na semana epidemiológica ` +
    `${d.semana.slice(4)}/${d.semana.slice(0, 4)} (${inicio} a ${dataBr(d.fim, true)}) não foi identificado nenhum caso de doença, agravo ou evento de saúde ` +
    'pública da Lista Nacional de Notificação Compulsória (PRC nº 4/2017, Anexo V, art. 2º, IX).'
  );
}

/** O que se sabe da unidade na semana. */
export interface FatosUnidadeSemana {
  notificante: boolean;
  /** Notificações (individuais ou de surto) e registros oficiais da unidade na SE da notificação. */
  positivas: number;
  negativa: { atrasada: boolean } | null;
  emCurso: boolean;
  prazoPassou: boolean;
}

/**
 * Situação da unidade na semana, nesta ordem: fora do período de notificante; semana em curso; com notificação
 * (positiva); com atesto (no prazo ou atrasado); antes do prazo (aguardando); sem informação.
 */
export function situacaoDaSemana(f: FatosUnidadeSemana): SituacaoUnidadeSemana {
  if (!f.notificante) return 'NAO_NOTIFICANTE';
  if (f.emCurso) return 'EM_CURSO';
  if (f.positivas > 0) return 'POSITIVA';
  if (f.negativa) return f.negativa.atrasada ? 'NEGATIVA_ATRASADA' : 'NEGATIVA';
  if (!f.prazoPassou) return 'AGUARDANDO';
  return 'SEM_INFORMACAO';
}

/** Linha da grade: situação de cada semana, da mais antiga à mais recente. */
export interface LinhaGradeUnidade {
  unitId: string;
  semanas: SituacaoUnidadeSemana[];
}

export interface AnaliseGrade {
  /** Unidades com `semanasSilenciosa` ou mais SEM_INFORMACAO seguidas até a última semana fechada. */
  silenciosas: { unitId: string; semanasSeguidas: number }[];
  /** Unidades só com NEGATIVA nas últimas `semanasSoNegativa` semanas fechadas. */
  soNegativas: { unitId: string; semanas: number }[];
  /** Por coluna da grade (`semana` = índice, 0 = a mais antiga): unidades com informação sobre as notificantes. */
  percentualPorSemana: { semana: number; comInformacao: number; notificantes: number; percentual: number | null }[];
  /** Semanas fechadas seguidas sem nenhuma informação no município e se isso já passa do limite. */
  regularidadeMunicipal: { semanasSemInformacao: number; irregular: boolean };
}

const COM_INFORMACAO: SituacaoUnidadeSemana[] = ['POSITIVA', 'NEGATIVA', 'NEGATIVA_ATRASADA'];
const NEGATIVAS: SituacaoUnidadeSemana[] = ['NEGATIVA', 'NEGATIVA_ATRASADA'];
/** Semana ainda aberta para a unidade: em curso ou antes do prazo do atesto. */
const aberta = (s: SituacaoUnidadeSemana) => s === 'EM_CURSO' || s === 'AGUARDANDO';

/**
 * Análise da grade unidade × semana (colunas da mais antiga à mais recente). Semanas "fechadas" são as que já
 * passaram do prazo: as abertas no fim da linha (em curso ou aguardando) ficam de fora das sequências. A
 * regularidade municipal só enxerga as semanas da grade: para as 8 SE da PRC nº 6/2017 (art. 454-E), a grade precisa
 * ter pelo menos 8 semanas fechadas.
 */
export function analisarGrade(grade: LinhaGradeUnidade[], cfg: ParametrosGrade): AnaliseGrade {
  const fechadas = (semanas: SituacaoUnidadeSemana[]) => {
    let fim = semanas.length;
    while (fim > 0 && aberta(semanas[fim - 1]!)) fim--;
    return semanas.slice(0, fim);
  };
  /** Quantas das últimas semanas fechadas seguidas satisfazem o teste. */
  const seguidas = (semanas: SituacaoUnidadeSemana[], teste: (s: SituacaoUnidadeSemana) => boolean) => {
    let n = 0;
    for (let i = semanas.length - 1; i >= 0 && teste(semanas[i]!); i--) n++;
    return n;
  };
  const silenciosas: AnaliseGrade['silenciosas'] = [];
  const soNegativas: AnaliseGrade['soNegativas'] = [];
  for (const linha of grade) {
    const f = fechadas(linha.semanas);
    const semInfo = seguidas(f, (s) => s === 'SEM_INFORMACAO');
    if (semInfo >= Math.max(1, cfg.semanasSilenciosa)) silenciosas.push({ unitId: linha.unitId, semanasSeguidas: semInfo });
    const negativas = seguidas(f, (s) => NEGATIVAS.includes(s));
    if (negativas >= Math.max(1, cfg.semanasSoNegativa)) soNegativas.push({ unitId: linha.unitId, semanas: negativas });
  }
  const colunas = Math.max(0, ...grade.map((l) => l.semanas.length));
  const informa = (s: SituacaoUnidadeSemana | undefined) => s !== undefined && (s === 'POSITIVA' || s === 'NEGATIVA' || (s === 'NEGATIVA_ATRASADA' && cfg.contaAtrasada));
  const percentualPorSemana = Array.from({ length: colunas }, (_, i) => {
    // A unidade em curso não entra; a que aguarda o prazo entra no denominador (ainda deve a informação).
    const daColuna = grade.map((l) => l.semanas[i]).filter((s): s is SituacaoUnidadeSemana => s !== undefined && s !== 'NAO_NOTIFICANTE' && s !== 'EM_CURSO');
    const comInformacao = daColuna.filter(informa).length;
    const notificantes = daColuna.length;
    return { semana: i, comInformacao, notificantes, percentual: notificantes ? (comInformacao * 100) / notificantes : null };
  });
  // Regularidade (PRC nº 6/2017, art. 454-E): semanas fechadas seguidas, da mais recente para trás, sem nenhuma
  // informação de nenhuma unidade (o atesto atrasado também é informação para o Sinan).
  let semanasSemInformacao = 0;
  for (let i = colunas - 1; i >= 0; i--) {
    const daColuna = grade.map((l) => l.semanas[i]).filter((s): s is SituacaoUnidadeSemana => s !== undefined);
    if (daColuna.some((s) => COM_INFORMACAO.includes(s))) break;
    if (daColuna.some(aberta)) continue;
    semanasSemInformacao++;
  }
  return {
    silenciosas,
    soNegativas,
    percentualPorSemana,
    regularidadeMunicipal: { semanasSemInformacao, irregular: semanasSemInformacao >= cfg.semanasRegularidadeMunicipal },
  };
}
