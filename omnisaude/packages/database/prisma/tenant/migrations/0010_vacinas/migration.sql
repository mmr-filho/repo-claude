-- Vacinas: sala de vacina, estoque por lote, códigos do e-SUS/RNDS e aprazamento.
ALTER TYPE "StockLocationKind" ADD VALUE IF NOT EXISTS 'SALA_DE_VACINA';
ALTER TABLE "products" ADD COLUMN "vaccine_code" TEXT;
ALTER TABLE "vaccinations"
  ADD COLUMN "encounter_id" UUID,
  ADD COLUMN "manufacturer_code" TEXT,
  ADD COLUMN "expiry" DATE,
  ADD COLUMN "lot_id" UUID,
  ADD COLUMN "location_id" UUID,
  ADD COLUMN "dose_code" TEXT,
  ADD COLUMN "route_code" TEXT,
  ADD COLUMN "site_code" TEXT,
  ADD COLUMN "strategy_code" TEXT,
  ADD COLUMN "transcription" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "next_due_at" DATE;
CREATE INDEX "vaccinations_unit_id_applied_at_idx" ON "vaccinations"("unit_id", "applied_at");
