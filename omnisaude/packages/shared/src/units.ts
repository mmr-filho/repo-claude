import type { UnitType } from './clinical';

/** Rótulos dos tipos de estabelecimento (lista UNIT_TYPES em clinical.ts). */
export const UNIT_TYPE_LABELS: Record<UnitType, string> = {
  UBS: 'Unidade Básica de Saúde',
  UPA: 'UPA 24h',
  POLICLINICA: 'Policlínica / especialidades',
  HOSPITAL: 'Hospital',
  CEO: 'Centro de Especialidades Odontológicas',
  SAMU: 'SAMU / urgência móvel',
  CAPS: 'CAPS / saúde mental',
  FARMACIA_CENTRAL: 'Farmácia central',
  ALMOXARIFADO: 'Almoxarifado',
  LABORATORIO: 'Laboratório',
};
