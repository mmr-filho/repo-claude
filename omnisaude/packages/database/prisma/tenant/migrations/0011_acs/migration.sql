-- App do ACS: papel de agente comunitário, visitas domiciliares e operações sincronizadas do campo.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ACS';

CREATE TABLE "home_visits" (
  "id" UUID NOT NULL,
  "client_id" TEXT,
  "unit_id" UUID NOT NULL,
  "team_id" UUID,
  "professional_id" UUID NOT NULL,
  "cbo" CHAR(6) NOT NULL,
  "household_id" UUID,
  "patient_id" UUID,
  "visited_at" TIMESTAMP(3) NOT NULL,
  "turno" INTEGER NOT NULL,
  "outcome" CHAR(1) NOT NULL,
  "reasons" TEXT[],
  "shared" BOOLEAN NOT NULL DEFAULT false,
  "out_of_area" BOOLEAN NOT NULL DEFAULT false,
  "micro_area" TEXT,
  "property_type" CHAR(2) NOT NULL DEFAULT '01',
  "weight_kg" DECIMAL(5,2),
  "height_cm" INTEGER,
  "systolic" INTEGER,
  "diastolic" INTEGER,
  "temperature" DECIMAL(4,1),
  "glucose" INTEGER,
  "glucose_type" INTEGER,
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "notes" TEXT,
  "recorded_at" TIMESTAMP(3) NOT NULL,
  "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "home_visits_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "home_visits_client_id_key" ON "home_visits"("client_id");
CREATE INDEX "home_visits_unit_id_visited_at_idx" ON "home_visits"("unit_id", "visited_at");
CREATE INDEX "home_visits_patient_id_visited_at_idx" ON "home_visits"("patient_id", "visited_at");
CREATE INDEX "home_visits_household_id_visited_at_idx" ON "home_visits"("household_id", "visited_at");
CREATE INDEX "home_visits_professional_id_visited_at_idx" ON "home_visits"("professional_id", "visited_at");
ALTER TABLE "home_visits" ADD CONSTRAINT "home_visits_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "home_visits" ADD CONSTRAINT "home_visits_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "field_sync_ops" (
  "id" UUID NOT NULL,
  "client_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "user_id" UUID NOT NULL,
  "unit_id" UUID NOT NULL,
  "status" TEXT NOT NULL,
  "entity_type" TEXT,
  "entity_id" UUID,
  "error" TEXT,
  "recorded_at" TIMESTAMP(3) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "field_sync_ops_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "field_sync_ops_client_id_key" ON "field_sync_ops"("client_id");
CREATE INDEX "field_sync_ops_user_id_received_at_idx" ON "field_sync_ops"("user_id", "received_at");
