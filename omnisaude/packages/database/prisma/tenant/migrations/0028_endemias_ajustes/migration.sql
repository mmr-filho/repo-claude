-- Semana 26, ajustes da revisão: observação do imóvel própria do controle vetorial, estorno de remessa de insumo,
-- registro do que já foi exportado ao e-SUS (para visita sincronizada depois do envio não repetir as já enviadas)
-- e índices das consultas por ciclo e por período. O valor novo do enum só é usado depois desta migração.

ALTER TYPE "MovementKind" ADD VALUE IF NOT EXISTS 'ESTORNO_REMESSA';

-- Observação do imóvel escrita pelo ACE e pela supervisão. O pacote do campo leva só esta, nunca households.notes,
-- que é escrita na APS (recepção e ACS) e pode trazer condição de saúde do morador.
ALTER TABLE households ADD COLUMN vector_notes text;

-- Estorno da entrada de remessa: movimento inverso auditado; a guia estornada pode ser lançada de novo.
ALTER TABLE vector_stock_receipts
  ADD COLUMN reversed_at timestamp(3),
  ADD COLUMN reversed_by uuid,
  ADD COLUMN reversal_reason text;
DROP INDEX IF EXISTS vector_stock_receipts_document_lot_id_key;
CREATE UNIQUE INDEX vector_stock_receipts_document_lot_id_ativa ON vector_stock_receipts (document, lot_id) WHERE reversed_at IS NULL;
CREATE INDEX vector_stock_receipts_received_at_idx ON vector_stock_receipts (received_at);

-- Cada registro de origem (atendimento, procedimento, classificação de risco, vacina, visita do ACS ou do ACE) entra
-- em no máximo uma ficha de cada tipo. Gerar outro lote para o mesmo período não repete o que já foi para um lote, e o
-- reprocessamento regera cada ficha só com os registros dela. Cadastros (Patient, Household) ficam de fora: são
-- atualizações e voltam a ser enviados quando mudam.
CREATE TABLE esus_record_items (
  kind integer NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  record_id uuid NOT NULL REFERENCES esus_records(id) ON DELETE CASCADE,
  PRIMARY KEY (kind, source_type, source_id)
);
CREATE INDEX esus_record_items_record_id_idx ON esus_record_items (record_id);

-- Carga do que já foi gerado: os registros agrupados estão em summary.registros; os demais, na própria ficha.
INSERT INTO esus_record_items (kind, source_type, source_id, record_id)
SELECT r.kind, r.source_type, x.id::uuid, r.id
FROM esus_records r
CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.summary -> 'registros') = 'array' THEN r.summary -> 'registros' ELSE '[]'::jsonb END) AS x(id)
WHERE r.source_type NOT IN ('Patient', 'Household')
ORDER BY r.created_at
ON CONFLICT DO NOTHING;
INSERT INTO esus_record_items (kind, source_type, source_id, record_id)
SELECT r.kind, r.source_type, r.source_id, r.id
FROM esus_records r
WHERE r.source_type NOT IN ('Patient', 'Household') AND jsonb_typeof(r.summary -> 'registros') IS DISTINCT FROM 'array'
ORDER BY r.created_at
ON CONFLICT DO NOTHING;

-- Pendências e zonas por ciclo; produção e lista de visitas só por período.
CREATE INDEX vector_visits_cycle_household_id_visited_at_idx ON vector_visits (cycle, household_id, visited_at);
CREATE INDEX vector_visits_visited_at_idx ON vector_visits (visited_at);
