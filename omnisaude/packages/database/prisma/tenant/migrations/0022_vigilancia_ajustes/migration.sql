-- Vigilância (revisão da semana 23): índices da varredura e da deduplicação por grupo; hash do conteúdo das
-- versões nacionais para sincronizar a curadoria quando o catálogo gerado muda.

ALTER TABLE notifiable_list_versions ADD COLUMN IF NOT EXISTS content_hash CHAR(64);

CREATE INDEX IF NOT EXISTS clinical_notes_status_signed_at_idx ON clinical_notes (status, signed_at);
CREATE INDEX IF NOT EXISTS notifications_encounter_id_group_key_idx ON notifications (encounter_id, group_key);
CREATE INDEX IF NOT EXISTS notifications_vaccination_id_idx ON notifications (vaccination_id);
