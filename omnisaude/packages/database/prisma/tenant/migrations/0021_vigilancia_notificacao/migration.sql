-- VIG-1a: notificação compulsória a partir do atendimento (Anexo V da PRC GM/MS nº 4/2017)
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'VIGILANCIA_EPIDEMIOLOGICA';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'NUCLEO_VIGILANCIA';
ALTER TYPE "UnitType" ADD VALUE IF NOT EXISTS 'VIGILANCIA_SAUDE';

CREATE TYPE "ListScope" AS ENUM ('NACIONAL', 'ESTADUAL', 'MUNICIPAL');
CREATE TYPE "DiseaseContext" AS ENUM ('CASO', 'OBITO', 'GESTANTE', 'ANOMALIA_CONGENITA', 'OUTRO');
CREATE TYPE "NotifyOn" AS ENUM ('SUSPEITA', 'CONFIRMACAO');
CREATE TYPE "DeadlineStart" AS ENUM ('ATENDIMENTO', 'CONHECIMENTO', 'CONFIRMACAO');
CREATE TYPE "NormativeStatus" AS ENUM ('VIGENTE', 'EM_REVISAO');
CREATE TYPE "CodeMapStatus" AS ENUM ('PROPOSTO', 'HOMOLOGADO', 'INATIVO');
CREATE TYPE "NotificationStatus" AS ENUM ('RASCUNHO', 'NOTIFICADA', 'DESCARTADA');
CREATE TYPE "NotificationOrigin" AS ENUM ('ATENDIMENTO', 'OBITO', 'INTERNACAO', 'MANUAL', 'VACINA', 'VARREDURA');
CREATE TYPE "NotificationBasis" AS ENUM ('SUSPEITA', 'CONFIRMADO');
CREATE TYPE "Sphere" AS ENUM ('SMS', 'SES', 'MS');
CREATE TYPE "CommChannel" AS ENUM ('SISTEMA', 'TELEFONE', 'EMAIL', 'FORMULARIO', 'PRESENCIAL', 'OUTRO');
CREATE TYPE "DeadlineKind" AS ENUM ('IMEDIATA', 'SEMANAL');

CREATE TABLE "notifiable_list_versions" (
  "id" UUID NOT NULL,
  "scope" "ListScope" NOT NULL,
  "scope_key" TEXT NOT NULL,
  "national_id" TEXT,
  "uf" CHAR(2),
  "ibge_code" CHAR(7),
  "act" TEXT NOT NULL,
  "published_in" TEXT,
  "act_url" TEXT,
  "source_url" TEXT,
  "source_sha256" CHAR(64),
  "consulted_at" DATE,
  "valid_from" DATE NOT NULL,
  "valid_to" DATE,
  "notes" TEXT,
  "created_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifiable_list_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notifiable_list_versions_national_id_key" ON "notifiable_list_versions"("national_id");
CREATE UNIQUE INDEX "notifiable_list_versions_scope_key_valid_from_key" ON "notifiable_list_versions"("scope_key", "valid_from");

CREATE TABLE "notifiable_conditions" (
  "id" UUID NOT NULL,
  "version_id" UUID NOT NULL,
  "key" VARCHAR(60) NOT NULL,
  "group_key" VARCHAR(40) NOT NULL,
  "item" INTEGER NOT NULL,
  "subitem" CHAR(1),
  "name" TEXT NOT NULL,
  "context" "DiseaseContext" NOT NULL,
  "immediate_ms" BOOLEAN NOT NULL,
  "immediate_ses" BOOLEAN NOT NULL,
  "immediate_sms" BOOLEAN NOT NULL,
  "weekly" BOOLEAN NOT NULL,
  "notify_on" "NotifyOn" NOT NULL,
  "deadline_start" "DeadlineStart" NOT NULL,
  "sensitive" BOOLEAN NOT NULL DEFAULT false,
  "once" BOOLEAN NOT NULL DEFAULT false,
  "normative_status" "NormativeStatus" NOT NULL DEFAULT 'VIGENTE',
  "normative_note" TEXT,
  "sinan_code" VARCHAR(5),
  "active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "notifiable_conditions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notifiable_conditions_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "notifiable_list_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- Uma única periodicidade por linha: semanal ou imediata para ao menos uma esfera.
  CONSTRAINT "notifiable_conditions_periodicidade" CHECK ((weekly AND NOT (immediate_ms OR immediate_ses OR immediate_sms)) OR (NOT weekly AND (immediate_ms OR immediate_ses OR immediate_sms)))
);
CREATE UNIQUE INDEX "notifiable_conditions_version_id_key_key" ON "notifiable_conditions"("version_id", "key");
CREATE INDEX "notifiable_conditions_group_key_idx" ON "notifiable_conditions"("group_key");

CREATE TABLE "notifiable_code_maps" (
  "id" UUID NOT NULL,
  "system" "CodeSystem" NOT NULL,
  "code_prefix" VARCHAR(5) NOT NULL,
  "group_key" VARCHAR(40) NOT NULL,
  "context" "DiseaseContext",
  "status" "CodeMapStatus" NOT NULL DEFAULT 'PROPOSTO',
  "source" TEXT NOT NULL,
  "homologated_by" UUID,
  "homologated_at" TIMESTAMP(3),
  "created_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notifiable_code_maps_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notifiable_code_maps_system_code_prefix_group_key_key" ON "notifiable_code_maps"("system", "code_prefix", "group_key");

CREATE TABLE "notifications" (
  "id" UUID NOT NULL,
  "year" INTEGER NOT NULL,
  "seq" INTEGER NOT NULL,
  "number" TEXT NOT NULL,
  "status" "NotificationStatus" NOT NULL DEFAULT 'RASCUNHO',
  "origin" "NotificationOrigin" NOT NULL,
  "condition_id" UUID NOT NULL,
  "condition_key" VARCHAR(60) NOT NULL,
  "group_key" VARCHAR(40) NOT NULL,
  "basis" "NotificationBasis" NOT NULL DEFAULT 'SUSPEITA',
  "code_system" "CodeSystem",
  "code" VARCHAR(6),
  "map_status" "CodeMapStatus",
  "patient_id" UUID NOT NULL,
  "encounter_id" UUID,
  "note_id" UUID,
  "admission_id" UUID,
  "vaccination_id" UUID,
  "related_notification_id" UUID,
  "unit_id" UUID NOT NULL,
  "notifier_id" UUID NOT NULL,
  "notifier_cbo" CHAR(6),
  "notifier_role" "Role" NOT NULL,
  "first_care_at" TIMESTAMP(3),
  "known_at" TIMESTAMP(3) NOT NULL,
  "confirmed_at" TIMESTAMP(3),
  "deadline_start" "DeadlineStart" NOT NULL,
  "deadline_kind" "DeadlineKind" NOT NULL,
  "targets" "Sphere"[],
  "deadline_start_at" TIMESTAMP(3),
  "due_at" TIMESTAMP(3),
  "notified_at" TIMESTAMP(3),
  "symptoms_onset" DATE,
  "epi_week_notified" CHAR(6),
  "epi_week_onset" CHAR(6),
  "sensitive" BOOLEAN NOT NULL DEFAULT false,
  "form" JSONB NOT NULL DEFAULT '{}',
  "residence_ibge" CHAR(7),
  "residence_lat" DOUBLE PRECISION,
  "residence_lng" DOUBLE PRECISION,
  "out_of_municipality" BOOLEAN NOT NULL DEFAULT false,
  "sms_received_at" TIMESTAMP(3),
  "sms_received_by" UUID,
  "escalated_at" TIMESTAMP(3),
  "overdue_at" TIMESTAMP(3),
  "discard_reason" TEXT,
  "discarded_by" UUID,
  "discarded_at" TIMESTAMP(3),
  "created_by" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notifications_condition_id_fkey" FOREIGN KEY ("condition_id") REFERENCES "notifiable_conditions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "notifications_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "notifications_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "notifications_related_notification_id_fkey" FOREIGN KEY ("related_notification_id") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "notifications_number_key" ON "notifications"("number");
CREATE UNIQUE INDEX "notifications_year_seq_key" ON "notifications"("year", "seq");
CREATE INDEX "notifications_status_due_at_idx" ON "notifications"("status", "due_at");
CREATE INDEX "notifications_patient_id_group_key_created_at_idx" ON "notifications"("patient_id", "group_key", "created_at");
CREATE INDEX "notifications_unit_id_status_idx" ON "notifications"("unit_id", "status");
CREATE INDEX "notifications_notifier_id_created_at_idx" ON "notifications"("notifier_id", "created_at");
-- O gatilho não duplica: um rascunho ativo por atendimento e agravo.
CREATE UNIQUE INDEX "notifications_encounter_condition_ativa" ON "notifications"("encounter_id", "condition_key") WHERE "encounter_id" IS NOT NULL AND "status" <> 'DESCARTADA';

CREATE TABLE "notification_events" (
  "id" UUID NOT NULL,
  "notification_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "user_id" UUID,
  "data" JSONB,
  "notes" TEXT,
  CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_events_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "notification_events_notification_id_at_idx" ON "notification_events"("notification_id", "at");

CREATE TABLE "notification_communications" (
  "id" UUID NOT NULL,
  "notification_id" UUID NOT NULL,
  "target" "Sphere" NOT NULL,
  "channel" "CommChannel" NOT NULL,
  "communicated_at" TIMESTAMP(3) NOT NULL,
  "counterpart_name" TEXT NOT NULL,
  "counterpart_org" TEXT,
  "contact_id" UUID,
  "contact_value" TEXT,
  "protocol" TEXT,
  "notes" TEXT,
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_communications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_communications_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "notification_communications_notification_id_target_idx" ON "notification_communications"("notification_id", "target");

CREATE TABLE "surveillance_contacts" (
  "id" UUID NOT NULL,
  "sphere" "Sphere" NOT NULL,
  "label" TEXT NOT NULL,
  "phone" TEXT,
  "email" TEXT,
  "form_url" TEXT,
  "hours" TEXT,
  "on_call" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sort" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "surveillance_contacts_pkey" PRIMARY KEY ("id")
);
