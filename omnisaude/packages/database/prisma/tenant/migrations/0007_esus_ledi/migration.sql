-- ─────────────────────────────────────────────────────────────────────────────
-- e-SUS APS: lotes e fichas do LEDI (Thrift) geradas a partir dos registros e enviadas ao PEC
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "EsusBatchStatus" AS ENUM ('GERADO', 'ENVIANDO', 'ENVIADO', 'PARCIAL', 'ERRO');
CREATE TYPE "EsusRecordStatus" AS ENUM ('GERADA', 'INVALIDA', 'ENVIADA', 'ACEITA', 'REJEITADA');

CREATE TABLE "esus_batches" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "EsusBatchStatus" NOT NULL DEFAULT 'GERADO',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    "last_error" TEXT,

    CONSTRAINT "esus_batches_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "esus_batches_unit_id_created_at_idx" ON "esus_batches"("unit_id", "created_at");
ALTER TABLE "esus_batches" ADD CONSTRAINT "esus_batches_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "esus_batches" ADD CONSTRAINT "esus_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "esus_records" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "kind" INTEGER NOT NULL,
    "uuid" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "patient_id" UUID,
    "cnes" CHAR(7) NOT NULL,
    "ine" CHAR(10),
    "status" "EsusRecordStatus" NOT NULL DEFAULT 'GERADA',
    "issues" JSONB NOT NULL DEFAULT '[]',
    "payload" BYTEA,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "esus_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "esus_records_uuid_key" ON "esus_records"("uuid");
CREATE INDEX "esus_records_batch_id_status_idx" ON "esus_records"("batch_id", "status");
CREATE INDEX "esus_records_source_type_source_id_idx" ON "esus_records"("source_type", "source_id");
ALTER TABLE "esus_records" ADD CONSTRAINT "esus_records_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "esus_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
