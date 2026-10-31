/**
 * Layout do arquivo magnético do BPA (Boletim de Produção Ambulatorial), conforme o documento
 * "Layout da interface texto do BPA e do SIA - Layout INTERNO" do DATASUS (Layout de Exportação do BPA),
 * na versão que inclui o CPF do indivíduo (posições 339-349) e a situação de rua (posição 350, válida a
 * partir da competência 12/2024). Cabeçalho com 130 posições, BPA-C com 48 e BPA-I com 350, todas seguidas
 * de CR+LF.
 *
 * Convenções do layout: campos numéricos (NUM) alinhados à direita com zeros; os numéricos cujo padrão é
 * "Brancos" ficam totalmente em branco quando não informados; alfanuméricos (ALFA) alinhados à esquerda com
 * espaços, em maiúsculas e sem acentos. O paciente é identificado por um só documento: CNS ou CPF.
 */

export type FieldKind = 'N' | 'A';
export interface FieldSpec {
  name: string;
  size: number;
  kind: FieldKind;
  /** Valor fixo do campo (ex.: identificador do registro). */
  fixed?: string;
  /** Numérico com padrão "Brancos" no layout: sai em branco quando não informado. */
  blank?: boolean;
  description: string;
}

export const BPA_LAYOUT_VERSION = 'Layout de exportação do BPA/SIA com CPF do indivíduo e situação de rua (vigente desde a competência 12/2024)';

export const BPA_HEADER: FieldSpec[] = [
  { name: 'cbc-hdr-1', size: 2, kind: 'N', fixed: '01', description: 'Indicador de linha do cabeçalho' },
  { name: 'cbc-hdr-2', size: 5, kind: 'A', fixed: '#BPA#', description: 'Indicador de início do cabeçalho' },
  { name: 'cbc-mvm', size: 6, kind: 'N', description: 'Ano e mês de processamento da produção (AAAAMM)' },
  { name: 'cbc-lin', size: 6, kind: 'N', description: 'Número de linhas do BPA gravadas' },
  { name: 'cbc-flh', size: 6, kind: 'N', description: 'Quantidade de folhas de BPA gravadas' },
  { name: 'cbc-smt-vrf', size: 4, kind: 'N', description: 'Campo de controle (1111 a 2221)' },
  { name: 'cbc-rsp', size: 30, kind: 'A', description: 'Nome do órgão de origem responsável pela informação' },
  { name: 'cbc-sgl', size: 6, kind: 'A', description: 'Sigla do órgão de origem responsável pela digitação' },
  { name: 'cbc-cgccpf', size: 14, kind: 'N', description: 'CNPJ/CPF do prestador ou do órgão público responsável' },
  { name: 'cbc-dst', size: 40, kind: 'A', description: 'Nome do órgão de saúde destino do arquivo' },
  { name: 'cbc-dst-in', size: 1, kind: 'A', description: 'Indicador do órgão destino: M municipal, E estadual' },
  { name: 'cbc-versao', size: 10, kind: 'A', description: 'Versão do sistema gerador' },
];

/** BPA consolidado (BPA-C): produção agregada por CBO, procedimento e idade. */
export const BPA_C_LINE: FieldSpec[] = [
  { name: 'prd-ident', size: 2, kind: 'N', fixed: '02', description: 'Identificação de linha de produção BPA-C' },
  { name: 'prd-cnes', size: 7, kind: 'N', description: 'Código do CNES' },
  { name: 'prd-cmp', size: 6, kind: 'N', description: 'Competência de realização do procedimento (AAAAMM)' },
  { name: 'prd-cbo', size: 6, kind: 'A', description: 'CBO do profissional' },
  { name: 'prd-flh', size: 3, kind: 'N', description: 'Número da folha do BPA (001 a 999)' },
  { name: 'prd-seq', size: 2, kind: 'N', description: 'Sequência da linha na folha (01 a 20)' },
  { name: 'prd-pa', size: 10, kind: 'N', description: 'Código do procedimento ambulatorial' },
  { name: 'prd-idade', size: 3, kind: 'N', description: 'Idade (0 a 130 anos)' },
  { name: 'prd-qt', size: 6, kind: 'N', description: 'Quantidade de procedimentos produzidos' },
  { name: 'prd-org', size: 3, kind: 'A', fixed: 'BPA', description: 'Origem das informações' },
];

/** BPA individualizado (BPA-I): uma linha por atendimento, com paciente identificado. */
export const BPA_I_LINE: FieldSpec[] = [
  { name: 'prd-ident', size: 2, kind: 'N', fixed: '03', description: 'Identificação de linha de produção BPA-I' },
  { name: 'prd-cnes', size: 7, kind: 'N', description: 'Código do CNES' },
  { name: 'prd-cmp', size: 6, kind: 'N', description: 'Competência de realização do procedimento (AAAAMM)' },
  { name: 'prd-cnsmed', size: 15, kind: 'N', blank: true, description: 'CNS do profissional' },
  { name: 'prd-cbo', size: 6, kind: 'A', description: 'CBO do profissional' },
  { name: 'prd-dtaten', size: 8, kind: 'N', blank: true, description: 'Data de atendimento (AAAAMMDD)' },
  { name: 'prd-flh', size: 3, kind: 'N', description: 'Número da folha do BPA (001 a 999)' },
  { name: 'prd-seq', size: 2, kind: 'N', description: 'Sequência da linha na folha (01 a 99)' },
  { name: 'prd-pa', size: 10, kind: 'N', description: 'Código do procedimento ambulatorial' },
  { name: 'prd-cnspac', size: 15, kind: 'N', blank: true, description: 'CNS do paciente (não informar junto com o CPF)' },
  { name: 'prd-sexo', size: 1, kind: 'A', description: 'Sexo do paciente (M/F)' },
  { name: 'prd-ibge', size: 6, kind: 'N', blank: true, description: 'Código IBGE do município de residência' },
  { name: 'prd-cid', size: 4, kind: 'A', description: 'CID-10' },
  { name: 'prd-idade', size: 3, kind: 'N', description: 'Idade (0 a 130 anos)' },
  { name: 'prd-qt', size: 6, kind: 'N', description: 'Quantidade de procedimentos produzidos' },
  { name: 'prd-caten', size: 2, kind: 'N', blank: true, description: 'Caráter do atendimento (01 eletivo, 02 urgência)' },
  { name: 'prd-naut', size: 13, kind: 'N', blank: true, description: 'Número da autorização do estabelecimento' },
  { name: 'prd-org', size: 3, kind: 'A', fixed: 'BPA', description: 'Origem das informações' },
  { name: 'prd-nmpac', size: 30, kind: 'A', description: 'Nome completo do paciente' },
  { name: 'prd-dtnasc', size: 8, kind: 'N', blank: true, description: 'Data de nascimento do paciente (AAAAMMDD)' },
  { name: 'prd-raca', size: 2, kind: 'N', blank: true, description: 'Raça/cor (01 a 05, 99)' },
  { name: 'prd-etnia', size: 4, kind: 'N', blank: true, description: 'Etnia (só quando raça/cor = 05)' },
  { name: 'prd-nac', size: 3, kind: 'N', blank: true, description: 'Nacionalidade do paciente' },
  { name: 'prd-srv', size: 3, kind: 'N', blank: true, description: 'Código do serviço' },
  { name: 'prd-clf', size: 3, kind: 'N', blank: true, description: 'Código da classificação' },
  { name: 'prd-equipe-seq', size: 8, kind: 'N', blank: true, description: 'Código da sequência da equipe' },
  { name: 'prd-equipe-area', size: 4, kind: 'N', blank: true, description: 'Código da área da equipe' },
  { name: 'prd-cnpj', size: 14, kind: 'N', blank: true, description: 'CNPJ da empresa que fez a manutenção da OPM' },
  { name: 'prd-cep-pcnte', size: 8, kind: 'N', blank: true, description: 'CEP do paciente' },
  { name: 'prd-lograd-pcnte', size: 3, kind: 'N', blank: true, description: 'Código do logradouro do paciente' },
  { name: 'prd-end-pcnte', size: 30, kind: 'A', description: 'Endereço do paciente' },
  { name: 'prd-compl-pcnte', size: 10, kind: 'A', description: 'Complemento do endereço' },
  { name: 'prd-num-pcnte', size: 5, kind: 'A', description: 'Número do endereço (SN quando não houver)' },
  { name: 'prd-bairro-pcnte', size: 30, kind: 'A', description: 'Bairro' },
  { name: 'prd-ddtel-pcnte', size: 11, kind: 'N', blank: true, description: 'Telefone do paciente com DDD' },
  { name: 'prd-email-pcnte', size: 40, kind: 'A', description: 'E-mail do paciente' },
  { name: 'prd-ine', size: 10, kind: 'N', blank: true, description: 'Identificação Nacional de Equipes' },
  { name: 'prd-cpf-pcnte', size: 11, kind: 'N', blank: true, description: 'CPF do indivíduo (não informar junto com o CNS)' },
  { name: 'prd-situacao-rua', size: 1, kind: 'A', description: 'Pessoa em situação de rua (S/N, em branco sem informação)' },
];

export const LINES_PER_SHEET = 20;
export const BPA_VERSION = 'OMNI0.2';
export const RECORD_LINE: Record<'02' | '03', FieldSpec[]> = { '02': BPA_C_LINE, '03': BPA_I_LINE };

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
        if (!digits && f.blank) return ' '.repeat(f.size);
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
  sheets: number;
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
    'cbc-flh': h.sheets,
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

// ─── Conferência de um arquivo BPA ───────────────────────────────────────────

export interface BpaIssue {
  /** Número da linha no arquivo (1 = cabeçalho). */
  line: number;
  field?: string;
  severity: 'erro' | 'aviso';
  message: string;
}

export interface BpaValidation {
  ok: boolean;
  layout: string;
  competencia: string | null;
  header: { lines: number; sheets: number; control: number; origin: string; destination: string; destinationType: string; version: string } | null;
  records: { total: number; bpaC: number; bpaI: number; sheets: number };
  computedControl: number | null;
  errors: number;
  warnings: number;
  issues: BpaIssue[];
}

export function parseLine(spec: FieldSpec[], line: string): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  for (const f of spec) {
    out[f.name] = line.slice(pos, pos + f.size);
    pos += f.size;
  }
  return out;
}

const RACA = new Set(['01', '02', '03', '04', '05', '99']);
const isDigits = (s: string) => /^\d+$/.test(s);
const isBlank = (s: string) => s.trim() === '';

function validDate(yyyymmdd: string): boolean {
  if (!/^\d{8}$/.test(yyyymmdd)) return false;
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Confere um arquivo BPA (gerado aqui ou por outro sistema) contra o layout: larguras, tipos, domínios,
 * competência, folhas/sequência, identificação do paciente (CNS ou CPF) e o campo de controle do cabeçalho.
 */
export function validateBpaFile(content: string): BpaValidation {
  const issues: BpaIssue[] = [];
  const err = (line: number, message: string, field?: string) => issues.push({ line, field, severity: 'erro', message });
  const warn = (line: number, message: string, field?: string) => issues.push({ line, field, severity: 'aviso', message });
  const result: BpaValidation = { ok: false, layout: BPA_LAYOUT_VERSION, competencia: null, header: null, records: { total: 0, bpaC: 0, bpaI: 0, sheets: 0 }, computedControl: null, errors: 0, warnings: 0, issues };

  if (!content.endsWith('\r\n')) err(0, 'Cada linha deve terminar com CR+LF e o arquivo deve terminar com CR+LF');
  if (/[^\r]\n/.test(content)) err(0, 'Há quebras de linha sem CR (só LF): use CR+LF');
  if (/[^\x20-\x7e\r\n]/.test(content)) err(0, 'O arquivo tem caracteres fora do ASCII imprimível (acentos ou controle)');
  const lines = content.replace(/\r\n$/, '').split('\r\n');
  const header = lines[0] ?? '';
  if (!header.startsWith('01#BPA#')) {
    err(1, 'A primeira linha deve ser o cabeçalho "01#BPA#"');
    return finish(result);
  }
  if (header.length !== lineWidth(BPA_HEADER)) err(1, `Cabeçalho com ${header.length} posições; o layout exige ${lineWidth(BPA_HEADER)}`);
  const h = parseLine(BPA_HEADER, header.padEnd(lineWidth(BPA_HEADER)));
  const competencia = h['cbc-mvm']!;
  if (!/^\d{6}$/.test(competencia) || Number(competencia.slice(4)) < 1 || Number(competencia.slice(4)) > 12) err(1, `Competência inválida: "${competencia}" (AAAAMM)`, 'cbc-mvm');
  else result.competencia = competencia;
  for (const f of ['cbc-lin', 'cbc-flh', 'cbc-smt-vrf', 'cbc-cgccpf'] as const) if (!isDigits(h[f]!)) err(1, `${f} deve ter só dígitos`, f);
  const control = Number(h['cbc-smt-vrf']);
  if (Number.isFinite(control) && (control < 1111 || control > 2221)) err(1, `Campo de controle ${control} fora do domínio 1111 a 2221`, 'cbc-smt-vrf');
  if (!['M', 'E'].includes(h['cbc-dst-in']!)) err(1, `Indicador do órgão destino deve ser M ou E (veio "${h['cbc-dst-in']}")`, 'cbc-dst-in');
  if (isBlank(h['cbc-rsp']!)) warn(1, 'Nome do órgão de origem em branco', 'cbc-rsp');
  result.header = {
    lines: Number(h['cbc-lin']),
    sheets: Number(h['cbc-flh']),
    control,
    origin: h['cbc-rsp']!.trim(),
    destination: h['cbc-dst']!.trim(),
    destinationType: h['cbc-dst-in']!,
    version: h['cbc-versao']!.trim(),
  };

  const control_lines: { procedureCode: string; quantity: number }[] = [];
  let maxSheet = 0;
  const sequence = new Map<string, number>();
  for (let i = 1; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i]!;
    const type = line.slice(0, 2) as '02' | '03';
    const spec = RECORD_LINE[type];
    if (!spec) {
      err(n, `Tipo de registro desconhecido "${line.slice(0, 2)}" (esperado 02 BPA-C ou 03 BPA-I)`);
      continue;
    }
    if (line.length !== lineWidth(spec)) err(n, `Registro ${type} com ${line.length} posições; o layout exige ${lineWidth(spec)}`);
    const v = parseLine(spec, line.padEnd(lineWidth(spec)));
    result.records.total++;
    if (type === '02') result.records.bpaC++;
    else result.records.bpaI++;
    for (const f of spec) {
      const value = v[f.name]!;
      if (f.fixed !== undefined && value !== f.fixed) err(n, `${f.name} deve ser "${f.fixed}"`, f.name);
      if (f.kind === 'N') {
        if (isBlank(value)) {
          if (!f.blank) err(n, `${f.name} (${f.description}) não pode ficar em branco`, f.name);
        } else if (!isDigits(value)) err(n, `${f.name} (${f.description}) deve ter só dígitos: "${value}"`, f.name);
      } else if (/[a-z]/.test(value)) warn(n, `${f.name} deve estar em maiúsculas`, f.name);
    }
    if (v['prd-cmp'] !== competencia) err(n, `Competência do registro (${v['prd-cmp']}) diferente da do cabeçalho (${competencia})`, 'prd-cmp');
    const sheet = Number(v['prd-flh']);
    const seq = Number(v['prd-seq']);
    maxSheet = Math.max(maxSheet, sheet);
    const key = `${type}-${sheet}`;
    const expected = (sequence.get(key) ?? 0) + 1;
    if (seq !== expected) warn(n, `Sequência ${seq} na folha ${sheet}; esperada ${expected}`, 'prd-seq');
    sequence.set(key, seq);
    if (type === '02' && seq > LINES_PER_SHEET) err(n, `Sequência ${seq} acima do máximo de ${LINES_PER_SHEET} por folha no BPA-C`, 'prd-seq');
    const qt = Number(v['prd-qt']);
    if (!(qt > 0)) err(n, 'Quantidade deve ser maior que zero', 'prd-qt');
    const idade = Number(v['prd-idade']);
    if (idade > 130) err(n, `Idade ${idade} fora do domínio 0 a 130`, 'prd-idade');
    if (isDigits(v['prd-pa']!) && qt > 0) control_lines.push({ procedureCode: v['prd-pa']!, quantity: qt });
    if (type === '03') {
      if (isBlank(v['prd-cnsmed']!)) err(n, 'CNS do profissional em branco', 'prd-cnsmed');
      if (!validDate(v['prd-dtaten']!)) err(n, `Data de atendimento inválida: "${v['prd-dtaten']}"`, 'prd-dtaten');
      else if (v['prd-dtaten']!.slice(0, 6) !== competencia) warn(n, `Data de atendimento ${v['prd-dtaten']} fora da competência ${competencia}`, 'prd-dtaten');
      const cns = !isBlank(v['prd-cnspac']!);
      const cpf = !isBlank(v['prd-cpf-pcnte']!);
      if (cns && cpf) err(n, 'Paciente identificado por CNS e CPF ao mesmo tempo: informe só um deles', 'prd-cpf-pcnte');
      if (!cns && !cpf) warn(n, 'Paciente sem CNS e sem CPF (obrigatório quando o procedimento exigir)', 'prd-cnspac');
      if (!['M', 'F'].includes(v['prd-sexo']!)) err(n, `Sexo deve ser M ou F (veio "${v['prd-sexo']}")`, 'prd-sexo');
      if (!isBlank(v['prd-cid']!) && !/^[A-Z]\d{2}[A-Z0-9 ]$/.test(v['prd-cid']!)) err(n, `CID inválido: "${v['prd-cid']}"`, 'prd-cid');
      if (!isBlank(v['prd-caten']!) && !['01', '02'].includes(v['prd-caten']!)) err(n, `Caráter do atendimento deve ser 01 ou 02 (veio "${v['prd-caten']}")`, 'prd-caten');
      if (!isBlank(v['prd-dtnasc']!) && !validDate(v['prd-dtnasc']!)) err(n, `Data de nascimento inválida: "${v['prd-dtnasc']}"`, 'prd-dtnasc');
      if (!isBlank(v['prd-raca']!) && !RACA.has(v['prd-raca']!)) err(n, `Raça/cor "${v['prd-raca']}" fora do domínio 01-05/99`, 'prd-raca');
      if (!isBlank(v['prd-etnia']!) && v['prd-raca'] !== '05') warn(n, 'Etnia preenchida com raça/cor diferente de 05 (indígena)', 'prd-etnia');
      if (![' ', 'N', 'S'].includes(v['prd-situacao-rua']!)) err(n, `Situação de rua deve ser S, N ou branco (veio "${v['prd-situacao-rua']}")`, 'prd-situacao-rua');
      if (isBlank(v['prd-nmpac']!)) err(n, 'Nome do paciente em branco', 'prd-nmpac');
    }
  }
  result.records.sheets = maxSheet;
  if (result.header && result.header.lines !== result.records.total) err(1, `Cabeçalho informa ${result.header.lines} linha(s), mas o arquivo tem ${result.records.total}`, 'cbc-lin');
  if (result.header && maxSheet && result.header.sheets !== maxSheet) err(1, `Cabeçalho informa ${result.header.sheets} folha(s), mas a maior folha é ${maxSheet}`, 'cbc-flh');
  if (result.records.total === 0) err(1, 'O arquivo não tem linhas de produção');
  result.computedControl = control_lines.length ? controlField(control_lines) : null;
  if (result.computedControl !== null && result.header && result.computedControl !== result.header.control)
    err(1, `Campo de controle ${result.header.control} não confere com o calculado ${result.computedControl}`, 'cbc-smt-vrf');
  return finish(result);
}

function finish(result: BpaValidation): BpaValidation {
  result.errors = result.issues.filter((i) => i.severity === 'erro').length;
  result.warnings = result.issues.length - result.errors;
  result.ok = result.errors === 0;
  return result;
}
