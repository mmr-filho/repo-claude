export type ProductionStatus = 'PENDENTE' | 'VALIDADO' | 'GLOSA_PREVISTA' | 'EXPORTADO';

export interface Issue {
  rule: string;
  message: string;
}

export interface ProductionItem {
  id: string;
  competencia: string;
  unit: string | null;
  unitId: string;
  patient: { id: string; name: string; cns: string | null } | null;
  professional: string | null;
  cbo: string;
  procedureCode: string;
  procedureName: string | null;
  cid: string | null;
  quantity: number;
  performedAt: string;
  instrument: 'BPA_I' | 'BPA_C' | 'APAC' | 'AIH';
  status: ProductionStatus;
  issues: Issue[];
}

export interface ProductionList {
  competencia: string;
  summary: Record<string, number>;
  items: ProductionItem[];
}

export const STATUS_LABEL: Record<ProductionStatus, { label: string; tone: 'slate' | 'green' | 'red' | 'blue' }> = {
  PENDENTE: { label: 'Pendente', tone: 'slate' },
  VALIDADO: { label: 'Validado', tone: 'green' },
  GLOSA_PREVISTA: { label: 'Glosa prevista', tone: 'red' },
  EXPORTADO: { label: 'Exportado', tone: 'blue' },
};

export const RULE_LABEL: Record<string, string> = {
  PROCEDIMENTO_INEXISTENTE: 'Procedimento inexistente na SIGTAP',
  CBO_INCOMPATIVEL: 'CBO incompatível',
  CID_OBRIGATORIO: 'CID obrigatório',
  CID_INCOMPATIVEL: 'CID incompatível',
  INSTRUMENTO_INCOMPATIVEL: 'Instrumento de registro não permitido',
  SEXO_INCOMPATIVEL: 'Sexo incompatível',
  IDADE_INCOMPATIVEL: 'Idade fora dos limites',
  QUANTIDADE_EXCEDIDA: 'Quantidade acima do máximo',
  CNS_PACIENTE_AUSENTE: 'Paciente sem CNS nem CPF',
  CNS_PROFISSIONAL_AUSENTE: 'CNS do profissional ausente',
};

/** "202610" -> "out/2026" */
export function fmtCompetencia(c: string): string {
  const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return `${months[Number(c.slice(4, 6)) - 1] ?? '?'}/${c.slice(0, 4)}`;
}

/** Código SIGTAP 0301060061 -> 03.01.06.006-1 */
export function fmtSigtap(code: string): string {
  const d = code.replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 2)}.${d.slice(2, 4)}.${d.slice(4, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : code;
}
