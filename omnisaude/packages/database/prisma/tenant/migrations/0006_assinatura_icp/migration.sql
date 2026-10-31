-- ─────────────────────────────────────────────────────────────────────────────
-- Assinatura digital ICP-Brasil: certificados A1 dos profissionais e documentos assinados (PAdES)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "SignedKind" AS ENUM ('PRONTUARIO', 'RECEITA', 'ATESTADO', 'DOCUMENTO');

CREATE TABLE "signing_certificates" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "cpf" CHAR(11) NOT NULL,
    "issuer" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "not_before" TIMESTAMPTZ(3) NOT NULL,
    "not_after" TIMESTAMPTZ(3) NOT NULL,
    "icp_brasil" BOOLEAN NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "pfx_encrypted" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "signing_certificates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "signing_certificates_user_id_active_idx" ON "signing_certificates"("user_id", "active");
ALTER TABLE "signing_certificates" ADD CONSTRAINT "signing_certificates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "signed_documents" (
    "id" UUID NOT NULL,
    "kind" "SignedKind" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "patient_id" UUID,
    "signer_id" UUID NOT NULL,
    "certificate_id" UUID,
    "sha256" CHAR(64) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "cpf" CHAR(11) NOT NULL,
    "source" TEXT NOT NULL,
    "signed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signed_documents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "signed_documents_entity_type_entity_id_idx" ON "signed_documents"("entity_type", "entity_id");
CREATE INDEX "signed_documents_sha256_idx" ON "signed_documents"("sha256");
ALTER TABLE "signed_documents" ADD CONSTRAINT "signed_documents_signer_id_fkey" FOREIGN KEY ("signer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "signed_documents" ADD CONSTRAINT "signed_documents_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "signing_certificates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Um registro assinado continua imutável, com uma única exceção: receber a assinatura ICP-Brasil (coluna
-- "signature") uma vez. Qualquer outra coluna continua bloqueada.
CREATE OR REPLACE FUNCTION omni_signed_note_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'ASSINADO' THEN
    IF TG_OP = 'UPDATE' AND OLD.signature IS NULL AND NEW.signature IS NOT NULL
       AND (to_jsonb(NEW) - 'signature' - 'updated_at') = (to_jsonb(OLD) - 'signature' - 'updated_at') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Registro clínico assinado não pode ser alterado; registre uma nova evolução';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
