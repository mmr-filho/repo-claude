import type { PrecisaoGeo } from '@omnisaude/shared';

export type Geometria = { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };

export interface CamadasMapa {
  localidades: { id: string; code: string; name: string; category: string; zone: string; geometry: Geometria | null; centerLat: number | null; centerLng: number | null }[];
  bairros: { id: string; localityId: string; name: string; official: boolean; geometry: Geometria | null }[];
  quarteiroes: { id: string; localityId: string; neighborhoodId: string | null; number: string; geometry: Geometria; centerLat: number; centerLng: number; areaM2: number; imoveis: number }[];
  /** campo: o usuário pode marcar a posição (quem edita o território, ou o ACS na sua equipe e microárea). */
  imoveis: { id: string; lat: number; lng: number; precisao: PrecisaoGeo | null; blockId: string | null; sequencia: string | null; endereco: string; tipo: string | null; campo: boolean }[];
  limitado: boolean;
}

export interface ResumoTerritorio {
  localidades: number;
  bairros: number;
  quarteiroes: number;
  imoveis: number;
  semPosicao: number;
  semQuarteirao: number;
  porPrecisao: Record<string, number>;
  baseDeEnderecos: number;
  ultimaImportacao: { kind: string; fileName: string; appliedAt: string } | null;
  config: { numeracaoQuarteirao: 'LOCALIDADE' | 'BAIRRO'; raioBloqueioM: number };
}

export interface QuarteiraoNoRaio {
  id: string;
  numero: string;
  distanciaM: number;
  localidade: { id: string; code: string; name: string } | null;
  bairro: string | null;
  imoveis: number;
}

export interface Localidade {
  id: string;
  code: string;
  name: string;
  category: string;
  zone: string;
  status: string;
  source: string;
  notes: string | null;
  _count: { blocks: number; neighborhoods: number };
}

export interface Bairro {
  id: string;
  localityId: string;
  name: string;
  code: string | null;
  official: boolean;
  aliases: string[];
  _count: { blocks: number };
}

export interface ImovelPendente {
  id: string;
  endereco: string;
  district: string | null;
  cep: string | null;
  propertyType: string | null;
  geoPrecision: PrecisaoGeo | null;
  precisaoLabel: string | null;
  geoSource: string | null;
  blockId: string | null;
  rgSequence: string | null;
  microArea: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Cor do imóvel pela precisão da posição (verde: serve ao bloqueio; âmbar: com aviso; vermelho: confirmar em campo). */
export const COR_PRECISAO: Record<string, string> = {
  GPS_CAMPO: '#059669',
  MAPA: '#059669',
  ENDERECO: '#0d9488',
  FACE: '#d97706',
  QUARTEIRAO: '#d97706',
  LOGRADOURO: '#dc2626',
  LOCALIDADE: '#dc2626',
  SETOR: '#dc2626',
  CEP: '#dc2626',
  MUNICIPIO: '#dc2626',
};
