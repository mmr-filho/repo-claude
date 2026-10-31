-- Programas da APS: novas linhas de busca ativa, beneficiários do Bolsa Família e estratificações de risco.
ALTER TYPE "LineOfCare" ADD VALUE IF NOT EXISTS 'CRIANCA';
ALTER TYPE "LineOfCare" ADD VALUE IF NOT EXISTS 'IDOSO';
ALTER TYPE "LineOfCare" ADD VALUE IF NOT EXISTS 'MULHER';
ALTER TYPE "LineOfCare" ADD VALUE IF NOT EXISTS 'BOLSA_FAMILIA';
ALTER TYPE "LineOfCare" ADD VALUE IF NOT EXISTS 'SISVAN';

ALTER TABLE "patients" ADD COLUMN "bolsa_familia" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "RiskKind" AS ENUM ('GESTANTE', 'PE_DIABETICO', 'MCHAT');

CREATE TABLE "risk_stratifications" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "kind" "RiskKind" NOT NULL,
    "result" TEXT NOT NULL,
    "score" INTEGER,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "next_due_at" DATE,
    "assessed_by" UUID NOT NULL,
    "assessed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "risk_stratifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "risk_stratifications_patient_id_kind_assessed_at_idx" ON "risk_stratifications"("patient_id", "kind", "assessed_at");
ALTER TABLE "risk_stratifications" ADD CONSTRAINT "risk_stratifications_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
