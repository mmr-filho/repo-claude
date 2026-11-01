-- Semana 24 (revisão): a notificação descartada não prende o número oficial nem fica na fila de digitação.

-- O número de uma descartada fica como histórico, mas não impede que outra notificação receba o mesmo número
-- (ex.: caso reclassificado para outro agravo e notificado de novo). O Sinan Net segue conferido na aplicação.
DROP INDEX IF EXISTS notifications_numero_oficial;
CREATE UNIQUE INDEX notifications_numero_oficial ON notifications (official_system, official_number)
  WHERE official_number IS NOT NULL AND official_system <> 'SINAN_NET' AND status <> 'DESCARTADA';

-- Descartadas antes desta correção que ficaram pendentes (ou como lembrete) saem da fila.
UPDATE notifications SET entry_status = NULL WHERE status = 'DESCARTADA' AND entry_status IN ('PENDENTE', 'LEMBRETE');
