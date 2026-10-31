-- REG-7: regulação de leitos da rede (solicitação de vaga, reserva de leito, transferência) e AIH (laudo, autorização, faixas numéricas).
ALTER TYPE "BedStatus" ADD VALUE IF NOT EXISTS 'RESERVADO';
CREATE TYPE "BedRequestStatus" AS ENUM ('PENDENTE', 'EM_ANALISE', 'DEVOLVIDA', 'AUTORIZADA', 'EM_TRANSFERENCIA', 'INTERNADA', 'NEGADA', 'CANCELADA');
CREATE TYPE "AihStatus" AS ENUM ('PENDENTE', 'AUTORIZADA', 'NEGADA', 'CANCELADA');

CREATE TABLE "bed_requests" (
  "id" UUID NOT NULL,
  "protocol" TEXT NOT NULL,
  "patient_id" UUID NOT NULL,
  "encounter_id" UUID,
  "origin_unit_id" UUID NOT NULL,
  "requester_id" UUID NOT NULL,
  "requester_cbo" CHAR(6) NOT NULL,
  "bed_kind" "WardKind" NOT NULL,
  "specialty" TEXT NOT NULL,
  "priority" "RegulationPriority" NOT NULL,
  "requested_priority" "RegulationPriority" NOT NULL,
  "cid" VARCHAR(5),
  "clinical_summary" TEXT NOT NULL,
  "vitals" JSONB,
  "support" JSONB NOT NULL DEFAULT '{}',
  "news2" INTEGER,
  "isolation" "Isolation" NOT NULL DEFAULT 'NENHUM',
  "elective" BOOLEAN NOT NULL DEFAULT false,
  "status" "BedRequestStatus" NOT NULL DEFAULT 'PENDENTE',
  "regulator_id" UUID,
  "decision_at" TIMESTAMP(3),
  "decision_reason" TEXT,
  "second_opinion_at" TIMESTAMP(3),
  "second_opinion_by" UUID,
  "second_opinion_notes" TEXT,
  "destination_unit_id" UUID,
  "destination_kind" "WardKind",
  "reserved_bed_id" UUID,
  "transport" TEXT,
  "transfer_at" TIMESTAMP(3),
  "transfer_notes" TEXT,
  "admission_id" UUID,
  "returned_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "closed_at" TIMESTAMP(3),
  CONSTRAINT "bed_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bed_requests_protocol_key" ON "bed_requests"("protocol");
CREATE UNIQUE INDEX "bed_requests_admission_id_key" ON "bed_requests"("admission_id");
CREATE INDEX "bed_requests_status_priority_created_at_idx" ON "bed_requests"("status", "priority", "created_at");
CREATE INDEX "bed_requests_patient_id_idx" ON "bed_requests"("patient_id");
CREATE INDEX "bed_requests_origin_unit_id_status_idx" ON "bed_requests"("origin_unit_id", "status");
CREATE INDEX "bed_requests_destination_unit_id_status_idx" ON "bed_requests"("destination_unit_id", "status");
ALTER TABLE "bed_requests" ADD CONSTRAINT "bed_requests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bed_requests" ADD CONSTRAINT "bed_requests_reserved_bed_id_fkey" FOREIGN KEY ("reserved_bed_id") REFERENCES "beds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "bed_requests" ADD CONSTRAINT "bed_requests_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "bed_request_events" (
  "id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "from_status" "BedRequestStatus",
  "to_status" "BedRequestStatus",
  "user_id" UUID NOT NULL,
  "role" "Role" NOT NULL,
  "notes" TEXT,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bed_request_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "bed_request_events_request_id_at_idx" ON "bed_request_events"("request_id", "at");
ALTER TABLE "bed_request_events" ADD CONSTRAINT "bed_request_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "bed_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "aih_ranges" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "unit_id" UUID,
  "uf" CHAR(2) NOT NULL,
  "year" INTEGER NOT NULL,
  "aih_type" CHAR(1) NOT NULL DEFAULT '1',
  "seq_start" INTEGER NOT NULL,
  "seq_end" INTEGER NOT NULL,
  "seq_next" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "aih_ranges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "aih_ranges_active_unit_id_idx" ON "aih_ranges"("active", "unit_id");

CREATE TABLE "aih_requests" (
  "id" UUID NOT NULL,
  "patient_id" UUID NOT NULL,
  "admission_id" UUID,
  "bed_request_id" UUID,
  "unit_id" UUID NOT NULL,
  "requester_id" UUID NOT NULL,
  "requester_cbo" CHAR(6) NOT NULL,
  "procedure_code" CHAR(10) NOT NULL,
  "procedure_name" TEXT NOT NULL,
  "main_cid" VARCHAR(5) NOT NULL,
  "secondary_cid" VARCHAR(5),
  "associated_cid" VARCHAR(5),
  "specialty_code" CHAR(2) NOT NULL,
  "nature" CHAR(2) NOT NULL,
  "symptoms" TEXT NOT NULL,
  "conditions" TEXT NOT NULL,
  "diagnostics" TEXT NOT NULL,
  "notes" TEXT,
  "status" "AihStatus" NOT NULL DEFAULT 'PENDENTE',
  "authorizer_id" UUID,
  "authorized_at" TIMESTAMP(3),
  "decision_notes" TEXT,
  "aih_number" CHAR(13),
  "aih_type" CHAR(1) NOT NULL DEFAULT '1',
  "range_id" UUID,
  "valid_until" DATE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "aih_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "aih_requests_admission_id_key" ON "aih_requests"("admission_id");
CREATE UNIQUE INDEX "aih_requests_aih_number_key" ON "aih_requests"("aih_number");
CREATE INDEX "aih_requests_status_created_at_idx" ON "aih_requests"("status", "created_at");
CREATE INDEX "aih_requests_patient_id_idx" ON "aih_requests"("patient_id");
CREATE INDEX "aih_requests_unit_id_status_idx" ON "aih_requests"("unit_id", "status");
ALTER TABLE "aih_requests" ADD CONSTRAINT "aih_requests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "aih_requests" ADD CONSTRAINT "aih_requests_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "aih_requests" ADD CONSTRAINT "aih_requests_bed_request_id_fkey" FOREIGN KEY ("bed_request_id") REFERENCES "bed_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "aih_requests" ADD CONSTRAINT "aih_requests_range_id_fkey" FOREIGN KEY ("range_id") REFERENCES "aih_ranges"("id") ON DELETE SET NULL ON UPDATE CASCADE;
