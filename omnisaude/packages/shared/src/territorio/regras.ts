/**
 * Território único (PLT-3): localidade > bairro (sublocalidade) > quarteirão > imóvel, para ACS, ACE e vigilância.
 * Base normativa: Manual de Normas Técnicas do PNCD (FUNASA, 2001), Diretrizes Nacionais para Prevenção e Controle
 * de Epidemias de Dengue (2009) e de Arboviroses (2025), LEDI do e-SUS APS 8.7.0. Ver docs/TERRITORIO.md.
 */

/**
 * Nível de precisão da posição do imóvel. A geocodificação é só local (GPS em campo, clique no mapa, base de endereços
 * do IBGE carregada no município, centro do quarteirão ou da localidade): o endereço de paciente não sai para serviços
 * externos (LGPD, arts. 7º, 11 e 26; os termos do Nominatim público vedam dado pessoal).
 */
/** Da melhor para a pior: o centro do quarteirão (dezenas de metros) vem antes da rua sem número (pode ter quilômetros). */
export const PRECISOES = ['GPS_CAMPO', 'MAPA', 'ENDERECO', 'FACE', 'QUARTEIRAO', 'LOGRADOURO', 'LOCALIDADE', 'SETOR', 'CEP', 'MUNICIPIO'] as const;
export type PrecisaoGeo = (typeof PRECISOES)[number];

export const PRECISAO_INFO: Record<PrecisaoGeo, { label: string; raioTipicoM: number | null; bloqueio: 'AUTOMATICO' | 'COM_AVISO' | 'CONFIRMAR_EM_CAMPO' }> = {
  GPS_CAMPO: { label: 'GPS em campo', raioTipicoM: null, bloqueio: 'AUTOMATICO' },
  MAPA: { label: 'Marcado no mapa', raioTipicoM: 10, bloqueio: 'AUTOMATICO' },
  // CNEFE 2022, níveis 1 a 3: coordenada coletada no endereço (erro de 5,84 m ideal, até 11,71 m em condição normal).
  ENDERECO: { label: 'Endereço (base do IBGE)', raioTipicoM: 12, bloqueio: 'AUTOMATICO' },
  FACE: { label: 'Face de quadra (base do IBGE)', raioTipicoM: 50, bloqueio: 'COM_AVISO' },
  LOGRADOURO: { label: 'Logradouro, sem o número', raioTipicoM: null, bloqueio: 'CONFIRMAR_EM_CAMPO' },
  QUARTEIRAO: { label: 'Centro do quarteirão', raioTipicoM: 60, bloqueio: 'COM_AVISO' },
  LOCALIDADE: { label: 'Centro da localidade ou bairro', raioTipicoM: null, bloqueio: 'CONFIRMAR_EM_CAMPO' },
  SETOR: { label: 'Centro do setor censitário', raioTipicoM: null, bloqueio: 'CONFIRMAR_EM_CAMPO' },
  CEP: { label: 'CEP', raioTipicoM: null, bloqueio: 'CONFIRMAR_EM_CAMPO' },
  MUNICIPIO: { label: 'Município', raioTipicoM: null, bloqueio: 'CONFIRMAR_EM_CAMPO' },
};

/** Ordem de qualidade (menor é melhor): uma posição nova só substitui a atual se for melhor ou igual. */
export const ORDEM_PRECISAO: Record<PrecisaoGeo, number> = Object.fromEntries(PRECISOES.map((p, i) => [p, i])) as Record<PrecisaoGeo, number>;

/**
 * GPS: a "accuracy" do Android é o raio com 68% de confiança; a da API de geolocalização do navegador, com 95%.
 * Normaliza para 95% (fator ~1,62 sob erro normal circular) antes de aplicar os limites.
 */
export function raio95(accuracyM: number, confianca: 68 | 95): number {
  return confianca === 68 ? accuracyM * 1.62 : accuracyM;
}

/** Limites do GPS em campo (95%): até 20 m aceita; 20 a 50 m aceita com alerta; acima de 50 m, nova leitura. */
export function avaliarGps(accuracy95M: number): 'ACEITA' | 'ALERTA' | 'NOVA_LEITURA' {
  return accuracy95M <= 20 ? 'ACEITA' : accuracy95M <= 50 ? 'ALERTA' : 'NOVA_LEITURA';
}

/** Localidade (PNCD 2001): área com um ou mais imóveis, nome próprio e limites definidos. */
export const CATEGORIAS_LOCALIDADE = ['CIDADE', 'VILA', 'DISTRITO', 'POVOADO', 'ASSENTAMENTO', 'ALDEIA', 'FAZENDA', 'SITIO', 'CHACARA', 'OUTRA'] as const;
export type CategoriaLocalidade = (typeof CATEGORIAS_LOCALIDADE)[number];
export const CATEGORIA_LOCALIDADE_LABEL: Record<CategoriaLocalidade, string> = {
  CIDADE: 'Cidade (sede)',
  VILA: 'Vila',
  DISTRITO: 'Distrito',
  POVOADO: 'Povoado',
  ASSENTAMENTO: 'Assentamento',
  ALDEIA: 'Aldeia',
  FAZENDA: 'Fazenda',
  SITIO: 'Sítio',
  CHACARA: 'Chácara',
  OUTRA: 'Outra',
};

/** Zona do imóvel (LEDI, LocalizacaoDaMoradia: 83 urbana, 84 rural, 205 periurbana). */
export const ZONAS = ['URBANA', 'RURAL', 'PERIURBANA'] as const;
export type Zona = (typeof ZONAS)[number];
export const ZONA_ESUS: Record<Zona, number> = { URBANA: 83, RURAL: 84, PERIURBANA: 205 };

/**
 * Classe do reconhecimento geográfico (R residência, C comércio, TB terreno baldio, PE ponto estratégico, O outros)
 * para cada tipo de imóvel do Cadastro Domiciliar e Territorial (TIPO_IMOVEL do e-SUS), e se é imóvel especial
 * (Diretrizes de 2025). O mapeamento é escolha de projeto a validar com a coordenação de endemias.
 */
export const CLASSE_RG_IMOVEL: Record<string, { rg: 'R' | 'C' | 'TB' | 'PE' | 'O'; especial?: boolean }> = {
  '01': { rg: 'R' },
  '02': { rg: 'C' },
  '03': { rg: 'TB' },
  '04': { rg: 'PE' },
  '05': { rg: 'O', especial: true },
  '06': { rg: 'O', especial: true },
  '07': { rg: 'O' },
  '08': { rg: 'O' },
  '09': { rg: 'O', especial: true },
  '10': { rg: 'O', especial: true },
  '11': { rg: 'O', especial: true },
  '12': { rg: 'O' },
  '13': { rg: 'O' },
  '99': { rg: 'O' },
};

/** Numeração dos quarteirões: única na localidade ou reiniciada em cada bairro (PNCD 2001: facultado por bairro ou setor). */
export type NumeracaoQuarteirao = 'LOCALIDADE' | 'BAIRRO';

/** Raio padrão do bloqueio de transmissão (Diretrizes de 2009 e de 2025: no mínimo 150 m da residência do caso). */
export const RAIO_BLOQUEIO_PADRAO_M = 150;

/** Número do quarteirão: dígitos com sufixo opcional da numeração suplementar (ex.: 12, 12-A, 12A). */
export function numeroQuarteiraoValido(n: string): boolean {
  return /^\d{1,5}(-?[A-Z0-9]{1,3})?$/.test(n.trim().toUpperCase());
}

/**
 * Forma única do número do quarteirão (editor, importação e conferência de repetidos): maiúsculas, sem espaços e sem
 * zeros à esquerda na parte numérica ("012" → "12", "007-a" → "7-A"; "0" fica "0").
 */
export function normalizarNumeroQuarteirao(n: string): string {
  return n
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/^0+(?=\d)/, '');
}

/** Código da localidade (cadastro de localidades do DATASUS): até 8 dígitos, único no município. */
export function codigoLocalidadeValido(c: string): boolean {
  return /^\d{1,8}$/.test(c.trim());
}

const TIPOS_LOGRADOURO = ['AVENIDA', 'AV', 'RUA', 'R', 'TRAVESSA', 'TV', 'TRAV', 'ALAMEDA', 'AL', 'PRACA', 'PCA', 'RODOVIA', 'ROD', 'ESTRADA', 'EST', 'VIELA', 'BECO', 'QUADRA', 'LARGO', 'VIA', 'PASSAGEM'];
const TITULOS = [
  'DOUTOR',
  'DR',
  'PROFESSOR',
  'PROF',
  'PROFESSORA',
  'PROFA',
  'PADRE',
  'PE',
  'SANTO',
  'SANTA',
  'SAO',
  'GOVERNADOR',
  'GOV',
  'PRESIDENTE',
  'PRES',
  'CORONEL',
  'CEL',
  'GENERAL',
  'GAL',
  'DOM',
  'DONA',
  'SENADOR',
  'SEN',
  'DEPUTADO',
  'DEP',
  'MAJOR',
  'CAPITAO',
  'CAP',
  'TENENTE',
  'TEN',
  'MARECHAL',
  'MAL',
  'ENGENHEIRO',
  'ENG',
  'VEREADOR',
  'VER',
];

/** Logradouro para casar endereços: maiúsculas, sem acento, sem tipo (rua, avenida...) nem título, números como vêm. */
export function normalizarLogradouro(s: string | null | undefined): string {
  const partes = (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (partes.length > 1 && TIPOS_LOGRADOURO.includes(partes[0]!)) partes.shift();
  return partes.filter((p, i) => !(TITULOS.includes(p) && i < partes.length - 1)).join(' ');
}

/** Número do imóvel: só os dígitos iniciais; "SN", "S/N" e vazio viram null. */
export function normalizarNumero(s: string | null | undefined): string | null {
  const m = (s ?? '').toUpperCase().match(/^\s*0*(\d+)/);
  return m ? m[1]! : null;
}

/** Quadra e lote no complemento (42% dos endereços de Gurupi no CNEFE são "SN" com QUADRA/LOTE). */
export function quadraLote(s: string | null | undefined): { quadra: string | null; lote: string | null } {
  const t = (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  // A abreviação de uma letra (Q 12, L 7) só vale com número, para não pegar "LOJA" ou "QUIOSQUE".
  const q = t.match(/\b(?:QUADRA|QD)\.?\s*([0-9A-Z]{1,6})\b|\bQ\.?\s*(\d[0-9A-Z]{0,5})\b/);
  const l = t.match(/\b(?:LOTE|LT)\.?\s*([0-9A-Z]{1,6})\b|\bL\.?\s*(\d[0-9A-Z]{0,5})\b/);
  const limpa = (m: RegExpMatchArray | null) => (m ? (m[1] ?? m[2])!.replace(/^0+(?=\d)/, '') : null);
  return { quadra: limpa(q), lote: limpa(l) };
}

/** Nome de bairro ou localidade para casar textos (cadastro x malha x Sinan). */
export function normalizarNome(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
