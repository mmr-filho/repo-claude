/** Função renal: TFG estimada e ajustes de medicamentos (BASE DE DESENVOLVIMENTO — validar com a CFT). */
import type { AlertSeverity } from '@omnisaude/shared';
import { matchesSelector, type Selector } from './interactions';
import type { DrugInfo } from './drugs';

/**
 * TFG estimada pela equação CKD-EPI 2021 (sem coeficiente de raça), em mL/min/1,73 m².
 * Válida para adultos (≥ 18 anos) com creatinina sérica em mg/dL.
 */
export function ckdEpi2021(creatinineMgDl: number, ageYears: number, sex: 'M' | 'F'): number {
  const kappa = sex === 'F' ? 0.7 : 0.9;
  const alpha = sex === 'F' ? -0.241 : -0.302;
  const ratio = creatinineMgDl / kappa;
  const egfr = 142 * Math.min(ratio, 1) ** alpha * Math.max(ratio, 1) ** -1.2 * 0.9938 ** ageYears * (sex === 'F' ? 1.012 : 1);
  return Math.round(egfr);
}

export interface RenalRule {
  id: string;
  drugs: Selector[];
  /** Faixas de TFG (limite superior exclusivo), da mais grave para a menos grave. */
  bands: { below: number; severity: AlertSeverity; recommendation: string }[];
  title: string;
}

export const RENAL_RULES: readonly RenalRule[] = [
  {
    id: 'REN-METFORMINA',
    drugs: [{ drug: 'metformina' }],
    title: 'Metformina e função renal',
    bands: [
      { below: 30, severity: 'GRAVE', recommendation: 'Contraindicada com TFG < 30: risco de acidose lática. Suspender.' },
      { below: 45, severity: 'MODERADO', recommendation: 'TFG 30–44: não iniciar; se em uso, limitar a 1.000 mg/dia e reavaliar.' },
    ],
  },
  {
    id: 'REN-AINE',
    drugs: [{ cls: 'AINE' }],
    title: 'Anti-inflamatório e função renal',
    bands: [
      { below: 30, severity: 'GRAVE', recommendation: 'Evitar AINE com TFG < 30: risco de lesão renal aguda e hipercalemia.' },
      { below: 60, severity: 'MODERADO', recommendation: 'Usar a menor dose pelo menor tempo e monitorar creatinina.' },
    ],
  },
  {
    id: 'REN-NEFROTOXICO',
    drugs: [{ cls: 'AMINOGLICOSIDEO' }, { cls: 'GLICOPEPTIDEO' }],
    title: 'Antimicrobiano nefrotóxico com função renal reduzida',
    bands: [{ below: 60, severity: 'MODERADO', recommendation: 'Ajustar dose/intervalo pela função renal e monitorar nível sérico e creatinina.' }],
  },
  {
    id: 'REN-POUPADOR-K',
    drugs: [{ cls: 'POUPADOR_POTASSIO' }],
    title: 'Diurético poupador de potássio e função renal',
    bands: [{ below: 30, severity: 'GRAVE', recommendation: 'Evitar com TFG < 30: alto risco de hipercalemia.' }],
  },
  {
    id: 'REN-DABIGATRANA',
    drugs: [{ drug: 'dabigatrana' }],
    title: 'Dabigatrana e função renal',
    bands: [{ below: 30, severity: 'GRAVE', recommendation: 'Contraindicada com depuração < 30 mL/min.' }],
  },
  {
    id: 'REN-XABANAS',
    drugs: [{ drug: 'rivaroxabana' }, { drug: 'apixabana' }],
    title: 'Anticoagulante oral direto e função renal',
    bands: [
      { below: 15, severity: 'GRAVE', recommendation: 'Não recomendado com depuração < 15 mL/min.' },
      { below: 50, severity: 'MODERADO', recommendation: 'Avaliar redução de dose conforme bula e indicação.' },
    ],
  },
  {
    id: 'REN-NITROFURANTOINA',
    drugs: [{ drug: 'nitrofurantoina' }],
    title: 'Nitrofurantoína e função renal',
    bands: [{ below: 30, severity: 'GRAVE', recommendation: 'Evitar com TFG < 30: ineficaz e com maior toxicidade.' }],
  },
  {
    id: 'REN-LITIO',
    drugs: [{ cls: 'LITIO' }],
    title: 'Lítio e função renal',
    bands: [{ below: 60, severity: 'MODERADO', recommendation: 'Reduzir dose e monitorar litemia e função renal com mais frequência.' }],
  },
  {
    id: 'REN-ENOXAPARINA',
    drugs: [{ drug: 'enoxaparina' }],
    title: 'Enoxaparina e função renal',
    bands: [{ below: 30, severity: 'MODERADO', recommendation: 'Ajustar dose (ex.: 1 mg/kg uma vez ao dia no tratamento) com TFG < 30.' }],
  },
  {
    id: 'REN-GLIBENCLAMIDA',
    drugs: [{ drug: 'glibenclamida' }],
    title: 'Glibenclamida e função renal',
    bands: [{ below: 60, severity: 'MODERADO', recommendation: 'Risco de hipoglicemia prolongada; preferir gliclazida.' }],
  },
];

export function renalFindings(drug: DrugInfo, egfr: number) {
  const out: { ruleId: string; title: string; severity: AlertSeverity; recommendation: string }[] = [];
  for (const rule of RENAL_RULES) {
    if (!matchesSelector(drug, rule.drugs)) continue;
    const band = rule.bands.find((b) => egfr < b.below);
    if (band) out.push({ ruleId: rule.id, title: rule.title, severity: band.severity, recommendation: band.recommendation });
  }
  return out;
}

/** Medicamentos cuja segurança depende da função renal (para avisar quando não há creatinina recente). */
export function isRenallyRelevant(drug: DrugInfo): boolean {
  return RENAL_RULES.some((r) => matchesSelector(drug, r.drugs));
}
