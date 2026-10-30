-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UnitType" AS ENUM ('UBS', 'UPA', 'POLICLINICA', 'HOSPITAL', 'CEO', 'SAMU', 'CAPS', 'FARMACIA_CENTRAL', 'ALMOXARIFADO', 'LABORATORIO');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('RECEPCAO', 'ENFERMAGEM', 'MEDICO', 'MULTIPROFISSIONAL', 'SERVICO_SOCIAL', 'NIR', 'FARMACIA', 'FATURAMENTO', 'GESTOR');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('M', 'F');

-- CreateEnum
CREATE TYPE "CodeSystem" AS ENUM ('CID10', 'CID11', 'CIAP2');

-- CreateEnum
CREATE TYPE "LineOfCare" AS ENUM ('HIPERTENSAO', 'DIABETES', 'GESTANTE', 'ONCOLOGIA', 'SAUDE_MENTAL', 'TUBERCULOSE', 'HANSENIASE');

-- CreateEnum
CREATE TYPE "AppointmentKind" AS ENUM ('PRIMEIRA_CONSULTA', 'RETORNO');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('AGENDADO', 'CONFIRMADO', 'CANCELADO', 'FALTOU', 'ATENDIDO', 'REMARCADO');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('AGUARDANDO', 'OFERTADO', 'AGENDADO', 'DESISTIU');

-- CreateEnum
CREATE TYPE "TicketKind" AS ENUM ('NORMAL', 'PRIORIDADE');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('AGUARDANDO', 'CHAMADA', 'EM_ATENDIMENTO', 'FINALIZADA', 'AUSENTE');

-- CreateEnum
CREATE TYPE "EncounterKind" AS ENUM ('AMBULATORIAL', 'URGENCIA', 'INTERNACAO', 'DOMICILIAR', 'ODONTOLOGICO');

-- CreateEnum
CREATE TYPE "EncounterStatus" AS ENUM ('ABERTO', 'TRIADO', 'EM_ATENDIMENTO', 'ENCERRADO', 'CANCELADO', 'EVADIU');

-- CreateEnum
CREATE TYPE "EncounterOutcome" AS ENUM ('ALTA', 'INTERNACAO', 'ENCAMINHAMENTO', 'TRANSFERENCIA', 'OBITO', 'EVASAO');

-- CreateEnum
CREATE TYPE "RiskColor" AS ENUM ('VERMELHO', 'LARANJA', 'AMARELO', 'VERDE', 'AZUL');

-- CreateEnum
CREATE TYPE "NoteKind" AS ENUM ('SOAP', 'EVOLUCAO', 'ODONTOGRAMA', 'LAUDO_INTERNACAO', 'ATESTADO', 'SUMARIO_ALTA');

-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('RASCUNHO', 'ASSINADO');

-- CreateEnum
CREATE TYPE "PrescriptionKind" AS ENUM ('AMBULATORIAL', 'HOSPITALAR');

-- CreateEnum
CREATE TYPE "PrescriptionStatus" AS ENUM ('ATIVA', 'SUSPENSA', 'ENCERRADA');

-- CreateEnum
CREATE TYPE "ExamStatus" AS ENUM ('SOLICITADO', 'COLETADO', 'RESULTADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "WardKind" AS ENUM ('CLINICA_MEDICA', 'CIRURGICA', 'UTI_ADULTO', 'UTI_PEDIATRICA', 'PEDIATRIA', 'OBSTETRICIA', 'OBSERVACAO');

-- CreateEnum
CREATE TYPE "BedStatus" AS ENUM ('VAGO', 'OCUPADO', 'HIGIENIZACAO', 'BLOQUEADO');

-- CreateEnum
CREATE TYPE "Isolation" AS ENUM ('NENHUM', 'CONTATO', 'GOTICULAS', 'AEROSSOIS');

-- CreateEnum
CREATE TYPE "ControlledList" AS ENUM ('A1', 'A2', 'A3', 'B1', 'B2', 'C1', 'C2', 'C3', 'C4', 'C5');

-- CreateEnum
CREATE TYPE "StockLocationKind" AS ENUM ('ALMOXARIFADO_CENTRAL', 'FARMACIA_CENTRAL', 'FARMACIA_SETORIAL', 'POSTO_ENFERMAGEM');

-- CreateEnum
CREATE TYPE "MovementKind" AS ENUM ('ENTRADA_NFE', 'TRANSFERENCIA_SAIDA', 'TRANSFERENCIA_ENTRADA', 'DISPENSACAO', 'ADMINISTRACAO', 'DEVOLUCAO', 'UNITARIZACAO_SAIDA', 'UNITARIZACAO_ENTRADA', 'AJUSTE', 'PERDA');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('SEPARACAO', 'EXPEDIDA', 'RECEBIDA', 'DIVERGENTE', 'CANCELADA');

-- CreateEnum
CREATE TYPE "UnitDoseStatus" AS ENUM ('DISPONIVEL', 'ADMINISTRADA', 'DEVOLVIDA', 'DESCARTADA');

-- CreateEnum
CREATE TYPE "AdministrationStatus" AS ENUM ('ADMINISTRADO', 'BLOQUEADO', 'RECUSADO_PACIENTE');

-- CreateEnum
CREATE TYPE "PopKind" AS ENUM ('HARD', 'SOFT');

-- CreateEnum
CREATE TYPE "BillingInstrument" AS ENUM ('BPA_I', 'BPA_C', 'APAC', 'AIH');

-- CreateEnum
CREATE TYPE "ProductionStatus" AS ENUM ('PENDENTE', 'VALIDADO', 'GLOSA_PREVISTA', 'EXPORTADO');

-- CreateEnum
CREATE TYPE "OutboxKind" AS ENUM ('RNDS_RAC', 'RNDS_IMUNIZACAO', 'RNDS_DISPENSACAO', 'RNDS_SUMARIO_ALTA');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDENTE', 'ENVIADO', 'ERRO', 'DESCARTADO');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('CONFIRMACAO_CONSULTA', 'LEMBRETE_MEDICACAO', 'REMARCACAO', 'AVISO');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('AGENDADA', 'ENVIADA', 'ENTREGUE', 'LIDA', 'FALHOU', 'CANCELADA');

-- CreateEnum
CREATE TYPE "ActiveSearchStatus" AS ENUM ('ABERTO', 'EM_CONTATO', 'AGENDADO', 'ENCERRADO');

-- CreateTable
CREATE TABLE "units" (
    "id" UUID NOT NULL,
    "cnes" CHAR(7) NOT NULL,
    "name" TEXT NOT NULL,
    "type" "UnitType" NOT NULL,
    "ibge_code" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "cpf" CHAR(11) NOT NULL,
    "cns" CHAR(15),
    "name" TEXT NOT NULL,
    "social_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    "totp_secret" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "cbo" CHAR(6) NOT NULL,
    "council" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL,
    "cns" CHAR(15),
    "cpf" CHAR(11),
    "name" TEXT NOT NULL,
    "social_name" TEXT,
    "name_key" TEXT NOT NULL,
    "mother_name" TEXT,
    "father_name" TEXT,
    "birth_date" DATE NOT NULL,
    "sex" "Sex" NOT NULL,
    "raca_cor" CHAR(2) NOT NULL DEFAULT '99',
    "etnia" CHAR(4),
    "nationality" CHAR(3) NOT NULL DEFAULT '010',
    "phone" TEXT,
    "whatsapp_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "email" TEXT,
    "cep" CHAR(8),
    "street" TEXT,
    "number" TEXT,
    "complement" TEXT,
    "district" TEXT,
    "ibge_code" TEXT,
    "cadsus_synced_at" TIMESTAMP(3),
    "deceased_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_allergies" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "substance" TEXT NOT NULL,
    "reaction" TEXT,
    "severity" TEXT,
    "recorded_by" UUID,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_allergies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_conditions" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "system" "CodeSystem" NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "line_of_care" "LineOfCare",
    "onset_at" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_documents" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cbo" CHAR(6) NOT NULL,
    "slot_minutes" INTEGER NOT NULL DEFAULT 20,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_rules" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_time" CHAR(5) NOT NULL,
    "end_time" CHAR(5) NOT NULL,
    "first_visit_quota" INTEGER NOT NULL,
    "return_quota" INTEGER NOT NULL,

    CONSTRAINT "schedule_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_blocks" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,

    CONSTRAINT "schedule_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "kind" "AppointmentKind" NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'AGENDADO',
    "confirmation_channel" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "rescheduled_from_id" UUID,
    "notes" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "cbo" CHAR(6) NOT NULL,
    "patient_id" UUID NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'AGUARDANDO',
    "offered_appointment_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "day" CHAR(10) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "TicketKind" NOT NULL,
    "sector" TEXT NOT NULL DEFAULT 'RECEPCAO',
    "patient_id" UUID,
    "encounter_id" UUID,
    "status" "TicketStatus" NOT NULL DEFAULT 'AGUARDANDO',
    "desk" TEXT,
    "called_at" TIMESTAMP(3),
    "called_by" UUID,
    "call_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounters" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "kind" "EncounterKind" NOT NULL,
    "status" "EncounterStatus" NOT NULL DEFAULT 'ABERTO',
    "appointment_id" UUID,
    "ticket_id" UUID,
    "responsible_id" UUID,
    "main_cid" TEXT,
    "outcome" "EncounterOutcome",
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "created_by" UUID NOT NULL,

    CONSTRAINT "encounters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "triages" (
    "id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "nurse_id" UUID NOT NULL,
    "complaint" TEXT NOT NULL,
    "systolic" INTEGER,
    "diastolic" INTEGER,
    "heart_rate" INTEGER,
    "respiratory_rate" INTEGER,
    "temperature" DECIMAL(4,1),
    "spo2" INTEGER,
    "glucose" INTEGER,
    "weight_kg" DECIMAL(5,2),
    "height_cm" INTEGER,
    "pain_score" INTEGER,
    "pain_map" JSONB NOT NULL DEFAULT '[]',
    "flags" TEXT[],
    "vulnerability" TEXT,
    "suggested_color" "RiskColor" NOT NULL,
    "risk_color" "RiskColor" NOT NULL,
    "override_reason" TEXT,
    "classified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "triages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_notes" (
    "id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "cbo" CHAR(6) NOT NULL,
    "kind" "NoteKind" NOT NULL,
    "subjective" TEXT,
    "objective" TEXT,
    "assessment" TEXT,
    "plan" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "codes" TEXT[],
    "status" "NoteStatus" NOT NULL DEFAULT 'RASCUNHO',
    "signed_at" TIMESTAMP(3),
    "audit_hash" CHAR(64),
    "signature" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clinical_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescriptions" (
    "id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "prescriber_id" UUID NOT NULL,
    "kind" "PrescriptionKind" NOT NULL,
    "status" "PrescriptionStatus" NOT NULL DEFAULT 'ATIVA',
    "alerts" JSONB NOT NULL DEFAULT '[]',
    "justification" TEXT,
    "signed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "audit_hash" CHAR(64),

    CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription_items" (
    "id" UUID NOT NULL,
    "prescription_id" UUID NOT NULL,
    "product_id" UUID,
    "description" TEXT NOT NULL,
    "active_ingredient" TEXT,
    "dose" DECIMAL(10,3),
    "dose_unit" TEXT,
    "route" TEXT,
    "frequency_hours" INTEGER,
    "duration_days" INTEGER,
    "quantity" DECIMAL(10,2),
    "instructions" TEXT,
    "suspended_at" TIMESTAMP(3),

    CONSTRAINT "prescription_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_requests" (
    "id" UUID NOT NULL,
    "encounter_id" UUID,
    "patient_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "sigtap_code" CHAR(10) NOT NULL,
    "name" TEXT NOT NULL,
    "analyte" TEXT,
    "status" "ExamStatus" NOT NULL DEFAULT 'SOLICITADO',
    "result_value" DECIMAL(12,4),
    "result_unit" TEXT,
    "result_text" TEXT,
    "result_at" TIMESTAMP(3),
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vaccinations" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "professional_id" UUID NOT NULL,
    "vaccine_code" TEXT NOT NULL,
    "vaccine_name" TEXT NOT NULL,
    "lot" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "dose" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "site" TEXT,
    "applied_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vaccinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wards" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "WardKind" NOT NULL,

    CONSTRAINT "wards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beds" (
    "id" UUID NOT NULL,
    "ward_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "BedStatus" NOT NULL DEFAULT 'VAGO',
    "isolation" "Isolation" NOT NULL DEFAULT 'NENHUM',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "beds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bed_events" (
    "id" UUID NOT NULL,
    "bed_id" UUID NOT NULL,
    "status" "BedStatus" NOT NULL,
    "isolation" "Isolation" NOT NULL,
    "reason" TEXT,
    "user_id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bed_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admissions" (
    "id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "bed_id" UUID,
    "main_cid" TEXT NOT NULL,
    "regulation_code" TEXT,
    "aih_number" CHAR(13),
    "admitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discharged_at" TIMESTAMP(3),

    CONSTRAINT "admissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "catmat" TEXT,
    "description" TEXT NOT NULL,
    "active_ingredient" TEXT,
    "concentration" TEXT,
    "pharmaceutical_form" TEXT,
    "unit" TEXT NOT NULL,
    "gtin" TEXT,
    "controlled_list" "ControlledList",
    "high_alert" BOOLEAN NOT NULL DEFAULT false,
    "antimicrobial_restricted" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_mappings" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "supplier_cnpj" CHAR(14),
    "supplier_code" TEXT,
    "gtin" TEXT,
    "conversion_factor" DECIMAL(10,3) NOT NULL DEFAULT 1,

    CONSTRAINT "product_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_locations" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "StockLocationKind" NOT NULL,

    CONSTRAINT "stock_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_lots" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_number" TEXT NOT NULL,
    "expiry" DATE NOT NULL,
    "manufactured_at" DATE,
    "manufacturer" TEXT,

    CONSTRAINT "stock_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "location_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("location_id","lot_id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "kind" "MovementKind" NOT NULL,
    "location_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "ref_type" TEXT,
    "ref_id" UUID,
    "patient_id" UUID,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "access_key" CHAR(44) NOT NULL,
    "number" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "supplier_cnpj" CHAR(14) NOT NULL,
    "supplier_name" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "total_value" DECIMAL(14,2) NOT NULL,
    "location_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "xml" TEXT NOT NULL,
    "imported_by" UUID NOT NULL,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "product_id" UUID,
    "supplier_code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "gtin" TEXT,
    "ncm" TEXT,
    "anvisa_code" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_price" DECIMAL(14,6) NOT NULL,
    "lots" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" UUID NOT NULL,
    "from_location_id" UUID NOT NULL,
    "to_location_id" UUID NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'SEPARACAO',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_by" UUID,
    "dispatched_at" TIMESTAMP(3),
    "received_by" UUID,
    "received_at" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_items" (
    "id" UUID NOT NULL,
    "transfer_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "received_quantity" DECIMAL(12,3),

    CONSTRAINT "transfer_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_doses" (
    "id" UUID NOT NULL,
    "serial" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "gtin" TEXT NOT NULL,
    "expiry" DATE NOT NULL,
    "location_id" UUID NOT NULL,
    "status" "UnitDoseStatus" NOT NULL DEFAULT 'DISPONIVEL',
    "gs1" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_doses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispensations" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "prescription_id" UUID,
    "external_prescription" JSONB,
    "controlled" BOOLEAN NOT NULL DEFAULT false,
    "dispensed_by" UUID NOT NULL,
    "dispensed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispensations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispensation_items" (
    "id" UUID NOT NULL,
    "dispensation_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,

    CONSTRAINT "dispensation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "administrations" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "prescription_item_id" UUID NOT NULL,
    "unit_dose_id" UUID,
    "location_id" UUID NOT NULL,
    "status" "AdministrationStatus" NOT NULL,
    "checks" JSONB NOT NULL,
    "route" TEXT,
    "scheduled_for" TIMESTAMP(3),
    "administered_by" UUID NOT NULL,
    "double_check_by" UUID,
    "pop_execution_id" UUID,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "administrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pops" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "PopKind" NOT NULL,
    "trigger" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "content" TEXT NOT NULL,
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "requires_double_check" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pop_executions" (
    "id" UUID NOT NULL,
    "pop_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "patient_id" UUID,
    "answers" JSONB NOT NULL,
    "double_check_user_id" UUID,
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "pop_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sigtap_procedures" (
    "code" CHAR(10) NOT NULL,
    "name" TEXT NOT NULL,
    "complexity" TEXT,
    "sex" CHAR(1) NOT NULL,
    "min_age_months" INTEGER NOT NULL,
    "max_age_months" INTEGER NOT NULL,
    "max_quantity" INTEGER NOT NULL,
    "value_sh" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "value_sa" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "value_sp" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "instruments" TEXT[],
    "competencia" CHAR(6) NOT NULL,

    CONSTRAINT "sigtap_procedures_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "sigtap_procedure_cbo" (
    "procedure_code" CHAR(10) NOT NULL,
    "cbo" CHAR(6) NOT NULL,

    CONSTRAINT "sigtap_procedure_cbo_pkey" PRIMARY KEY ("procedure_code","cbo")
);

-- CreateTable
CREATE TABLE "sigtap_procedure_cid" (
    "procedure_code" CHAR(10) NOT NULL,
    "cid" VARCHAR(4) NOT NULL,

    CONSTRAINT "sigtap_procedure_cid_pkey" PRIMARY KEY ("procedure_code","cid")
);

-- CreateTable
CREATE TABLE "sigtap_syncs" (
    "id" UUID NOT NULL,
    "competencia" CHAR(6) NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "procedures" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "sigtap_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_records" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "competencia" CHAR(6) NOT NULL,
    "encounter_id" UUID,
    "patient_id" UUID,
    "professional_id" UUID NOT NULL,
    "cbo" CHAR(6) NOT NULL,
    "procedure_code" CHAR(10) NOT NULL,
    "cid" VARCHAR(4),
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "performed_at" TIMESTAMP(3) NOT NULL,
    "instrument" "BillingInstrument" NOT NULL,
    "status" "ProductionStatus" NOT NULL DEFAULT 'PENDENTE',
    "issues" JSONB NOT NULL DEFAULT '[]',
    "export_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_exports" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "competencia" CHAR(6) NOT NULL,
    "instrument" "BillingInstrument" NOT NULL,
    "file_name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "lines" INTEGER NOT NULL,
    "control_field" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" UUID NOT NULL,
    "kind" "OutboxKind" NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDENTE',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "not_before" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "external_id" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_logs" (
    "id" UUID NOT NULL,
    "patient_id" UUID,
    "phone" TEXT NOT NULL,
    "kind" "MessageKind" NOT NULL,
    "ref_id" UUID,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'AGENDADA',
    "provider_message_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "response" TEXT,
    "responded_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_search_cases" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "line_of_care" "LineOfCare" NOT NULL,
    "status" "ActiveSearchStatus" NOT NULL DEFAULT 'ABERTO',
    "assigned_to" UUID,
    "last_visit_at" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "close_reason" TEXT,

    CONSTRAINT "active_search_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_search_contacts" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "vulnerabilities" TEXT[],
    "actions" TEXT[],
    "notes" TEXT,
    "user_id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "active_search_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_agendas" (
    "id" UUID NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "scope" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "markdown" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_agendas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bi_query_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "sql" TEXT,
    "rows" INTEGER,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "ms" INTEGER,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bi_query_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "libras_calls" (
    "id" UUID NOT NULL,
    "room_id" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "encounter_id" UUID,
    "interpreter_id" TEXT,
    "status" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "libras_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_entries" (
    "seq" BIGSERIAL NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID,
    "unit_id" UUID,
    "role" TEXT,
    "ip" TEXT,
    "mfa" BOOLEAN NOT NULL DEFAULT false,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "payload_hash" CHAR(64) NOT NULL,
    "prev_hash" CHAR(64) NOT NULL,
    "hash" CHAR(64) NOT NULL,

    CONSTRAINT "audit_entries_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "units_cnes_key" ON "units"("cnes");

-- CreateIndex
CREATE UNIQUE INDEX "users_cpf_key" ON "users"("cpf");

-- CreateIndex
CREATE UNIQUE INDEX "users_cns_key" ON "users"("cns");

-- CreateIndex
CREATE UNIQUE INDEX "user_assignments_user_id_unit_id_role_key" ON "user_assignments"("user_id", "unit_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "patients_cns_key" ON "patients"("cns");

-- CreateIndex
CREATE UNIQUE INDEX "patients_cpf_key" ON "patients"("cpf");

-- CreateIndex
CREATE INDEX "patients_name_key_birth_date_idx" ON "patients"("name_key", "birth_date");

-- CreateIndex
CREATE INDEX "patient_allergies_patient_id_idx" ON "patient_allergies"("patient_id");

-- CreateIndex
CREATE INDEX "patient_conditions_patient_id_idx" ON "patient_conditions"("patient_id");

-- CreateIndex
CREATE INDEX "patient_conditions_line_of_care_active_idx" ON "patient_conditions"("line_of_care", "active");

-- CreateIndex
CREATE INDEX "patient_documents_patient_id_idx" ON "patient_documents"("patient_id");

-- CreateIndex
CREATE INDEX "schedules_unit_id_idx" ON "schedules"("unit_id");

-- CreateIndex
CREATE INDEX "schedule_blocks_schedule_id_starts_at_idx" ON "schedule_blocks"("schedule_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_schedule_id_starts_at_idx" ON "appointments"("schedule_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_patient_id_starts_at_idx" ON "appointments"("patient_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_status_starts_at_idx" ON "appointments"("status", "starts_at");

-- CreateIndex
CREATE INDEX "waitlist_entries_unit_id_cbo_status_idx" ON "waitlist_entries"("unit_id", "cbo", "status");

-- CreateIndex
CREATE INDEX "tickets_unit_id_day_status_idx" ON "tickets"("unit_id", "day", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_unit_id_day_kind_sequence_key" ON "tickets"("unit_id", "day", "kind", "sequence");

-- CreateIndex
CREATE INDEX "encounters_patient_id_started_at_idx" ON "encounters"("patient_id", "started_at");

-- CreateIndex
CREATE INDEX "encounters_unit_id_status_idx" ON "encounters"("unit_id", "status");

-- CreateIndex
CREATE INDEX "triages_encounter_id_idx" ON "triages"("encounter_id");

-- CreateIndex
CREATE INDEX "clinical_notes_encounter_id_idx" ON "clinical_notes"("encounter_id");

-- CreateIndex
CREATE INDEX "clinical_notes_status_created_at_idx" ON "clinical_notes"("status", "created_at");

-- CreateIndex
CREATE INDEX "prescriptions_patient_id_signed_at_idx" ON "prescriptions"("patient_id", "signed_at");

-- CreateIndex
CREATE INDEX "prescription_items_prescription_id_idx" ON "prescription_items"("prescription_id");

-- CreateIndex
CREATE INDEX "exam_requests_patient_id_analyte_result_at_idx" ON "exam_requests"("patient_id", "analyte", "result_at");

-- CreateIndex
CREATE INDEX "vaccinations_patient_id_idx" ON "vaccinations"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "beds_ward_id_code_key" ON "beds"("ward_id", "code");

-- CreateIndex
CREATE INDEX "bed_events_bed_id_at_idx" ON "bed_events"("bed_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "admissions_encounter_id_key" ON "admissions"("encounter_id");

-- CreateIndex
CREATE INDEX "admissions_bed_id_idx" ON "admissions"("bed_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");

-- CreateIndex
CREATE INDEX "products_gtin_idx" ON "products"("gtin");

-- CreateIndex
CREATE INDEX "product_mappings_gtin_idx" ON "product_mappings"("gtin");

-- CreateIndex
CREATE UNIQUE INDEX "product_mappings_supplier_cnpj_supplier_code_key" ON "product_mappings"("supplier_cnpj", "supplier_code");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_product_id_lot_number_key" ON "stock_lots"("product_id", "lot_number");

-- CreateIndex
CREATE INDEX "stock_movements_location_id_created_at_idx" ON "stock_movements"("location_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_lot_id_idx" ON "stock_movements"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_access_key_key" ON "invoices"("access_key");

-- CreateIndex
CREATE INDEX "invoice_items_invoice_id_idx" ON "invoice_items"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "unit_doses_serial_key" ON "unit_doses"("serial");

-- CreateIndex
CREATE INDEX "unit_doses_location_id_status_idx" ON "unit_doses"("location_id", "status");

-- CreateIndex
CREATE INDEX "dispensations_patient_id_dispensed_at_idx" ON "dispensations"("patient_id", "dispensed_at");

-- CreateIndex
CREATE INDEX "administrations_patient_id_at_idx" ON "administrations"("patient_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "pops_code_key" ON "pops"("code");

-- CreateIndex
CREATE INDEX "production_records_unit_id_competencia_status_idx" ON "production_records"("unit_id", "competencia", "status");

-- CreateIndex
CREATE INDEX "outbox_messages_status_not_before_idx" ON "outbox_messages"("status", "not_before");

-- CreateIndex
CREATE UNIQUE INDEX "message_logs_provider_message_id_key" ON "message_logs"("provider_message_id");

-- CreateIndex
CREATE INDEX "message_logs_status_scheduled_for_idx" ON "message_logs"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "message_logs_ref_id_idx" ON "message_logs"("ref_id");

-- CreateIndex
CREATE INDEX "active_search_cases_status_line_of_care_idx" ON "active_search_cases"("status", "line_of_care");

-- CreateIndex
CREATE INDEX "active_search_contacts_case_id_idx" ON "active_search_contacts"("case_id");

-- CreateIndex
CREATE INDEX "bi_query_logs_user_id_at_idx" ON "bi_query_logs"("user_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "libras_calls_room_id_key" ON "libras_calls"("room_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_entries_hash_key" ON "audit_entries"("hash");

-- CreateIndex
CREATE INDEX "audit_entries_entity_type_entity_id_idx" ON "audit_entries"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_entries_user_id_at_idx" ON "audit_entries"("user_id", "at");

-- AddForeignKey
ALTER TABLE "user_assignments" ADD CONSTRAINT "user_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_assignments" ADD CONSTRAINT "user_assignments_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_allergies" ADD CONSTRAINT "patient_allergies_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_conditions" ADD CONSTRAINT "patient_conditions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_rules" ADD CONSTRAINT "schedule_rules_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triages" ADD CONSTRAINT "triages_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_requests" ADD CONSTRAINT "exam_requests_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_requests" ADD CONSTRAINT "exam_requests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vaccinations" ADD CONSTRAINT "vaccinations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wards" ADD CONSTRAINT "wards_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beds" ADD CONSTRAINT "beds_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bed_events" ADD CONSTRAINT "bed_events_bed_id_fkey" FOREIGN KEY ("bed_id") REFERENCES "beds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_bed_id_fkey" FOREIGN KEY ("bed_id") REFERENCES "beds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_mappings" ADD CONSTRAINT "product_mappings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_items" ADD CONSTRAINT "transfer_items_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensations" ADD CONSTRAINT "dispensations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensation_items" ADD CONSTRAINT "dispensation_items_dispensation_id_fkey" FOREIGN KEY ("dispensation_id") REFERENCES "dispensations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pop_executions" ADD CONSTRAINT "pop_executions_pop_id_fkey" FOREIGN KEY ("pop_id") REFERENCES "pops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_search_cases" ADD CONSTRAINT "active_search_cases_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_search_contacts" ADD CONSTRAINT "active_search_contacts_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "active_search_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
