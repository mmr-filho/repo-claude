export interface ChecklistItem {
  id: string;
  text: string;
  required: boolean;
}

export interface PopSummary {
  id: string;
  code: string;
  title: string;
  kind: 'HARD' | 'SOFT';
  trigger: string | null;
  version: number;
  checklist: ChecklistItem[];
  requiresDoubleCheck: boolean;
}

export interface Pop extends PopSummary {
  content: string;
}

export interface PopExecution {
  id: string;
  code: string;
  trigger: string | null;
  completedAt: string;
  doubleCheckBy: string | null;
}

export const TRIGGER_LABELS: Record<string, string> = {
  'administracao.alta_vigilancia': 'Medicamento de alta vigilância',
  'administracao.antimicrobiano_restrito': 'Antimicrobiano de uso restrito',
  'administracao.hemoderivado': 'Hemocomponentes',
};
