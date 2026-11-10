/**
 * Escritor de DBF dBase III para os testes da importação (VIG-1c): campos C, D e N; byte 29 (language driver) à
 * escolha; texto em CP850 (o padrão do Sinan Net); registro apagado com '*'; 0x1A no fim. Os dados são sintéticos.
 * Um valor pode vir em bytes prontos (Uint8Array), para usar bytes gerados fora do código testado (pelo Python).
 */

export interface CampoEscrita {
  nome: string;
  tipo: 'C' | 'D' | 'N';
  tamanho: number;
  decimais?: number;
}

export type ValorEscrita = string | number | Uint8Array | null | undefined;

export interface RegistroEscrita {
  valores: Record<string, ValorEscrita>;
  /** Marca de apagado ('*'): o leitor pula. */
  apagado?: boolean;
}

export interface OpcoesEscrita {
  /** Byte 29 (0x25 = CP850 do Sinan Net; 0x00 = sem marca). */
  byteIdioma?: number;
  /** Data da última atualização no cabeçalho. */
  data?: { ano: number; mes: number; dia: number };
  /** Sem o 0x1A no fim. */
  semFimDeArquivo?: boolean;
}

/**
 * Bytes 0x80 a 0xFF do CP850, gerados por `python3 -I -c "print(bytes(range(128,256)).decode('cp850'))"` (para o
 * escritor codificar texto; os testes de codificação usam bytes gerados pelo próprio Python).
 */
const CP850_PONTOS = [
  0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7, 0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5, 0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9, 0x00ff, 0x00d6, 0x00dc,
  0x00f8, 0x00a3, 0x00d8, 0x00d7, 0x0192, 0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba, 0x00bf, 0x00ae, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb, 0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x00c1,
  0x00c2, 0x00c0, 0x00a9, 0x2563, 0x2551, 0x2557, 0x255d, 0x00a2, 0x00a5, 0x2510, 0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x00e3, 0x00c3, 0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x00a4, 0x00f0,
  0x00d0, 0x00ca, 0x00cb, 0x00c8, 0x0131, 0x00cd, 0x00ce, 0x00cf, 0x2518, 0x250c, 0x2588, 0x2584, 0x00a6, 0x00cc, 0x2580, 0x00d3, 0x00df, 0x00d4, 0x00d2, 0x00f5, 0x00d5, 0x00b5, 0x00fe, 0x00de, 0x00da, 0x00db, 0x00d9,
  0x00fd, 0x00dd, 0x00af, 0x00b4, 0x00ad, 0x00b1, 0x2017, 0x00be, 0x00b6, 0x00a7, 0x00f7, 0x00b8, 0x00b0, 0x00a8, 0x00b7, 0x00b9, 0x00b3, 0x00b2, 0x25a0, 0x00a0,
];
const CP850_ALTOS = String.fromCharCode(...CP850_PONTOS);
const PARA_CP850 = new Map([...CP850_ALTOS].map((c, i) => [c, 0x80 + i]));

/** Texto em CP850 (caractere fora da tabela vira '?'). */
export function emCp850(texto: string): Uint8Array {
  return Uint8Array.from([...texto].map((c) => (c.charCodeAt(0) < 0x80 ? c.charCodeAt(0) : (PARA_CP850.get(c) ?? 0x3f))));
}

const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0x7f));

function campoEmBytes(campo: CampoEscrita, valor: ValorEscrita): Uint8Array {
  const out = new Uint8Array(campo.tamanho).fill(0x20);
  if (valor === null || valor === undefined || valor === '') return out;
  let bytes: Uint8Array;
  if (valor instanceof Uint8Array) bytes = valor;
  else if (campo.tipo === 'D') bytes = ascii(String(valor).replace(/-/g, ''));
  else if (campo.tipo === 'N') bytes = ascii(typeof valor === 'number' ? valor.toFixed(campo.decimais ?? 0) : valor);
  else bytes = emCp850(String(valor));
  const parte = bytes.subarray(0, campo.tamanho);
  // Número alinhado à direita; texto e data à esquerda.
  out.set(parte, campo.tipo === 'N' ? campo.tamanho - parte.length : 0);
  return out;
}

/** DBF dBase III (versão 0x03) com os campos e registros dados. */
export function escreverDbf(campos: CampoEscrita[], registros: (RegistroEscrita | Record<string, ValorEscrita>)[], opcoes: OpcoesEscrita = {}): Buffer {
  const tamanhoRegistro = 1 + campos.reduce((a, c) => a + c.tamanho, 0);
  const tamanhoCabecalho = 32 + 32 * campos.length + 1;
  const data = opcoes.data ?? { ano: 2026, mes: 11, dia: 9 };
  const cab = Buffer.alloc(tamanhoCabecalho);
  cab[0] = 0x03;
  cab[1] = data.ano - 1900;
  cab[2] = data.mes;
  cab[3] = data.dia;
  cab.writeUInt32LE(registros.length, 4);
  cab.writeUInt16LE(tamanhoCabecalho, 8);
  cab.writeUInt16LE(tamanhoRegistro, 10);
  cab[29] = opcoes.byteIdioma ?? 0x25;
  campos.forEach((c, i) => {
    const off = 32 + 32 * i;
    cab.set(ascii(c.nome.toUpperCase().slice(0, 10)), off);
    cab[off + 11] = c.tipo.charCodeAt(0);
    cab[off + 16] = c.tamanho;
    cab[off + 17] = c.decimais ?? 0;
  });
  cab[tamanhoCabecalho - 1] = 0x0d;
  const corpo = Buffer.alloc(registros.length * tamanhoRegistro + (opcoes.semFimDeArquivo ? 0 : 1));
  registros.forEach((r, i) => {
    const reg = 'valores' in r && typeof r.valores === 'object' && !(r.valores instanceof Uint8Array) ? (r as RegistroEscrita) : { valores: r as Record<string, ValorEscrita> };
    let off = i * tamanhoRegistro;
    corpo[off++] = reg.apagado ? 0x2a : 0x20;
    for (const c of campos) {
      corpo.set(campoEmBytes(c, reg.valores[c.nome]), off);
      off += c.tamanho;
    }
  });
  if (!opcoes.semFimDeArquivo) corpo[corpo.length - 1] = 0x1a;
  return Buffer.concat([cab, corpo]);
}

/** Campos da notificação individual do Sinan Net (NINDINET), com os tamanhos do dicionário. */
export const CAMPOS_NINDINET: CampoEscrita[] = [
  { nome: 'NU_NOTIFIC', tipo: 'C', tamanho: 7 },
  { nome: 'TP_NOT', tipo: 'C', tamanho: 1 },
  { nome: 'ID_AGRAVO', tipo: 'C', tamanho: 4 },
  { nome: 'CS_SUSPEIT', tipo: 'C', tamanho: 1 },
  { nome: 'DT_NOTIFIC', tipo: 'D', tamanho: 8 },
  { nome: 'SEM_NOT', tipo: 'C', tamanho: 6 },
  { nome: 'NU_ANO', tipo: 'C', tamanho: 4 },
  { nome: 'SG_UF_NOT', tipo: 'C', tamanho: 2 },
  { nome: 'ID_MUNICIP', tipo: 'C', tamanho: 6 },
  { nome: 'ID_UNIDADE', tipo: 'C', tamanho: 7 },
  { nome: 'DT_SIN_PRI', tipo: 'D', tamanho: 8 },
  { nome: 'SEM_PRI', tipo: 'C', tamanho: 6 },
  { nome: 'NM_PACIENT', tipo: 'C', tamanho: 70 },
  { nome: 'DT_NASC', tipo: 'D', tamanho: 8 },
  { nome: 'NU_IDADE_N', tipo: 'N', tamanho: 4 },
  { nome: 'CS_SEXO', tipo: 'C', tamanho: 1 },
  { nome: 'ID_CNS_SUS', tipo: 'C', tamanho: 15 },
  { nome: 'NM_MAE_PAC', tipo: 'C', tamanho: 60 },
  { nome: 'SG_UF', tipo: 'C', tamanho: 2 },
  { nome: 'ID_MN_RESI', tipo: 'C', tamanho: 6 },
  { nome: 'ID_BAIRRO', tipo: 'C', tamanho: 8 },
  { nome: 'NM_BAIRRO', tipo: 'C', tamanho: 60 },
  { nome: 'NU_TELEFON', tipo: 'C', tamanho: 9 },
  { nome: 'NDUPLIC_N', tipo: 'C', tamanho: 1 },
];
