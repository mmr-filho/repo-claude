/**
 * Acolhimento com Classificação de Risco (ACCR / HumanizaSUS), em cinco cores.
 * Os tempos-alvo seguem a escala de cinco níveis usada na maioria das redes e podem ser
 * sobrescritos por tenant. A sugestão automática é apoio à decisão: quem classifica é a enfermagem.
 */

export const RISK_COLORS = ['VERMELHO', 'LARANJA', 'AMARELO', 'VERDE', 'AZUL'] as const;
export type RiskColor = (typeof RISK_COLORS)[number];

export const RISK_INFO: Record<RiskColor, { label: string; maxWaitMinutes: number; hex: string }> = {
  VERMELHO: { label: 'Emergência', maxWaitMinutes: 0, hex: '#dc2626' },
  LARANJA: { label: 'Muito urgente', maxWaitMinutes: 10, hex: '#ea580c' },
  AMARELO: { label: 'Urgente', maxWaitMinutes: 60, hex: '#eab308' },
  VERDE: { label: 'Pouco urgente', maxWaitMinutes: 120, hex: '#16a34a' },
  AZUL: { label: 'Não urgente', maxWaitMinutes: 240, hex: '#2563eb' },
};

/** Ordem da fila: cor mais grave primeiro; dentro da mesma cor, quem chegou antes. */
export function compareRisk(
  a: { color: RiskColor; classifiedAt: Date },
  b: { color: RiskColor; classifiedAt: Date },
): number {
  const byColor = RISK_COLORS.indexOf(a.color) - RISK_COLORS.indexOf(b.color);
  return byColor !== 0 ? byColor : a.classifiedAt.getTime() - b.classifiedAt.getTime();
}

export interface VitalSigns {
  systolic?: number; // mmHg
  diastolic?: number; // mmHg
  heartRate?: number; // bpm
  respiratoryRate?: number; // irpm
  temperature?: number; // °C
  spo2?: number; // %
  glucose?: number; // mg/dL (glicemia capilar)
  painScore?: number; // 0-10 (escala visual analógica)
}

/** Discriminadores clínicos marcados pela enfermagem na avaliação. */
export const RISK_FLAGS = {
  parada_cardiorrespiratoria: 'VERMELHO',
  via_aerea_comprometida: 'VERMELHO',
  choque: 'VERMELHO',
  convulsao_ativa: 'VERMELHO',
  dor_toracica: 'LARANJA',
  deficit_neurologico_agudo: 'LARANJA',
  alteracao_aguda_consciencia: 'LARANJA',
  hemorragia_nao_controlada: 'LARANJA',
  gestante_sangramento: 'LARANJA',
  vomitos_persistentes: 'AMARELO',
  historia_trauma_moderado: 'AMARELO',
  vulnerabilidade_social: 'AMARELO',
} as const satisfies Record<string, RiskColor>;
export type RiskFlag = keyof typeof RISK_FLAGS;

export interface RiskSuggestion {
  color: RiskColor;
  reasons: string[];
}

export function suggestRiskColor(vitals: VitalSigns, flags: readonly RiskFlag[] = []): RiskSuggestion {
  const found: { color: RiskColor; reason: string }[] = [];
  const add = (color: RiskColor, reason: string) => found.push({ color, reason });
  const { systolic, diastolic, heartRate, respiratoryRate, temperature, spo2, glucose, painScore } = vitals;

  for (const flag of flags) add(RISK_FLAGS[flag], `Discriminador: ${flag.replaceAll('_', ' ')}`);

  if (spo2 !== undefined) {
    if (spo2 < 85) add('VERMELHO', `SpO2 ${spo2}%`);
    else if (spo2 < 90) add('LARANJA', `SpO2 ${spo2}%`);
    else if (spo2 < 95) add('AMARELO', `SpO2 ${spo2}%`);
  }
  if (heartRate !== undefined) {
    if (heartRate < 40 || heartRate > 150) add('VERMELHO', `FC ${heartRate} bpm`);
    else if (heartRate < 50 || heartRate > 130) add('LARANJA', `FC ${heartRate} bpm`);
    else if (heartRate > 110) add('AMARELO', `FC ${heartRate} bpm`);
  }
  if (respiratoryRate !== undefined) {
    if (respiratoryRate < 8 || respiratoryRate > 35) add('VERMELHO', `FR ${respiratoryRate} irpm`);
    else if (respiratoryRate > 29) add('LARANJA', `FR ${respiratoryRate} irpm`);
    else if (respiratoryRate > 24) add('AMARELO', `FR ${respiratoryRate} irpm`);
  }
  if (systolic !== undefined) {
    if (systolic < 80) add('VERMELHO', `PAS ${systolic} mmHg`);
    else if (systolic >= 200 || systolic < 90) add('LARANJA', `PAS ${systolic} mmHg`);
    else if (systolic >= 180) add('AMARELO', `PAS ${systolic} mmHg`);
  }
  if (diastolic !== undefined && diastolic >= 120) add('LARANJA', `PAD ${diastolic} mmHg`);
  else if (diastolic !== undefined && diastolic >= 110) add('AMARELO', `PAD ${diastolic} mmHg`);
  if (temperature !== undefined) {
    if (temperature >= 41 || temperature < 35) add('LARANJA', `Temperatura ${temperature} °C`);
    else if (temperature >= 39) add('AMARELO', `Temperatura ${temperature} °C`);
    else if (temperature >= 37.8) add('VERDE', `Temperatura ${temperature} °C`);
  }
  if (glucose !== undefined) {
    if (glucose < 40) add('VERMELHO', `Glicemia ${glucose} mg/dL`);
    else if (glucose < 70 || glucose > 400) add('LARANJA', `Glicemia ${glucose} mg/dL`);
    else if (glucose > 300) add('AMARELO', `Glicemia ${glucose} mg/dL`);
  }
  if (painScore !== undefined) {
    if (painScore >= 8) add('LARANJA', `Dor intensa (${painScore}/10)`);
    else if (painScore >= 5) add('AMARELO', `Dor moderada (${painScore}/10)`);
    else if (painScore >= 1) add('VERDE', `Dor leve (${painScore}/10)`);
  }

  if (found.length === 0) return { color: 'AZUL', reasons: ['Sem alterações nos parâmetros avaliados'] };
  const worst = RISK_COLORS.find((c) => found.some((f) => f.color === c))!;
  return { color: worst, reasons: found.filter((f) => f.color === worst).map((f) => f.reason) };
}
