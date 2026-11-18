import { crc32 } from 'node:zlib';
import { Inflate } from 'fflate';
import { decodificar } from './codepages';
import { limparCampo } from './controle';
import { ErroArquivo } from './dbf';
import { LIMITE_DESCOMPACTADO_BYTES, LIMITE_ENTRADAS_ZIP, mensagemTetoBytes, mensagemTetoEntradas } from './limites';
import type { Ritmo } from './ritmo';

/**
 * Entrada do envio (VIG-1c): o zip é lido pelo diretório central, sem descompactar nada de uma vez; cada arquivo sai em
 * pedaços, descompactado em fluxo, contando os bytes reais. Um arquivo que descompacta mais do que o zip declara (zip
 * bomb) para no primeiro pedaço a mais. O arquivo enviado sem zip é uma entrada só. O nome da entrada do zip com
 * caractere de controle (o NUL, que o banco recusa) é limpo: cada sequência deles vira um espaço, e o arquivo ganha
 * um aviso (R6-3).
 */

export interface EntradaEnvio {
  /** Nome (dentro do zip, se veio compactado). */
  nome: string;
  /** Tamanho descompactado declarado (sem zip: o tamanho do arquivo). */
  tamanho: number;
  /** 0 = guardado sem compressão; 8 = deflate. */
  metodo: number;
  /** Bytes como estão no envio (compactados, no deflate): fatia do envio, sem cópia. */
  dados: Uint8Array;
  /** CRC-32 declarado no zip (sem zip: null). */
  crc: number | null;
  /** Fora da importação (motivo): não é .dbf nem .csv, protegido por senha ou compressão que não é lida. */
  ignorado?: string;
  /** O nome dentro do zip tinha caractere de controle: `nome` é o nome limpo. */
  nomeLimpo?: boolean;
}

/** Bytes compactados empurrados por vez para o inflate: o pior caso do deflate (1:1032) dá 8 MB descompactados. */
const PASSO_DEFLATE = 8 * 1024;
/** Pedaço do arquivo guardado sem compressão. */
const PASSO_CRU = 256 * 1024;

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

/** Começa como zip (assinatura do cabeçalho local ou do fim do diretório, no zip vazio). */
export const eZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06);

const zipInvalido = (motivo: string) => new ErroArquivo(`Não foi possível abrir o zip (${motivo}). Gere o zip de novo e envie.`, true);

interface EntradaCentral {
  nome: string;
  nomeLimpo: boolean;
  flags: number;
  metodo: number;
  crc: number;
  compactado: number;
  tamanho: number;
  local: number;
}

/**
 * Fim do diretório central (com o zip64, se houver): onde começa e quantas entradas tem. Acima de
 * `LIMITE_ENTRADAS_ZIP`, recusa o envio antes de montar a lista (o zip64 declara até 2^64 entradas).
 */
function diretorio(b: Uint8Array): { inicio: number; entradas: number } {
  const piso = Math.max(0, b.length - 22 - 0xffff);
  let p = -1;
  for (let i = b.length - 22; i >= piso; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
      p = i;
      break;
    }
  }
  if (p < 0) throw zipInvalido('sem o diretório central');
  let entradas = u16(b, p + 10);
  let inicio = u32(b, p + 16);
  if (entradas === 0xffff || inicio === 0xffffffff) {
    const loc = p - 20;
    if (loc < 0 || u32(b, loc) !== 0x07064b50) throw zipInvalido('zip64 sem localizador');
    const z = u64(b, loc + 8);
    if (z + 56 > b.length || u32(b, z) !== 0x06064b50) throw zipInvalido('zip64 sem o fim do diretório');
    entradas = u64(b, z + 32);
    inicio = u64(b, z + 48);
  }
  if (inicio > b.length) throw zipInvalido('diretório central fora do arquivo');
  if (entradas > LIMITE_ENTRADAS_ZIP) throw new ErroArquivo(mensagemTetoEntradas(), true);
  return { inicio, entradas };
}

function entradasCentrais(b: Uint8Array): EntradaCentral[] {
  const { inicio, entradas } = diretorio(b);
  const out: EntradaCentral[] = [];
  let q = inicio;
  for (let k = 0; k < entradas; k++) {
    if (q + 46 > b.length || u32(b, q) !== 0x02014b50) throw zipInvalido('diretório central corrompido');
    const flags = u16(b, q + 8);
    const n = u16(b, q + 28);
    const m = u16(b, q + 30);
    const c = u16(b, q + 32);
    if (q + 46 + n + m + c > b.length) throw zipInvalido('diretório central corrompido');
    const bytesNome = b.subarray(q + 46, q + 46 + n);
    const lido = flags & 0x800 ? new TextDecoder('utf-8').decode(bytesNome) : decodificar(bytesNome, 'CP437');
    const limpo = limparCampo(lido);
    const nome = limpo === null ? lido : limpo.trim();
    let compactado = u32(b, q + 20);
    let tamanho = u32(b, q + 24);
    let local = u32(b, q + 42);
    // Zip64: os campos com 0xFFFFFFFF vêm no extra 0x0001, nesta ordem.
    if (compactado === 0xffffffff || tamanho === 0xffffffff || local === 0xffffffff) {
      for (let x = q + 46 + n; x + 4 <= q + 46 + n + m; ) {
        const id = u16(b, x);
        const t = u16(b, x + 2);
        if (id === 0x0001) {
          let y = x + 4;
          if (tamanho === 0xffffffff) ((tamanho = u64(b, y)), (y += 8));
          if (compactado === 0xffffffff) ((compactado = u64(b, y)), (y += 8));
          if (local === 0xffffffff) local = u64(b, y);
          break;
        }
        x += 4 + t;
      }
    }
    out.push({ nome, nomeLimpo: limpo !== null, flags, metodo: u16(b, q + 10), crc: u32(b, q + 16), compactado, tamanho, local });
    q += 46 + n + m + c;
  }
  return out;
}

/**
 * Arquivos do envio: o zip vira os seus .dbf e .csv (ordem do nome), seguidos dos que ficam de fora, com o motivo; o
 * resto passa como veio. Recusa o envio inteiro: zip que não abre, planilha do Excel (.xlsx) e soma declarada acima do
 * teto (antes de descompactar qualquer coisa).
 */
export function abrirEnvio(nome: string, bytes: Uint8Array): EntradaEnvio[] {
  if (!eZip(bytes)) {
    if (bytes.length > LIMITE_DESCOMPACTADO_BYTES) throw new ErroArquivo(mensagemTetoBytes(), true);
    return [{ nome, tamanho: bytes.length, metodo: 0, dados: bytes, crc: null }];
  }
  const aceitos: EntradaEnvio[] = [];
  const ignorados: EntradaEnvio[] = [];
  let total = 0;
  for (const e of entradasCentrais(bytes)) {
    const base = e.nome.split('/').pop() ?? '';
    if (!base || e.nome.endsWith('/') || e.nome.startsWith('__MACOSX/') || base.startsWith('.')) continue;
    const fora = (motivo: string) =>
      ignorados.push({ nome: e.nome, tamanho: e.tamanho, metodo: e.metodo, dados: new Uint8Array(0), crc: null, ignorado: motivo, ...(e.nomeLimpo ? { nomeLimpo: true } : {}) });
    if (!/\.(dbf|csv)$/i.test(base)) {
      fora(/\.dbc$/i.test(base) ? 'DBC do DATASUS (compactado) não é lido: use a exportação DBF do Sinan' : 'não é .dbf nem .csv');
      continue;
    }
    if (e.flags & 0x1) {
      fora('protegido por senha: gere o zip sem senha');
      continue;
    }
    if (e.metodo !== 0 && e.metodo !== 8) {
      fora(`compressão que não é lida (método ${e.metodo}): gere o zip no padrão (deflate)`);
      continue;
    }
    if (e.local + 30 > bytes.length || u32(bytes, e.local) !== 0x04034b50) throw zipInvalido(`cabeçalho de ${e.nome} fora do lugar`);
    const inicio = e.local + 30 + u16(bytes, e.local + 26) + u16(bytes, e.local + 28);
    if (inicio + e.compactado > bytes.length) throw zipInvalido(`${e.nome} cortado`);
    total += e.tamanho;
    if (total > LIMITE_DESCOMPACTADO_BYTES) throw new ErroArquivo(mensagemTetoBytes(), true);
    aceitos.push({ nome: e.nome, tamanho: e.tamanho, metodo: e.metodo, dados: bytes.subarray(inicio, inicio + e.compactado), crc: e.crc, ...(e.nomeLimpo ? { nomeLimpo: true } : {}) });
  }
  if (ignorados.some((i) => i.nome === '[Content_Types].xml')) throw new ErroArquivo('Planilha do Excel (.xlsx) não é lida: envie o DBF ou o CSV exportado pelo sistema oficial, sem abrir no Excel', true);
  aceitos.sort((a, b) => a.nome.localeCompare(b.nome));
  return [...aceitos, ...ignorados];
}

/** Soma dos bytes descompactados do envio inteiro (o teto vale para a soma, com os bytes reais). */
export class ContadorBytes {
  total = 0;

  somar(n: number) {
    this.total += n;
    if (this.total > LIMITE_DESCOMPACTADO_BYTES) throw new ErroArquivo(mensagemTetoBytes(), true);
  }
}

/**
 * Conteúdo da entrada em pedaços (cada um é processado e solto antes do próximo). Conta os bytes reais: recusa o envio
 * se o arquivo descompacta mais (ou menos) do que o zip declara, se o CRC não bate e se a soma passa do teto.
 */
export async function* pedacos(e: EntradaEnvio, ritmo: Ritmo, contador?: ContadorBytes): AsyncGenerator<Uint8Array> {
  if (e.metodo === 0) {
    if (e.dados.length !== e.tamanho) throw zipInvalido(`${e.nome} com tamanho diferente do declarado`);
    let crc = 0;
    for (let i = 0; i < e.dados.length; i += PASSO_CRU) {
      const p = e.dados.subarray(i, i + PASSO_CRU);
      contador?.somar(p.length);
      if (e.crc !== null) crc = crc32(p, crc);
      yield p;
      await ritmo.ceder();
    }
    if (e.crc !== null && crc !== e.crc) throw zipInvalido(`${e.nome} corrompido (CRC)`);
    return;
  }
  let saida = 0;
  let crc = 0;
  const fila: Uint8Array[] = [];
  const inflate = new Inflate((dados) => {
    if (!dados.length) return;
    saida += dados.length;
    if (saida > e.tamanho) throw new ErroArquivo(`O arquivo ${e.nome} descompacta mais do que o zip declara. Gere o zip de novo e envie.`, true);
    contador?.somar(dados.length);
    crc = crc32(dados, crc);
    fila.push(dados);
  });
  for (let i = 0; i < e.dados.length || i === 0; i += PASSO_DEFLATE) {
    try {
      inflate.push(e.dados.subarray(i, i + PASSO_DEFLATE), i + PASSO_DEFLATE >= e.dados.length);
    } catch (x) {
      if (x instanceof ErroArquivo) throw x;
      throw zipInvalido(`${e.nome}: ${(x as Error).message}`);
    }
    while (fila.length) yield fila.shift()!;
    await ritmo.ceder();
  }
  if (saida !== e.tamanho) throw zipInvalido(`${e.nome} descompacta ${saida} bytes e o zip declara ${e.tamanho}`);
  if (e.crc !== null && crc !== e.crc) throw zipInvalido(`${e.nome} corrompido (CRC)`);
}
