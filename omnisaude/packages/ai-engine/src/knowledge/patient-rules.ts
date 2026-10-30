/** Regras dependentes do paciente: gestação, idade e condições (CID-10). BASE DE DESENVOLVIMENTO — validar com a CFT. */
import type { AlertSeverity } from '@omnisaude/shared';
import type { DrugClass } from './drugs';
import type { Selector } from './interactions';

export interface ContextRule {
  id: string;
  drugs: Selector[];
  severity: AlertSeverity;
  title: string;
  recommendation: string;
}

export const PREGNANCY_RULES: readonly ContextRule[] = [
  { id: 'GES-SRAA', drugs: [{ cls: 'IECA' }, { cls: 'BRA' }], severity: 'GRAVE', title: 'IECA/BRA contraindicados na gestação', recommendation: 'Fetotoxicidade (oligoidrâmnio, insuficiência renal fetal). Preferir metildopa, nifedipino ou hidralazina.' },
  { id: 'GES-VARFARINA', drugs: [{ cls: 'CUMARINICO' }], severity: 'GRAVE', title: 'Varfarina contraindicada na gestação', recommendation: 'Embriopatia cumarínica. Usar heparina de baixo peso molecular.' },
  { id: 'GES-ESTATINA', drugs: [{ cls: 'ESTATINA' }], severity: 'GRAVE', title: 'Estatina contraindicada na gestação', recommendation: 'Suspender durante a gestação e a amamentação.' },
  { id: 'GES-TERATOGENICOS', drugs: [{ cls: 'RETINOIDE' }, { cls: 'ANTIMETABOLITO' }, { cls: 'PROSTAGLANDINA' }, { drug: 'acido_valproico' }], severity: 'GRAVE', title: 'Medicamento teratogênico na gestação', recommendation: 'Contraindicado na gestação.' },
  { id: 'GES-AINE', drugs: [{ cls: 'AINE' }], severity: 'MODERADO', title: 'AINE na gestação', recommendation: 'Evitar, sobretudo a partir de 20 semanas (oligoidrâmnio, fechamento do ducto arterial). Preferir paracetamol.' },
  { id: 'GES-OUTROS', drugs: [{ cls: 'TETRACICLINA' }, { cls: 'FLUOROQUINOLONA' }, { cls: 'LITIO' }, { drug: 'carbamazepina' }], severity: 'MODERADO', title: 'Uso na gestação requer avaliação de risco', recommendation: 'Avaliar risco-benefício e alternativas mais seguras.' },
];

export interface AgeRule extends ContextRule {
  minAge?: number;
  maxAge?: number; // exclusivo
}

export const AGE_RULES: readonly AgeRule[] = [
  { id: 'IDA-AAS-REYE', drugs: [{ cls: 'SALICILATO' }], maxAge: 16, severity: 'GRAVE', title: 'AAS em menor de 16 anos', recommendation: 'Risco de síndrome de Reye. Usar apenas em indicações específicas (ex.: doença de Kawasaki).' },
  { id: 'IDA-CODEINA-TRAMADOL', drugs: [{ drug: 'codeina' }, { drug: 'tramadol' }], maxAge: 12, severity: 'GRAVE', title: 'Codeína/tramadol em menor de 12 anos', recommendation: 'Contraindicado: risco de depressão respiratória (metabolizadores ultrarrápidos).' },
  { id: 'IDA-QUINOLONA', drugs: [{ cls: 'FLUOROQUINOLONA' }], maxAge: 18, severity: 'MODERADO', title: 'Fluoroquinolona em menor de 18 anos', recommendation: 'Reservar para infecções sem alternativa (risco musculoesquelético).' },
  { id: 'IDA-TETRACICLINA', drugs: [{ cls: 'TETRACICLINA' }], maxAge: 8, severity: 'MODERADO', title: 'Tetraciclina em menor de 8 anos', recommendation: 'Risco de alteração do esmalte dentário; preferir alternativa.' },
  { id: 'IDA-BZD-IDOSO', drugs: [{ cls: 'BENZODIAZEPINICO' }], minAge: 65, severity: 'MODERADO', title: 'Benzodiazepínico em idoso', recommendation: 'Critérios de Beers: risco de quedas, fraturas e delirium. Usar a menor dose pelo menor tempo.' },
  { id: 'IDA-GLIBENCLAMIDA-IDOSO', drugs: [{ drug: 'glibenclamida' }], minAge: 65, severity: 'MODERADO', title: 'Glibenclamida em idoso', recommendation: 'Hipoglicemia prolongada; preferir gliclazida.' },
];

export interface ConditionRule extends ContextRule {
  /** Prefixos de CID-10 sem ponto (ex.: "J45", "K922"). */
  cid: string[];
  conditionLabel: string;
  /** Só aplica quando a TFG é desconhecida (senão as regras renais cobrem). */
  onlyWithoutEgfr?: boolean;
}

const cls = (...c: DrugClass[]): Selector[] => c.map((x) => ({ cls: x }));

export const CONDITION_RULES: readonly ConditionRule[] = [
  { id: 'CON-ASMA-BB', cid: ['J45', 'J46'], conditionLabel: 'asma', drugs: cls('BETABLOQUEADOR_NAO_SELETIVO'), severity: 'GRAVE', title: 'Betabloqueador não seletivo na asma', recommendation: 'Risco de broncoespasmo grave. Preferir betabloqueador cardiosseletivo se indispensável.' },
  { id: 'CON-ASMA-AINE', cid: ['J45', 'J46'], conditionLabel: 'asma', drugs: cls('AINE', 'SALICILATO'), severity: 'MODERADO', title: 'AINE/AAS na asma', recommendation: 'Pode desencadear broncoespasmo em asma sensível a AINE. Confirmar uso prévio sem reação.' },
  { id: 'CON-ULCERA-AINE', cid: ['K25', 'K26', 'K27', 'K28', 'K920', 'K921', 'K922'], conditionLabel: 'úlcera péptica/hemorragia digestiva', drugs: cls('AINE', 'SALICILATO'), severity: 'GRAVE', title: 'AINE com úlcera ou sangramento digestivo', recommendation: 'Evitar; se indispensável, associar IBP e usar pelo menor tempo.' },
  { id: 'CON-ULCERA-ANTICOAG', cid: ['K25', 'K26', 'K27', 'K28', 'K920', 'K921', 'K922'], conditionLabel: 'úlcera péptica/hemorragia digestiva', drugs: cls('CUMARINICO', 'ANTICOAGULANTE_DIRETO', 'CORTICOIDE'), severity: 'MODERADO', title: 'Risco de sangramento digestivo', recommendation: 'Avaliar proteção gástrica e monitorar sinais de sangramento.' },
  { id: 'CON-IC-AINE', cid: ['I50'], conditionLabel: 'insuficiência cardíaca', drugs: cls('AINE'), severity: 'MODERADO', title: 'AINE na insuficiência cardíaca', recommendation: 'Retenção de sódio e água pode descompensar a IC. Evitar.' },
  { id: 'CON-DRC-AINE', cid: ['N18'], conditionLabel: 'doença renal crônica', drugs: [...cls('AINE'), { drug: 'metformina' }], severity: 'MODERADO', title: 'Doença renal crônica registrada', recommendation: 'Solicitar creatinina para estimar a TFG antes de manter o medicamento.', onlyWithoutEgfr: true },
  { id: 'CON-EPILEPSIA-TRAMADOL', cid: ['G40', 'G41'], conditionLabel: 'epilepsia', drugs: [{ drug: 'tramadol' }], severity: 'MODERADO', title: 'Tramadol na epilepsia', recommendation: 'Reduz o limiar convulsivo; preferir outro analgésico.' },
  { id: 'CON-HIPERCALEMIA', cid: ['E875'], conditionLabel: 'hipercalemia', drugs: cls('POUPADOR_POTASSIO', 'SUPLEMENTO_POTASSIO'), severity: 'GRAVE', title: 'Potássio/poupador de potássio com hipercalemia', recommendation: 'Contraindicado na hipercalemia.' },
  { id: 'CON-HAS-AINE', cid: ['I10', 'I11', 'I12', 'I13', 'I15'], conditionLabel: 'hipertensão', drugs: cls('AINE'), severity: 'LEVE', title: 'AINE na hipertensão', recommendation: 'Pode elevar a pressão arterial; monitorar.' },
  { id: 'CON-HEPATOPATIA-PARACETAMOL', cid: ['K70', 'K71', 'K72', 'K73', 'K74', 'K75', 'K76', 'K77'], conditionLabel: 'hepatopatia', drugs: [{ drug: 'paracetamol' }], severity: 'MODERADO', title: 'Paracetamol na hepatopatia', recommendation: 'Limitar a 2 g/dia.' },
  { id: 'CON-MIASTENIA', cid: ['G700'], conditionLabel: 'miastenia gravis', drugs: cls('AMINOGLICOSIDEO', 'FLUOROQUINOLONA', 'MACROLIDEO'), severity: 'GRAVE', title: 'Antimicrobiano que piora a miastenia gravis', recommendation: 'Risco de crise miastênica; escolher outra classe.' },
];

/** Grupos para detectar duplicidade terapêutica. */
export const DUPLICATION_GROUPS: { label: string; classes: DrugClass[] }[] = [
  { label: 'anti-inflamatórios (AINEs)', classes: ['AINE'] },
  { label: 'IECA', classes: ['IECA'] },
  { label: 'BRA', classes: ['BRA'] },
  { label: 'estatinas', classes: ['ESTATINA'] },
  { label: 'ISRS', classes: ['ISRS'] },
  { label: 'benzodiazepínicos', classes: ['BENZODIAZEPINICO'] },
  { label: 'inibidores de bomba de prótons', classes: ['IBP'] },
  { label: 'anticoagulantes', classes: ['CUMARINICO', 'ANTICOAGULANTE_DIRETO', 'HEPARINA'] },
  { label: 'opioides', classes: ['OPIOIDE'] },
  { label: 'sulfonilureias', classes: ['SULFONILUREIA'] },
  { label: 'betabloqueadores', classes: ['BETABLOQUEADOR'] },
  { label: 'corticoides', classes: ['CORTICOIDE'] },
  { label: 'penicilinas', classes: ['PENICILINA'] },
  { label: 'cefalosporinas', classes: ['CEFALOSPORINA'] },
  { label: 'fluoroquinolonas', classes: ['FLUOROQUINOLONA'] },
  { label: 'macrolídeos', classes: ['MACROLIDEO'] },
  { label: 'diuréticos tiazídicos', classes: ['TIAZIDICO'] },
];
