import { brl, brlCurto, mesAno, num1, pct, reaisPorHab } from './formata';
import { anos, caixa, FONTES, FUNDEB, indicadores, mesesDeSaldo, receita, type Estatisticas } from './pares';
import type { Achado, Analise, Eixo, Indicador, Pendencia, Perfil, Trecho } from './tipos';

/*
 * Camada 2: motor de regras. Compara os números do perfil com os parâmetros legais e com as prefeituras do mesmo
 * porte no Tocantins, e estima o impacto em reais. Tudo aqui é determinístico: o agente (camada 4) só redige, e o
 * texto dele é conferido contra estes números.
 *
 * Os parâmetros que não vêm de lei citada no corpus estão em PARAMETROS, com a origem de cada um.
 */
export const PARAMETROS = {
  /** Saldo do FNAS em meses de repasse a partir do qual o achado é crítico ou alerta. Origem: regra de negócio da
   * especificação do módulo ("bloqueio por saldo em conta acima de 12/24 meses de repasse"), atribuída à Portaria
   * MDS nº 113/2015, cujo texto não está no corpus: conferir a portaria vigente antes de agir. */
  fnas_meses_critico: 12,
  fnas_meses_alerta: 6,
  /** Saldo do SUS (manutenção) acima do qual o recurso é tratado como parado: o maior entre este número de meses e o
   * 3º quartil das prefeituras do mesmo grupo. Parâmetro de gestão do módulo, não é limite legal. */
  sus_meses_minimo: 6,
  /** Folga de caixa considerada normal para o SUS, em meses de repasse, ao calcular o valor parado. */
  sus_meses_folga: 3,
  /** Grupo de comparação com menos prefeituras do que isto não gera achado. */
  pares_minimo: 8,
  /** Comparação por habitante: só em grupos grandes e homogêneos (o grupo "acima de 20 mil" junta de 20 mil a
   * 330 mil habitantes e não serve) e só quando a prefeitura está no quartil inferior E ao menos 25% abaixo da
   * mediana. É um sinal para investigar, não um cálculo de perda. */
  por_habitante_pares_minimo: 15,
  por_habitante_distancia_minima: 0.25,
  /** Meses do ano corrente com a MSC entregue para afirmar que um repasse não chegou. */
  meses_para_ausencia: 6,
};

const EIXO_ORDEM: Record<Eixo, number> = { 'Educação': 0, 'Saúde': 1, 'Assistência Social': 2 };
const NIVEL_ORDEM = { 'Crítico': 0, 'Alerta': 1, 'Oportunidade': 2 } as const;

interface Contexto {
  p: Perfil;
  base: number | null;
  corrente: number | null;
  meses: number | null;
  ind: Record<string, Indicador>;
}

type Regra = (c: Contexto) => Achado[];

// --- mínimos constitucionais e legais (RREO Anexo 14) --------------------------------------------------------------
interface DefMinimo {
  chave: 'fundeb70' | 'mde' | 'asps';
  eixo: Eixo;
  nome: string;
  oque: string;
  base_legal: string[];
  consultas: string[];
  responsavel: string;
  sistema: string;
  acao_ano: (falta: number) => string;
  acao_encerrado: string;
}

const MINIMOS: DefMinimo[] = [
  {
    chave: 'fundeb70',
    eixo: 'Educação',
    nome: 'FUNDEB na remuneração dos profissionais da educação',
    oque: 'dos recursos do FUNDEB na remuneração dos profissionais da educação básica em efetivo exercício',
    base_legal: ['l14113-art26', 'cf88-art212-A-4'],
    consultas: ['proporção não inferior a 70% remuneração profissionais da educação básica efetivo exercício'],
    responsavel: 'Secretário(a) Municipal de Educação, com a Contabilidade e o Departamento de Pessoal',
    sistema: 'Folha de pagamento e contabilidade (fonte 540, código de acompanhamento 1070) e SIOPE (FNDE), onde o percentual é declarado',
    acao_ano: (falta) =>
      `Programar até dezembro ${brl(falta)} a mais de remuneração de profissionais da educação básica em efetivo exercício paga com o FUNDEB (fonte 540, código 1070) e conferir no SIOPE se toda essa folha está classificada nessa fonte: folha paga com recurso próprio não entra no cálculo.`,
    acao_encerrado:
      'Conferir com a Contabilidade se a folha dos profissionais da educação paga com o FUNDEB foi toda classificada na fonte 540 com o código 1070 e se o SIOPE coincide com o RREO; preparar a justificativa para a prestação de contas do exercício.',
  },
  {
    chave: 'mde',
    eixo: 'Educação',
    nome: 'aplicação mínima em manutenção e desenvolvimento do ensino',
    oque: 'da receita de impostos em manutenção e desenvolvimento do ensino',
    base_legal: ['cf88-art212-1'],
    consultas: ['aplicará anualmente nunca menos de vinte e cinco por cento receita de impostos manutenção desenvolvimento ensino'],
    responsavel: 'Secretário(a) Municipal de Educação e Contador(a) do município',
    sistema: 'Contabilidade (fonte 500, código de acompanhamento 1001) e SIOPE (FNDE)',
    acao_ano: (falta) =>
      `Executar até dezembro ${brl(falta)} a mais em despesas de manutenção e desenvolvimento do ensino pagas com recursos de impostos (fonte 500, código 1001) e conferir a declaração no SIOPE.`,
    acao_encerrado:
      'Conferir com a Contabilidade a classificação das despesas de educação pagas com impostos (fonte 500, código 1001) e se o SIOPE coincide com o RREO; preparar a justificativa para a prestação de contas do exercício.',
  },
  {
    chave: 'asps',
    eixo: 'Saúde',
    nome: 'aplicação mínima em ações e serviços públicos de saúde',
    oque: 'da receita de impostos em ações e serviços públicos de saúde',
    base_legal: ['lc141-art7', 'lc141-art25', 'lc141-art26-1', 'cf88-art160'],
    consultas: ['condicionamento da entrega de recursos aplicação adicional percentual mínimo saúde'],
    responsavel: 'Secretário(a) Municipal de Saúde e Contador(a) do município',
    sistema: 'Contabilidade (fonte 500, código de acompanhamento 1002) e SIOPS (Ministério da Saúde), onde o percentual é declarado e homologado',
    acao_ano: (falta) =>
      `Executar até dezembro ${brl(falta)} a mais em ações e serviços públicos de saúde pagos com recursos de impostos (fonte 500, código 1002) e declarar no SIOPS a cada bimestre.`,
    acao_encerrado:
      'Somar a diferença ao mínimo deste exercício (LC 141/2012, art. 25), conferir a declaração do SIOPS e acompanhar se a União ou o Estado condicionou a entrega de recursos à aplicação adicional (art. 26).',
  },
];

const minimos: Regra = ({ p, base, corrente }) => {
  const saida: Achado[] = [];
  for (const d of MINIMOS) {
    for (const ano of [base, corrente]) {
      if (ano === null) continue;
      const r = p.rreo14[String(ano)];
      const m = r?.[d.chave];
      if (!r || !m?.aplicado_pct || !m.minimo_pct || !m.valor || m.aplicado_pct >= m.minimo_pct) continue;
      const encerrado = r.bimestre === 6;
      const baseCalc = m.valor / (m.aplicado_pct / 100);
      const falta = (baseCalc * (m.minimo_pct - m.aplicado_pct)) / 100;
      const restantes = 12 - 2 * r.bimestre;
      const periodo = encerrado ? `no exercício de ${ano}` : `até o ${r.bimestre}º bimestre de ${ano}`;
      saida.push({
        id: `${d.chave}-${ano}`,
        regra: `minimo_${d.chave}`,
        eixo: d.eixo,
        nivel: encerrado ? 'Crítico' : 'Alerta',
        titulo: encerrado ? `Mínimo não cumprido em ${ano}: ${d.nome}` : `Abaixo do mínimo em ${ano}: ${d.nome}`,
        diagnostico:
          `${periodo[0]?.toUpperCase()}${periodo.slice(1)}, a prefeitura aplicou ${pct(m.aplicado_pct)} ${d.oque}, abaixo do mínimo de ${pct(m.minimo_pct)} (RREO, Anexo 14). ` +
          (encerrado
            ? `A diferença foi de ${brl(falta)}.`
            : `Para chegar ao mínimo no ano, faltam hoje ${brl(falta)}, cerca de ${brl(falta / restantes)} por mês até dezembro.`),
        atual: pct(m.aplicado_pct),
        parametro: `mínimo de ${pct(m.minimo_pct)}`,
        impacto: {
          mensal: encerrado ? null : falta / restantes,
          anual: falta,
          natureza: 'valor_a_aplicar',
          metodo: `(${pct(m.minimo_pct)} − ${pct(m.aplicado_pct)}) × base de cálculo de ${brl(baseCalc)} (valor apurado ÷ percentual aplicado, RREO Anexo 14${encerrado ? '' : `, ${r.bimestre}º bimestre`})`,
          confianca: 'alta',
        },
        base_legal: d.base_legal,
        normas_externas: [],
        consultas: d.consultas,
        passos: {
          responsavel: d.responsavel,
          sistema: d.sistema,
          acao: encerrado ? d.acao_encerrado : d.acao_ano(falta),
          prazo: encerrado
            ? `Exercício de ${ano} encerrado: a diferença é examinada na prestação de contas; ${d.chave === 'asps' ? `ela se soma ao mínimo de ${ano + 1}` : 'evite repetir em ' + (ano + 1)}.`
            : `31/12/${ano}: o percentual é anual e aparece no RREO do 6º bimestre, publicado até 30/01/${ano + 1}.`,
        },
        fontes_dados: [`Siconfi, RREO Anexo 14 de ${ano} (${r.bimestre}º bimestre)`],
      });
    }
  }
  return saida;
};

// --- FUNDEB: saldo acima de 10% no fim do ano ------------------------------------------------------------------
const fundebSaldo: Regra = ({ p }) => {
  const r = p.rgf5;
  if (!r) return [];
  const linhas = Object.entries(r.linhas).filter(([k]) => /FUNDEB/i.test(k));
  if (!linhas.length) return [];
  const saldo = linhas.reduce((s, [, v]) => s + (v.liquida_apos_rp ?? 0), 0);
  const recebido = receita(p, r.ano, ...FUNDEB);
  if (recebido <= 0 || saldo <= 0.1 * recebido) return [];
  const acima = saldo - 0.1 * recebido;
  return [{
    id: `fundeb_saldo-${r.ano}`,
    regra: 'fundeb_saldo_10',
    eixo: 'Educação',
    nivel: 'Crítico',
    titulo: `FUNDEB: saldo de ${r.ano} acima do limite de 10%`,
    diagnostico:
      `Em 31/12/${r.ano} sobraram ${brl(saldo)} do FUNDEB sem empenho (RGF Anexo 5, disponibilidade após restos a pagar), ${pct((100 * saldo) / recebido)} dos ${brl(recebido)} recebidos no ano. ` +
      `A lei permite deixar até 10% para o primeiro quadrimestre seguinte; ${brl(acima)} passaram desse limite.`,
    atual: pct((100 * saldo) / recebido),
    parametro: 'até 10% dos recursos recebidos',
    impacto: {
      mensal: null,
      anual: acima,
      natureza: 'valor_a_aplicar',
      metodo: `saldo de ${brl(saldo)} − 10% de ${brl(recebido)} (receita do FUNDEB, fontes 540 a 543, MSC de dezembro de ${r.ano})`,
      confianca: 'média',
    },
    base_legal: ['l14113-art25'],
    normas_externas: [],
    consultas: ['recursos dos fundos utilizados no exercício financeiro em que forem creditados primeiro quadrimestre crédito adicional'],
    passos: {
      responsavel: 'Secretário(a) Municipal de Educação e Contador(a), com o Conselho de Acompanhamento e Controle Social do FUNDEB',
      sistema: 'Contabilidade (fonte 540) e SIOPE (FNDE); RGF Anexo 5 no Siconfi',
      acao:
        'Abrir crédito adicional e aplicar o saldo em manutenção e desenvolvimento da educação básica; registrar no SIOPE e na prestação de contas o motivo do saldo acima de 10% e o cronograma de aplicação.',
      prazo: `A parte de até 10% devia ser usada até 30/04/${r.ano + 1} (primeiro quadrimestre); o excedente já está fora do prazo do art. 25 da Lei 14.113/2020.`,
    },
    fontes_dados: [`Siconfi, RGF Anexo 5 de ${r.ano}`, `Siconfi, MSC de dezembro de ${r.ano}`],
  }];
};

// --- FUNDEB: complementação VAAR ---------------------------------------------------------------------------------
const PASSOS_VAAR = {
  responsavel: 'Secretário(a) Municipal de Educação, com a equipe do Censo Escolar e o(a) responsável pelo SAEB na rede',
  sistema: 'SIMEC (MEC), onde a rede informa as condicionalidades do VAAR; resultados e participação no SAEB (INEP); Educacenso',
  prazo:
    'Calendário do ciclo do VAAR publicado anualmente pelo MEC e pela Comissão Intergovernamental (não está no corpus do módulo: conferir a resolução do ciclo).',
};
const CONDICIONALIDADES =
  'provimento do diretor escolar por critérios técnicos de mérito e desempenho (ou escolha com a comunidade entre aprovados em avaliação), participação de pelo menos 80% dos estudantes de cada ano avaliado no SAEB, redução das desigualdades educacionais socioeconômicas e raciais, e referenciais curriculares alinhados à BNCC';

const vaar: Regra = ({ p, base, corrente, meses, ind }) => {
  if (base === null) return [];
  const antes = receita(p, base, '543');
  const agora = receita(p, corrente, '543');
  const fundeb = receita(p, base, '540');
  if (antes > 0 && corrente !== null && agora <= 0 && (meses ?? 0) >= PARAMETROS.meses_para_ausencia) {
    return [{
      id: `vaar_perdido-${corrente}`,
      regra: 'vaar_perdido',
      eixo: 'Educação',
      nivel: 'Alerta',
      titulo: `FUNDEB: a complementação VAAR parou de chegar em ${corrente}`,
      diagnostico:
        `Em ${base} a prefeitura recebeu ${brl(antes)} de complementação VAAR (${pct((100 * antes) / (fundeb || 1))} do FUNDEB). ` +
        `Em ${corrente}, até ${mesAno(meses ?? 0, corrente)}, não há receita nessa fonte (543) na contabilidade enviada ao Tesouro.`,
      atual: `R$ 0 em ${corrente}`,
      parametro: `${brl(antes)} em ${base}`,
      impacto: {
        mensal: antes / 12,
        anual: antes,
        natureza: 'perda_de_repasse',
        metodo: `receita da fonte 543 em ${base} (MSC de dezembro) como estimativa do que deixa de entrar em ${corrente}`,
        confianca: 'média',
      },
      base_legal: ['l14113-art14-1', 'cf88-art212-A-2'],
      normas_externas: [],
      consultas: ['complementação VAAR condicionalidades melhoria dos indicadores atendimento e aprendizagem'],
      passos: {
        ...PASSOS_VAAR,
        acao:
          `Confirmar na lista do ciclo publicada pelo FNDE/MEC se a rede ficou inabilitada e por qual condicionalidade (ou por falta de melhoria nos indicadores); se for registro contábil, reclassificar a receita na fonte 543. Corrigir a pendência no SIMEC: ${CONDICIONALIDADES}.`,
      },
      fontes_dados: [`Siconfi, MSC de dezembro de ${base} e de ${mesAno(meses ?? 0, corrente)}`],
    }];
  }
  const g = ind['vaar_fundeb'];
  if (antes > 0 || agora > 0 || !g?.mediana || g.n < PARAMETROS.pares_minimo || fundeb <= 0) return [];
  const potencial = (g.mediana / 100) * fundeb;
  return [{
    id: `vaar_potencial-${base}`,
    regra: 'vaar_potencial',
    eixo: 'Educação',
    nivel: 'Oportunidade',
    titulo: 'FUNDEB: a rede não recebe a complementação VAAR',
    diagnostico:
      `A prefeitura não recebeu complementação VAAR em ${base}${corrente ? ` nem em ${corrente}` : ''}. ` +
      `Entre as ${g.n} prefeituras do grupo "${g.grupo}" que recebem, a mediana é ${pct(g.mediana)} do FUNDEB; aplicada aos ${brl(fundeb)} de FUNDEB desta prefeitura em ${base}, seriam cerca de ${brl(potencial)} por ano.`,
    atual: 'R$ 0',
    parametro: `mediana de ${pct(g.mediana)} do FUNDEB entre as que recebem`,
    impacto: {
      mensal: potencial / 12,
      anual: potencial,
      natureza: 'ganho_potencial',
      metodo: `mediana da razão VAAR ÷ FUNDEB (fontes 543 e 540, ${base}) no grupo "${g.grupo}" × FUNDEB da prefeitura`,
      confianca: 'média',
    },
    base_legal: ['l14113-art14-1', 'cf88-art212-A-2'],
    normas_externas: [],
    consultas: ['complementação VAAR condicionalidades melhoria dos indicadores atendimento e aprendizagem'],
    passos: {
      ...PASSOS_VAAR,
      acao: `Verificar no SIMEC quais condicionalidades estão pendentes e cumpri-las para o próximo ciclo: ${CONDICIONALIDADES}.`,
    },
    fontes_dados: [`Siconfi, MSC de dezembro de ${base}`, 'comparação com as prefeituras do Tocantins do mesmo grupo'],
  }];
};

// --- Assistência: saldo do FNAS em meses de repasse -------------------------------------------------------------
const fnasSaldo: Regra = ({ p, base, ind }) => {
  const meses = mesesDeSaldo(p, '660');
  if (meses === null || base === null || !p.caixa || meses < PARAMETROS.fnas_meses_alerta) return [];
  const media = receita(p, base, '660') / 12;
  const saldo = caixa(p, '660') ?? 0;
  const g = ind['meses_saldo_fnas'];
  const critico = meses >= PARAMETROS.fnas_meses_critico;
  return [{
    id: `fnas_saldo-${p.caixa.ano}-${p.caixa.mes}`,
    regra: 'fnas_saldo',
    eixo: 'Assistência Social',
    nivel: critico ? 'Crítico' : 'Alerta',
    titulo: critico ? 'FNAS: saldo parado acima de 12 meses de repasse' : 'FNAS: saldo parado se aproximando de 12 meses de repasse',
    diagnostico:
      `Em ${mesAno(p.caixa.mes, p.caixa.ano)} o caixa dos recursos do FNAS somava ${brl(saldo)}, o equivalente a ${num1(meses)} meses do repasse médio de ${base} (${brl(media)} por mês)` +
      (g?.mediana ? `; a mediana das prefeituras do grupo "${g.grupo}" é ${num1(g.mediana)} meses.` : '.') +
      (critico ? ' Saldo nesse nível expõe os repasses à suspensão até a execução.' : ' Mais alguns meses sem execução e o saldo passa de 12 meses de repasse.'),
    atual: `${num1(meses)} meses de repasse`,
    parametro: `${critico ? 'crítico a partir de' : 'alerta a partir de'} ${critico ? PARAMETROS.fnas_meses_critico : PARAMETROS.fnas_meses_alerta} meses`,
    impacto: {
      mensal: media,
      anual: 12 * media,
      natureza: 'perda_de_repasse',
      metodo: `repasse médio mensal do FNAS em ${base} (fonte 660, MSC de dezembro ÷ 12): é o que deixa de entrar por mês se o repasse for suspenso; saldo em caixa (contas 1.1.1.1, fonte 660, MSC de ${mesAno(p.caixa.mes, p.caixa.ano)})`,
      confianca: 'média',
    },
    base_legal: ['l8742-art30-A', 'l8742-art30-C'],
    normas_externas: [{
      rotulo: 'Portaria MDS nº 113/2015',
      observacao: 'regra de suspensão por saldo em conta citada na especificação do módulo; o texto não está no corpus: confira a versão vigente no DOU antes de agir',
    }],
    consultas: ['transferências automáticas fundos de assistência social repasse recursos FNAS'],
    passos: {
      responsavel: 'Gestor(a) do Fundo Municipal de Assistência Social, com a Contabilidade e o Conselho Municipal de Assistência Social',
      sistema: 'Contabilidade do fundo (fonte 660) e extratos das contas de cada bloco do FNAS; demonstrativo de execução no SUASweb, apreciado pelo Conselho',
      acao: `Identificar conta por conta qual bloco (proteção social básica, especial, gestão do SUAS e do Bolsa Família) acumula o saldo de ${brl(saldo)}, reprogramar no orçamento por crédito adicional e executar nos serviços do próprio bloco.`,
      prazo: 'Antes da próxima apuração de saldos pelo FNAS; o limite de meses usado aqui é parâmetro do módulo (veja a norma externa).',
    },
    fontes_dados: [`Siconfi, MSC de dezembro de ${base} (receita) e de ${mesAno(p.caixa.mes, p.caixa.ano)} (caixa)`],
  }];
};

// --- Saúde: recurso do SUS parado em caixa -----------------------------------------------------------------------
const susSaldo: Regra = ({ p, base, ind }) => {
  const meses = mesesDeSaldo(p, '600');
  const g = ind['meses_saldo_sus'];
  if (meses === null || base === null || !p.caixa || !g?.p75 || g.n < PARAMETROS.pares_minimo) return [];
  const limite = Math.max(PARAMETROS.sus_meses_minimo, g.p75);
  if (meses <= limite) return [];
  const media = receita(p, base, '600') / 12;
  const saldo = caixa(p, '600') ?? 0;
  const parado = saldo - PARAMETROS.sus_meses_folga * media;
  return [{
    id: `sus_saldo-${p.caixa.ano}-${p.caixa.mes}`,
    regra: 'sus_saldo',
    eixo: 'Saúde',
    nivel: 'Oportunidade',
    titulo: 'SUS: recurso federal de manutenção parado em caixa',
    diagnostico:
      `Em ${mesAno(p.caixa.mes, p.caixa.ano)} havia ${brl(saldo)} em caixa dos repasses federais do SUS para manutenção, ${num1(meses)} meses do repasse médio de ${base} (${brl(media)} por mês). ` +
      `No grupo "${g.grupo}", 3 em cada 4 prefeituras têm até ${num1(g.p75)} meses. Acima de ${PARAMETROS.sus_meses_folga} meses de folga, ${brl(parado)} poderiam estar em serviço para a população.`,
    atual: `${num1(meses)} meses de repasse`,
    parametro: `até ${num1(limite)} meses (3º quartil do grupo ou ${PARAMETROS.sus_meses_minimo} meses)`,
    impacto: {
      mensal: null,
      anual: parado,
      natureza: 'recurso_parado',
      metodo: `saldo de ${brl(saldo)} (fonte 600, contas 1.1.1.1) − ${PARAMETROS.sus_meses_folga} × repasse médio mensal de ${base}`,
      confianca: 'média',
    },
    base_legal: ['l8142-art4'],
    normas_externas: [],
    consultas: ['recursos transferidos fundo de saúde movimentados conta específica aplicação ações e serviços públicos de saúde'],
    passos: {
      responsavel: 'Secretário(a) Municipal de Saúde e gestor(a) do Fundo Municipal de Saúde, com o Conselho Municipal de Saúde',
      sistema: 'Contabilidade do fundo (fonte 600) e Programação Anual de Saúde e Relatório de Gestão no DigiSUS Gestor',
      acao: `Separar o saldo de ${brl(saldo)} por programa de origem (atenção primária, especializada, vigilância, assistência farmacêutica), incluir a execução na Programação Anual de Saúde e abrir os créditos adicionais necessários.`,
      prazo: `Programação Anual de Saúde de ${p.caixa.ano + 1} e Relatório Anual de Gestão de ${p.caixa.ano}, apreciados pelo Conselho Municipal de Saúde.`,
    },
    fontes_dados: [`Siconfi, MSC de dezembro de ${base} (receita) e de ${mesAno(p.caixa.mes, p.caixa.ano)} (caixa)`],
  }];
};

// --- Comparação por habitante com as prefeituras do mesmo porte ---------------------------------------------------
interface DefPorHab {
  indicador: string;
  fonte: string;
  eixo: Eixo;
  titulo: string;
  porque: string;
  base_legal: string[];
  consultas: string[];
  responsavel: string;
  sistema: string;
  acao: string;
  prazo: string;
}

const POR_HAB: DefPorHab[] = [
  {
    indicador: 'fundeb_hab', fonte: '540', eixo: 'Educação',
    titulo: 'FUNDEB por habitante abaixo das prefeituras do mesmo porte',
    porque: 'O FUNDEB é repartido pelas matrículas do Censo Escolar, com pesos maiores para tempo integral, creche, educação especial (AEE) e escolas do campo; matrícula declarada na categoria errada reduz a receita.',
    base_legal: ['l14113-art7-1', 'l14113-art8-1'],
    consultas: ['distribuição dos recursos matrículas ponderação diferenças e ponderações tempo integral campo educação especial'],
    responsavel: 'Coordenador(a) do Censo Escolar da Secretaria de Educação, com os diretores das escolas',
    sistema: 'Educacenso (INEP)',
    acao: 'Conferir escola por escola se cada aluno está na etapa, jornada e modalidade corretas: tempo integral (jornada diária de 7 horas ou mais), atendimento educacional especializado (AEE) e dupla matrícula, creche, escolas do campo, indígenas e quilombolas.',
    prazo: 'Data de referência do Censo Escolar (última quarta-feira de maio) e prazos de fechamento e retificação do INEP; o Censo de um ano define a distribuição do FUNDEB do ano seguinte.',
  },
  {
    indicador: 'pnae_hab', fonte: '552', eixo: 'Educação',
    titulo: 'PNAE por habitante abaixo das prefeituras do mesmo porte',
    porque: 'O repasse do PNAE é calculado pelo número de alunos do Censo Escolar, com valores maiores para creche, tempo integral, AEE e escolas indígenas e quilombolas.',
    base_legal: ['l11947-art5'],
    consultas: ['montante dos recursos calculado com base no número de alunos matriculados censo escolar alimentação escolar'],
    responsavel: 'Coordenador(a) do Censo Escolar, com o(a) nutricionista responsável técnico(a) do PNAE',
    sistema: 'Educacenso (INEP), que alimenta o cálculo do PNAE no FNDE',
    acao: 'Conferir no Educacenso as matrículas de creche, pré-escola, tempo integral, AEE e escolas indígenas e quilombolas, que têm valor por aluno maior no PNAE.',
    prazo: 'Data de referência do Censo Escolar (última quarta-feira de maio) e prazos de retificação do INEP; o repasse usa o Censo do ano anterior.',
  },
  {
    indicador: 'pnate_hab', fonte: '553', eixo: 'Educação',
    titulo: 'PNATE por habitante abaixo das prefeituras do mesmo porte',
    porque: 'O PNATE atende alunos da educação básica pública residentes em área rural que usam transporte escolar; aluno rural sem o transporte informado no Censo não conta.',
    base_legal: ['l10880-art2-1'],
    consultas: ['transporte escolar alunos educação básica pública residentes em área rural assistência financeira'],
    responsavel: 'Coordenador(a) do Censo Escolar e do transporte escolar',
    sistema: 'Educacenso (INEP): localização da residência e uso de transporte escolar público de cada aluno',
    acao: 'Conferir no Educacenso, aluno por aluno, a zona de residência (rural) e o campo de uso de transporte escolar público, inclusive dos alunos da rede estadual transportados pelo município quando houver acordo.',
    prazo: 'Data de referência do Censo Escolar (última quarta-feira de maio) e prazos de retificação do INEP.',
  },
  {
    indicador: 'sus_hab', fonte: '600', eixo: 'Saúde',
    titulo: 'SUS fundo a fundo por habitante abaixo das prefeituras do mesmo porte',
    porque: 'Os repasses federais de manutenção dependem de equipes credenciadas e homologadas, de cadastros e indicadores da atenção primária e da produção registrada.',
    base_legal: ['lc141-art17'],
    consultas: ['rateio dos recursos da União vinculados a ações e serviços públicos de saúde repassados aos municípios'],
    responsavel: 'Coordenação da Atenção Primária, digitador(a) do CNES e responsável pelo faturamento SIA/SIH',
    sistema: 'SCNES (equipes e profissionais), e-SUS APS e SISAB (cadastros e acompanhamento), SIA e SIH (produção)',
    acao: 'Cruzar as equipes do SCNES com as homologadas e as efetivamente pagas e procurar suspensões (profissional obrigatório ausente, carga horária); limpar cadastros individuais sem CPF/CNS ou sem atualização há mais de 24 meses no e-SUS APS; conferir se toda a produção ambulatorial e hospitalar está sendo enviada com os procedimentos SIGTAP corretos.',
    prazo: 'Competência mensal: o envio do SCNES, do e-SUS APS/SISAB e do SIA/SIH segue o cronograma de cada competência do Ministério da Saúde.',
  },
  {
    indicador: 'fnas_hab', fonte: '660', eixo: 'Assistência Social',
    titulo: 'FNAS por habitante abaixo das prefeituras do mesmo porte',
    porque: 'Parte dos repasses do FNAS (IGD do Bolsa Família e do Cadastro Único, IGD-SUAS) depende de índices de gestão: atualização cadastral, acompanhamento de condicionalidades e registros mensais do SUAS.',
    base_legal: ['l14601-art14-1'],
    consultas: ['índice de gestão descentralizada programa bolsa família cadastro único apoio financeiro'],
    responsavel: 'Gestor(a) municipal do SUAS e do Cadastro Único/Bolsa Família',
    sistema: 'Cadastro Único (taxa de atualização cadastral), Sistema de Condicionalidades (educação e saúde), CadSUAS, RMA e Censo SUAS',
    acao: 'Conferir a taxa de atualização cadastral do Cadastro Único e o acompanhamento das condicionalidades de educação e saúde (componentes do IGD), e se o RMA dos CRAS e CREAS e o CadSUAS estão em dia (componentes do IGD-SUAS).',
    prazo: 'Registros mensais (RMA) e calendário do Censo SUAS; os índices são apurados periodicamente pelo MDS.',
  },
];

const porHabitante: Regra = ({ p, base, ind }) => {
  if (base === null) return [];
  const saida: Achado[] = [];
  for (const d of POR_HAB) {
    const g = ind[d.indicador];
    if (!g || g.valor === null || g.p25 === null || !g.mediana || g.n < PARAMETROS.por_habitante_pares_minimo) continue;
    if (g.valor >= g.p25 || (g.mediana - g.valor) / g.mediana < PARAMETROS.por_habitante_distancia_minima) continue;
    const distancia = (g.mediana - g.valor) * p.populacao;
    saida.push({
      id: `${d.indicador}-${base}`,
      regra: 'por_habitante',
      eixo: d.eixo,
      nivel: 'Oportunidade',
      titulo: d.titulo,
      diagnostico:
        `Em ${base}: ${reaisPorHab(g.valor)} (${FONTES[d.fonte]?.rotulo}). Entre as ${g.n} prefeituras do grupo "${g.grupo}", a mediana é ${reaisPorHab(g.mediana)} e 1 em cada 4 recebe menos de ${reaisPorHab(g.p25)}. ` +
        `${d.porque} A diferença até a mediana, ${brl(distancia)} por ano, não é valor devido: indica onde procurar.`,
      atual: reaisPorHab(g.valor),
      parametro: `mediana do grupo: ${reaisPorHab(g.mediana)}`,
      impacto: {
        mensal: distancia / 12,
        anual: distancia,
        natureza: 'ganho_potencial',
        metodo: `(mediana do grupo − valor da prefeitura) × ${p.populacao.toLocaleString('pt-BR')} habitantes; teto teórico, não estimativa de ganho`,
        confianca: 'baixa',
      },
      base_legal: d.base_legal,
      normas_externas: [],
      consultas: d.consultas,
      passos: { responsavel: d.responsavel, sistema: d.sistema, acao: d.acao, prazo: d.prazo },
      fontes_dados: [`Siconfi, MSC de dezembro de ${base} (fonte ${d.fonte})`, 'população: cadastro de entes do Siconfi', 'comparação com as prefeituras do Tocantins do mesmo grupo'],
    });
  }
  return saida;
};

export const REGRAS: Regra[] = [minimos, fundebSaldo, vaar, fnasSaldo, susSaldo, porHabitante];

// --- O que os dados abertos não mostram ---------------------------------------------------------------------------
function pendencias(p: Perfil, base: number | null): Pendencia[] {
  const saida: Pendencia[] = [];
  const r = base !== null ? p.rreo14[String(base)] : undefined;
  if (!r?.fundeb70?.aplicado_pct) {
    saida.push({
      eixo: 'Educação', tema: 'Percentuais do FUNDEB (70%) e da educação (25%)',
      por_que: r?.simplificado
        ? 'A prefeitura publica o RREO simplificado, e o Tesouro não traz esses percentuais na versão simplificada.'
        : 'O Anexo 14 do RREO não traz esses percentuais para esta prefeitura.',
      onde: 'SIOPE (FNDE): demonstrativo da função educação', quem: 'Contabilidade e Secretaria de Educação',
    });
  }
  if (!r?.asps?.aplicado_pct) {
    saida.push({
      eixo: 'Saúde', tema: 'Percentual aplicado em saúde (15%)',
      por_que: r?.simplificado ? 'Não aparece no RREO simplificado no Tesouro.' : 'O Anexo 14 do RREO não traz o percentual para esta prefeitura.',
      onde: 'SIOPS (Ministério da Saúde)', quem: 'Contabilidade e Secretaria de Saúde',
    });
  }
  saida.push(
    {
      eixo: 'Educação', tema: 'Matrículas por etapa, jornada e modalidade',
      por_que: 'Para calcular quanto a reclassificação de matrículas (tempo integral, AEE, creche, campo) acrescenta ao FUNDEB e ao PNAE é preciso o Censo da rede e os fatores de ponderação do ano.',
      onde: 'Educacenso (INEP) ou sinopse do Censo Escolar; fatores do FUNDEB publicados pelo MEC/FNDE', quem: 'Coordenação do Censo Escolar',
    },
    {
      eixo: 'Educação', tema: 'Situação nas condicionalidades do VAAR',
      por_que: 'A habilitação depende de cinco condicionalidades e da melhoria de indicadores; o resultado por rede não está nos dados do Tesouro.',
      onde: 'SIMEC (MEC) e lista de habilitados do ciclo publicada pelo FNDE', quem: 'Secretaria de Educação',
    },
    {
      eixo: 'Saúde', tema: 'Equipes homologadas, pagas e suspensas na atenção primária',
      por_que: 'Suspensões por profissional ausente ou carga horária e equipes cadastradas sem homologação não aparecem na contabilidade.',
      onde: 'SCNES e relatórios de pagamento da atenção primária (e-Gestor AB)', quem: 'Coordenação da Atenção Primária e digitador(a) do CNES',
    },
    {
      eixo: 'Saúde', tema: 'Cadastros e indicadores da atenção primária',
      por_que: 'O componente de vínculo e acompanhamento depende de cadastros individuais com CPF/CNS e atualizados; a qualidade, de metas por indicador.',
      onde: 'e-SUS APS e SISAB', quem: 'Coordenação da Atenção Primária',
    },
    {
      eixo: 'Assistência Social', tema: 'IGD do Bolsa Família e do Cadastro Único, IGD-SUAS',
      por_que: 'Os índices (atualização cadastral, condicionalidades, IDCRAS/IDCREAS, RMA) definem parte dos repasses e não estão nos dados abertos do Tesouro.',
      onde: 'Cadastro Único, Sistema de Condicionalidades, CadSUAS, RMA e Censo SUAS', quem: 'Gestão do SUAS e do Cadastro Único',
    },
    {
      eixo: 'Assistência Social', tema: 'Conselho, fundo e plano de assistência social',
      por_que: 'São condição para receber os repasses (LOAS, art. 30).',
      onde: 'CadSUAS e atos do município', quem: 'Gestão do SUAS',
    },
  );
  return saida;
}

const TOTAL_POR_NATUREZA = (achados: Achado[], natureza: Achado['impacto']['natureza']) =>
  achados.filter((a) => a.impacto.natureza === natureza).reduce((s, a) => s + a.impacto.anual, 0);

/** Camada 2: o diagnóstico de uma prefeitura. `trechos` é o corpus (para anexar o texto das normas citadas). */
export function analisa(p: Perfil, est: Estatisticas, trechos: Map<string, Trecho>, hoje = new Date()): Analise {
  const { base, corrente } = anos(p);
  const meses = corrente !== null ? (p.receitas[corrente]?.meses ?? null) : null;
  const ind = indicadores(p, est);
  const ctx: Contexto = { p, base, corrente, meses, ind };
  const achados = REGRAS.flatMap((r) => r(ctx)).sort(
    (a, b) => NIVEL_ORDEM[a.nivel] - NIVEL_ORDEM[b.nivel] || EIXO_ORDEM[a.eixo] - EIXO_ORDEM[b.eixo] || b.impacto.anual - a.impacto.anual,
  );
  const citados: Record<string, Trecho> = {};
  for (const a of achados) {
    for (const id of a.base_legal) {
      const t = trechos.get(id);
      if (!t) throw new Error(`regra ${a.regra} cita o trecho ${id}, que não está no corpus`);
      citados[id] = t;
    }
  }
  const federais = Object.entries(FONTES).map(([fonte, f]) => ({
    fonte,
    rotulo: f.rotulo,
    eixo: f.eixo,
    ano_base: base !== null ? (p.receitas[base]?.por_fonte[fonte] ?? 0) : null,
    corrente: corrente !== null ? (p.receitas[corrente]?.por_fonte[fonte] ?? 0) : null,
    caixa: p.caixa ? (p.caixa.por_fonte[fonte] ?? 0) : null,
  })).filter((f) => f.ano_base || f.corrente || f.caixa);
  return {
    versao: 1,
    ibge: p.ibge,
    nome: p.nome,
    populacao: p.populacao,
    faixa: p.faixa_populacional,
    gerado_em: hoje.toISOString().slice(0, 10),
    referencia: {
      ano_base: base,
      ano_corrente: corrente,
      meses_corrente: meses,
      caixa_em: p.caixa ? mesAno(p.caixa.mes, p.caixa.ano) : null,
    },
    totais: {
      perda_anual: TOTAL_POR_NATUREZA(achados, 'perda_de_repasse'),
      ganho_anual: TOTAL_POR_NATUREZA(achados.filter((a) => a.impacto.confianca !== 'baixa'), 'ganho_potencial'),
      a_aplicar: TOTAL_POR_NATUREZA(achados, 'valor_a_aplicar'),
      parado: TOTAL_POR_NATUREZA(achados, 'recurso_parado'),
      criticos: achados.filter((a) => a.nivel === 'Crítico').length,
      alertas: achados.filter((a) => a.nivel === 'Alerta').length,
      oportunidades: achados.filter((a) => a.nivel === 'Oportunidade').length,
    },
    achados,
    pendencias: pendencias(p, base),
    indicadores: ind,
    trechos: citados,
    receitas_federais: federais,
    faltas: p.faltas,
  };
}

/** Frase curta com o total, para listas e cartões. */
export function chamada(a: Analise): string {
  const t = a.totais;
  const partes = [
    t.perda_anual ? `${brlCurto(t.perda_anual)}/ano em repasses em risco` : '',
    t.ganho_anual ? `${brlCurto(t.ganho_anual)}/ano a buscar` : '',
    t.a_aplicar ? `${brlCurto(t.a_aplicar)} a aplicar nos mínimos` : '',
    t.parado ? `${brlCurto(t.parado)} parados em caixa` : '',
  ].filter(Boolean);
  return partes.join(' · ') || 'Nenhum gargalo encontrado nos dados abertos';
}
