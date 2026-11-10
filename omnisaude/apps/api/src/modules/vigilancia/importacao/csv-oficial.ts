import { decodificarCp1252 } from './codepages';
import { ErroArquivo, type LinhaArquivo } from './dbf';

/**
 * Leitor dos CSV do e-SUS Notifica e do e-SUS Sinan (VIG-1c, frente F2): tira o BOM; UTF-8 e, se inválido,
 * windows-1252 com aviso; separador ';' ou ',' pelo cabeçalho; aspas e CRLF; cabeçalho normalizado (sem acento,
 * minúsculas, sem pontuação) com sinônimos; recusa arquivo regravado pelo Excel (número em notação científica na
 * coluna do número da notificação, do CPF ou do CNS).
 */

export interface LeituraCsv {
  separador: ';' | ',';
  codificacao: 'UTF8' | 'CP1252';
  /** Colunas normalizadas (`normalizarCabecalho`), na ordem do arquivo. */
  colunas: string[];
  colunasOriginais: string[];
  avisos: string[];
  /** Iterador preguiçoso; as chaves são as colunas normalizadas. Lança `ErroArquivo` no arquivo regravado pelo Excel. */
  linhas(): IterableIterator<LinhaArquivo>;
  /** Linha do arquivo (a partir de 1, o cabeçalho é a 1) da última linha entregue pelo iterador. */
  linhaAtual(): number;
}

/**
 * Sinônimos do cabeçalho (forma normalizada → forma usada no código). A grafia muda entre versões e fontes
 * (dicionário de 25/11/2022, manuais do RS, amostras): "Evolução Caso" × "Evolução do Caso" etc.
 */
const SINONIMOS: Readonly<Record<string, string>> = {
  'evolucao do caso': 'evolucao caso',
  'numero notificacao': 'numero da notificacao',
  'n da notificacao': 'numero da notificacao',
  'no da notificacao': 'numero da notificacao',
  'data notificacao': 'data da notificacao',
  'data de notificacao': 'data da notificacao',
  'data de inicio dos sintomas': 'data do inicio dos sintomas',
  'data inicio dos sintomas': 'data do inicio dos sintomas',
  'data de inicio de sintomas': 'data do inicio dos sintomas',
  'data do inicio de sintomas': 'data do inicio dos sintomas',
  'data inicio sintomas': 'data do inicio dos sintomas',
  'data do encerramento': 'data de encerramento',
  'data encerramento': 'data de encerramento',
  'data nascimento': 'data de nascimento',
  'cnes da notificacao': 'cnes notificacao',
  'cnes de notificacao': 'cnes notificacao',
  'municipio de notificacao': 'municipio da notificacao',
  'estado de notificacao': 'estado da notificacao',
  'municipio residencia': 'municipio de residencia',
  'estado residencia': 'estado de residencia',
  'nome da mae': 'nome completo da mae',
  'nome completo mae': 'nome completo da mae',
  'telefone de contato': 'telefone 1',
  'logradouro endereco': 'logradouro',
  classificacao: 'classificacao final',
};

/** Cabeçalho sem acento, em minúsculas, sem pontuação e com os sinônimos resolvidos ('evolucao caso' = 'evolucao do caso'). */
export function normalizarCabecalho(coluna: string): string {
  const base = coluna
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // "e-mail" = "email"; "Sintoma- Febre" = "sintoma febre"
    .replace(/-/g, '')
    .replace(/[^a-z0-9_ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return SINONIMOS[base] ?? base;
}

/** Colunas que o Excel estraga ao abrir o CSV (número longo vira notação científica e perde os dígitos). */
const COLUNAS_NUMERO_LONGO = ['numero da notificacao', 'nu_notific', 'cpf', 'nu_cpf', 'cns', 'id_cns_sus', 'nu_cns'];
const NOTACAO_CIENTIFICA = /^\d+(?:[.,]\d+)?e[+-]?\d+$/i;

const ASPAS = 34;
const LF = 10;
const CR = 13;
const quebras = (texto: string, de: number, ate: number) => {
  let n = 0;
  for (let k = de; k < ate; k++) if (texto.charCodeAt(k) === LF) n++;
  return n;
};

/** Registros do CSV: campos de cada linha lógica (aspas com separador ou quebra de linha dentro; "" vira "). */
function* registrosCsv(texto: string, separador: string): IterableIterator<{ campos: string[]; linha: number }> {
  const n = texto.length;
  const sep = separador.charCodeAt(0);
  const fimDoCampo = (de: number) => {
    let k = de;
    while (k < n) {
      const c = texto.charCodeAt(k);
      if (c === sep || c === LF || c === CR) break;
      k++;
    }
    return k;
  };
  let i = 0;
  let linha = 1;
  while (i < n) {
    const campos: string[] = [];
    const inicioLinha = linha;
    for (;;) {
      if (texto.charCodeAt(i) === ASPAS) {
        let campo = '';
        i++;
        for (;;) {
          const j = texto.indexOf('"', i);
          if (j < 0) {
            campo += texto.slice(i);
            linha += quebras(texto, i, n);
            i = n;
            break;
          }
          campo += texto.slice(i, j);
          linha += quebras(texto, i, j);
          if (texto.charCodeAt(j + 1) === ASPAS) {
            campo += '"';
            i = j + 2;
            continue;
          }
          i = j + 1;
          break;
        }
        // O que vier depois da aspa de fechamento, até o separador, entra no campo (tolerância).
        const k = fimDoCampo(i);
        campos.push(campo + texto.slice(i, k));
        i = k;
      } else {
        const k = fimDoCampo(i);
        campos.push(texto.slice(i, k));
        i = k;
      }
      if (i >= n) break;
      const c = texto.charCodeAt(i);
      if (c === sep) {
        i++;
        if (i >= n) {
          campos.push('');
          break;
        }
        continue;
      }
      if (c === CR && texto.charCodeAt(i + 1) === LF) i++;
      i++;
      linha++;
      break;
    }
    yield { campos, linha: inicioLinha };
  }
}

export function lerCsvOficial(bytes: Uint8Array, opcoes?: { codificacao?: 'UTF8' | 'CP1252' }): LeituraCsv {
  const avisos: string[] = [];
  let dados = bytes;
  if (dados.length >= 3 && dados[0] === 0xef && dados[1] === 0xbb && dados[2] === 0xbf) dados = dados.subarray(3);
  let texto: string;
  let codificacao: 'UTF8' | 'CP1252';
  if (opcoes?.codificacao === 'CP1252') {
    texto = decodificarCp1252(dados);
    codificacao = 'CP1252';
  } else {
    try {
      texto = new TextDecoder('utf-8', { fatal: true }).decode(dados);
      codificacao = 'UTF8';
    } catch {
      if (opcoes?.codificacao === 'UTF8') throw new ErroArquivo('O arquivo não é UTF-8 válido');
      texto = decodificarCp1252(dados);
      codificacao = 'CP1252';
      avisos.push('O arquivo não é UTF-8 válido: foi lido como Windows-1252. Confira os acentos na prévia.');
    }
  }
  // BOM que sobrou depois da decodificação (arquivo com dois BOMs ou BOM em CP1252).
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);

  // Separador pelo cabeçalho: o que mais aparece fora de aspas na primeira linha (empate: ponto e vírgula).
  let fora = true;
  let pv = 0;
  let virgulas = 0;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]!;
    if (c === '"') fora = !fora;
    else if (fora && (c === '\n' || c === '\r')) break;
    else if (fora && c === ';') pv++;
    else if (fora && c === ',') virgulas++;
  }
  const separador: ';' | ',' = virgulas > pv ? ',' : ';';

  const iter = registrosCsv(texto, separador);
  const primeiro = iter.next();
  if (primeiro.done) throw new ErroArquivo('CSV vazio');
  const colunasOriginais = primeiro.value.campos.map((c) => c.trim());
  if (colunasOriginais.length < 2) throw new ErroArquivo('CSV sem colunas reconhecíveis (separador deve ser ponto e vírgula ou vírgula)');
  const colunas = colunasOriginais.map(normalizarCabecalho);
  const repetidas = colunas.filter((c, i) => c && colunas.indexOf(c) !== i);
  if (repetidas.length) avisos.push(`Colunas repetidas no cabeçalho (fica a primeira): ${[...new Set(repetidas)].join(', ')}.`);
  const vigiadas = colunas.map((c, i) => (COLUNAS_NUMERO_LONGO.includes(c) ? i : -1)).filter((i) => i >= 0);

  let linhaAtual = 1;
  let foraDoPadrao = 0;
  let consumido = false;
  return {
    separador,
    codificacao,
    colunas,
    colunasOriginais,
    avisos,
    linhaAtual: () => linhaAtual,
    *linhas() {
      if (consumido) throw new Error('As linhas do CSV só podem ser lidas uma vez');
      consumido = true;
      for (const { campos, linha } of iter) {
        linhaAtual = linha;
        if (campos.every((c) => !c.trim())) continue;
        if (campos.length !== colunas.length) foraDoPadrao++;
        for (const i of vigiadas) {
          const v = (campos[i] ?? '').trim();
          if (NOTACAO_CIENTIFICA.test(v))
            throw new ErroArquivo(
              `Arquivo regravado pelo Excel: a coluna "${colunasOriginais[i]}" tem número em notação científica (${v}) na linha ${linha}. Exporte de novo do sistema oficial e envie o arquivo sem abrir no Excel.`,
              true,
            );
        }
        const registro: LinhaArquivo = {};
        for (let i = 0; i < colunas.length; i++) {
          const nome = colunas[i]!;
          if (!nome || nome in registro) continue;
          const v = (campos[i] ?? '').trim();
          registro[nome] = v === '' ? null : v;
        }
        yield registro;
      }
      if (foraDoPadrao) avisos.push(`${foraDoPadrao} linha(s) com número de colunas diferente do cabeçalho.`);
    },
  };
}
