import type { AlertSeverity } from '@omnisaude/shared';
import { estimateDailyDoseMg } from './dose';
import { allergyFinding, parseAllergy } from './knowledge/allergies';
import { DRUGS_BY_KEY, findDrugsInText, KNOWLEDGE_BASE_VERSION, type DrugInfo } from './knowledge/drugs';
import { INTERACTIONS, matchesSelector, type InteractionContext } from './knowledge/interactions';
import { AGE_RULES, CONDITION_RULES, DUPLICATION_GROUPS, PREGNANCY_RULES } from './knowledge/patient-rules';
import { ckdEpi2021, isRenallyRelevant, renalFindings } from './knowledge/renal';

/**
 * Copiloto de prescrição: cruza os itens novos com medicamentos em uso, alergias, condições,
 * exames recentes e dados do paciente. É apoio à decisão; a base de conhecimento é semente de
 * desenvolvimento e precisa ser validada pela Comissão de Farmácia e Terapêutica antes do uso clínico.
 */

export interface MedicationItem {
  name: string;
  activeIngredients?: string[];
  dose?: string;
  route?: string;
  frequency?: string;
}

export interface LabResult {
  /** CREATININA (mg/dL ou µmol/L), POTASSIO (mEq/L), TFG (mL/min/1,73 m²), ... */
  code: string;
  value: number;
  unit?: string;
  collectedAt: Date | string;
}

export interface PrescriptionCheckInput {
  newItems: MedicationItem[];
  currentMedications?: MedicationItem[];
  allergies?: string[];
  /** CID-10 (com ou sem ponto). Códigos O00–O99 e Z33–Z36 marcam gestação. */
  conditions?: string[];
  labs?: LabResult[];
  patient: { ageYears: number; sex: 'M' | 'F'; weightKg?: number; pregnant?: boolean };
  /** Data de referência (padrão: agora). Exames com mais de 180 dias são desconsiderados. */
  now?: Date;
}

export type AlertCode =
  | 'INTERACAO'
  | 'ALERGIA'
  | 'ALERGIA_CRUZADA'
  | 'FUNCAO_RENAL'
  | 'POTASSIO'
  | 'GESTACAO'
  | 'IDADE'
  | 'CONDICAO_CLINICA'
  | 'DUPLICIDADE'
  | 'DOSE_MAXIMA'
  | 'EXAME_AUSENTE'
  | 'NAO_RECONHECIDO';

export interface ClinicalAlert {
  severity: AlertSeverity;
  code: AlertCode;
  /** Identificador estável da regra (trilha de auditoria). */
  ruleId: string;
  title: string;
  detail: string;
  recommendation: string;
  /** Itens envolvidos, como foram prescritos. */
  involves: string[];
}

export interface PrescriptionAnalysis {
  alerts: ClinicalAlert[];
  requiresJustification: boolean;
  /** TFG usada nas regras (informada ou estimada por CKD-EPI 2021). */
  egfr?: { value: number; source: 'informada' | 'CKD-EPI 2021'; collectedAt: string };
  potassium?: number;
  knowledgeBaseVersion: string;
}

const LAB_MAX_AGE_DAYS = 180;
const SEVERITY_RANK: Record<AlertSeverity, number> = { GRAVE: 0, MODERADO: 1, LEVE: 2 };

interface ResolvedItem {
  item: MedicationItem;
  drugs: DrugInfo[];
  isNew: boolean;
}

function resolve(item: MedicationItem, isNew: boolean): ResolvedItem {
  const sources = item.activeIngredients?.length ? item.activeIngredients : [item.name];
  const drugs: DrugInfo[] = [];
  for (const source of sources) {
    for (const d of DRUGS_BY_KEY.has(source) ? [DRUGS_BY_KEY.get(source)!] : findDrugsInText(source)) {
      if (!drugs.includes(d)) drugs.push(d);
    }
  }
  return { item, drugs, isNew };
}

function latestLab(labs: LabResult[], codes: string[], now: Date) {
  const minTime = now.getTime() - LAB_MAX_AGE_DAYS * 86_400_000;
  return labs
    .filter((l) => codes.includes(l.code.toUpperCase()))
    .map((l) => ({ ...l, at: new Date(l.collectedAt) }))
    .filter((l) => l.at.getTime() >= minTime && l.at.getTime() <= now.getTime() + 86_400_000)
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
}

function isPregnant(input: PrescriptionCheckInput): boolean {
  if (input.patient.pregnant) return true;
  return (input.conditions ?? []).some((c) => /^(O\d|Z3[3-6])/.test(c.toUpperCase().replace('.', '')));
}

export function analyzePrescription(input: PrescriptionCheckInput): PrescriptionAnalysis {
  const now = input.now ?? new Date();
  const labs = input.labs ?? [];
  const alerts: ClinicalAlert[] = [];
  const add = (a: ClinicalAlert) => alerts.push(a);

  const newItems = input.newItems.map((i) => resolve(i, true));
  const current = (input.currentMedications ?? []).map((i) => resolve(i, false));
  const all = [...newItems, ...current];

  // Exames de referência
  let egfr: PrescriptionAnalysis['egfr'];
  const tfg = latestLab(labs, ['TFG', 'EGFR'], now);
  const creat = latestLab(labs, ['CREATININA'], now);
  if (tfg && (!creat || tfg.at >= creat.at)) {
    egfr = { value: tfg.value, source: 'informada', collectedAt: tfg.at.toISOString() };
  } else if (creat && input.patient.ageYears >= 18) {
    const mgdl = creat.unit && /mol/i.test(creat.unit) ? creat.value / 88.4 : creat.value;
    egfr = { value: ckdEpi2021(mgdl, input.patient.ageYears, input.patient.sex), source: 'CKD-EPI 2021', collectedAt: creat.at.toISOString() };
  }
  const potassium = latestLab(labs, ['POTASSIO', 'K'], now)?.value;
  const ctx: InteractionContext = { ...(egfr ? { egfr: egfr.value } : {}), ...(potassium !== undefined ? { potassium } : {}) };

  for (const r of newItems) {
    if (r.drugs.length === 0) {
      add({
        severity: 'LEVE',
        code: 'NAO_RECONHECIDO',
        ruleId: 'SIS-NAO-RECONHECIDO',
        title: 'Medicamento não reconhecido pela base de conhecimento',
        detail: `"${r.item.name}" não foi identificado; interações e alergias não puderam ser verificadas automaticamente.`,
        recommendation: 'Conferir manualmente ou cadastrar o princípio ativo no catálogo institucional.',
        involves: [r.item.name],
      });
    }
  }

  // Interações: item novo x qualquer outro (novo ou em uso), cada par uma vez.
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const x = all[i]!;
      const y = all[j]!;
      if (!x.isNew && !y.isNew) continue;
      for (const dx of x.drugs) {
        for (const dy of y.drugs) {
          if (dx.key === dy.key) continue;
          for (const rule of INTERACTIONS) {
            const hit = (matchesSelector(dx, rule.a) && matchesSelector(dy, rule.b)) || (matchesSelector(dx, rule.b) && matchesSelector(dy, rule.a));
            if (!hit) continue;
            const escalated = rule.escalate?.(ctx);
            const severity = escalated && SEVERITY_RANK[escalated] < SEVERITY_RANK[rule.severity] ? escalated : rule.severity;
            add({
              severity,
              code: 'INTERACAO',
              ruleId: rule.id,
              title: `${rule.title}: ${dx.label} + ${dy.label}`,
              detail: rule.detail + (escalated && severity !== rule.severity ? ' Exames recentes (potássio/TFG) aumentam o risco.' : ''),
              recommendation: rule.recommendation,
              involves: [x.item.name, y.item.name],
            });
          }
        }
      }
    }
  }

  // Duplicidade terapêutica e item já em uso.
  for (const r of newItems) {
    for (const other of all) {
      if (other === r || (other.isNew && all.indexOf(other) < all.indexOf(r))) continue;
      const same = r.drugs.find((d) => other.drugs.some((o) => o.key === d.key));
      if (same) {
        add({
          severity: 'MODERADO',
          code: 'DUPLICIDADE',
          ruleId: 'DUP-MESMO-FARMACO',
          title: `${same.label} prescrito em duplicidade`,
          detail: other.isNew ? 'O mesmo princípio ativo aparece em mais de um item desta prescrição.' : 'O paciente já está em uso deste princípio ativo.',
          recommendation: 'Confirmar se é ajuste de dose (suspender o item anterior) ou duplicidade.',
          involves: [r.item.name, other.item.name],
        });
        continue;
      }
      for (const group of DUPLICATION_GROUPS) {
        const a = r.drugs.find((d) => d.classes.some((c) => group.classes.includes(c)));
        const b = other.drugs.find((d) => d.classes.some((c) => group.classes.includes(c)));
        if (a && b && a.key !== b.key) {
          add({
            severity: 'MODERADO',
            code: 'DUPLICIDADE',
            ruleId: `DUP-CLASSE-${group.classes[0]}`,
            title: `Duplicidade terapêutica: ${group.label}`,
            detail: `${a.label} e ${b.label} pertencem ao mesmo grupo terapêutico.`,
            recommendation: 'Evitar dois medicamentos do mesmo grupo, salvo intenção terapêutica documentada.',
            involves: [r.item.name, other.item.name],
          });
        }
      }
    }
  }

  // Alergias
  const allergies = (input.allergies ?? []).map(parseAllergy);
  for (const r of newItems) {
    for (const drug of r.drugs) {
      for (const allergy of allergies) {
        const f = allergyFinding(drug, allergy);
        if (!f) continue;
        add({
          severity: f.severity,
          code: f.ruleId === 'ALG-MESMO-FARMACO' || f.ruleId === 'ALG-CLASSE' ? 'ALERGIA' : 'ALERGIA_CRUZADA',
          ruleId: f.ruleId,
          title: f.title,
          detail: f.detail,
          recommendation: f.severity === 'GRAVE' ? 'Não administrar. Escolher alternativa de outra classe.' : 'Avaliar a história da reação; se prescrever, observar o paciente.',
          involves: [r.item.name],
        });
      }
    }
  }

  // Contexto do paciente
  const pregnant = isPregnant(input);
  const conditions = (input.conditions ?? []).map((c) => c.toUpperCase().replace('.', ''));
  for (const r of newItems) {
    for (const drug of r.drugs) {
      if (egfr) {
        for (const f of renalFindings(drug, egfr.value)) {
          add({
            severity: f.severity,
            code: 'FUNCAO_RENAL',
            ruleId: f.ruleId,
            title: f.title,
            detail: `TFG ${egfr.value} mL/min/1,73 m² (${egfr.source}, ${egfr.collectedAt.slice(0, 10)}).`,
            recommendation: f.recommendation,
            involves: [r.item.name],
          });
        }
      } else if (isRenallyRelevant(drug) && input.patient.ageYears >= 65) {
        add({
          severity: 'LEVE',
          code: 'EXAME_AUSENTE',
          ruleId: 'REN-SEM-CREATININA',
          title: 'Sem creatinina recente',
          detail: `${drug.label} depende da função renal e não há creatinina nos últimos ${LAB_MAX_AGE_DAYS} dias.`,
          recommendation: 'Solicitar creatinina sérica para estimar a TFG.',
          involves: [r.item.name],
        });
      }
      if (potassium !== undefined && potassium > 5.0 && drug.classes.some((c) => c === 'POUPADOR_POTASSIO' || c === 'SUPLEMENTO_POTASSIO')) {
        add({
          severity: 'GRAVE',
          code: 'POTASSIO',
          ruleId: 'K-ELEVADO-POUPADOR',
          title: `Potássio elevado (${potassium} mEq/L)`,
          detail: `${drug.label} eleva o potássio sérico.`,
          recommendation: 'Não iniciar/suspender até normalização do potássio.',
          involves: [r.item.name],
        });
      } else if (potassium !== undefined && potassium > 5.5 && drug.classes.some((c) => c === 'IECA' || c === 'BRA')) {
        add({
          severity: 'MODERADO',
          code: 'POTASSIO',
          ruleId: 'K-ELEVADO-SRAA',
          title: `Potássio elevado (${potassium} mEq/L)`,
          detail: `${drug.label} pode elevar ainda mais o potássio.`,
          recommendation: 'Reavaliar a dose e repetir potássio e creatinina.',
          involves: [r.item.name],
        });
      }
      if (pregnant) {
        for (const rule of PREGNANCY_RULES) {
          if (matchesSelector(drug, rule.drugs)) {
            add({ severity: rule.severity, code: 'GESTACAO', ruleId: rule.id, title: rule.title, detail: `Paciente gestante; prescrito ${drug.label}.`, recommendation: rule.recommendation, involves: [r.item.name] });
          }
        }
      } else if (drug.classes.includes('RETINOIDE') && input.patient.sex === 'F' && input.patient.ageYears >= 12 && input.patient.ageYears <= 50) {
        add({
          severity: 'LEVE',
          code: 'GESTACAO',
          ruleId: 'GES-RETINOIDE-IDADE-FERTIL',
          title: 'Retinoide em mulher em idade fértil',
          detail: 'Isotretinoína é altamente teratogênica.',
          recommendation: 'Exigir teste de gravidez negativo e contracepção eficaz (programa de prevenção da gravidez).',
          involves: [r.item.name],
        });
      }
      for (const rule of AGE_RULES) {
        const age = input.patient.ageYears;
        const inRange = (rule.minAge === undefined || age >= rule.minAge) && (rule.maxAge === undefined || age < rule.maxAge);
        if (inRange && matchesSelector(drug, rule.drugs)) {
          add({ severity: rule.severity, code: 'IDADE', ruleId: rule.id, title: rule.title, detail: `Paciente com ${age} anos.`, recommendation: rule.recommendation, involves: [r.item.name] });
        }
      }
      for (const rule of CONDITION_RULES) {
        if (rule.onlyWithoutEgfr && egfr) continue;
        if (!matchesSelector(drug, rule.drugs)) continue;
        const cid = conditions.find((c) => rule.cid.some((p) => c.startsWith(p)));
        if (cid) {
          add({
            severity: rule.severity,
            code: 'CONDICAO_CLINICA',
            ruleId: rule.id,
            title: rule.title,
            detail: `Condição registrada: ${rule.conditionLabel} (CID ${cid}).`,
            recommendation: rule.recommendation,
            involves: [r.item.name],
          });
        }
      }
    }

    // Dose diária máxima (só itens com um único princípio ativo reconhecido).
    const [single] = r.drugs;
    if (r.drugs.length === 1 && single?.maxDailyDoseMg) {
      const daily = estimateDailyDoseMg(r.item.dose, r.item.frequency);
      const elderly = input.patient.ageYears >= 65 && single.maxDailyDoseElderlyMg !== undefined;
      const max = elderly ? single.maxDailyDoseElderlyMg! : single.maxDailyDoseMg;
      if (daily !== undefined && daily > max) {
        add({
          severity: single.key === 'paracetamol' ? 'GRAVE' : 'MODERADO',
          code: 'DOSE_MAXIMA',
          ruleId: `DOSE-${single.key.toUpperCase()}`,
          title: `Dose diária acima da máxima: ${single.label}`,
          detail: `Posologia equivale a ${daily} mg/dia; máximo usual ${max} mg/dia${elderly ? ' para idosos' : ''}.`,
          recommendation: 'Revisar dose e intervalo.',
          involves: [r.item.name],
        });
      }
    }
  }

  return {
    alerts: dedupe(alerts),
    requiresJustification: alerts.some((a) => a.severity === 'GRAVE'),
    ...(egfr ? { egfr } : {}),
    ...(potassium !== undefined ? { potassium } : {}),
    knowledgeBaseVersion: KNOWLEDGE_BASE_VERSION,
  };
}

function dedupe(alerts: ClinicalAlert[]): ClinicalAlert[] {
  const seen = new Map<string, ClinicalAlert>();
  for (const a of alerts) {
    const key = `${a.ruleId}|${[...a.involves].sort().join('|')}`;
    const prev = seen.get(key);
    if (!prev || SEVERITY_RANK[a.severity] < SEVERITY_RANK[prev.severity]) seen.set(key, a);
  }
  return [...seen.values()].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.ruleId.localeCompare(b.ruleId));
}

/** Lista de alertas da prescrição, do mais grave para o mais leve. */
export function checkPrescription(input: PrescriptionCheckInput): ClinicalAlert[] {
  return analyzePrescription(input).alerts;
}

/** Alertas graves só podem ser ignorados com justificativa formal do prescritor. */
export function requiresJustification(alerts: readonly ClinicalAlert[]): boolean {
  return alerts.some((a) => a.severity === 'GRAVE');
}

