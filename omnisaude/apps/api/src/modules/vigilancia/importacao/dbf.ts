import type { CodigoPagina } from '@omnisaude/shared';
import { codigoPaginaDoCabecalho, decodificar, escolherCodificacao } from './codepages';

/**
 * Leitor de DBF dBase III do Sinan Net e do Sinan Online (VIG-1c, frente F2): versão no byte 0; registros, tamanho do
 * cabeçalho e do registro nos bytes 4 a 11; descritores até 0x0D; para no 0x1A ou na contagem; pula o registro
 * apagado ('*'); valores aparados (espaço e NUL); D vazio = null, D preenchido = 'AAAA-MM-DD'; aceita C e N onde o
 * dicionário diz outro tipo (datas em C como 'AAAAMMDD' ou 'dd/mm/aaaa' ficam como vieram: a normalização as lê).
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
  /** Iterador preguiçoso: uma linha por vez (não monta todas de uma vez). */
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
/** Data fixa que a biblioteca shapelib (pacote foreign do R) grava no cabeçalho. */
const DATA_DO_R = '1995-07-26';
/** Registros lidos para escolher a codificação de um DBF sem marca no byte 29. */
const AMOSTRA_CODIFICACAO = 5000;

const ascii = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
};
const aparar = (s: string) => s.replace(/^[\s\0]+|[\s\0]+$/g, '');

/** Parece DBF: versão conhecida, cabeçalho coerente com o tamanho do arquivo e terminador 0x0D nos descritores. */
export function pareceDbf(bytes: Uint8Array): boolean {
  if (bytes.length < 65 || !VERSOES.has(bytes[0]!)) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cabecalho = dv.getUint16(8, true);
  const registro = dv.getUint16(10, true);
  if (cabecalho < 65 || cabecalho > bytes.length || registro < 2) return false;
  for (let off = 32; off < cabecalho; off += 32) if (bytes[off] === 0x0d) return off > 32;
  return false;
}

export function lerDbf(bytes: Uint8Array, opcoes?: { codificacao?: CodigoPagina }): LeituraDbf {
  if (!pareceDbf(bytes)) throw new ErroArquivo('O arquivo não é um DBF válido (cabeçalho fora do formato dBase)');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versao = bytes[0]!;
  const ano = 1900 + bytes[1]!;
  const mes = bytes[2]!;
  const dia = bytes[3]!;
  const atualizadoEm = mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31 ? `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}` : null;
  const registros = dv.getUint32(4, true);
  const tamanhoCabecalho = dv.getUint16(8, true);
  const tamanhoRegistro = dv.getUint16(10, true);
  const byteIdioma = bytes[29]!;
  const avisos: string[] = [];

  // Descritores de 32 bytes a partir do byte 32, até o terminador 0x0D.
  const campos: (CampoDbf & { inicio: number })[] = [];
  let inicio = 1; // o primeiro byte do registro é a marca de apagado
  for (let off = 32; off + 32 <= tamanhoCabecalho && bytes[off] !== 0x0d; off += 32) {
    const nomeBytes = bytes.subarray(off, off + 11);
    const fim = nomeBytes.indexOf(0);
    const nome = aparar(ascii(fim >= 0 ? nomeBytes.subarray(0, fim) : nomeBytes)).toUpperCase();
    const tipo = String.fromCharCode(bytes[off + 11]!).toUpperCase();
    const tamanho = bytes[off + 16]!;
    const decimais = bytes[off + 17]!;
    if (!nome) throw new ErroArquivo('DBF com descritor de campo sem nome');
    campos.push({ nome, tipo, tamanho, decimais, inicio });
    inicio += tamanho;
  }
  if (!campos.length) throw new ErroArquivo('DBF sem campos');
  if (inicio > tamanhoRegistro) throw new ErroArquivo(`DBF inconsistente: os campos somam ${inicio} bytes e o registro tem ${tamanhoRegistro}`);

  const esperado = tamanhoCabecalho + registros * tamanhoRegistro;
  if (bytes.length < esperado) {
    const completos = Math.max(0, Math.floor((bytes.length - tamanhoCabecalho) / tamanhoRegistro));
    avisos.push(`O arquivo terminou antes do previsto pelo cabeçalho: ${completos} de ${registros} registros completos (arquivo cortado ou compactado em DBC).`);
  }
  if (atualizadoEm === DATA_DO_R) avisos.push('Arquivo regravado pelo R (data do cabeçalho 26/07/1995): os tipos e tamanhos das colunas podem ter mudado.');

  /** Bytes de cada registro ainda válido, na ordem do arquivo (para a amostra da codificação e para as linhas). */
  function* registrosBrutos(): IterableIterator<Uint8Array> {
    for (let i = 0; i < registros; i++) {
      const off = tamanhoCabecalho + i * tamanhoRegistro;
      if (off >= bytes.length || bytes[off] === 0x1a) return;
      if (off + tamanhoRegistro > bytes.length) return;
      if (bytes[off] === 0x2a) continue; // '*' = registro apagado
      yield bytes.subarray(off, off + tamanhoRegistro);
    }
  }

  let codificacao: CodigoPagina;
  let origemCodificacao: LeituraDbf['origemCodificacao'];
  const doCabecalho = codigoPaginaDoCabecalho(byteIdioma);
  if (opcoes?.codificacao) {
    codificacao = opcoes.codificacao;
    origemCodificacao = 'INFORMADA';
  } else if (doCabecalho) {
    codificacao = doCabecalho;
    origemCodificacao = 'CABECALHO';
  } else {
    const textos = campos.filter((c) => c.tipo === 'C');
    const amostras: Uint8Array[] = [];
    let n = 0;
    for (const r of registrosBrutos()) {
      if (++n > AMOSTRA_CODIFICACAO) break;
      for (const c of textos) {
        const v = r.subarray(c.inicio, c.inicio + c.tamanho);
        if (v.some((b) => b >= 0x80)) amostras.push(v);
      }
    }
    codificacao = escolherCodificacao(amostras);
    origemCodificacao = 'PONTUACAO';
    if (byteIdioma !== 0) avisos.push(`Código de página do cabeçalho desconhecido (0x${byteIdioma.toString(16).padStart(2, '0')}): a codificação foi escolhida pelas letras.`);
  }

  const valor = (c: CampoDbf & { inicio: number }, r: Uint8Array): string | null => {
    const bruto = r.subarray(c.inicio, c.inicio + c.tamanho);
    switch (c.tipo) {
      case 'D': {
        const s = aparar(ascii(bruto));
        if (!s || /^0+$/.test(s)) return null;
        return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
      }
      case 'L': {
        const s = aparar(ascii(bruto)).toUpperCase();
        return s === 'T' || s === 'Y' ? 'T' : s === 'F' || s === 'N' ? 'F' : null;
      }
      case 'N':
      case 'F':
        return aparar(ascii(bruto)) || null;
      default:
        return aparar(decodificar(bruto, codificacao)) || null;
    }
  };

  return {
    versao,
    atualizadoEm,
    registros,
    tamanhoCabecalho,
    tamanhoRegistro,
    campos: campos.map(({ nome, tipo, tamanho, decimais }) => ({ nome, tipo, tamanho, decimais })),
    codificacao,
    origemCodificacao,
    byteIdioma,
    avisos,
    *linhas() {
      for (const r of registrosBrutos()) {
        const linha: LinhaArquivo = {};
        for (const c of campos) linha[c.nome] = valor(c, r);
        yield linha;
      }
    },
  };
}
