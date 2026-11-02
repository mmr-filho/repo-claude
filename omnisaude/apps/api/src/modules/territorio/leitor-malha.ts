import { unzipSync } from 'fflate';
import proj4 from 'proj4';
import * as shapefile from 'shapefile';
import { normalizarLogradouro, normalizarNumero, quadraLote } from '@omnisaude/shared';

/**
 * Leitura das malhas enviadas pela instituição (prefeitura, coordenação de endemias, IBGE): shapefile zipado com .prj
 * (e .cpg para a codificação do .dbf) ou GeoJSON. Saída sempre em WGS 84 / SIRGAS 2000 geográfico, [lng, lat]
 * (RFC 7946). SIRGAS 2000 e WGS 84 são tratados como idênticos (IBGE R.PR 01/2015); SAD 69 e Córrego Alegre exigem as
 * grades de transformação do IBGE e são recusados com orientação.
 */

export class ArquivoInvalido extends Error {}

/** Sistemas de referência aceitos sem .prj (ou informados na tela). */
export const SRC_CONHECIDOS: Record<string, { label: string; def: string | null }> = {
  'EPSG:4326': { label: 'WGS 84 (graus)', def: null },
  'EPSG:4674': { label: 'SIRGAS 2000 (graus)', def: null },
  ...Object.fromEntries([17, 18, 19, 20, 21, 22, 23, 24, 25].map((z) => [`EPSG:${31960 + z}`, { label: `SIRGAS 2000 / UTM ${z}S (metros)`, def: `+proj=utm +zone=${z} +south +ellps=GRS80 +units=m +no_defs +type=crs` }])),
};

/** Limites do Brasil com folga (confere o resultado da reprojeção). */
const BRASIL: [number, number, number, number] = [-74.5, -34.5, -28, 6];

export interface FeicaoLida {
  propriedades: Record<string, unknown>;
  geometria: { type: string; coordinates: unknown } | null;
}

export interface MalhaLida {
  formato: 'SHAPEFILE' | 'GEOJSON';
  src: string;
  feicoes: FeicaoLida[];
  avisos: string[];
}

const DATUM_ANTIGO = /SAD[_ ]?(19)?69|South_American_1969|Corrego[_ ]Alegre|Córrego[_ ]Alegre/i;
const MSG_DATUM_ANTIGO = 'O arquivo está em SAD 69 ou Córrego Alegre. Converta para SIRGAS 2000 com as grades oficiais do IBGE (ProGriD ou QGIS com a grade SAD69_003.GSB/SAD96_003.GSB) e envie de novo.';

/** Códigos EPSG do SAD 69 e do Córrego Alegre (geográficos e UTM): exigem as grades do IBGE, não uma fórmula. */
function epsgAntigo(codigo: string): boolean {
  const n = Number(codigo.replace(/^EPSG:/i, ''));
  return [4618, 4291, 4225, 5527].includes(n) || (n >= 29168 && n <= 29172) || (n >= 29187 && n <= 29195) || (n >= 22521 && n <= 22525) || (n >= 5531 && n <= 5536) || (n >= 5875 && n <= 5877);
}

/** Sistema declarado no GeoJSON (membro "crs"): só os aceitos; SAD 69 e Córrego Alegre têm mensagem própria. */
function srcDoGeojsonAceito(src: string) {
  if (epsgAntigo(src)) throw new ArquivoInvalido(MSG_DATUM_ANTIGO);
  if (!(src in SRC_CONHECIDOS)) throw new ArquivoInvalido(`Sistema de referência do GeoJSON não aceito: ${src}. Converta para SIRGAS 2000 ou WGS 84.`);
  return srcInformado(src);
}

/** Teto do conteúdo descompactado: o zip de 10 MB não pode virar gigabytes na memória (zip bomb). */
const MAX_DESCOMPACTADO = 150 * 1024 * 1024;

/** Descompacta só os arquivos úteis, recusando o zip cujo conteúdo declarado passa do teto. */
function descompactar(dados: Buffer, util: RegExp): Record<string, Uint8Array> {
  let total = 0;
  let grande = false;
  let arquivos: Record<string, Uint8Array>;
  try {
    arquivos = unzipSync(new Uint8Array(dados), {
      filter: (f) => {
        if (f.name.startsWith('__MACOSX/') || !util.test(f.name)) return false;
        total += f.originalSize;
        if (total > MAX_DESCOMPACTADO) grande = true;
        return !grande;
      },
    });
  } catch {
    throw new ArquivoInvalido('Não foi possível abrir o zip');
  }
  if (grande) throw new ArquivoInvalido('O conteúdo do zip passa de 150 MB descompactado: recorte a camada do município');
  return arquivos;
}

function srcDaPrj(prj: string): { nome: string; para4326: ((p: number[]) => number[]) | null } {
  if (DATUM_ANTIGO.test(prj)) throw new ArquivoInvalido(MSG_DATUM_ANTIGO);
  const geografico = /^\s*GEOGCS/i.test(prj) || /^\s*GEOGCRS/i.test(prj);
  if (geografico) return { nome: /SIRGAS/i.test(prj) ? 'EPSG:4674' : 'EPSG:4326', para4326: null };
  try {
    const conv = proj4(prj, 'EPSG:4326');
    const zona = prj.match(/UTM[_ ]zone[_ ](\d{1,2})S/i);
    return { nome: zona ? `EPSG:${31960 + Number(zona[1])}` : 'PRJ', para4326: (p) => conv.forward(p) };
  } catch {
    throw new ArquivoInvalido('Não foi possível interpretar o arquivo .prj (sistema de referência). Envie em SIRGAS 2000 (graus ou UTM).');
  }
}

function srcInformado(codigo: string): { nome: string; para4326: ((p: number[]) => number[]) | null } {
  const c = SRC_CONHECIDOS[codigo];
  if (!c) throw new ArquivoInvalido(`Sistema de referência não aceito: ${codigo}`);
  if (!c.def) return { nome: codigo, para4326: null };
  const conv = proj4(c.def, 'EPSG:4326');
  return { nome: codigo, para4326: (p) => conv.forward(p) };
}

/** GeoJSON antigo (2008) com o membro "crs": o IBGE publica assim (EPSG:4674). */
function srcDoGeojson(crs: unknown): string | null {
  const nome = (crs as { properties?: { name?: string } } | undefined)?.properties?.name;
  if (!nome) return null;
  const m = nome.match(/EPSG:{1,2}(\d+)/i) ?? nome.match(/CRS84/i);
  if (!m) return null;
  return m[1] ? `EPSG:${m[1]}` : 'EPSG:4326';
}

function transformar(coords: unknown, f: (p: number[]) => number[]): unknown {
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === 'number') return f(coords as number[]);
  return coords.map((c) => transformar(c, f));
}

function caixa(coords: unknown, acc: [number, number, number, number]) {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === 'number') {
    const [x, y] = coords as number[];
    acc[0] = Math.min(acc[0], x!);
    acc[1] = Math.min(acc[1], y!);
    acc[2] = Math.max(acc[2], x!);
    acc[3] = Math.max(acc[3], y!);
    return;
  }
  for (const c of coords) caixa(c, acc);
}

function pareceGraus(feicoes: FeicaoLida[]): boolean {
  const acc: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of feicoes.slice(0, 50)) caixa(f.geometria?.coordinates, acc);
  return acc[0] >= -180 && acc[2] <= 180 && acc[1] >= -90 && acc[3] <= 90;
}

function codificacaoDaCpg(cpg: string | undefined): string {
  const t = (cpg ?? '').trim().toUpperCase();
  if (!t) return 'windows-1252';
  if (t.includes('UTF')) return 'utf-8';
  if (/1252|ANSI|LATIN|8859/.test(t)) return 'windows-1252';
  return 'utf-8';
}

async function lerShapefile(arquivos: Record<string, Uint8Array>): Promise<{ feicoes: FeicaoLida[]; prj: string | null }> {
  const nomes = Object.keys(arquivos).filter((n) => !n.startsWith('__MACOSX/'));
  const shps = nomes.filter((n) => /\.shp$/i.test(n));
  if (shps.length !== 1) throw new ArquivoInvalido(shps.length ? 'O zip tem mais de um shapefile: envie uma camada por arquivo' : 'O zip não tem arquivo .shp');
  const base = shps[0]!.replace(/\.shp$/i, '');
  const achar = (ext: string) => nomes.find((n) => n.toLowerCase() === `${base}.${ext}`.toLowerCase());
  const dbf = achar('dbf');
  if (!dbf) throw new ArquivoInvalido('Falta o arquivo .dbf (atributos) no zip');
  const prj = achar('prj');
  const cpg = achar('cpg');
  const decod = new TextDecoder();
  const encoding = codificacaoDaCpg(cpg ? decod.decode(arquivos[cpg]) : undefined);
  // Cópias com buffer próprio: o leitor usa o ArrayBuffer inteiro.
  const fonte = await shapefile.open(Uint8Array.from(arquivos[shps[0]!]!), Uint8Array.from(arquivos[dbf]!), { encoding });
  const feicoes: FeicaoLida[] = [];
  for (;;) {
    const r = await fonte.read();
    if (r.done) break;
    const f = r.value as { properties?: Record<string, unknown>; geometry?: { type: string; coordinates: unknown } | null };
    feicoes.push({ propriedades: f.properties ?? {}, geometria: f.geometry ?? null });
  }
  return { feicoes, prj: prj ? decod.decode(arquivos[prj]) : null };
}

function lerGeojson(texto: string): { feicoes: FeicaoLida[]; src: string | null } {
  let g: { type?: string; features?: unknown[]; geometry?: unknown; properties?: unknown; crs?: unknown };
  try {
    g = JSON.parse(texto);
  } catch {
    throw new ArquivoInvalido('O arquivo não é um JSON válido');
  }
  const src = srcDoGeojson(g.crs);
  if (g.type === 'FeatureCollection' && Array.isArray(g.features))
    return {
      src,
      feicoes: g.features.map((f) => {
        const x = f as { properties?: Record<string, unknown>; geometry?: { type: string; coordinates: unknown } | null };
        return { propriedades: x.properties ?? {}, geometria: x.geometry ?? null };
      }),
    };
  if (g.type === 'Feature') return { src, feicoes: [{ propriedades: (g.properties as Record<string, unknown>) ?? {}, geometria: (g.geometry as { type: string; coordinates: unknown }) ?? null }] };
  if (g.type === 'Polygon' || g.type === 'MultiPolygon') return { src, feicoes: [{ propriedades: {}, geometria: g as { type: string; coordinates: unknown } }] };
  throw new ArquivoInvalido('GeoJSON sem feições (esperado FeatureCollection, Feature ou Polygon)');
}

/** Lê o arquivo enviado (zip com shapefile ou GeoJSON, .geojson/.json solto) e devolve as feições em graus WGS 84. */
export async function lerMalha(nomeArquivo: string, dados: Buffer, srcEscolhido?: string | null): Promise<MalhaLida> {
  const avisos: string[] = [];
  let formato: MalhaLida['formato'];
  let feicoes: FeicaoLida[];
  let conv: { nome: string; para4326: ((p: number[]) => number[]) | null } | null = null;
  if (/\.zip$/i.test(nomeArquivo)) {
    const arquivos = descompactar(dados, /\.(shp|dbf|prj|cpg|geojson|json)$/i);
    const geo = Object.keys(arquivos).find((n) => /\.(geo)?json$/i.test(n));
    if (geo && !Object.keys(arquivos).some((n) => /\.shp$/i.test(n))) {
      const r = lerGeojson(new TextDecoder().decode(arquivos[geo]));
      formato = 'GEOJSON';
      feicoes = r.feicoes;
      if (r.src) conv = srcDoGeojsonAceito(r.src);
    } else {
      formato = 'SHAPEFILE';
      const r = await lerShapefile(arquivos);
      feicoes = r.feicoes;
      if (r.prj) conv = srcDaPrj(r.prj);
      else if (!srcEscolhido) throw new ArquivoInvalido('O shapefile não tem o arquivo .prj: informe o sistema de referência (ex.: SIRGAS 2000 / UTM 22S)');
    }
  } else if (/\.(geo)?json$/i.test(nomeArquivo)) {
    formato = 'GEOJSON';
    // TextDecoder tira o BOM que o Bloco de Notas e outras ferramentas do Windows põem no começo.
    const r = lerGeojson(new TextDecoder().decode(dados));
    feicoes = r.feicoes;
    if (r.src) conv = srcDoGeojsonAceito(r.src);
  } else throw new ArquivoInvalido('Envie um .zip com o shapefile (.shp, .dbf, .prj) ou um arquivo .geojson');
  if (srcEscolhido) {
    if (conv && conv.nome !== srcEscolhido) avisos.push(`O arquivo declara ${conv.nome}; foi usado o informado na tela (${srcEscolhido}).`);
    conv = srcInformado(srcEscolhido);
  }
  if (!conv) {
    if (!pareceGraus(feicoes)) throw new ArquivoInvalido('As coordenadas estão em metros e o arquivo não diz o sistema de referência: informe-o (ex.: SIRGAS 2000 / UTM 22S)');
    conv = { nome: 'EPSG:4326', para4326: null };
    avisos.push('Sem sistema de referência declarado: considerado WGS 84/SIRGAS 2000 em graus (padrão do GeoJSON).');
  }
  if (conv.para4326) {
    const f = conv.para4326;
    for (const x of feicoes) if (x.geometria) x.geometria = { type: x.geometria.type, coordinates: transformar(x.geometria.coordinates, f) };
  }
  const acc: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const x of feicoes) caixa(x.geometria?.coordinates, acc);
  if (feicoes.length && (acc[0] < BRASIL[0] || acc[2] > BRASIL[2] || acc[1] < BRASIL[1] || acc[3] > BRASIL[3]))
    throw new ArquivoInvalido('As coordenadas ficam fora do Brasil depois da conversão: confira o sistema de referência (fuso UTM, graus ou metros)');
  return { formato, src: conv.nome, feicoes, avisos };
}

// ───────────── Base de endereços do IBGE (CNEFE do Censo 2022) ─────────────

export interface EnderecoCnefe {
  externalId: string;
  ibgeCode: string;
  sector: string | null;
  quadra: string | null;
  face: string | null;
  cep: string | null;
  locality: string | null;
  street: string;
  streetKey: string;
  number: string | null;
  complement: string | null;
  quadraKey: string | null;
  loteKey: string | null;
  latitude: number;
  longitude: number;
  level: number;
  species: number | null;
}

/** Linha do CSV com aspas opcionais e separador ';' (o CNEFE vem em ASCII, separado por ';', fim de linha CRLF). */
function campos(linha: string): string[] {
  const out: string[] = [];
  let atual = '';
  let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const ch = linha[i]!;
    if (aspas) {
      if (ch === '"' && linha[i + 1] === '"') {
        atual += '"';
        i++;
      } else if (ch === '"') aspas = false;
      else atual += ch;
    } else if (ch === '"') aspas = true;
    else if (ch === ';') {
      out.push(atual);
      atual = '';
    } else atual += ch;
  }
  out.push(atual);
  return out;
}

/**
 * CNEFE 2022 por município (CSV do IBGE, ou o zip com o CSV): um endereço por COD_UNICO_ENDERECO, com coordenada e
 * nível de geocodificação (NV_GEO_COORD). Sem morador: o IBGE publica só endereço, espécie e estabelecimento.
 */
export function lerCnefe(nomeArquivo: string, dados: Buffer): { enderecos: EnderecoCnefe[]; municipios: string[]; ignorados: number } {
  let texto: string;
  if (/\.zip$/i.test(nomeArquivo)) {
    const arquivos = descompactar(dados, /\.csv$/i);
    const csv = Object.keys(arquivos).find((n) => /\.csv$/i.test(n));
    if (!csv) throw new ArquivoInvalido('O zip não tem o CSV do CNEFE');
    texto = new TextDecoder().decode(arquivos[csv]);
  } else if (/\.csv$/i.test(nomeArquivo)) texto = dados.toString('utf8');
  else throw new ArquivoInvalido('Envie o CSV do CNEFE do município (ou o zip baixado do IBGE)');
  const linhas = texto.replace(/^﻿/, '').split(/\r?\n/);
  const cab = campos(linhas[0] ?? '').map((c) => c.trim().toUpperCase());
  const col = (...nomes: string[]) => nomes.map((n) => cab.indexOf(n)).find((i) => i >= 0) ?? -1;
  const ix = {
    id: col('COD_UNICO_ENDERECO'),
    mun: col('COD_MUNICIPIO'),
    setor: col('COD_SETOR'),
    quadra: col('NUM_QUADRA'),
    face: col('NUM_FACE'),
    cep: col('CEP'),
    loc: col('DSC_LOCALIDADE'),
    tipo: col('NOM_TIPO_SEGLOGR'),
    titulo: col('NOM_TITULO_SEGLOGR'),
    nome: col('NOM_SEGLOGR'),
    num: col('NUM_ENDERECO'),
    mod: col('DSC_MODIFICADOR'),
    lat: col('LATITUDE'),
    lng: col('LONGITUDE'),
    nivel: col('NV_GEO_COORD'),
    especie: col('COD_ESPECIE'),
  };
  if (ix.id < 0 || ix.lat < 0 || ix.lng < 0 || ix.nome < 0 || ix.nivel < 0)
    throw new ArquivoInvalido('O CSV não está no layout do CNEFE 2022 (faltam COD_UNICO_ENDERECO, NOM_SEGLOGR, LATITUDE, LONGITUDE ou NV_GEO_COORD)');
  const compl = [1, 2, 3, 4, 5].map((n) => ({ nom: cab.indexOf(`NOM_COMP_ELEM${n}`), val: cab.indexOf(`VAL_COMP_ELEM${n}`) }));
  const enderecos: EnderecoCnefe[] = [];
  const vistos = new Set<string>();
  const municipios = new Set<string>();
  let ignorados = 0;
  const num = (s: string | undefined) => Number((s ?? '').trim().replace(',', '.'));
  for (const linha of linhas.slice(1)) {
    if (!linha.trim()) continue;
    const c = campos(linha);
    const v = (i: number) => (i >= 0 ? (c[i] ?? '').trim() : '');
    const id = v(ix.id);
    const lat = num(c[ix.lat]);
    const lng = num(c[ix.lng]);
    const nivel = Number(v(ix.nivel));
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || !Number.isInteger(nivel)) {
      ignorados++;
      continue;
    }
    if (vistos.has(id)) continue; // uma linha por espécie no mesmo endereço
    vistos.add(id);
    const complementos = compl
      .map(({ nom, val }) => [v(nom), v(val)].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(' ');
    const ql = quadraLote(complementos);
    const rua = [v(ix.tipo), v(ix.titulo), v(ix.nome)].filter(Boolean).join(' ');
    const sn = /^S\/?N$/i.test(v(ix.mod)) || /^0*$/.test(v(ix.num));
    const mun = v(ix.mun);
    if (mun) municipios.add(mun);
    enderecos.push({
      externalId: id,
      ibgeCode: mun.slice(0, 7),
      sector: v(ix.setor) || null,
      quadra: v(ix.quadra) || null,
      face: v(ix.face) || null,
      cep: v(ix.cep).replace(/\D/g, '').slice(0, 8) || null,
      locality: v(ix.loc) || null,
      street: rua,
      streetKey: normalizarLogradouro(rua),
      number: sn ? null : normalizarNumero(v(ix.num)),
      complement: complementos || null,
      quadraKey: ql.quadra,
      loteKey: ql.lote,
      latitude: Math.round(lat * 1e6) / 1e6,
      longitude: Math.round(lng * 1e6) / 1e6,
      level: nivel,
      species: v(ix.especie) ? Number(v(ix.especie)) : null,
    });
  }
  return { enderecos, municipios: [...municipios], ignorados };
}
