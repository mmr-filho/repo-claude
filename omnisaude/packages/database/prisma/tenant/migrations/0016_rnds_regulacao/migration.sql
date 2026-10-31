-- INT-5: envio da regulação à RNDS (Portaria GM/MS 6.656/2025), procedimento SIGTAP da vaga de leito e código externo (SISREG / e-SUS Regulação).
ALTER TYPE "OutboxKind" ADD VALUE IF NOT EXISTS 'RNDS_REGULACAO';
ALTER TABLE "regulation_requests" ADD COLUMN "external_code" TEXT;
ALTER TABLE "bed_requests" ADD COLUMN "procedure_code" CHAR(10);
ALTER TABLE "bed_requests" ADD COLUMN "external_code" TEXT;
