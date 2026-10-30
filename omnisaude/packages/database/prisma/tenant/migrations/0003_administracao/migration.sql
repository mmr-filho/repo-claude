-- ─────────────────────────────────────────────────────────────────────────────
-- Administração: senha provisória de profissionais e dados de contato das unidades
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN password_changed_at timestamptz;

ALTER TABLE units
  ADD COLUMN email text,
  ADD COLUMN opening_hours text;
