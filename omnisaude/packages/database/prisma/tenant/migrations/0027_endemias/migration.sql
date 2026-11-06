-- VIG-3a (semana 26): agente de combate às endemias em campo, zonas de trabalho, visita ao imóvel com depósitos,
-- focos, amostras e tratamento focal (baixa do larvicida por lote), e a ordem de bloqueio de transmissão aberta pelas
-- notificações de dengue, chikungunya e Zika. Os valores novos dos enums só são usados depois desta migração.

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ACE';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPERVISOR_ENDEMIAS';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'COORDENADOR_ENDEMIAS';
ALTER TYPE "StockLocationKind" ADD VALUE IF NOT EXISTS 'ENDEMIAS';
ALTER TYPE "MovementKind" ADD VALUE IF NOT EXISTS 'TRATAMENTO_FOCAL';
ALTER TYPE "MovementKind" ADD VALUE IF NOT EXISTS 'ENTRADA_REMESSA';

CREATE TYPE "VectorControlKind" AS ENUM ('LARVICIDA', 'ADULTICIDA');
CREATE TYPE "VectorActivity" AS ENUM ('LI_T', 'LI', 'T', 'BLOQUEIO', 'PE', 'DF', 'PVE');
CREATE TYPE "VectorVisitSituation" AS ENUM ('TRABALHADO', 'FECHADO', 'RECUSADO', 'ABANDONADO');
CREATE TYPE "BlockingOrderStatus" AS ENUM ('AGUARDANDO_LOCALIZACAO', 'ABERTA', 'EM_CAMPO', 'CONCLUIDA', 'CANCELADA');
CREATE TYPE "TreatmentStockStatus" AS ENUM ('BAIXADO', 'PENDENTE', 'REGULARIZADO', 'CANCELADO');

ALTER TABLE products ADD COLUMN vector_control "VectorControlKind";

CREATE TABLE vector_zones (
  id uuid PRIMARY KEY,
  unit_id uuid NOT NULL REFERENCES units(id),
  name text NOT NULL,
  ace_id uuid REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL
);
CREATE INDEX vector_zones_ace_id_idx ON vector_zones (ace_id);
-- Nome único entre as zonas ativas da unidade.
CREATE UNIQUE INDEX vector_zones_nome_ativo ON vector_zones (unit_id, upper(name)) WHERE active;

CREATE TABLE vector_zone_blocks (
  zone_id uuid NOT NULL REFERENCES vector_zones(id) ON DELETE CASCADE,
  block_id uuid NOT NULL REFERENCES blocks(id),
  PRIMARY KEY (zone_id, block_id)
);
-- Um quarteirão pertence a uma zona só.
CREATE UNIQUE INDEX vector_zone_blocks_block_id_key ON vector_zone_blocks (block_id);

CREATE TABLE blocking_orders (
  id uuid PRIMARY KEY,
  year integer NOT NULL,
  seq integer NOT NULL,
  status "BlockingOrderStatus" NOT NULL,
  radius_m integer NOT NULL,
  groups text[] NOT NULL DEFAULT '{}',
  needs_check boolean NOT NULL DEFAULT false,
  opened_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  opened_by uuid,
  started_at timestamp(3),
  concluded_at timestamp(3),
  concluded_by uuid,
  conclusion_note text,
  cancelled_at timestamp(3),
  cancelled_by uuid,
  cancel_reason text,
  merged_into_id uuid REFERENCES blocking_orders(id),
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL
);
CREATE UNIQUE INDEX blocking_orders_year_seq_key ON blocking_orders (year, seq);
CREATE INDEX blocking_orders_status_idx ON blocking_orders (status);

CREATE TABLE blocking_order_cases (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES blocking_orders(id),
  notification_id uuid NOT NULL REFERENCES notifications(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  household_id uuid REFERENCES households(id),
  group_key varchar(40) NOT NULL,
  condition_key varchar(60) NOT NULL,
  lat double precision,
  lng double precision,
  precision "GeoPrecision",
  block_id uuid REFERENCES blocks(id),
  reference_date date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  linked_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unlinked_at timestamp(3),
  unlink_reason text
);
-- Uma notificação fica numa ordem só.
CREATE UNIQUE INDEX blocking_order_cases_notification_id_key ON blocking_order_cases (notification_id);
CREATE INDEX blocking_order_cases_order_id_idx ON blocking_order_cases (order_id);

CREATE TABLE blocking_order_blocks (
  order_id uuid NOT NULL REFERENCES blocking_orders(id) ON DELETE CASCADE,
  block_id uuid NOT NULL REFERENCES blocks(id),
  distance_m double precision NOT NULL,
  added_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (order_id, block_id)
);
CREATE INDEX blocking_order_blocks_block_id_idx ON blocking_order_blocks (block_id);

CREATE TABLE blocking_order_assignees (
  order_id uuid NOT NULL REFERENCES blocking_orders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  assigned_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_by uuid,
  PRIMARY KEY (order_id, user_id)
);
CREATE INDEX blocking_order_assignees_user_id_idx ON blocking_order_assignees (user_id);

CREATE TABLE vector_visits (
  id uuid PRIMARY KEY,
  client_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  unit_id uuid NOT NULL REFERENCES units(id),
  cbo char(6) NOT NULL,
  household_id uuid NOT NULL REFERENCES households(id),
  block_id uuid REFERENCES blocks(id),
  property_type char(2) NOT NULL,
  micro_area text,
  order_id uuid REFERENCES blocking_orders(id),
  activity "VectorActivity" NOT NULL,
  situation "VectorVisitSituation" NOT NULL,
  recovery boolean NOT NULL DEFAULT false,
  cycle varchar(7) NOT NULL,
  visited_at timestamp(3) NOT NULL,
  turno integer NOT NULL,
  synced_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deposits jsonb,
  deposits_inspected integer NOT NULL DEFAULT 0,
  deposits_positive integer NOT NULL DEFAULT 0,
  deposits_eliminated integer NOT NULL DEFAULT 0,
  deposits_treated integer NOT NULL DEFAULT 0,
  samples jsonb,
  samples_count integer NOT NULL DEFAULT 0,
  ubv text,
  education boolean NOT NULL DEFAULT false,
  latitude double precision,
  longitude double precision,
  accuracy_m double precision,
  notes text,
  CONSTRAINT vector_visits_contagens CHECK (deposits_positive <= deposits_inspected AND deposits_eliminated + deposits_treated <= deposits_inspected),
  CONSTRAINT vector_visits_ubv CHECK (ubv IS NULL OR ubv IN ('INTRA', 'PERI', 'INTRA_PERI'))
);
-- Idempotência da sincronização do app de campo.
CREATE UNIQUE INDEX vector_visits_client_id_key ON vector_visits (client_id);
CREATE INDEX vector_visits_household_id_visited_at_idx ON vector_visits (household_id, visited_at);
CREATE INDEX vector_visits_user_id_visited_at_idx ON vector_visits (user_id, visited_at);
CREATE INDEX vector_visits_unit_id_visited_at_idx ON vector_visits (unit_id, visited_at);
CREATE INDEX vector_visits_block_id_visited_at_idx ON vector_visits (block_id, visited_at);
CREATE INDEX vector_visits_order_id_idx ON vector_visits (order_id);

CREATE TABLE vector_treatments (
  id uuid PRIMARY KEY,
  visit_id uuid NOT NULL REFERENCES vector_visits(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id),
  lot_id uuid REFERENCES stock_lots(id),
  lot_number text,
  quantity decimal(12, 3) NOT NULL CHECK (quantity > 0),
  deposits integer NOT NULL CHECK (deposits > 0),
  location_id uuid REFERENCES stock_locations(id),
  stock_status "TreatmentStockStatus" NOT NULL,
  pending_reason text,
  expired_at_use boolean NOT NULL DEFAULT false,
  movement_id uuid,
  resolved_by uuid,
  resolved_at timestamp(3),
  resolution text,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX vector_treatments_visit_id_seq_key ON vector_treatments (visit_id, seq);
CREATE INDEX vector_treatments_stock_status_idx ON vector_treatments (stock_status);

CREATE TABLE vector_stock_receipts (
  id uuid PRIMARY KEY,
  location_id uuid NOT NULL REFERENCES stock_locations(id),
  product_id uuid NOT NULL REFERENCES products(id),
  lot_id uuid NOT NULL REFERENCES stock_lots(id),
  quantity decimal(12, 3) NOT NULL CHECK (quantity > 0),
  document text NOT NULL,
  origin text NOT NULL,
  notes text,
  received_by uuid NOT NULL,
  received_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- A mesma guia não entra duas vezes para o mesmo lote.
CREATE UNIQUE INDEX vector_stock_receipts_document_lot_id_key ON vector_stock_receipts (document, lot_id);

-- No máximo uma baixa (e um ajuste de regularização) por linha de tratamento, mesmo com reenvio concorrente.
CREATE UNIQUE INDEX stock_movements_tratamento_focal ON stock_movements (ref_id, kind) WHERE ref_type = 'TratamentoFocal';
