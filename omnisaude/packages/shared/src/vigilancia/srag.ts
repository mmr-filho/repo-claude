/**
 * Srag hospitalizada (item 59 da lista, alínea c): na internação, a vigilância precisa da notificação no Sivep-Gripe.
 * Definição da NT nº 11/2026-CGCOVID/DEDT/SVSA/MS: pessoa hospitalizada com síndrome gripal e dispneia, taquipneia
 * e/ou SpO2 ≤ 94%, ou óbito por Srag. O sistema abre o rascunho quando a internação tem CID respiratório e um desses
 * sinais registrado na triagem, e sugere à vigilância quando só um dos dois aparece. A NT não fixa a frequência da
 * taquipneia: os limites abaixo são os da OMS para crianças e 24 irpm para os demais (critério de triagem do sistema).
 */

/** CID-10 de quadro respiratório agudo que, na internação, sugere Srag. */
export const CID_RESPIRATORIO_AGUDO = ['J09', 'J10', 'J11', 'J12', 'J13', 'J14', 'J15', 'J16', 'J17', 'J18', 'J20', 'J21', 'J22', 'J80', 'U04', 'U07', 'B342', 'B972'];

export function cidRespiratorioAgudo(code: string | null | undefined): boolean {
  const c = (code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CID_RESPIRATORIO_AGUDO.some((p) => c.startsWith(p));
}

/** Taquipneia por idade (frequência respiratória mínima, irpm). */
export const TAQUIPNEIA: { ateMeses: number; irpm: number }[] = [
  { ateMeses: 2, irpm: 60 },
  { ateMeses: 12, irpm: 50 },
  { ateMeses: 60, irpm: 40 },
  { ateMeses: Infinity, irpm: 24 },
];

export function taquipneia(frequencia: number | null | undefined, idadeMeses: number): boolean {
  if (frequencia === null || frequencia === undefined) return false;
  const faixa = TAQUIPNEIA.find((t) => idadeMeses < t.ateMeses) ?? TAQUIPNEIA[TAQUIPNEIA.length - 1]!;
  return frequencia >= faixa.irpm;
}

export interface SinaisSrag {
  spo2: number | null;
  frequenciaRespiratoria: number | null;
  desconfortoRespiratorio: boolean;
}

/** Sinais registrados na triagem: SpO2 ≤ 94%, dispneia/desconforto respiratório ou taquipneia para a idade. */
export function sinaisDeSrag(s: SinaisSrag, idadeMeses: number): string[] {
  const sinais: string[] = [];
  if (s.spo2 !== null && s.spo2 <= 94) sinais.push(`SpO2 ${s.spo2}%`);
  if (s.desconfortoRespiratorio) sinais.push('desconforto respiratório');
  if (taquipneia(s.frequenciaRespiratoria, idadeMeses)) sinais.push(`taquipneia (FR ${s.frequenciaRespiratoria} irpm)`);
  return sinais;
}
