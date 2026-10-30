import { describe, expect, it } from 'vitest';
import {
  analyzePrescription,
  checkPrescription,
  ckdEpi2021,
  doseInMg,
  dosesPerDay,
  findDrugsInText,
  requiresJustification,
  type PrescriptionCheckInput,
} from '@omnisaude/ai-engine';

const now = new Date('2026-10-30T12:00:00Z');
const adult = { ageYears: 50, sex: 'M' as const };
const base = (extra: Partial<PrescriptionCheckInput>): PrescriptionCheckInput => ({ newItems: [], patient: adult, now, ...extra });
const ruleIds = (input: PrescriptionCheckInput) => checkPrescription(input).map((a) => `${a.severity}:${a.ruleId}`);

describe('identificação de medicamentos', () => {
  it('reconhece nomes comerciais/genéricos sem acento e combinações', () => {
    expect(findDrugsInText('Dipirona sódica 500 mg comprimido').map((d) => d.key)).toEqual(['dipirona']);
    expect(findDrugsInText('AMOXICILINA + CLAVULANATO DE POTÁSSIO 875/125').map((d) => d.key)).toEqual(['amoxicilina_clavulanato']);
    expect(findDrugsInText('Losartana potássica 50mg e HCTZ').map((d) => d.key).sort()).toEqual(['hidroclorotiazida', 'losartana']);
    expect(findDrugsInText('Ácido acetilsalicílico 100 mg').map((d) => d.key)).toEqual(['aas']);
  });
});

describe('interações', () => {
  it('varfarina + AINE é grave e exige justificativa', () => {
    const input = base({ newItems: [{ name: 'Ibuprofeno 600 mg' }], currentMedications: [{ name: 'Varfarina 5 mg' }] });
    const alerts = checkPrescription(input);
    expect(alerts[0]).toMatchObject({ severity: 'GRAVE', code: 'INTERACAO', ruleId: 'INT-CUMARINICO-AINE', involves: ['Ibuprofeno 600 mg', 'Varfarina 5 mg'] });
    expect(requiresJustification(alerts)).toBe(true);
  });

  it('cobre as interações clássicas da base', () => {
    const pair = (a: string, b: string) => ruleIds(base({ newItems: [{ name: a }], currentMedications: [{ name: b }] }));
    expect(pair('Claritromicina 500 mg', 'Sinvastatina 40 mg')).toContain('GRAVE:INT-ESTATINA-CYP3A4');
    expect(pair('Claritromicina', 'Atorvastatina')).toContain('MODERADO:INT-ATORVASTATINA-CYP3A4');
    expect(pair('Sildenafila 50 mg', 'Mononitrato de isossorbida')).toContain('GRAVE:INT-NITRATO-PDE5');
    expect(pair('Tramadol 50 mg', 'Fluoxetina 20 mg')).toContain('GRAVE:INT-ISRS-TRAMADOL');
    expect(pair('Hidroclorotiazida 25 mg', 'Carbonato de lítio 300 mg')).toContain('GRAVE:INT-LITIO-DIURETICO-AINE');
    expect(pair('Omeprazol 20 mg', 'Clopidogrel 75 mg')).toContain('MODERADO:INT-CLOPIDOGREL-IBP');
    expect(pair('Amiodarona', 'Digoxina 0,25 mg')).toContain('GRAVE:INT-DIGOXINA-AMIODARONA');
    expect(pair('Amiodarona', 'Varfarina')).toContain('GRAVE:INT-VARFARINA-POTENCIALIZADORES');
    expect(pair('Losartana', 'Enalapril')).toContain('MODERADO:INT-IECA-BRA');
    expect(pair('Diazepam', 'Morfina')).toContain('GRAVE:INT-BZD-OPIOIDE');
    expect(pair('Ciprofloxacino', 'Teofilina')).toContain('GRAVE:INT-QUINOLONA-XANTINA');
    expect(pair('Pantoprazol', 'Clopidogrel')).not.toContain('MODERADO:INT-CLOPIDOGREL-IBP');
  });

  it('eleva a hipercalemia para grave com potássio alto', () => {
    const items = { newItems: [{ name: 'Espironolactona 25 mg' }], currentMedications: [{ name: 'Enalapril 10 mg' }] };
    expect(ruleIds(base(items))).toContain('MODERADO:INT-SRAA-POTASSIO');
    const withLab = base({ ...items, labs: [{ code: 'POTASSIO', value: 5.6, unit: 'mEq/L', collectedAt: '2026-10-20' }] });
    expect(ruleIds(withLab)).toEqual(expect.arrayContaining(['GRAVE:INT-SRAA-POTASSIO', 'GRAVE:K-ELEVADO-POUPADOR']));
  });

  it('não acusa interação entre medicamentos já em uso', () => {
    const alerts = checkPrescription(base({ newItems: [{ name: 'Paracetamol 500 mg' }], currentMedications: [{ name: 'Varfarina' }, { name: 'AAS 100 mg' }] }));
    expect(alerts.filter((a) => a.code === 'INTERACAO')).toEqual([]);
  });

  it('interação entre dois itens novos da mesma prescrição', () => {
    expect(ruleIds(base({ newItems: [{ name: 'Diclofenaco 50 mg' }, { name: 'Prednisona 20 mg' }] }))).toContain('MODERADO:INT-AINE-CORTICOIDE');
  });
});

describe('alergias', () => {
  it('mesmo fármaco, mesma classe e reatividade cruzada', () => {
    expect(ruleIds(base({ newItems: [{ name: 'Dipirona 1 g' }], allergies: ['Dipirona'] }))).toContain('GRAVE:ALG-MESMO-FARMACO');
    expect(ruleIds(base({ newItems: [{ name: 'Amoxicilina 500 mg' }], allergies: ['alergia a PENICILINA'] }))).toContain('GRAVE:ALG-CLASSE');
    expect(ruleIds(base({ newItems: [{ name: 'Ampicilina' }], allergies: ['Amoxicilina'] }))).toContain('GRAVE:ALG-MESMA-CLASSE');
    expect(ruleIds(base({ newItems: [{ name: 'Cefalexina 500 mg' }], allergies: ['Penicilina'] }))).toContain('MODERADO:ALG-CRUZADA-PENICILINA-CEFALOSPORINA');
    expect(ruleIds(base({ newItems: [{ name: 'Furosemida 40 mg' }], allergies: ['Sulfa'] }))).toContain('LEVE:ALG-CRUZADA-SULFONAMIDA_ANTIBIOTICA-SULFONAMIDA_NAO_ANTIBIOTICA');
    expect(ruleIds(base({ newItems: [{ name: 'Ibuprofeno' }], allergies: ['AAS'] }))).toContain('MODERADO:ALG-CRUZADA-SALICILATO-AINE');
    expect(ruleIds(base({ newItems: [{ name: 'Paracetamol' }], allergies: ['Penicilina', 'Dipirona'] }))).toEqual([]);
  });
});

describe('função renal', () => {
  it('CKD-EPI 2021', () => {
    expect(ckdEpi2021(1.0, 50, 'M')).toBe(92);
    expect(ckdEpi2021(1.0, 50, 'F')).toBe(69);
    expect(ckdEpi2021(2.5, 70, 'M')).toBe(27);
  });

  it('metformina e AINE conforme a TFG estimada pela creatinina', () => {
    const labs = [{ code: 'CREATININA', value: 2.5, unit: 'mg/dL', collectedAt: '2026-10-01' }];
    const r = analyzePrescription(base({ newItems: [{ name: 'Metformina 850 mg' }, { name: 'Nimesulida 100 mg' }], labs, patient: { ageYears: 70, sex: 'M' } }));
    expect(r.egfr).toMatchObject({ value: 27, source: 'CKD-EPI 2021' });
    expect(r.alerts.map((a) => `${a.severity}:${a.ruleId}`)).toEqual(expect.arrayContaining(['GRAVE:REN-METFORMINA', 'GRAVE:REN-AINE']));
  });

  it('usa a TFG informada, converte µmol/L e ignora exames antigos', () => {
    expect(analyzePrescription(base({ newItems: [{ name: 'Metformina' }], labs: [{ code: 'TFG', value: 40, collectedAt: '2026-10-01' }] })).alerts[0]?.ruleId).toBe('REN-METFORMINA');
    const umol = analyzePrescription(base({ newItems: [{ name: 'Metformina' }], labs: [{ code: 'CREATININA', value: 88.4, unit: 'µmol/L', collectedAt: '2026-10-01' }] }));
    expect(umol.egfr?.value).toBe(92);
    const old = analyzePrescription(base({ newItems: [{ name: 'Metformina' }], labs: [{ code: 'CREATININA', value: 3, collectedAt: '2025-01-01' }], patient: { ageYears: 70, sex: 'F' } }));
    expect(old.egfr).toBeUndefined();
    expect(old.alerts.map((a) => a.ruleId)).toContain('REN-SEM-CREATININA');
  });
});

describe('contexto do paciente', () => {
  it('gestação (flag ou CID) contraindica IECA, varfarina e estatina', () => {
    expect(ruleIds(base({ newItems: [{ name: 'Enalapril 10 mg' }], patient: { ageYears: 28, sex: 'F', pregnant: true } }))).toContain('GRAVE:GES-SRAA');
    expect(ruleIds(base({ newItems: [{ name: 'Sinvastatina' }], conditions: ['Z34.0'], patient: { ageYears: 30, sex: 'F' } }))).toContain('GRAVE:GES-ESTATINA');
    expect(ruleIds(base({ newItems: [{ name: 'Isotretinoína 20 mg' }], patient: { ageYears: 19, sex: 'F' } }))).toContain('LEVE:GES-RETINOIDE-IDADE-FERTIL');
  });

  it('idade: AAS em criança, codeína em menor de 12, benzodiazepínico em idoso', () => {
    expect(ruleIds(base({ newItems: [{ name: 'AAS 500 mg' }], patient: { ageYears: 8, sex: 'M' } }))).toContain('GRAVE:IDA-AAS-REYE');
    expect(ruleIds(base({ newItems: [{ name: 'Codeína 30 mg' }], patient: { ageYears: 10, sex: 'F' } }))).toContain('GRAVE:IDA-CODEINA-TRAMADOL');
    expect(ruleIds(base({ newItems: [{ name: 'Clonazepam 2 mg' }], patient: { ageYears: 80, sex: 'F' } }))).toContain('MODERADO:IDA-BZD-IDOSO');
  });

  it('condições registradas (CID-10)', () => {
    expect(ruleIds(base({ newItems: [{ name: 'Propranolol 40 mg' }], conditions: ['J45.9'] }))).toContain('GRAVE:CON-ASMA-BB');
    expect(ruleIds(base({ newItems: [{ name: 'Naproxeno' }], conditions: ['K25'] }))).toContain('GRAVE:CON-ULCERA-AINE');
    expect(ruleIds(base({ newItems: [{ name: 'Gentamicina' }], conditions: ['G70.0'] }))).toContain('GRAVE:CON-MIASTENIA');
  });
});

describe('duplicidade, dose e itens desconhecidos', () => {
  it('duplicidade terapêutica e item já em uso', () => {
    expect(ruleIds(base({ newItems: [{ name: 'Ibuprofeno' }], currentMedications: [{ name: 'Diclofenaco' }] }))).toContain('MODERADO:DUP-CLASSE-AINE');
    expect(ruleIds(base({ newItems: [{ name: 'Losartana 100 mg' }], currentMedications: [{ name: 'Losartana potássica 50 mg' }] }))).toContain('MODERADO:DUP-MESMO-FARMACO');
  });

  it('dose diária acima do máximo', () => {
    expect(dosesPerDay('de 6 em 6 horas')).toBe(4);
    expect(dosesPerDay('8/8h')).toBe(3);
    expect(dosesPerDay('3x ao dia')).toBe(3);
    expect(dosesPerDay('a cada doze horas')).toBe(2);
    expect(doseInMg('1 g')).toBe(1000);
    expect(doseInMg('2 comprimidos de 500 mg')).toBe(1000);
    expect(doseInMg('100 mg/ml')).toBeUndefined();
    expect(ruleIds(base({ newItems: [{ name: 'Paracetamol', dose: '1 g', frequency: '4/4h' }] }))).toContain('GRAVE:DOSE-PARACETAMOL');
    expect(ruleIds(base({ newItems: [{ name: 'Paracetamol', dose: '750 mg', frequency: '6/6h' }], patient: { ageYears: 80, sex: 'F' } }))).toEqual([]);
    expect(ruleIds(base({ newItems: [{ name: 'Paracetamol', dose: '1 g', frequency: '6/6h' }], patient: { ageYears: 80, sex: 'F' } }))).toContain('GRAVE:DOSE-PARACETAMOL');
  });

  it('avisa quando não reconhece o medicamento', () => {
    const alerts = checkPrescription(base({ newItems: [{ name: 'Xyzumab 10 mg' }] }));
    expect(alerts).toEqual([expect.objectContaining({ severity: 'LEVE', code: 'NAO_RECONHECIDO' })]);
    expect(requiresJustification(alerts)).toBe(false);
  });

  it('ordena por gravidade e informa a versão da base', () => {
    const r = analyzePrescription(base({ newItems: [{ name: 'Ibuprofeno' }, { name: 'Xyzumab' }], currentMedications: [{ name: 'Varfarina' }, { name: 'Losartana' }] }));
    const order = r.alerts.map((a) => a.severity);
    expect(order).toEqual([...order].sort((a, b) => ['GRAVE', 'MODERADO', 'LEVE'].indexOf(a) - ['GRAVE', 'MODERADO', 'LEVE'].indexOf(b)));
    expect(r.knowledgeBaseVersion).toMatch(/^seed-dev/);
    expect(r.requiresJustification).toBe(true);
  });
});
