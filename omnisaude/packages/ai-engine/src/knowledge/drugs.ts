/**
 * BASE DE CONHECIMENTO DE DESENVOLVIMENTO. Lista curta de princípios ativos comuns na RENAME,
 * criada para exercitar o motor de regras. Antes de qualquer uso clínico ela precisa ser
 * revisada e ampliada pela Comissão de Farmácia e Terapêutica (CFT) do tenant.
 */
import { normalizeKey } from '../text';

export const KNOWLEDGE_BASE_VERSION = 'seed-dev-2026.10';

export type DrugClass =
  | 'AINE'
  | 'SALICILATO'
  | 'ANTIAGREGANTE'
  | 'PIRAZOLONA'
  | 'ANALGESICO'
  | 'CUMARINICO'
  | 'ANTICOAGULANTE_DIRETO'
  | 'HEPARINA'
  | 'IECA'
  | 'BRA'
  | 'POUPADOR_POTASSIO'
  | 'SUPLEMENTO_POTASSIO'
  | 'TIAZIDICO'
  | 'DIURETICO_ALCA'
  | 'ESTATINA'
  | 'MACROLIDEO'
  | 'INIBIDOR_CYP3A4_FORTE'
  | 'AZOL'
  | 'NITRATO'
  | 'INIBIDOR_PDE5'
  | 'ISRS'
  | 'OPIOIDE'
  | 'LITIO'
  | 'IBP'
  | 'INIBIDOR_CYP2C19'
  | 'DIGITALICO'
  | 'ANTIARRITMICO'
  | 'BIGUANIDA'
  | 'AMINOGLICOSIDEO'
  | 'GLICOPEPTIDEO'
  | 'NEFROTOXICO'
  | 'PENICILINA'
  | 'CEFALOSPORINA'
  | 'CARBAPENEM'
  | 'SULFONAMIDA_ANTIBIOTICA'
  | 'SULFONAMIDA_NAO_ANTIBIOTICA'
  | 'FLUOROQUINOLONA'
  | 'XANTINA'
  | 'RETINOIDE'
  | 'BENZODIAZEPINICO'
  | 'CORTICOIDE'
  | 'BETABLOQUEADOR_NAO_SELETIVO'
  | 'BETABLOQUEADOR'
  | 'NITROIMIDAZOL'
  | 'TETRACICLINA'
  | 'ANTICONVULSIVANTE'
  | 'ANTIMETABOLITO'
  | 'PROSTAGLANDINA'
  | 'NITROFURANO'
  | 'SULFONILUREIA'
  | 'INSULINA'
  | 'BLOQUEADOR_CANAL_CALCIO';

export interface DrugInfo {
  key: string;
  label: string;
  synonyms: string[];
  classes: DrugClass[];
  /** Dose diária máxima usual para adultos, em mg (quando aplicável). */
  maxDailyDoseMg?: number;
  /** Dose diária máxima para idosos (≥ 65 anos), quando diferente. */
  maxDailyDoseElderlyMg?: number;
}

const D = (key: string, label: string, classes: DrugClass[], synonyms: string[] = [], extra: Partial<DrugInfo> = {}): DrugInfo => ({
  key,
  label,
  classes,
  synonyms,
  ...extra,
});

export const DRUGS: readonly DrugInfo[] = [
  // Analgésicos e anti-inflamatórios
  D('paracetamol', 'Paracetamol', ['ANALGESICO'], ['acetaminofeno', 'acetaminofen'], { maxDailyDoseMg: 4000, maxDailyDoseElderlyMg: 3000 }),
  D('dipirona', 'Dipirona', ['PIRAZOLONA', 'ANALGESICO'], ['metamizol', 'dipirona sodica', 'dipirona monoidratada'], { maxDailyDoseMg: 4000 }),
  D('aas', 'Ácido acetilsalicílico', ['SALICILATO', 'ANTIAGREGANTE'], ['acido acetilsalicilico', 'aspirina']),
  D('ibuprofeno', 'Ibuprofeno', ['AINE'], [], { maxDailyDoseMg: 3200 }),
  D('diclofenaco', 'Diclofenaco', ['AINE'], ['diclofenaco sodico', 'diclofenaco potassico'], { maxDailyDoseMg: 150 }),
  D('naproxeno', 'Naproxeno', ['AINE'], [], { maxDailyDoseMg: 1500 }),
  D('cetoprofeno', 'Cetoprofeno', ['AINE'], [], { maxDailyDoseMg: 300 }),
  D('nimesulida', 'Nimesulida', ['AINE'], [], { maxDailyDoseMg: 200 }),
  D('meloxicam', 'Meloxicam', ['AINE'], [], { maxDailyDoseMg: 15 }),
  D('piroxicam', 'Piroxicam', ['AINE'], [], { maxDailyDoseMg: 20 }),
  D('indometacina', 'Indometacina', ['AINE'], []),
  D('celecoxibe', 'Celecoxibe', ['AINE'], ['celecoxib']),
  D('tramadol', 'Tramadol', ['OPIOIDE'], ['cloridrato de tramadol'], { maxDailyDoseMg: 400, maxDailyDoseElderlyMg: 300 }),
  D('codeina', 'Codeína', ['OPIOIDE'], ['fosfato de codeina']),
  D('morfina', 'Morfina', ['OPIOIDE'], ['sulfato de morfina']),
  D('fentanil', 'Fentanil', ['OPIOIDE'], ['fentanila']),
  // Anticoagulantes e antiagregantes
  D('varfarina', 'Varfarina', ['CUMARINICO'], ['warfarina', 'varfarina sodica', 'marevan']),
  D('rivaroxabana', 'Rivaroxabana', ['ANTICOAGULANTE_DIRETO'], ['rivaroxaban']),
  D('apixabana', 'Apixabana', ['ANTICOAGULANTE_DIRETO'], ['apixaban']),
  D('dabigatrana', 'Dabigatrana', ['ANTICOAGULANTE_DIRETO'], ['dabigatran']),
  D('heparina', 'Heparina', ['HEPARINA'], ['heparina sodica']),
  D('enoxaparina', 'Enoxaparina', ['HEPARINA'], ['enoxaparina sodica']),
  D('clopidogrel', 'Clopidogrel', ['ANTIAGREGANTE'], ['bissulfato de clopidogrel']),
  // Cardiovasculares
  D('enalapril', 'Enalapril', ['IECA'], ['maleato de enalapril']),
  D('captopril', 'Captopril', ['IECA']),
  D('lisinopril', 'Lisinopril', ['IECA']),
  D('ramipril', 'Ramipril', ['IECA']),
  D('losartana', 'Losartana', ['BRA'], ['losartana potassica', 'losartan']),
  D('valsartana', 'Valsartana', ['BRA'], ['valsartan']),
  D('candesartana', 'Candesartana', ['BRA'], ['candesartan']),
  D('olmesartana', 'Olmesartana', ['BRA'], ['olmesartan']),
  D('telmisartana', 'Telmisartana', ['BRA'], ['telmisartan']),
  D('espironolactona', 'Espironolactona', ['POUPADOR_POTASSIO']),
  D('amilorida', 'Amilorida', ['POUPADOR_POTASSIO']),
  D('cloreto_potassio', 'Cloreto de potássio', ['SUPLEMENTO_POTASSIO'], ['cloreto de potassio', 'kcl', 'xarope de kcl']),
  D('hidroclorotiazida', 'Hidroclorotiazida', ['TIAZIDICO', 'SULFONAMIDA_NAO_ANTIBIOTICA'], ['hctz']),
  D('clortalidona', 'Clortalidona', ['TIAZIDICO', 'SULFONAMIDA_NAO_ANTIBIOTICA']),
  D('indapamida', 'Indapamida', ['TIAZIDICO', 'SULFONAMIDA_NAO_ANTIBIOTICA']),
  D('furosemida', 'Furosemida', ['DIURETICO_ALCA', 'SULFONAMIDA_NAO_ANTIBIOTICA']),
  D('anlodipino', 'Anlodipino', ['BLOQUEADOR_CANAL_CALCIO'], ['besilato de anlodipino', 'amlodipina']),
  D('atenolol', 'Atenolol', ['BETABLOQUEADOR']),
  D('metoprolol', 'Metoprolol', ['BETABLOQUEADOR'], ['succinato de metoprolol', 'tartarato de metoprolol']),
  D('carvedilol', 'Carvedilol', ['BETABLOQUEADOR', 'BETABLOQUEADOR_NAO_SELETIVO']),
  D('propranolol', 'Propranolol', ['BETABLOQUEADOR', 'BETABLOQUEADOR_NAO_SELETIVO'], ['cloridrato de propranolol']),
  D('sinvastatina', 'Sinvastatina', ['ESTATINA'], ['simvastatina']),
  D('lovastatina', 'Lovastatina', ['ESTATINA']),
  D('atorvastatina', 'Atorvastatina', ['ESTATINA'], ['atorvastatina calcica']),
  D('rosuvastatina', 'Rosuvastatina', ['ESTATINA'], ['rosuvastatina calcica']),
  D('pravastatina', 'Pravastatina', ['ESTATINA']),
  D('isossorbida', 'Isossorbida (nitrato)', ['NITRATO'], ['mononitrato de isossorbida', 'dinitrato de isossorbida', 'isordil', 'monocordil']),
  D('nitroglicerina', 'Nitroglicerina', ['NITRATO'], ['trinitrato de glicerila']),
  D('sildenafila', 'Sildenafila', ['INIBIDOR_PDE5'], ['sildenafil', 'citrato de sildenafila']),
  D('tadalafila', 'Tadalafila', ['INIBIDOR_PDE5'], ['tadalafil']),
  D('digoxina', 'Digoxina', ['DIGITALICO']),
  D('amiodarona', 'Amiodarona', ['ANTIARRITMICO'], ['cloridrato de amiodarona']),
  // Endócrino
  D('metformina', 'Metformina', ['BIGUANIDA'], ['cloridrato de metformina'], { maxDailyDoseMg: 2550 }),
  D('glibenclamida', 'Glibenclamida', ['SULFONILUREIA'], [], { maxDailyDoseMg: 20 }),
  D('gliclazida', 'Gliclazida', ['SULFONILUREIA'], [], { maxDailyDoseMg: 320 }),
  D('insulina', 'Insulina', ['INSULINA'], ['insulina nph', 'insulina regular', 'insulina humana']),
  D('prednisona', 'Prednisona', ['CORTICOIDE']),
  D('prednisolona', 'Prednisolona', ['CORTICOIDE']),
  D('dexametasona', 'Dexametasona', ['CORTICOIDE']),
  // Antimicrobianos
  D('amoxicilina', 'Amoxicilina', ['PENICILINA'], ['amoxicilina tri-hidratada']),
  D('amoxicilina_clavulanato', 'Amoxicilina + clavulanato', ['PENICILINA'], ['amoxicilina clavulanato', 'amoxicilina + clavulanato de potassio', 'amoxicilina e clavulanato']),
  D('ampicilina', 'Ampicilina', ['PENICILINA']),
  D('benzilpenicilina', 'Benzilpenicilina', ['PENICILINA'], ['penicilina g benzatina', 'benzetacil', 'benzilpenicilina benzatina', 'penicilina g procaina', 'penicilina cristalina']),
  D('oxacilina', 'Oxacilina', ['PENICILINA']),
  D('piperacilina_tazobactam', 'Piperacilina + tazobactam', ['PENICILINA'], ['piperacilina tazobactam', 'piperacilina']),
  D('cefalexina', 'Cefalexina', ['CEFALOSPORINA']),
  D('cefazolina', 'Cefazolina', ['CEFALOSPORINA']),
  D('cefuroxima', 'Cefuroxima', ['CEFALOSPORINA']),
  D('ceftriaxona', 'Ceftriaxona', ['CEFALOSPORINA']),
  D('cefepima', 'Cefepima', ['CEFALOSPORINA']),
  D('meropenem', 'Meropenem', ['CARBAPENEM']),
  D('imipenem', 'Imipenem', ['CARBAPENEM'], ['imipenem cilastatina']),
  D('azitromicina', 'Azitromicina', ['MACROLIDEO']),
  D('claritromicina', 'Claritromicina', ['MACROLIDEO', 'INIBIDOR_CYP3A4_FORTE']),
  D('eritromicina', 'Eritromicina', ['MACROLIDEO', 'INIBIDOR_CYP3A4_FORTE']),
  D('cetoconazol', 'Cetoconazol', ['AZOL', 'INIBIDOR_CYP3A4_FORTE']),
  D('itraconazol', 'Itraconazol', ['AZOL', 'INIBIDOR_CYP3A4_FORTE']),
  D('fluconazol', 'Fluconazol', ['AZOL']),
  D('sulfametoxazol_trimetoprima', 'Sulfametoxazol + trimetoprima', ['SULFONAMIDA_ANTIBIOTICA'], ['sulfametoxazol', 'smx tmp', 'smx-tmp', 'bactrim', 'cotrimoxazol', 'sulfametoxazol trimetoprima']),
  D('sulfadiazina', 'Sulfadiazina', ['SULFONAMIDA_ANTIBIOTICA']),
  D('ciprofloxacino', 'Ciprofloxacino', ['FLUOROQUINOLONA'], ['ciprofloxacina']),
  D('levofloxacino', 'Levofloxacino', ['FLUOROQUINOLONA'], ['levofloxacina']),
  D('gentamicina', 'Gentamicina', ['AMINOGLICOSIDEO', 'NEFROTOXICO']),
  D('amicacina', 'Amicacina', ['AMINOGLICOSIDEO', 'NEFROTOXICO']),
  D('vancomicina', 'Vancomicina', ['GLICOPEPTIDEO', 'NEFROTOXICO']),
  D('metronidazol', 'Metronidazol', ['NITROIMIDAZOL']),
  D('doxiciclina', 'Doxiciclina', ['TETRACICLINA']),
  D('nitrofurantoina', 'Nitrofurantoína', ['NITROFURANO']),
  // SNC
  D('fluoxetina', 'Fluoxetina', ['ISRS'], ['cloridrato de fluoxetina']),
  D('sertralina', 'Sertralina', ['ISRS'], ['cloridrato de sertralina']),
  D('paroxetina', 'Paroxetina', ['ISRS']),
  D('citalopram', 'Citalopram', ['ISRS']),
  D('escitalopram', 'Escitalopram', ['ISRS']),
  D('litio', 'Carbonato de lítio', ['LITIO'], ['carbonato de litio']),
  D('diazepam', 'Diazepam', ['BENZODIAZEPINICO']),
  D('clonazepam', 'Clonazepam', ['BENZODIAZEPINICO']),
  D('alprazolam', 'Alprazolam', ['BENZODIAZEPINICO']),
  D('midazolam', 'Midazolam', ['BENZODIAZEPINICO']),
  D('lorazepam', 'Lorazepam', ['BENZODIAZEPINICO']),
  D('acido_valproico', 'Ácido valproico', ['ANTICONVULSIVANTE'], ['valproato de sodio', 'divalproato', 'valproato']),
  D('carbamazepina', 'Carbamazepina', ['ANTICONVULSIVANTE']),
  // Gastro e outros
  D('omeprazol', 'Omeprazol', ['IBP', 'INIBIDOR_CYP2C19']),
  D('esomeprazol', 'Esomeprazol', ['IBP', 'INIBIDOR_CYP2C19']),
  D('pantoprazol', 'Pantoprazol', ['IBP']),
  D('teofilina', 'Teofilina', ['XANTINA']),
  D('aminofilina', 'Aminofilina', ['XANTINA']),
  D('isotretinoina', 'Isotretinoína', ['RETINOIDE']),
  D('metotrexato', 'Metotrexato', ['ANTIMETABOLITO']),
  D('misoprostol', 'Misoprostol', ['PROSTAGLANDINA']),
];

export const DRUGS_BY_KEY: ReadonlyMap<string, DrugInfo> = new Map(DRUGS.map((d) => [d.key, d]));

/** Termos de busca (sem acento) ordenados do maior para o menor, para casar "amoxicilina + clavulanato" antes de "amoxicilina". */
const TERMS: { term: string; drug: DrugInfo }[] = DRUGS.flatMap((drug) =>
  [drug.key.replaceAll('_', ' '), drug.label, ...drug.synonyms].map((t) => ({ term: normalizeKey(t).replace(/[+]/g, ' ').replace(/\s+/g, ' '), drug })),
).sort((a, b) => b.term.length - a.term.length);

function searchable(text: string): string {
  return ` ${normalizeKey(text).replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/** Encontra os princípios ativos citados em um texto livre ("Dipirona 500 mg cp" -> dipirona). */
export function findDrugsInText(text: string): DrugInfo[] {
  let haystack = searchable(text);
  const found: DrugInfo[] = [];
  for (const { term, drug } of TERMS) {
    const needle = ` ${term.replace(/[^a-z0-9]+/g, ' ').trim()} `;
    if (needle.trim().length < 3) continue;
    const idx = haystack.indexOf(needle);
    if (idx === -1) continue;
    if (!found.includes(drug)) found.push(drug);
    // Consome o trecho para que "amoxicilina" não case de novo dentro de "amoxicilina clavulanato".
    haystack = haystack.slice(0, idx) + ' '.repeat(needle.length) + haystack.slice(idx + needle.length);
  }
  return found;
}
