-- Indicadores do cofinanciamento da APS: modalidade da equipe (valores do componente de qualidade) e
-- desfecho das condições (fim da gestação, condição resolvida).
ALTER TABLE "teams" ADD COLUMN "modality" TEXT;
ALTER TABLE "patient_conditions" ADD COLUMN "resolved_at" DATE;
