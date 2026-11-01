-- CID-3: ouvidoria (manifestações com protocolo e prazo legal) e pesquisa de satisfação após o atendimento
CREATE TYPE "OmbudsmanKind" AS ENUM ('RECLAMACAO', 'DENUNCIA', 'SUGESTAO', 'ELOGIO', 'SOLICITACAO', 'INFORMACAO');
CREATE TYPE "OmbudsmanChannel" AS ENUM ('APP', 'WHATSAPP', 'PRESENCIAL', 'TELEFONE', 'SITE');
CREATE TYPE "OmbudsmanStatus" AS ENUM ('RECEBIDA', 'EM_ANALISE', 'PRORROGADA', 'RESPONDIDA', 'ENCERRADA', 'ARQUIVADA');
CREATE TYPE "SurveyStatus" AS ENUM ('PENDENTE', 'RESPONDIDA', 'EXPIRADA');

CREATE TABLE "ombudsman_cases" (
  "id" UUID NOT NULL,
  "protocol" TEXT NOT NULL,
  "kind" "OmbudsmanKind" NOT NULL,
  "channel" "OmbudsmanChannel" NOT NULL,
  "subject" TEXT NOT NULL,
  "unit_id" UUID,
  "patient_id" UUID,
  "anonymous" BOOLEAN NOT NULL DEFAULT false,
  "contact_name" TEXT,
  "contact_phone" TEXT,
  "text" TEXT NOT NULL,
  "status" "OmbudsmanStatus" NOT NULL DEFAULT 'RECEBIDA',
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "due_at" TIMESTAMP(3) NOT NULL,
  "extended_at" TIMESTAMP(3),
  "extension_reason" TEXT,
  "assigned_unit_id" UUID,
  "assigned_user_id" UUID,
  "response_text" TEXT,
  "responded_at" TIMESTAMP(3),
  "responded_by" UUID,
  "closed_at" TIMESTAMP(3),
  "rating" INTEGER,
  "rating_comment" TEXT,
  "rated_at" TIMESTAMP(3),
  "created_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ombudsman_cases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ombudsman_cases_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ombudsman_cases_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ombudsman_cases_protocol_key" ON "ombudsman_cases"("protocol");
CREATE INDEX "ombudsman_cases_status_due_at_idx" ON "ombudsman_cases"("status", "due_at");
CREATE INDEX "ombudsman_cases_patient_id_created_at_idx" ON "ombudsman_cases"("patient_id", "created_at");
CREATE INDEX "ombudsman_cases_unit_id_status_idx" ON "ombudsman_cases"("unit_id", "status");

CREATE TABLE "ombudsman_events" (
  "id" UUID NOT NULL,
  "case_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "notes" TEXT,
  "user_id" UUID,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ombudsman_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ombudsman_events_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "ombudsman_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ombudsman_events_case_id_at_idx" ON "ombudsman_events"("case_id", "at");

CREATE TABLE "satisfaction_surveys" (
  "id" UUID NOT NULL,
  "patient_id" UUID NOT NULL,
  "encounter_id" UUID,
  "unit_id" UUID NOT NULL,
  "professional_id" UUID,
  "status" "SurveyStatus" NOT NULL DEFAULT 'PENDENTE',
  "channel" TEXT,
  "sent_at" TIMESTAMP(3),
  "answered_at" TIMESTAMP(3),
  "score" INTEGER,
  "recommend" INTEGER,
  "comment" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "satisfaction_surveys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "satisfaction_surveys_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "satisfaction_surveys_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "satisfaction_surveys_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "satisfaction_surveys_encounter_id_key" ON "satisfaction_surveys"("encounter_id");
CREATE INDEX "satisfaction_surveys_unit_id_created_at_idx" ON "satisfaction_surveys"("unit_id", "created_at");
CREATE INDEX "satisfaction_surveys_patient_id_status_idx" ON "satisfaction_surveys"("patient_id", "status");
