import { lerNumeroPtBr, ROTULO_FONTE_POPULACAO, type CorpoPopulacao, type EstimativaPopulacao, type FontePopulacao, type NivelTerritorio } from '@omnisaude/shared';

/*
 * População do diagrama de controle, sem React (testada em apps/web/test/populacao-colar.test.ts): leitura do texto
 * colado ("ano;população", uma linha por ano), corpo do PUT /vigilancia/populacao e agrupamento por fonte e versão.
 * Os limites são os da API.
 */

export const ANO_MINIMO_POPULACAO = 1990;
export const ANO_MAXIMO_POPULACAO = 2100;
export const POPULACAO_MAXIMA = 2_000_000_000;
export const MAX_LINHAS_POPULACAO = 2000;
export const VERSAO_MAXIMA = 20;
export const NOTA_MAXIMA = 500;
/** O Censo 2022 só vale para o ano do censo. */
export const ANO_CENSO = 2022;

/** Linha lida do texto colado. */
export interface LinhaColada {
  /** Linha do texto, a partir de 1. */
  linha: number;
  ano: number;
  populacao: number;
}

export interface ErroColagem {
  linha: number;
  texto: string;
  erro: string;
}

/** Separa ano e população: ponto e vírgula ou tabulação (cópia de planilha); sem eles, espaço ou vírgula depois do ano. */
function campos(t: string): string[] {
  const partes = t.split(/\s*[;\t]\s*/);
  // Separador sobrando no fim da linha ("2024;1234567;") não conta como coluna.
  while (partes.length > 1 && partes[partes.length - 1] === '') partes.pop();
  if (partes.length > 1) return partes;
  const m = /^(\d{4})[\s,]+(.+)$/.exec(t);
  return m ? [m[1]!, m[2]!] : [t];
}

/**
 * Lê o texto colado: uma linha por ano, "ano;população" (também aceita tabulação, ou espaço/vírgula depois do ano). A
 * população aceita ponto de milhar (1.234.567). Ignora linhas em branco e o cabeçalho (primeira linha sem número).
 * Cada linha com problema volta em `erros`, com o motivo; as boas voltam em `linhas`.
 */
export function lerPopulacaoColada(texto: string, fonte: FontePopulacao): { linhas: LinhaColada[]; erros: ErroColagem[] } {
  const linhas: LinhaColada[] = [];
  const erros: ErroColagem[] = [];
  const anos = new Map<number, number>();
  let primeira = true;
  texto.split(/\r?\n/).forEach((bruta, i) => {
    const t = bruta.trim();
    if (!t) return;
    const n = i + 1;
    const erro = (e: string) => {
      erros.push({ linha: n, texto: t, erro: e });
    };
    const c = campos(t);
    if (primeira) {
      primeira = false;
      // Cabeçalho da planilha ("ano;população"): a primeira linha que não começa com número.
      if (!/^\d/.test(c[0] ?? '')) return;
    }
    if (c.length !== 2) return erro('Use duas colunas: ano;população');
    const [anoTexto, popTexto] = c as [string, string];
    if (!/^\d{4}$/.test(anoTexto)) return erro('Ano inválido: use 4 dígitos (ex.: 2024)');
    const ano = Number(anoTexto);
    if (ano < ANO_MINIMO_POPULACAO || ano > ANO_MAXIMO_POPULACAO) return erro(`Ano fora do intervalo (${ANO_MINIMO_POPULACAO} a ${ANO_MAXIMO_POPULACAO})`);
    if (fonte === 'CENSO_2022' && ano !== ANO_CENSO) return erro('O Censo 2022 só vale para o ano de 2022');
    const populacao = lerNumeroPtBr(popTexto);
    if (populacao === null) return erro('População inválida: use só números, com ponto de milhar se quiser (ex.: 1.234.567)');
    if (!Number.isInteger(populacao) || populacao < 1) return erro('A população precisa ser um número inteiro maior que zero');
    if (populacao > POPULACAO_MAXIMA) return erro('População acima do limite (2 bilhões)');
    const repetida = anos.get(ano);
    if (repetida !== undefined) return erro(`Ano repetido no texto (já está na linha ${repetida})`);
    anos.set(ano, n);
    linhas.push({ linha: n, ano, populacao });
  });
  if (linhas.length > MAX_LINHAS_POPULACAO) erros.push({ linha: linhas[MAX_LINHAS_POPULACAO]!.linha, texto: '', erro: `Mais de ${MAX_LINHAS_POPULACAO.toLocaleString('pt-BR')} linhas: grave em partes` });
  return { linhas, erros };
}

/** Problemas na versão e na nota do lote (limites da API). */
export function errosDoLote(meta: { versao: string; nota: string }): string[] {
  const erros: string[] = [];
  if (meta.versao.trim().length > VERSAO_MAXIMA) erros.push(`A versão tem no máximo ${VERSAO_MAXIMA} caracteres`);
  if (meta.nota.trim().length > NOTA_MAXIMA) erros.push(`A nota tem no máximo ${NOTA_MAXIMA} caracteres`);
  return erros;
}

/** Corpo do PUT /vigilancia/populacao para o território escolhido (no município, sem território). */
export function corpoDaPopulacao(linhas: LinhaColada[], destino: { nivel: NivelTerritorio; territorioId: string | null }, meta: { fonte: FontePopulacao; versao: string; nota: string }): CorpoPopulacao {
  const territorioId = destino.nivel === 'MUNICIPIO' ? null : destino.territorioId;
  return {
    linhas: linhas.map((l) => ({ ano: l.ano, nivel: destino.nivel, territorioId, populacao: l.populacao, fonte: meta.fonte, versao: meta.versao.trim(), nota: meta.nota.trim() || null })),
  };
}

/** Estimativas agrupadas por fonte e versão (a incidência usa uma só fonte e versão em todos os anos), anos em ordem. */
export function gruposDePopulacao(lista: EstimativaPopulacao[]): { fonte: FontePopulacao; versao: string; linhas: EstimativaPopulacao[] }[] {
  const grupos: { fonte: FontePopulacao; versao: string; linhas: EstimativaPopulacao[] }[] = [];
  for (const e of lista) {
    const g = grupos.find((x) => x.fonte === e.fonte && x.versao === e.versao);
    if (g) g.linhas.push(e);
    else grupos.push({ fonte: e.fonte, versao: e.versao, linhas: [e] });
  }
  for (const g of grupos) g.linhas.sort((a, b) => a.ano - b.ano);
  return grupos;
}

/** Fonte e versão que a receita pode escolher: as que o município já tem, com os anos cobertos. */
export interface OpcaoFonte {
  fonte: FontePopulacao;
  versao: string | null;
  rotulo: string;
}

/**
 * Opções de fonte da população para a receita do agravo: cada fonte e versão com estimativa do município (a API
 * recusa a fonte sem população do município), e a escolhida hoje, mesmo que não tenha mais estimativa.
 */
export function opcoesDeFonte(municipio: EstimativaPopulacao[], atual: { fonte: FontePopulacao | null; versao: string | null }): OpcaoFonte[] {
  const out: OpcaoFonte[] = gruposDePopulacao(municipio.filter((e) => e.nivel === 'MUNICIPIO')).map((g) => {
    const de = g.linhas[0]!.ano;
    const ate = g.linhas[g.linhas.length - 1]!.ano;
    return { fonte: g.fonte, versao: g.versao, rotulo: `${ROTULO_FONTE_POPULACAO[g.fonte]}${g.versao ? `, versão ${g.versao}` : ''} (${de === ate ? de : `${de} a ${ate}`})` };
  });
  if (atual.fonte && !out.some((o) => o.fonte === atual.fonte && o.versao === atual.versao))
    out.push({
      fonte: atual.fonte,
      versao: atual.versao,
      rotulo: `${ROTULO_FONTE_POPULACAO[atual.fonte]}${atual.versao === null ? ' (qualquer versão)' : atual.versao ? `, versão ${atual.versao}` : ''} (escolha atual)`,
    });
  return out;
}

/** Valor do seletor de fonte: vazio = escolhida pelo sistema. */
export const valorDaFonte = (o: { fonte: FontePopulacao | null; versao: string | null }) => (o.fonte ? JSON.stringify([o.fonte, o.versao]) : '');

/** Lê o valor do seletor de fonte. */
export function lerValorDaFonte(v: string): { fonte: FontePopulacao | null; versao: string | null } {
  if (!v) return { fonte: null, versao: null };
  const [fonte, versao] = JSON.parse(v) as [FontePopulacao, string | null];
  return { fonte, versao };
}
