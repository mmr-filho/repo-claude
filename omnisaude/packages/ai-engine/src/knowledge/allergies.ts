/** Alergias e reatividade cruzada (BASE DE DESENVOLVIMENTO — validar com a CFT). */
import type { AlertSeverity } from '@omnisaude/shared';
import { normalizeKey } from '../text';
import { findDrugsInText, type DrugClass, type DrugInfo } from './drugs';

/** Termos que designam uma classe inteira ("alergia a penicilina", "sulfa", "AINEs"). */
const CLASS_TERMS: { terms: string[]; classes: DrugClass[]; label: string }[] = [
  { terms: ['penicilina', 'penicilinas'], classes: ['PENICILINA'], label: 'penicilinas' },
  { terms: ['betalactamico', 'betalactamicos', 'beta lactamico', 'beta lactamicos'], classes: ['PENICILINA', 'CEFALOSPORINA', 'CARBAPENEM'], label: 'betalactâmicos' },
  { terms: ['cefalosporina', 'cefalosporinas'], classes: ['CEFALOSPORINA'], label: 'cefalosporinas' },
  { terms: ['sulfa', 'sulfas', 'sulfonamida', 'sulfonamidas'], classes: ['SULFONAMIDA_ANTIBIOTICA'], label: 'sulfonamidas' },
  { terms: ['pirazolona', 'pirazolonas'], classes: ['PIRAZOLONA'], label: 'pirazolonas' },
  { terms: ['aine', 'aines', 'anti inflamatorio', 'anti inflamatorios', 'antiinflamatorio', 'antiinflamatorios'], classes: ['AINE', 'SALICILATO'], label: 'anti-inflamatórios (AINEs)' },
  { terms: ['quinolona', 'quinolonas', 'fluoroquinolona', 'fluoroquinolonas'], classes: ['FLUOROQUINOLONA'], label: 'quinolonas' },
  { terms: ['macrolideo', 'macrolideos'], classes: ['MACROLIDEO'], label: 'macrolídeos' },
  { terms: ['opioide', 'opioides', 'opiaceo', 'opiaceos'], classes: ['OPIOIDE'], label: 'opioides' },
];

/** Classes em que alergia a um item contraindica os demais da mesma classe. */
const SAME_CLASS_SEVERITY: Partial<Record<DrugClass, AlertSeverity>> = {
  PENICILINA: 'GRAVE',
  CEFALOSPORINA: 'GRAVE',
  CARBAPENEM: 'GRAVE',
  PIRAZOLONA: 'GRAVE',
  SULFONAMIDA_ANTIBIOTICA: 'GRAVE',
  FLUOROQUINOLONA: 'GRAVE',
  MACROLIDEO: 'GRAVE',
  OPIOIDE: 'MODERADO',
  // Entre AINEs a reação cruzada depende do mecanismo (inibição da COX-1): alerta, sem bloquear.
  AINE: 'MODERADO',
};

/** Reatividade cruzada entre classes diferentes: [classe da alergia, classe prescrita, gravidade, explicação]. */
const CROSS_CLASS: [DrugClass, DrugClass, AlertSeverity, string][] = [
  ['PENICILINA', 'CEFALOSPORINA', 'MODERADO', 'Reatividade cruzada penicilinas–cefalosporinas é baixa (≈1–2%), maior com cefalosporinas de 1ª geração.'],
  ['CEFALOSPORINA', 'PENICILINA', 'MODERADO', 'Reatividade cruzada cefalosporinas–penicilinas é baixa, mas possível.'],
  ['PENICILINA', 'CARBAPENEM', 'LEVE', 'Reatividade cruzada penicilinas–carbapenêmicos é rara (< 1%).'],
  ['CEFALOSPORINA', 'CARBAPENEM', 'LEVE', 'Reatividade cruzada cefalosporinas–carbapenêmicos é rara.'],
  ['SULFONAMIDA_ANTIBIOTICA', 'SULFONAMIDA_NAO_ANTIBIOTICA', 'LEVE', 'Sulfonamidas não antibióticas (diuréticos) raramente reagem de forma cruzada.'],
  ['AINE', 'SALICILATO', 'MODERADO', 'Pacientes com reação a AINE podem reagir ao AAS (doença respiratória exacerbada por AINE/urticária).'],
  ['SALICILATO', 'AINE', 'MODERADO', 'Pacientes com reação ao AAS podem reagir a outros AINEs.'],
  ['PIRAZOLONA', 'AINE', 'LEVE', 'Intolerância à dipirona pode coexistir com intolerância a AINEs.'],
];

export interface ParsedAllergy {
  text: string;
  drugs: DrugInfo[];
  classes: DrugClass[];
  classLabel?: string;
}

export function parseAllergy(text: string): ParsedAllergy {
  const key = ` ${normalizeKey(text).replace(/[^a-z0-9]+/g, ' ')} `;
  const drugs = findDrugsInText(text);
  const classes: DrugClass[] = [];
  let classLabel: string | undefined;
  for (const entry of CLASS_TERMS) {
    if (entry.terms.some((t) => key.includes(` ${t} `))) {
      classes.push(...entry.classes);
      classLabel ??= entry.label;
    }
  }
  return { text, drugs, classes, ...(classLabel ? { classLabel } : {}) };
}

export interface AllergyFinding {
  severity: AlertSeverity;
  ruleId: string;
  title: string;
  detail: string;
}

/** Compara um medicamento prescrito com uma alergia registrada. */
export function allergyFinding(drug: DrugInfo, allergy: ParsedAllergy): AllergyFinding | undefined {
  if (allergy.drugs.some((d) => d.key === drug.key)) {
    return {
      severity: 'GRAVE',
      ruleId: 'ALG-MESMO-FARMACO',
      title: `Alergia registrada a ${drug.label}`,
      detail: `O paciente tem alergia registrada: "${allergy.text}".`,
    };
  }
  const declared = allergy.classes.filter((c) => drug.classes.includes(c));
  if (declared.length > 0) {
    return {
      severity: 'GRAVE',
      ruleId: 'ALG-CLASSE',
      title: `Alergia registrada a ${allergy.classLabel ?? 'esta classe'}`,
      detail: `${drug.label} pertence à classe para a qual há alergia registrada ("${allergy.text}").`,
    };
  }
  for (const allergen of allergy.drugs) {
    for (const c of allergen.classes) {
      const severity = SAME_CLASS_SEVERITY[c];
      if (severity && drug.classes.includes(c)) {
        return {
          severity,
          ruleId: 'ALG-MESMA-CLASSE',
          title: `Possível reação cruzada com ${allergen.label}`,
          detail: `${drug.label} é da mesma classe de ${allergen.label}, ao qual o paciente é alérgico.`,
        };
      }
    }
  }
  const allergyClasses = new Set<DrugClass>([...allergy.classes, ...allergy.drugs.flatMap((d) => d.classes)]);
  for (const [from, to, severity, explanation] of CROSS_CLASS) {
    if (allergyClasses.has(from) && drug.classes.includes(to)) {
      return {
        severity,
        ruleId: `ALG-CRUZADA-${from}-${to}`,
        title: `Reatividade cruzada possível (alergia: ${allergy.text})`,
        detail: explanation,
      };
    }
  }
  return undefined;
}
