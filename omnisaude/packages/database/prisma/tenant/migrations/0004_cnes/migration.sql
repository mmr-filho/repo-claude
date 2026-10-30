-- ─────────────────────────────────────────────────────────────────────────────
-- Importação do CNES: dados das unidades, equipes (INE), pré-cadastro de profissionais e histórico de importações
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "units"
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "cnes_type_code" CHAR(2),
  ADD COLUMN "legal_nature" CHAR(4),
  ADD COLUMN "management" CHAR(1),
  ADD COLUMN "sus_ambulatory" BOOLEAN,
  ADD COLUMN "cnes_updated_at" TIMESTAMPTZ(3),
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL';

CREATE TYPE "StagedStatus" AS ENUM ('PENDENTE', 'VINCULADO', 'IGNORADO');
CREATE TYPE "ImportKind" AS ENUM ('ESTABELECIMENTOS', 'PROFISSIONAIS', 'EQUIPES');
CREATE TYPE "ImportStatus" AS ENUM ('PREVIA', 'APLICADA', 'CANCELADA');

CREATE TABLE "cnes_imports" (
    "id" UUID NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "ibge_code" TEXT,
    "source" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'PREVIA',
    "summary" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ(3),

    CONSTRAINT "cnes_imports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "ine" CHAR(10) NOT NULL,
    "name" TEXT NOT NULL,
    "type_code" CHAR(2) NOT NULL,
    "unit_id" UUID NOT NULL,
    "area" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "teams_ine_key" ON "teams"("ine");
ALTER TABLE "teams" ADD CONSTRAINT "teams_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "cnes_professionals" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cpf" CHAR(11),
    "cns" CHAR(15),
    "cbo" CHAR(6) NOT NULL,
    "council" TEXT,
    "unit_id" UUID,
    "cnes" CHAR(7),
    "ine" CHAR(10),
    "bond" TEXT,
    "weekly_hours" INTEGER,
    "source" TEXT NOT NULL,
    "status" "StagedStatus" NOT NULL DEFAULT 'PENDENTE',
    "user_id" UUID,
    "import_id" UUID,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cnes_professionals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cnes_professionals_status_name_idx" ON "cnes_professionals"("status", "name");
ALTER TABLE "cnes_professionals" ADD CONSTRAINT "cnes_professionals_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cnes_professionals" ADD CONSTRAINT "cnes_professionals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cnes_professionals" ADD CONSTRAINT "cnes_professionals_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "cnes_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "team_members" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "user_id" UUID,
    "staged_id" UUID,
    "cbo" CHAR(6) NOT NULL,
    "micro_area" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "team_members_team_id_user_id_key" ON "team_members"("team_id", "user_id");
CREATE UNIQUE INDEX "team_members_team_id_staged_id_key" ON "team_members"("team_id", "staged_id");
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_staged_id_fkey" FOREIGN KEY ("staged_id") REFERENCES "cnes_professionals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
