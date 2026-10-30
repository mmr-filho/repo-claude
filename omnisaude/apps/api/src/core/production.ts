import { competencia } from '@omnisaude/shared';
import type { TenantPrisma } from '@omnisaude/database';
import type { RequestContext } from './context';

/**
 * Registra produção SUS a partir do ato assistencial (triagem, consulta, procedimento), para que o
 * faturamento não dependa de digitação posterior. A crítica pré-glosa roda depois no módulo de faturamento.
 */
export function recordProduction(
  tx: TenantPrisma.TransactionClient,
  ctx: RequestContext,
  input: { procedureCode: string; instrument: 'BPA_I' | 'BPA_C'; encounterId?: string; patientId?: string; cid?: string | null; quantity?: number; at?: Date },
) {
  const at = input.at ?? new Date();
  return tx.productionRecord.create({
    data: {
      unitId: ctx.session.unitId,
      competencia: competencia(at, ctx.tenant.timeZone),
      encounterId: input.encounterId ?? null,
      patientId: input.patientId ?? null,
      professionalId: ctx.session.userId,
      cbo: ctx.cbo,
      procedureCode: input.procedureCode,
      cid: input.cid ? input.cid.replace(/^(CID10|CIAP2):/, '').replace('.', '').slice(0, 4) : null,
      quantity: input.quantity ?? 1,
      performedAt: at,
      instrument: input.instrument,
    },
  });
}

/** Códigos SIGTAP usados nos registros automáticos. */
export const SIGTAP = {
  ACOLHIMENTO_CLASSIFICACAO_RISCO: '0301060118',
  AFERICAO_PA: '0301100039',
  GLICEMIA_CAPILAR: '0214010015',
  CONSULTA_ESPECIALIZADA: '0301010072',
  ATENDIMENTO_URGENCIA: '0301060061',
  CONSULTA_NIVEL_SUPERIOR_ESPECIALIZADA: '0301010048',
} as const;
