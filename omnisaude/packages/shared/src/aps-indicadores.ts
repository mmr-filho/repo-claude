/**
 * Indicadores do Componente de Qualidade do cofinanciamento federal da APS (Portaria GM/MS 3.493/2024,
 * alterada pelas Portarias 6.907/2025 e 7.799/2025). Pesos, pontuação e faixas da Nota Final conforme a
 * Nota Técnica nº 8/2026-DEAPS/SAPS/MS; fórmulas, boas práticas e parâmetros conforme as notas
 * metodológicas C1 a C7, B1 a B6, M1 e M2 publicadas em gov.br/saude (versões de 2026).
 */

export type Conceito = 'OTIMO' | 'BOM' | 'SUFICIENTE' | 'REGULAR';
export type BlocoIndicador = 'ESF_EAP' | 'ESB' | 'EMULTI';
export type CodigoIndicador = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6' | 'M1' | 'M2';
/** Situação da fonte de dados de uma boa prática dentro do OmniSaúde. */
export type FonteApp = 'DISPONIVEL' | 'PARCIAL' | 'SEM_FONTE';

export const CONCEITOS: Conceito[] = ['OTIMO', 'BOM', 'SUFICIENTE', 'REGULAR'];
export const CONCEITO_LABEL: Record<Conceito, string> = { OTIMO: 'Ótimo', BOM: 'Bom', SUFICIENTE: 'Suficiente', REGULAR: 'Regular' };
/** NT 8/2026, item 4.3.2: pontuação de cada conceito no indicador. */
export const CONCEITO_PONTOS: Record<Conceito, number> = { OTIMO: 1, BOM: 0.75, SUFICIENTE: 0.5, REGULAR: 0.25 };

/** Faixa de classificação: todos os limites informados precisam ser satisfeitos. */
export interface Faixa {
  conceito: Conceito;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

export interface BoaPratica {
  letra: string;
  descricao: string;
  pontos: number;
  /** Como o OmniSaúde apura a boa prática hoje. */
  fonte: FonteApp;
  fonteDescricao: string;
  /** Pontuação integral para eAP (tipo 76), por não ter ACS. */
  eapIntegral?: boolean;
}

export interface IndicadorAps {
  codigo: CodigoIndicador;
  bloco: BlocoIndicador;
  titulo: string;
  tituloCompleto: string;
  objetivo: string;
  numerador: string;
  denominador: string;
  unidade: '%' | 'média';
  polaridade: 'MAIOR_MELHOR' | 'MENOR_MELHOR' | 'FAIXA';
  /** Janela máxima de monitoramento (NT 8/2026, figura 2). */
  janela: string;
  peso: number;
  parametro: Faixa[];
  /** Descrição textual do parâmetro (como consta na nota metodológica). */
  parametroTexto: string;
  boasPraticas?: BoaPratica[];
  populacao?: string;
  fonteDados: string[];
  /** Como o OmniSaúde apura o indicador e o que ainda falta. */
  fonteApp: { situacao: FonteApp; descricao: string };
  notaMetodologica: string;
}

const PCT_PADRAO: Faixa[] = [
  { conceito: 'OTIMO', gt: 75, lte: 100 },
  { conceito: 'BOM', gt: 50, lte: 75 },
  { conceito: 'SUFICIENTE', gt: 25, lte: 50 },
  { conceito: 'REGULAR', lte: 25 },
];
const PCT_PADRAO_TEXTO = 'Ótimo: > 75 e ≤ 100 · Bom: > 50 e ≤ 75 · Suficiente: > 25 e ≤ 50 · Regular: ≤ 25';
const NM = 'https://www.gov.br/saude/pt-br/composicao/saps/publicacoes/fichas-tecnicas';

export const INDICADORES_APS: IndicadorAps[] = [
  {
    codigo: 'C1',
    bloco: 'ESF_EAP',
    titulo: 'Mais acesso à APS',
    tituloCompleto: 'Mais Acesso à Atenção Primária à Saúde (APS)',
    objetivo: 'Verificar o percentual de atendimentos de demanda programada em relação ao total de atendimentos (espontâneos e programados) na APS.',
    numerador: 'Nº de atendimentos por demanda programada (consulta agendada programada, cuidado continuado e consulta agendada) por médicos e enfermeiros da equipe.',
    denominador: 'Nº total de atendimentos individuais da equipe (demanda programada + espontânea: escuta inicial/orientação, consulta no dia e atendimento de urgência).',
    unidade: '%',
    polaridade: 'FAIXA',
    janela: 'Últimos 30 dias (mês de competência).',
    peso: 1,
    parametro: [{ conceito: 'OTIMO', gt: 50, lte: 70 }, { conceito: 'BOM', gt: 30, lte: 50 }, { conceito: 'SUFICIENTE', gt: 10, lte: 30 }, { conceito: 'REGULAR' }],
    parametroTexto: 'Ótimo: > 50 e ≤ 70 · Bom: > 30 e ≤ 50 · Suficiente: > 10 e ≤ 30 · Regular: ≤ 10 ou > 70',
    fonteDados: ['Siaps (MIAI, campo tipo de demanda)', 'SCNES'],
    fonteApp: {
      situacao: 'DISPONIVEL',
      descricao:
        'Registros SOAP/evolução assinados por médicos e enfermeiros lotados na equipe. Atendimento com agendamento conta como demanda programada; sem agendamento (fila do dia ou urgência) conta como espontânea.',
    },
    notaMetodologica: `${NM}/equipe-de-atencao-primaria-e-saude-da-familia/nota-metodologica-c1-mais-acesso/view`,
  },
  {
    codigo: 'C2',
    bloco: 'ESF_EAP',
    titulo: 'Cuidado no desenvolvimento infantil',
    tituloCompleto: 'Cuidado no desenvolvimento infantil na Atenção Primária à Saúde',
    objetivo: 'Avaliar o acesso e o acompanhamento das crianças até dois anos de idade, com captação precoce e cuidado contínuo.',
    numerador: 'Somatório das boas práticas pontuadas para cada criança que completou dois anos no mês avaliado.',
    denominador: 'Nº de crianças que completaram dois anos no mês, vinculadas à equipe.',
    unidade: '%',
    polaridade: 'MAIOR_MELHOR',
    janela: 'Últimos 24 meses (do nascimento aos dois anos). Só entram no quadrimestre os meses com crianças completando dois anos.',
    peso: 2,
    parametro: PCT_PADRAO,
    parametroTexto: PCT_PADRAO_TEXTO,
    populacao: 'Crianças vinculadas à equipe com até dois anos de vida.',
    boasPraticas: [
      { letra: 'A', descricao: '1ª consulta presencial por médico ou enfermeiro até o 30º dia de vida.', pontos: 20, fonte: 'DISPONIVEL', fonteDescricao: 'Registro assinado em atendimento da criança.' },
      { letra: 'B', descricao: 'Pelo menos 9 consultas por médico ou enfermeiro até os dois anos.', pontos: 20, fonte: 'DISPONIVEL', fonteDescricao: 'Registros assinados (SOAP/evolução).' },
      {
        letra: 'C',
        descricao: 'Pelo menos 9 registros simultâneos de peso e altura até os dois anos.',
        pontos: 20,
        fonte: 'DISPONIVEL',
        fonteDescricao: 'Peso e altura na classificação de risco/acolhimento no mesmo dia.',
      },
      {
        letra: 'D',
        descricao: '2 visitas domiciliares do ACS/TACS: a primeira até 30 dias e a segunda até 6 meses de vida.',
        pontos: 20,
        fonte: 'SEM_FONTE',
        fonteDescricao: 'As visitas chegam com o app do ACS (APS-3). Para eAP a pontuação é integral.',
        eapIntegral: true,
      },
      {
        letra: 'E',
        descricao: 'Vacinas penta (3 doses), VIP (3), SCR (2, após 12 meses) e pneumocócica (2) com todas as doses.',
        pontos: 20,
        fonte: 'DISPONIVEL',
        fonteDescricao: 'Vacinas registradas no sistema (sala de vacina chega em APS-8; a API já aceita registros).',
      },
    ],
    fonteDados: ['Siaps (MIAI, MIP, MIVDT, MIV)', 'RNDS (RIA)', 'SCNES'],
    fonteApp: { situacao: 'PARCIAL', descricao: 'Consultas, antropometria e vacinas são apuradas; as visitas domiciliares (20 pontos) só com o app do ACS.' },
    notaMetodologica: `${NM}/equipe-de-atencao-primaria-e-saude-da-familia/nota-metodologica-c2-cuidado-no-desenvolvimento-infantil/view`,
  },
  {
    codigo: 'C3',
    bloco: 'ESF_EAP',
    titulo: 'Cuidado na gestação e puerpério',
    tituloCompleto: 'Cuidado na Gestação e Puerpério na Atenção Primária à Saúde (APS)',
    objetivo: 'Avaliar o acesso e o acompanhamento das gestantes e puérperas, com captação precoce e cuidado contínuo.',
    numerador: 'Somatório das boas práticas pontuadas em cada gestação cujo puerpério (42 dias) terminou no mês avaliado.',
    denominador: 'Nº de gestações com puerpério encerrado no mês, de pessoas vinculadas à equipe.',
    unidade: '%',
    polaridade: 'MAIOR_MELHOR',
    janela: 'Últimos 12 meses (gestação de até 294 dias + 42 dias de puerpério). Só entram os meses com puerpérios encerrados.',
    peso: 2,
    parametro: PCT_PADRAO,
    parametroTexto: PCT_PADRAO_TEXTO,
    populacao: 'Gestantes (CID-10/CIAP-2 de gestação, sem aborto) e puérperas vinculadas à equipe. A DUM é a data de início da condição no cadastro; sem desfecho registrado, a gestação encerra em 294 dias.',
    boasPraticas: [
      { letra: 'A', descricao: '1ª consulta por médico ou enfermeiro até a 12ª semana de gestação.', pontos: 10, fonte: 'DISPONIVEL', fonteDescricao: 'Registro assinado até 84 dias após a DUM.' },
      { letra: 'B', descricao: 'Pelo menos 7 consultas por médico ou enfermeiro na gestação.', pontos: 9, fonte: 'DISPONIVEL', fonteDescricao: 'Registros assinados.' },
      { letra: 'C', descricao: 'Pelo menos 7 aferições de pressão arterial na gestação.', pontos: 9, fonte: 'DISPONIVEL', fonteDescricao: 'PA na classificação de risco/acolhimento.' },
      { letra: 'D', descricao: 'Pelo menos 7 registros simultâneos de peso e altura na gestação.', pontos: 9, fonte: 'DISPONIVEL', fonteDescricao: 'Peso e altura no mesmo dia.' },
      {
        letra: 'E',
        descricao: 'Pelo menos 3 visitas domiciliares do ACS/TACS após a 1ª consulta de pré-natal.',
        pontos: 9,
        fonte: 'SEM_FONTE',
        fonteDescricao: 'App do ACS (APS-3). Integral para eAP.',
        eapIntegral: true,
      },
      { letra: 'F', descricao: 'Vacina dTpa a partir da 20ª semana.', pontos: 9, fonte: 'DISPONIVEL', fonteDescricao: 'Vacina código 57 (dTpa adulto) registrada.' },
      { letra: 'G', descricao: 'Testes/exames de sífilis, HIV, hepatite B e hepatite C no 1º trimestre.', pontos: 9, fonte: 'DISPONIVEL', fonteDescricao: 'Exames solicitados ou com resultado (códigos SIGTAP da nota).' },
      { letra: 'H', descricao: 'Testes/exames de sífilis e HIV no 3º trimestre.', pontos: 9, fonte: 'DISPONIVEL', fonteDescricao: 'Exames solicitados ou com resultado.' },
      { letra: 'I', descricao: 'Pelo menos 1 consulta por médico ou enfermeiro no puerpério.', pontos: 9, fonte: 'DISPONIVEL', fonteDescricao: 'Registro assinado nos 42 dias após o desfecho.' },
      { letra: 'J', descricao: 'Pelo menos 1 visita domiciliar do ACS/TACS no puerpério.', pontos: 9, fonte: 'SEM_FONTE', fonteDescricao: 'App do ACS (APS-3). Integral para eAP.', eapIntegral: true },
      { letra: 'K', descricao: 'Pelo menos 1 atividade em saúde bucal por dentista ou TSB na gestação.', pontos: 9, fonte: 'DISPONIVEL', fonteDescricao: 'Odontograma assinado ou procedimento odontológico registrado.' },
    ],
    fonteDados: ['Siaps (MIAI, MIP, MIVDT, MIV, MIAC, MIAOI)', 'RNDS (RIA)', 'SCNES'],
    fonteApp: { situacao: 'PARCIAL', descricao: 'Consultas, PA, antropometria, exames, dTpa e saúde bucal são apurados; visitas (18 pontos) só com o app do ACS.' },
    notaMetodologica: `${NM}/equipe-de-atencao-primaria-e-saude-da-familia/nota-metodologica-c3-cuidado-na-gestacao-e-puerperio/view`,
  },
  {
    codigo: 'C4',
    bloco: 'ESF_EAP',
    titulo: 'Cuidado da pessoa com diabetes',
    tituloCompleto: 'Cuidado da pessoa com diabetes na Atenção Primária à Saúde',
    objetivo: 'Avaliar o acesso e o acompanhamento contínuo das pessoas com diabetes.',
    numerador: 'Somatório das boas práticas pontuadas para cada pessoa com diabetes no período.',
    denominador: 'Nº de pessoas com diabetes (CID-10 E10, E11, E14; CIAP-2 T89, T90) ativas e vinculadas à equipe.',
    unidade: '%',
    polaridade: 'MAIOR_MELHOR',
    janela: 'Últimos 12 meses.',
    peso: 1,
    parametro: PCT_PADRAO,
    parametroTexto: PCT_PADRAO_TEXTO,
    populacao: 'Pessoas com condição ativa de diabetes no cadastro, vinculadas à equipe.',
    boasPraticas: [
      { letra: 'A', descricao: 'Pelo menos 1 consulta por médico ou enfermeiro nos últimos 6 meses.', pontos: 20, fonte: 'DISPONIVEL', fonteDescricao: 'Registro assinado.' },
      { letra: 'B', descricao: 'Pelo menos 1 aferição de pressão arterial nos últimos 6 meses.', pontos: 15, fonte: 'DISPONIVEL', fonteDescricao: 'PA na classificação de risco/acolhimento.' },
      { letra: 'C', descricao: 'Pelo menos 1 registro de peso e altura nos últimos 12 meses.', pontos: 15, fonte: 'DISPONIVEL', fonteDescricao: 'Peso e altura no mesmo dia.' },
      {
        letra: 'D',
        descricao: '2 visitas domiciliares do ACS/TACS com intervalo mínimo de 30 dias nos últimos 12 meses.',
        pontos: 20,
        fonte: 'SEM_FONTE',
        fonteDescricao: 'App do ACS (APS-3). Integral para eAP.',
        eapIntegral: true,
      },
      {
        letra: 'E',
        descricao: 'Hemoglobina glicada solicitada ou avaliada nos últimos 12 meses.',
        pontos: 15,
        fonte: 'DISPONIVEL',
        fonteDescricao: 'Exame 02.02.01.050-3 (ou analito HBA1C) solicitado ou com resultado.',
      },
      { letra: 'F', descricao: 'Avaliação dos pés nos últimos 12 meses.', pontos: 15, fonte: 'DISPONIVEL', fonteDescricao: 'Procedimento 03.01.04.009-5 (exame do pé diabético) na produção.' },
    ],
    fonteDados: ['Siaps (MIAI, MIAC, MIP, MIVDT)', 'SCNES'],
    fonteApp: { situacao: 'PARCIAL', descricao: 'Tudo apurado, exceto as visitas domiciliares (20 pontos).' },
    notaMetodologica: `${NM}/equipe-de-atencao-primaria-e-saude-da-familia/nota-metodologica-c4-cuidado-da-pessoa-com-diabetes/view`,
  },
  {
    codigo: 'C5',
    bloco: 'ESF_EAP',
    titulo: 'Cuidado da pessoa com hipertensão',
    tituloCompleto: 'Cuidado da pessoa com hipertensão na Atenção Primária à Saúde',
    objetivo: 'Avaliar o acesso e o acompanhamento contínuo das pessoas com hipertensão arterial.',
    numerador: 'Somatório das boas práticas pontuadas para cada pessoa com hipertensão no período.',
    denominador: 'Nº de pessoas com hipertensão (CID-10 I10 a I15, O10, O11; CIAP-2 K86, K87) ativas e vinculadas à equipe.',
    unidade: '%',
    polaridade: 'MAIOR_MELHOR',
    janela: 'Últimos 12 meses.',
    peso: 1,
    parametro: PCT_PADRAO,
    parametroTexto: PCT_PADRAO_TEXTO,
    populacao: 'Pessoas com condição ativa de hipertensão no cadastro, vinculadas à equipe.',
    boasPraticas: [
      { letra: 'A', descricao: 'Pelo menos 1 consulta por médico ou enfermeiro nos últimos 6 meses.', pontos: 25, fonte: 'DISPONIVEL', fonteDescricao: 'Registro assinado.' },
      { letra: 'B', descricao: 'Pelo menos 1 aferição de pressão arterial nos últimos 6 meses.', pontos: 25, fonte: 'DISPONIVEL', fonteDescricao: 'PA na classificação de risco/acolhimento.' },
      { letra: 'C', descricao: 'Pelo menos 1 registro de peso e altura nos últimos 12 meses.', pontos: 25, fonte: 'DISPONIVEL', fonteDescricao: 'Peso e altura no mesmo dia.' },
      {
        letra: 'D',
        descricao: '2 visitas domiciliares do ACS/TACS com intervalo mínimo de 30 dias nos últimos 12 meses.',
        pontos: 25,
        fonte: 'SEM_FONTE',
        fonteDescricao: 'App do ACS (APS-3). Integral para eAP.',
        eapIntegral: true,
      },
    ],
    fonteDados: ['Siaps (MIAI, MIP, MIVDT)', 'SCNES'],
    fonteApp: { situacao: 'PARCIAL', descricao: 'Tudo apurado, exceto as visitas domiciliares (25 pontos).' },
    notaMetodologica: `${NM}/equipe-de-atencao-primaria-e-saude-da-familia/nota-metodologica-c5-cuidado-da-pessoa-com-hipertensao/view`,
  },
  {
    codigo: 'C6',
    bloco: 'ESF_EAP',
    titulo: 'Cuidado da pessoa idosa',
    tituloCompleto: 'Cuidado Integral à Pessoa Idosa na Atenção Primária à Saúde (APS)',
    objetivo: 'Avaliar o acesso e o acompanhamento das pessoas com 60 anos ou mais.',
    numerador: 'Somatório das boas práticas pontuadas para cada pessoa idosa.',
    denominador: 'Nº de pessoas com 60 anos ou mais vinculadas à equipe.',
    unidade: '%',
    polaridade: 'MAIOR_MELHOR',
    janela: 'Últimos 12 meses.',
    peso: 1,
    parametro: PCT_PADRAO,
    parametroTexto: PCT_PADRAO_TEXTO,
    populacao: 'Pessoas com 60 anos ou mais vinculadas à equipe.',
    boasPraticas: [
      { letra: 'A', descricao: 'Pelo menos 1 consulta por médico ou enfermeiro nos últimos 12 meses.', pontos: 25, fonte: 'DISPONIVEL', fonteDescricao: 'Registro assinado.' },
      { letra: 'B', descricao: 'Pelo menos 1 registro simultâneo de peso e altura nos últimos 12 meses.', pontos: 25, fonte: 'DISPONIVEL', fonteDescricao: 'Peso e altura no mesmo dia.' },
      {
        letra: 'C',
        descricao: '2 visitas domiciliares do ACS/TACS com intervalo mínimo de 30 dias nos últimos 12 meses.',
        pontos: 25,
        fonte: 'SEM_FONTE',
        fonteDescricao: 'App do ACS (APS-3). Integral para eAP.',
        eapIntegral: true,
      },
      { letra: 'D', descricao: '1 dose da vacina contra influenza nos últimos 12 meses.', pontos: 25, fonte: 'DISPONIVEL', fonteDescricao: 'Vacina 33 (trivalente) ou 77 (tetravalente) registrada.' },
    ],
    fonteDados: ['Siaps (MIAI, MIP, MIVDT, MIV)', 'RNDS (RIA)', 'SCNES'],
    fonteApp: { situacao: 'PARCIAL', descricao: 'Tudo apurado, exceto as visitas domiciliares (25 pontos).' },
    notaMetodologica: `${NM}/equipe-de-atencao-primaria-e-saude-da-familia/nota-metodologica-c6-cuidado-da-pessoa-idosa/view`,
  },
  {
    codigo: 'C7',
    bloco: 'ESF_EAP',
    titulo: 'Cuidado da mulher na prevenção do câncer',
    tituloCompleto: 'Cuidado da mulher e do homem transgênero na prevenção do câncer na Atenção Primária à Saúde (APS)',
    objetivo: 'Avaliar o acesso de mulheres e homens transgênero de 9 a 69 anos à saúde sexual e reprodutiva, à vacina HPV e ao rastreamento dos cânceres de colo do útero e de mama.',
    numerador: 'Soma das quatro boas práticas, cada uma calculada como proporção na sua faixa etária multiplicada pelos pontos.',
    denominador: 'Pessoas do sexo feminino vinculadas à equipe em cada faixa etária (25–64, 9–14, 14–69 e 50–69 anos).',
    unidade: '%',
    polaridade: 'MAIOR_MELHOR',
    janela: 'Até 60 meses (exame molecular de HPV); 36 meses para o citopatológico; 24 meses para a mamografia; 12 meses para a consulta.',
    peso: 2,
    parametro: PCT_PADRAO,
    parametroTexto: PCT_PADRAO_TEXTO,
    populacao: 'Pessoas do sexo feminino de 9 a 69 anos vinculadas à equipe.',
    boasPraticas: [
      {
        letra: 'A',
        descricao: '25 a 64 anos: 1 exame de rastreamento do câncer do colo do útero coletado, solicitado ou avaliado em 36 meses (teste molecular de HPV: 60 meses).',
        pontos: 20,
        fonte: 'DISPONIVEL',
        fonteDescricao: 'Exame solicitado/avaliado ou coleta registrada na produção.',
      },
      {
        letra: 'B',
        descricao: '9 a 14 anos (sexo feminino): pelo menos 1 dose da vacina HPV.',
        pontos: 30,
        fonte: 'DISPONIVEL',
        fonteDescricao: 'Vacina 67 (quadrivalente) ou 93 (nonavalente) aplicada nessa faixa etária.',
      },
      {
        letra: 'C',
        descricao: '14 a 69 anos: 1 atendimento sobre saúde sexual e reprodutiva nos últimos 12 meses.',
        pontos: 30,
        fonte: 'DISPONIVEL',
        fonteDescricao: 'Registro assinado com CID-10/CIAP-2 de saúde sexual e reprodutiva da nota.',
      },
      {
        letra: 'D',
        descricao: '50 a 69 anos: 1 mamografia solicitada ou avaliada nos últimos 24 meses.',
        pontos: 20,
        fonte: 'DISPONIVEL',
        fonteDescricao: 'Exame 02.04.03.003-0 ou 02.04.03.018-8 solicitado ou com resultado.',
      },
    ],
    fonteDados: ['Siaps (MIAI, MIP)', 'RNDS (RIA)', 'SCNES'],
    fonteApp: { situacao: 'DISPONIVEL', descricao: 'Apurado a partir de exames, vacinas e registros assinados. Pessoas trans são consideradas pelo sexo do cadastro.' },
    notaMetodologica: `${NM}/equipe-de-atencao-primaria-e-saude-da-familia/nota-metodologica-c7-cuidado-da-mulher-na-prevencao-do-cancer/view`,
  },
  {
    codigo: 'B1',
    bloco: 'ESB',
    titulo: 'Primeira consulta odontológica programada',
    tituloCompleto: 'Cobertura de primeira consulta programada por equipe de Saúde Bucal (eSB)',
    objetivo: 'Avaliar o acesso da população à primeira consulta odontológica programada.',
    numerador: 'Nº de pessoas com primeira consulta odontológica programada (03.01.01.015-3), uma vez por dentista a cada 12 meses.',
    denominador: 'Nº de pessoas vinculadas à eSF/eAP de referência da eSB (eSB 20h vinculada a eSF: metade).',
    unidade: '%',
    polaridade: 'MAIOR_MELHOR',
    janela: 'Últimos 30 dias (mês de competência).',
    peso: 2,
    parametro: [
      { conceito: 'OTIMO', gt: 1.25 },
      { conceito: 'BOM', gt: 0.75, lte: 1.25 },
      { conceito: 'SUFICIENTE', gt: 0.25, lte: 0.75 },
      { conceito: 'REGULAR', lte: 0.25 },
    ],
    parametroTexto: 'Ótimo: > 1,25 · Bom: > 0,75 e ≤ 1,25 · Suficiente: > 0,25 e ≤ 0,75 · Regular: ≤ 0,25',
    fonteDados: ['Siaps (MIAOI)', 'SCNES'],
    fonteApp: {
      situacao: 'PARCIAL',
      descricao: 'Produção 03.01.01.015-3 dos dentistas da equipe; população de referência = pessoas vinculadas às eSF/eAP da mesma unidade. A tela de atendimento odontológico chega depois.',
    },
    notaMetodologica: `${NM}/equipe-de-saude-bucal/nota-metodologica-b1-primeira-consulta-programada/view`,
  },
  {
    codigo: 'B2',
    bloco: 'ESB',
    titulo: 'Tratamento odontológico concluído',
    tituloCompleto: 'Percentual de tratamentos concluídos em relação às primeiras consultas odontológicas programadas por eSB',
    objetivo: 'Avaliar a resolutividade da eSB: quanto dos tratamentos iniciados é concluído.',
    numerador: 'Nº de pessoas com conduta “tratamento concluído” registrada pela eSB.',
    denominador: 'Nº de pessoas com primeira consulta odontológica programada pela eSB.',
    unidade: '%',
    polaridade: 'MAIOR_MELHOR',
    janela: 'Últimos 30 dias (mês de competência).',
    peso: 2,
    parametro: PCT_PADRAO,
    parametroTexto: PCT_PADRAO_TEXTO,
    fonteDados: ['Siaps (MIAOI)', 'SCNES'],
    fonteApp: { situacao: 'PARCIAL', descricao: 'Conduta “tratamento concluído” no odontograma assinado; primeiras consultas pela produção 03.01.01.015-3.' },
    notaMetodologica: `${NM}/equipe-de-saude-bucal/nota-metodologica-b2-tratamento-concluido/view`,
  },
  {
    codigo: 'B3',
    bloco: 'ESB',
    titulo: 'Taxa de exodontias',
    tituloCompleto: 'Taxa de exodontias em relação ao total de procedimentos preventivos e curativos realizados pela eSB',
    objetivo: 'Avaliar se a eSB atua no início da história da doença, com menos extrações em relação aos procedimentos individuais.',
    numerador: 'Nº de exodontias de dente permanente (04.14.02.013-8) e múltiplas com alveoloplastia (04.14.02.014-6).',
    denominador: 'Nº de procedimentos individuais preventivos, curativos e exodontias (lista da nota).',
    unidade: '%',
    polaridade: 'FAIXA',
    janela: 'Últimos 30 dias (mês de competência).',
    peso: 2,
    parametro: [{ conceito: 'OTIMO', gte: 3, lt: 10 }, { conceito: 'BOM', gte: 10, lt: 12 }, { conceito: 'SUFICIENTE', gte: 12, lt: 14 }, { conceito: 'REGULAR' }],
    parametroTexto: 'Ótimo: ≥ 3 e < 10 · Bom: ≥ 10 e < 12 · Suficiente: ≥ 12 e < 14 · Regular: < 3 ou ≥ 14',
    fonteDados: ['Siaps (MIAOI)'],
    fonteApp: { situacao: 'DISPONIVEL', descricao: 'Produção SIGTAP dos dentistas e TSB da equipe.' },
    notaMetodologica: `${NM}/equipe-de-saude-bucal/nota-metodologica-b3-taxa-de-exodontia/view`,
  },
  {
    codigo: 'B4',
    bloco: 'ESB',
    titulo: 'Escovação supervisionada (6 a 12 anos)',
    tituloCompleto: 'Proporção de crianças de 6 a 12 anos beneficiadas pela ação coletiva de escovação dental supervisionada pela eSB',
    objetivo: 'Mensurar a cobertura da escovação supervisionada em idade escolar.',
    numerador: 'Nº de crianças de 6 a 12 anos participantes da ação coletiva de escovação (01.01.02.003-1).',
    denominador: 'Nº de crianças de 6 a 12 anos vinculadas à eSF/eAP de referência.',
    unidade: '%',
    polaridade: 'MAIOR_MELHOR',
    janela: 'Últimos 30 dias (mês de competência).',
    peso: 1,
    parametro: [
      { conceito: 'OTIMO', gt: 1 },
      { conceito: 'BOM', gt: 0.5, lte: 1 },
      { conceito: 'SUFICIENTE', gt: 0.25, lte: 0.5 },
      { conceito: 'REGULAR', lte: 0.25 },
    ],
    parametroTexto: 'Ótimo: > 1 · Bom: > 0,5 e ≤ 1 · Suficiente: > 0,25 e ≤ 0,5 · Regular: ≤ 0,25',
    fonteDados: ['Siaps (MIAC)', 'SCNES'],
    fonteApp: { situacao: 'SEM_FONTE', descricao: 'Depende da ficha de atividade coletiva (grupos, APS-7).' },
    notaMetodologica: `${NM}/equipe-de-saude-bucal/nota-metodologica-b4-escovacao-supervisionada-em-faixa-etaria-escolar-de-6-a-12-anos/view`,
  },
  {
    codigo: 'B5',
    bloco: 'ESB',
    titulo: 'Procedimentos odontológicos preventivos',
    tituloCompleto: 'Proporção de procedimentos odontológicos preventivos entre os procedimentos individuais da eSB',
    objetivo: 'Avaliar a oferta de ações preventivas em relação ao total de procedimentos odontológicos individuais.',
    numerador: 'Nº de procedimentos preventivos (cariostático, selante, flúor, evidenciação de placa, orientação de higiene bucal e de próteses, profilaxia).',
    denominador: 'Nº de procedimentos odontológicos individuais (lista da nota).',
    unidade: '%',
    polaridade: 'FAIXA',
    janela: 'Últimos 30 dias (mês de competência).',
    peso: 2,
    parametro: [{ conceito: 'OTIMO', gte: 65, lte: 85 }, { conceito: 'BOM', gte: 55, lt: 65 }, { conceito: 'SUFICIENTE', gte: 40, lt: 55 }, { conceito: 'REGULAR' }],
    parametroTexto: 'Ótimo: ≥ 65 e ≤ 85 · Bom: ≥ 55 e < 65 · Suficiente: ≥ 40 e < 55 · Regular: < 40 ou > 85',
    fonteDados: ['Siaps (MIAOI)'],
    fonteApp: { situacao: 'DISPONIVEL', descricao: 'Produção SIGTAP dos dentistas e TSB da equipe.' },
    notaMetodologica: `${NM}/equipe-de-saude-bucal/nota-metodologica-b5-procedimentos-odontologicos-preventivos/view`,
  },
  {
    codigo: 'B6',
    bloco: 'ESB',
    titulo: 'Tratamento restaurador atraumático',
    tituloCompleto: 'Proporção de tratamentos restauradores atraumáticos (ART) entre os procedimentos restauradores da eSB',
    objetivo: 'Estimular a oferta do ART sempre que indicado.',
    numerador: 'Nº de procedimentos 03.07.01.007-4 (tratamento restaurador atraumático).',
    denominador: 'Nº de procedimentos restauradores (resina em dentes decíduos e permanentes, ionômero e ART).',
    unidade: '%',
    polaridade: 'MAIOR_MELHOR',
    janela: 'Últimos 30 dias (mês de competência).',
    peso: 1,
    parametro: [
      { conceito: 'OTIMO', gt: 8 },
      { conceito: 'BOM', gt: 6, lte: 8 },
      { conceito: 'SUFICIENTE', gt: 3, lte: 6 },
      { conceito: 'REGULAR', lte: 3 },
    ],
    parametroTexto: 'Ótimo: > 8 · Bom: > 6 e ≤ 8 · Suficiente: > 3 e ≤ 6 · Regular: ≤ 3',
    fonteDados: ['Siaps (MIAOI)'],
    fonteApp: { situacao: 'DISPONIVEL', descricao: 'Produção SIGTAP dos dentistas e TSB da equipe.' },
    notaMetodologica: `${NM}/equipe-de-saude-bucal/nota-metodologica-b6-tratamento-restaurador-atraumatico/view`,
  },
  {
    codigo: 'M1',
    bloco: 'EMULTI',
    titulo: 'Média de atendimentos por pessoa pela eMulti',
    tituloCompleto: 'Média de atendimentos por pessoa pela eMulti na Atenção Primária à Saúde (APS)',
    objetivo: 'Mensurar o acesso da população aos atendimentos individuais e coletivos da eMulti.',
    numerador: 'Nº de atendimentos individuais e coletivos realizados pela eMulti nos últimos 4 meses.',
    denominador: 'Nº de pessoas atendidas pela eMulti no mesmo período.',
    unidade: 'média',
    polaridade: 'MAIOR_MELHOR',
    janela: 'Últimos 4 meses.',
    peso: 6,
    parametro: [
      { conceito: 'OTIMO', gt: 3 },
      { conceito: 'BOM', gt: 2, lte: 3 },
      { conceito: 'SUFICIENTE', gt: 1, lte: 2 },
      { conceito: 'REGULAR', lte: 1 },
    ],
    parametroTexto: 'Ótimo: > 3 · Bom: > 2 e ≤ 3 · Suficiente: > 1 e ≤ 2 · Regular: ≤ 1',
    fonteDados: ['Siaps (MIAI, MIAC)', 'SCNES'],
    fonteApp: { situacao: 'PARCIAL', descricao: 'Registros assinados dos profissionais lotados na eMulti; atividades coletivas chegam com os grupos (APS-7).' },
    notaMetodologica: `${NM}/equipes-multiprofissionais-emulti/nota-metodologica-m1-media-de-atendimentos-por-pessoa-pela-emulti-na-aps/view`,
  },
  {
    codigo: 'M2',
    bloco: 'EMULTI',
    titulo: 'Ações interprofissionais da eMulti',
    tituloCompleto: 'Ações interprofissionais realizadas pela eMulti na Atenção Primária à Saúde (APS)',
    objetivo: 'Monitorar a proporção de ações realizadas de forma compartilhada pela eMulti com outros profissionais da APS.',
    numerador: 'Nº de ações compartilhadas (atendimentos e atividades com 2 ou mais profissionais, sendo 1 da eMulti, e compartilhamento do cuidado respondido).',
    denominador: 'Nº de ações realizadas pela eMulti nos últimos 4 meses.',
    unidade: '%',
    polaridade: 'MAIOR_MELHOR',
    janela: 'Últimos 4 meses.',
    peso: 4,
    parametro: [
      { conceito: 'OTIMO', gt: 5 },
      { conceito: 'BOM', gt: 2.5, lte: 5 },
      { conceito: 'SUFICIENTE', gt: 1, lte: 2.5 },
      { conceito: 'REGULAR', lte: 1 },
    ],
    parametroTexto: 'Ótimo: > 5 · Bom: > 2,5 e ≤ 5 · Suficiente: > 1 e ≤ 2,5 · Regular: ≤ 1',
    fonteDados: ['Siaps (MIAI, MIAC, MIAOI, compartilhamento do cuidado)', 'SCNES'],
    fonteApp: {
      situacao: 'PARCIAL',
      descricao: 'Atendimento compartilhado = registros assinados de 2 ou mais profissionais no mesmo atendimento, um deles da eMulti. Atividades coletivas e compartilhamento do cuidado ainda sem fonte.',
    },
    notaMetodologica: `${NM}/equipes-multiprofissionais-emulti/nota-metodologica-m2-acoes-interprofissionais-realizadas-pela-emulti-na-aps/view`,
  },
];

export const INDICADOR_POR_CODIGO: Record<CodigoIndicador, IndicadorAps> = Object.fromEntries(INDICADORES_APS.map((i) => [i.codigo, i])) as Record<CodigoIndicador, IndicadorAps>;

/** Bloco de indicadores por tipo de equipe do CNES (70 eSF, 76 eAP, 71 eSB, 72 eMulti). */
export function blocoDaEquipe(typeCode: string): BlocoIndicador | null {
  const t = String(typeCode).padStart(2, '0');
  if (t === '70' || t === '76') return 'ESF_EAP';
  if (t === '71') return 'ESB';
  if (t === '72') return 'EMULTI';
  return null;
}

export function indicadoresDoBloco(bloco: BlocoIndicador): IndicadorAps[] {
  return INDICADORES_APS.filter((i) => i.bloco === bloco);
}

function dentro(valor: number, f: Faixa): boolean {
  if (f.gt !== undefined && !(valor > f.gt)) return false;
  if (f.gte !== undefined && !(valor >= f.gte)) return false;
  if (f.lt !== undefined && !(valor < f.lt)) return false;
  if (f.lte !== undefined && !(valor <= f.lte)) return false;
  return true;
}

/** Conceito de um resultado pelo parâmetro do indicador (null quando não há resultado). */
export function conceitoDoIndicador(codigo: CodigoIndicador, valor: number | null | undefined): Conceito | null {
  if (valor === null || valor === undefined || Number.isNaN(valor)) return null;
  const ind = INDICADOR_POR_CODIGO[codigo];
  for (const f of ind.parametro) if (dentro(valor, f)) return f.conceito;
  return 'REGULAR';
}

/** Nota final do componente III: soma dos pontos do conceito ponderados pelo peso (NT 8/2026, quadro 2). */
export function notaFinal(itens: { peso: number; conceito: Conceito | null }[]): number {
  return Math.round(itens.reduce((s, i) => s + (i.conceito ? CONCEITO_PONTOS[i.conceito] * i.peso : 0), 0) * 100) / 100;
}

/** Classificação da nota final do componente III (NT 8/2026, quadro 6). */
export function classificacaoNotaFinal(nota: number): Conceito {
  if (nota > 7.5) return 'OTIMO';
  if (nota >= 5) return 'BOM';
  if (nota > 2.5) return 'SUFICIENTE';
  return 'REGULAR';
}

/** Média dos meses monitorados do quadrimestre (meses sem resultado não entram). */
export function mediaQuadrimestre(meses: (number | null)[]): number | null {
  const v = meses.filter((m): m is number => m !== null && m !== undefined && !Number.isNaN(m));
  if (!v.length) return null;
  return Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100;
}

// ───────────────────────────── Valores do componente de qualidade ─────────────────────────────

export type ModalidadeEquipe = 'ESF_40H' | 'EAP_30H' | 'EAP_20H' | 'ESB_I' | 'ESB_II' | 'ESB_I_QUILOMBOLA' | 'ESB_II_QUILOMBOLA' | 'EMULTI_AMPLIADA' | 'EMULTI_COMPLEMENTAR' | 'EMULTI_ESTRATEGICA';

export const MODALIDADE_LABEL: Record<ModalidadeEquipe, string> = {
  ESF_40H: 'eSF 40h',
  EAP_30H: 'eAP 30h',
  EAP_20H: 'eAP 20h',
  ESB_I: 'eSB modalidade I',
  ESB_II: 'eSB modalidade II',
  ESB_I_QUILOMBOLA: 'eSB modalidade I (quilombola/assentamento)',
  ESB_II_QUILOMBOLA: 'eSB modalidade II (quilombola/assentamento)',
  EMULTI_AMPLIADA: 'eMulti ampliada',
  EMULTI_COMPLEMENTAR: 'eMulti complementar',
  EMULTI_ESTRATEGICA: 'eMulti estratégica',
};

/** Modalidades possíveis por tipo de equipe do CNES. */
export function modalidadesDoTipo(typeCode: string): ModalidadeEquipe[] {
  const t = String(typeCode).padStart(2, '0');
  if (t === '70') return ['ESF_40H'];
  if (t === '76') return ['EAP_30H', 'EAP_20H'];
  if (t === '71') return ['ESB_I', 'ESB_II', 'ESB_I_QUILOMBOLA', 'ESB_II_QUILOMBOLA'];
  if (t === '72') return ['EMULTI_AMPLIADA', 'EMULTI_COMPLEMENTAR', 'EMULTI_ESTRATEGICA'];
  return [];
}

export function modalidadePadrao(typeCode: string): ModalidadeEquipe | null {
  return modalidadesDoTipo(typeCode)[0] ?? null;
}

/** Valores mensais do componente de qualidade por classificação (Portaria GM/MS 7.799/2025, anexo XCIX-B), em reais. */
export const VALOR_QUALIDADE: Record<ModalidadeEquipe, Record<Conceito, number>> = {
  ESF_40H: { OTIMO: 8000, BOM: 6000, SUFICIENTE: 4000, REGULAR: 2000 },
  EAP_30H: { OTIMO: 4000, BOM: 3000, SUFICIENTE: 2000, REGULAR: 1000 },
  EAP_20H: { OTIMO: 3000, BOM: 2250, SUFICIENTE: 1500, REGULAR: 750 },
  ESB_I: { OTIMO: 2449, BOM: 1836.75, SUFICIENTE: 1224.5, REGULAR: 612.25 },
  ESB_II: { OTIMO: 3267, BOM: 2450.25, SUFICIENTE: 1633.5, REGULAR: 816.75 },
  ESB_I_QUILOMBOLA: { OTIMO: 3673.5, BOM: 2755.13, SUFICIENTE: 1836.75, REGULAR: 918.38 },
  ESB_II_QUILOMBOLA: { OTIMO: 4900.5, BOM: 3675.38, SUFICIENTE: 2450.25, REGULAR: 1225.13 },
  EMULTI_AMPLIADA: { OTIMO: 9000, BOM: 6750, SUFICIENTE: 4500, REGULAR: 2250 },
  EMULTI_COMPLEMENTAR: { OTIMO: 6000, BOM: 4500, SUFICIENTE: 3000, REGULAR: 1500 },
  EMULTI_ESTRATEGICA: { OTIMO: 3000, BOM: 2250, SUFICIENTE: 1500, REGULAR: 750 },
};

export const MESES_POR_QUADRIMESTRE = 4;

/** Quadrimestre de uma competência AAAA-MM: meses que o compõem e o número (1 a 3). */
export function quadrimestreDe(competencia: string): { numero: 1 | 2 | 3; ano: number; meses: string[]; rotulo: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(competencia);
  if (!m) throw new Error(`Competência inválida: ${competencia} (use AAAA-MM)`);
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12) throw new Error(`Competência inválida: ${competencia}`);
  const numero = (Math.floor((mes - 1) / 4) + 1) as 1 | 2 | 3;
  const inicio = (numero - 1) * 4 + 1;
  const meses = [0, 1, 2, 3].map((i) => `${ano}-${String(inicio + i).padStart(2, '0')}`);
  return { numero, ano, meses, rotulo: `${numero}º quadrimestre de ${ano}` };
}

// ───────────────────────────── Códigos usados na apuração ─────────────────────────────

/** CBO (prefixos de família) de médicos e enfermeiros para as consultas das boas práticas. */
export const CBO_MEDICO_ENFERMEIRO_PREFIXOS = ['2231', '2251', '2252', '2253', '2235'];
/** CBO aceitos no indicador C1 (nota metodológica, item 24-c). */
export const CBO_C1 = ['225142', '225170', '225130', '225125', '225250', '223565', '223505'];
export const CBO_DENTISTA_PREFIXO = '2232';
export const CBO_TSB_PREFIXO = '3224';

export const CID_GESTACAO_PREFIXOS = [
  'O10',
  'O11',
  'O12',
  'O13',
  'O14',
  'O15',
  'O16',
  'O20',
  'O21',
  'O22',
  'O23',
  'O24',
  'O25',
  'O26',
  'O28',
  'O29',
  'O30',
  'O31',
  'O32',
  'O33',
  'O34',
  'O35',
  'O36',
  'O40',
  'O41',
  'O43',
  'O44',
  'O46',
  'O47',
  'O48',
  'O752',
  'O753',
  'O98',
  'O990',
  'O991',
  'O992',
  'O993',
  'O994',
  'O995',
  'O996',
  'O997',
  'Z321',
  'Z33',
  'Z34',
  'Z35',
  'Z36',
  'Z640',
];
export const CIAP_GESTACAO = ['W03', 'W78', 'W79', 'W81', 'W84', 'W85'];
export const CID_ABORTO_PREFIXOS = ['O02', 'O03', 'O04', 'O05', 'O06', 'Z303'];
export const CIAP_ABORTO = ['W82', 'W83'];
export const CID_DIABETES_PREFIXOS = ['E10', 'E11', 'E14'];
export const CIAP_DIABETES = ['T89', 'T90'];
export const CID_HIPERTENSAO_PREFIXOS = ['I10', 'I11', 'I12', 'I13', 'I15', 'O10', 'O11'];
export const CIAP_HIPERTENSAO = ['K86', 'K87'];
/** Saúde sexual e reprodutiva (C7, boa prática C): CIAP-2 e prefixos de CID-10 da nota. */
export const CIAP_SSR = [
  'B25',
  'W02',
  'W10',
  'W11',
  'W12',
  'W13',
  'W14',
  'W15',
  'W79',
  'W82',
  'X01',
  'X02',
  'X03',
  'X04',
  'X05',
  'X06',
  'X07',
  'X08',
  'X09',
  'X10',
  'X11',
  'X12',
  'X13',
  'X23',
  'X24',
  'X82',
  'X89',
  'Y14',
];
export const CID_SSR_PREFIXOS = [
  'N80',
  'N91',
  'N92',
  'N93',
  'N94',
  'N95',
  'N96',
  'N97',
  'O03',
  'O04',
  'R102',
  'T742',
  'Y05',
  'Z123',
  'Z124',
  'Z205',
  'Z206',
  'Z30',
  'Z31',
  'Z320',
  'Z600',
  'Z630',
  'Z640',
  'Z70',
  'Z717',
  'Z725',
];

export const SIGTAP_APS = {
  AFERICAO_PA: '0301100039',
  AVALIACAO_ANTROPOMETRICA: '0101040024',
  MEDICAO_PESO: '0101040083',
  MEDICAO_ALTURA: '0101040075',
  HEMOGLOBINA_GLICADA: '0202010503',
  EXAME_PE_DIABETICO: '0301040095',
  PRIMEIRA_CONSULTA_ODONTO: '0301010153',
  ESCOVACAO_SUPERVISIONADA: '0101020031',
  MAMOGRAFIA: ['0204030030', '0204030188'],
  CITOPATOLOGICO: ['0201020033', '0203010086', '0203010019', '0201020076', '0201020084'],
  HPV_MOLECULAR: '0202100251',
  TESTES_HIV: ['0214010040', '0214010279', '0214010058', '0213010780', '0213010500', '0202030300'],
  TESTES_SIFILIS: ['0214010074', '0214010082', '0214010252', '0202031098', '0202031110', '0202031179'],
  TESTES_HEPATITE_B: ['0214010104', '0214010236', '0202030784', '0202030970', '0213010208'],
  TESTES_HEPATITE_C: ['0214010090', '0214010309', '0202030059', '0202030679'],
  EXODONTIAS: ['0414020138', '0414020146'],
  ODONTO_PREVENTIVOS: ['0101020058', '0101020066', '0101020074', '0101020082', '0101020104', '0101020120', '0307030040'],
  ODONTO_RESTAURADORES: ['0307010031', '0307010082', '0307010104', '0307010112', '0307010120', '0307010074'],
  ART: '0307010074',
  /** Denominador de B3 e B5: procedimentos individuais preventivos, curativos e exodontias. */
  ODONTO_INDIVIDUAIS: [
    '0101020058',
    '0101020066',
    '0101020074',
    '0101020082',
    '0101020090',
    '0101020104',
    '0101020120',
    '0307010015',
    '0307010031',
    '0307010066',
    '0307010074',
    '0307010082',
    '0307010104',
    '0307010112',
    '0307010120',
    '0307010155',
    '0307020010',
    '0307020029',
    '0307020070',
    '0307030024',
    '0307030040',
    '0307030059',
    '0307030067',
    '0307030075',
    '0307030083',
    '0307050017',
    '0414020138',
    '0414020146',
  ],
} as const;

/** Componentes vacinais por código de imunobiológico do e-SUS/RNDS. */
export type ComponenteVacinal =
  | 'DTP'
  | 'HEPB'
  | 'HIB'
  | 'VIP'
  | 'SCR'
  | 'PNEUMO'
  | 'INFLUENZA'
  | 'DTPA_ADULTO'
  | 'HPV'
  | 'BCG'
  | 'ROTA'
  | 'MENINGO_C'
  | 'MENINGO_ACWY'
  | 'FEBRE_AMARELA'
  | 'VARICELA'
  | 'HEPA'
  | 'DT'
  | 'COVID';
export const COMPONENTES_POR_CODIGO: Record<string, ComponenteVacinal[]> = {
  '09': ['HEPB'],
  '14': ['FEBRE_AMARELA'],
  '15': ['BCG'],
  '17': ['HIB'],
  '22': ['VIP'],
  '24': ['SCR'],
  '25': ['DT'],
  '26': ['PNEUMO'],
  '29': ['DTP', 'VIP', 'HIB'],
  '33': ['INFLUENZA'],
  '34': ['VARICELA'],
  '35': ['HEPA'],
  '39': ['DTP', 'HIB'],
  '41': ['MENINGO_C'],
  '42': ['DTP', 'HEPB', 'HIB'],
  '43': ['DTP', 'HEPB', 'VIP', 'HIB'],
  '45': ['ROTA'],
  '46': ['DTP'],
  '47': ['DTP'],
  '55': ['HEPA'],
  '56': ['SCR', 'VARICELA'],
  '57': ['DTPA_ADULTO'],
  '58': ['DTP', 'VIP'],
  '59': ['PNEUMO'],
  '62': ['HEPA', 'HEPB'],
  '63': ['HEPA', 'HEPB'],
  '65': ['ROTA'],
  '67': ['HPV'],
  '73': ['SCR', 'VARICELA'],
  '74': ['MENINGO_C', 'MENINGO_ACWY'],
  '77': ['INFLUENZA'],
  '83': ['HEPA'],
  '84': ['FEBRE_AMARELA'],
  '85': ['COVID'],
  '86': ['COVID'],
  '87': ['COVID'],
  '88': ['COVID'],
  '89': ['COVID'],
  '93': ['HPV'],
  '97': ['COVID'],
  '98': ['COVID'],
  '99': ['COVID'],
  '102': ['COVID'],
  '103': ['COVID'],
  '105': ['COVID'],
  '112': ['COVID'],
  '114': ['COVID'],
  '106': ['PNEUMO'],
  '107': ['PNEUMO'],
};

const NOME_PARA_CODIGO: [RegExp, string][] = [
  [/covid|coronavac|comirnaty|spikevax|covishield/i, '87'],
  [/acwy/i, '74'],
  [/dupla\s*adulto|difteria e t[ée]tano adulto|\bdt\b/i, '25'],
  [/\bbcg\b/i, '15'],
  [/rotav/i, '45'],
  [/mening/i, '41'],
  [/febre\s*amarela/i, '14'],
  [/hepatite\s*a\b|hep\s*a\b/i, '55'],
  [/varicela/i, '34'],
  [/hexa/i, '43'],
  [/penta/i, '42'],
  [/tetra\s*viral|scrv/i, '56'],
  [/tetra/i, '39'],
  [/dtpa.*adult|dtpa\b(?!.*infantil)/i, '57'],
  [/dtp/i, '46'],
  [/\bvip\b|p[óo]lio.*inativ|inativ.*p[óo]lio/i, '22'],
  [/\bhib\b|haemophilus/i, '17'],
  [/hepatite\s*b|hep\s*b|hepb/i, '09'],
  [/\bscr\b|tr[íi]plice\s*viral|sarampo/i, '24'],
  [/pneumo/i, '26'],
  [/influenza|gripe/i, '33'],
  [/hpv|papiloma/i, '67'],
];

/** Código do imunobiológico a partir do código informado (numérico do e-SUS) ou do nome da vacina. */
export function codigoImunobiologico(code: string | null | undefined, name: string | null | undefined): string | null {
  const c = (code ?? '').trim();
  if (/^\d{1,3}$/.test(c) && COMPONENTES_POR_CODIGO[c.replace(/^0+(?=\d)/, '').padStart(2, '0')]) return c.replace(/^0+(?=\d)/, '').padStart(2, '0');
  const texto = `${c} ${name ?? ''}`;
  for (const [re, codigo] of NOME_PARA_CODIGO) if (re.test(texto)) return codigo;
  return null;
}

export function componentesDaVacina(code: string | null | undefined, name: string | null | undefined): ComponenteVacinal[] {
  const codigo = codigoImunobiologico(code, name);
  return codigo ? (COMPONENTES_POR_CODIGO[codigo] ?? []) : [];
}
