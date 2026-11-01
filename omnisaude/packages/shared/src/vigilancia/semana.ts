import { localDateString } from '../dates';

/**
 * Semana epidemiológica (calendário do Sinan): de domingo a sábado; a semana 1 é a que tem mais dias de janeiro,
 * ou seja, a que contém o dia 4 de janeiro. O ano epidemiológico tem 52 ou 53 semanas. A data é lida no fuso
 * da instituição. Fonte: perguntas frequentes e calendários anuais do portal Sinan.
 */
export interface SemanaEpidemiologica {
  ano: number;
  semana: number;
  /** "AAAASS", como em SEM_NOT e SEM_PRI do Sinan. */
  codigo: string;
}

const DIA = 86_400_000;

/** Data civil "AAAA-MM-DD" como instante ao meio-dia UTC (aritmética de dias sem efeito de fuso). */
function civil(iso: string): number {
  const [a, m, d] = iso.split('-').map(Number);
  return Date.UTC(a!, m! - 1, d!, 12);
}

/** Domingo que inicia a semana 1 do ano epidemiológico. */
export function inicioAnoEpidemiologico(ano: number): number {
  const quatroJan = Date.UTC(ano, 0, 4, 12);
  const diaSemana = new Date(quatroJan).getUTCDay(); // 0 = domingo
  return quatroJan - diaSemana * DIA;
}

export function semanasNoAno(ano: number): number {
  return Math.round((inicioAnoEpidemiologico(ano + 1) - inicioAnoEpidemiologico(ano)) / (7 * DIA));
}

/** Semana epidemiológica de uma data civil "AAAA-MM-DD". */
export function semanaDaData(iso: string): SemanaEpidemiologica {
  const t = civil(iso);
  let ano = Number(iso.slice(0, 4));
  if (t < inicioAnoEpidemiologico(ano)) ano -= 1;
  else if (t >= inicioAnoEpidemiologico(ano + 1)) ano += 1;
  const semana = Math.floor((t - inicioAnoEpidemiologico(ano)) / (7 * DIA)) + 1;
  return { ano, semana, codigo: `${ano}${String(semana).padStart(2, '0')}` };
}

/** Semana epidemiológica de um instante, lido no fuso da instituição. */
export function semanaEpidemiologica(data: Date, timeZone: string): SemanaEpidemiologica {
  return semanaDaData(localDateString(data, timeZone));
}

/** Primeiro (domingo) e último (sábado) dia de uma semana epidemiológica, em "AAAA-MM-DD". */
export function intervaloDaSemana(ano: number, semana: number): { inicio: string; fim: string } {
  if (semana < 1 || semana > semanasNoAno(ano)) throw new Error(`Semana ${semana} inexistente em ${ano}`);
  const ini = inicioAnoEpidemiologico(ano) + (semana - 1) * 7 * DIA;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { inicio: iso(ini), fim: iso(ini + 6 * DIA) };
}
