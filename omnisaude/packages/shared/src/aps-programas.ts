import type { CodigoIndicador, ComponenteVacinal } from './aps-indicadores';

/**
 * Programas da Atenção Primária (ações programáticas por ciclo de vida e condição) e instrumentos de
 * estratificação de risco. Cada programa tem a população, as ações esperadas com periodicidade, a linha
 * de busca ativa em que o faltoso é acompanhado e o indicador do cofinanciamento que alimenta.
 */

export type CodigoPrograma = 'PRE_NATAL' | 'PUERICULTURA' | 'HAS_DM' | 'IDOSO' | 'MULHER' | 'BOLSA_FAMILIA' | 'SISVAN' | 'TB_HANSENIASE';
export type LinhaBuscaAtiva = 'HIPERTENSAO' | 'DIABETES' | 'GESTANTE' | 'ONCOLOGIA' | 'SAUDE_MENTAL' | 'TUBERCULOSE' | 'HANSENIASE' | 'CRIANCA' | 'IDOSO' | 'MULHER' | 'BOLSA_FAMILIA' | 'SISVAN';

export const LINHAS_BUSCA_ATIVA: LinhaBuscaAtiva[] = ['HIPERTENSAO', 'DIABETES', 'GESTANTE', 'ONCOLOGIA', 'SAUDE_MENTAL', 'TUBERCULOSE', 'HANSENIASE', 'CRIANCA', 'IDOSO', 'MULHER', 'BOLSA_FAMILIA', 'SISVAN'];
export const LINHA_BUSCA_ATIVA_LABEL: Record<LinhaBuscaAtiva, string> = {
  HIPERTENSAO: 'Hipertensão',
  DIABETES: 'Diabetes',
  GESTANTE: 'Gestante',
  ONCOLOGIA: 'Oncologia',
  SAUDE_MENTAL: 'Saúde mental',
  TUBERCULOSE: 'Tuberculose',
  HANSENIASE: 'Hanseníase',
  CRIANCA: 'Criança (puericultura)',
  IDOSO: 'Pessoa idosa',
  MULHER: 'Saúde da mulher',
  BOLSA_FAMILIA: 'Bolsa Família',
  SISVAN: 'Vigilância alimentar (SISVAN)',
};

export interface AcaoProgramatica {
  codigo: string;
  descricao: string;
  periodicidade: string;
}

export interface ProgramaAps {
  codigo: CodigoPrograma;
  titulo: string;
  descricao: string;
  populacao: string;
  acoes: AcaoProgramatica[];
  /** Indicadores do componente de qualidade alimentados pelo programa. */
  indicadores: CodigoIndicador[];
  linhasBuscaAtiva: LinhaBuscaAtiva[];
  /** Instrumentos de estratificação aplicáveis. */
  estratificacoes: TipoEstratificacao[];
  referencias: string[];
}

export type TipoEstratificacao = 'GESTANTE' | 'PE_DIABETICO' | 'MCHAT';

export const PROGRAMAS_APS: ProgramaAps[] = [
  {
    codigo: 'PRE_NATAL',
    titulo: 'Pré-natal e puerpério',
    descricao: 'Captação precoce, consultas por idade gestacional, exames por trimestre, vacinas, saúde bucal, estratificação de risco e consulta puerperal.',
    populacao: 'Gestantes (condição ativa de gestação, com a DUM no início da condição) e puérperas até 42 dias do desfecho.',
    acoes: [
      { codigo: 'CAPTACAO', descricao: '1ª consulta até a 12ª semana', periodicidade: 'uma vez' },
      { codigo: 'CONSULTA', descricao: 'Consulta de pré-natal', periodicidade: 'mensal até 28 semanas, quinzenal até 36, semanal até o parto' },
      { codigo: 'RISCO', descricao: 'Classificação de risco gestacional', periodicidade: 'na 1ª consulta e quando mudar' },
      { codigo: 'EXAMES_T1', descricao: 'Sífilis, HIV, hepatites B e C', periodicidade: '1º trimestre' },
      { codigo: 'EXAMES_T3', descricao: 'Sífilis e HIV', periodicidade: '3º trimestre' },
      { codigo: 'DTPA', descricao: 'Vacina dTpa', periodicidade: 'a partir da 20ª semana' },
      { codigo: 'ODONTO', descricao: 'Atendimento odontológico', periodicidade: 'pelo menos um na gestação' },
      { codigo: 'PUERPERIO', descricao: 'Consulta puerperal', periodicidade: 'até 42 dias após o parto' },
    ],
    indicadores: ['C3'],
    linhasBuscaAtiva: ['GESTANTE'],
    estratificacoes: ['GESTANTE'],
    referencias: ['Caderno de Atenção Básica nº 32 (Pré-natal de baixo risco)', 'Manual de Gestação de Alto Risco (MS, 2022)', 'Nota metodológica C3'],
  },
  {
    codigo: 'PUERICULTURA',
    titulo: 'Puericultura',
    descricao: 'Consultas de crescimento e desenvolvimento, antropometria, vacinas do calendário e triagem do desenvolvimento (M-CHAT-R).',
    populacao: 'Crianças até 2 anos vinculadas à unidade (as consultas seguem até os 5 anos na Caderneta).',
    acoes: [
      { codigo: 'CONSULTA', descricao: 'Consulta de puericultura', periodicidade: '1ª semana, 1, 2, 4, 6, 9, 12, 18 e 24 meses' },
      { codigo: 'ANTROPOMETRIA', descricao: 'Peso e altura', periodicidade: 'em toda consulta' },
      { codigo: 'VACINAS', descricao: 'Calendário nacional de vacinação', periodicidade: 'por idade' },
      { codigo: 'MCHAT', descricao: 'M-CHAT-R (triagem do autismo)', periodicidade: 'entre 16 e 30 meses' },
    ],
    indicadores: ['C2'],
    linhasBuscaAtiva: ['CRIANCA'],
    estratificacoes: ['MCHAT'],
    referencias: ['Caderneta da Criança (MS, 2024)', 'Calendário Nacional de Vacinação', 'Nota metodológica C2'],
  },
  {
    codigo: 'HAS_DM',
    titulo: 'Hipertensão e diabetes',
    descricao: 'Consultas semestrais, pressão arterial, antropometria, hemoglobina glicada e avaliação dos pés com estratificação do risco de ulceração.',
    populacao: 'Pessoas com condição ativa de hipertensão ou diabetes.',
    acoes: [
      { codigo: 'CONSULTA', descricao: 'Consulta médica ou de enfermagem', periodicidade: 'a cada 6 meses' },
      { codigo: 'PA', descricao: 'Aferição da pressão arterial', periodicidade: 'a cada 6 meses' },
      { codigo: 'ANTROPOMETRIA', descricao: 'Peso e altura', periodicidade: 'anual' },
      { codigo: 'HBA1C', descricao: 'Hemoglobina glicada (diabetes)', periodicidade: 'anual' },
      { codigo: 'PE', descricao: 'Avaliação e estratificação do pé diabético', periodicidade: 'anual ou conforme o grau de risco' },
    ],
    indicadores: ['C4', 'C5'],
    linhasBuscaAtiva: ['HIPERTENSAO', 'DIABETES'],
    estratificacoes: ['PE_DIABETICO'],
    referencias: ['Cadernos de Atenção Básica nº 36 e 37', 'Manual do pé diabético (MS, 2016)', 'Notas metodológicas C4 e C5'],
  },
  {
    codigo: 'IDOSO',
    titulo: 'Pessoa idosa',
    descricao: 'Consulta anual, antropometria e vacina contra influenza.',
    populacao: 'Pessoas com 60 anos ou mais.',
    acoes: [
      { codigo: 'CONSULTA', descricao: 'Consulta médica ou de enfermagem', periodicidade: 'anual' },
      { codigo: 'ANTROPOMETRIA', descricao: 'Peso e altura', periodicidade: 'anual' },
      { codigo: 'INFLUENZA', descricao: 'Vacina contra influenza', periodicidade: 'anual' },
    ],
    indicadores: ['C6'],
    linhasBuscaAtiva: ['IDOSO'],
    estratificacoes: [],
    referencias: ['Caderneta de Saúde da Pessoa Idosa', 'Nota metodológica C6'],
  },
  {
    codigo: 'MULHER',
    titulo: 'Preventivo e mamografia',
    descricao: 'Rastreamento do câncer do colo do útero e de mama, vacina HPV e atenção à saúde sexual e reprodutiva.',
    populacao: 'Pessoas do sexo feminino de 9 a 69 anos.',
    acoes: [
      { codigo: 'CITO', descricao: 'Citopatológico (25 a 64 anos)', periodicidade: 'a cada 3 anos (teste molecular de HPV: 5 anos)' },
      { codigo: 'MAMO', descricao: 'Mamografia (50 a 69 anos)', periodicidade: 'a cada 2 anos' },
      { codigo: 'HPV', descricao: 'Vacina HPV (9 a 14 anos)', periodicidade: 'dose única' },
      { codigo: 'SSR', descricao: 'Atendimento de saúde sexual e reprodutiva (14 a 69 anos)', periodicidade: 'anual' },
    ],
    indicadores: ['C7'],
    linhasBuscaAtiva: ['MULHER'],
    estratificacoes: [],
    referencias: ['Diretrizes para o rastreamento do câncer do colo do útero (INCA)', 'Nota metodológica C7'],
  },
  {
    codigo: 'BOLSA_FAMILIA',
    titulo: 'Bolsa Família',
    descricao: 'Condicionalidades de saúde: acompanhamento do crescimento das crianças, vacinação, pré-natal e acompanhamento nutricional das mulheres.',
    populacao: 'Beneficiários marcados no cadastro: crianças até 7 anos, gestantes e mulheres de 14 a 44 anos.',
    acoes: [
      { codigo: 'ANTROPOMETRIA', descricao: 'Peso e altura na vigência', periodicidade: 'a cada semestre (jan–jun, jul–dez)' },
      { codigo: 'VACINAS', descricao: 'Vacinação em dia (crianças)', periodicidade: 'por idade' },
      { codigo: 'PRE_NATAL', descricao: 'Pré-natal (gestantes)', periodicidade: 'conforme o programa' },
    ],
    indicadores: [],
    linhasBuscaAtiva: ['BOLSA_FAMILIA'],
    estratificacoes: [],
    referencias: ['Portaria Interministerial MDS/MS nº 2.509/2007 (condicionalidades de saúde)'],
  },
  {
    codigo: 'SISVAN',
    titulo: 'Vigilância alimentar e nutricional (SISVAN)',
    descricao: 'Antropometria periódica e classificação do estado nutricional.',
    populacao: 'Crianças até 5 anos, gestantes e pessoas com 60 anos ou mais; adultos atendidos entram quando têm antropometria.',
    acoes: [
      { codigo: 'ANTROPOMETRIA', descricao: 'Peso e altura', periodicidade: 'crianças: a cada 6 meses; gestantes: em cada consulta; demais: anual' },
      { codigo: 'ESTADO_NUTRICIONAL', descricao: 'Classificação do estado nutricional (IMC)', periodicidade: 'a cada antropometria' },
    ],
    indicadores: [],
    linhasBuscaAtiva: ['SISVAN'],
    estratificacoes: [],
    referencias: ['Orientações para a coleta e análise de dados antropométricos (SISVAN, MS 2011)'],
  },
  {
    codigo: 'TB_HANSENIASE',
    titulo: 'Tuberculose e hanseníase',
    descricao: 'Tratamento acompanhado mensalmente até a alta, com previsão de término por esquema.',
    populacao: 'Pessoas com condição ativa de tuberculose (CID A15–A19) ou hanseníase (CID A30).',
    acoes: [
      { codigo: 'CONSULTA', descricao: 'Consulta de acompanhamento do tratamento', periodicidade: 'mensal' },
      { codigo: 'ALTA', descricao: 'Previsão de alta', periodicidade: 'tuberculose: 6 meses; hanseníase: 6 doses (PB) ou 12 doses (MB)' },
    ],
    indicadores: [],
    linhasBuscaAtiva: ['TUBERCULOSE', 'HANSENIASE'],
    estratificacoes: [],
    referencias: ['Manual de Recomendações para o Controle da Tuberculose no Brasil (MS, 2019)', 'Diretrizes para vigilância, atenção e eliminação da hanseníase (MS, 2016)'],
  },
];

export const PROGRAMA_POR_CODIGO: Record<CodigoPrograma, ProgramaAps> = Object.fromEntries(PROGRAMAS_APS.map((p) => [p.codigo, p])) as Record<CodigoPrograma, ProgramaAps>;

// ───────────────────────────── Puericultura: consultas e vacinas ─────────────────────────────

/** Idade (em meses) das consultas de puericultura nos dois primeiros anos (Caderneta da Criança). */
export const CONSULTAS_PUERICULTURA_MESES = [0.25, 1, 2, 4, 6, 9, 12, 18, 24];

export interface DoseCalendario {
  componente: ComponenteVacinal;
  rotulo: string;
  /** Idade recomendada em meses. */
  meses: number;
  /** Número da dose (1, 2, 3; reforços contam a partir da dose seguinte). */
  dose: number;
}

/** Calendário nacional de vacinação até os 24 meses (doses e reforços relevantes à puericultura). */
export const CALENDARIO_VACINAL_0_24M: DoseCalendario[] = [
  { componente: 'BCG', rotulo: 'BCG', meses: 0, dose: 1 },
  { componente: 'HEPB', rotulo: 'Hepatite B (ao nascer)', meses: 0, dose: 1 },
  { componente: 'DTP', rotulo: 'Penta (DTP/HepB/Hib) 1ª dose', meses: 2, dose: 1 },
  { componente: 'VIP', rotulo: 'Poliomielite inativada 1ª dose', meses: 2, dose: 1 },
  { componente: 'PNEUMO', rotulo: 'Pneumocócica 10 1ª dose', meses: 2, dose: 1 },
  { componente: 'ROTA', rotulo: 'Rotavírus 1ª dose', meses: 2, dose: 1 },
  { componente: 'MENINGO_C', rotulo: 'Meningocócica C 1ª dose', meses: 3, dose: 1 },
  { componente: 'DTP', rotulo: 'Penta 2ª dose', meses: 4, dose: 2 },
  { componente: 'VIP', rotulo: 'Poliomielite inativada 2ª dose', meses: 4, dose: 2 },
  { componente: 'PNEUMO', rotulo: 'Pneumocócica 10 2ª dose', meses: 4, dose: 2 },
  { componente: 'ROTA', rotulo: 'Rotavírus 2ª dose', meses: 4, dose: 2 },
  { componente: 'MENINGO_C', rotulo: 'Meningocócica C 2ª dose', meses: 5, dose: 2 },
  { componente: 'DTP', rotulo: 'Penta 3ª dose', meses: 6, dose: 3 },
  { componente: 'VIP', rotulo: 'Poliomielite inativada 3ª dose', meses: 6, dose: 3 },
  { componente: 'FEBRE_AMARELA', rotulo: 'Febre amarela', meses: 9, dose: 1 },
  { componente: 'PNEUMO', rotulo: 'Pneumocócica 10 reforço', meses: 12, dose: 3 },
  { componente: 'MENINGO_C', rotulo: 'Meningocócica C reforço', meses: 12, dose: 3 },
  { componente: 'SCR', rotulo: 'Tríplice viral 1ª dose', meses: 12, dose: 1 },
  { componente: 'SCR', rotulo: 'Tríplice viral 2ª dose (tetra viral)', meses: 15, dose: 2 },
  { componente: 'VARICELA', rotulo: 'Varicela (tetra viral)', meses: 15, dose: 1 },
  { componente: 'HEPA', rotulo: 'Hepatite A', meses: 15, dose: 1 },
  { componente: 'DTP', rotulo: 'DTP 1º reforço', meses: 15, dose: 4 },
  { componente: 'VIP', rotulo: 'Poliomielite inativada reforço', meses: 15, dose: 4 },
];

/** Tolerância, em dias, depois da idade recomendada antes de considerar a dose atrasada. */
export const TOLERANCIA_VACINA_DIAS = 30;
export const TOLERANCIA_CONSULTA_PUERICULTURA_DIAS = 30;

/** Intervalo máximo entre consultas de pré-natal pela idade gestacional (CAB 32), em dias. */
export function intervaloPreNatalDias(semanas: number): number {
  if (semanas < 28) return 30;
  if (semanas < 36) return 15;
  return 7;
}

/** Vigência do Bolsa Família: 1ª (janeiro a junho) ou 2ª (julho a dezembro). */
export function vigenciaBolsaFamilia(data: Date): { ano: number; semestre: 1 | 2; inicio: Date; fim: Date } {
  const ano = data.getUTCFullYear();
  const semestre: 1 | 2 = data.getUTCMonth() < 6 ? 1 : 2;
  return { ano, semestre, inicio: new Date(Date.UTC(ano, semestre === 1 ? 0 : 6, 1)), fim: new Date(Date.UTC(ano, semestre === 1 ? 6 : 12, 1) - 1) };
}

/** Classificação do estado nutricional pelo IMC (SISVAN): adultos e pessoas idosas. */
export function estadoNutricionalImc(imc: number, idadeAnos: number): string {
  if (idadeAnos >= 60) {
    if (imc <= 22) return 'BAIXO_PESO';
    if (imc < 27) return 'ADEQUADO';
    return 'SOBREPESO';
  }
  if (imc < 18.5) return 'BAIXO_PESO';
  if (imc < 25) return 'ADEQUADO';
  if (imc < 30) return 'SOBREPESO';
  return 'OBESIDADE';
}
export const ESTADO_NUTRICIONAL_LABEL: Record<string, string> = { BAIXO_PESO: 'Baixo peso', ADEQUADO: 'Eutrofia', SOBREPESO: 'Sobrepeso', OBESIDADE: 'Obesidade' };

// ───────────────────────────── Estratificações de risco ─────────────────────────────

export const ESTRATIFICACAO_LABEL: Record<TipoEstratificacao, string> = {
  GESTANTE: 'Risco gestacional',
  PE_DIABETICO: 'Risco do pé diabético',
  MCHAT: 'M-CHAT-R (desenvolvimento, 16 a 30 meses)',
};

export interface CriterioRisco {
  codigo: string;
  descricao: string;
}

/** Fatores que indicam encaminhamento ao pré-natal de alto risco (CAB 32 e Manual de Gestação de Alto Risco). */
export const GESTANTE_ALTO_RISCO: CriterioRisco[] = [
  { codigo: 'CARDIOPATIA', descricao: 'Cardiopatia' },
  { codigo: 'PNEUMOPATIA', descricao: 'Pneumopatia grave (asma grave, DPOC)' },
  { codigo: 'NEFROPATIA', descricao: 'Nefropatia grave (insuficiência renal, rins policísticos)' },
  { codigo: 'ENDOCRINOPATIA', descricao: 'Endocrinopatia (diabetes prévio, hipo ou hipertireoidismo)' },
  { codigo: 'HEMATOLOGICA', descricao: 'Doença hematológica (anemia falciforme, PTI, trombofilia)' },
  { codigo: 'HAS_CRONICA', descricao: 'Hipertensão arterial crônica ou PA ≥ 140/90 antes de 20 semanas' },
  { codigo: 'NEUROLOGICA', descricao: 'Doença neurológica (epilepsia)' },
  { codigo: 'PSIQUIATRICA', descricao: 'Transtorno psiquiátrico que precisa de acompanhamento' },
  { codigo: 'AUTOIMUNE', descricao: 'Doença autoimune (lúpus, artrite reumatoide)' },
  { codigo: 'TROMBOEMBOLISMO', descricao: 'Antecedente de trombose venosa profunda ou embolia' },
  { codigo: 'GINECOPATIA', descricao: 'Ginecopatia (malformação uterina, miomatose, tumores anexiais)' },
  { codigo: 'INFECCAO', descricao: 'HIV, sífilis com complicações, toxoplasmose, hepatites, hanseníase, tuberculose' },
  { codigo: 'DEPENDENCIA', descricao: 'Dependência de álcool ou outras drogas' },
  { codigo: 'OBITO_FETAL', descricao: 'Morte intrauterina ou perinatal anterior sem causa esclarecida' },
  { codigo: 'ABORTO_HABITUAL', descricao: 'Abortamento habitual' },
  { codigo: 'INFERTILIDADE', descricao: 'Esterilidade ou infertilidade tratada' },
  { codigo: 'RCIU', descricao: 'Restrição do crescimento intrauterino' },
  { codigo: 'LIQUIDO', descricao: 'Polidrâmnio ou oligoidrâmnio' },
  { codigo: 'GEMELAR', descricao: 'Gestação gemelar' },
  { codigo: 'MALFORMACAO', descricao: 'Malformação fetal ou arritmia fetal' },
  { codigo: 'DHEG', descricao: 'Distúrbio hipertensivo da gestação (pré-eclâmpsia, hipertensão gestacional)' },
  { codigo: 'ITU_REPETICAO', descricao: 'Infecção urinária de repetição ou pielonefrite' },
  { codigo: 'ANEMIA_GRAVE', descricao: 'Anemia grave (Hb < 8) ou que não responde ao tratamento' },
  { codigo: 'DMG', descricao: 'Diabetes mellitus gestacional' },
  { codigo: 'DESNUTRICAO', descricao: 'Desnutrição materna severa' },
  { codigo: 'OBESIDADE_MORBIDA', descricao: 'Obesidade mórbida (IMC ≥ 40)' },
  { codigo: 'NIC3', descricao: 'NIC III ou neoplasia' },
  { codigo: 'HEMORRAGIA', descricao: 'Hemorragia na gestação atual (placenta prévia, descolamento)' },
  { codigo: 'ISOIMUNIZACAO', descricao: 'Isoimunização Rh' },
  { codigo: 'ADOLESCENTE_MENOR_15', descricao: 'Gestante com menos de 15 anos' },
];

/** Fatores de atenção que permitem o pré-natal na própria equipe (risco habitual com acompanhamento reforçado). */
export const GESTANTE_ATENCAO: CriterioRisco[] = [
  { codigo: 'IDADE', descricao: 'Idade entre 15 e 19 anos ou acima de 35' },
  { codigo: 'OCUPACAO', descricao: 'Ocupação com esforço físico excessivo, exposição a agentes químicos ou estresse' },
  { codigo: 'SITUACAO_FAMILIAR', descricao: 'Situação familiar insegura, não aceitação da gravidez ou violência' },
  { codigo: 'ESCOLARIDADE', descricao: 'Baixa escolaridade (menos de 5 anos de estudo)' },
  { codigo: 'ALTURA', descricao: 'Altura menor que 1,45 m' },
  { codigo: 'IMC', descricao: 'IMC inicial abaixo de 19 ou acima de 30' },
  { codigo: 'RN_ANTERIOR', descricao: 'RN anterior com restrição de crescimento, pré-termo ou malformado' },
  { codigo: 'MACROSSOMIA', descricao: 'Macrossomia fetal anterior' },
  { codigo: 'SINDROME_ANTERIOR', descricao: 'Síndrome hemorrágica ou hipertensiva em gestação anterior' },
  { codigo: 'INTERVALO', descricao: 'Intervalo interpartal menor que 2 anos ou maior que 5' },
  { codigo: 'PARIDADE', descricao: 'Nuliparidade ou multiparidade (5 ou mais partos)' },
  { codigo: 'CIRURGIA_UTERINA', descricao: 'Cirurgia uterina anterior ou 3 ou mais cesarianas' },
  { codigo: 'GANHO_PONDERAL', descricao: 'Ganho de peso inadequado' },
  { codigo: 'ITU', descricao: 'Infecção urinária' },
  { codigo: 'ANEMIA', descricao: 'Anemia leve a moderada' },
  { codigo: 'TABAGISMO', descricao: 'Tabagismo' },
];

export type RiscoGestacional = 'RISCO_HABITUAL' | 'ALTO_RISCO';

export function classificarRiscoGestacional(criterios: string[]): { resultado: RiscoGestacional; altoRisco: string[]; atencao: string[]; orientacao: string } {
  const altoRisco = criterios.filter((c) => GESTANTE_ALTO_RISCO.some((a) => a.codigo === c));
  const atencao = criterios.filter((c) => GESTANTE_ATENCAO.some((a) => a.codigo === c));
  if (altoRisco.length) return { resultado: 'ALTO_RISCO', altoRisco, atencao, orientacao: 'Encaminhar ao pré-natal de alto risco mantendo o acompanhamento na equipe (vínculo compartilhado).' };
  return { resultado: 'RISCO_HABITUAL', altoRisco, atencao, orientacao: atencao.length ? 'Pré-natal na equipe com atenção reforçada aos fatores marcados.' : 'Pré-natal de risco habitual na equipe.' };
}

/** Avaliação do pé (Manual do pé diabético, MS 2016): respostas sim/não. */
export const PE_DIABETICO_ITENS: CriterioRisco[] = [
  { codigo: 'PSP', descricao: 'Perda da sensibilidade protetora (monofilamento de 10 g alterado ou diapasão alterado)' },
  { codigo: 'DEFORMIDADE', descricao: 'Deformidade do pé (dedos em garra/martelo, proeminências ósseas, Charcot)' },
  { codigo: 'DAP', descricao: 'Doença arterial periférica (pulsos pedioso/tibial ausentes, claudicação ou ITB < 0,9)' },
  { codigo: 'ULCERA_PREVIA', descricao: 'Úlcera prévia no pé' },
  { codigo: 'AMPUTACAO_PREVIA', descricao: 'Amputação prévia' },
  { codigo: 'DRC_DIALISE', descricao: 'Doença renal crônica em diálise' },
];

export type GrauPeDiabetico = 0 | 1 | 2 | 3;

export function classificarPeDiabetico(itens: string[]): { grau: GrauPeDiabetico; descricao: string; retornoMeses: number; orientacao: string } {
  const tem = (c: string) => itens.includes(c);
  if (tem('ULCERA_PREVIA') || tem('AMPUTACAO_PREVIA') || tem('DRC_DIALISE')) {
    return { grau: 3, descricao: 'Grau 3: úlcera ou amputação prévia', retornoMeses: 1, orientacao: 'Avaliação a cada 1 a 2 meses; referenciar à atenção especializada; calçados e palmilhas especiais.' };
  }
  if (tem('DAP'))
    return {
      grau: 2,
      descricao: 'Grau 2: doença arterial periférica, com ou sem neuropatia',
      retornoMeses: 2,
      orientacao: 'Avaliação a cada 2 a 3 meses; avaliar necessidade de encaminhamento vascular; calçados adequados.',
    };
  if (tem('PSP') || tem('DEFORMIDADE'))
    return { grau: 1, descricao: 'Grau 1: neuropatia periférica, com ou sem deformidade', retornoMeses: 3, orientacao: 'Avaliação a cada 3 a 6 meses; educação para o autocuidado; calçados adequados.' };
  return { grau: 0, descricao: 'Grau 0: sem neuropatia nem doença arterial', retornoMeses: 12, orientacao: 'Avaliação anual e educação para o autocuidado.' };
}

/** M-CHAT-R (Robins, Fein e Barton, 2009; tradução brasileira). Respostas sim/não; itens 2, 5 e 12 pontuam no "sim". */
export const MCHAT_ITENS: { numero: number; pergunta: string; riscoNoSim: boolean }[] = [
  { numero: 1, pergunta: 'Se você aponta para algo do outro lado da sala, seu filho olha para o que você está apontando? (Por exemplo, um brinquedo, um bicho de pelúcia ou um animal)', riscoNoSim: false },
  { numero: 2, pergunta: 'Você já se perguntou se seu filho pode ser surdo?', riscoNoSim: true },
  { numero: 3, pergunta: 'Seu filho brinca de faz de conta? (Por exemplo, finge beber de um copo vazio, finge falar ao telefone ou finge alimentar uma boneca ou um bichinho de pelúcia)', riscoNoSim: false },
  { numero: 4, pergunta: 'Seu filho gosta de subir nas coisas? (Por exemplo, móveis, brinquedos de parquinho ou escadas)', riscoNoSim: false },
  { numero: 5, pergunta: 'Seu filho faz movimentos incomuns com os dedos perto dos olhos? (Por exemplo, balança os dedos perto dos olhos)', riscoNoSim: true },
  { numero: 6, pergunta: 'Seu filho aponta com um dedo para pedir alguma coisa ou para conseguir ajuda? (Por exemplo, aponta para um alimento ou brinquedo fora do alcance)', riscoNoSim: false },
  { numero: 7, pergunta: 'Seu filho aponta com um dedo para mostrar algo interessante a você? (Por exemplo, aponta para um avião no céu ou um caminhão grande na rua)', riscoNoSim: false },
  { numero: 8, pergunta: 'Seu filho se interessa por outras crianças? (Por exemplo, observa outras crianças, sorri para elas ou se aproxima delas)', riscoNoSim: false },
  {
    numero: 9,
    pergunta:
      'Seu filho mostra coisas para você, trazendo-as ou segurando-as para que você veja, não para pedir ajuda, mas só para compartilhar? (Por exemplo, uma flor, um bichinho de pelúcia ou um caminhão de brinquedo)',
    riscoNoSim: false,
  },
  { numero: 10, pergunta: 'Seu filho responde quando você o chama pelo nome? (Por exemplo, olha, fala ou balbucia, ou para o que está fazendo)', riscoNoSim: false },
  { numero: 11, pergunta: 'Quando você sorri para seu filho, ele sorri de volta?', riscoNoSim: false },
  { numero: 12, pergunta: 'Seu filho fica muito incomodado com barulhos do dia a dia? (Por exemplo, grita ou chora com barulho de aspirador de pó ou música alta)', riscoNoSim: true },
  { numero: 13, pergunta: 'Seu filho anda?', riscoNoSim: false },
  { numero: 14, pergunta: 'Seu filho olha nos seus olhos quando você fala com ele, brinca com ele ou troca a roupa dele?', riscoNoSim: false },
  { numero: 15, pergunta: 'Seu filho imita o que você faz? (Por exemplo, dá tchau, bate palmas ou faz um barulho engraçado quando você faz)', riscoNoSim: false },
  { numero: 16, pergunta: 'Se você vira a cabeça para olhar alguma coisa, seu filho olha em volta para ver o que você está olhando?', riscoNoSim: false },
  { numero: 17, pergunta: 'Seu filho tenta fazer com que você olhe para ele? (Por exemplo, olha para você esperando elogio ou diz "olha" ou "olha para mim")', riscoNoSim: false },
  { numero: 18, pergunta: 'Seu filho entende quando você pede para ele fazer algo? (Por exemplo, sem apontar, entende "coloque o livro na cadeira" ou "traga o cobertor")', riscoNoSim: false },
  { numero: 19, pergunta: 'Se algo novo acontece, seu filho olha para o seu rosto para ver como você se sente a respeito? (Por exemplo, se ouve um barulho estranho ou vê um brinquedo novo)', riscoNoSim: false },
  { numero: 20, pergunta: 'Seu filho gosta de atividades com movimento? (Por exemplo, ser balançado ou pular no seu joelho)', riscoNoSim: false },
];

export type RiscoMchat = 'BAIXO' | 'MEDIO' | 'ALTO';

/** Pontua o M-CHAT-R: respostas por número do item (true = sim). */
export function pontuarMchat(respostas: Record<string, boolean>): { pontos: number; resultado: RiscoMchat; itensRisco: number[]; orientacao: string } {
  const itensRisco: number[] = [];
  for (const item of MCHAT_ITENS) {
    const r = respostas[String(item.numero)];
    if (r === undefined) throw new Error(`Item ${item.numero} sem resposta`);
    if (r === item.riscoNoSim) itensRisco.push(item.numero);
  }
  const pontos = itensRisco.length;
  if (pontos >= 8) return { pontos, resultado: 'ALTO', itensRisco, orientacao: 'Risco alto: encaminhar para avaliação diagnóstica e intervenção precoce sem esperar a entrevista de seguimento.' };
  if (pontos >= 3) return { pontos, resultado: 'MEDIO', itensRisco, orientacao: 'Risco médio: aplicar a entrevista de seguimento (M-CHAT-R/F); se continuar com 2 ou mais itens, encaminhar.' };
  return { pontos, resultado: 'BAIXO', itensRisco, orientacao: 'Risco baixo: repetir a triagem após os 24 meses se a aplicação foi antes disso.' };
}
