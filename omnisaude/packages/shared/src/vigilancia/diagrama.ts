/**
 * Diagrama de controle (canal endêmico) por semana epidemiológica (VIG-1c). Funções iguais às do Excel (MED,
 * QUARTIL.EXC, QUARTIL.INC, MÉDIA, DESVPAD.A e ARRED), em precisão total; arredondar só na exibição. A receita do
 * canal é dado, não código: o método muda entre os documentos do MS (Plano de Contingência 2025, NT 1/2023, VigiEPI
 * 2025, Diretrizes 2009). Ver a pesquisa da semana 27 (diagrama-controle.md).
 */
import { semanasNoAno } from './semana';

/** Como o canal é calculado. */
export interface ReceitaCanal {
  /** QUARTIS: centro = mediana, LI = Q1, LS = Q3. MEDIA_DP: centro = média, LS = média + k·DP, sem LI. */
  metodo: 'QUARTIS' | 'MEDIA_DP';
  /** Função de quartil: QUARTIL.EXC (padrão do MS) ou QUARTIL.INC. */
  quartil: 'EXC' | 'INC';
  /** Multiplicador do desvio-padrão (MEDIA_DP). */
  k: number;
  /** Quantos anos anteriores ao ano em análise entram na referência. */
  anos: number;
  /** NENHUMA: um valor por ano por SE. AGRUPADA_5: junta as SE s−2..s+2 de todos os anos. SUAVIZADA_5: média das SE s−2..s+2 de cada ano. */
  janela: 'NENHUMA' | 'AGRUPADA_5' | 'SUAVIZADA_5';
  /** Janela na virada do ano: só as SE do ano, dentro do próprio ano (SE 0 = SE 52) ou com o ano vizinho. */
  borda: 'TRUNCADA' | 'CIRCULAR' | 'CONTINUA';
  /** Incidência por 100 mil habitantes ou número de casos. */
  unidade: 'INCIDENCIA' | 'CASOS';
  /** Casos prováveis (notificados menos descartados), todos os notificados ou só os confirmados. */
  base: 'PROVAVEIS' | 'NOTIFICADOS' | 'CONFIRMADOS';
  /** No ano em análise entram todos os notificados (Diretrizes 2009). Quem monta a série do ano em análise lê esta marca. */
  anoEmAnaliseTodosNotificados: boolean;
  /** O ano em análise também entra na referência (só para reproduzir a Tabela 1 da NT 1/2023). */
  incluiAnoEmAnalise: boolean;
}

export type ChaveReceitaModelo = 'MS_2025' | 'NT_1_2023' | 'VIGIEPI_2025' | 'DIRETRIZES_2009';

export interface ReceitaModelo {
  nome: string;
  fonte: string;
  nota: string;
  receita: ReceitaCanal;
}

export const ROTULO_METODO_CANAL: Record<ReceitaCanal['metodo'], string> = { QUARTIS: 'Mediana e quartis', MEDIA_DP: 'Média e desvio-padrão' };
export const ROTULO_JANELA_CANAL: Record<ReceitaCanal['janela'], string> = {
  NENHUMA: 'sem janela',
  AGRUPADA_5: 'janela de 5 semanas agrupada (valores das SE s−2 a s+2 de todos os anos)',
  SUAVIZADA_5: 'janela de 5 semanas suavizada (média das SE s−2 a s+2 de cada ano)',
};
export const ROTULO_BORDA_CANAL: Record<ReceitaCanal['borda'], string> = {
  TRUNCADA: 'borda truncada (só as SE do próprio ano)',
  CIRCULAR: 'borda circular no ano (SE 0 = SE 52)',
  CONTINUA: 'borda contínua (SE 51-52 do ano anterior e 1-2 do seguinte, quando estão na referência)',
};
export const ROTULO_UNIDADE_CANAL: Record<ReceitaCanal['unidade'], string> = { INCIDENCIA: 'incidência por 100 mil habitantes', CASOS: 'número de casos' };
export const ROTULO_BASE_CANAL: Record<ReceitaCanal['base'], string> = { PROVAVEIS: 'casos prováveis', NOTIFICADOS: 'casos notificados', CONFIRMADOS: 'casos confirmados' };

const QUARTIS_MS: ReceitaCanal = {
  metodo: 'QUARTIS',
  quartil: 'EXC',
  k: 1.96,
  anos: 5,
  janela: 'NENHUMA',
  borda: 'TRUNCADA',
  unidade: 'INCIDENCIA',
  base: 'PROVAVEIS',
  anoEmAnaliseTodosNotificados: false,
  incluiAnoEmAnalise: false,
};

/** Receitas publicadas. A MS_2025 é o padrão. */
export const RECEITAS_MODELO: Record<ChaveReceitaModelo, ReceitaModelo> = {
  MS_2025: {
    nome: 'Plano de Contingência Nacional (MS, 2025)',
    fonte: 'Plano de Contingência Nacional para Dengue, Chikungunya e Zika (MS, 2025), pp. 22-23',
    nota: 'Para cada SE, mediana, Q1 (limite inferior) e Q3 (limite superior) da incidência de casos prováveis por SE de início dos sintomas, nos 5 anos anteriores ao ano em análise, sem janela. O plano não diz a função de quartil: usa-se a QUARTIL.EXC, a da NT 1/2023 e do VigiEPI.',
    receita: QUARTIS_MS,
  },
  NT_1_2023: {
    nome: 'Nota Técnica nº 1/2023-CGARB',
    fonte: 'Nota Técnica nº 1/2023-CGARB/DEIDT/SVS/MS (SEI 0031215464), itens 3.2 a 3.4, pp. 1-2',
    nota: 'Mediana, Q1 e Q3 (QUARTIL.EXC) da incidência de casos prováveis em 7 anos, um valor por ano em cada SE (item 3.4). A janela de 5 semanas citada no item 3.2 não é explicada: se a vigilância quiser usá-la, a opção é a suavizada (cada ano suavizado antes dos quartis), nunca a agrupada.',
    receita: { ...QUARTIS_MS, anos: 7 },
  },
  VIGIEPI_2025: {
    nome: 'Curso VigiEPI (MS e UnB, 2025)',
    fonte: 'VigiEPI Brasil, Caderno de Prática (MS/UnB, 2025), seção 3, pp. 28-34 (exercício de Londrina, Tabelas 1 e 2)',
    nota: 'Mediana, Q1 e Q3 (MED e QUARTIL.EXC) da incidência em 10 anos, sem janela; exclui os anos epidêmicos que a vigilância indicar. A incidência de cada ano usa a população daquele ano, da mesma fonte em toda a série.',
    receita: { ...QUARTIS_MS, anos: 10 },
  },
  DIRETRIZES_2009: {
    nome: 'Diretrizes Nacionais de 2009 (média móvel)',
    fonte: 'Diretrizes Nacionais para a Prevenção e Controle de Epidemias de Dengue (MS, 2009), Anexo VIII, pp. 129-131',
    nota: 'Média e desvio-padrão amostral dos valores das SE s−2 a s+2 de 10 anos (janela agrupada, borda circular no ano), sem os anos epidêmicos; LS = média + 1,96·DP; sem limite inferior. No ano em análise entram todos os notificados. A tabela de exemplo do anexo usa, na prática, LS = média + 1 DP.',
    receita: { ...QUARTIS_MS, metodo: 'MEDIA_DP', k: 1.96, anos: 10, janela: 'AGRUPADA_5', borda: 'CIRCULAR', anoEmAnaliseTodosNotificados: true },
  },
};

/** Ano excluído da referência, com o motivo (decisão da vigilância). */
export interface AnoExcluido {
  ano: number;
  motivo: string;
}

/** Série de um ano: índice 0 = SE 1 … índice 52 = SE 53; null = sem cobertura (diferente de 0, semana sem caso). */
export interface SerieAnual {
  ano: number;
  semanas: (number | null)[];
  populacao: number | null;
}

/** Valor de um ano de referência numa SE do canal. */
export interface ValorAnoCanal {
  ano: number;
  casos: number | null;
  populacao: number | null;
  /** Casos ou incidência, conforme a receita (na janela suavizada, o valor já suavizado); null = sem cobertura na SE. */
  valor: number | null;
}

/** Uma SE do canal (52 posições; a SE 53 do histórico soma na 52). */
export interface SemanaCanal {
  semana: number;
  valores: ValorAnoCanal[];
  /** Quantos valores válidos entraram no cálculo. */
  n: number;
  centro: number | null;
  li: number | null;
  ls: number | null;
  q1?: number | null;
  mediana?: number | null;
  q3?: number | null;
  media?: number | null;
  dp?: number | null;
}

export interface CanalCalculado {
  receita: ReceitaCanal;
  anosReferencia: number[];
  semanas: SemanaCanal[];
  avisos: string[];
}

/** Ponto da curva observada (53 posições; a SE 53 é comparada com o canal da SE 52). */
export interface PontoObservado {
  semana: number;
  casos: number | null;
  valor: number | null;
}

export type StatusSemana = 'ABAIXO_LI' | 'ATE_CENTRO' | 'ENTRE_CENTRO_E_LS' | 'ACIMA_LS' | 'SEM_CANAL';

export const ROTULO_STATUS_SEMANA: Record<StatusSemana, string> = {
  ABAIXO_LI: 'Abaixo do limite inferior',
  ATE_CENTRO: 'Até o centro',
  ENTRE_CENTRO_E_LS: 'Entre o centro e o limite superior',
  ACIMA_LS: 'Acima do limite superior',
  SEM_CANAL: 'Sem canal',
};

/** Sugestão de anos epidêmicos (regra do painel da SES-GO). Só sugere: a exclusão é decisão da vigilância. */
export interface AnosEpidemicosSugeridos {
  anos: { ano: number; semanasAcima: number; epidemico: boolean }[];
  /** Q3 (QUARTIL.EXC) das contagens; null quando há menos de 3 anos. */
  limiar: number | null;
  nota: string;
}

/** Cabeçalho do CSV do canal. */
export interface MetaCsvCanal {
  /** Ex.: "Dengue, município, 2026". */
  titulo: string;
  /** Ex.: "RIPSA, versão 2025"; null quando a receita é em casos. */
  fontePopulacao: string | null;
  /** Instante da geração (ISO). */
  geradoEm: string;
}

// ───────────── Funções do Excel ─────────────

const SEMANAS_CANAL = 52;
const POR_100_MIL = 100_000;
/** Abaixo disso o diagrama não vale: o MS recomenda a curva epidêmica (Plano 2025, p. 23; nenhum texto dá o número). */
const MINIMO_CASOS_REFERENCIA = 10;

const ordenados = (xs: number[]) => xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);

/** Valor na posição h (base 1) dos valores ordenados, com interpolação linear entre vizinhos. */
function interpolar(s: number[], h: number): number {
  const i = Math.floor(h);
  const f = h - i;
  const baixo = s[i - 1]!;
  return f === 0 ? baixo : baixo + f * (s[i]! - baixo);
}

/** MED do Excel; null sem valores. */
export function mediana(xs: number[]): number | null {
  const s = ordenados(xs);
  const n = s.length;
  if (!n) return null;
  const m = Math.floor(n / 2);
  return n % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** QUARTIL.EXC: h = p·(n+1), interpolação linear; null se h < 1 ou h > n (n < 3). */
export function quartilExc(xs: number[], q: 1 | 3): number | null {
  const s = ordenados(xs);
  const h = (q * (s.length + 1)) / 4;
  if (h < 1 || h > s.length) return null;
  return interpolar(s, h);
}

/** QUARTIL.INC: h = 1 + p·(n−1). */
export function quartilInc(xs: number[], q: 1 | 3): number | null {
  const s = ordenados(xs);
  if (!s.length) return null;
  return interpolar(s, 1 + (q * (s.length - 1)) / 4);
}

/** MÉDIA do Excel; null sem valores. */
export function media(xs: number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x));
  if (!s.length) return null;
  return s.reduce((a, x) => a + x, 0) / s.length;
}

/** DESVPAD.A (amostral, n−1); null se n < 2. */
export function desvioPadraoAmostral(xs: number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x));
  if (s.length < 2) return null;
  const m = s.reduce((a, x) => a + x, 0) / s.length;
  return Math.sqrt(s.reduce((a, x) => a + (x - m) ** 2, 0) / (s.length - 1));
}

/** Dígitos e expoente decimal do valor com 12 algarismos significativos: |valor| = digitos × 10^expoente. */
function decimal12(valor: number): { digitos: bigint; expoente: number } {
  const [mantissa, exp = '0'] = Math.abs(valor).toPrecision(12).split('e');
  const [inteira, fracao = ''] = mantissa!.split('.');
  return { digitos: BigInt(inteira! + fracao), expoente: Number(exp) - fracao.length };
}

/**
 * ARRED do Excel: meia unidade para longe do zero, sobre a representação decimal (nunca o arredondamento do
 * banqueiro). Os 12 algarismos significativos tiram o ruído do ponto flutuante (0,49499999999999994 vira 0,495).
 */
export function arredondar(valor: number, casas: number): number {
  if (!Number.isFinite(valor) || valor === 0) return valor === 0 ? 0 : valor;
  const d = Math.trunc(casas);
  const { digitos, expoente } = decimal12(valor);
  const corte = -d - expoente;
  let r: number;
  if (corte <= 0) r = Number(`${digitos}e${expoente}`);
  else {
    const base = 10n ** BigInt(corte);
    const q = digitos / base + ((digitos % base) * 2n >= base ? 1n : 0n);
    r = Number(`${q}e${-d}`);
  }
  return valor < 0 && r !== 0 ? -r : r;
}

// ───────────── Canal ─────────────

const numeroOuNulo = (x: number | null | undefined): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Casos ou incidência por 100 mil (casos × 100.000 ÷ população: uma divisão só, sem erro acumulado). */
function valorNaUnidade(casos: number | null, populacao: number | null, unidade: ReceitaCanal['unidade']): number | null {
  if (casos === null) return null;
  if (unidade === 'CASOS') return casos;
  return populacao !== null && populacao > 0 ? (casos * POR_100_MIL) / populacao : null;
}

/** 52 posições do histórico: a SE 53 soma na SE 52 do mesmo ano (os casos nunca se perdem). */
function semanasDoHistorico(serie: SerieAnual): (number | null)[] {
  const s = Array.from({ length: SEMANAS_CANAL }, (_, i) => numeroOuNulo(serie.semanas[i]));
  const se53 = numeroOuNulo(serie.semanas[SEMANAS_CANAL]);
  if (se53 !== null) s[SEMANAS_CANAL - 1] = (s[SEMANAS_CANAL - 1] ?? 0) + se53;
  return s;
}

interface AnoReferencia {
  ano: number;
  populacao: number | null;
  casos: (number | null)[];
  valores: (number | null)[];
}

/** Valores da janela de 5 semanas em torno da SE (índice 0 a 51), conforme a borda. */
function valoresDaJanela(ref: AnoReferencia, i: number, borda: ReceitaCanal['borda'], porAno: Map<number, AnoReferencia>): number[] {
  const out: number[] = [];
  for (let o = -2; o <= 2; o++) {
    let j = i + o;
    let alvo: AnoReferencia | undefined = ref;
    if (j < 0 || j >= SEMANAS_CANAL) {
      if (borda === 'TRUNCADA') continue;
      if (borda === 'CIRCULAR') j = (j + SEMANAS_CANAL) % SEMANAS_CANAL;
      else {
        alvo = porAno.get(ref.ano + (j < 0 ? -1 : 1));
        j = (j + SEMANAS_CANAL) % SEMANAS_CANAL;
      }
    }
    const v = alvo?.valores[j] ?? null;
    if (v !== null) out.push(v);
  }
  return out;
}

/** "1 a 5, 9 e 12": lista de SE compactada em faixas. */
function faixas(semanas: number[]): string {
  const partes: string[] = [];
  for (let i = 0; i < semanas.length; ) {
    let j = i;
    while (j + 1 < semanas.length && semanas[j + 1] === semanas[j]! + 1) j++;
    partes.push(j > i ? `${semanas[i]} a ${semanas[j]}` : String(semanas[i]));
    i = j + 1;
  }
  return partes.length > 1 ? `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}` : (partes[0] ?? '');
}

/**
 * Canal do ano em análise a partir das séries anuais (casos por SE) e da receita. Anos de referência: os `anos`
 * anteriores ao ano em análise (mais o próprio, se a receita mandar), menos os excluídos, os sem cobertura e, na
 * incidência, os sem população (estes com aviso). A série do ano em análise não entra (salvo `incluiAnoEmAnalise`).
 */
export function calcularCanal(series: SerieAnual[], anoAnalise: number, receita: ReceitaCanal, anosExcluidos: number[]): CanalCalculado {
  const avisos: string[] = [];
  const excluidos = new Set(anosExcluidos);
  const porAnoSerie = new Map(series.map((s) => [s.ano, s]));
  const janelaAnos = Array.from({ length: Math.max(0, Math.trunc(receita.anos)) }, (_, i) => anoAnalise - Math.trunc(receita.anos) + i);
  if (receita.incluiAnoEmAnalise) janelaAnos.push(anoAnalise);

  const referencia: AnoReferencia[] = [];
  for (const ano of janelaAnos) {
    if (excluidos.has(ano)) continue;
    const serie = porAnoSerie.get(ano);
    const casos = serie ? semanasDoHistorico(serie) : [];
    if (!serie || casos.every((c) => c === null)) {
      avisos.push(`Ano ${ano} fora do canal: sem cobertura (nenhuma base cobre o ano).`);
      continue;
    }
    const populacao = numeroOuNulo(serie.populacao);
    if (receita.unidade === 'INCIDENCIA' && !(populacao !== null && populacao > 0)) {
      avisos.push(`Ano ${ano} fora do canal: sem população para a incidência.`);
      continue;
    }
    referencia.push({ ano, populacao, casos, valores: casos.map((c) => valorNaUnidade(c, populacao, receita.unidade)) });
  }
  if (!referencia.length) avisos.push('Nenhum ano de referência com dados: o canal não pode ser calculado.');

  const porAno = new Map(referencia.map((r) => [r.ano, r]));
  const suavizados = new Map<number, (number | null)[]>();
  if (receita.janela === 'SUAVIZADA_5')
    for (const r of referencia)
      suavizados.set(
        r.ano,
        r.valores.map((_, i) => media(valoresDaJanela(r, i, receita.borda, porAno))),
      );

  const poucos: number[] = [];
  const semanas: SemanaCanal[] = [];
  for (let i = 0; i < SEMANAS_CANAL; i++) {
    const valoresAno: ValorAnoCanal[] = referencia.map((r) => ({
      ano: r.ano,
      casos: r.casos[i] ?? null,
      populacao: r.populacao,
      valor: receita.janela === 'SUAVIZADA_5' ? (suavizados.get(r.ano)![i] ?? null) : (r.valores[i] ?? null),
    }));
    const conjunto = receita.janela === 'AGRUPADA_5' ? referencia.flatMap((r) => valoresDaJanela(r, i, receita.borda, porAno)) : valoresAno.flatMap((v) => (v.valor === null ? [] : [v.valor]));
    const n = conjunto.length;
    if (referencia.length && n < 3) poucos.push(i + 1);
    if (receita.metodo === 'QUARTIS') {
      const quartil = receita.quartil === 'EXC' ? quartilExc : quartilInc;
      const q1 = quartil(conjunto, 1);
      const med = mediana(conjunto);
      const q3 = quartil(conjunto, 3);
      semanas.push({ semana: i + 1, valores: valoresAno, n, centro: med, li: q1, ls: q3, q1, mediana: med, q3 });
    } else {
      const m = media(conjunto);
      const dp = desvioPadraoAmostral(conjunto);
      semanas.push({ semana: i + 1, valores: valoresAno, n, centro: m, li: null, ls: m !== null && dp !== null ? m + receita.k * dp : null, media: m, dp });
    }
  }
  if (poucos.length)
    avisos.push(
      `Menos de 3 valores válidos nas SE ${faixas(poucos)}: ${receita.metodo === 'QUARTIS' && receita.quartil === 'EXC' ? 'o QUARTIL.EXC fica indefinido e a SE fica sem canal' : 'canal frágil nessas semanas'}.`,
    );
  const totalCasos = referencia.reduce((a, r) => a + r.casos.reduce<number>((b, c) => b + (c ?? 0), 0), 0);
  if (referencia.length && totalCasos < MINIMO_CASOS_REFERENCIA)
    avisos.push(`Só ${totalCasos} caso(s) no período de referência: com tão poucos casos, prefira a curva epidêmica (Plano de Contingência Nacional 2025, p. 23).`);
  return { receita, anosReferencia: referencia.map((r) => r.ano), semanas, avisos };
}

/** SE do canal usada para comparar a SE `semana` do ano em análise (a SE 53 usa o canal da SE 52). */
export function semanaDoCanal(canal: CanalCalculado, semana: number): SemanaCanal | null {
  return canal.semanas[Math.min(semana, SEMANAS_CANAL) - 1] ?? null;
}

/** Curva observada do ano na mesma unidade do canal (53 posições; a SE 53 só existe nos anos de 53 semanas). */
export function curvaObservada(serie: SerieAnual, receita: ReceitaCanal): PontoObservado[] {
  const total = semanasNoAno(serie.ano);
  const populacao = numeroOuNulo(serie.populacao);
  return Array.from({ length: SEMANAS_CANAL + 1 }, (_, i) => {
    const casos = i < total ? numeroOuNulo(serie.semanas[i]) : null;
    return { semana: i + 1, casos, valor: valorNaUnidade(casos, populacao, receita.unidade) };
  });
}

/** Posição do valor no canal: centro < valor ≤ LS = ENTRE; valor > LS = ACIMA; valor < LI = ABAIXO_LI. Sem valor, centro ou LS: SEM_CANAL. */
export function statusDaSemana(valor: number | null, semanaCanal: SemanaCanal | null | undefined): StatusSemana {
  if (valor === null || !Number.isFinite(valor) || !semanaCanal || semanaCanal.centro === null || semanaCanal.ls === null) return 'SEM_CANAL';
  if (semanaCanal.li !== null && valor < semanaCanal.li) return 'ABAIXO_LI';
  if (valor <= semanaCanal.centro) return 'ATE_CENTRO';
  if (valor <= semanaCanal.ls) return 'ENTRE_CENTRO_E_LS';
  return 'ACIMA_LS';
}

/**
 * Anos epidêmicos sugeridos entre os `anos` anteriores a `anoAnalise`, pela regra do painel da SES-GO (interpretação
 * documentada): com a média móvel e o DP amostral de todos os anos (janela agrupada de 5 semanas, borda circular),
 * conta-se em quantas SE o valor do ano passou de média + 1 DP; são epidêmicos os anos com contagem ≥ Q3
 * (QUARTIL.EXC) das contagens e pelo menos uma SE acima. Usa a incidência quando todos os anos têm população; senão,
 * os casos.
 */
export function sugerirAnosEpidemicos(series: SerieAnual[], anoAnalise: number, anos: number): AnosEpidemicosSugeridos {
  const janela = new Set(Array.from({ length: Math.max(0, Math.trunc(anos)) }, (_, i) => anoAnalise - Math.trunc(anos) + i));
  const daJanela = series.filter((s) => janela.has(s.ano) && s.semanas.some((c) => numeroOuNulo(c) !== null));
  const unidade: ReceitaCanal['unidade'] = daJanela.length && daJanela.every((s) => (numeroOuNulo(s.populacao) ?? 0) > 0) ? 'INCIDENCIA' : 'CASOS';
  const receita: ReceitaCanal = { ...QUARTIS_MS, metodo: 'MEDIA_DP', k: 1, anos, janela: 'AGRUPADA_5', borda: 'CIRCULAR', unidade };
  const canal = calcularCanal(series, anoAnalise, receita, []);
  const contagens = canal.anosReferencia.map((ano) => ({
    ano,
    semanasAcima: canal.semanas.filter((s) => {
      const v = s.valores.find((x) => x.ano === ano)?.valor ?? null;
      return v !== null && s.ls !== null && v > s.ls;
    }).length,
  }));
  const limiar = quartilExc(
    contagens.map((c) => c.semanasAcima),
    3,
  );
  return {
    // Ano com nenhuma SE acima do limite nunca é epidêmico (com a maioria dos anos em 0, o Q3 também dá 0).
    anos: contagens.map((c) => ({ ...c, epidemico: limiar !== null && c.semanasAcima > 0 && c.semanasAcima >= limiar })),
    limiar,
    nota: `Regra do painel da SES-GO (interpretação): para cada ano, as SE com ${ROTULO_UNIDADE_CANAL[unidade]} acima da média móvel + 1 DP de todos os anos (janela de 5 semanas); epidêmicos os anos com contagem ≥ Q3 (QUARTIL.EXC) das contagens. Só sugere: a exclusão é decisão da vigilância, com motivo.`,
  };
}

// ───────────── CSV ─────────────

/** Texto da receita, para a tela e o CSV. */
export function descreverReceita(r: ReceitaCanal): string {
  const metodo = r.metodo === 'QUARTIS' ? `mediana, Q1 e Q3 (QUARTIL.${r.quartil})` : `média e desvio-padrão amostral, LS = média + ${String(r.k).replace('.', ',')}·DP, sem limite inferior`;
  const anos = `${r.anos} ano(s) anteriores${r.incluiAnoEmAnalise ? ' e o próprio ano em análise' : ''}`;
  const janela = r.janela === 'NENHUMA' ? ROTULO_JANELA_CANAL.NENHUMA : `${ROTULO_JANELA_CANAL[r.janela]}, ${ROTULO_BORDA_CANAL[r.borda]}`;
  const analise = r.anoEmAnaliseTodosNotificados ? '; no ano em análise, todos os notificados' : '';
  return `${metodo}; ${anos}; ${janela}; ${ROTULO_UNIDADE_CANAL[r.unidade]}; ${ROTULO_BASE_CANAL[r.base]}${analise}`;
}

/** Número com vírgula decimal e até 12 algarismos significativos, sem notação científica. */
function numeroCsv(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const { digitos, expoente } = decimal12(v);
  let s = digitos.toString();
  if (expoente >= 0) s += '0'.repeat(expoente);
  else {
    const casas = -expoente;
    s = s.padStart(casas + 1, '0');
    s = `${s.slice(0, s.length - casas)},${s.slice(s.length - casas)}`.replace(/0+$/, '').replace(/,$/, '');
  }
  return v < 0 ? `-${s}` : s;
}

/** Texto de célula protegido contra injeção de fórmula (apóstrofo antes de = + − @) e com aspas quando precisa. */
function celulaTexto(v: string): string {
  const t = /^[=+\-−@\t\r]/.test(v) ? `'${v}` : v;
  return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** Letra da coluna do Excel (1 = A). */
function coluna(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/**
 * CSV do canal para refazer a conta no Excel: ';' como separador, vírgula decimal, começa com o BOM UTF-8. Colunas:
 * SE, um valor por ano de referência, os limites e o observado (casos e valor); nas primeiras linhas, método, receita,
 * fonte da população e as fórmulas equivalentes. Texto protegido contra injeção de fórmula.
 */
export function csvDoCanal(canal: CanalCalculado, observado: PontoObservado[], meta: MetaCsvCanal): string {
  const r = canal.receita;
  const anos = canal.anosReferencia;
  const quartis = r.metodo === 'QUARTIS';
  const preambulo: string[][] = [
    ['Diagrama de controle', meta.titulo],
    ['Método', quartis ? `${ROTULO_METODO_CANAL.QUARTIS} (QUARTIL.${r.quartil})` : `${ROTULO_METODO_CANAL.MEDIA_DP} amostral, LS = média + ${String(r.k).replace('.', ',')}·DP`],
    ['Receita', descreverReceita(r)],
    ['Anos de referência', anos.length ? anos.join(', ') : 'nenhum'],
    ['População', r.unidade === 'CASOS' ? 'não se aplica (receita em número de casos)' : (meta.fontePopulacao ?? 'não informada')],
    ['Gerado em', meta.geradoEm],
  ];
  const agrupada = r.janela === 'AGRUPADA_5';
  const notas: string[] = [];
  if (anos.length && agrupada) notas.push(`Janela agrupada: cada SE usa as linhas da SE s−2 a s+2 de todos os anos; nas SE 1, 2, 51 e 52 vale a ${ROTULO_BORDA_CANAL[r.borda]}.`);
  if (anos.length && r.janela === 'SUAVIZADA_5') notas.push(`Os valores por ano já estão suavizados (média das SE s−2 a s+2 do próprio ano; ${ROTULO_BORDA_CANAL[r.borda]}).`);
  notas.push('A SE 53 do ano em análise é comparada com o canal da SE 52.');
  // Linha da SE 1 no arquivo: preâmbulo, fórmulas, notas, avisos, linha em branco e cabeçalho vêm antes.
  const primeiraLinha = preambulo.length + 1 + notas.length + canal.avisos.length + 2 + 1;
  const formulas: string[] = [];
  if (anos.length) {
    const faixa = `B${primeiraLinha}:${coluna(1 + anos.length)}${agrupada ? primeiraLinha + 4 : primeiraLinha}`;
    const quando = agrupada ? ' (SE 3)' : ' (SE 1)';
    if (quartis) {
      const f = `QUARTIL.${r.quartil}`;
      formulas.push(`Mediana${quando} = MED(${faixa})`, `Q1${quando} = ${f}(${faixa};1)`, `Q3${quando} = ${f}(${faixa};3)`);
    } else {
      const k = String(r.k).replace('.', ',');
      formulas.push(`Média${quando} = MÉDIA(${faixa})`, `DP${quando} = DESVPAD.A(${faixa})`, `LS${quando} = MÉDIA(${faixa})+${k}*DESVPAD.A(${faixa})`);
    }
  } else formulas.push('Sem anos de referência: não há fórmula.');

  const limites = quartis ? ['Q1 (limite inferior)', 'Mediana (centro)', 'Q3 (limite superior)'] : ['Média (centro)', 'DP', 'Limite superior'];
  const cabecalho = ['SE', ...anos.map(String), ...limites, 'Observado (casos)', `Observado (${r.unidade === 'CASOS' ? 'valor' : 'incidência'})`];
  const linhas: string[][] = [...preambulo, ['Fórmulas do Excel', ...formulas], ...notas.map((n) => ['Nota', n]), ...canal.avisos.map((a) => ['Aviso', a]), [], cabecalho];
  const textoDe = (cels: string[]) => cels.map(celulaTexto);
  const saida = linhas.map(textoDe);
  for (const s of canal.semanas) {
    const obs = observado[s.semana - 1];
    const lim = quartis ? [s.q1, s.mediana, s.q3] : [s.media, s.dp, s.ls];
    saida.push([String(s.semana), ...anos.map((a) => numeroCsv(s.valores.find((v) => v.ano === a)?.valor)), ...lim.map(numeroCsv), numeroCsv(obs?.casos), numeroCsv(obs?.valor)]);
  }
  const se53 = observado[SEMANAS_CANAL];
  if (se53 && (se53.casos !== null || se53.valor !== null)) {
    const s52 = canal.semanas[SEMANAS_CANAL - 1];
    const lim = s52 ? (quartis ? [s52.q1, s52.mediana, s52.q3] : [s52.media, s52.dp, s52.ls]) : [null, null, null];
    saida.push(['53', ...anos.map(() => ''), ...lim.map(numeroCsv), numeroCsv(se53.casos), numeroCsv(se53.valor)]);
  }
  return `\uFEFF${saida.map((c) => c.join(';')).join('\r\n')}\r\n`;
}
