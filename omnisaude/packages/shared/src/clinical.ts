/** Vocabulário clínico compartilhado entre API, motor de IA e front-end. */

export const ALERT_SEVERITIES = ['LEVE', 'MODERADO', 'GRAVE'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_SEVERITY_LABELS: Record<AlertSeverity, string> = {
  LEVE: 'Informativo / Leve',
  MODERADO: 'Atenção / Moderado',
  GRAVE: 'Crítico / Grave',
};

export interface SoapNote {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export const SOAP_LABELS: Record<keyof SoapNote, string> = {
  subjective: 'Subjetivo',
  objective: 'Objetivo',
  assessment: 'Avaliação',
  plan: 'Plano',
};

export const ROUTES_OF_ADMINISTRATION = ['ORAL', 'SUBLINGUAL', 'IV', 'IM', 'SC', 'TOPICA', 'INALATORIA', 'RETAL', 'OFTALMICA', 'NASAL'] as const;
export type RouteOfAdministration = (typeof ROUTES_OF_ADMINISTRATION)[number];

export const UNIT_TYPES = [
  'UBS',
  'UPA',
  'POLICLINICA',
  'HOSPITAL',
  'CEO',
  'SAMU',
  'CAPS',
  'FARMACIA_CENTRAL',
  'ALMOXARIFADO',
  'LABORATORIO',
] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const SEXES = ['M', 'F'] as const;
export type Sex = (typeof SEXES)[number];

/** Raça/cor no padrão do SUS (BPA/e-SUS): 01 branca, 02 preta, 03 parda, 04 amarela, 05 indígena, 99 sem informação. */
export const RACA_COR = { '01': 'Branca', '02': 'Preta', '03': 'Parda', '04': 'Amarela', '05': 'Indígena', '99': 'Sem informação' } as const;
export type RacaCor = keyof typeof RACA_COR;
