-- PLT-3 (semana 25): território único (localidade, bairro, quarteirão e imóvel) para ACS, ACE e vigilância, base
-- local de endereços do IBGE para geocodificação e precisão da posição do imóvel.

CREATE TYPE "TerritoryZone" AS ENUM ('URBANA', 'RURAL', 'PERIURBANA');
CREATE TYPE "GeoPrecision" AS ENUM ('GPS_CAMPO', 'MAPA', 'ENDERECO', 'FACE', 'LOGRADOURO', 'QUARTEIRAO', 'LOCALIDADE', 'SETOR', 'CEP', 'MUNICIPIO');

CREATE TABLE localities (
  id uuid PRIMARY KEY,
  code varchar(8) NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'CIDADE',
  zone "TerritoryZone" NOT NULL DEFAULT 'URBANA',
  status text NOT NULL DEFAULT 'ATIVA',
  geometry jsonb,
  min_lng double precision,
  min_lat double precision,
  max_lng double precision,
  max_lat double precision,
  center_lat double precision,
  center_lng double precision,
  source text NOT NULL DEFAULT 'MANUAL',
  notes text,
  created_by uuid,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL
);
-- Código único no município entre as localidades ativas (cadastro de localidades do DATASUS).
CREATE UNIQUE INDEX localities_codigo_ativa ON localities (code) WHERE status = 'ATIVA';

CREATE TABLE neighborhoods (
  id uuid PRIMARY KEY,
  locality_id uuid NOT NULL REFERENCES localities(id),
  name text NOT NULL,
  code varchar(20),
  official boolean NOT NULL DEFAULT false,
  aliases text[] NOT NULL DEFAULT '{}',
  geometry jsonb,
  min_lng double precision,
  min_lat double precision,
  max_lng double precision,
  max_lat double precision,
  center_lat double precision,
  center_lng double precision,
  active boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'MANUAL',
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL
);
CREATE INDEX neighborhoods_locality_id_idx ON neighborhoods (locality_id);
CREATE UNIQUE INDEX neighborhoods_nome_ativo ON neighborhoods (locality_id, upper(name)) WHERE active;

CREATE TABLE blocks (
  id uuid PRIMARY KEY,
  locality_id uuid NOT NULL REFERENCES localities(id),
  neighborhood_id uuid REFERENCES neighborhoods(id),
  number varchar(10) NOT NULL,
  geometry jsonb NOT NULL,
  min_lng double precision NOT NULL,
  min_lat double precision NOT NULL,
  max_lng double precision NOT NULL,
  max_lat double precision NOT NULL,
  center_lat double precision NOT NULL,
  center_lng double precision NOT NULL,
  area_m2 double precision NOT NULL,
  source text NOT NULL DEFAULT 'EDITOR',
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  updated_by uuid,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL
);
CREATE INDEX blocks_locality_id_number_idx ON blocks (locality_id, number);
CREATE INDEX blocks_min_lng_max_lng_min_lat_max_lat_idx ON blocks (min_lng, max_lng, min_lat, max_lat);

ALTER TABLE households
  ADD COLUMN block_id uuid REFERENCES blocks(id),
  ADD COLUMN rg_sequence varchar(12),
  ADD COLUMN zone "TerritoryZone",
  ADD COLUMN geo_precision "GeoPrecision",
  ADD COLUMN geo_source text,
  ADD COLUMN geo_accuracy_m double precision,
  ADD COLUMN geo_at timestamp(3);
CREATE INDEX households_block_id_idx ON households (block_id);
CREATE INDEX households_latitude_longitude_idx ON households (latitude, longitude);
-- Posições já gravadas vieram do GPS do app do ACS (APS-3) ou do cadastro.
UPDATE households SET geo_precision = 'GPS_CAMPO', geo_source = 'legado', geo_at = updated_at WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

ALTER TABLE notifications ADD COLUMN residence_precision "GeoPrecision";

CREATE TABLE address_points (
  id uuid PRIMARY KEY,
  source text NOT NULL DEFAULT 'CNEFE2022',
  external_id text NOT NULL,
  ibge_code varchar(7) NOT NULL,
  sector varchar(16),
  quadra varchar(6),
  face varchar(6),
  cep char(8),
  locality text,
  street text NOT NULL,
  street_key text NOT NULL,
  number text,
  complement text,
  quadra_key text,
  lote_key text,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  level integer NOT NULL,
  species integer
);
CREATE UNIQUE INDEX address_points_source_external_id_key ON address_points (source, external_id);
CREATE INDEX address_points_street_key_number_idx ON address_points (street_key, number);
CREATE INDEX address_points_quadra_key_lote_key_idx ON address_points (quadra_key, lote_key);
CREATE INDEX address_points_cep_idx ON address_points (cep);

CREATE TABLE territory_imports (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  file_name text NOT NULL,
  crs text,
  status text NOT NULL DEFAULT 'PREVIA',
  storage_key text,
  summary jsonb NOT NULL,
  result jsonb,
  created_by uuid NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_by uuid,
  applied_at timestamp(3)
);
CREATE INDEX territory_imports_created_at_idx ON territory_imports (created_at);
