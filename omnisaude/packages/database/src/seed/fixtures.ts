import { cnsFromBase, completeCpf, gtinCheckDigit } from '@omnisaude/shared';

/**
 * Dados fictícios de demonstração. CNES iniciados por 9, CPFs e CNS gerados com dígitos válidos
 * e GTINs com prefixo 789 inventados: nada aqui corresponde a pessoas, unidades ou produtos reais.
 */

export const DEMO_PASSWORD = 'OmniSaude2026';

export const DEMO_TENANT = {
  slug: 'demo',
  name: 'Consórcio Intermunicipal de Saúde Vale Verde (demonstração)',
  kind: 'CONSORCIO' as const,
  cnpj: '00000000000191',
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
] as const;
export type UnitKey = (typeof UNITS)[number]['key'];

type RoleName = 'RECEPCAO' | 'ENFERMAGEM' | 'MEDICO' | 'MULTIPROFISSIONAL' | 'SERVICO_SOCIAL' | 'NIR' | 'FARMACIA' | 'FATURAMENTO' | 'GESTOR';

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
    assignments: [{ unit: 'hosp', role: 'NIR', cbo: '223505' }],
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
    content:
      'Medicamentos potencialmente perigosos (anticoagulantes, insulinas, opioides, eletrólitos concentrados) exigem conferência independente por um segundo profissional antes da administração.',
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
