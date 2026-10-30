import { z } from 'zod';

const uuid = z.string().uuid();
export const ISOLATIONS = ['NENHUM', 'CONTATO', 'GOTICULAS', 'AEROSSOIS'] as const;

export const bedUpdateSchema = z
  .object({
    status: z.enum(['VAGO', 'OCUPADO', 'HIGIENIZACAO', 'BLOQUEADO']).optional(),
    isolation: z.enum(ISOLATIONS).optional(),
    reason: z.string().max(500).optional(),
  })
  .refine((b) => b.status || b.isolation, 'Informe status ou isolamento');

export const admissionSchema = z
  .object({
    encounterId: uuid.optional(),
    patientId: uuid.optional(),
    bedId: uuid,
    mainCid: z.string().min(3).max(4),
    regulationCode: z.string().max(40).optional(),
    /** Precaução exigida pelo paciente (o leito precisa ser compatível). */
    isolation: z.enum(ISOLATIONS).default('NENHUM'),
  })
  .refine((a) => a.encounterId || a.patientId, 'Informe o atendimento ou o paciente');

export const transferBedSchema = z.object({ bedId: uuid, reason: z.string().max(500).optional() });

export const dischargeSchema = z.object({
  outcome: z.enum(['ALTA', 'OBITO', 'TRANSFERENCIA']).default('ALTA'),
  summary: z.string().min(10),
  diagnoses: z.array(z.string().min(3).max(4)).default([]),
  procedures: z.array(z.string()).default([]),
  followUp: z.string().optional(),
});
