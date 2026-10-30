/**
 * Guia de linhas de cuidado: a partir do diagnóstico (CID-10 ou CIAP-2) sugere o protocolo do
 * Ministério da Saúde e os exames correspondentes na SIGTAP. SEMENTE DE DESENVOLVIMENTO: os
 * códigos SIGTAP devem ser conciliados com a tabela carregada pela sincronização mensal do
 * faturamento antes do uso, e as recomendações revisadas pela coordenação clínica.
 */

export type CodeSystem = 'CID10' | 'CIAP2';

export interface SigtapExam {
  /** Formato 02.02.01.031-0 */
  sigtapCode: string;
  name: string;
}

export interface CarePathwayProtocol {
  id: string;
  title: string;
  source: string;
  recommendations: string[];
}

export interface CarePathwaySuggestion {
  protocol: CarePathwayProtocol;
  exams: SigtapExam[];
  /** Código que casou, normalizado (ex.: "E11"). */
  matchedCode: string;
  system: CodeSystem;
}

export const SIGTAP_EXAMS = {
  CREATININA: { sigtapCode: '02.02.01.031-0', name: 'Dosagem de creatinina' },
  POTASSIO: { sigtapCode: '02.02.01.060-0', name: 'Dosagem de potássio' },
  GLICOSE: { sigtapCode: '02.02.01.047-3', name: 'Dosagem de glicose' },
  COLESTEROL_TOTAL: { sigtapCode: '02.02.01.029-5', name: 'Dosagem de colesterol total' },
  HDL: { sigtapCode: '02.02.01.027-9', name: 'Dosagem de colesterol HDL' },
  LDL: { sigtapCode: '02.02.01.028-7', name: 'Dosagem de colesterol LDL' },
  TRIGLICERIDEOS: { sigtapCode: '02.02.01.067-7', name: 'Dosagem de triglicerídeos' },
  EAS: { sigtapCode: '02.02.05.001-7', name: 'Análise de caracteres físicos, elementos e sedimento da urina (EAS)' },
  ECG: { sigtapCode: '02.11.02.003-6', name: 'Eletrocardiograma' },
  HBA1C: { sigtapCode: '02.02.01.050-3', name: 'Dosagem de hemoglobina glicosilada' },
  UREIA: { sigtapCode: '02.02.01.069-3', name: 'Dosagem de ureia' },
  HEMOGRAMA: { sigtapCode: '02.02.02.038-0', name: 'Hemograma completo' },
} as const satisfies Record<string, SigtapExam>;

const E = SIGTAP_EXAMS;

interface PathwayEntry {
  protocol: CarePathwayProtocol;
  exams: SigtapExam[];
  cid10: string[]; // prefixos sem ponto
  ciap2: string[];
}

const PATHWAYS: PathwayEntry[] = [
  {
    cid10: ['I10', 'I11', 'I12', 'I13', 'I15'],
    ciap2: ['K86', 'K87'],
    protocol: {
      id: 'HAS',
      title: 'Hipertensão arterial sistêmica',
      source: 'Ministério da Saúde. Caderno de Atenção Básica nº 37 — Estratégias para o cuidado da pessoa com doença crônica: hipertensão arterial sistêmica (2013); Linha de Cuidado do Adulto com HAS.',
      recommendations: [
        'Aferir a pressão arterial em todas as consultas e registrar a média de duas medidas.',
        'Estratificar o risco cardiovascular (escore de Framingham) e definir a periodicidade das consultas.',
        'Orientar mudanças de estilo de vida: redução do sal (< 5 g/dia), atividade física, controle do peso, cessação do tabagismo e do álcool.',
        'Meta usual < 140/90 mmHg; mais estrita em alto risco cardiovascular, conforme avaliação clínica.',
        'Repetir os exames de rotina anualmente ou conforme a evolução.',
      ],
    },
    exams: [E.CREATININA, E.POTASSIO, E.GLICOSE, E.COLESTEROL_TOTAL, E.HDL, E.TRIGLICERIDEOS, E.EAS, E.ECG],
  },
  {
    cid10: ['E11', 'E14'],
    ciap2: ['T90'],
    protocol: {
      id: 'DM2',
      title: 'Diabetes mellitus tipo 2',
      source: 'Ministério da Saúde. Caderno de Atenção Básica nº 36 — Estratégias para o cuidado da pessoa com doença crônica: diabetes mellitus (2013).',
      recommendations: [
        'Meta de hemoglobina glicada < 7% para a maioria dos adultos, individualizada para idosos e pessoas com comorbidades.',
        'Hemoglobina glicada a cada 6 meses quando na meta; a cada 3 meses após mudança de tratamento ou fora da meta.',
        'Exame dos pés com estratificação de risco ao menos uma vez ao ano.',
        'Avaliação de retinopatia (fundo de olho) anual e rastreio de doença renal (creatinina e albuminúria).',
        'Metformina como primeira escolha, salvo contraindicação (ver função renal).',
      ],
    },
    exams: [E.GLICOSE, E.HBA1C, E.COLESTEROL_TOTAL, E.HDL, E.TRIGLICERIDEOS, E.CREATININA, E.EAS, E.ECG],
  },
  {
    cid10: ['E10'],
    ciap2: ['T89'],
    protocol: {
      id: 'DM1',
      title: 'Diabetes mellitus tipo 1',
      source: 'Ministério da Saúde. Protocolo Clínico e Diretrizes Terapêuticas do Diabetes Mellitus Tipo 1 (Portaria Conjunta SAES/SCTIE).',
      recommendations: [
        'Acompanhamento compartilhado com a atenção especializada.',
        'Insulinoterapia basal-bolus, automonitorização da glicemia capilar e educação em diabetes.',
        'Hemoglobina glicada a cada 3 meses; rastrear complicações micro e macrovasculares.',
        'Orientar reconhecimento e manejo de hipoglicemia.',
      ],
    },
    exams: [E.GLICOSE, E.HBA1C, E.CREATININA, E.COLESTEROL_TOTAL, E.HDL, E.TRIGLICERIDEOS, E.EAS],
  },
  {
    cid10: ['Z34', 'Z35', 'Z33'],
    ciap2: ['W78', 'W84'],
    protocol: {
      id: 'PRE-NATAL',
      title: 'Pré-natal',
      source: 'Ministério da Saúde. Caderno de Atenção Básica nº 32 — Atenção ao pré-natal de baixo risco (2012).',
      recommendations: [
        'Mínimo de seis consultas, iniciando no primeiro trimestre, alternando médico e enfermeiro.',
        'Solicitar na primeira consulta: hemograma, glicemia de jejum, urina (EAS) e urocultura, tipagem sanguínea e fator Rh, testes rápidos/sorologias para HIV, sífilis e hepatites B e C, toxoplasmose (códigos ainda não vinculados nesta semente: conciliar com a SIGTAP carregada).',
        'Suplementação de ácido fólico e sulfato ferroso conforme protocolo.',
        'Atualizar a vacinação (dTpa, hepatite B, influenza) e classificar o risco gestacional a cada consulta.',
      ],
    },
    exams: [E.HEMOGRAMA, E.GLICOSE, E.EAS],
  },
  {
    cid10: ['O24'],
    ciap2: [],
    protocol: {
      id: 'DMG',
      title: 'Diabetes na gestação',
      source: 'Ministério da Saúde/OPAS/FEBRASGO/SBD. Cuidados obstétricos em diabetes mellitus gestacional no Brasil (2021); Caderno de Atenção Básica nº 32.',
      recommendations: [
        'Encaminhar ao pré-natal de alto risco, mantendo o vínculo com a atenção primária.',
        'Orientação nutricional e atividade física; automonitorização da glicemia capilar.',
        'Insulina quando as metas glicêmicas não forem atingidas com medidas não farmacológicas.',
      ],
    },
    exams: [E.GLICOSE, E.HEMOGRAMA, E.EAS],
  },
  {
    cid10: ['J45', 'J46'],
    ciap2: ['R96'],
    protocol: {
      id: 'ASMA',
      title: 'Asma',
      source: 'Ministério da Saúde. Protocolo Clínico e Diretrizes Terapêuticas da Asma (Portaria Conjunta SAES/SCTIE nº 14/2021).',
      recommendations: [
        'Classificar o nível de controle dos sintomas em cada consulta.',
        'Revisar a técnica inalatória e a adesão antes de escalonar o tratamento.',
        'Entregar plano de ação escrito para crises.',
        'Espirometria para confirmação diagnóstica e seguimento (código SIGTAP a vincular).',
      ],
    },
    exams: [],
  },
];

export function normalizeDiagnosisCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Sugere a linha de cuidado para um diagnóstico. O sistema de códigos precisa ser informado:
 * "K86" é hipertensão no CIAP-2, mas doença do pâncreas na CID-10.
 */
export function suggestCarePathway(code: string, system: CodeSystem = 'CID10'): CarePathwaySuggestion | null {
  const normalized = normalizeDiagnosisCode(code);
  if (!normalized) return null;
  for (const entry of PATHWAYS) {
    const prefixes = system === 'CID10' ? entry.cid10 : entry.ciap2;
    const hit = system === 'CID10' ? prefixes.find((p) => normalized.startsWith(p)) : prefixes.find((p) => normalized === p);
    if (hit) return { protocol: entry.protocol, exams: [...entry.exams], matchedCode: hit, system };
  }
  return null;
}

export function listCarePathways(): CarePathwayProtocol[] {
  return PATHWAYS.map((p) => p.protocol);
}
