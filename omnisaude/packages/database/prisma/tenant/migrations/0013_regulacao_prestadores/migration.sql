-- REG-3/REG-4: prestadores (contratos e tetos), PPI/cotas por competência e agendamento regulado.
CREATE TYPE "ProviderKind" AS ENUM ('PROPRIO', 'CONTRATADO', 'FILANTROPICO', 'CONSORCIADO');

CREATE TABLE "regulation_providers" (
  "id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "ProviderKind" NOT NULL,
  "unit_id" UUID,
  "cnes" CHAR(7),
  "cnpj" CHAR(14),
  "contract_number" TEXT,
  "contract_start" DATE,
  "contract_end" DATE,
  "physical_ceiling" INTEGER,
  "financial_ceiling" DECIMAL(14,2),
  "phone" TEXT,
  "address" TEXT,
  "notes" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "regulation_providers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "regulation_quotas" (
  "id" UUID NOT NULL,
  "provider_id" UUID NOT NULL,
  "competencia" CHAR(7) NOT NULL,
  "kind" "RegulationKind" NOT NULL,
  "specialty" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unit_value" DECIMAL(12,2),
  "origin_unit_id" UUID,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "regulation_quotas_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "regulation_quotas_competencia_kind_specialty_idx" ON "regulation_quotas"("competencia", "kind", "specialty");
CREATE INDEX "regulation_quotas_provider_id_competencia_idx" ON "regulation_quotas"("provider_id", "competencia");
ALTER TABLE "regulation_quotas" ADD CONSTRAINT "regulation_quotas_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "regulation_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "regulation_requests"
  ADD COLUMN "provider_id" UUID,
  ADD COLUMN "quota_id" UUID,
  ADD COLUMN "competencia" CHAR(7),
  ADD COLUMN "scheduled_at" TIMESTAMP(3),
  ADD COLUMN "no_show_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "regulation_requests" ADD CONSTRAINT "regulation_requests_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "regulation_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
