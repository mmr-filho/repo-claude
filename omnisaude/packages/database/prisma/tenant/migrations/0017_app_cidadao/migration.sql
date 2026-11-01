-- CID-1: códigos de acesso do cidadão ao app (WhatsApp ou recepção).
CREATE TABLE "citizen_access_codes" (
  "id" UUID NOT NULL,
  "patient_id" UUID NOT NULL,
  "code_hash" CHAR(64) NOT NULL,
  "channel" TEXT NOT NULL,
  "phone" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "created_by" UUID,
  "ip" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "citizen_access_codes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "citizen_access_codes_patient_id_created_at_idx" ON "citizen_access_codes"("patient_id", "created_at");
ALTER TABLE "citizen_access_codes" ADD CONSTRAINT "citizen_access_codes_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
