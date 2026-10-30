/**
 * Identificadores da RNDS (Rede Nacional de Dados em Saúde) usados nos documentos FHIR.
 *
 * ATENÇÃO: nomes e versões de perfis (StructureDefinition), sistemas de código e códigos de tipo de documento
 * mudam entre versões do Guia de Implementação da RNDS. Confirme cada valor abaixo no guia vigente
 * (https://rnds-guia.saude.gov.br) e no ambiente de homologação antes de enviar dados reais.
 * Todos os valores estão concentrados neste arquivo de propósito.
 */

export const RNDS_BASE = 'https://saude.gov.br/fhir/r4';

export const NAMING_SYSTEMS = {
  cpf: `${RNDS_BASE}/NamingSystem/cpf`,
  cns: `${RNDS_BASE}/NamingSystem/cns`,
  cnes: `${RNDS_BASE}/NamingSystem/cnes`,
} as const;

/** Bundle.identifier.system = prefixo + identificador do solicitante credenciado na RNDS. */
export const BUNDLE_IDENTIFIER_PREFIX = 'http://www.saude.gov.br/fhir/r4/NamingSystem/BRRNDS-';

export const CODE_SYSTEMS = {
  cid10: `${RNDS_BASE}/CodeSystem/BRCID10`,
  ciap2: `${RNDS_BASE}/CodeSystem/BRCIAP2`,
  sigtap: `${RNDS_BASE}/CodeSystem/BRTabelaSUS`,
  cbo: `${RNDS_BASE}/CodeSystem/BRCBO`,
  imunobiologico: `${RNDS_BASE}/CodeSystem/BRImunobiologico`,
  fabricante: `${RNDS_BASE}/CodeSystem/BRFabricantePNI`,
  dose: `${RNDS_BASE}/CodeSystem/BRDose`,
  viaAdministracao: `${RNDS_BASE}/CodeSystem/BRViaAdministracao`,
  localAplicacao: `${RNDS_BASE}/CodeSystem/BRLocalAnatomico`,
  catmat: `${RNDS_BASE}/CodeSystem/BRCATMAT`,
  tipoDocumento: `${RNDS_BASE}/CodeSystem/BRTipoDocumento`,
  nivelAtencao: `${RNDS_BASE}/CodeSystem/BRNivelAtencao`,
  loinc: 'http://loinc.org',
  ucum: 'http://unitsofmeasure.org',
  observationCategory: 'http://terminology.hl7.org/CodeSystem/observation-category',
  conditionCategory: 'http://terminology.hl7.org/CodeSystem/condition-category',
  conditionClinical: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
  actCode: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  roleCode: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode',
  diagnosisRole: 'http://terminology.hl7.org/CodeSystem/diagnosis-role',
  dischargeDisposition: 'http://terminology.hl7.org/CodeSystem/discharge-disposition',
} as const;

const sd = (name: string) => `${RNDS_BASE}/StructureDefinition/${name}`;

export const PROFILES = {
  racComposition: sd('BRRegistroAtendimentoClinico-3.2'),
  racEncounter: sd('BRContatoAssistencial-3.2'),
  problem: sd('BRProblemaDiagnosticoAvaliado-1.0'),
  procedure: sd('BRProcedimentoRealizado-2.0'),
  vitalSign: sd('BRSinaisVitais-1.0'),
  practitionerRole: sd('BRLotacaoProfissional-1.0'),
  immunizationComposition: sd('BRRegistroImunobiologicoAdministrado-2.0'),
  immunization: sd('BRImunobiologicoAdministrado-2.0'),
  dispensationComposition: sd('BRRegistroDispensacaoMedicamento-1.0'),
  dispensation: sd('BRDispensacaoMedicamento-1.0'),
  medication: sd('BRMedicamento-1.0'),
  dischargeComposition: sd('BRSumarioAlta-1.0'),
  dischargeEncounter: sd('BRInternacao-1.0'),
  dischargeMedication: sd('BRPrescricaoAlta-1.0'),
} as const;

/** Códigos de BRTipoDocumento usados em Composition.type. */
export const DOCUMENT_TYPES = {
  rac: { code: 'RAC', display: 'Registro de Atendimento Clínico' },
  immunization: { code: 'RIA', display: 'Registro de Imunobiológico Administrado' },
  dispensation: { code: 'RDM', display: 'Registro de Dispensação de Medicamento' },
  discharge: { code: 'SA', display: 'Sumário de Alta' },
} as const;

export const LOINC = {
  bloodPressurePanel: { code: '85354-9', display: 'Blood pressure panel with all children optional' },
  systolic: { code: '8480-6', display: 'Systolic blood pressure', unit: 'mm[Hg]' },
  diastolic: { code: '8462-4', display: 'Diastolic blood pressure', unit: 'mm[Hg]' },
  heartRate: { code: '8867-4', display: 'Heart rate', unit: '/min' },
  respiratoryRate: { code: '9279-1', display: 'Respiratory rate', unit: '/min' },
  temperature: { code: '8310-5', display: 'Body temperature', unit: 'Cel' },
  spo2: { code: '59408-5', display: 'Oxygen saturation in Arterial blood by Pulse oximetry', unit: '%' },
  glucose: { code: '2339-0', display: 'Glucose [Mass/volume] in Blood', unit: 'mg/dL' },
  weight: { code: '29463-7', display: 'Body weight', unit: 'kg' },
  height: { code: '8302-2', display: 'Body height', unit: 'cm' },
  painScore: { code: '72514-3', display: 'Pain severity - 0-10 verbal numeric rating [Score] - Reported', unit: '{score}' },
} as const;
