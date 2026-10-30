/**
 * ATENÇÃO: layout do arquivo magnético do BPA (Boletim de Produção Ambulatorial) montado a partir
 * do leiaute publicado pelo DATASUS para importação no BPA Magnético / SIA. ANTES DE USAR EM PRODUÇÃO,
 * confira cada campo (ordem, tamanho e preenchimento) com o documento de layout vigente da competência
 * e valide o arquivo no próprio BPA Magnético. Todo o leiaute está nesta tabela para facilitar o ajuste.
 *
 * Convenções: campos numéricos (N) são alinhados à direita com zeros; alfanuméricos (A) à esquerda
 * com espaços, em maiúsculas e sem acentos. Cada linha termina com CR+LF.
 */

export type FieldKind = 'N' | 'A';
export interface FieldSpec {
  name: string;
  size: number;
  kind: FieldKind;
  /** Valor fixo do campo (ex.: identificador do registro). */
  fixed?: string;
}

export const BPA_HEADER: FieldSpec[] = [
  { name: 'cbc-hdr-1', size: 2, kind: 'N', fixed: '01' },
  { name: 'cbc-hdr-2', size: 5, kind: 'A', fixed: '#BPA#' },
  { name: 'cbc-mvm', size: 6, kind: 'N' }, // competência AAAAMM
  { name: 'cbc-lin', size: 6, kind: 'N' }, // quantidade de linhas de produção
  { name: 'cbc-flh', size: 6, kind: 'N' }, // quantidade de folhas
  { name: 'cbc-smt-vrf', size: 4, kind: 'N' }, // campo de controle
  { name: 'cbc-rsp', size: 30, kind: 'A' }, // nome do órgão de origem
  { name: 'cbc-sgl', size: 6, kind: 'A' }, // sigla do órgão de origem
  { name: 'cbc-cgccpf', size: 14, kind: 'N' }, // CNPJ/CPF do prestador
  { name: 'cbc-dst', size: 40, kind: 'A' }, // nome do órgão de destino
  { name: 'cbc-dst-in', size: 1, kind: 'A' }, // M = municipal, E = estadual
  { name: 'cbc-versao', size: 10, kind: 'A' }, // versão do sistema gerador
];

/** BPA consolidado (BPA-C): produção agregada por CBO, procedimento e idade. */
export const BPA_C_LINE: FieldSpec[] = [
  { name: 'prd-ident', size: 2, kind: 'N', fixed: '02' },
  { name: 'prd-cnes', size: 7, kind: 'N' },
  { name: 'prd-cmp', size: 6, kind: 'N' },
  { name: 'prd-cbo', size: 6, kind: 'A' },
  { name: 'prd-flh', size: 3, kind: 'N' },
  { name: 'prd-seq', size: 2, kind: 'N' },
  { name: 'prd-pa', size: 10, kind: 'N' },
  { name: 'prd-idade', size: 3, kind: 'N' },
  { name: 'prd-qt', size: 6, kind: 'N' },
  { name: 'prd-org', size: 3, kind: 'A', fixed: 'BPA' },
];

/** BPA individualizado (BPA-I): uma linha por atendimento, com paciente identificado. */
export const BPA_I_LINE: FieldSpec[] = [
  { name: 'prd-ident', size: 2, kind: 'N', fixed: '03' },
  { name: 'prd-cnes', size: 7, kind: 'N' },
  { name: 'prd-cmp', size: 6, kind: 'N' },
  { name: 'prd-cnsmed', size: 15, kind: 'N' },
  { name: 'prd-cbo', size: 6, kind: 'A' },
  { name: 'prd-dtaten', size: 8, kind: 'N' }, // AAAAMMDD
  { name: 'prd-flh', size: 3, kind: 'N' },
  { name: 'prd-seq', size: 2, kind: 'N' },
  { name: 'prd-pa', size: 10, kind: 'N' },
  { name: 'prd-cnspac', size: 15, kind: 'N' },
  { name: 'prd-sexo', size: 1, kind: 'A' },
  { name: 'prd-ibge', size: 6, kind: 'N' },
  { name: 'prd-cid', size: 4, kind: 'A' },
  { name: 'prd-idade', size: 3, kind: 'N' },
  { name: 'prd-qt', size: 6, kind: 'N' },
  { name: 'prd-caten', size: 2, kind: 'N' }, // caráter do atendimento: 01 eletivo, 02 urgência
  { name: 'prd-naut', size: 13, kind: 'A' }, // número da autorização
  { name: 'prd-org', size: 3, kind: 'A', fixed: 'BPA' },
  { name: 'prd-nmpac', size: 30, kind: 'A' },
  { name: 'prd-dtnasc', size: 8, kind: 'N' },
  { name: 'prd-raca', size: 2, kind: 'N' },
  { name: 'prd-etnia', size: 4, kind: 'A' },
  { name: 'prd-nac', size: 3, kind: 'N' },
  { name: 'prd-srv', size: 3, kind: 'A' },
  { name: 'prd-clf', size: 3, kind: 'A' },
  { name: 'prd-equipe-seq', size: 8, kind: 'A' },
  { name: 'prd-equipe-area', size: 4, kind: 'A' },
  { name: 'prd-cnpj', size: 14, kind: 'A' },
  { name: 'prd-cep-pcnte', size: 8, kind: 'A' },
  { name: 'prd-lograd-pcnte', size: 3, kind: 'A' },
  { name: 'prd-end-pcnte', size: 30, kind: 'A' },
  { name: 'prd-compl-pcnte', size: 10, kind: 'A' },
  { name: 'prd-num-pcnte', size: 5, kind: 'A' },
  { name: 'prd-bairro-pcnte', size: 30, kind: 'A' },
  { name: 'prd-ddtel-pcnte', size: 11, kind: 'A' },
  { name: 'prd-email-pcnte', size: 40, kind: 'A' },
  { name: 'prd-ine', size: 10, kind: 'A' },
];

export const LINES_PER_SHEET = 20;
export const BPA_VERSION = 'OMNI0.1';

/** Maiúsculas, sem acentos e só ASCII imprimível: o BPA Magnético não aceita outros caracteres. */
export function toBpaText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, ' ')
    .toUpperCase();
}

export function renderLine(spec: FieldSpec[], values: Record<string, string | number | null | undefined>): string {
  return spec
    .map((f) => {
      const raw = f.fixed ?? values[f.name];
      const text = raw === null || raw === undefined ? '' : String(raw);
      if (f.kind === 'N') {
        const digits = text.replace(/\D/g, '');
        if (digits.length > f.size) throw new Error(`Campo ${f.name} excede ${f.size} dígitos: ${text}`);
        return digits.padStart(f.size, '0');
      }
      return toBpaText(text).slice(0, f.size).padEnd(f.size, ' ');
    })
    .join('');
}

export function lineWidth(spec: FieldSpec[]): number {
  return spec.reduce((sum, f) => sum + f.size, 0);
}

/** Campo de controle do cabeçalho: (Σ códigos de procedimento + Σ quantidades) mod 1111 + 1111. */
export function controlField(lines: { procedureCode: string; quantity: number }[]): number {
  let sum = 0n;
  for (const l of lines) sum += BigInt(l.procedureCode) + BigInt(l.quantity);
  return Number(sum % 1111n) + 1111;
}

export interface BpaHeaderInput {
  competencia: string;
  lines: number;
  originName: string;
  originAcronym: string;
  originCnpj: string;
  destinationName: string;
  destinationType: 'M' | 'E';
  control: number;
}

export function renderHeader(h: BpaHeaderInput): string {
  return renderLine(BPA_HEADER, {
    'cbc-mvm': h.competencia,
    'cbc-lin': h.lines,
    'cbc-flh': Math.max(1, Math.ceil(h.lines / LINES_PER_SHEET)),
    'cbc-smt-vrf': h.control,
    'cbc-rsp': h.originName,
    'cbc-sgl': h.originAcronym,
    'cbc-cgccpf': h.originCnpj,
    'cbc-dst': h.destinationName,
    'cbc-dst-in': h.destinationType,
    'cbc-versao': BPA_VERSION,
  });
}

/** Folha e sequência (1-20) da n-ésima linha de produção (n começa em 0). */
export function sheetPosition(index: number) {
  return { sheet: Math.floor(index / LINES_PER_SHEET) + 1, seq: (index % LINES_PER_SHEET) + 1 };
}
