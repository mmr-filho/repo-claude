import { cnsFromBase, completeCpf, deslocarSemana, gtinCheckDigit, semanaEpidemiologica, semanasNoAno } from '@omnisaude/shared';

/**
 * Dados fictícios de demonstração. CNES iniciados por 9, CPFs e CNS gerados com dígitos válidos
 * e GTINs com prefixo 789 inventados: nada aqui corresponde a pessoas, unidades ou produtos reais.
 */

export const DEMO_PASSWORD = 'OmniSaude2026';

export const DEMO_TENANT = {
  slug: 'demo',
  name: 'Consórcio Intermunicipal de Saúde Vale Verde (demonstração)',
  kind: 'CONSORCIO' as const,
  cnpj: '04512345000185',
  ibgeCode: '3550308',
  uf: 'SP',
  timeZone: 'America/Sao_Paulo',
};

export const UNITS = [
  { key: 'ubs', cnes: '9000011', name: 'UBS Centro', type: 'UBS' },
  { key: 'ubs2', cnes: '9000028', name: 'UBS Jardim das Flores', type: 'UBS' },
  { key: 'upa', cnes: '9000036', name: 'UPA 24h Norte', type: 'UPA' },
  { key: 'hosp', cnes: '9000044', name: 'Hospital Municipal São Lucas', type: 'HOSPITAL' },
  { key: 'poli', cnes: '9000052', name: 'Policlínica Municipal', type: 'POLICLINICA' },
  { key: 'ceo', cnes: '9000060', name: 'CEO Sorriso', type: 'CEO' },
  { key: 'fc', cnes: '9000079', name: 'Farmácia Central', type: 'FARMACIA_CENTRAL' },
  { key: 'alm', cnes: '9000087', name: 'Almoxarifado Central', type: 'ALMOXARIFADO' },
  { key: 'vig', cnes: '9000117', name: 'Vigilância em Saúde', type: 'VIGILANCIA_SAUDE' },
] as const;
export type UnitKey = (typeof UNITS)[number]['key'];

type RoleName =
  | 'RECEPCAO'
  | 'ENFERMAGEM'
  | 'MEDICO'
  | 'MULTIPROFISSIONAL'
  | 'SERVICO_SOCIAL'
  | 'NIR'
  | 'FARMACIA'
  | 'FATURAMENTO'
  | 'GESTOR'
  | 'ACS'
  | 'VIGILANCIA_EPIDEMIOLOGICA'
  | 'NUCLEO_VIGILANCIA'
  | 'ACE'
  | 'SUPERVISOR_ENDEMIAS'
  | 'COORDENADOR_ENDEMIAS';

export const STAFF: {
  key: string;
  name: string;
  cpf: string;
  cns: string;
  council?: string;
  assignments: { unit: UnitKey; role: RoleName; cbo: string }[];
}[] = [
  {
    key: 'recepcao',
    name: 'Ana Paula Recepção',
    cpf: completeCpf('100000001'),
    cns: cnsFromBase('10000000001'),
    assignments: [
      { unit: 'ubs', role: 'RECEPCAO', cbo: '422105' },
      { unit: 'upa', role: 'RECEPCAO', cbo: '422105' },
    ],
  },
  {
    key: 'enfermeiro',
    name: 'Bruno Almeida Enfermeiro',
    cpf: completeCpf('100000002'),
    cns: cnsFromBase('10000000002'),
    council: 'COREN-SP 100002',
    assignments: [
      { unit: 'upa', role: 'ENFERMAGEM', cbo: '223505' },
      { unit: 'hosp', role: 'ENFERMAGEM', cbo: '223505' },
      { unit: 'ubs', role: 'ENFERMAGEM', cbo: '223505' },
    ],
  },
  {
    key: 'tecnica',
    name: 'Joana Lima Técnica de Enfermagem',
    cpf: completeCpf('100000010'),
    cns: cnsFromBase('10000000010'),
    council: 'COREN-SP 100010',
    assignments: [{ unit: 'hosp', role: 'ENFERMAGEM', cbo: '322205' }],
  },
  {
    key: 'medica',
    name: 'Carla Menezes Médica',
    cpf: completeCpf('100000003'),
    cns: cnsFromBase('10000000003'),
    council: 'CRM-SP 100003',
    assignments: [
      { unit: 'ubs', role: 'MEDICO', cbo: '225125' },
      { unit: 'upa', role: 'MEDICO', cbo: '225125' },
      { unit: 'hosp', role: 'MEDICO', cbo: '225125' },
    ],
  },
  {
    key: 'dentista',
    name: 'Diego Prado Cirurgião-Dentista',
    cpf: completeCpf('100000004'),
    cns: cnsFromBase('10000000004'),
    council: 'CRO-SP 100004',
    assignments: [{ unit: 'ceo', role: 'MULTIPROFISSIONAL', cbo: '223208' }],
  },
  {
    key: 'social',
    name: 'Elisa Ramos Assistente Social',
    cpf: completeCpf('100000005'),
    cns: cnsFromBase('10000000005'),
    council: 'CRESS-SP 100005',
    assignments: [
      { unit: 'ubs', role: 'SERVICO_SOCIAL', cbo: '251605' },
      { unit: 'hosp', role: 'SERVICO_SOCIAL', cbo: '251605' },
    ],
  },
  {
    key: 'nir',
    name: 'Fábio Teixeira NIR',
    cpf: completeCpf('100000006'),
    cns: cnsFromBase('10000000006'),
    council: 'COREN-SP 100006',
    assignments: [
      { unit: 'hosp', role: 'NIR', cbo: '223505' },
      { unit: 'poli', role: 'NIR', cbo: '223505' },
    ],
  },
  {
    key: 'farmaceutica',
    name: 'Gabriela Souto Farmacêutica',
    cpf: completeCpf('100000007'),
    cns: cnsFromBase('10000000007'),
    council: 'CRF-SP 100007',
    assignments: [
      { unit: 'fc', role: 'FARMACIA', cbo: '223405' },
      { unit: 'hosp', role: 'FARMACIA', cbo: '223405' },
      { unit: 'alm', role: 'FARMACIA', cbo: '223405' },
      { unit: 'upa', role: 'FARMACIA', cbo: '223405' },
    ],
  },
  {
    key: 'faturamento',
    name: 'Hugo Martins Faturista',
    cpf: completeCpf('100000008'),
    cns: cnsFromBase('10000000008'),
    assignments: [
      { unit: 'ubs', role: 'FATURAMENTO', cbo: '411010' },
      { unit: 'upa', role: 'FATURAMENTO', cbo: '411010' },
      { unit: 'hosp', role: 'FATURAMENTO', cbo: '411010' },
    ],
  },
  {
    key: 'gestora',
    name: 'Íris Campos Gestora',
    cpf: completeCpf('100000009'),
    cns: cnsFromBase('10000000009'),
    assignments: [
      { unit: 'ubs', role: 'GESTOR', cbo: '131205' },
      { unit: 'upa', role: 'GESTOR', cbo: '131205' },
      { unit: 'hosp', role: 'GESTOR', cbo: '131205' },
      { unit: 'fc', role: 'GESTOR', cbo: '131205' },
    ],
  },
  {
    key: 'cardiologista',
    name: 'Lúcio Andrade Cardiologista',
    cpf: completeCpf('100000012'),
    cns: cnsFromBase('10000000012'),
    council: 'CRM-SP 100012',
    assignments: [{ unit: 'poli', role: 'MEDICO', cbo: '225120' }],
  },
  {
    key: 'oftalmologista',
    name: 'Marina Lopes Oftalmologista',
    cpf: completeCpf('100000013'),
    cns: cnsFromBase('10000000013'),
    council: 'CRM-SP 100013',
    assignments: [{ unit: 'poli', role: 'MEDICO', cbo: '225265' }],
  },
  {
    key: 'acs',
    name: 'Joaquim Pereira Agente Comunitário',
    cpf: completeCpf('100000011'),
    cns: cnsFromBase('10000000011'),
    assignments: [{ unit: 'ubs', role: 'ACS', cbo: '515105' }],
  },
  {
    key: 'vigilancia',
    name: 'Vera Lúcia Vigilância Epidemiológica',
    cpf: completeCpf('100000014'),
    cns: cnsFromBase('10000000014'),
    council: 'COREN-TO 100014',
    assignments: [{ unit: 'vig', role: 'VIGILANCIA_EPIDEMIOLOGICA', cbo: '223505' }],
  },
  {
    key: 'nucleo',
    name: 'Nelson Núcleo Hospitalar',
    cpf: completeCpf('100000015'),
    cns: cnsFromBase('10000000015'),
    council: 'COREN-TO 100015',
    assignments: [{ unit: 'hosp', role: 'NUCLEO_VIGILANCIA', cbo: '223505' }],
  },
  // Controle vetorial (VIG-3a): lotados na Vigilância em Saúde, onde fica o depósito de endemias.
  {
    key: 'ace',
    name: 'Rafael Souza Agente de Endemias',
    cpf: completeCpf('100000016'),
    cns: cnsFromBase('10000000016'),
    assignments: [{ unit: 'vig', role: 'ACE', cbo: '515140' }],
  },
  {
    key: 'supervisora',
    name: 'Sílvia Moura Supervisora de Endemias',
    cpf: completeCpf('100000017'),
    cns: cnsFromBase('10000000017'),
    assignments: [{ unit: 'vig', role: 'SUPERVISOR_ENDEMIAS', cbo: '515140' }],
  },
  {
    key: 'coordenador',
    name: 'Otávio Reis Coordenador de Endemias',
    cpf: completeCpf('100000018'),
    cns: cnsFromBase('10000000018'),
    assignments: [{ unit: 'vig', role: 'COORDENADOR_ENDEMIAS', cbo: '131205' }],
  },
];

export interface PatientFixture {
  key: string;
  name: string;
  sex: 'M' | 'F';
  birthDate: string;
  cpfBase: string;
  cnsBase: string;
  motherName: string;
  phone?: string;
  whatsapp?: boolean;
  district: string;
  conditions?: { system: 'CID10' | 'CIAP2'; code: string; description: string; line?: 'HIPERTENSAO' | 'DIABETES' | 'GESTANTE' | 'ONCOLOGIA' }[];
  allergies?: string[];
}

export const PATIENTS: PatientFixture[] = [
  {
    key: 'maria',
    name: 'Maria Aparecida da Silva',
    sex: 'F',
    birthDate: '1968-04-12',
    cpfBase: '200000001',
    cnsBase: '20000000001',
    motherName: 'Benedita da Silva',
    phone: '5511990000001',
    whatsapp: true,
    district: 'Centro',
    conditions: [{ system: 'CID10', code: 'I10', description: 'Hipertensão essencial (primária)', line: 'HIPERTENSAO' }],
  },
  {
    key: 'jose',
    name: 'José Carlos Pereira',
    sex: 'M',
    birthDate: '1975-09-03',
    cpfBase: '200000002',
    cnsBase: '20000000002',
    motherName: 'Rita Pereira',
    phone: '5511990000002',
    whatsapp: true,
    district: 'Vila Nova',
    conditions: [
      { system: 'CID10', code: 'I10', description: 'Hipertensão essencial (primária)', line: 'HIPERTENSAO' },
      { system: 'CID10', code: 'E11', description: 'Diabetes mellitus tipo 2', line: 'DIABETES' },
    ],
  },
  {
    key: 'antonia',
    name: 'Antônia Ferreira Lima',
    sex: 'F',
    birthDate: '1980-01-25',
    cpfBase: '200000003',
    cnsBase: '20000000003',
    motherName: 'Joana Ferreira',
    district: 'Centro',
    conditions: [{ system: 'CID10', code: 'I10', description: 'Hipertensão essencial (primária)', line: 'HIPERTENSAO' }],
  },
  {
    key: 'francisco',
    name: 'Francisco Souza Santos',
    sex: 'M',
    birthDate: '1955-06-30',
    cpfBase: '200000004',
    cnsBase: '20000000004',
    motherName: 'Luzia Souza',
    district: 'Jardim das Flores',
    conditions: [
      { system: 'CID10', code: 'I10', description: 'Hipertensão essencial (primária)', line: 'HIPERTENSAO' },
      { system: 'CID10', code: 'J18', description: 'Pneumonia por microrganismo não especificado' },
    ],
  },
  {
    key: 'luana',
    name: 'Luana Costa Ribeiro',
    sex: 'F',
    birthDate: '1998-11-02',
    cpfBase: '200000005',
    cnsBase: '20000000005',
    motherName: 'Sandra Costa',
    phone: '5511990000005',
    whatsapp: true,
    district: 'Vila Nova',
    conditions: [{ system: 'CID10', code: 'Z34', description: 'Supervisão de gravidez normal', line: 'GESTANTE' }],
  },
  {
    key: 'pedro',
    name: 'Pedro Henrique Alves',
    sex: 'M',
    birthDate: '2019-03-14',
    cpfBase: '200000006',
    cnsBase: '20000000006',
    motherName: 'Camila Alves',
    district: 'Centro',
    conditions: [{ system: 'CID10', code: 'J45', description: 'Asma' }],
  },
  {
    key: 'raimunda',
    name: 'Raimunda Oliveira',
    sex: 'F',
    birthDate: '1950-02-08',
    cpfBase: '200000007',
    cnsBase: '20000000007',
    motherName: 'Francisca Oliveira',
    district: 'Jardim das Flores',
    conditions: [{ system: 'CID10', code: 'E11', description: 'Diabetes mellitus tipo 2', line: 'DIABETES' }],
    allergies: ['dipirona'],
  },
  {
    key: 'carlos',
    name: 'Carlos Eduardo Martins',
    sex: 'M',
    birthDate: '1962-07-19',
    cpfBase: '200000008',
    cnsBase: '20000000008',
    motherName: 'Helena Martins',
    district: 'Centro',
    conditions: [
      { system: 'CID10', code: 'I10', description: 'Hipertensão essencial (primária)', line: 'HIPERTENSAO' },
      { system: 'CID10', code: 'I48', description: 'Flutter e fibrilação atrial' },
    ],
    allergies: ['penicilina'],
  },
  {
    key: 'juliana',
    name: 'Juliana Rocha Mendes',
    sex: 'F',
    birthDate: '1990-05-27',
    cpfBase: '200000009',
    cnsBase: '20000000009',
    motherName: 'Marta Rocha',
    phone: '5511990000009',
    whatsapp: true,
    district: 'Vila Nova',
  },
  {
    key: 'sebastiao',
    name: 'Sebastião Barbosa',
    sex: 'M',
    birthDate: '1948-12-01',
    cpfBase: '200000010',
    cnsBase: '20000000010',
    motherName: 'Ana Barbosa',
    district: 'Jardim das Flores',
    conditions: [{ system: 'CID10', code: 'C61', description: 'Neoplasia maligna da próstata', line: 'ONCOLOGIA' }],
  },
  {
    key: 'fernanda',
    name: 'Fernanda Gomes Araújo',
    sex: 'F',
    birthDate: '1985-08-09',
    cpfBase: '200000011',
    cnsBase: '20000000011',
    motherName: 'Teresa Gomes',
    phone: '5511990000011',
    whatsapp: true,
    district: 'Centro',
    conditions: [
      { system: 'CID10', code: 'I10', description: 'Hipertensão essencial (primária)', line: 'HIPERTENSAO' },
      { system: 'CID10', code: 'E11', description: 'Diabetes mellitus tipo 2', line: 'DIABETES' },
    ],
  },
  {
    key: 'thiago',
    name: 'Thiago Nascimento',
    sex: 'M',
    birthDate: '2001-10-10',
    cpfBase: '200000012',
    cnsBase: '20000000012',
    motherName: 'Patrícia Nascimento',
    district: 'Vila Nova',
  },
];

function gtin(seq: number): string {
  const body = `789000000${String(seq).padStart(3, '0')}`;
  return `${body}${gtinCheckDigit(body)}`;
}

/**
 * Larvicidas da rotina (Nota Informativa nº 29/2024-CGARB, repetida na NI 10/2025): Bti WG 37,4% (em gramas) e o disco
 * de resina de piriproxifeno 2% para recipientes de 40 a 500 L que não podem ser removidos. Lotes fictícios.
 */
export const LARVICIDES = [
  {
    code: 'LAR001',
    description: 'Larvicida biológico Bti WG 37,4% (Bacillus thuringiensis israelensis, cepa AM65-52)',
    activeIngredient: 'Bacillus thuringiensis israelensis',
    concentration: '37,4% p/p (3.000 UTI/mg)',
    pharmaceuticalForm: 'Granulado dispersível em água (WG)',
    unit: 'G',
    lots: [
      { lotNumber: 'BTI2601', expiryDays: 300, quantity: 5000 },
      { lotNumber: 'BTI2509', expiryDays: 40, quantity: 600 },
    ],
  },
  {
    code: 'LAR002',
    description: 'Larvicida piriproxifeno 2% em disco de resina de liberação lenta',
    activeIngredient: 'Piriproxifeno',
    concentration: '2% p/p',
    pharmaceuticalForm: 'Disco de resina',
    unit: 'UN',
    lots: [{ lotNumber: 'PPF2603', expiryDays: 420, quantity: 3 }],
  },
] as const;

/** Imóveis sem família do território de demonstração (comércio, terreno baldio, ponto estratégico, escola). */
export const DEMO_PROPERTIES = [
  { street: 'Avenida Goiás', number: '1200', propertyType: '04', notes: 'Borracharia (ponto estratégico)', lat: -11.73055, lng: -49.06985 },
  { street: 'Rua Exemplo', number: 's/n', propertyType: '03', notes: 'Terreno baldio', lat: -11.72935, lng: -49.06985 },
  { street: 'Avenida Goiás', number: '1350', propertyType: '02', notes: 'Mercado', lat: -11.72815, lng: -49.0683 },
  { street: 'Rua das Flores', number: '50', propertyType: '05', notes: 'Escola municipal (imóvel especial)', lat: -11.73055, lng: -49.0683 },
  { street: 'Rua das Flores', number: '72', propertyType: '01', notes: 'Residência sem cadastro de família', lat: -11.72935, lng: -49.0683 },
  { street: 'Rua das Flores', number: '90', propertyType: '01', notes: 'Residência sem cadastro de família', lat: -11.72815, lng: -49.06985 },
] as const;

export const PRODUCTS = [
  { code: 'MED001', description: 'Dipirona sódica 500 mg comprimido', activeIngredient: 'dipirona', unit: 'CP', gtin: gtin(1) },
  { code: 'MED002', description: 'Paracetamol 500 mg comprimido', activeIngredient: 'paracetamol', unit: 'CP', gtin: gtin(2) },
  { code: 'MED003', description: 'Losartana potássica 50 mg comprimido', activeIngredient: 'losartana', unit: 'CP', gtin: gtin(3) },
  { code: 'MED004', description: 'Hidroclorotiazida 25 mg comprimido', activeIngredient: 'hidroclorotiazida', unit: 'CP', gtin: gtin(4) },
  { code: 'MED005', description: 'Enalapril 10 mg comprimido', activeIngredient: 'enalapril', unit: 'CP', gtin: gtin(5) },
  { code: 'MED006', description: 'Metformina 850 mg comprimido', activeIngredient: 'metformina', unit: 'CP', gtin: gtin(6) },
  { code: 'MED007', description: 'Sinvastatina 20 mg comprimido', activeIngredient: 'sinvastatina', unit: 'CP', gtin: gtin(7) },
  { code: 'MED008', description: 'Ácido acetilsalicílico 100 mg comprimido', activeIngredient: 'acido acetilsalicilico', unit: 'CP', gtin: gtin(8) },
  { code: 'MED009', description: 'Amoxicilina 500 mg cápsula', activeIngredient: 'amoxicilina', unit: 'CAP', gtin: gtin(9) },
  { code: 'MED010', description: 'Omeprazol 20 mg cápsula', activeIngredient: 'omeprazol', unit: 'CAP', gtin: gtin(10) },
  { code: 'MED011', description: 'Varfarina sódica 5 mg comprimido', activeIngredient: 'varfarina', unit: 'CP', gtin: gtin(11), highAlert: true },
  { code: 'MED012', description: 'Espironolactona 25 mg comprimido', activeIngredient: 'espironolactona', unit: 'CP', gtin: gtin(12) },
  { code: 'MED013', description: 'Ceftriaxona 1 g pó para solução injetável', activeIngredient: 'ceftriaxona', unit: 'FA', gtin: gtin(13), antimicrobialRestricted: true },
  { code: 'MED014', description: 'Morfina 10 mg/mL solução injetável ampola 1 mL', activeIngredient: 'morfina', unit: 'AMP', gtin: gtin(14), controlledList: 'A1', highAlert: true },
  { code: 'MED015', description: 'Diazepam 10 mg comprimido', activeIngredient: 'diazepam', unit: 'CP', gtin: gtin(15), controlledList: 'B1' },
  { code: 'MED016', description: 'Cloreto de potássio 19,1% solução injetável ampola 10 mL', activeIngredient: 'cloreto de potassio', unit: 'AMP', gtin: gtin(16), highAlert: true },
  { code: 'MED017', description: 'Heparina sódica 5.000 UI/0,25 mL solução injetável', activeIngredient: 'heparina', unit: 'AMP', gtin: gtin(17), highAlert: true },
  { code: 'MED018', description: 'Insulina humana NPH 100 UI/mL frasco 10 mL', activeIngredient: 'insulina nph', unit: 'FR', gtin: gtin(18), highAlert: true },
  { code: 'MED019', description: 'Dipirona sódica 500 mg/mL solução injetável ampola 2 mL', activeIngredient: 'dipirona', unit: 'AMP', gtin: gtin(19) },
] as const;

/**
 * Amostra da tabela SIGTAP para demonstrar a crítica pré-glosa. A carga real vem da sincronização
 * mensal com o DATASUS; valores e compatibilidades aqui são ilustrativos.
 */
export const SIGTAP_SAMPLE = [
  {
    code: '0301010072',
    name: 'CONSULTA MEDICA EM ATENÇÃO ESPECIALIZADA',
    sex: 'I',
    minAgeMonths: 0,
    maxAgeMonths: 1560,
    maxQuantity: 1,
    valueSa: 10,
    instruments: ['BPA_I'],
    cbos: ['225125', '225142', '225170'],
    cids: [],
  },
  {
    code: '0301060061',
    name: 'ATENDIMENTO DE URGENCIA EM ATENÇÃO ESPECIALIZADA',
    sex: 'I',
    minAgeMonths: 0,
    maxAgeMonths: 1560,
    maxQuantity: 1,
    valueSa: 11,
    instruments: ['BPA_I'],
    cbos: ['225125', '225142', '225170'],
    cids: ['I10', 'J45', 'R50', 'R51', 'J18', 'E11', 'R10'],
  },
  {
    code: '0301060118',
    name: 'ACOLHIMENTO COM CLASSIFICAÇÃO DE RISCO',
    sex: 'I',
    minAgeMonths: 0,
    maxAgeMonths: 1560,
    maxQuantity: 1,
    valueSa: 0,
    instruments: ['BPA_C'],
    cbos: ['223505', '225125'],
    cids: [],
  },
  {
    code: '0301100039',
    name: 'AFERIÇÃO DE PRESSÃO ARTERIAL',
    sex: 'I',
    minAgeMonths: 0,
    maxAgeMonths: 1560,
    maxQuantity: 1,
    valueSa: 0,
    instruments: ['BPA_C'],
    cbos: ['223505', '322205', '225125'],
    cids: [],
  },
  {
    code: '0214010015',
    name: 'GLICEMIA CAPILAR',
    sex: 'I',
    minAgeMonths: 0,
    maxAgeMonths: 1560,
    maxQuantity: 1,
    valueSa: 0,
    instruments: ['BPA_C'],
    cbos: ['223505', '322205', '225125'],
    cids: [],
  },
  {
    code: '0211020036',
    name: 'ELETROCARDIOGRAMA',
    sex: 'I',
    minAgeMonths: 0,
    maxAgeMonths: 1560,
    maxQuantity: 1,
    valueSa: 5.15,
    instruments: ['BPA_C', 'BPA_I'],
    cbos: ['225125', '225120'],
    cids: [],
  },
  {
    code: '0202020380',
    name: 'HEMOGRAMA COMPLETO',
    sex: 'I',
    minAgeMonths: 0,
    maxAgeMonths: 1560,
    maxQuantity: 1,
    valueSa: 4.11,
    instruments: ['BPA_C'],
    cbos: ['221205', '223415', '225125'],
    cids: [],
  },
  {
    code: '0201020033',
    name: 'COLETA DE MATERIAL P/ EXAME CITOPATOLOGICO DE COLO UTERINO',
    sex: 'F',
    minAgeMonths: 144,
    maxAgeMonths: 1560,
    maxQuantity: 1,
    valueSa: 0,
    instruments: ['BPA_C'],
    cbos: ['223505', '225125', '225250'],
    cids: [],
  },
] as const;

export const POPS = [
  {
    code: 'POP-ENF-001',
    title: 'Administração de medicamentos de alta vigilância',
    kind: 'HARD',
    trigger: 'administracao.alta_vigilancia',
    requiresDoubleCheck: true,
    content: 'Medicamentos potencialmente perigosos (anticoagulantes, insulinas, opioides, eletrólitos concentrados) exigem conferência independente por um segundo profissional antes da administração.',
    checklist: [
      { id: 'identificacao', text: 'Paciente identificado por dois identificadores (nome completo e data de nascimento)', required: true },
      { id: 'prescricao', text: 'Prescrição conferida: medicamento, dose, via e horário', required: true },
      { id: 'calculo', text: 'Cálculo de dose/diluição conferido de forma independente', required: true },
      { id: 'bomba', text: 'Bomba de infusão programada e conferida (quando aplicável)', required: false },
    ],
  },
  {
    code: 'POP-ENF-002',
    title: 'Administração de antimicrobianos de uso restrito',
    kind: 'HARD',
    trigger: 'administracao.antimicrobiano_restrito',
    requiresDoubleCheck: false,
    content: 'Antimicrobianos de uso restrito só são administrados com liberação da CCIH registrada e checagem do horário de início.',
    checklist: [
      { id: 'ccih', text: 'Liberação da CCIH registrada no prontuário', required: true },
      { id: 'cultura', text: 'Coleta de culturas realizada antes da primeira dose (quando indicada)', required: false },
      { id: 'horario', text: 'Horário da dose conferido com o aprazamento', required: true },
    ],
  },
  {
    code: 'POP-ENF-003',
    title: 'Transfusão de hemocomponentes',
    kind: 'HARD',
    trigger: 'administracao.hemoderivado',
    requiresDoubleCheck: true,
    content: 'Conferência à beira do leito da bolsa com a requisição e o paciente, sinais vitais antes e 15 minutos após o início.',
    checklist: [
      { id: 'bolsa', text: 'Bolsa conferida com a requisição (tipo ABO/Rh, número, validade)', required: true },
      { id: 'sinais', text: 'Sinais vitais registrados antes do início', required: true },
      { id: 'consentimento', text: 'Termo de consentimento assinado', required: true },
    ],
  },
  {
    code: 'POP-GER-001',
    title: 'Higienização das mãos',
    kind: 'SOFT',
    trigger: null,
    requiresDoubleCheck: false,
    content: 'Os cinco momentos: antes de tocar o paciente, antes de procedimento asséptico, após risco de exposição a fluidos, após tocar o paciente e após tocar superfícies próximas.',
    checklist: [],
  },
  {
    code: 'POP-GER-002',
    title: 'Identificação do paciente',
    kind: 'SOFT',
    trigger: null,
    requiresDoubleCheck: false,
    content: 'Use sempre ao menos dois identificadores (nome completo e data de nascimento) e confira a pulseira antes de qualquer cuidado.',
    checklist: [],
  },
  {
    code: 'POP-GER-003',
    title: 'Prevenção de quedas',
    kind: 'SOFT',
    trigger: null,
    requiresDoubleCheck: false,
    content: 'Avalie o risco de queda na admissão e diariamente; mantenha grades elevadas e campainha ao alcance.',
    checklist: [],
  },
] as const;

/** Vacinas da sala de vacina da demonstração (código do imunobiológico do e-SUS/RNDS). */
export const VACCINES = [
  { code: 'VAC015', vaccineCode: '15', description: 'Vacina BCG', manufacturer: 'FUNDACAO ATAULPHO DE PAIVA', unit: 'DS' },
  { code: 'VAC009', vaccineCode: '09', description: 'Vacina hepatite B (recombinante)', manufacturer: 'INSTITUTO BUTANTAN', unit: 'DS' },
  { code: 'VAC042', vaccineCode: '42', description: 'Vacina penta (DTP/HepB/Hib)', manufacturer: 'INSTITUTO BUTANTAN', unit: 'DS' },
  { code: 'VAC022', vaccineCode: '22', description: 'Vacina poliomielite inativada (VIP)', manufacturer: 'SANOFI PASTEUR', unit: 'DS' },
  { code: 'VAC026', vaccineCode: '26', description: 'Vacina pneumocócica 10-valente', manufacturer: 'GLAXOSMITHKLINE', unit: 'DS' },
  { code: 'VAC045', vaccineCode: '45', description: 'Vacina rotavírus humano', manufacturer: 'GLAXOSMITHKLINE', unit: 'DS' },
  { code: 'VAC041', vaccineCode: '41', description: 'Vacina meningocócica C (conjugada)', manufacturer: 'FUNDACAO EZEQUIEL DIAS', unit: 'DS' },
  { code: 'VAC014', vaccineCode: '14', description: 'Vacina febre amarela', manufacturer: 'BIO-MANGUINHOS/FIOCRUZ', unit: 'DS' },
  { code: 'VAC024', vaccineCode: '24', description: 'Vacina tríplice viral (SCR)', manufacturer: 'BIO-MANGUINHOS/FIOCRUZ', unit: 'DS' },
  { code: 'VAC046', vaccineCode: '46', description: 'Vacina DTP', manufacturer: 'INSTITUTO BUTANTAN', unit: 'DS' },
  { code: 'VAC055', vaccineCode: '55', description: 'Vacina hepatite A (infantil)', manufacturer: 'INSTITUTO BUTANTAN', unit: 'DS' },
  { code: 'VAC034', vaccineCode: '34', description: 'Vacina varicela', manufacturer: 'GLAXOSMITHKLINE', unit: 'DS' },
  { code: 'VAC067', vaccineCode: '67', description: 'Vacina HPV quadrivalente', manufacturer: 'INSTITUTO BUTANTAN', unit: 'DS' },
  { code: 'VAC025', vaccineCode: '25', description: 'Vacina difteria e tétano adulto (dT)', manufacturer: 'INSTITUTO BUTANTAN', unit: 'DS' },
  { code: 'VAC057', vaccineCode: '57', description: 'Vacina dTpa adulto', manufacturer: 'GLAXOSMITHKLINE', unit: 'DS' },
  { code: 'VAC033', vaccineCode: '33', description: 'Vacina influenza trivalente', manufacturer: 'INSTITUTO BUTANTAN', unit: 'DS' },
  { code: 'VAC087', vaccineCode: '87', description: 'Vacina covid-19 RNAm (Comirnaty)', manufacturer: 'PFIZER', unit: 'DS' },
] as const;

// ───────────────────────── Semana 27 (VIG-1c): consolidação, diagrama, contingência, surto e negativa ─────────────────────────

/**
 * População residente do município do tenant de demonstração (São Paulo, IBGE 355030): estimativas da RIPSA/MS do
 * "Estudo de Estimativas Populacionais por Município, Idade e Sexo 2000-2025" (TabNet do DATASUS, popsvs), consultadas
 * em 10/11/2026. O ano em análise sem estimativa usa a do último ano da mesma série (o diagrama marca "repetida").
 */
export const POPULACAO_RIPSA_DEMO = {
  versao: '2000-2025',
  nota: 'TabNet/DATASUS, popsvs: Estudo de Estimativas Populacionais por Município, Idade e Sexo 2000-2025 (São Paulo, 355030), consulta de 10/11/2026',
  anos: {
    2016: 11_980_837,
    2017: 11_999_421,
    2018: 12_010_314,
    2019: 12_015_228,
    2020: 12_012_528,
    2021: 11_986_673,
    2022: 11_950_472,
    2023: 11_930_850,
    2024: 11_895_578,
    2025: 11_904_961,
  } as Record<number, number>,
};

/** Censo 2022 do município (IBGE, SIDRA) e, sintéticos, os da localidade e do bairro da malha de demonstração. */
export const CENSO_2022_DEMO = {
  municipio: 11_451_999,
  notaMunicipio: 'IBGE, Censo 2022, população residente (SIDRA, tabela 4709), consulta de 10/11/2026',
  localidade: 62_400,
  bairro: 18_700,
  notaSintetica: 'Valor sintético da demonstração: troque pela soma do V0001 dos setores censitários do território (Censo 2022)',
};

/** Nome da importação sintética (o mesmo arquivo não é aplicado duas vezes). */
export const IMPORTACAO_DEMO = 'Demonstração (dados sintéticos)';

/** Agravos da importação sintética (DENGON e CHIKON do Sinan Online). */
export type GrupoDemo = 'dengue' | 'chikungunya';

export interface SerieDemo {
  grupo: GrupoDemo;
  ano: number;
  /** Casos prováveis por SE de início dos sintomas (índice 0 = SE 1 … 52 = SE 53; 0 fora do ano e no futuro). */
  provaveis: number[];
  /** Casos descartados por SE (ficam fora da base de prováveis). */
  descartados: number[];
}

export interface SemanasDemo {
  /** Semana em curso no fuso da instituição (AAAASS). */
  atual: string;
  /** Última semana completa: as `semanasIncompletas` mais recentes, contando a em curso, ficam de fora. */
  ultimaCompleta: string;
  /** Ano epidemiológico em análise: o da última semana completa (o mesmo da contingência). */
  anoAnalise: number;
  /** Subida da dengue: as 6 semanas que terminam na última completa. */
  subida: string[];
}

/** Curva sazonal da dengue no Sudeste: pico na SE 14. */
const sazonal = (s: number) => Math.exp(-((s - 14) ** 2) / 98);
/** Casos prováveis de dengue numa SE de ano típico (o centro do canal da demonstração). */
export const baseDengueDemo = (s: number) => Math.round(4 + 20 * sazonal(s));
const baseChikDemo = (s: number) => Math.round(1 + 6 * sazonal(s));
/** Anos de histórico antes do ano em análise (7: cobre as receitas de 5 e de 7 anos). */
export const ANOS_HISTORICO_DEMO = 7;
/** Fator de cada ano de referência, pelo recuo em anos. O recuo 2 (2024, quando o ano em análise é 2026) é epidêmico. */
const FATOR_DENGUE: Record<number, number> = { 7: 1.1, 6: 0.7, 5: 0.6, 4: 0.8, 3: 1, 1: 1.25 };
const FATOR_CHIK: Record<number, number> = { 7: 0.4, 6: 0.3, 5: 0.5, 4: 1, 3: 1.5, 2: 2, 1: 0.8 };

/** Semanas da demonstração no instante `agora`. */
export function semanasDemo(agora: Date, timeZone: string, semanasIncompletas = 2): SemanasDemo {
  const atual = semanaEpidemiologica(agora, timeZone).codigo;
  const ultimaCompleta = deslocarSemana(atual, -Math.max(1, Math.trunc(semanasIncompletas)));
  return { atual, ultimaCompleta, anoAnalise: Number(ultimaCompleta.slice(0, 4)), subida: Array.from({ length: 6 }, (_, i) => deslocarSemana(ultimaCompleta, i - 5)) };
}

/**
 * Casos sintéticos por SE de início dos sintomas, já consolidados (registro oficial ou notificação sem vínculo). Nos
 * anos de referência: um ano típico (fator 1), anos menores e maiores e um ano epidêmico (2,5 a 8 vezes o típico). No
 * ano em análise: abaixo do centro até a subida; nas 6 últimas semanas completas, acima da mediana e abaixo do limite
 * superior (sugestão de MOBILIZAÇÃO no modelo do MS); a semana anterior e a em curso, incompletas. Chikungunya menor e
 * sem casos nas 10 últimas semanas. Tudo relativo à semana em curso: a demonstração continua coerente em outra data.
 */
export function seriesDemo(semanas: SemanasDemo): SerieDemo[] {
  const { atual, anoAnalise, subida } = semanas;
  const anoAtual = Number(atual.slice(0, 4));
  const anterior = deslocarSemana(atual, -1);
  const semChik = deslocarSemana(atual, -10);
  const out: SerieDemo[] = [];
  for (let ano = anoAnalise - ANOS_HISTORICO_DEMO; ano <= anoAtual; ano++) {
    const recuo = anoAnalise - ano;
    const dengue = Array<number>(53).fill(0);
    const chik = Array<number>(53).fill(0);
    for (let s = 1; s <= semanasNoAno(ano); s++) {
      const codigo = `${ano}${String(s).padStart(2, '0')}`;
      const b = baseDengueDemo(s);
      const bc = baseChikDemo(s);
      if (recuo > 0) {
        dengue[s - 1] = recuo === 2 ? Math.round(b * (2.5 + 5.5 * sazonal(s))) : Math.round(b * FATOR_DENGUE[recuo]!);
        chik[s - 1] = Math.round(bc * FATOR_CHIK[recuo]!);
        continue;
      }
      if (codigo > atual) continue;
      dengue[s - 1] = codigo === atual ? Math.round(b / 2) : codigo === anterior ? b + 1 : subida.includes(codigo) ? b + Math.max(2, Math.round(0.4 * b)) : Math.round(0.75 * b);
      chik[s - 1] = codigo >= semChik ? 0 : Math.round(0.6 * bc);
    }
    out.push({ grupo: 'dengue', ano, provaveis: dengue, descartados: dengue.map((c) => Math.round(c / 4)) });
    out.push({ grupo: 'chikungunya', ano, provaveis: chik, descartados: chik.map((c) => Math.round(c * 0.3)) });
  }
  return out;
}

/** Como a notificação da demonstração aparece na conciliação com a importação sintética. */
export type VinculoDemo = 'CASADA' | 'CASADA_DIVERGENTE' | 'SO_OMNISAUDE' | 'SUGESTAO' | null;

/**
 * Notificações da demonstração, em semanas relativas à em curso (−1 = a anterior) e dias da semana (0 = domingo).
 * Dengue: duas casadas com o registro oficial pelo número (uma com divergência), duas só no OmniSaúde e uma com
 * sugestão de vínculo por nome, nascimento e sexo. Coqueluche: duas no mesmo bairro em 7 dias (sugestão de surto).
 */
export const NOTIFICACOES_DEMO: {
  chave: string;
  paciente: string;
  grupo: 'dengue' | 'coqueluche';
  unidade: UnitKey;
  notificador: string;
  semana: number;
  sintomas: number;
  conhecimento: number;
  vinculo: VinculoDemo;
}[] = [
  { chave: 'dengue-maria', paciente: 'maria', grupo: 'dengue', unidade: 'ubs', notificador: 'medica', semana: -3, sintomas: 1, conhecimento: 3, vinculo: 'CASADA_DIVERGENTE' },
  { chave: 'dengue-jose', paciente: 'jose', grupo: 'dengue', unidade: 'upa', notificador: 'medica', semana: -4, sintomas: 2, conhecimento: 4, vinculo: 'CASADA' },
  { chave: 'dengue-carlos', paciente: 'carlos', grupo: 'dengue', unidade: 'ubs', notificador: 'enfermeiro', semana: -2, sintomas: 1, conhecimento: 2, vinculo: 'SO_OMNISAUDE' },
  { chave: 'dengue-juliana', paciente: 'juliana', grupo: 'dengue', unidade: 'upa', notificador: 'medica', semana: -1, sintomas: 2, conhecimento: 4, vinculo: 'SO_OMNISAUDE' },
  { chave: 'dengue-thiago', paciente: 'thiago', grupo: 'dengue', unidade: 'upa', notificador: 'enfermeiro', semana: -5, sintomas: 3, conhecimento: 5, vinculo: 'SUGESTAO' },
  { chave: 'coqueluche-pedro', paciente: 'pedro', grupo: 'coqueluche', unidade: 'ubs', notificador: 'medica', semana: -1, sintomas: 1, conhecimento: 3, vinculo: null },
  { chave: 'coqueluche-antonia', paciente: 'antonia', grupo: 'coqueluche', unidade: 'ubs', notificador: 'medica', semana: -1, sintomas: 3, conhecimento: 5, vinculo: null },
];

/** Quem atesta a notificação negativa de cada unidade. A UBS Jardim das Flores fica sem responsável (e silenciosa). */
export const RESPONSAVEIS_NEGATIVA_DEMO: { unidade: UnitKey; pessoa: string; tipo: 'TITULAR' | 'SUBSTITUTO' }[] = [
  { unidade: 'ubs', pessoa: 'enfermeiro', tipo: 'TITULAR' },
  { unidade: 'ubs', pessoa: 'gestora', tipo: 'SUBSTITUTO' },
  { unidade: 'upa', pessoa: 'enfermeiro', tipo: 'TITULAR' },
  { unidade: 'hosp', pessoa: 'nucleo', tipo: 'TITULAR' },
  { unidade: 'poli', pessoa: 'nir', tipo: 'TITULAR' },
  { unidade: 'ceo', pessoa: 'dentista', tipo: 'TITULAR' },
];

/**
 * Grade da negativa nas 16 últimas semanas fechadas (k = 1 é a anterior à em curso). `semRegistro`: semanas em que a
 * unidade não recebe registro oficial sintético (para a negativa aparecer); `todas` = nunca. `exigeRegistro`: semanas em
 * que a unidade precisa de pelo menos um. Sem notificação, surto nem registro, a unidade com responsável atesta, menos
 * em `semAtesto`. A UBS Jardim das Flores fica sem informação nas 3 últimas semanas fechadas: a unidade silenciosa.
 */
export const NEGATIVA_DEMO = {
  semanas: 16,
  semRegistro: {
    ubs: [5, 8, 11, 14],
    ubs2: [1, 2, 3],
    hosp: [1, 3, 5, 7, 8, 10, 12, 14, 16],
    poli: [1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16],
    ceo: 'todas',
  } as Partial<Record<UnitKey, number[] | 'todas'>>,
  exigeRegistro: { upa: 'todas', ubs2: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] } as Partial<Record<UnitKey, number[] | 'todas'>>,
  /** Semanas sem atesto: a Policlínica não atestou a última e só digitou no Sinan Net a da semana 6. */
  semAtesto: { poli: [1, 6] } as Partial<Record<UnitKey, number[]>>,
  /** Negativa digitada no Sinan Net (NNEGANET) sem atesto no OmniSaúde. */
  soNoSinan: { poli: [6] } as Partial<Record<UnitKey, number[]>>,
  /** Atesto depois do prazo. */
  atrasado: { hosp: [7] } as Partial<Record<UnitKey, number[]>>,
  /** Atesto feito pela substituta (Íris, na UBS Centro). */
  substituto: { ubs: [8] } as Partial<Record<UnitKey, number[]>>,
  /** Semanas atestadas que ainda não foram digitadas no Sinan Net (sem NNEGANET). */
  naoDigitadas: [1],
};

/**
 * Surto de doença transmitida por alimento numa escola da malha de demonstração (DTA, Ficha de Investigação de Surto
 * de DTA): aberto, investigado, com a planilha de acompanhamento preenchida à mão (sem notificação individual: DTA não
 * é agravo individual da lista). Dias da semana anterior à em curso (0 = domingo).
 */
export const SURTO_DEMO = {
  cid: 'A059',
  casos: 14,
  localInicial: '3',
  endereco: 'Rua das Flores, 50',
  referencia: 'Escola municipal (imóvel especial do território)',
  /** Posição da escola em DEMO_PROPERTIES. */
  lat: -11.73055,
  lng: -49.0683,
  diaSintomas: 1,
  diaConhecimento: 2,
  diaInvestigacao: 3,
  observacoes: 'Merenda de segunda-feira (arroz, frango desfiado e salada de maionese). Vômitos e diarreia de 2 a 8 horas depois. Amostras da salada enviadas ao laboratório; aguardando o resultado.',
  dta: {
    NU_ENTR: 38,
    NU_ENT_DOE: 14,
    NU_TOT: 14,
    NU_TOT_HOS: 2,
    NU_OBITO: 0,
    DS_ALICAUS: 'Salada de maionese (suspeita)',
    TP_PRO_PRE: 'Cozinha da escola',
    ST_ALIMEN: 'Refeitório da escola',
  },
  planilha: [
    { iniciais: 'A.S.L.', sexo: 'F', idade: '9A', dia: 1, hospitalizado: false },
    { iniciais: 'B.R.O.', sexo: 'M', idade: '10A', dia: 1, hospitalizado: true },
    { iniciais: 'C.M.P.', sexo: 'F', idade: '8A', dia: 1, hospitalizado: false },
    { iniciais: 'D.F.A.', sexo: 'M', idade: '9A', dia: 2, hospitalizado: false },
    { iniciais: 'E.C.N.', sexo: 'F', idade: '34A', dia: 1, hospitalizado: false },
    { iniciais: 'F.G.T.', sexo: 'M', idade: '11A', dia: 2, hospitalizado: true },
  ],
} as const;

/** Nomes sintéticos dos pacientes dos registros oficiais da demonstração (nenhuma pessoa real). */
export const NOMES_SINTETICOS = {
  femininos: ['Ana', 'Bruna', 'Camila', 'Débora', 'Eliane', 'Flávia', 'Gisele', 'Helena', 'Isabela', 'Jéssica', 'Larissa', 'Mirela', 'Natália', 'Olívia', 'Priscila', 'Renata'],
  masculinos: ['André', 'Bernardo', 'César', 'Davi', 'Emerson', 'Felipe', 'Gustavo', 'Henrique', 'Igor', 'Jonas', 'Leandro', 'Murilo', 'Nilton', 'Otávio', 'Rodrigo', 'Sérgio'],
  sobrenomes: ['Abreu', 'Bastos', 'Correia', 'Duarte', 'Esteves', 'Fontes', 'Guimarães', 'Leal', 'Macedo', 'Neves', 'Paiva', 'Quintana', 'Rocha', 'Saraiva', 'Tavares', 'Valadares'],
  /** Bairros dos registros: os três primeiros casam com o bairro Centro da malha (nome e apelidos); os abreviados pedem apelido. */
  bairros: ['CENTRO', 'VILA NOVA', 'JARDIM DAS FLORES', 'JD DAS FLORES', 'VL NOVA', 'PARQUE INDUSTRIAL', 'SAO JOSE', 'BELA VISTA', 'JARDIM AMERICA', 'VILA SANTA RITA'],
};

/**
 * Casos graves e com sinais de alarme de dengue no ano em análise (até a última semana completa): menos de 1% dos
 * prováveis, para a sugestão não subir para ALERTA pelo percentual de graves (modelo do MS, Apêndice B).
 */
export function gravesDemo(provaveis: number): { graves: number; sinaisAlarme: number } {
  const total = Math.floor(Math.max(0, provaveis) * 0.008);
  const graves = Math.floor(total / 3);
  return { graves, sinaisAlarme: total - graves };
}
