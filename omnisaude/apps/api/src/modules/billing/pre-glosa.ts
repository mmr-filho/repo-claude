import { ageInMonths } from '@omnisaude/shared';

/** Regras do motor de auditoria pré-glosa (crítica antes do fechamento da produção). */

export type PreGlosaRule =
  | 'PROCEDIMENTO_INEXISTENTE'
  | 'CBO_INCOMPATIVEL'
  | 'CID_OBRIGATORIO'
  | 'CID_INCOMPATIVEL'
  | 'SEXO_INCOMPATIVEL'
  | 'IDADE_INCOMPATIVEL'
  | 'QUANTIDADE_EXCEDIDA'
  | 'INSTRUMENTO_INCOMPATIVEL'
  | 'CNS_PACIENTE_AUSENTE'
  | 'CNS_PROFISSIONAL_AUSENTE';

export interface PreGlosaIssue {
  rule: PreGlosaRule;
  message: string;
}

export interface ProcedureRules {
  code: string;
  name: string;
  sex: string;
  minAgeMonths: number;
  maxAgeMonths: number;
  maxQuantity: number;
  instruments: string[];
  cbos: Set<string>;
  cids: Set<string>;
}

export interface RecordToCheck {
  procedureCode: string;
  cbo: string;
  cid: string | null;
  instrument: string;
  performedAt: Date;
  patient: { sex: string; birthDate: Date; cns: string | null } | null;
  professionalCns: string | null;
  /** Soma das quantidades do mesmo procedimento para o mesmo paciente na competência. */
  patientQuantityInCompetencia: number;
}

/** Na SIGTAP, 9999 (ou zero) significa "sem limite". */
const unlimited = (v: number) => v <= 0 || v >= 9999;

const normalizeCid = (c: string) => c.replace(/[^A-Z0-9]/gi, '').toUpperCase();

/** CID compatível quando igual ao da tabela ou quando um é a categoria do outro (I10 x I100). */
function cidCompatible(cid: string, allowed: Set<string>): boolean {
  const c = normalizeCid(cid);
  for (const a of allowed) {
    const n = normalizeCid(a);
    if (n === c || n.startsWith(c) || c.startsWith(n)) return true;
  }
  return false;
}

export function evaluateRecord(record: RecordToCheck, proc: ProcedureRules | undefined): PreGlosaIssue[] {
  if (!proc) {
    return [{ rule: 'PROCEDIMENTO_INEXISTENTE', message: `Procedimento ${record.procedureCode} não consta na SIGTAP carregada` }];
  }
  const issues: PreGlosaIssue[] = [];
  if (proc.cbos.size > 0 && !proc.cbos.has(record.cbo)) {
    issues.push({ rule: 'CBO_INCOMPATIVEL', message: `CBO ${record.cbo} não é compatível com ${proc.code} (${proc.name})` });
  }
  if (proc.cids.size > 0) {
    if (!record.cid) issues.push({ rule: 'CID_OBRIGATORIO', message: `O procedimento ${proc.code} exige CID compatível` });
    else if (!cidCompatible(record.cid, proc.cids)) {
      issues.push({ rule: 'CID_INCOMPATIVEL', message: `CID ${record.cid} não é compatível com ${proc.code}` });
    }
  }
  if (proc.instruments.length > 0 && !proc.instruments.includes(record.instrument)) {
    issues.push({
      rule: 'INSTRUMENTO_INCOMPATIVEL',
      message: `${proc.code} não pode ser registrado em ${record.instrument} (permitidos: ${proc.instruments.join(', ')})`,
    });
  }
  if (record.patient) {
    if ((proc.sex === 'M' || proc.sex === 'F') && record.patient.sex !== proc.sex) {
      issues.push({ rule: 'SEXO_INCOMPATIVEL', message: `${proc.code} é restrito ao sexo ${proc.sex === 'F' ? 'feminino' : 'masculino'}` });
    }
    const months = ageInMonths(record.patient.birthDate, record.performedAt);
    const tooYoung = months < proc.minAgeMonths;
    const tooOld = !unlimited(proc.maxAgeMonths) && months > proc.maxAgeMonths;
    if (tooYoung || tooOld) {
      issues.push({
        rule: 'IDADE_INCOMPATIVEL',
        message: `Idade de ${Math.floor(months / 12)} anos fora da faixa do procedimento (${proc.minAgeMonths}–${proc.maxAgeMonths} meses)`,
      });
    }
    if (!unlimited(proc.maxQuantity) && record.patientQuantityInCompetencia > proc.maxQuantity) {
      issues.push({
        rule: 'QUANTIDADE_EXCEDIDA',
        message: `Quantidade ${record.patientQuantityInCompetencia} excede o máximo de ${proc.maxQuantity} por paciente na competência`,
      });
    }
  }
  if (record.instrument === 'BPA_I') {
    if (!record.patient?.cns) issues.push({ rule: 'CNS_PACIENTE_AUSENTE', message: 'BPA-I exige o CNS do paciente' });
    if (!record.professionalCns) issues.push({ rule: 'CNS_PROFISSIONAL_AUSENTE', message: 'BPA-I exige o CNS do profissional' });
  }
  return issues;
}
