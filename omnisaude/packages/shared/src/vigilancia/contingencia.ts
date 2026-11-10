/**
 * Plano de contingência das arboviroses (VIG-1c): estágios, critérios de acionamento e ações por eixo, como dado
 * editável. O sistema avalia os critérios toda semana e SUGERE o estágio; a vigilância municipal decide e registra o
 * acionamento. Modelo padrão: Apêndice B do Plano de Contingência Nacional para Dengue, Chikungunya e Zika (MS, 2025).
 * Ver a pesquisa da semana 27 (contingencia-surto-negativa.md, A2 a A12).
 */
import { arredondar, type StatusSemana } from './diagrama';
import { deslocarSemana } from './semana';

/** Estágio do plano; ordem 0 = normalidade. */
export interface EstagioPlano {
  chave: string;
  nome: string;
  ordem: number;
}

export type TipoCriterio =
  | 'CANAL_ACIMA_CENTRO'
  | 'CANAL_ENTRE_CENTRO_E_LS'
  | 'CANAL_ACIMA_LS'
  | 'PERCENTUAL_GRAVES'
  | 'LETALIDADE'
  | 'LETALIDADE_GRAVES'
  | 'OBITOS_INVESTIGACAO_PERCENTUAL'
  | 'INCIDENCIA_ACUMULADA'
  | 'MANUAL';

export const ROTULO_TIPO_CRITERIO: Record<TipoCriterio, string> = {
  CANAL_ACIMA_CENTRO: 'Acima do centro do canal',
  CANAL_ENTRE_CENTRO_E_LS: 'Entre o centro e o limite superior',
  CANAL_ACIMA_LS: 'Acima do limite superior',
  PERCENTUAL_GRAVES: 'Percentual de casos graves',
  LETALIDADE: 'Letalidade',
  LETALIDADE_GRAVES: 'Letalidade entre os graves',
  OBITOS_INVESTIGACAO_PERCENTUAL: 'Óbitos em investigação (percentual)',
  INCIDENCIA_ACUMULADA: 'Incidência acumulada',
  MANUAL: 'Avaliado pela vigilância',
};

/** Critério de um estágio. Os de canal contam semanas; os percentuais comparam com o limiar. */
export interface CriterioPlano {
  id: string;
  estagio: string;
  /** Grupos de agravo do catálogo (ex.: dengue). Vazio = todos os agravos do plano. */
  agravos: string[];
  tipo: TipoCriterio;
  descricao: string;
  /** Semanas exigidas (critérios de canal). */
  semanas?: number;
  /** CONSECUTIVAS = as últimas N completas; K_DE_N = pelo menos k das últimas n. */
  modo?: 'CONSECUTIVAS' | 'K_DE_N';
  k?: number;
  n?: number;
  /** Limiar dos critérios numéricos (percentual ou incidência). */
  limiar?: number;
  comparador?: '>' | '>=';
  /** Documento e página. */
  fonte?: string;
}

export type EixoAcao = 'GESTAO' | 'VIGILANCIA' | 'LABORATORIO' | 'VETORES' | 'APS' | 'ATENCAO_ESPECIALIZADA' | 'COMUNICACAO';

export const ROTULO_EIXO_ACAO: Record<EixoAcao, string> = {
  GESTAO: 'Gestão',
  VIGILANCIA: 'Vigilância epidemiológica',
  LABORATORIO: 'Laboratório',
  VETORES: 'Controle vetorial',
  APS: 'Atenção primária',
  ATENCAO_ESPECIALIZADA: 'Atenção especializada',
  COMUNICACAO: 'Comunicação',
};

export interface AcaoPlano {
  estagio: string;
  eixo: EixoAcao;
  descricao: string;
}

export interface PlanoContingencia {
  estagios: EstagioPlano[];
  /** Grupos de agravo do plano. */
  agravos: string[];
  /** QUALQUER: um critério atendido basta (o "E/OU" do MS). DOIS_OU_MAIS: regra da SES-MG. */
  combinacao: 'QUALQUER' | 'DOIS_OU_MAIS';
  criterios: CriterioPlano[];
  acoes: AcaoPlano[];
  desmobilizacao: { semanas: number; descricao: string };
}

/** Situação das ações do checklist do acionamento. */
export type StatusAcao = 'PENDENTE' | 'EM_ANDAMENTO' | 'FEITA' | 'NAO_SE_APLICA';

export const ROTULO_STATUS_ACAO: Record<StatusAcao, string> = { PENDENTE: 'Pendente', EM_ANDAMENTO: 'Em andamento', FEITA: 'Feita', NAO_SE_APLICA: 'Não se aplica' };

const PLANO_2025 = 'Plano de Contingência Nacional para Dengue, Chikungunya e Zika (MS, 2025)';
const FONTE_APENDICE_B = `${PLANO_2025}, Apêndice B`;
const ARBO = ['dengue', 'chikungunya', 'zika'];
const DENGUE_CHIK = ['dengue', 'chikungunya'];

/** Ações do Apêndice B por estágio e eixo, em texto curto (preparação: pp. 84-90; mobilização: pp. 92-95; alerta: pp. 97-98; epidemia: pp. 100-101). */
const ACOES_MS_2025: Record<string, Partial<Record<EixoAcao, string[]>>> = {
  NORMALIDADE: {
    GESTAO: ['Elaborar ou revisar o plano de contingência municipal', 'Avaliar os estoques de insumos do município', 'Monitorar as metas e as ações do plano com as áreas técnicas'],
    VIGILANCIA: [
      'Elaborar e monitorar o diagrama de controle ou a curva epidêmica',
      'Fazer a estratificação de risco intramunicipal',
      'Publicar o boletim semanal das arboviroses',
      'Emitir alertas para os distritos de saúde',
      'Fazer busca ativa de síndrome febril',
      'Monitorar todo mês a oportunidade de notificação, investigação e encerramento',
      'Formar o comitê municipal de investigação de óbitos por arboviroses',
      'Investigar surtos e situações inusitadas',
    ],
    LABORATORIO: ['Orientar os fluxos dos exames específicos de arboviroses', 'Monitorar o estoque estratégico de insumos laboratoriais'],
    VETORES: ['Organizar a vigilância entomológica e o controle vetorial', 'Fazer o monitoramento entomológico (LIRAa/LIA ou armadilhas)', 'Monitorar os estoques de inseticidas, equipamentos e EPI'],
    APS: ['Organizar as unidades para acolhimento, classificação de risco e hidratação oral', 'Definir os fluxos assistenciais e de referência'],
    ATENCAO_ESPECIALIZADA: ['Disponibilizar à rede os fluxogramas de classificação de risco e manejo clínico'],
    COMUNICACAO: ['Elaborar a campanha e os materiais de comunicação', 'Definir os porta-vozes'],
  },
  MOBILIZACAO: {
    GESTAO: ['Implantar a Sala de Situação municipal', 'Acompanhar a execução do plano de contingência municipal'],
    VIGILANCIA: [
      'Publicar o boletim epidemiológico semanal',
      'Intensificar os alertas aos distritos de saúde',
      'Monitorar a tendência dos casos pelo diagrama de controle',
      'Notificar em 24 horas os óbitos suspeitos ou confirmados de dengue',
      'Investigar os óbitos de forma oportuna',
      'Implantar a vigilância ativa dos casos graves',
      'Selecionar unidades para enviar dados diários de atendimento',
      'Consolidar toda semana as informações epidemiológicas, laboratoriais e entomológicas',
    ],
    LABORATORIO: ['Monitorar os sorotipos circulantes'],
    VETORES: ['Fazer o bloqueio de transmissão de forma oportuna', 'Intensificar as visitas casa a casa nos pontos de maior transmissão'],
    APS: ['Avaliar a ampliação das equipes e do horário das unidades', 'Orientar o uso dos fluxos e protocolos de manejo das arboviroses'],
    ATENCAO_ESPECIALIZADA: ['Monitorar a notificação de casos graves pela regulação', 'Revisar e divulgar os fluxos assistenciais (leitos de retaguarda, transporte, referência)'],
    COMUNICACAO: ['Elaborar e divulgar o plano de comunicação de risco', 'Fazer a campanha publicitária municipal'],
  },
  ALERTA: {
    GESTAO: ['Manter e intensificar as atividades da mobilização', 'Adquirir em caráter emergencial os insumos essenciais', 'Avaliar a abertura do Centro de Operações de Emergências (COE)'],
    VIGILANCIA: [
      'Manter e intensificar as atividades da mobilização',
      'Acompanhar com a rede assistencial os casos graves e os óbitos',
      'Investigar os casos suspeitos de síndrome congênita do Zika e de transmissão vertical de chikungunya',
    ],
    LABORATORIO: ['Priorizar o diagnóstico de casos graves, óbitos, gestantes, menores de 2 anos e maiores de 60 anos'],
    VETORES: ['Avaliar a efetividade do bloqueio de transmissão'],
    APS: ['Intensificar a busca ativa de casos suspeitos', 'Avaliar o plano de investimento emergencial (equipes, insumos, leitos e unidades extras)'],
    ATENCAO_ESPECIALIZADA: ['Avaliar o pedido de apoio da Força Nacional do SUS', 'Orientar a hidratação venosa precoce em todos os níveis de atenção'],
    COMUNICACAO: ['Estabelecer o porta-voz', 'Intensificar o plano de comunicação de risco'],
  },
  EPIDEMIA: {
    GESTAO: ['Manter as atividades do alerta', 'Avaliar a implantação do COE local com base na avaliação de risco'],
    VIGILANCIA: ['Manter as atividades do alerta', 'Avaliar força-tarefa estadual ou federal para investigar óbitos e casos suspeitos de síndrome congênita'],
    LABORATORIO: ['Apoiar os distritos de saúde na intensificação da vigilância laboratorial'],
    VETORES: ['Suspender o monitoramento entomológico para levar a força de trabalho ao controle, comunicando a SES e o MS'],
    APS: ['Manter e intensificar as atividades dos estágios anteriores'],
    ATENCAO_ESPECIALIZADA: ['Ampliar a capacidade da rede especializada com recursos adicionais'],
    COMUNICACAO: ['Organizar as entrevistas do porta-voz', 'Intensificar a campanha nas regiões de maior incidência'],
  },
};

/**
 * Modelo do MS 2025 para o município (Apêndice B). Os indicadores do plano vêm ligados por "E/OU": combinação
 * QUALQUER. Nowcasting, positividade (RT-PCR e ZDC), sorotipo e atendimentos não são calculados pelo sistema: ficam
 * como critérios MANUAIS, respondidos pela vigilância a cada semana. Interpretação: no critério da mobilização ("acima
 * da mediana e abaixo do limite superior por 4 SE"), as semanas acima do limite superior também contam, para a
 * sugestão não cair quando a curva passa do limite antes de completar as 4 SE.
 */
export const PLANO_MODELO_MS_2025: PlanoContingencia = {
  estagios: [
    { chave: 'NORMALIDADE', nome: 'Normalidade', ordem: 0 },
    { chave: 'MOBILIZACAO', nome: 'Mobilização', ordem: 1 },
    { chave: 'ALERTA', nome: 'Alerta', ordem: 2 },
    { chave: 'EPIDEMIA', nome: 'Situação de epidemia', ordem: 3 },
  ],
  agravos: ARBO,
  combinacao: 'QUALQUER',
  criterios: [
    // Mobilização (cenário 1, p. 92).
    {
      id: 'mob-canal',
      estagio: 'MOBILIZACAO',
      agravos: ARBO,
      tipo: 'CANAL_ACIMA_CENTRO',
      descricao: 'Incidência de casos prováveis acima da mediana do canal endêmico por 4 SE consecutivas (as semanas acima do limite superior também contam)',
      semanas: 4,
      modo: 'CONSECUTIVAS',
      fonte: `${FONTE_APENDICE_B}, p. 92`,
    },
    {
      id: 'mob-nowcasting',
      estagio: 'MOBILIZACAO',
      agravos: ARBO,
      tipo: 'MANUAL',
      descricao: 'Nowcasting acima da mediana e abaixo do limite superior por 4 SE consecutivas (InfoDengue)',
      fonte: `${FONTE_APENDICE_B}, p. 92`,
    },
    { id: 'mob-rtpcr', estagio: 'MOBILIZACAO', agravos: ARBO, tipo: 'MANUAL', descricao: 'Positividade laboratorial (RT-PCR) acima de 20% por 4 SE consecutivas', fonte: `${FONTE_APENDICE_B}, p. 92` },
    { id: 'mob-sorotipo', estagio: 'MOBILIZACAO', agravos: ['dengue'], tipo: 'MANUAL', descricao: 'Detecção de novo sorotipo de dengue', fonte: `${FONTE_APENDICE_B}, p. 92` },
    // Alerta (cenário 2, pp. 96-97).
    {
      id: 'ale-canal',
      estagio: 'ALERTA',
      agravos: DENGUE_CHIK,
      tipo: 'CANAL_ACIMA_LS',
      descricao: 'Curva de incidência acima do limite superior do diagrama de controle por pelo menos 4 SE consecutivas',
      semanas: 4,
      modo: 'CONSECUTIVAS',
      fonte: `${FONTE_APENDICE_B}, pp. 96-97`,
    },
    { id: 'ale-nowcasting', estagio: 'ALERTA', agravos: DENGUE_CHIK, tipo: 'MANUAL', descricao: 'Nowcasting acima do limite superior por pelo menos 4 SE (InfoDengue)', fonte: `${FONTE_APENDICE_B}, pp. 96-97` },
    {
      id: 'ale-graves',
      estagio: 'ALERTA',
      agravos: ['dengue'],
      tipo: 'PERCENTUAL_GRAVES',
      descricao: 'Casos graves ou com sinais de alarme acima de 1% dos casos prováveis',
      limiar: 1,
      comparador: '>',
      fonte: `${FONTE_APENDICE_B}, p. 96`,
    },
    {
      id: 'ale-letalidade',
      estagio: 'ALERTA',
      agravos: DENGUE_CHIK,
      tipo: 'LETALIDADE',
      descricao: 'Letalidade por casos prováveis acima de 0,05%',
      limiar: 0.05,
      comparador: '>',
      fonte: `${FONTE_APENDICE_B}, pp. 96-97`,
    },
    {
      id: 'ale-letalidade-graves',
      estagio: 'ALERTA',
      agravos: ['dengue'],
      tipo: 'LETALIDADE_GRAVES',
      descricao: 'Letalidade por casos graves e com sinais de alarme acima de 3%',
      limiar: 3,
      comparador: '>',
      fonte: `${FONTE_APENDICE_B}, p. 96`,
    },
    {
      id: 'ale-obitos-investigacao',
      estagio: 'ALERTA',
      agravos: DENGUE_CHIK,
      tipo: 'OBITOS_INVESTIGACAO_PERCENTUAL',
      descricao: 'Óbitos em investigação acima de 1% dos casos prováveis',
      limiar: 1,
      comparador: '>',
      fonte: `${FONTE_APENDICE_B}, pp. 96-97`,
    },
    { id: 'ale-zdc', estagio: 'ALERTA', agravos: DENGUE_CHIK, tipo: 'MANUAL', descricao: 'Positividade laboratorial acima de 30% no teste ZDC', fonte: `${FONTE_APENDICE_B}, pp. 96-97` },
    { id: 'ale-atendimentos', estagio: 'ALERTA', agravos: DENGUE_CHIK, tipo: 'MANUAL', descricao: 'Aumento do número de atendimentos nos serviços de saúde', fonte: `${FONTE_APENDICE_B}, pp. 96-97` },
    { id: 'ale-zika-rtpcr', estagio: 'ALERTA', agravos: ['zika'], tipo: 'MANUAL', descricao: 'Aumento de casos de Zika confirmados por RT-PCR', fonte: `${FONTE_APENDICE_B}, p. 97` },
    // Situação de epidemia (cenário 3, p. 100).
    {
      id: 'epi-nowcasting',
      estagio: 'EPIDEMIA',
      agravos: DENGUE_CHIK,
      tipo: 'MANUAL',
      descricao: 'Nowcasting ainda em alta por mais de 4 SE desde o início do alerta (nível 2)',
      fonte: `${FONTE_APENDICE_B}, p. 100`,
    },
    {
      id: 'epi-graves',
      estagio: 'EPIDEMIA',
      agravos: ['dengue'],
      tipo: 'PERCENTUAL_GRAVES',
      descricao: 'Casos graves ou com sinais de alarme acima de 2% dos casos prováveis',
      limiar: 2,
      comparador: '>',
      fonte: `${FONTE_APENDICE_B}, p. 100`,
    },
    {
      id: 'epi-letalidade',
      estagio: 'EPIDEMIA',
      agravos: DENGUE_CHIK,
      tipo: 'LETALIDADE',
      descricao: 'Letalidade por casos prováveis acima de 0,07%',
      limiar: 0.07,
      comparador: '>',
      fonte: `${FONTE_APENDICE_B}, p. 100`,
    },
    {
      id: 'epi-letalidade-graves',
      estagio: 'EPIDEMIA',
      agravos: ['dengue'],
      tipo: 'LETALIDADE_GRAVES',
      descricao: 'Letalidade por casos graves e com sinais de alarme acima de 5%',
      limiar: 5,
      comparador: '>',
      fonte: `${FONTE_APENDICE_B}, p. 100`,
    },
    {
      id: 'epi-obitos-investigacao',
      estagio: 'EPIDEMIA',
      agravos: DENGUE_CHIK,
      tipo: 'OBITOS_INVESTIGACAO_PERCENTUAL',
      descricao: 'Óbitos em investigação acima de 2% dos casos prováveis',
      limiar: 2,
      comparador: '>',
      fonte: `${FONTE_APENDICE_B}, p. 100`,
    },
    { id: 'epi-zdc', estagio: 'EPIDEMIA', agravos: ['dengue'], tipo: 'MANUAL', descricao: 'Positividade laboratorial acima de 40% no teste ZDC para dengue', fonte: `${FONTE_APENDICE_B}, p. 100` },
    { id: 'epi-sorotipo', estagio: 'EPIDEMIA', agravos: ['dengue'], tipo: 'MANUAL', descricao: 'Inversão do sorotipo predominante de dengue no município', fonte: `${FONTE_APENDICE_B}, p. 100` },
  ],
  acoes: Object.entries(ACOES_MS_2025).flatMap(([estagio, eixos]) => Object.entries(eixos).flatMap(([eixo, lista]) => lista!.map((descricao) => ({ estagio, eixo: eixo as EixoAcao, descricao })))),
  desmobilizacao: {
    semanas: 4,
    descricao: `Redução sustentada da incidência e dos óbitos por mais de 4 SE consecutivas, ou volta da curva ao canal endêmico (${PLANO_2025}, item 7.2.3, p. 52)`,
  },
};

/** Indicadores de um agravo no ano epidemiológico em análise, até a semana de referência. */
export interface IndicadoresAgravo {
  grupo: string;
  /** Status de cada SE no canal (AAAASS), da mais antiga à mais recente. */
  semanas: { semana: string; status: StatusSemana; completa: boolean }[];
  provaveis: number;
  graves: number;
  sinaisAlarme: number;
  obitosAgravo: number;
  obitosInvestigacao: number;
  incidenciaAcumulada: number | null;
}

/** Resposta da vigilância a um critério MANUAL na semana. */
export interface RespostaCriterio {
  criterio: string;
  atendido: boolean;
}

export interface AvaliacaoCriterio {
  id: string;
  estagio: string;
  agravo?: string;
  /** null = não avaliado (critério manual sem resposta na semana). */
  atendido: boolean | null;
  valor?: number | null;
  detalhe: string;
}

export interface AvaliacaoPlano {
  /** Chave do estágio sugerido. */
  sugerido: string;
  criterios: AvaliacaoCriterio[];
  /** Critérios atendidos por estágio. */
  porEstagio: Record<string, number>;
  desmobilizacao: { sugerida: boolean; detalhe: string };
}

// ───────────── Avaliação ─────────────

type Resultado = Pick<AvaliacaoCriterio, 'atendido' | 'valor' | 'detalhe'>;

const STATUS_DO_CRITERIO: Partial<Record<TipoCriterio, StatusSemana[]>> = {
  CANAL_ACIMA_CENTRO: ['ENTRE_CENTRO_E_LS', 'ACIMA_LS'],
  CANAL_ENTRE_CENTRO_E_LS: ['ENTRE_CENTRO_E_LS'],
  CANAL_ACIMA_LS: ['ACIMA_LS'],
};

/** Número em português, com 2 casas (3 abaixo de 1). */
const br = (x: number) => String(arredondar(x, Math.abs(x) < 1 ? 3 : 2)).replace('.', ',');
const ss = (semana: string) => `${semana.slice(4)}/${semana.slice(0, 4)}`;

/** Critério de canal sobre as semanas completas, sem as `recuo` mais recentes (para olhar semanas passadas). */
function avaliarCanal(c: CriterioPlano, ind: IndicadoresAgravo, recuo: number): Resultado {
  const aceitos = STATUS_DO_CRITERIO[c.tipo]!;
  const completas = ind.semanas.filter((s) => s.completa);
  const ate = completas.slice(0, Math.max(0, completas.length - recuo));
  const kDeN = c.modo === 'K_DE_N';
  const n = Math.max(1, Math.trunc((kDeN ? (c.n ?? c.semanas) : c.semanas) ?? 1));
  const k = kDeN ? Math.min(n, Math.max(1, Math.trunc(c.k ?? n))) : n;
  const janela = ate.slice(-n);
  const sim = janela.filter((s) => aceitos.includes(s.status)).length;
  const semCanal = janela.filter((s) => s.status === 'SEM_CANAL').length;
  const periodo = janela.length ? ` (SE ${ss(janela[0]!.semana)} a ${ss(janela[janela.length - 1]!.semana)})` : '';
  const alvo = ROTULO_TIPO_CRITERIO[c.tipo].toLowerCase();
  let atendido: boolean | null;
  if (sim >= k && janela.length >= (kDeN ? 1 : n)) atendido = true;
  else if (janela.length < (kDeN ? k : n)) atendido = false;
  else atendido = sim + semCanal >= k && semCanal > 0 ? null : false;
  const detalhe =
    janela.length < (kDeN ? k : n) && atendido === false
      ? `Só ${janela.length} SE completa(s) no ano; o critério pede ${kDeN ? `${k} de ${n}` : n}`
      : `${sim} de ${janela.length} SE completas ${alvo}${periodo}${atendido === null ? `; ${semCanal} SE sem canal` : ''}; pede ${kDeN ? `${k} de ${n}` : `${n} seguidas`}`;
  return { atendido, valor: sim, detalhe };
}

/** Critério numérico (percentual, letalidade ou incidência acumulada) contra o limiar. */
function avaliarNumero(c: CriterioPlano, ind: IndicadoresAgravo): Resultado {
  const graves = ind.graves + ind.sinaisAlarme;
  const fracoes: Partial<Record<TipoCriterio, [number, number, string]>> = {
    PERCENTUAL_GRAVES: [graves, ind.provaveis, 'dos casos prováveis são graves ou com sinais de alarme'],
    LETALIDADE: [ind.obitosAgravo, ind.provaveis, 'de letalidade entre os casos prováveis'],
    LETALIDADE_GRAVES: [ind.obitosAgravo, graves, 'de letalidade entre os casos graves e com sinais de alarme'],
    OBITOS_INVESTIGACAO_PERCENTUAL: [ind.obitosInvestigacao, ind.provaveis, 'dos casos prováveis são óbitos em investigação'],
  };
  const comp = c.comparador ?? '>';
  const passa = (v: number) => (comp === '>=' ? v >= c.limiar! : v > c.limiar!);
  if (c.limiar === undefined || c.limiar === null) return { atendido: null, valor: null, detalhe: 'Critério sem limiar: não avaliado' };
  if (c.tipo === 'INCIDENCIA_ACUMULADA') {
    const v = ind.incidenciaAcumulada;
    if (v === null) return { atendido: null, valor: null, detalhe: 'Sem população para a incidência acumulada: não avaliado' };
    return { atendido: passa(v), valor: v, detalhe: `Incidência acumulada de ${br(v)} por 100 mil; limiar ${comp} ${br(c.limiar)}` };
  }
  const [num, den, texto] = fracoes[c.tipo]!;
  if (den <= 0) return { atendido: false, valor: null, detalhe: c.tipo === 'LETALIDADE_GRAVES' ? 'Sem casos graves ou com sinais de alarme no ano' : 'Sem casos prováveis no ano' };
  const v = (num * 100) / den;
  return { atendido: passa(v), valor: v, detalhe: `${br(v)}% ${texto} (${num} de ${den}); limiar ${comp} ${br(c.limiar)}%` };
}

function avaliarManual(c: CriterioPlano, respostas: Map<string, boolean>): Resultado {
  const r = respostas.get(c.id);
  if (r === undefined) return { atendido: null, valor: null, detalhe: 'Sem resposta da vigilância nesta semana: não avaliado' };
  return { atendido: r, valor: null, detalhe: r ? 'Atendido (resposta da vigilância na semana)' : 'Não atendido (resposta da vigilância na semana)' };
}

/** Avaliação de todos os critérios: um item por agravo nos automáticos, um por critério nos manuais. */
function avaliarCriterios(plano: PlanoContingencia, indicadores: Map<string, IndicadoresAgravo>, respostas: Map<string, boolean>, recuo: number): AvaliacaoCriterio[] {
  return plano.criterios.flatMap((c): AvaliacaoCriterio[] => {
    const base = { id: c.id, estagio: c.estagio };
    if (c.tipo === 'MANUAL') return [{ ...base, ...avaliarManual(c, respostas) }];
    return (c.agravos.length ? c.agravos : plano.agravos).map((agravo) => {
      const ind = indicadores.get(agravo);
      if (!ind) return { ...base, agravo, atendido: null, valor: null, detalhe: 'Sem indicadores do agravo: não avaliado' };
      return { ...base, agravo, ...(STATUS_DO_CRITERIO[c.tipo] ? avaliarCanal(c, ind, recuo) : avaliarNumero(c, ind)) };
    });
  });
}

/** Estágio sugerido pelas avaliações (QUALQUER: o maior com algum critério; DOIS_OU_MAIS: regra da SES-MG por agravo). */
function estagioSugerido(plano: PlanoContingencia, avaliacoes: AvaliacaoCriterio[]): string {
  const estagios = [...plano.estagios].sort((a, b) => a.ordem - b.ordem);
  const base = estagios[0]?.chave ?? 'NORMALIDADE';
  const ordem = new Map(estagios.map((e) => [e.chave, e.ordem]));
  const maior = (chaves: string[]) => chaves.reduce((m, c) => ((ordem.get(c) ?? -1) > (ordem.get(m) ?? -1) ? c : m), base);
  if (plano.combinacao === 'QUALQUER') return maior(avaliacoes.filter((a) => a.atendido === true).map((a) => a.estagio));
  // DOIS_OU_MAIS (SES-MG): por agravo, o estágio com 2 ou mais critérios atendidos; empate fica no maior; o estágio
  // de maior ordem exige todos os seus critérios. O resultado é o pior entre os agravos.
  const topo = estagios[estagios.length - 1]?.chave;
  const sugestoes = plano.agravos.map((agravo) => {
    const qualificados = estagios
      .filter((e) => {
        const doEstagio = plano.criterios.filter((c) => c.estagio === e.chave && (c.agravos.length ? c.agravos : plano.agravos).includes(agravo));
        if (!doEstagio.length) return false;
        const atendidos = doEstagio.filter((c) => avaliacoes.some((a) => a.id === c.id && a.atendido === true && (c.tipo === 'MANUAL' || a.agravo === agravo))).length;
        return e.chave === topo ? atendidos === doEstagio.length : atendidos >= 2;
      })
      .map((e) => e.chave);
    return maior(qualificados);
  });
  return maior(sugestoes);
}

/**
 * Estágio sugerido pelos critérios. Só semanas completas contam; critério MANUAL sem resposta fica null (nunca
 * "atendido"); descer de estágio só depois de `desmobilizacao.semanas` semanas completas seguidas com a sugestão abaixo
 * do estágio atual (senão, manter). Nas semanas passadas, só os critérios de canal são refeitos (as semanas de cada
 * agravo); os percentuais, acumulados no ano, e as respostas manuais da semana valem como estão.
 */
export function avaliarPlano(plano: PlanoContingencia, indicadores: IndicadoresAgravo[], respostas: RespostaCriterio[], estagioAtual: string | null): AvaliacaoPlano {
  const porGrupo = new Map(indicadores.map((i) => [i.grupo, i]));
  const resp = new Map(respostas.map((r) => [r.criterio, r.atendido]));
  const nomes = new Map(plano.estagios.map((e) => [e.chave, e.nome]));
  const ordem = new Map(plano.estagios.map((e) => [e.chave, e.ordem]));
  const criterios = avaliarCriterios(plano, porGrupo, resp, 0);
  const porEstagio: Record<string, number> = Object.fromEntries(plano.estagios.map((e) => [e.chave, 0]));
  for (const id of new Set(criterios.filter((a) => a.atendido === true).map((a) => a.id))) {
    const c = plano.criterios.find((x) => x.id === id)!;
    porEstagio[c.estagio] = (porEstagio[c.estagio] ?? 0) + 1;
  }
  const bruto = estagioSugerido(plano, criterios);
  const atual = estagioAtual !== null && ordem.has(estagioAtual) ? estagioAtual : null;
  if (atual === null || ordem.get(bruto)! >= ordem.get(atual)!) return { sugerido: bruto, criterios, porEstagio, desmobilizacao: { sugerida: false, detalhe: '' } };

  // A sugestão caiu abaixo do estágio atual: só desce depois de N semanas completas seguidas abaixo dele.
  const n = Math.max(1, Math.trunc(plano.desmobilizacao.semanas));
  const disponiveis = Math.max(0, ...indicadores.map((i) => i.semanas.filter((s) => s.completa).length));
  const anteriores: string[] = [bruto];
  for (let recuo = 1; recuo < n && recuo < disponiveis; recuo++) anteriores.push(estagioSugerido(plano, avaliarCriterios(plano, porGrupo, resp, recuo)));
  const seguidas = anteriores.findIndex((s) => ordem.get(s)! >= ordem.get(atual)!);
  const abaixo = seguidas === -1 ? anteriores.length : seguidas;
  if (abaixo >= n) {
    const destino = anteriores.reduce((m, s) => (ordem.get(s)! > ordem.get(m)! ? s : m));
    return {
      sugerido: destino,
      criterios,
      porEstagio,
      desmobilizacao: { sugerida: true, detalhe: `Sugestão abaixo de ${nomes.get(atual)} nas últimas ${n} SE completas: pode desmobilizar para ${nomes.get(destino)}. ${plano.desmobilizacao.descricao}.` },
    };
  }
  return {
    sugerido: atual,
    criterios,
    porEstagio,
    desmobilizacao: { sugerida: false, detalhe: `Sugestão abaixo de ${nomes.get(atual)} há ${abaixo} de ${n} SE completas seguidas: manter ${nomes.get(atual)} até completar ${n}.` },
  };
}

/** Semanas incompletas (as `semanasIncompletas` mais recentes, contando a semana em curso) e a última completa. */
export interface JanelaSemanasIncompletas {
  /** Da mais antiga à mais recente (a última é a semana em curso). */
  incompletas: string[];
  ultimaCompleta: string;
}

/** A semana em curso nunca é completa: com `semanasIncompletas` menor que 1, vale 1. */
export function semanasCompletas(semanaAtual: string, semanasIncompletas: number): JanelaSemanasIncompletas {
  const n = Math.max(1, Math.trunc(semanasIncompletas));
  return {
    incompletas: Array.from({ length: n }, (_, i) => deslocarSemana(semanaAtual, i - (n - 1))),
    ultimaCompleta: deslocarSemana(semanaAtual, -n),
  };
}
