-- Regulação ambulatorial: solicitações a partir do atendimento, fila única, histórico (devolutiva) e anexos.
CREATE TYPE "RegulationKind" AS ENUM ('CONSULTA', 'EXAME', 'PROCEDIMENTO');
CREATE TYPE "RegulationPriority" AS ENUM ('VERMELHA', 'AMARELA', 'VERDE', 'AZUL');
CREATE TYPE "RegulationStatus" AS ENUM ('PENDENTE', 'EM_ANALISE', 'DEVOLVIDA', 'AUTORIZADA', 'AGENDADA', 'NEGADA', 'CANCELADA', 'REALIZADA');

CREATE TABLE "regulation_requests" (
  "id" UUID NOT NULL,
  "protocol" TEXT NOT NULL,
  "kind" "RegulationKind" NOT NULL,
  "specialty" TEXT NOT NULL,
  "procedure_code" CHAR(10) NOT NULL,
  "procedure_name" TEXT NOT NULL,
  "patient_id" UUID NOT NULL,
  "encounter_id" UUID,
  "unit_id" UUID NOT NULL,
  "requester_id" UUID NOT NULL,
  "requester_cbo" CHAR(6) NOT NULL,
  "priority" "RegulationPriority" NOT NULL,
  "priority_justification" TEXT,
  "clinical_summary" TEXT NOT NULL,
  "criteria" TEXT[],
  "cid" VARCHAR(5),
  "protocol_issues" TEXT[],
  "status" "RegulationStatus" NOT NULL DEFAULT 'PENDENTE',
  "requested_priority" "RegulationPriority" NOT NULL,
  "regulator_id" UUID,
  "decision_at" TIMESTAMP(3),
  "decision_reason" TEXT,
  "provider_unit_id" UUID,
  "appointment_id" UUID,
  "returned_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "closed_at" TIMESTAMP(3),
  CONSTRAINT "regulation_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "regulation_requests_protocol_key" ON "regulation_requests"("protocol");
CREATE INDEX "regulation_requests_status_priority_created_at_idx" ON "regulation_requests"("status", "priority", "created_at");
CREATE INDEX "regulation_requests_unit_id_status_idx" ON "regulation_requests"("unit_id", "status");
CREATE INDEX "regulation_requests_patient_id_created_at_idx" ON "regulation_requests"("patient_id", "created_at");
CREATE INDEX "regulation_requests_specialty_status_idx" ON "regulation_requests"("specialty", "status");
ALTER TABLE "regulation_requests" ADD CONSTRAINT "regulation_requests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "regulation_events" (
  "id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "from_status" "RegulationStatus",
  "to_status" "RegulationStatus",
  "user_id" UUID NOT NULL,
  "role" "Role" NOT NULL,
  "notes" TEXT,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "regulation_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "regulation_events_request_id_at_idx" ON "regulation_events"("request_id", "at");
ALTER TABLE "regulation_events" ADD CONSTRAINT "regulation_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "regulation_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "regulation_attachments" (
  "id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "label" TEXT,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "regulation_attachments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "regulation_attachments_request_id_document_id_key" ON "regulation_attachments"("request_id", "document_id");
ALTER TABLE "regulation_attachments" ADD CONSTRAINT "regulation_attachments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "regulation_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
