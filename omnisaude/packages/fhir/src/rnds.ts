/**
 * Identificadores da RNDS (Rede Nacional de Dados em Saúde) usados nos documentos FHIR.
 *
 * ATENÇÃO: nomes e versões de perfis (StructureDefinition), sistemas de código e códigos de tipo de documento
 * mudam entre versões do Guia de Implementação da RNDS. Confirme cada valor abaixo no guia vigente
 * (https://rnds-guia.saude.gov.br) e no ambiente de homologação antes de enviar dados reais.
 * Todos os valores estão concentrados neste arquivo de propósito.
 */

/** Base canônica dos perfis, sistemas de código e conjuntos de valores da RNDS (pacote oficial no Simplifier). */
export const RNDS_BASE = 'http://www.saude.gov.br/fhir/r4';

/** NamingSystems usados nas buscas e identificadores (conforme a coleção oficial de requisições da RNDS). */
export const NAMING_SYSTEMS = {
  cpf: 'http://rnds.saude.gov.br/fhir/r4/NamingSystem/cpf',
  cns: 'http://rnds.saude.gov.br/fhir/r4/NamingSystem/cns',
  cnes: 'http://rnds.saude.gov.br/fhir/r4/NamingSystem/cnes',
} as const;

export type RndsEnvironment = 'homologacao' | 'producao';

/**
 * Endereços da RNDS: autenticação única nacional; na produção, o EHR é por UF (ex.: to-ehr-services.saude.gov.br).
 * Na homologação, um único EHR nacional.
 */
export function rndsEndpoints(environment: RndsEnvironment, uf?: string): { authUrl: string; ehrUrl: string } {
  if (environment === 'homologacao') return { authUrl: 'https://ehr-auth-hmg.saude.gov.br', ehrUrl: 'https://ehr-services.hmg.saude.gov.br' };
  const state = (uf ?? '').trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(state)) throw new Error('Informe a UF do estabelecimento para o ambiente de produção da RNDS');
  return { authUrl: 'https://ehr-auth.saude.gov.br', ehrUrl: `https://${state}-ehr-services.saude.gov.br` };
}

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

/**
 * Perfis conferidos com o pacote oficial da RNDS (br.ufg.cgis.rnds-lite 0.5.0, espelho do projeto
 * "Rede Nacional de Dados em Saúde" no Simplifier): RAC, contato assistencial, problema/diagnóstico,
 * procedimento, medida observada, lotação e medicamento. Imunização, dispensação e sumário de alta não
 * constam do pacote público e ficam com os nomes do guia anterior até a homologação.
 */
export const PROFILES = {
  racComposition: sd('BRRegistroAtendimentoClinico'),
  racEncounter: sd('BRContatoAssistencial-1.0'),
  problem: sd('BRProblemaDiagnostico'),
  procedure: sd('BRProcedimentoRealizado-1.0'),
  vitalSign: sd('BRMedidaObservada'),
  practitionerRole: sd('BRLotacaoProfissional-1.0'),
  immunizationComposition: sd('BRRegistroImunobiologicoAdministrado-2.0'),
  immunization: sd('BRImunobiologicoAdministrado-2.0'),
  dispensationComposition: sd('BRRegistroDispensacaoMedicamento-1.0'),
  dispensation: sd('BRDispensacaoMedicamento-1.0'),
  medication: sd('BRMedicamento'),
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
