import type { CodigoPagina } from '@omnisaude/shared';
import { codigoPaginaDoCabecalho, decodificar, escolherCodificacao } from './codepages';

/**
 * Leitor de DBF dBase III do Sinan Net e do Sinan Online (VIG-1c, frente F2): versão no byte 0; registros, tamanho do
 * cabeçalho e do registro nos bytes 4 a 11; descritores até 0x0D; para no 0x1A ou na contagem; pula o registro
 * apagado ('*'); valores aparados (espaço e NUL); D vazio = null, D preenchido = 'AAAA-MM-DD'; aceita C e N onde o
 * dicionário diz outro tipo (datas em C como 'AAAAMMDD' ou 'dd/mm/aaaa' ficam como vieram: a normalização as lê).
 * O `LeitorDbf` recebe o arquivo em pedaços e devolve as linhas de cada pedaço: o arquivo nunca fica inteiro na memória.
 */

/** Uma linha lida (coluna → valor aparado; null = vazio). */
export type LinhaArquivo = Record<string, string | null>;

export interface CampoDbf {
  nome: string;
  /** C, N, D, L, F... */
  tipo: string;
  tamanho: number;
  decimais: number;
}

export interface LeituraDbf {
  versao: number;
  /** Data da última atualização no cabeçalho (AAAA-MM-DD). 1995-07-26 = arquivo regravado pelo R (aviso). */
  atualizadoEm: string | null;
  registros: number;
  tamanhoCabecalho: number;
  tamanhoRegistro: number;
  campos: CampoDbf[];
  codificacao: CodigoPagina;
  origemCodificacao: 'CABECALHO' | 'PONTUACAO' | 'INFORMADA';
  /** Byte 29 do cabeçalho (language driver). */
  byteIdioma: number;
  avisos: string[];
  linhas(): IterableIterator<LinhaArquivo>;
}

/**
 * Erro de leitura do arquivo (estrutura inválida): a mensagem vai para a tela. `recusaEnvio`: o envio inteiro é recusado
 * (zip que não abre ou passa do teto, CSV regravado pelo Excel); sem ela, só o arquivo fica de fora, com aviso.
 */
export class ErroArquivo extends Error {
  constructor(
    message: string,
    readonly recusaEnvio = false,
  ) {
    super(message);
  }
}

/** Versões de DBF conhecidas (dBase III/IV, FoxBASE, FoxPro e Visual FoxPro). */
const VERSOES = new Set([0x02, 0x03, 0x30, 0x31, 0x32, 0x43, 0x63, 0x83, 0x8b, 0xcb, 0xe5, 0xf5, 0xfb]);
/** Tipos de campo do dBase, do FoxPro e do Visual FoxPro. */
const TIPOS = new Set('CDFLMNBGPIYTOVWQ@+0');
/** Data fixa que a biblioteca shapelib (pacote foreign do R) grava no cabeçalho. */
const DATA_DO_R = '1995-07-26';
/** Registros lidos para escolher a codificação de um DBF sem marca no byte 29. */
const AMOSTRA_CODIFICACAO = 5000;

export interface CabecalhoDbf {
  versao: number;
  atualizadoEm: string | null;
  registros: number;
  tamanhoCabecalho: number;
  tamanhoRegistro: number;
  byteIdioma: number;
  campos: (CampoDbf & { inicio: number })[];
}

/** Bytes que o cabeçalho ocupa, pelos bytes 8 e 9 (0 enquanto não houver 32 bytes). */
export function bytesDoCabecalho(b: Uint8Array): number {
  return b.length < 32 ? 0 : Math.max(65, b[8]! | (b[9]! << 8));
}

const letraDeNome = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x5f;

/** Descritor de campo coerente: nome ASCII (letra, dígito, _) completado por NUL (ou espaço), tipo conhecido, tamanho > 0. */
function descritor(b: Uint8Array, off: number): CampoDbf | null {
  let fim = off;
  while (fim < off + 11 && letraDeNome(b[fim]!)) fim++;
  if (fim === off) return null;
  for (let i = fim; i < off + 11; i++) if (b[i] !== 0 && b[i] !== 0x20) return null;
  const tipo = String.fromCharCode(b[off + 11]!).toUpperCase();
  const tamanho = b[off + 16]!;
  if (!TIPOS.has(tipo) || tamanho === 0) return null;
  let nome = '';
  for (let i = off; i < fim; i++) nome += String.fromCharCode(b[i]!);
  return { nome: nome.toUpperCase(), tipo, tamanho, decimais: b[off + 17]! };
}

/**
 * Cabeçalho de DBF coerente, ou null quando não é DBF: versão conhecida; data com mês até 12 e dia até 31; NUL nos bytes
 * reservados; descritores de 32 bytes válidos até o 0x0D; campos que cabem no registro. Texto (CSV) não passa: não tem
 * NUL e os "nomes" teriam espaço e acento. `b` precisa trazer o cabeçalho inteiro (`bytesDoCabecalho`).
 */
export function lerCabecalhoDbf(b: Uint8Array): CabecalhoDbf | null {
  if (b.length < 65 || !VERSOES.has(b[0]!)) return null;
  const mes = b[2]!;
  const dia = b[3]!;
  if (mes > 12 || dia > 31) return null;
  if (!b.subarray(12, 28).includes(0)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const registros = dv.getUint32(4, true);
  const tamanhoCabecalho = dv.getUint16(8, true);
  const tamanhoRegistro = dv.getUint16(10, true);
  if (tamanhoCabecalho < 65 || tamanhoRegistro < 2) return null;
  const campos: (CampoDbf & { inicio: number })[] = [];
  let inicio = 1; // o primeiro byte do registro é a marca de apagado
  let off = 32;
  for (; off + 32 <= tamanhoCabecalho && off < b.length && b[off] !== 0x0d; off += 32) {
    if (off + 32 > b.length) return null;
    const campo = descritor(b, off);
    if (!campo) return null;
    campos.push({ ...campo, inicio });
    inicio += campo.tamanho;
  }
  if (!campos.length || off >= b.length || b[off] !== 0x0d || off >= tamanhoCabecalho || inicio > tamanhoRegistro) return null;
  const atualizadoEm = mes >= 1 && dia >= 1 ? `${1900 + b[1]!}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}` : null;
  return { versao: b[0]!, atualizadoEm, registros, tamanhoCabecalho, tamanhoRegistro, byteIdioma: b[29]!, campos };
}

/** Parece DBF (com o cabeçalho inteiro em `bytes`). */
export function pareceDbf(bytes: Uint8Array): boolean {
  return lerCabecalhoDbf(bytes) !== null;
}

const branco = (c: number) => c === 0x20 || c === 0x00 || (c >= 0x09 && c <= 0x0d);

export interface OpcoesLeitorDbf {
  codificacao?: CodigoPagina;
  /** Chave de cada campo na linha (padrão: o nome do DBF). Dois campos com a mesma chave: fica o primeiro. */
  chave?: (nome: string) => string;
  /** Só estas chaves são decodificadas; as outras ficam na linha com null (a presença da coluna conta). */
  lidas?: ReadonlySet<string>;
}

interface Plano {
  chave: string;
  tipo: string;
  inicio: number;
  fim: number;
  ler: boolean;
}

/** DBF lido em pedaços: `push` devolve as linhas completas que o pedaço fechou; `fim` devolve o resto. */
export class LeitorDbf {
  cabecalho: CabecalhoDbf | null = null;
  codificacao: CodigoPagina | null = null;
  origemCodificacao: LeituraDbf['origemCodificacao'] | null = null;
  readonly avisos: string[] = [];
  /** Chaves das colunas, na ordem dos campos (sem repetidas). */
  colunas: string[] = [];
  private prefixo: Uint8Array[] = [];
  private bytesPrefixo = 0;
  private resto: Uint8Array | null = null;
  private recebidos = 0;
  private consumidos = 0;
  private parado = false;
  /** Registros guardados até escolher a codificação (DBF sem marca no byte 29). */
  private pendentes: Uint8Array[] | null = null;
  private plano: Plano[] = [];

  constructor(private readonly opcoes: OpcoesLeitorDbf = {}) {}

  push(pedaco: Uint8Array): LinhaArquivo[] {
    this.recebidos += pedaco.length;
    const saida: LinhaArquivo[] = [];
    if (!this.cabecalho) {
      this.prefixo.push(pedaco);
      this.bytesPrefixo += pedaco.length;
      const juntos = this.prefixo.length === 1 ? pedaco : concatenar(this.prefixo, this.bytesPrefixo);
      this.prefixo = [juntos];
      const precisa = bytesDoCabecalho(juntos);
      if (!precisa || juntos.length < precisa) return saida;
      this.iniciar(juntos);
      this.prefixo = [];
      this.registros(juntos.subarray(this.cabecalho!.tamanhoCabecalho), saida);
      return saida;
    }
    this.registros(pedaco, saida);
    return saida;
  }

  fim(): LinhaArquivo[] {
    const saida: LinhaArquivo[] = [];
    if (!this.cabecalho) {
      if (!this.bytesPrefixo) throw new ErroArquivo('Arquivo vazio');
      this.iniciar(concatenar(this.prefixo, this.bytesPrefixo));
      this.prefixo = [];
    }
    const c = this.cabecalho!;
    if (this.pendentes) this.decidirCodificacao(saida);
    const esperado = c.tamanhoCabecalho + c.registros * c.tamanhoRegistro;
    if (this.recebidos < esperado) {
      const completos = Math.max(0, Math.floor((this.recebidos - c.tamanhoCabecalho) / c.tamanhoRegistro));
      this.avisos.push(`O arquivo terminou antes do previsto pelo cabeçalho: ${completos} de ${c.registros} registros completos (arquivo cortado ou compactado em DBC).`);
    }
    return saida;
  }

  private iniciar(b: Uint8Array) {
    const c = lerCabecalhoDbf(b);
    if (!c) throw new ErroArquivo('O arquivo não é um DBF válido (cabeçalho fora do formato dBase)');
    this.cabecalho = c;
    if (c.atualizadoEm === DATA_DO_R) this.avisos.push('Arquivo regravado pelo R (data do cabeçalho 26/07/1995): os tipos e tamanhos das colunas podem ter mudado.');
    const vistas = new Set<string>();
    for (const campo of c.campos) {
      const chave = this.opcoes.chave ? this.opcoes.chave(campo.nome) : campo.nome;
      if (vistas.has(chave)) continue;
      vistas.add(chave);
      this.colunas.push(chave);
      this.plano.push({ chave, tipo: campo.tipo, inicio: campo.inicio, fim: campo.inicio + campo.tamanho, ler: !this.opcoes.lidas || this.opcoes.lidas.has(chave) });
    }
    const doCabecalho = codigoPaginaDoCabecalho(c.byteIdioma);
    if (this.opcoes.codificacao) {
      this.codificacao = this.opcoes.codificacao;
      this.origemCodificacao = 'INFORMADA';
    } else if (doCabecalho) {
      this.codificacao = doCabecalho;
      this.origemCodificacao = 'CABECALHO';
    } else {
      this.pendentes = [];
    }
  }

  /** Registros inteiros do pedaço (o pedaço de registro que sobra fica para o próximo). */
  private registros(pedaco: Uint8Array, saida: LinhaArquivo[]) {
    const tam = this.cabecalho!.tamanhoRegistro;
    let i = 0;
    if (this.resto) {
      const falta = tam - this.resto.length;
      if (pedaco.length < falta) {
        this.resto = concatenar([this.resto, pedaco], this.resto.length + pedaco.length);
        return;
      }
      const r = concatenar([this.resto, pedaco.subarray(0, falta)], tam);
      this.resto = null;
      i = falta;
      this.registro(r, saida, true);
    }
    for (; i + tam <= pedaco.length; i += tam) this.registro(pedaco.subarray(i, i + tam), saida, false);
    if (i < pedaco.length && !this.parado) this.resto = pedaco.slice(i);
  }

  private registro(r: Uint8Array, saida: LinhaArquivo[], proprio: boolean) {
    if (this.parado) return;
    if (this.consumidos >= this.cabecalho!.registros || r[0] === 0x1a) {
      this.parado = true;
      return;
    }
    this.consumidos++;
    if (r[0] === 0x2a) return; // '*' = registro apagado
    if (this.pendentes) {
      this.pendentes.push(proprio ? r : r.slice());
      if (this.pendentes.length >= AMOSTRA_CODIFICACAO) this.decidirCodificacao(saida);
      return;
    }
    saida.push(this.linha(r));
  }

  private decidirCodificacao(saida: LinhaArquivo[]) {
    const pendentes = this.pendentes!;
    this.pendentes = null;
    const textos = this.cabecalho!.campos.filter((c) => c.tipo === 'C');
    const amostras: Uint8Array[] = [];
    for (const r of pendentes)
      for (const c of textos) {
        const v = r.subarray(c.inicio, c.inicio + c.tamanho);
        if (v.some((b) => b >= 0x80)) amostras.push(v);
      }
    this.codificacao = escolherCodificacao(amostras);
    this.origemCodificacao = 'PONTUACAO';
    const byte = this.cabecalho!.byteIdioma;
    if (byte !== 0) this.avisos.push(`Código de página do cabeçalho desconhecido (0x${byte.toString(16).padStart(2, '0')}): a codificação foi escolhida pelas letras.`);
    for (const r of pendentes) saida.push(this.linha(r));
  }

  private linha(r: Uint8Array): LinhaArquivo {
    const buf = Buffer.from(r.buffer, r.byteOffset, r.byteLength);
    const linha: LinhaArquivo = {};
    for (const p of this.plano) linha[p.chave] = p.ler ? this.valor(p, r, buf) : null;
    return linha;
  }

  private valor(p: Plano, r: Uint8Array, buf: Buffer): string | null {
    let s = p.inicio;
    let e = Math.min(p.fim, r.length);
    while (s < e && branco(r[s]!)) s++;
    while (e > s && branco(r[e - 1]!)) e--;
    if (s === e) return null;
    switch (p.tipo) {
      case 'D': {
        const v = buf.toString('latin1', s, e);
        if (/^0+$/.test(v)) return null;
        return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;
      }
      case 'L': {
        const v = String.fromCharCode(r[s]!).toUpperCase();
        return e - s === 1 && (v === 'T' || v === 'Y') ? 'T' : e - s === 1 && (v === 'F' || v === 'N') ? 'F' : null;
      }
      case 'N':
      case 'F':
        return buf.toString('latin1', s, e);
      default: {
        let alto = false;
        for (let i = s; i < e; i++)
          if (r[i]! >= 0x80) {
            alto = true;
            break;
          }
        if (!alto) return buf.toString('latin1', s, e);
        const v = decodificar(r.subarray(s, e), this.codificacao!);
        // Espaço não separável (0xA0 no CP1252, 0xFF nos códigos de página do DOS) nas pontas.
        const a = v.charCodeAt(0);
        const z = v.charCodeAt(v.length - 1);
        return a === 0xa0 || z === 0xa0 ? v.trim() || null : v;
      }
    }
  }
}

function concatenar(partes: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of partes) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** O DBF inteiro de uma vez (testes e arquivos pequenos). A importação usa o `LeitorDbf`, em pedaços. */
export function lerDbf(bytes: Uint8Array, opcoes?: { codificacao?: CodigoPagina }): LeituraDbf {
  const leitor = new LeitorDbf({ codificacao: opcoes?.codificacao });
  const cabecalho = lerCabecalhoDbf(bytes.subarray(0, Math.max(bytesDoCabecalho(bytes), 65)));
  if (!cabecalho) throw new ErroArquivo('O arquivo não é um DBF válido (cabeçalho fora do formato dBase)');
  const linhas = [...leitor.push(bytes), ...leitor.fim()];
  return {
    versao: cabecalho.versao,
    atualizadoEm: cabecalho.atualizadoEm,
    registros: cabecalho.registros,
    tamanhoCabecalho: cabecalho.tamanhoCabecalho,
    tamanhoRegistro: cabecalho.tamanhoRegistro,
    campos: cabecalho.campos.map(({ nome, tipo, tamanho, decimais }) => ({ nome, tipo, tamanho, decimais })),
    codificacao: leitor.codificacao!,
    origemCodificacao: leitor.origemCodificacao!,
    byteIdioma: cabecalho.byteIdioma,
    avisos: leitor.avisos,
    linhas: () => linhas[Symbol.iterator](),
  };
}
