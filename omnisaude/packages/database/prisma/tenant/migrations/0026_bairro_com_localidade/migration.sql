-- Território (PLT-3): bairros desativados junto com a extinção da localidade voltam quando ela é reativada.
ALTER TABLE neighborhoods ADD COLUMN inactivated_with_locality BOOLEAN NOT NULL DEFAULT false;
