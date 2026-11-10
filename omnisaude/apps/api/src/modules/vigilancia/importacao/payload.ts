import { gunzipSync, gzipSync } from 'node:zlib';
import type { Cobertura, RegistroDoEnvio } from './leitura';

/**
 * Payload da prévia (official_imports.payload): os registros normalizados em JSON, uma linha por registro (NDJSON),
 * com gzip. A primeira linha traz a cobertura e a tabela das listas de colunas (iguais em todas as linhas de um
 * arquivo: cada parte guarda só o índice). Assim o envio grande não vira uma string única na memória.
 */

export interface PayloadImportacao {
  versao: 1;
  registros: RegistroDoEnvio[];
  cobertura: Cobertura[];
}

export function gravarPayload(p: PayloadImportacao) {
  const tabela: string[][] = [];
  const indice = new Map<string, number>();
  const linhas: Buffer[] = [];
  for (const r of p.registros) {
    const partes = r.partes.map((parte) => {
      const k = parte.colunas.join('\u0001');
      let i = indice.get(k);
      if (i === undefined) {
        i = tabela.length;
        tabela.push(parte.colunas);
        indice.set(k, i);
      }
      return { ...parte, colunas: i };
    });
    linhas.push(Buffer.from(`${JSON.stringify({ ...r, partes })}\n`, 'utf8'));
  }
  const cabecalho = Buffer.from(`${JSON.stringify({ versao: p.versao, cobertura: p.cobertura, colunas: tabela })}\n`, 'utf8');
  return gzipSync(Buffer.concat([cabecalho, ...linhas]));
}

export function lerPayload(gz: Uint8Array): PayloadImportacao {
  const bruto = gunzipSync(gz);
  let fim = bruto.indexOf(0x0a);
  if (fim < 0) throw new Error('Payload da prévia sem cabeçalho');
  const cab = JSON.parse(bruto.subarray(0, fim).toString('utf8')) as { versao: 1; cobertura: Cobertura[]; colunas: string[][] };
  const registros: RegistroDoEnvio[] = [];
  for (let inicio = fim + 1; inicio < bruto.length; inicio = fim + 1) {
    fim = bruto.indexOf(0x0a, inicio);
    if (fim < 0) fim = bruto.length;
    if (fim === inicio) continue;
    const r = JSON.parse(bruto.subarray(inicio, fim).toString('utf8')) as Omit<RegistroDoEnvio, 'partes'> & { partes: (Omit<RegistroDoEnvio['partes'][number], 'colunas'> & { colunas: number })[] };
    registros.push({ ...r, partes: r.partes.map((p) => ({ ...p, colunas: cab.colunas[p.colunas] ?? [] })) });
  }
  return { versao: cab.versao, cobertura: cab.cobertura, registros };
}
