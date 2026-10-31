/**
 * Regulação ambulatorial (REG-1/REG-2): protocolos de encaminhamento por especialidade, exames e
 * procedimentos regulados, classificação de prioridade com prazo-meta, ordem da fila única e verificação do
 * protocolo na solicitação. Os critérios seguem os Protocolos de Encaminhamento da Atenção Básica para a
 * Atenção Especializada (Ministério da Saúde / TelessaúdeRS-UFRGS, volumes 1 a 7) e os cadernos de atenção
 * básica; são o apoio à decisão do solicitante e do regulador, não substituem a avaliação clínica.
 */

export type PrioridadeRegulacao = 'VERMELHA' | 'AMARELA' | 'VERDE' | 'AZUL';
export type TipoSolicitacao = 'CONSULTA' | 'EXAME' | 'PROCEDIMENTO';
export type StatusSolicitacao = 'PENDENTE' | 'EM_ANALISE' | 'DEVOLVIDA' | 'AUTORIZADA' | 'AGENDADA' | 'NEGADA' | 'CANCELADA' | 'REALIZADA';

export const PRIORIDADES: Record<PrioridadeRegulacao, { label: string; descricao: string; prazoDias: number; exigeJustificativa: boolean; ordem: number }> = {
  VERMELHA: { label: 'Emergência', descricao: 'Risco imediato de vida ou de perda de função: atendimento em até 24 horas.', prazoDias: 1, exigeJustificativa: true, ordem: 0 },
  AMARELA: { label: 'Urgência', descricao: 'Agravamento provável em dias: atendimento em até 7 dias.', prazoDias: 7, exigeJustificativa: true, ordem: 1 },
  VERDE: { label: 'Prioridade', descricao: 'Condição que não pode esperar a fila eletiva: até 30 dias.', prazoDias: 30, exigeJustificativa: false, ordem: 2 },
  AZUL: { label: 'Eletivo', descricao: 'Sem risco de agravamento no prazo da fila: até 90 dias.', prazoDias: 90, exigeJustificativa: false, ordem: 3 },
};

export const STATUS_SOLICITACAO: Record<StatusSolicitacao, string> = {
  PENDENTE: 'Aguardando regulação',
  EM_ANALISE: 'Em análise',
  DEVOLVIDA: 'Devolvida ao solicitante',
  AUTORIZADA: 'Autorizada',
  AGENDADA: 'Agendada',
  NEGADA: 'Negada',
  CANCELADA: 'Cancelada',
  REALIZADA: 'Realizada',
};

/** Situações em que a solicitação ainda ocupa lugar na fila única. */
export const STATUS_NA_FILA: StatusSolicitacao[] = ['PENDENTE', 'EM_ANALISE'];

export interface CriterioEncaminhamento {
  codigo: string;
  descricao: string;
  /** Prioridade sugerida quando o critério está presente. */
  prioridade: PrioridadeRegulacao;
}

export interface ExameMinimo {
  sigtapCode: string;
  nome: string;
  /** Analito do laboratório (quando houver) para reconhecer o resultado no prontuário. */
  analito?: string;
  obrigatorio: boolean;
}

export interface ProtocoloEspecialidade {
  codigo: string;
  nome: string;
  /** CBOs do profissional executante (consulta médica em atenção especializada). */
  cbos: string[];
  /** Procedimento SIGTAP da consulta. */
  sigtapCode: string;
  criterios: CriterioEncaminhamento[];
  examesMinimos: ExameMinimo[];
  /** O que a atenção primária segue acompanhando sem encaminhar. */
  manejoNaAps: string[];
  fonte: string;
}

const CONSULTA_ESPECIALIZADA = '0301010072';
const FONTE_MS = 'Protocolos de Encaminhamento da Atenção Básica para a Atenção Especializada (MS/TelessaúdeRS-UFRGS)';

export const ESPECIALIDADES: ProtocoloEspecialidade[] = [
  {
    codigo: 'CARDIOLOGIA',
    nome: 'Cardiologia',
    cbos: ['225120'],
    sigtapCode: CONSULTA_ESPECIALIZADA,
    criterios: [
      { codigo: 'IC_DESCOMPENSADA', descricao: 'Insuficiência cardíaca classe funcional III ou IV apesar do tratamento otimizado', prioridade: 'AMARELA' },
      { codigo: 'ANGINA_INSTAVEL', descricao: 'Angina em piora recente ou aos mínimos esforços (síndrome coronariana crônica instável)', prioridade: 'VERMELHA' },
      { codigo: 'ARRITMIA_SINTOMATICA', descricao: 'Arritmia sintomática (síncope, palpitação com repercussão) ou fibrilação atrial de início recente', prioridade: 'AMARELA' },
      { codigo: 'HAS_RESISTENTE', descricao: 'Hipertensão resistente (PA acima da meta com 3 fármacos em dose otimizada, incluindo diurético)', prioridade: 'VERDE' },
      { codigo: 'SOPRO_VALVOPATIA', descricao: 'Sopro cardíaco com suspeita de valvopatia moderada ou grave', prioridade: 'VERDE' },
      { codigo: 'ESTRATIFICACAO_ALTO_RISCO', descricao: 'Avaliação pré-operatória ou estratificação de risco em paciente de alto risco cardiovascular', prioridade: 'AZUL' },
    ],
    examesMinimos: [
      { sigtapCode: '0211020036', nome: 'Eletrocardiograma', obrigatorio: true },
      { sigtapCode: '0204030153', nome: 'Radiografia de tórax', obrigatorio: false },
      { sigtapCode: '0202010295', nome: 'Creatinina', analito: 'CREATININA', obrigatorio: true },
      { sigtapCode: '0202010473', nome: 'Potássio', analito: 'POTASSIO', obrigatorio: false },
    ],
    manejoNaAps: ['Hipertensão sem lesão de órgão-alvo e controlada', 'Insuficiência cardíaca classe I e II estável', 'Dislipidemia sem evento cardiovascular'],
    fonte: FONTE_MS,
  },
  {
    codigo: 'ENDOCRINOLOGIA',
    nome: 'Endocrinologia',
    cbos: ['225155'],
    sigtapCode: CONSULTA_ESPECIALIZADA,
    criterios: [
      { codigo: 'DM1', descricao: 'Diabetes tipo 1 ou diabetes em criança e adolescente', prioridade: 'AMARELA' },
      { codigo: 'DM2_DESCOMPENSADO', descricao: 'Diabetes tipo 2 com HbA1c acima de 9% apesar de insulina em dose otimizada', prioridade: 'VERDE' },
      { codigo: 'HIPOGLICEMIAS_GRAVES', descricao: 'Hipoglicemias graves ou frequentes em uso de insulina', prioridade: 'AMARELA' },
      { codigo: 'NODULO_TIREOIDE', descricao: 'Nódulo de tireoide com 1 cm ou mais, ou com características suspeitas na ultrassonografia', prioridade: 'VERDE' },
      { codigo: 'HIPERTIREOIDISMO', descricao: 'Hipertireoidismo confirmado (TSH suprimido com T4 livre elevado)', prioridade: 'AMARELA' },
      { codigo: 'OBESIDADE_GRAVE', descricao: 'Obesidade grau III ou grau II com comorbidade, candidata a tratamento especializado', prioridade: 'AZUL' },
    ],
    examesMinimos: [
      { sigtapCode: '0202010503', nome: 'Hemoglobina glicada', analito: 'HBA1C', obrigatorio: true },
      { sigtapCode: '0202010295', nome: 'Creatinina', analito: 'CREATININA', obrigatorio: true },
      { sigtapCode: '0202060381', nome: 'TSH', analito: 'TSH', obrigatorio: false },
    ],
    manejoNaAps: ['Diabetes tipo 2 em uso de metformina e insulina basal com metas atingidas', 'Hipotireoidismo em reposição estável', 'Pré-diabetes e obesidade grau I'],
    fonte: FONTE_MS,
  },
  {
    codigo: 'NEFROLOGIA',
    nome: 'Nefrologia',
    cbos: ['225135'],
    sigtapCode: CONSULTA_ESPECIALIZADA,
    criterios: [
      { codigo: 'TFG_ABAIXO_30', descricao: 'Taxa de filtração glomerular abaixo de 30 mL/min (DRC estágio 4 ou 5)', prioridade: 'AMARELA' },
      { codigo: 'PERDA_RAPIDA', descricao: 'Perda de função renal acima de 5 mL/min por ano ou creatinina em elevação rápida', prioridade: 'AMARELA' },
      { codigo: 'PROTEINURIA', descricao: 'Proteinúria acima de 1 g/dia ou relação albumina/creatinina acima de 300 mg/g', prioridade: 'VERDE' },
      { codigo: 'HEMATURIA_GLOMERULAR', descricao: 'Hematúria persistente de origem glomerular (cilindros ou dismorfismo)', prioridade: 'VERDE' },
      { codigo: 'TFG_30_45_DM', descricao: 'DRC estágio 3b em pessoa com diabetes ou hipertensão de difícil controle', prioridade: 'AZUL' },
    ],
    examesMinimos: [
      { sigtapCode: '0202010295', nome: 'Creatinina', analito: 'CREATININA', obrigatorio: true },
      { sigtapCode: '0202050017', nome: 'Exame de urina (EAS)', obrigatorio: true },
      { sigtapCode: '0202050025', nome: 'Relação albumina/creatinina na urina', analito: 'ALBUMINURIA', obrigatorio: false },
      { sigtapCode: '0205020054', nome: 'Ultrassonografia de rins e vias urinárias', obrigatorio: false },
    ],
    manejoNaAps: ['DRC estágios 1 a 3a estável, com controle de pressão, glicemia e uso de IECA/BRA'],
    fonte: FONTE_MS,
  },
  {
    codigo: 'NEUROLOGIA',
    nome: 'Neurologia',
    cbos: ['225112'],
    sigtapCode: CONSULTA_ESPECIALIZADA,
    criterios: [
      { codigo: 'EPILEPSIA_REFRATARIA', descricao: 'Epilepsia sem controle com dois fármacos em dose adequada ou primeira crise com exame alterado', prioridade: 'AMARELA' },
      { codigo: 'CEFALEIA_SINAIS_ALARME', descricao: 'Cefaleia com sinais de alarme (início súbito, progressiva, déficit focal, despertar noturno)', prioridade: 'VERMELHA' },
      { codigo: 'PARKINSONISMO', descricao: 'Parkinsonismo para confirmação diagnóstica ou ajuste de tratamento', prioridade: 'VERDE' },
      { codigo: 'DEMENCIA_ATIPICA', descricao: 'Demência de início precoce (antes dos 65 anos) ou de evolução rápida', prioridade: 'VERDE' },
      { codigo: 'NEUROPATIA', descricao: 'Neuropatia periférica sem causa definida após investigação inicial', prioridade: 'AZUL' },
    ],
    examesMinimos: [
      { sigtapCode: '0202010643', nome: 'Glicemia de jejum', analito: 'GLICEMIA', obrigatorio: false },
      { sigtapCode: '0202060381', nome: 'TSH', analito: 'TSH', obrigatorio: false },
      { sigtapCode: '0202020380', nome: 'Hemograma', analito: 'HEMOGRAMA', obrigatorio: false },
    ],
    manejoNaAps: ['Enxaqueca sem sinais de alarme', 'Epilepsia controlada com monoterapia', 'Demência típica em acompanhamento com a família'],
    fonte: FONTE_MS,
  },
  {
    codigo: 'OFTALMOLOGIA',
    nome: 'Oftalmologia',
    cbos: ['225265'],
    sigtapCode: CONSULTA_ESPECIALIZADA,
    criterios: [
      { codigo: 'PERDA_VISUAL_SUBITA', descricao: 'Perda visual súbita, dor ocular intensa ou trauma ocular', prioridade: 'VERMELHA' },
      { codigo: 'RETINOPATIA_DM', descricao: 'Rastreio de retinopatia diabética (diabetes há mais de 5 anos ou sem fundoscopia há mais de 1 ano)', prioridade: 'VERDE' },
      { codigo: 'CATARATA', descricao: 'Catarata com baixa acuidade visual que limita as atividades diárias', prioridade: 'AZUL' },
      { codigo: 'GLAUCOMA_SUSPEITO', descricao: 'Suspeita de glaucoma (pressão intraocular elevada, história familiar com alteração de disco)', prioridade: 'VERDE' },
      { codigo: 'REFRACAO_CRIANCA', descricao: 'Baixa acuidade visual em criança em idade escolar', prioridade: 'VERDE' },
    ],
    examesMinimos: [],
    manejoNaAps: ['Conjuntivite, hordéolo e blefarite', 'Presbiopia em adulto sem outra queixa'],
    fonte: FONTE_MS,
  },
  {
    codigo: 'ORTOPEDIA',
    nome: 'Ortopedia e traumatologia',
    cbos: ['225270'],
    sigtapCode: CONSULTA_ESPECIALIZADA,
    criterios: [
      { codigo: 'FRATURA_LESAO_AGUDA', descricao: 'Fratura, luxação ou lesão ligamentar aguda que precise de avaliação especializada', prioridade: 'VERMELHA' },
      { codigo: 'DEFICIT_NEUROLOGICO', descricao: 'Dor na coluna com déficit neurológico progressivo ou sinais de alarme', prioridade: 'AMARELA' },
      { codigo: 'ARTROSE_LIMITANTE', descricao: 'Osteoartrose de quadril ou joelho com limitação funcional apesar de 6 meses de tratamento conservador', prioridade: 'AZUL' },
      { codigo: 'LESAO_MENISCO_LCA', descricao: 'Lesão meniscal ou ligamentar com bloqueio articular ou instabilidade', prioridade: 'VERDE' },
      { codigo: 'DEFORMIDADE_CRIANCA', descricao: 'Deformidade ou alteração da marcha em criança (displasia do quadril, pé torto, escoliose progressiva)', prioridade: 'VERDE' },
    ],
    examesMinimos: [{ sigtapCode: '0204020034', nome: 'Radiografia da região afetada', obrigatorio: true }],
    manejoNaAps: ['Lombalgia mecânica aguda sem sinais de alarme', 'Tendinopatias e bursites em tratamento conservador'],
    fonte: FONTE_MS,
  },
  {
    codigo: 'OTORRINOLARINGOLOGIA',
    nome: 'Otorrinolaringologia',
    cbos: ['225275'],
    sigtapCode: CONSULTA_ESPECIALIZADA,
    criterios: [
      { codigo: 'PERDA_AUDITIVA_SUBITA', descricao: 'Perda auditiva súbita ou paralisia facial periférica sem melhora', prioridade: 'VERMELHA' },
      { codigo: 'OTITE_CRONICA', descricao: 'Otite média crônica com perfuração ou otorreia persistente', prioridade: 'VERDE' },
      { codigo: 'ROUQUIDAO_PERSISTENTE', descricao: 'Rouquidão há mais de 3 semanas (suspeita de lesão laríngea)', prioridade: 'AMARELA' },
      { codigo: 'HIPERTROFIA_AMIGDALAS', descricao: 'Apneia obstrutiva do sono ou amigdalites de repetição com indicação cirúrgica', prioridade: 'AZUL' },
      { codigo: 'SINUSITE_CRONICA', descricao: 'Rinossinusite crônica sem resposta ao tratamento clínico', prioridade: 'AZUL' },
    ],
    examesMinimos: [],
    manejoNaAps: ['Rinite alérgica', 'Otite média aguda', 'Cerume'],
    fonte: FONTE_MS,
  },
  {
    codigo: 'PSIQUIATRIA',
    nome: 'Psiquiatria',
    cbos: ['225133'],
    sigtapCode: CONSULTA_ESPECIALIZADA,
    criterios: [
      { codigo: 'RISCO_SUICIDIO', descricao: 'Risco de suicídio ou de agressão com plano ou tentativa recente', prioridade: 'VERMELHA' },
      { codigo: 'PSICOSE', descricao: 'Transtorno psicótico ou primeiro episódio psicótico', prioridade: 'AMARELA' },
      { codigo: 'DEPRESSAO_REFRATARIA', descricao: 'Depressão sem resposta a dois antidepressivos em dose e tempo adequados', prioridade: 'VERDE' },
      { codigo: 'TRANSTORNO_BIPOLAR', descricao: 'Transtorno bipolar para início ou ajuste de estabilizador de humor', prioridade: 'VERDE' },
      { codigo: 'DEPENDENCIA_GRAVE', descricao: 'Dependência química com complicações clínicas ou falha no tratamento no CAPS', prioridade: 'VERDE' },
    ],
    examesMinimos: [],
    manejoNaAps: ['Depressão leve e moderada', 'Ansiedade e insônia', 'Uso de álcool sem dependência grave (acompanhamento compartilhado com o CAPS)'],
    fonte: FONTE_MS,
  },
  {
    codigo: 'DERMATOLOGIA',
    nome: 'Dermatologia',
    cbos: ['225140'],
    sigtapCode: CONSULTA_ESPECIALIZADA,
    criterios: [
      { codigo: 'LESAO_SUSPEITA_CANCER', descricao: 'Lesão com suspeita de melanoma ou carcinoma (crescimento, assimetria, sangramento)', prioridade: 'AMARELA' },
      { codigo: 'PSORIASE_GRAVE', descricao: 'Psoríase extensa ou com artrite, sem resposta ao tratamento tópico', prioridade: 'VERDE' },
      { codigo: 'HANSENIASE_DUVIDA', descricao: 'Suspeita de hanseníase com dúvida diagnóstica ou reação hansênica', prioridade: 'AMARELA' },
      { codigo: 'DERMATOSE_REFRATARIA', descricao: 'Dermatose crônica sem resposta a dois tratamentos na atenção básica', prioridade: 'AZUL' },
    ],
    examesMinimos: [],
    manejoNaAps: ['Acne leve e moderada', 'Micoses superficiais', 'Dermatite seborreica e de contato'],
    fonte: FONTE_MS,
  },
  {
    codigo: 'GINECOLOGIA',
    nome: 'Ginecologia',
    cbos: ['225250'],
    sigtapCode: CONSULTA_ESPECIALIZADA,
    criterios: [
      { codigo: 'CITOLOGIA_ALTERADA', descricao: 'Citopatológico com lesão de alto grau (HSIL), ASC-H, AGC ou carcinoma', prioridade: 'AMARELA' },
      { codigo: 'SANGRAMENTO_POS_MENOPAUSA', descricao: 'Sangramento uterino após a menopausa', prioridade: 'AMARELA' },
      { codigo: 'MIOMA_SINTOMATICO', descricao: 'Mioma ou sangramento uterino anormal sem resposta ao tratamento clínico', prioridade: 'VERDE' },
      { codigo: 'MASSA_ANEXIAL', descricao: 'Massa anexial ou cisto ovariano complexo na ultrassonografia', prioridade: 'AMARELA' },
      { codigo: 'INFERTILIDADE', descricao: 'Infertilidade após 12 meses de tentativa (6 meses se a mulher tiver mais de 35 anos)', prioridade: 'AZUL' },
      { codigo: 'PRE_NATAL_ALTO_RISCO', descricao: 'Gestação de alto risco (conforme a estratificação do pré-natal)', prioridade: 'AMARELA' },
    ],
    examesMinimos: [{ sigtapCode: '0203010086', nome: 'Citopatológico do colo do útero', obrigatorio: false }],
    manejoNaAps: ['Pré-natal de risco habitual', 'Planejamento reprodutivo', 'Climatério sem contraindicação à terapia hormonal'],
    fonte: FONTE_MS,
  },
  {
    codigo: 'UROLOGIA',
    nome: 'Urologia',
    cbos: ['225285'],
    sigtapCode: CONSULTA_ESPECIALIZADA,
    criterios: [
      { codigo: 'HEMATURIA_MACRO', descricao: 'Hematúria macroscópica sem infecção', prioridade: 'AMARELA' },
      { codigo: 'PSA_ELEVADO', descricao: 'PSA acima de 4 ng/mL (ou acima de 2,5 em menores de 60 anos) ou toque retal alterado', prioridade: 'AMARELA' },
      { codigo: 'HPB_REFRATARIA', descricao: 'Hiperplasia prostática com retenção ou sintomas graves apesar do tratamento', prioridade: 'VERDE' },
      { codigo: 'LITIASE', descricao: 'Cálculo urinário maior que 1 cm ou com obstrução', prioridade: 'VERDE' },
      { codigo: 'VASECTOMIA', descricao: 'Vasectomia (planejamento reprodutivo, conforme a lei)', prioridade: 'AZUL' },
    ],
    examesMinimos: [
      { sigtapCode: '0202050017', nome: 'Exame de urina (EAS)', obrigatorio: true },
      { sigtapCode: '0202010295', nome: 'Creatinina', analito: 'CREATININA', obrigatorio: false },
    ],
    manejoNaAps: ['Infecção urinária não complicada', 'Hiperplasia prostática com sintomas leves'],
    fonte: FONTE_MS,
  },
  {
    codigo: 'GASTROENTEROLOGIA',
    nome: 'Gastroenterologia',
    cbos: ['225165'],
    sigtapCode: CONSULTA_ESPECIALIZADA,
    criterios: [
      { codigo: 'SINAIS_ALARME_DIGESTIVO', descricao: 'Dispepsia com sinais de alarme (perda de peso, disfagia, anemia, sangramento) ou após 55 anos', prioridade: 'AMARELA' },
      { codigo: 'HEPATITE_CRONICA', descricao: 'Hepatite B ou C crônica para avaliação de tratamento', prioridade: 'VERDE' },
      { codigo: 'DOENCA_INFLAMATORIA', descricao: 'Suspeita de doença inflamatória intestinal (diarreia crônica com sangue, perda de peso)', prioridade: 'AMARELA' },
      { codigo: 'CIRROSE', descricao: 'Cirrose ou alteração persistente de enzimas hepáticas sem causa definida', prioridade: 'VERDE' },
    ],
    examesMinimos: [
      { sigtapCode: '0202020380', nome: 'Hemograma', analito: 'HEMOGRAMA', obrigatorio: true },
      { sigtapCode: '0202010651', nome: 'Transaminases (TGO/TGP)', analito: 'TGP', obrigatorio: false },
    ],
    manejoNaAps: ['Dispepsia funcional e doença do refluxo sem sinais de alarme', 'Síndrome do intestino irritável', 'Esteatose hepática sem fibrose'],
    fonte: FONTE_MS,
  },
  {
    codigo: 'PNEUMOLOGIA',
    nome: 'Pneumologia',
    cbos: ['225127'],
    sigtapCode: CONSULTA_ESPECIALIZADA,
    criterios: [
      { codigo: 'ASMA_GRAVE', descricao: 'Asma sem controle com corticoide inalatório em dose alta associado a beta-agonista de longa ação', prioridade: 'VERDE' },
      { codigo: 'DPOC_GRAVE', descricao: 'DPOC com exacerbações frequentes (2 ou mais por ano) ou hipoxemia', prioridade: 'VERDE' },
      { codigo: 'NODULO_PULMONAR', descricao: 'Nódulo ou massa pulmonar na radiografia ou tomografia', prioridade: 'AMARELA' },
      { codigo: 'TB_COMPLICADA', descricao: 'Tuberculose com falência, resistência ou efeitos adversos graves', prioridade: 'AMARELA' },
    ],
    examesMinimos: [
      { sigtapCode: '0204030153', nome: 'Radiografia de tórax', obrigatorio: true },
      { sigtapCode: '0211080055', nome: 'Espirometria', obrigatorio: false },
    ],
    manejoNaAps: ['Asma e DPOC controladas', 'Tuberculose sensível em tratamento diretamente observado'],
    fonte: FONTE_MS,
  },
];

export const ESPECIALIDADE_POR_CODIGO: Record<string, ProtocoloEspecialidade> = Object.fromEntries(ESPECIALIDADES.map((e) => [e.codigo, e]));

export interface ProcedimentoRegulado {
  codigo: string;
  nome: string;
  sigtapCode: string;
  tipo: 'EXAME' | 'PROCEDIMENTO';
  criterios: CriterioEncaminhamento[];
  fonte: string;
}

/** Exames e procedimentos de média complexidade que passam pela fila única. */
export const PROCEDIMENTOS_REGULADOS: ProcedimentoRegulado[] = [
  {
    codigo: 'MAMOGRAFIA',
    nome: 'Mamografia bilateral',
    sigtapCode: '0204030188',
    tipo: 'EXAME',
    criterios: [
      { codigo: 'RASTREIO_50_69', descricao: 'Rastreamento em mulher de 50 a 69 anos sem mamografia há 2 anos', prioridade: 'AZUL' },
      { codigo: 'NODULO_PALPAVEL', descricao: 'Nódulo palpável, retração ou descarga papilar sanguinolenta (mamografia diagnóstica)', prioridade: 'AMARELA' },
      { codigo: 'ALTO_RISCO', descricao: 'Alto risco familiar (câncer de mama em parente de 1º grau antes dos 50 anos)', prioridade: 'VERDE' },
    ],
    fonte: 'Diretrizes para a detecção precoce do câncer de mama (INCA, 2015)',
  },
  {
    codigo: 'USG_ABDOME',
    nome: 'Ultrassonografia de abdome total',
    sigtapCode: '0205020046',
    tipo: 'EXAME',
    criterios: [
      { codigo: 'DOR_ABDOMINAL_CRONICA', descricao: 'Dor abdominal crônica ou massa abdominal palpável', prioridade: 'VERDE' },
      { codigo: 'ENZIMAS_HEPATICAS', descricao: 'Alteração persistente de enzimas hepáticas ou suspeita de litíase biliar', prioridade: 'VERDE' },
      { codigo: 'ICTERICIA', descricao: 'Icterícia ou perda de peso inexplicada', prioridade: 'AMARELA' },
    ],
    fonte: FONTE_MS,
  },
  {
    codigo: 'USG_OBSTETRICA',
    nome: 'Ultrassonografia obstétrica',
    sigtapCode: '0205020143',
    tipo: 'EXAME',
    criterios: [
      { codigo: 'DATACAO', descricao: 'Datação da gestação (1º trimestre) ou morfológico (20 a 24 semanas)', prioridade: 'VERDE' },
      { codigo: 'SANGRAMENTO_GESTACAO', descricao: 'Sangramento, dor ou suspeita de alteração do crescimento fetal', prioridade: 'AMARELA' },
    ],
    fonte: 'Caderno de Atenção Básica 32 (pré-natal de baixo risco)',
  },
  {
    codigo: 'ECOCARDIOGRAMA',
    nome: 'Ecocardiografia transtorácica',
    sigtapCode: '0205010032',
    tipo: 'EXAME',
    criterios: [
      { codigo: 'SUSPEITA_IC', descricao: 'Suspeita de insuficiência cardíaca ou cardiopatia estrutural (sopro, dispneia, edema)', prioridade: 'VERDE' },
      { codigo: 'AVALIACAO_VALVOPATIA', descricao: 'Acompanhamento de valvopatia ou cardiomiopatia conhecida', prioridade: 'AZUL' },
    ],
    fonte: FONTE_MS,
  },
  {
    codigo: 'EDA',
    nome: 'Endoscopia digestiva alta',
    sigtapCode: '0209010037',
    tipo: 'EXAME',
    criterios: [
      { codigo: 'DISPEPSIA_ALARME', descricao: 'Dispepsia com sinais de alarme ou após 55 anos', prioridade: 'AMARELA' },
      { codigo: 'ANEMIA_FERROPRIVA', descricao: 'Anemia ferropriva sem causa definida em homem ou mulher após a menopausa', prioridade: 'AMARELA' },
      { codigo: 'DRGE_REFRATARIA', descricao: 'Refluxo sem resposta a 8 semanas de inibidor de bomba de prótons', prioridade: 'VERDE' },
    ],
    fonte: FONTE_MS,
  },
  {
    codigo: 'COLONOSCOPIA',
    nome: 'Colonoscopia',
    sigtapCode: '0209010029',
    tipo: 'EXAME',
    criterios: [
      { codigo: 'SANGUE_OCULTO', descricao: 'Pesquisa de sangue oculto positiva ou sangramento retal persistente', prioridade: 'AMARELA' },
      { codigo: 'ALTERACAO_HABITO', descricao: 'Alteração do hábito intestinal com perda de peso após 50 anos', prioridade: 'AMARELA' },
      { codigo: 'HISTORIA_FAMILIAR_CCR', descricao: 'História familiar de câncer colorretal em parente de 1º grau', prioridade: 'VERDE' },
    ],
    fonte: FONTE_MS,
  },
  {
    codigo: 'TOMOGRAFIA',
    nome: 'Tomografia computadorizada',
    sigtapCode: '0206010079',
    tipo: 'EXAME',
    criterios: [
      { codigo: 'SUSPEITA_NEOPLASIA', descricao: 'Suspeita de neoplasia ou estadiamento solicitado pela atenção especializada', prioridade: 'AMARELA' },
      { codigo: 'CEFALEIA_ALARME_TC', descricao: 'Cefaleia com sinais de alarme ou déficit neurológico', prioridade: 'VERMELHA' },
      { codigo: 'INVESTIGACAO_ELETIVA', descricao: 'Investigação eletiva indicada após exames iniciais', prioridade: 'AZUL' },
    ],
    fonte: FONTE_MS,
  },
  {
    codigo: 'TESTE_ERGOMETRICO',
    nome: 'Teste ergométrico',
    sigtapCode: '0211020060',
    tipo: 'EXAME',
    criterios: [
      { codigo: 'DOR_TORACICA_ESTAVEL', descricao: 'Dor torácica estável com probabilidade intermediária de doença coronariana', prioridade: 'VERDE' },
      { codigo: 'AVALIACAO_FUNCIONAL', descricao: 'Avaliação funcional em cardiopata conhecido ou pré-participação em atividade física intensa', prioridade: 'AZUL' },
    ],
    fonte: FONTE_MS,
  },
  {
    codigo: 'DENSITOMETRIA',
    nome: 'Densitometria óssea',
    sigtapCode: '0204060087',
    tipo: 'EXAME',
    criterios: [
      { codigo: 'MULHER_65_HOMEM_70', descricao: 'Mulher com 65 anos ou mais, homem com 70 ou mais', prioridade: 'AZUL' },
      { codigo: 'FRATURA_FRAGILIDADE', descricao: 'Fratura por fragilidade ou uso prolongado de corticoide', prioridade: 'VERDE' },
    ],
    fonte: FONTE_MS,
  },
  {
    codigo: 'CIRURGIA_CATARATA',
    nome: 'Facoemulsificação (cirurgia de catarata)',
    sigtapCode: '0405050372',
    tipo: 'PROCEDIMENTO',
    criterios: [{ codigo: 'CATARATA_INDICADA', descricao: 'Catarata com indicação cirúrgica pela oftalmologia', prioridade: 'AZUL' }],
    fonte: FONTE_MS,
  },
];

export const PROCEDIMENTO_POR_CODIGO: Record<string, ProcedimentoRegulado> = Object.fromEntries(PROCEDIMENTOS_REGULADOS.map((p) => [p.codigo, p]));

// ─── Regras ───────────────────────────────────────────────────────────────────

const ORDEM: PrioridadeRegulacao[] = ['VERMELHA', 'AMARELA', 'VERDE', 'AZUL'];

/** Maior prioridade entre os critérios marcados (AZUL quando nenhum tem prioridade maior). */
export function prioridadeSugerida(criterios: CriterioEncaminhamento[], marcados: string[]): PrioridadeRegulacao {
  const presentes = criterios.filter((c) => marcados.includes(c.codigo)).map((c) => c.prioridade);
  for (const p of ORDEM) if (presentes.includes(p)) return p;
  return 'AZUL';
}

export function criteriosDe(tipo: TipoSolicitacao, codigo: string): CriterioEncaminhamento[] {
  return tipo === 'CONSULTA' ? (ESPECIALIDADE_POR_CODIGO[codigo]?.criterios ?? []) : (PROCEDIMENTO_POR_CODIGO[codigo]?.criterios ?? []);
}

export interface ExameDisponivel {
  sigtapCode?: string | null;
  analito?: string | null;
  /** Exame com resultado (ou ao menos solicitado) nos últimos meses. */
  at: Date;
}

export interface VerificacaoProtocolo {
  /** Exames mínimos obrigatórios sem resultado no prontuário. */
  examesFaltantes: ExameMinimo[];
  /** Exames opcionais do protocolo que ajudam o regulador. */
  examesRecomendados: ExameMinimo[];
  /** Nenhum critério de encaminhamento foi marcado. */
  semCriterio: boolean;
  /** Prioridade VERMELHA/AMARELA sem justificativa. */
  semJustificativa: boolean;
  /** Pendências que o regulador deve ver (texto curto). */
  pendencias: string[];
}

/** Confere a solicitação contra o protocolo: exames mínimos (últimos 12 meses), critério e justificativa. */
export function verificarProtocolo(
  input: { tipo: TipoSolicitacao; codigo: string; criterios: string[]; prioridade: PrioridadeRegulacao; justificativa?: string | null },
  exames: ExameDisponivel[],
  hoje = new Date(),
): VerificacaoProtocolo {
  const minimos = input.tipo === 'CONSULTA' ? (ESPECIALIDADE_POR_CODIGO[input.codigo]?.examesMinimos ?? []) : [];
  const limite = hoje.getTime() - 365 * 86_400_000;
  const tem = (e: ExameMinimo) => exames.some((x) => x.at.getTime() >= limite && ((x.sigtapCode && x.sigtapCode === e.sigtapCode) || (e.analito && x.analito && x.analito === e.analito)));
  const examesFaltantes = minimos.filter((e) => e.obrigatorio && !tem(e));
  const examesRecomendados = minimos.filter((e) => !e.obrigatorio && !tem(e));
  const semCriterio = criteriosDe(input.tipo, input.codigo).length > 0 && input.criterios.length === 0;
  const semJustificativa = PRIORIDADES[input.prioridade].exigeJustificativa && !(input.justificativa ?? '').trim();
  const pendencias: string[] = [];
  for (const e of examesFaltantes) pendencias.push(`Sem ${e.nome} nos últimos 12 meses`);
  if (semCriterio) pendencias.push('Nenhum critério do protocolo de encaminhamento foi marcado');
  if (semJustificativa) pendencias.push(`Prioridade ${PRIORIDADES[input.prioridade].label.toLowerCase()} sem justificativa`);
  return { examesFaltantes, examesRecomendados, semCriterio, semJustificativa, pendencias };
}

export interface ItemFila {
  id: string;
  prioridade: PrioridadeRegulacao;
  createdAt: Date;
}

/** Fila única: prioridade mais alta primeiro; dentro dela, quem pediu antes. */
export function ordenarFila<T extends ItemFila>(itens: T[]): T[] {
  return [...itens].sort((a, b) => PRIORIDADES[a.prioridade].ordem - PRIORIDADES[b.prioridade].ordem || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

/** Data-limite (prazo-meta) da prioridade a partir da solicitação. */
export function prazoMeta(prioridade: PrioridadeRegulacao, createdAt: Date): Date {
  return new Date(createdAt.getTime() + PRIORIDADES[prioridade].prazoDias * 86_400_000);
}

export function diasEmFila(createdAt: Date, hoje = new Date()): number {
  return Math.max(0, Math.floor((hoje.getTime() - createdAt.getTime()) / 86_400_000));
}

/** Número de protocolo legível: REG-AAAA-NNNNNN. */
export function numeroProtocolo(ano: number, sequencia: number): string {
  return `REG-${ano}-${String(sequencia).padStart(6, '0')}`;
}
