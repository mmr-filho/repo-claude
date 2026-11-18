/**
 * Caracteres de controle dentro do arquivo enviado (VIG-1c, R6-3): o NUL (U+0000), que o banco não aceita no texto nem
 * no jsonb (o envio caía com 400 genérico, ou com erro interno depois do 202), e os demais caracteres de controle (C0,
 * DEL e C1). A leitura os tira, trocando cada sequência deles por um espaço, e o arquivo ganha um aviso com quantos
 * campos foram limpos. Na célula do CSV, a tabulação e a quebra de linha ficam: fazem parte do texto e do formato (a
 * quebra de linha dentro das aspas). No campo do DBF e no nome da entrada do zip, que não as usam, saem também.
 */

/** Algum caractere de controle fora a tabulação, o LF e o CR (a célula do CSV). */
const NO_TEXTO = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const NO_TEXTO_TODOS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+/g;
/** Algum caractere de controle (o campo do DBF e o nome da entrada do zip). */
const QUALQUER = /[\u0000-\u001f\u007f-\u009f]/;
const QUALQUER_TODOS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** A célula do CSV sem os caracteres de controle (a tabulação e a quebra de linha ficam); null = não tinha nenhum. */
export function limparTexto(v: string): string | null {
  return NO_TEXTO.test(v) ? v.replace(NO_TEXTO_TODOS, ' ') : null;
}

/** O campo do DBF ou o nome da entrada do zip sem nenhum caractere de controle; null = não tinha nenhum. */
export function limparCampo(v: string): string | null {
  return QUALQUER.test(v) ? v.replace(QUALQUER_TODOS, ' ') : null;
}

/** O aviso do arquivo com campos limpos. */
export const avisoCamposLimpos = (n: number) => `${n.toLocaleString('pt-BR')} campo(s) com caractere de controle foram limpos (cada sequência deles virou um espaço).`;

/** O aviso do arquivo do zip com o nome limpo. */
export const AVISO_NOME_LIMPO = 'O nome do arquivo dentro do zip tinha caractere de controle: foi limpo (cada sequência deles virou um espaço).';
