-- CID-2: assistente do cidadão no WhatsApp (conversas, mensagens e novo tipo de mensagem enviada)
ALTER TYPE "MessageKind" ADD VALUE IF NOT EXISTS 'ASSISTENTE';

CREATE TYPE "AssistantConversationStatus" AS ENUM ('ABERTA', 'AGUARDANDO_ATENDENTE', 'ENCERRADA');
CREATE TYPE "AssistantDirection" AS ENUM ('ENTRADA', 'SAIDA');

CREATE TABLE "assistant_conversations" (
  "id" UUID NOT NULL,
  "phone" TEXT NOT NULL,
  "patient_id" UUID,
  "status" "AssistantConversationStatus" NOT NULL DEFAULT 'ABERTA',
  "context" JSONB NOT NULL DEFAULT '{}',
  "last_triage" TEXT,
  "handoff_reason" TEXT,
  "messages_count" INTEGER NOT NULL DEFAULT 0,
  "last_inbound_at" TIMESTAMP(3) NOT NULL,
  "last_outbound_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_conversations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "assistant_conversations_phone_status_idx" ON "assistant_conversations"("phone", "status");
CREATE INDEX "assistant_conversations_status_last_inbound_at_idx" ON "assistant_conversations"("status", "last_inbound_at");

CREATE TABLE "assistant_messages" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "direction" "AssistantDirection" NOT NULL,
  "text" TEXT NOT NULL,
  "intent" TEXT,
  "payload" JSONB,
  "provider_message_id" TEXT,
  "author_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "assistant_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "assistant_messages_conversation_id_created_at_idx" ON "assistant_messages"("conversation_id", "created_at");
