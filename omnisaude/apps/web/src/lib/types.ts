import type { Permission, Role } from '@omnisaude/shared';

export interface Assignment {
  unitId: string;
  unitName: string;
  unitType: string;
  role: Role;
  roleLabel: string;
  cbo: string;
}

export interface Me {
  user: { id: string; name: string; cpf: string; cns: string | null; mfaEnabled: boolean };
  tenant: { id: string; slug: string; name: string; timeZone: string };
  context: { unitId: string; unitName: string; unitType: string; role: Role; roleLabel: string; cbo: string; mfa: boolean };
  permissions: Permission[];
  features: { aiEnabled: boolean; whatsappEnabled: boolean; rndsEnabled: boolean; icpBrasilEnabled: boolean };
  assignments: Assignment[];
}

export interface PatientSummary {
  id: string;
  name: string;
  civilName: string;
  cns: string | null;
  cpf: string | null;
  birthDate: string;
  age: number;
  sex: 'M' | 'F';
  motherName: string | null;
}
