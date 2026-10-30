import type { Role, UnitType } from '@omnisaude/shared';

export interface AdminUnit {
  id: string;
  cnes: string;
  name: string;
  type: UnitType;
  ibgeCode: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  openingHours: string | null;
  active: boolean;
  _count: { assignments: number };
}

export interface AdminAssignment {
  id: string;
  unitId: string;
  unitName: string;
  unitType: string;
  role: Role;
  roleLabel: string;
  cbo: string;
  cboLabel: string | null;
  council: string | null;
  active: boolean;
}

export interface AdminUser {
  id: string;
  cpf: string;
  cns: string | null;
  name: string;
  socialName: string | null;
  email: string | null;
  phone: string | null;
  active: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  locked: boolean;
  createdAt: string;
  assignments: AdminAssignment[];
}

export interface AssignmentDraft {
  unitId: string;
  role: Role | '';
  cbo: string;
  council: string;
}
