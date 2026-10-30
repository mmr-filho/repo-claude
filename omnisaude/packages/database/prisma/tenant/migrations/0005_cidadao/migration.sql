-- ─────────────────────────────────────────────────────────────────────────────
-- Cadastro completo do cidadão: documentos e dados sociais, domicílio e família (e-SUS), unificação de cadastros
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "patients"
  ADD COLUMN "rg" TEXT,
  ADD COLUMN "rg_issuer" TEXT,
  ADD COLUMN "rg_uf" CHAR(2),
  ADD COLUMN "nis" CHAR(11),
  ADD COLUMN "birth_ibge_code" TEXT,
  ADD COLUMN "education" CHAR(2),
  ADD COLUMN "work_situation" CHAR(2),
  ADD COLUMN "occupation_cbo" CHAR(6),
  ADD COLUMN "homeless" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "uf" CHAR(2),
  ADD COLUMN "family_id" UUID,
  ADD COLUMN "kinship" CHAR(2),
  ADD COLUMN "merged_into_id" UUID,
  ADD COLUMN "merged_at" TIMESTAMPTZ(3);

CREATE TABLE "households" (
    "id" UUID NOT NULL,
    "cep" CHAR(8),
    "street" TEXT,
    "number" TEXT,
    "complement" TEXT,
    "district" TEXT,
    "city" TEXT,
    "uf" CHAR(2),
    "ibge_code" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "property_type" CHAR(2),
    "dwelling_type" CHAR(2),
    "tenure" CHAR(2),
    "wall_material" CHAR(2),
    "water_supply" CHAR(2),
    "water_treatment" CHAR(2),
    "sewage" CHAR(2),
    "garbage" CHAR(2),
    "electricity" BOOLEAN,
    "rooms" INTEGER,
    "animals" TEXT,
    "micro_area" TEXT,
    "unit_id" UUID,
    "team_id" UUID,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "households_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "households_cep_idx" ON "households"("cep");
CREATE INDEX "households_ibge_code_district_idx" ON "households"("ibge_code", "district");
ALTER TABLE "households" ADD CONSTRAINT "households_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "households" ADD CONSTRAINT "households_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "families" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "responsible_id" UUID,
    "record_number" TEXT,
    "income_bracket" CHAR(2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "families_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "families_household_id_idx" ON "families"("household_id");
ALTER TABLE "families" ADD CONSTRAINT "families_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "families" ADD CONSTRAINT "families_responsible_id_fkey" FOREIGN KEY ("responsible_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "patients_family_id_idx" ON "patients"("family_id");
ALTER TABLE "patients" ADD CONSTRAINT "patients_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "patients" ADD CONSTRAINT "patients_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
