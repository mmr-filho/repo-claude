-- Consulta dos envios à RNDS por registro (resumo do Meu SUS Digital na ficha e no app do cidadão)
CREATE INDEX IF NOT EXISTS "outbox_messages_aggregate_id_kind_idx" ON "outbox_messages"("aggregate_id", "kind");
