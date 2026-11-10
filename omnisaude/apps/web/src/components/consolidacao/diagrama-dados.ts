import { arredondar, ROTULO_FONTE_POPULACAO, type EixoDiagrama, type NivelTerritorio, type PopulacaoUsada, type ReceitaCanal, type RespostaDiagrama, type StatusSemana } from '@omnisaude/shared';

/*
 * Dados da aba Diagrama de controle, sem React (testados em apps/web/test/diagrama-dados.test.ts). O gráfico e a
 * tabela usam as mesmas linhas, para os números baterem. Os valores ficam em precisão total; só a exibição arredonda,
 * com o ARRED do Excel (`arredondar`), como a planilha da vigilância.
 */

export type UnidadeCanal = ReceitaCanal['unidade'];
export type MetodoCanal = ReceitaCanal['metodo'];

/** Uma semana do eixo: o que o gráfico desenha e a tabela mostra. */
export interface LinhaDiagrama {
  /** Chave única no eixo ("2026-05"): o eixo sazonal tem dois anos. */
  chave: string;
  ano: number;
  semana: number;
  /** "SS/AAAA". */
  rotulo: string;
  casos: number | null;
  valor: number | null;
  li: number | null;
  centro: number | null;
  ls: number | null;
  /** Faixa do canal: [LI, LS] nos quartis; [0, LS] na média e desvio-padrão, que não tem limite inferior. */
  faixa: [number, number] | null;
  /** Curva observada nas semanas completas (traço contínuo). */
  observado: number | null;
  /** Curva nas semanas incompletas, mais a semana completa vizinha para ligar os traços (tracejado). */
  incompleto: number | null;
  status: StatusSemana;
  incompleta: boolean;
  metodo: MetodoCanal | null;
  /** Ponto sem vizinho na própria série: o gráfico desenha um marcador para ele não sumir. */
  isoladoObservado: boolean;
  isoladoIncompleto: boolean;
}

/** Linhas do gráfico e da tabela, na ordem do eixo (no sazonal, SE 27 do ano a SE 26 do seguinte). */
export function linhasDoDiagrama(r: Pick<RespostaDiagrama, 'pontos' | 'canais'>): LinhaDiagrama[] {
  const metodoDoAno = new Map(r.canais.map((c) => [c.ano, c.canal.receita.metodo]));
  const linhas: LinhaDiagrama[] = r.pontos.map((p) => {
    const metodo = metodoDoAno.get(p.ano) ?? null;
    const li = p.canal?.li ?? null;
    const centro = p.canal?.centro ?? null;
    const ls = p.canal?.ls ?? null;
    const faixa: [number, number] | null = ls === null ? null : metodo === 'MEDIA_DP' ? [0, ls] : li === null ? null : [li, ls];
    return {
      chave: `${p.ano}-${String(p.semana).padStart(2, '0')}`,
      ano: p.ano,
      semana: p.semana,
      rotulo: p.rotulo,
      casos: p.casos,
      valor: p.valor,
      li,
      centro,
      ls,
      faixa,
      observado: p.incompleta ? null : p.valor,
      incompleto: p.incompleta ? p.valor : null,
      status: p.status,
      incompleta: p.incompleta,
      metodo,
      isoladoObservado: false,
      isoladoIncompleto: false,
    };
  });
  // A semana completa vizinha de uma incompleta entra também no tracejado, para a curva não ter um buraco.
  linhas.forEach((l, i) => {
    if (l.incompleta || l.valor === null) return;
    if ([linhas[i - 1], linhas[i + 1]].some((v) => v?.incompleta && v.valor !== null)) l.incompleto = l.valor;
  });
  const isolado = (i: number, campo: 'observado' | 'incompleto') => linhas[i]![campo] !== null && (linhas[i - 1]?.[campo] ?? null) === null && (linhas[i + 1]?.[campo] ?? null) === null;
  linhas.forEach((l, i) => {
    l.isoladoObservado = isolado(i, 'observado');
    l.isoladoIncompleto = isolado(i, 'incompleto');
  });
  return linhas;
}

/**
 * Unidade e método do gráfico: os do canal do ano pedido (o congelado guarda a receita com que foi calculado). No
 * eixo sazonal os dois canais podem ter receitas diferentes: `misturada` avisa a tela.
 */
export function receitaDoGrafico(r: Pick<RespostaDiagrama, 'canais' | 'configuracao'>): { unidade: UnidadeCanal; metodo: MetodoCanal; k: number; misturada: boolean } {
  const receitas = r.canais.map((c) => c.canal.receita);
  const base = receitas[0] ?? r.configuracao.receita;
  const misturada = receitas.some((x) => x.unidade !== base.unidade || x.metodo !== base.metodo || (x.metodo === 'MEDIA_DP' && x.k !== base.k));
  return { unidade: base.unidade, metodo: base.metodo, k: base.k, misturada };
}

/** Rótulos da legenda, da tabela e da dica conforme o método do canal. */
export function rotulosDoCanal(metodo: MetodoCanal, k: number) {
  const kTexto = String(k).replace('.', ',');
  return metodo === 'QUARTIS'
    ? { faixa: 'Faixa do canal (Q1 a Q3)', li: 'Limite inferior (Q1)', centro: 'Mediana (centro)', ls: 'Limite superior (Q3)', liCurto: 'Q1', centroCurto: 'Mediana', lsCurto: 'Q3' }
    : {
        faixa: 'Faixa do canal (até o limite superior)',
        li: 'Sem limite inferior',
        centro: 'Média (centro)',
        ls: `Limite superior (média + ${kTexto} DP)`,
        liCurto: 'LI',
        centroCurto: 'Média',
        lsCurto: 'LS',
      };
}

/** Nome da medida no eixo Y e na tabela. */
export const ROTULO_MEDIDA: Record<UnidadeCanal, string> = { INCIDENCIA: 'Incidência por 100 mil habitantes', CASOS: 'Casos' };

/**
 * Número do canal e da curva no formato brasileiro, arredondado como o ARRED do Excel: incidência sempre com 2
 * casas; casos com até 2 (a mediana e os quartis podem ter fração). Sem valor, "—".
 */
export function fmtValor(v: number | null | undefined, unidade: UnidadeCanal): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return arredondar(v, 2).toLocaleString('pt-BR', { minimumFractionDigits: unidade === 'INCIDENCIA' ? 2 : 0, maximumFractionDigits: 2 });
}

/** Contagem de casos (inteira). */
export const fmtCasos = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('pt-BR'));

/** Marca do eixo Y: inteiro, com ponto de milhar; a partir de 10 mil, compacta (10 mil, 20 mil). */
export function fmtMarcaY(v: number): string {
  if (Math.abs(v) >= 10_000) return `${arredondar(v / 1000, 1).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return arredondar(v, 2).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

/**
 * Marcas do eixo X: a cada 4 semanas a partir do começo de cada trecho do mesmo ano (1, 5, 9…; no sazonal, 27, 31…
 * e depois 1, 5…). Devolve as chaves das linhas marcadas.
 */
export function marcasDoEixo(linhas: Pick<LinhaDiagrama, 'chave' | 'ano' | 'semana'>[]): string[] {
  const out: string[] = [];
  let inicio = 0;
  linhas.forEach((l, i) => {
    if (i === 0 || l.ano !== linhas[i - 1]!.ano) inicio = l.semana;
    if ((l.semana - inicio) % 4 === 0) out.push(l.chave);
  });
  return out;
}

/** Primeira linha do segundo ano no eixo sazonal (onde o gráfico marca a virada do ano); null no eixo epidemiológico. */
export function viradaDoAno(linhas: Pick<LinhaDiagrama, 'chave' | 'ano'>[]): { chave: string; ano: number } | null {
  const i = linhas.findIndex((l, j) => j > 0 && l.ano !== linhas[j - 1]!.ano);
  return i < 0 ? null : { chave: linhas[i]!.chave, ano: linhas[i]!.ano };
}

/** Semanas incompletas que estão no eixo mostrado (AAAASS), na ordem do eixo. Ver um ano passado não tem nenhuma. */
export const semanasIncompletasDoEixo = (linhas: Pick<LinhaDiagrama, 'ano' | 'semana' | 'incompleta'>[]) => linhas.filter((l) => l.incompleta).map((l) => `${l.ano}${String(l.semana).padStart(2, '0')}`);

/** "SE 44 e 45/2026"; na virada do ano, "SE 52/2025 e 1/2026". Vazio sem semanas. */
export function textoSemanas(codigos: string[]): string {
  const porAno: { ano: string; semanas: number[] }[] = [];
  for (const c of codigos) {
    const ano = c.slice(0, 4);
    const se = Number(c.slice(4));
    const g = porAno.find((x) => x.ano === ano);
    if (g) g.semanas.push(se);
    else porAno.push({ ano, semanas: [se] });
  }
  if (!porAno.length) return '';
  const lista = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}` : (xs[0] ?? ''));
  return `SE ${lista(porAno.map((g) => `${lista(g.semanas.map(String))}/${g.ano}`))}`;
}

/** Tom do selo de cada situação da semana no canal (sempre junto do texto, nunca só a cor). */
export const TOM_STATUS: Record<StatusSemana, 'blue' | 'green' | 'amber' | 'red' | 'slate'> = {
  ABAIXO_LI: 'blue',
  ATE_CENTRO: 'green',
  ENTRE_CENTRO_E_LS: 'amber',
  ACIMA_LS: 'red',
  SEM_CANAL: 'slate',
};

/** Última semana completa com valor (a que vale para a situação do agravo); null se não houver. */
export function ultimaSemanaCompleta(linhas: LinhaDiagrama[]): LinhaDiagrama | null {
  for (let i = linhas.length - 1; i >= 0; i--) if (!linhas[i]!.incompleta && linhas[i]!.valor !== null) return linhas[i]!;
  return null;
}

/** Semanas completas acima do limite superior no eixo mostrado. */
export const semanasAcimaDoLs = (linhas: LinhaDiagrama[]) => linhas.filter((l) => !l.incompleta && l.status === 'ACIMA_LS').length;

/** Consulta de GET /vigilancia/diagrama e do CSV (sem território no município). */
export function consultaDiagrama(f: { grupo: string; nivel: NivelTerritorio; territorio: string | null; ano: number; eixo: EixoDiagrama }): string {
  const q = new URLSearchParams({ grupo: f.grupo, nivel: f.nivel, ano: String(f.ano), eixo: f.eixo });
  if (f.nivel !== 'MUNICIPIO' && f.territorio) q.set('territorio', f.territorio);
  return `?${q.toString()}`;
}

/** Anos do seletor: do próximo ano (o eixo sazonal começa no meio do ano) até 2000, o piso da API. */
export function anosDoSeletor(anoAtual: number): number[] {
  return Array.from({ length: Math.max(0, anoAtual + 1 - 2000 + 1) }, (_, i) => anoAtual + 1 - i);
}

export const ROTULO_ORIGEM_POPULACAO: Record<PopulacaoUsada['origem'], string> = {
  OFICIAL: 'Estimativa do ano',
  REPETIDA: 'Repetida (último ano da mesma fonte)',
  ESTIMADA: 'Estimada (proporção do Censo 2022)',
  AUSENTE: 'Sem população',
};

/** Fonte e versão da população num texto curto ("RIPSA/MS (…), versão 2025"). */
export function textoFonte(fonte: PopulacaoUsada['fonte'], versao: string | null): string {
  if (!fonte) return '—';
  return `${ROTULO_FONTE_POPULACAO[fonte]}${versao ? `, versão ${versao}` : ''}`;
}

/** Descrição do gráfico para leitores de tela (os números ficam na tabela logo abaixo). */
export function descricaoDoGrafico(r: Pick<RespostaDiagrama, 'agravo' | 'territorio' | 'ano' | 'eixo'>, unidade: UnidadeCanal): string {
  const eixo = r.eixo === 'SAZONAL' ? `ano sazonal ${r.ano}/${r.ano + 1} (SE 27 a SE 26)` : `ano epidemiológico ${r.ano}`;
  return `Diagrama de controle de ${r.agravo}, ${r.territorio.nome}, ${eixo}, em ${ROTULO_MEDIDA[unidade].toLowerCase()}: faixa do canal, centro, limite superior e curva observada por semana. Os mesmos números estão na tabela abaixo do gráfico.`;
}
