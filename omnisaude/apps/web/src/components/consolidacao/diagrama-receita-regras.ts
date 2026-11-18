import { RECEITAS_MODELO, type ChaveReceitaModelo, type ConfiguracaoDiagrama, type CorpoConfiguracaoDiagrama, type FontePopulacao, type ReceitaCanal } from '@omnisaude/shared';
import { lerValorDaFonte, valorDaFonte } from './populacao-colar';

/*
 * Receita do diagrama de controle (modelo, ajustes, anos excluídos e fonte da população), sem React (testada em
 * apps/web/test/diagrama-receita.test.ts). As regras do método (QUARTIL.EXC com 3 anos ou mais etc.) ficam na API,
 * que devolve a lista de problemas; aqui só os limites do formulário.
 */

export const CHAVES_MODELO = Object.keys(RECEITAS_MODELO) as ChaveReceitaModelo[];
export const MOTIVO_MINIMO_EXCLUSAO = 10;
export const MOTIVO_MAXIMO_EXCLUSAO = 500;
export const MAX_ANOS_EXCLUIDOS = 30;
export const ANOS_REFERENCIA = { min: 1, max: 20 };
export const K_MAXIMO = 5;

/** Formulário da receita: a receita inteira (modelo + ajustes) e os anos excluídos como texto, para os campos. */
export interface FormularioReceita {
  modelo: ChaveReceitaModelo | null;
  receita: ReceitaCanal;
  anosExcluidos: { ano: string; motivo: string }[];
  /** Valor do seletor de fonte (`valorDaFonte`): vazio = escolhida pelo sistema. */
  fonte: string;
}

const CAMPOS = Object.keys(RECEITAS_MODELO.MS_2025.receita) as (keyof ReceitaCanal)[];

export function formularioDaConfiguracao(c: ConfiguracaoDiagrama): FormularioReceita {
  return {
    modelo: c.modelo,
    receita: { ...c.receita },
    anosExcluidos: c.anosExcluidos.map((a) => ({ ano: String(a.ano), motivo: a.motivo })),
    fonte: valorDaFonte({ fonte: c.fontePopulacao, versao: c.versaoPopulacao }),
  };
}

/** Campos da receita que diferem do modelo. */
export function ajustesDoModelo(modelo: ChaveReceitaModelo, receita: ReceitaCanal): Partial<ReceitaCanal> {
  const base = RECEITAS_MODELO[modelo].receita;
  const out: Partial<ReceitaCanal> = {};
  for (const c of CAMPOS) if (receita[c] !== base[c]) (out as Record<string, unknown>)[c] = receita[c];
  return out;
}

/** Modelo igual à receita (como a API devolve), ou null para receita própria. */
export function modeloDaReceita(receita: ReceitaCanal): ChaveReceitaModelo | null {
  return CHAVES_MODELO.find((m) => Object.keys(ajustesDoModelo(m, receita)).length === 0) ?? null;
}

/** Troca de modelo: a receita volta à do modelo; "receita própria" (null) mantém a atual para ajustar. */
export function aplicarModelo(f: FormularioReceita, modelo: ChaveReceitaModelo | null): FormularioReceita {
  return { ...f, modelo, receita: modelo ? { ...RECEITAS_MODELO[modelo].receita } : { ...f.receita } };
}

/**
 * Janelas que o método aceita: com mediana e quartis, a janela de 5 semanas é a suavizada (a agrupada é só da média
 * e desvio-padrão, Diretrizes 2009).
 */
export function janelasDoMetodo(metodo: ReceitaCanal['metodo']): ReceitaCanal['janela'][] {
  return metodo === 'QUARTIS' ? ['NENHUMA', 'SUAVIZADA_5'] : ['NENHUMA', 'AGRUPADA_5', 'SUAVIZADA_5'];
}

/** Ajusta um campo da receita; trocar o método leva a janela para uma que ele aceita. */
export function ajustarReceita<K extends keyof ReceitaCanal>(r: ReceitaCanal, campo: K, valor: ReceitaCanal[K]): ReceitaCanal {
  const nova = { ...r, [campo]: valor };
  if (!janelasDoMetodo(nova.metodo).includes(nova.janela)) nova.janela = 'NENHUMA';
  return nova;
}

/** Motivo sugerido para excluir um ano que a regra da SES-GO marcou como epidêmico (a vigilância confirma ou troca). */
export const motivoSugerido = (semanasAcima: number) => `Ano epidêmico pela regra do painel da SES-GO: ${semanasAcima} SE acima da média móvel + 1 DP.`;

/**
 * Corpo do PUT /vigilancia/diagrama/configuracao/:grupo e os problemas do formulário (limites da API: anos de 1990
 * ao ano em curso, motivo de 10 a 500 caracteres, sem ano repetido, até 30 anos; anos de referência de 1 a 20; k
 * maior que zero e até 5). Com problema, `corpo` é null.
 */
export function corpoDaReceita(f: FormularioReceita, anoAtual: number): { corpo: CorpoConfiguracaoDiagrama | null; erros: string[] } {
  const erros: string[] = [];
  const r = f.receita;
  if (!Number.isInteger(r.anos) || r.anos < ANOS_REFERENCIA.min || r.anos > ANOS_REFERENCIA.max) erros.push(`Anos de referência: de ${ANOS_REFERENCIA.min} a ${ANOS_REFERENCIA.max}.`);
  // A API confere o k em qualquer método (ele fica guardado na receita, mesmo nos quartis).
  if (!(r.k > 0 && r.k <= K_MAXIMO)) erros.push(`Multiplicador do desvio-padrão: maior que zero e até ${K_MAXIMO}.`);
  if (!janelasDoMetodo(r.metodo).includes(r.janela)) erros.push('Com mediana e quartis, a janela de 5 semanas é a suavizada.');
  if (f.anosExcluidos.length > MAX_ANOS_EXCLUIDOS) erros.push(`No máximo ${MAX_ANOS_EXCLUIDOS} anos excluídos.`);
  const vistos = new Set<number>();
  const anosExcluidos = f.anosExcluidos.map((a) => ({ ano: Number(a.ano.trim()), motivo: a.motivo.trim() }));
  for (const a of anosExcluidos) {
    if (!Number.isInteger(a.ano) || a.ano < 1990 || a.ano > anoAtual) {
      erros.push(`Ano excluído inválido: use um ano de 1990 a ${anoAtual}.`);
      continue;
    }
    if (vistos.has(a.ano)) erros.push(`O ano ${a.ano} aparece duas vezes nos anos excluídos.`);
    vistos.add(a.ano);
    if (a.motivo.length < MOTIVO_MINIMO_EXCLUSAO) erros.push(`Escreva o motivo da exclusão de ${a.ano} (mínimo de ${MOTIVO_MINIMO_EXCLUSAO} caracteres).`);
    if (a.motivo.length > MOTIVO_MAXIMO_EXCLUSAO) erros.push(`O motivo da exclusão de ${a.ano} tem no máximo ${MOTIVO_MAXIMO_EXCLUSAO} caracteres.`);
  }
  if (erros.length) return { corpo: null, erros };
  const { fonte, versao } = lerValorDaFonte(f.fonte);
  const ajustes = f.modelo ? ajustesDoModelo(f.modelo, r) : { ...r };
  return {
    corpo: {
      modelo: f.modelo,
      ...(Object.keys(ajustes).length ? { receita: ajustes } : {}),
      anosExcluidos: [...anosExcluidos].sort((a, b) => a.ano - b.ano),
      fontePopulacao: fonte as FontePopulacao | null,
      versaoPopulacao: fonte ? versao : null,
    },
    erros,
  };
}
