/** Leitura de planilhas CSV exportadas do Excel/LibreOffice: detecta o separador (; , ou tab), aceita aspas e BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [';', ',', '\t'].map((d) => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0]!.d;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((v) => v.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else field += c;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/** "Nº do Cartão SUS" → "n_do_cartao_sus": compara cabeçalhos sem acentos, caixa ou pontuação. */
export function normalizeHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export interface CsvTable<K extends string> {
  headers: string[];
  /** Colunas conhecidas encontradas na planilha. */
  found: K[];
  rows: { line: number; values: Partial<Record<K, string>> }[];
}

/** Lê a planilha e mapeia as colunas pelos sinônimos aceitos de cada campo. */
export function tableFromCsv<K extends string>(text: string, columns: Record<K, string[]>): CsvTable<K> {
  const parsed = parseCsv(text);
  if (parsed.length === 0) return { headers: [], found: [], rows: [] };
  const headers = parsed[0]!.map((h) => normalizeHeader(h));
  const index: Partial<Record<K, number>> = {};
  for (const key of Object.keys(columns) as K[]) {
    const i = headers.findIndex((h) => columns[key].map(normalizeHeader).includes(h));
    if (i >= 0) index[key] = i;
  }
  const found = (Object.keys(index) as K[]).sort();
  const rows = parsed.slice(1).map((cells, i) => {
    const values: Partial<Record<K, string>> = {};
    for (const key of found) values[key] = (cells[index[key]!] ?? '').trim();
    return { line: i + 2, values };
  });
  return { headers, found, rows };
}
