-- VIG-1b + INT-4a (semana 24): saída para os sistemas oficiais (fila de digitação com o número oficial), investigação
-- e encerramento, comunicação policial na violência contra a mulher, resultado qualitativo de exame e REL na RNDS.

CREATE TYPE "OfficialSystem" AS ENUM ('SINAN_NET', 'SINAN_ONLINE', 'ESUS_SINAN', 'ESUS_NOTIFICA', 'SIVEP_GRIPE', 'SINASC_SIM');
CREATE TYPE "RouteStatus" AS ENUM ('CONFIRMADO', 'A_DEFINIR', 'NAO_CONFIRMADO');
CREATE TYPE "EntryStatus" AS ENUM ('PENDENTE', 'DIGITADA', 'LEMBRETE');
CREATE TYPE "ExamQualitative" AS ENUM ('DETECTAVEL', 'NAO_DETECTAVEL', 'INCONCLUSIVO', 'REAGENTE', 'NAO_REAGENTE', 'INDETERMINADO');

ALTER TYPE "NotificationStatus" ADD VALUE IF NOT EXISTS 'ENCERRADA';
ALTER TYPE "NotificationOrigin" ADD VALUE IF NOT EXISTS 'EXAME';
ALTER TYPE "Sphere" ADD VALUE IF NOT EXISTS 'AUTORIDADE_POLICIAL';
ALTER TYPE "OutboxKind" ADD VALUE IF NOT EXISTS 'RNDS_REL';

CREATE TABLE official_system_routes (
  id UUID PRIMARY KEY,
  group_key VARCHAR(40) NOT NULL,
  condition_key VARCHAR(60) NOT NULL DEFAULT '',
  system "OfficialSystem" NOT NULL,
  status "RouteStatus" NOT NULL,
  valid_from DATE NOT NULL,
  valid_to DATE,
  source TEXT NOT NULL,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT official_system_routes_periodo CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX official_system_routes_group_key_condition_key_valid_from_key ON official_system_routes (group_key, condition_key, valid_from);

ALTER TABLE notifications
  ADD COLUMN official_system "OfficialSystem",
  ADD COLUMN entry_status "EntryStatus",
  ADD COLUMN official_number VARCHAR(30),
  ADD COLUMN official_batch VARCHAR(40),
  ADD COLUMN entered_by UUID,
  ADD COLUMN entered_at TIMESTAMP(3),
  ADD COLUMN investigated_at DATE,
  ADD COLUMN final_class VARCHAR(2),
  ADD COLUMN criterion VARCHAR(2),
  ADD COLUMN evolution VARCHAR(1),
  ADD COLUMN death_date DATE,
  ADD COLUMN closed_at DATE,
  ADD COLUMN closed_by UUID,
  ADD COLUMN conclusion JSONB,
  ADD COLUMN police_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN police_due_at TIMESTAMP(3),
  ADD COLUMN police_waiver TEXT;

CREATE INDEX notifications_official_system_entry_status_idx ON notifications (official_system, entry_status);
-- O mesmo número oficial não pode ser informado para duas notificações do mesmo sistema. No Sinan Net o NU_NOTIFIC
-- é atribuído pela unidade e só é único com a data da notificação, o município e o agravo (conferido na aplicação).
CREATE UNIQUE INDEX notifications_numero_oficial ON notifications (official_system, official_number) WHERE official_number IS NOT NULL AND official_system <> 'SINAN_NET';

ALTER TABLE exam_requests
  ADD COLUMN exam_key VARCHAR(40),
  ADD COLUMN qualitative "ExamQualitative",
  ADD COLUMN collected_at TIMESTAMP(3),
  ADD COLUMN method TEXT,
  ADD COLUMN lab_cnes CHAR(7),
  ADD COLUMN released_by UUID;
