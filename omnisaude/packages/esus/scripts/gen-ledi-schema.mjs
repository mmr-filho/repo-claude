#!/usr/bin/env node
/**
 * Gera src/ledi-schema.ts a partir dos arquivos .thrift oficiais do LEDI (repositório
 * laboratoriobridge/esusab-integracao). Uso: node scripts/gen-ledi-schema.mjs <pasta thrift do repositório>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
if (!root) {
  console.error('Informe a pasta "thrift" do repositório esusab-integracao');
  process.exit(1);
}
const files = {
  dado_transporte: join(root, 'layout-camada-transport/thrift/dado_transporte.thrift'),
  ...Object.fromEntries(
    [
      'common',
      'solicitacao_oci',
      'cadastro_individual',
      'cadastro_domiciliar',
      'ficha_atendimento_individual',
      'ficha_atendimento_odonto',
      'ficha_atendimento_procedimento',
      'ficha_vacinacao',
      'ficha_visita_domiciliar',
      'ficha_atividade_coletiva',
    ].map((n) => [n, join(root, `layout-ras/thrift/${n}.thrift`)]),
  ),
};

function parseType(raw) {
  const t = raw.trim();
  const list = /^list\s*<(.+)>$/.exec(t);
  if (list) return { list: parseType(list[1]) };
  if (['bool', 'i32', 'i64', 'double', 'string', 'binary'].includes(t)) return t;
  if (t === 'byte' || t === 'i8') return 'i32';
  return { struct: t.split('.').pop() };
}

const structs = {};
for (const [mod, path] of Object.entries(files)) {
  let s = readFileSync(path, 'utf8');
  s = s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/#[^\n]*/g, '');
  if (/\b(enum|typedef|union|map<|set<)/.test(s)) throw new Error(`Construção não suportada em ${mod}`);
  for (const m of s.matchAll(/struct\s+(\w+)\s*\{([\s\S]*?)\}/g)) {
    const fields = [];
    for (const f of m[2].matchAll(/(\d+)\s*:\s*(required|optional)?\s*([\w.<>, ]+?)\s+(\w+)\s*(?:=\s*[^,;]+)?\s*[,;]?/g)) {
      fields.push({ id: Number(f[1]), name: f[4], type: parseType(f[3]), required: f[2] === 'required' });
    }
    structs[m[1]] = { module: mod, fields };
  }
}

const lines = [
  '/**',
  ' * Esquema dos registros do LEDI (Layout e-SUS APS de Dados e Interface), gerado por scripts/gen-ledi-schema.mjs a',
  ' * partir dos arquivos .thrift oficiais (repositório laboratoriobridge/esusab-integracao). Não edite à mão.',
  ' */',
  '',
  "export type LediFieldType = 'bool' | 'i32' | 'i64' | 'double' | 'string' | 'binary' | { list: LediFieldType } | { struct: string };",
  'export interface LediField {',
  '  id: number;',
  '  name: string;',
  '  type: LediFieldType;',
  '  required: boolean;',
  '}',
  '',
  'export const LEDI_STRUCTS: Record<string, LediField[]> = {',
];
for (const [name, st] of Object.entries(structs)) {
  lines.push(`  // ${st.module}.thrift`);
  lines.push(`  ${name}: [`);
  for (const f of st.fields) lines.push(`    { id: ${f.id}, name: '${f.name}', type: ${JSON.stringify(f.type).replace(/"/g, "'")}, required: ${f.required} },`);
  lines.push('  ],');
}
lines.push('};', '');
const out = join(dirname(fileURLToPath(import.meta.url)), '../src/ledi-schema.ts');
writeFileSync(out, lines.join('\n'));
console.log(`${Object.keys(structs).length} estruturas em ${out}`);
