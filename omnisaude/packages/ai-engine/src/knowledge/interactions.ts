/**
 * Interações medicamento-medicamento (BASE DE DESENVOLVIMENTO — validar com a CFT).
 * Cada regra casa dois seletores (princípio ativo ou classe). A gravidade pode subir conforme
 * exames recentes (ex.: potássio alto torna a hipercalemia por IECA + espironolactona crítica).
 */
import type { AlertSeverity } from '@omnisaude/shared';
import type { DrugClass, DrugInfo } from './drugs';

export type Selector = { drug: string } | { cls: DrugClass };

export interface InteractionContext {
  potassium?: number; // mEq/L
  egfr?: number; // mL/min/1,73 m²
}

export interface InteractionRule {
  id: string;
  a: Selector[];
  b: Selector[];
  severity: AlertSeverity;
  title: string;
  detail: string;
  recommendation: string;
  escalate?: (ctx: InteractionContext) => AlertSeverity | undefined;
}

const drug = (...keys: string[]): Selector[] => keys.map((k) => ({ drug: k }));
const cls = (...classes: DrugClass[]): Selector[] => classes.map((c) => ({ cls: c }));

export function matchesSelector(info: DrugInfo, selectors: Selector[]): boolean {
  return selectors.some((s) => ('drug' in s ? s.drug === info.key : info.classes.includes(s.cls)));
}

const hyperkalemia = (ctx: InteractionContext): AlertSeverity | undefined =>
  (ctx.potassium !== undefined && ctx.potassium > 5.0) || (ctx.egfr !== undefined && ctx.egfr < 30) ? 'GRAVE' : undefined;

export const INTERACTIONS: readonly InteractionRule[] = [
  {
    id: 'INT-CUMARINICO-AINE',
    a: cls('CUMARINICO'),
    b: [...cls('AINE', 'SALICILATO')],
    severity: 'GRAVE',
    title: 'Risco aumentado de sangramento',
    detail: 'Anticoagulante cumarínico associado a AINE/salicilato aumenta o risco de hemorragia, inclusive digestiva.',
    recommendation: 'Evitar a associação; preferir paracetamol ou dipirona para analgesia. Se indispensável, monitorar INR e sinais de sangramento.',
  },
  {
    id: 'INT-ANTICOAG-AINE',
    a: cls('ANTICOAGULANTE_DIRETO', 'HEPARINA'),
    b: cls('AINE', 'SALICILATO'),
    severity: 'GRAVE',
    title: 'Risco aumentado de sangramento',
    detail: 'Anticoagulante associado a AINE/salicilato aumenta o risco de hemorragia.',
    recommendation: 'Evitar a associação, salvo indicação formal de antiagregação; monitorar sinais de sangramento.',
  },
  {
    id: 'INT-VARFARINA-POTENCIALIZADORES',
    a: drug('varfarina'),
    b: [...drug('amiodarona', 'metronidazol', 'sulfametoxazol_trimetoprima', 'fluconazol', 'ciprofloxacino', 'levofloxacino')],
    severity: 'GRAVE',
    title: 'Potencialização do efeito da varfarina',
    detail: 'O medicamento inibe o metabolismo da varfarina e pode elevar o INR de forma importante.',
    recommendation: 'Considerar alternativa terapêutica; se mantido, reduzir a dose da varfarina e controlar INR em 3 a 5 dias.',
  },
  {
    id: 'INT-ESTATINA-CYP3A4',
    a: drug('sinvastatina', 'lovastatina'),
    b: cls('INIBIDOR_CYP3A4_FORTE'),
    severity: 'GRAVE',
    title: 'Risco de miopatia e rabdomiólise',
    detail: 'Inibidores fortes do CYP3A4 elevam muito os níveis de sinvastatina/lovastatina.',
    recommendation: 'Contraindicado: suspender a estatina durante o tratamento ou trocar o antimicrobiano (ex.: azitromicina).',
  },
  {
    id: 'INT-ATORVASTATINA-CYP3A4',
    a: drug('atorvastatina'),
    b: cls('INIBIDOR_CYP3A4_FORTE'),
    severity: 'MODERADO',
    title: 'Aumento dos níveis de atorvastatina',
    detail: 'Inibidores fortes do CYP3A4 aumentam a exposição à atorvastatina.',
    recommendation: 'Limitar a dose de atorvastatina e orientar sobre dor muscular.',
  },
  {
    id: 'INT-SRAA-POTASSIO',
    a: cls('IECA', 'BRA'),
    b: cls('POUPADOR_POTASSIO', 'SUPLEMENTO_POTASSIO'),
    severity: 'MODERADO',
    title: 'Risco de hipercalemia',
    detail: 'IECA/BRA associados a diurético poupador de potássio ou suplemento de potássio elevam o potássio sérico.',
    recommendation: 'Dosar potássio e creatinina em 1 a 2 semanas; evitar em TFG < 30 ou K > 5,0 mEq/L.',
    escalate: hyperkalemia,
  },
  {
    id: 'INT-IECA-BRA',
    a: cls('IECA'),
    b: cls('BRA'),
    severity: 'MODERADO',
    title: 'Duplo bloqueio do sistema renina-angiotensina',
    detail: 'IECA + BRA aumenta hipercalemia, hipotensão e lesão renal aguda sem benefício cardiovascular adicional.',
    recommendation: 'Evitar a associação; usar um único bloqueador do SRAA.',
    escalate: hyperkalemia,
  },
  {
    id: 'INT-NITRATO-PDE5',
    a: cls('NITRATO'),
    b: cls('INIBIDOR_PDE5'),
    severity: 'GRAVE',
    title: 'Hipotensão grave',
    detail: 'Nitratos associados a inibidores da PDE-5 podem causar hipotensão grave e síncope.',
    recommendation: 'Contraindicado. Não associar.',
  },
  {
    id: 'INT-ISRS-TRAMADOL',
    a: cls('ISRS'),
    b: drug('tramadol'),
    severity: 'GRAVE',
    title: 'Síndrome serotoninérgica e convulsões',
    detail: 'ISRS + tramadol aumenta o risco de síndrome serotoninérgica e reduz o limiar convulsivo.',
    recommendation: 'Preferir outro analgésico; se mantido, usar a menor dose e orientar sinais de alerta.',
  },
  {
    id: 'INT-LITIO-DIURETICO-AINE',
    a: cls('LITIO'),
    b: cls('TIAZIDICO', 'AINE'),
    severity: 'GRAVE',
    title: 'Risco de intoxicação por lítio',
    detail: 'Tiazídicos e AINEs reduzem a eliminação renal do lítio.',
    recommendation: 'Evitar; se necessário, reduzir a dose de lítio e dosar litemia em 5 a 7 dias.',
  },
  {
    id: 'INT-LITIO-SRAA',
    a: cls('LITIO'),
    b: cls('IECA', 'BRA'),
    severity: 'MODERADO',
    title: 'Aumento da litemia',
    detail: 'IECA/BRA podem elevar os níveis séricos de lítio.',
    recommendation: 'Monitorar litemia e sinais de toxicidade.',
  },
  {
    id: 'INT-CLOPIDOGREL-IBP',
    a: drug('clopidogrel'),
    b: cls('INIBIDOR_CYP2C19'),
    severity: 'MODERADO',
    title: 'Redução do efeito do clopidogrel',
    detail: 'Omeprazol/esomeprazol inibem a ativação do clopidogrel (CYP2C19).',
    recommendation: 'Preferir pantoprazol quando houver indicação de IBP.',
  },
  {
    id: 'INT-DIGOXINA-AMIODARONA',
    a: drug('digoxina'),
    b: drug('amiodarona'),
    severity: 'GRAVE',
    title: 'Intoxicação digitálica',
    detail: 'A amiodarona eleva a digoxinemia (até cerca de 70%).',
    recommendation: 'Reduzir a dose de digoxina pela metade e monitorar digoxinemia, frequência cardíaca e ECG.',
  },
  {
    id: 'INT-AINE-SRAA',
    a: cls('AINE'),
    b: cls('IECA', 'BRA'),
    severity: 'MODERADO',
    title: 'Redução do efeito anti-hipertensivo e risco renal',
    detail: 'AINEs reduzem o efeito de IECA/BRA e, em associação, podem precipitar lesão renal aguda.',
    recommendation: 'Usar pelo menor tempo possível; monitorar PA e creatinina. Com diurético associado o risco é maior.',
  },
  {
    id: 'INT-AINE-CORTICOIDE',
    a: cls('AINE'),
    b: cls('CORTICOIDE'),
    severity: 'MODERADO',
    title: 'Risco de lesão e sangramento gastrointestinal',
    detail: 'Corticoide associado a AINE aumenta o risco de úlcera e hemorragia digestiva.',
    recommendation: 'Evitar a associação ou prescrever proteção gástrica (IBP).',
  },
  {
    id: 'INT-ISRS-SANGRAMENTO',
    a: cls('ISRS'),
    b: cls('AINE', 'SALICILATO', 'CUMARINICO', 'ANTICOAGULANTE_DIRETO'),
    severity: 'MODERADO',
    title: 'Risco aumentado de sangramento',
    detail: 'ISRS reduzem a agregação plaquetária; associados a AINE/anticoagulante aumentam o risco de sangramento.',
    recommendation: 'Avaliar proteção gástrica e orientar sinais de sangramento.',
  },
  {
    id: 'INT-QUINOLONA-XANTINA',
    a: drug('ciprofloxacino'),
    b: cls('XANTINA'),
    severity: 'GRAVE',
    title: 'Intoxicação por teofilina',
    detail: 'O ciprofloxacino reduz a depuração da teofilina/aminofilina (arritmias, convulsões).',
    recommendation: 'Evitar; se necessário, reduzir a dose da xantina e dosar nível sérico.',
  },
  {
    id: 'INT-BZD-OPIOIDE',
    a: cls('BENZODIAZEPINICO'),
    b: cls('OPIOIDE'),
    severity: 'GRAVE',
    title: 'Depressão respiratória',
    detail: 'Benzodiazepínico associado a opioide aumenta o risco de sedação profunda, depressão respiratória e óbito.',
    recommendation: 'Evitar a associação; se indispensável, menores doses, monitorização e orientação ao paciente/familiar.',
  },
  {
    id: 'INT-SMXTMP-POTASSIO',
    a: drug('sulfametoxazol_trimetoprima'),
    b: cls('IECA', 'BRA', 'POUPADOR_POTASSIO'),
    severity: 'MODERADO',
    title: 'Risco de hipercalemia',
    detail: 'A trimetoprima reduz a excreção renal de potássio.',
    recommendation: 'Monitorar potássio, principalmente em idosos e na doença renal.',
    escalate: hyperkalemia,
  },
  {
    id: 'INT-METOTREXATO-SMXTMP',
    a: drug('metotrexato'),
    b: [...drug('sulfametoxazol_trimetoprima'), ...cls('AINE')],
    severity: 'GRAVE',
    title: 'Toxicidade do metotrexato',
    detail: 'Reduz a eliminação do metotrexato (mielossupressão).',
    recommendation: 'Evitar a associação.',
  },
];
