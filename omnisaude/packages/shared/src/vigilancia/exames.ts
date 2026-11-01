/**
 * Exames de interesse da vigilância: o resultado positivo confirma (ou abre) a notificação do agravo, com o prazo
 * do item que se notifica na confirmação contado do resultado; covid-19 e mpox vão também à RNDS (REL), positivos,
 * negativos ou inconclusivos (Anexo V da PRC GM/MS nº 4/2017, arts. 22 a 26).
 */
export type ResultadoQualitativo = 'DETECTAVEL' | 'NAO_DETECTAVEL' | 'INCONCLUSIVO' | 'REAGENTE' | 'NAO_REAGENTE' | 'INDETERMINADO';

export const RESULTADO_LABEL: Record<ResultadoQualitativo, string> = {
  DETECTAVEL: 'Detectável',
  NAO_DETECTAVEL: 'Não detectável',
  INCONCLUSIVO: 'Inconclusivo',
  REAGENTE: 'Reagente',
  NAO_REAGENTE: 'Não reagente',
  INDETERMINADO: 'Indeterminado',
};

export const POSITIVO: ResultadoQualitativo[] = ['DETECTAVEL', 'REAGENTE'];

export type TecnicaExame = 'MOLECULAR' | 'ANTIGENO' | 'SOROLOGIA';

export const RESULTADOS_DA_TECNICA: Record<TecnicaExame, ResultadoQualitativo[]> = {
  MOLECULAR: ['DETECTAVEL', 'NAO_DETECTAVEL', 'INCONCLUSIVO'],
  ANTIGENO: ['REAGENTE', 'NAO_REAGENTE', 'INDETERMINADO'],
  SOROLOGIA: ['REAGENTE', 'NAO_REAGENTE', 'INDETERMINADO'],
};

export interface ExameVigilancia {
  key: string;
  nome: string;
  /** Grupo do agravo na lista (catálogo da LNNC). */
  grupo: string;
  /** CID-10 que a notificação aberta pelo resultado registra. */
  cid: string;
  tecnica: TecnicaExame;
  amostra: string;
  /** Vai à RNDS no modelo REL (covid-19 e mpox). */
  rel: boolean;
  /** Dados do REL 3.2.1 (conferidos no pacote da RNDS no Simplifier, CodeSystems BRNomeExameLOINC e afins). */
  relInfo?: {
    loinc: string;
    loincDisplay: string;
    tipoResultado: 'DTNT' | 'RGNR';
    /** BRSubgrupoTabelaSUS: 0214 teste rápido (exemplo do guia); 0202 laboratório clínico (escolha nossa para PCR). */
    categoria: '0214' | '0202';
    amostraGal: { code: string; display: string };
    patogeno: { code: string; display: string };
    suspeita: { code: 'B342' | 'B04'; display: string };
  };
}

export const EXAMES_VIGILANCIA: ExameVigilancia[] = [
  {
    key: 'covid-rtpcr',
    nome: 'SARS-CoV-2 (covid-19), RT-PCR',
    grupo: 'covid',
    cid: 'U071',
    tecnica: 'MOLECULAR',
    amostra: 'Swab nasofaríngeo',
    rel: true,
    relInfo: {
      loinc: '94759-8',
      loincDisplay: 'SARS Coronavírus 2 [Presença de] RNA em Nasofaringe por Amplificação de ácido nucleico com detecção por sonda',
      tipoResultado: 'DTNT',
      categoria: '0202',
      amostraGal: { code: 'SWNAFA', display: 'Swab Nasofaríngeo' },
      patogeno: { code: '07', display: 'SARS-CoV-2' },
      suspeita: { code: 'B342', display: 'Infecção por coronavírus de localização não especificada' },
    },
  },
  {
    key: 'covid-antigeno',
    nome: 'SARS-CoV-2 (covid-19), teste rápido de antígeno',
    grupo: 'covid',
    cid: 'U071',
    tecnica: 'ANTIGENO',
    amostra: 'Swab nasofaríngeo',
    rel: true,
    relInfo: {
      loinc: '94558-4',
      loincDisplay: 'SARS Coronavírus 2, [presença de] antígenos Ag em amostra respiratória por imunoensaio rápido',
      tipoResultado: 'RGNR',
      categoria: '0214',
      amostraGal: { code: 'SWNAFA', display: 'Swab Nasofaríngeo' },
      patogeno: { code: '07', display: 'SARS-CoV-2' },
      suspeita: { code: 'B342', display: 'Infecção por coronavírus de localização não especificada' },
    },
  },
  {
    key: 'mpox-pcr',
    nome: 'Monkeypox vírus (mpox), PCR',
    grupo: 'mpox',
    cid: 'B04',
    tecnica: 'MOLECULAR',
    amostra: 'Swab de lesão',
    rel: true,
    relInfo: {
      loinc: '100383-9',
      loincDisplay: 'Vírus Monkeypox DNA [Presença de] em Amostra por Amplificação de Ácido Nucleico com detecção por sonda',
      tipoResultado: 'DTNT',
      categoria: '0202',
      amostraGal: { code: 'SWLES', display: 'Swab de lesão' },
      patogeno: { code: '03', display: 'Vírus Monkeypox' },
      suspeita: { code: 'B04', display: 'Varíola dos macacos [Monkeypox]' },
    },
  },
  { key: 'dengue-ns1', nome: 'Dengue, antígeno NS1', grupo: 'dengue', cid: 'A90', tecnica: 'ANTIGENO', amostra: 'Soro', rel: false },
  { key: 'dengue-igm', nome: 'Dengue, sorologia IgM', grupo: 'dengue', cid: 'A90', tecnica: 'SOROLOGIA', amostra: 'Soro', rel: false },
  { key: 'dengue-rtpcr', nome: 'Dengue, RT-PCR', grupo: 'dengue', cid: 'A90', tecnica: 'MOLECULAR', amostra: 'Soro', rel: false },
  { key: 'chik-igm', nome: 'Chikungunya, sorologia IgM', grupo: 'chikungunya', cid: 'A920', tecnica: 'SOROLOGIA', amostra: 'Soro', rel: false },
  { key: 'chik-rtpcr', nome: 'Chikungunya, RT-PCR', grupo: 'chikungunya', cid: 'A920', tecnica: 'MOLECULAR', amostra: 'Soro', rel: false },
  { key: 'zika-rtpcr', nome: 'Zika, RT-PCR', grupo: 'zika', cid: 'A928', tecnica: 'MOLECULAR', amostra: 'Soro ou urina', rel: false },
  { key: 'oropouche-rtpcr', nome: 'Oropouche, RT-qPCR', grupo: 'oropouche', cid: 'A930', tecnica: 'MOLECULAR', amostra: 'Soro', rel: false },
];

export const exameVigilancia = (key: string | null | undefined) => (key ? (EXAMES_VIGILANCIA.find((e) => e.key === key) ?? null) : null);

/** Código do resultado no REL: DTNT (1 detectável, 2 não detectável, 3 indeterminado) ou RGNR (1 reagente, 2 não reagente, 3 indeterminado). */
export function resultadoRel(r: ResultadoQualitativo): { code: '1' | '2' | '3'; display: string } {
  const mapa: Record<ResultadoQualitativo, { code: '1' | '2' | '3'; display: string }> = {
    DETECTAVEL: { code: '1', display: 'Detectável' },
    NAO_DETECTAVEL: { code: '2', display: 'Não Detectável' },
    INCONCLUSIVO: { code: '3', display: 'Indeterminado' },
    REAGENTE: { code: '1', display: 'Reagente' },
    NAO_REAGENTE: { code: '2', display: 'Não Reagente' },
    INDETERMINADO: { code: '3', display: 'Indeterminado' },
  };
  return mapa[r];
}
