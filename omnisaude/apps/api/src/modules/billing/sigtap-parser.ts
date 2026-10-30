import type { ZipEntry } from './zip';

/**
 * Leitura da Tabela Unificada (SIGTAP) no formato publicado pelo DATASUS: cada tabela tb_x.txt
 * (largura fixa, latin1) vem acompanhada de tb_x_layout.txt com as colunas e posições.
 * As posições nunca são fixadas no código: a leitura segue o layout que veio no pacote.
 */

export interface LayoutColumn {
  name: string;
  size: number;
  start: number; // 1-based
  end: number;
  type: string;
}

export function parseLayout(text: string): LayoutColumn[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const header = lines.shift()?.toLowerCase() ?? '';
  if (!header.includes('coluna')) throw new Error('Layout SIGTAP sem cabeçalho "Coluna,Tamanho,Inicio,Fim,Tipo"');
  return lines.map((line) => {
    const [name, size, start, end, type] = line.split(',').map((c) => c.trim());
    if (!name || !start || !end) throw new Error(`Linha de layout inválida: ${line}`);
    return { name: name.toUpperCase(), size: Number(size), start: Number(start), end: Number(end), type: type ?? '' };
  });
}

export function parseFixedWidth(text: string, layout: LayoutColumn[]): Record<string, string>[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => Object.fromEntries(layout.map((c) => [c.name, line.slice(c.start - 1, c.end).trim()])));
}

export interface SigtapProcedureRow {
  code: string;
  name: string;
  complexity: string | null;
  sex: string;
  minAgeMonths: number;
  maxAgeMonths: number;
  maxQuantity: number;
  valueSh: number;
  valueSa: number;
  valueSp: number;
  competencia: string;
}

export interface SigtapTables {
  competencia: string;
  procedures: SigtapProcedureRow[];
  cbo: { procedureCode: string; cbo: string }[];
  cid: { procedureCode: string; cid: string }[];
  instruments: Map<string, Set<string>>;
}

/**
 * Códigos de instrumento de registro (rl_procedimento_registro → tb_registro) mapeados para os
 * instrumentos do OmniSaúde. Premissa a confirmar com a tb_registro da competência:
 * 01 BPA consolidado, 02 BPA individualizado, 03/04 AIH (principal/secundário), 06/07 APAC (principal/secundário).
 */
export const REGISTRO_TO_INSTRUMENT: Record<string, 'BPA_C' | 'BPA_I' | 'AIH' | 'APAC'> = {
  '01': 'BPA_C',
  '02': 'BPA_I',
  '03': 'AIH',
  '04': 'AIH',
  '06': 'APAC',
  '07': 'APAC',
};

function table(entries: ZipEntry[], name: string, required: boolean): Record<string, string>[] {
  const find = (file: string) => entries.find((e) => e.name.split('/').pop()?.toLowerCase() === file);
  const data = find(`${name}.txt`);
  const layout = find(`${name}_layout.txt`);
  if (!data || !layout) {
    if (required) throw new Error(`Pacote SIGTAP incompleto: falta ${name}.txt ou ${name}_layout.txt`);
    return [];
  }
  return parseFixedWidth(data.data.toString('latin1'), parseLayout(layout.data.toString('latin1')));
}

const int = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : 0);
const money = (v: string | undefined) => int(v) / 100;

export function readSigtapTables(entries: ZipEntry[]): SigtapTables {
  const procedures = table(entries, 'tb_procedimento', true).map((r) => ({
    code: r.CO_PROCEDIMENTO ?? '',
    name: r.NO_PROCEDIMENTO ?? '',
    complexity: r.TP_COMPLEXIDADE || null,
    sex: (r.TP_SEXO || 'I').slice(0, 1),
    minAgeMonths: int(r.VL_IDADE_MINIMA),
    maxAgeMonths: int(r.VL_IDADE_MAXIMA),
    maxQuantity: int(r.QT_MAXIMA_EXECUCAO),
    valueSh: money(r.VL_SH),
    valueSa: money(r.VL_SA),
    valueSp: money(r.VL_SP),
    competencia: r.DT_COMPETENCIA ?? '',
  }));
  const valid = procedures.filter((p) => /^\d{10}$/.test(p.code));
  if (valid.length === 0) throw new Error('Pacote SIGTAP sem procedimentos');
  const codes = new Set(valid.map((p) => p.code));

  const cbo = table(entries, 'rl_procedimento_ocupacao', false)
    .map((r) => ({ procedureCode: r.CO_PROCEDIMENTO ?? '', cbo: r.CO_OCUPACAO ?? '' }))
    .filter((r) => codes.has(r.procedureCode) && /^\w{6}$/.test(r.cbo));
  const cid = table(entries, 'rl_procedimento_cid', false)
    .map((r) => ({ procedureCode: r.CO_PROCEDIMENTO ?? '', cid: (r.CO_CID ?? '').toUpperCase() }))
    .filter((r) => codes.has(r.procedureCode) && r.cid.length >= 3);
  const instruments = new Map<string, Set<string>>();
  for (const r of table(entries, 'rl_procedimento_registro', false)) {
    const instrument = REGISTRO_TO_INSTRUMENT[r.CO_REGISTRO ?? ''];
    const code = r.CO_PROCEDIMENTO ?? '';
    if (!instrument || !codes.has(code)) continue;
    if (!instruments.has(code)) instruments.set(code, new Set());
    instruments.get(code)!.add(instrument);
  }
  const competencia = valid.find((p) => /^\d{6}$/.test(p.competencia))?.competencia ?? '';
  return { competencia, procedures: valid, cbo: dedupe(cbo, (r) => `${r.procedureCode}|${r.cbo}`), cid: dedupe(cid, (r) => `${r.procedureCode}|${r.cid}`), instruments };
}

function dedupe<T>(rows: T[], key: (r: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = key(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
