import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Corpus } from './rag';
import type { Perfil, Trecho } from './tipos';

// Leitura dos arquivos gerados pelo ETL (Node). No Worker, os mesmos JSON entram como módulos ou vêm do KV.

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DADOS = path.join(RAIZ, 'dados');

const ler = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8')) as T;

export function perfis(dir = path.join(DADOS, 'perfil')): Perfil[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^perfil_municipio_\d+\.json$/.test(f))
    .sort()
    .map((f) => ler<Perfil>(path.join(dir, f)));
}

export function corpus(arquivo = path.join(DADOS, 'rag', 'chunks.json')): Corpus {
  return new Corpus(ler<{ chunks: Trecho[] }>(arquivo).chunks);
}
