import { isUtf8 } from 'node:buffer';
import { decodificar } from './codepages';
import { avisoCamposLimpos, limparTexto } from './controle';
import { ErroArquivo, type LinhaArquivo } from './dbf';
import { LIMITE_LINHA_BYTES } from './limites';

/**
 * Leitor dos CSV do e-SUS Notifica e do e-SUS Sinan (VIG-1c, frente F2): tira o BOM; UTF-8 e, se inválido,
 * windows-1252 com aviso; separador ';' ou ',' pelo cabeçalho; aspas e CRLF; cabeçalho normalizado (sem acento,
 * minúsculas, sem pontuação) com sinônimos; recusa arquivo regravado pelo Excel (número em notação científica na
 * coluna do número da notificação, do CPF ou do CNS). O `LeitorCsv` lê os bytes em pedaços e decodifica cada valor
 * sozinho: o arquivo nunca vira uma string única e nenhum valor segura o texto de onde saiu. O caractere de controle
 * dentro da célula (o NUL, que o banco recusa) sai na leitura, com aviso (controle.ts); a tabulação e a quebra de linha
 * ficam.
 */

export interface LeituraCsv {
  separador: ';' | ',';
  codificacao: 'UTF8' | 'CP1252';
  /** Colunas normalizadas (`normalizarCabecalho`), na ordem do arquivo. */
  colunas: string[];
  colunasOriginais: string[];
  avisos: string[];
  /** As linhas; as chaves são as colunas normalizadas. Lança `ErroArquivo` no arquivo regravado pelo Excel. */
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

const ASPAS = 0x22;
const LF = 0x0a;
const CR = 0x0d;

/** Tira o BOM do UTF-8 do começo (um ou mais). */
export function semBom(b: Uint8Array): Uint8Array {
  let i = 0;
  while (b.length >= i + 3 && b[i] === 0xef && b[i + 1] === 0xbb && b[i + 2] === 0xbf) i += 3;
  return i ? b.subarray(i) : b;
}

/** Validação do UTF-8 em pedaços: o caractere partido entre dois pedaços fica para o próximo. */
export class ValidadorUtf8 {
  private resto: Uint8Array = new Uint8Array(0);
  valido = true;

  push(pedaco: Uint8Array) {
    if (!this.valido) return;
    const b = this.resto.length ? Buffer.concat([this.resto, pedaco]) : pedaco;
    let corte = b.length;
    let j = b.length - 1;
    let continuacoes = 0;
    while (j >= 0 && continuacoes < 3 && (b[j]! & 0xc0) === 0x80) {
      j--;
      continuacoes++;
    }
    if (j >= 0) {
      const lider = b[j]!;
      const precisa = lider >= 0xf0 ? 4 : lider >= 0xe0 ? 3 : lider >= 0xc0 ? 2 : 1;
      if (precisa > b.length - j) corte = j;
    }
    if (!isUtf8(b.subarray(0, corte))) this.valido = false;
    this.resto = Uint8Array.from(b.subarray(corte));
  }

  fim(): boolean {
    if (this.resto.length) this.valido = false;
    return this.valido;
  }
}

/** Separador pela primeira linha: o que mais aparece fora de aspas (empate: ponto e vírgula). */
function separadorDe(linha: Uint8Array): ';' | ',' {
  let fora = true;
  let pv = 0;
  let virgulas = 0;
  for (const c of linha) {
    if (c === ASPAS) fora = !fora;
    else if (fora && c === 0x3b) pv++;
    else if (fora && c === 0x2c) virgulas++;
  }
  return virgulas > pv ? ',' : ';';
}

/** Fim da primeira linha fora de aspas (−1 se ainda não veio). */
function fimDaPrimeiraLinha(b: Uint8Array): number {
  let fora = true;
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    if (c === ASPAS) fora = !fora;
    else if (fora && (c === LF || c === CR)) return i;
  }
  return -1;
}

const enum Estado {
  InicioCampo,
  SemAspas,
  ComAspas,
  AspaDentro,
  DepoisAspas,
  PularLf,
}

export interface LinhaCsv {
  l: LinhaArquivo;
  /** Linha física do arquivo onde o registro começa (o cabeçalho é a 1). */
  n: number;
}

export interface OpcoesLeitorCsv {
  codificacao: 'UTF8' | 'CP1252';
  /** Só estas colunas (normalizadas) são decodificadas; as outras ficam na linha com null (a presença conta). */
  lidas?: ReadonlySet<string>;
}

const temTexto = (b: Uint8Array, s: number, e: number) => {
  for (let i = s; i < e; i++) if (b[i]! > 0x20) return true;
  return false;
};

/**
 * CSV lido em pedaços de bytes: `push` devolve as linhas que o pedaço fechou; `fim`, a última. Um campo que passa de um
 * pedaço para o outro continua do byte 0 do pedaço seguinte. Linha física: a do começo do registro (CR, LF ou CRLF
 * fecham a linha; LF dentro das aspas conta).
 */
export class LeitorCsv {
  separador: ';' | ',' = ';';
  colunas: string[] = [];
  colunasOriginais: string[] = [];
  readonly avisos: string[] = [];
  private prefixo: Uint8Array[] = [];
  private comecou = false;
  private sep = 0x3b;
  private estado = Estado.InicioCampo;
  /** Bytes do campo aberto que vieram em pedaços anteriores ou entre aspas. */
  private campo = new Uint8Array(4096);
  private tamCampo = 0;
  /** Campos do registro aberto (valor decodificado; '' quando a coluna não é lida). */
  private campos: string[] = [];
  private registroComTexto = false;
  private bytesRegistro = 0;
  private linhaFisica = 1;
  private linhaDoRegistro = 1;
  private registroAberto = false;
  private cabecalhoLido = false;
  /** Índice → chave na linha (null = coluna sem nome ou repetida) e se decodifica. */
  private destino: { chave: string | null; ler: boolean }[] = [];
  private vigiadas: number[] = [];
  private foraDoPadrao = 0;
  private saida: LinhaCsv[] = [];
  private visto: Uint8Array | null = null;
  private vistoBuf: Buffer | null = null;
  /** Células com caractere de controle, limpas (o aviso sai no fim). */
  private limpos = 0;

  constructor(private readonly opcoes: OpcoesLeitorCsv) {}

  push(pedaco: Uint8Array): LinhaCsv[] {
    this.saida = [];
    if (!this.comecou) {
      this.prefixo.push(pedaco);
      const juntos = semBom(this.prefixo.length === 1 ? pedaco : Buffer.concat(this.prefixo));
      this.prefixo = [juntos];
      const fim = fimDaPrimeiraLinha(juntos);
      if (fim < 0) {
        if (juntos.length > LIMITE_LINHA_BYTES) throw new ErroArquivo('Cabeçalho do CSV com mais de 1 MB: confira se o arquivo é mesmo um CSV', true);
        return this.saida;
      }
      this.prefixo = [];
      this.comecar(juntos.subarray(0, fim));
      this.processar(juntos);
      return this.saida;
    }
    this.processar(pedaco);
    return this.saida;
  }

  fim(): LinhaCsv[] {
    this.saida = [];
    if (!this.comecou) {
      const juntos = semBom(this.prefixo.length ? Buffer.concat(this.prefixo) : new Uint8Array(0));
      this.prefixo = [];
      this.comecar(juntos);
      this.processar(juntos);
    }
    if (this.estado !== Estado.PularLf && (this.registroAberto || this.tamCampo)) {
      this.fecharCampo(null, 0, 0);
      this.fecharRegistro();
    }
    if (!this.cabecalhoLido) throw new ErroArquivo('CSV vazio');
    if (this.foraDoPadrao) this.avisos.push(`${this.foraDoPadrao} linha(s) com número de colunas diferente do cabeçalho.`);
    if (this.limpos) this.avisos.push(avisoCamposLimpos(this.limpos));
    return this.saida;
  }

  private comecar(primeiraLinha: Uint8Array) {
    this.comecou = true;
    this.separador = separadorDe(primeiraLinha);
    this.sep = this.separador.charCodeAt(0);
  }

  private linhaLonga() {
    return new ErroArquivo(`A linha ${this.linhaDoRegistro} do CSV passa de 1 MB (aspa sem fechamento?). Corrija o arquivo e envie de novo.`, true);
  }

  private guardar(b: Uint8Array, s: number, e: number) {
    const n = e - s;
    if (n <= 0) return;
    if (this.tamCampo + n > this.campo.length) {
      if (this.tamCampo + n > LIMITE_LINHA_BYTES) throw this.linhaLonga();
      const maior = new Uint8Array(Math.min(LIMITE_LINHA_BYTES, Math.max(this.campo.length * 2, this.tamCampo + n)));
      maior.set(this.campo.subarray(0, this.tamCampo));
      this.campo = maior;
    }
    this.campo.set(b.subarray(s, e), this.tamCampo);
    this.tamCampo += n;
  }

  /** Texto dos bytes, sem caractere de controle (conta a célula limpa) e sem segurar nada além dele. */
  private texto(b: Uint8Array, s: number, e: number): string {
    const v = this.decodificado(b, s, e);
    const limpo = limparTexto(v);
    if (limpo === null) return v;
    this.limpos++;
    return limpo;
  }

  /** Texto dos bytes, sem segurar nada além dele (o Buffer só aponta para os bytes). */
  private decodificado(b: Uint8Array, s: number, e: number): string {
    if (this.opcoes.codificacao === 'CP1252') {
      for (let i = s; i < e; i++) if (b[i]! >= 0x80) return decodificar(b.subarray(s, e), 'CP1252');
    }
    if (b !== this.visto) {
      this.visto = b;
      this.vistoBuf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    }
    return this.vistoBuf!.toString(this.opcoes.codificacao === 'CP1252' ? 'latin1' : 'utf8', s, e);
  }

  /** Fecha o campo: o que estava guardado mais `b[s, e)`. */
  private fecharCampo(b: Uint8Array | null, s: number, e: number) {
    const i = this.campos.length;
    const ler = !this.cabecalhoLido || (this.destino[i]?.ler ?? false);
    let v = '';
    if (this.tamCampo) {
      if (b) this.guardar(b, s, e);
      if (ler) v = this.texto(this.campo, 0, this.tamCampo);
      else if (!this.registroComTexto && temTexto(this.campo, 0, this.tamCampo)) this.registroComTexto = true;
      this.bytesRegistro += this.tamCampo;
    } else if (b && e > s) {
      if (ler) v = this.texto(b, s, e);
      else if (!this.registroComTexto && temTexto(b, s, e)) this.registroComTexto = true;
      this.bytesRegistro += e - s;
    }
    if (this.bytesRegistro > LIMITE_LINHA_BYTES) throw this.linhaLonga();
    if (!this.registroComTexto && v.trim()) this.registroComTexto = true;
    this.tamCampo = 0;
    this.campos.push(v);
  }

  private fecharRegistro() {
    const campos = this.campos;
    const linha = this.linhaDoRegistro;
    const comTexto = this.registroComTexto;
    this.campos = [];
    this.registroComTexto = false;
    this.bytesRegistro = 0;
    this.registroAberto = false;
    if (!this.cabecalhoLido) {
      this.cabecalho(campos);
      return;
    }
    // Linha em branco (só separadores e espaços): fica de fora.
    if (!comTexto) return;
    if (campos.length !== this.colunas.length) this.foraDoPadrao++;
    for (const i of this.vigiadas) {
      const v = (campos[i] ?? '').trim();
      if (NOTACAO_CIENTIFICA.test(v))
        throw new ErroArquivo(
          `Arquivo regravado pelo Excel: a coluna "${this.colunasOriginais[i]}" tem número em notação científica (${v}) na linha ${linha}. Exporte de novo do sistema oficial e envie o arquivo sem abrir no Excel.`,
          true,
        );
    }
    const registro: LinhaArquivo = {};
    for (let i = 0; i < this.destino.length; i++) {
      const d = this.destino[i]!;
      if (!d.chave) continue;
      const v = d.ler ? (campos[i] ?? '').trim() : '';
      registro[d.chave] = v === '' ? null : v;
    }
    this.saida.push({ l: registro, n: linha });
  }

  private cabecalho(campos: string[]) {
    this.cabecalhoLido = true;
    this.colunasOriginais = campos.map((c) => c.replace(/^﻿/, '').trim());
    if (this.colunasOriginais.length < 2) throw new ErroArquivo('CSV sem colunas reconhecíveis (separador deve ser ponto e vírgula ou vírgula)');
    this.colunas = this.colunasOriginais.map(normalizarCabecalho);
    const repetidas = this.colunas.filter((c, i) => c && this.colunas.indexOf(c) !== i);
    if (repetidas.length) this.avisos.push(`Colunas repetidas no cabeçalho (fica a primeira): ${[...new Set(repetidas)].join(', ')}.`);
    this.vigiadas = this.colunas.map((c, i) => (COLUNAS_NUMERO_LONGO.includes(c) ? i : -1)).filter((i) => i >= 0);
    const vistas = new Set<string>();
    this.destino = this.colunas.map((c, i) => {
      const vigiada = this.vigiadas.includes(i);
      if (!c || vistas.has(c)) return { chave: null, ler: vigiada };
      vistas.add(c);
      return { chave: c, ler: vigiada || !this.opcoes.lidas || this.opcoes.lidas.has(c) };
    });
  }

  private processar(b: Uint8Array) {
    const n = b.length;
    const sep = this.sep;
    let i = 0;
    // Campo que continua do pedaço anterior: começa no byte 0 deste.
    let inicio = 0;
    while (i < n) {
      switch (this.estado) {
        case Estado.PularLf:
          if (b[i] === LF) i++;
          this.estado = Estado.InicioCampo;
          break;
        case Estado.InicioCampo:
          if (!this.registroAberto) {
            this.registroAberto = true;
            this.linhaDoRegistro = this.linhaFisica;
          }
          if (b[i] === ASPAS) {
            this.estado = Estado.ComAspas;
            i++;
          } else {
            this.estado = Estado.SemAspas;
          }
          inicio = i;
          break;
        case Estado.SemAspas:
        case Estado.DepoisAspas: {
          let k = i;
          while (k < n) {
            const c = b[k]!;
            if (c === sep || c === LF || c === CR) break;
            k++;
          }
          if (k >= n) {
            this.guardar(b, inicio, n);
            i = n;
            break;
          }
          this.fecharCampo(b, inicio, k);
          const c = b[k]!;
          i = k + 1;
          if (c === sep) {
            this.estado = Estado.InicioCampo;
          } else {
            this.fecharRegistro();
            this.linhaFisica++;
            this.estado = c === CR ? Estado.PularLf : Estado.InicioCampo;
          }
          break;
        }
        case Estado.ComAspas: {
          const j = b.indexOf(ASPAS, i);
          const ate = j < 0 ? n : j;
          for (let k = i; k < ate; k++) if (b[k] === LF) this.linhaFisica++;
          this.guardar(b, inicio, ate);
          if (j < 0) {
            i = n;
          } else {
            i = j + 1;
            this.estado = Estado.AspaDentro;
          }
          break;
        }
        case Estado.AspaDentro:
          if (b[i] === ASPAS) {
            // "" dentro das aspas vira ".
            this.guardar(b, i, i + 1);
            i++;
            inicio = i;
            this.estado = Estado.ComAspas;
          } else {
            // Aspa de fechamento: o que vier até o separador entra no campo (tolerância).
            inicio = i;
            this.estado = Estado.DepoisAspas;
          }
          break;
      }
    }
  }
}

/** O CSV inteiro de uma vez (testes e arquivos pequenos). A importação usa o `LeitorCsv`, em pedaços. */
export function lerCsvOficial(bytes: Uint8Array, opcoes?: { codificacao?: 'UTF8' | 'CP1252' }): LeituraCsv {
  const avisos: string[] = [];
  let codificacao: 'UTF8' | 'CP1252';
  if (opcoes?.codificacao === 'CP1252') codificacao = 'CP1252';
  else if (isUtf8(bytes)) codificacao = 'UTF8';
  else {
    if (opcoes?.codificacao === 'UTF8') throw new ErroArquivo('O arquivo não é UTF-8 válido');
    codificacao = 'CP1252';
    avisos.push('O arquivo não é UTF-8 válido: foi lido como Windows-1252. Confira os acentos na prévia.');
  }
  const leitor = new LeitorCsv({ codificacao });
  const linhas: LinhaCsv[] = [];
  let erro: unknown = null;
  try {
    linhas.push(...leitor.push(bytes));
    linhas.push(...leitor.fim());
  } catch (e) {
    // Sem cabeçalho, o erro é do arquivo; depois dele, é de uma linha (vem na leitura das linhas, como antes).
    if (!leitor.colunas.length) throw e;
    erro = e;
  }
  let atual = 1;
  return {
    separador: leitor.separador,
    codificacao,
    colunas: leitor.colunas,
    colunasOriginais: leitor.colunasOriginais,
    avisos: [...avisos, ...leitor.avisos],
    linhaAtual: () => atual,
    *linhas() {
      for (const { l, n } of linhas) {
        atual = n;
        yield l;
      }
      if (erro) throw erro;
    },
  };
}
