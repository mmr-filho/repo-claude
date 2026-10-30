import { ROUTES_OF_ADMINISTRATION } from '@omnisaude/shared';
import { z } from 'zod';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const qty = z.coerce.number().positive();

export const productSchema = z.object({
  code: z.string().min(2),
  description: z.string().min(3),
  catmat: z.string().nullish(),
  activeIngredient: z.string().nullish(),
  concentration: z.string().nullish(),
  pharmaceuticalForm: z.string().nullish(),
  unit: z.string().min(1),
  gtin: z.string().regex(/^\d{8,14}$/).nullish(),
  controlledList: z.enum(['A1', 'A2', 'A3', 'B1', 'B2', 'C1', 'C2', 'C3', 'C4', 'C5']).nullish(),
  highAlert: z.boolean().optional(),
  antimicrobialRestricted: z.boolean().optional(),
});

export const mappingSchema = z
  .object({
    productId: uuid,
    supplierCnpj: z.string().regex(/^\d{14}$/).nullish(),
    supplierCode: z.string().min(1).nullish(),
    gtin: z.string().regex(/^\d{8,14}$/).nullish(),
    conversionFactor: z.coerce.number().positive().default(1),
  })
  .refine((m) => (m.supplierCnpj && m.supplierCode) || m.gtin, 'Informe fornecedor + código ou o GTIN');

export const nfeImportSchema = z.object({ xml: z.string().min(50), locationId: uuid });
export const sefazImportSchema = z.object({ locationId: uuid });

export const transferSchema = z.object({
  fromLocationId: uuid,
  toLocationId: uuid,
  notes: z.string().optional(),
  items: z.array(z.object({ lotId: uuid, quantity: qty })).min(1),
});
export const receiveSchema = z.object({
  items: z.array(z.object({ lotId: uuid, receivedQuantity: z.coerce.number().min(0) })).min(1),
  notes: z.string().optional(),
});

export const unitizeSchema = z.object({
  lotId: uuid,
  fromLocationId: uuid,
  toLocationId: uuid,
  quantity: z.coerce.number().int().positive().max(500),
  expiry: isoDate.optional(),
});

export const dispensationSchema = z
  .object({
    patientId: uuid,
    locationId: uuid.optional(),
    prescriptionId: uuid.optional(),
    externalPrescription: z
      .object({ number: z.string().min(1), prescriberName: z.string().min(3), prescriberCouncil: z.string().min(3), date: isoDate })
      .optional(),
    items: z.array(z.object({ productId: uuid, quantity: qty, lotId: uuid.optional() })).min(1),
  })
  .refine((d) => !(d.prescriptionId && d.externalPrescription), 'Informe a prescrição interna ou a externa, não ambas');

export const administrationSchema = z.object({
  patientCode: z.string().min(5),
  doseCode: z.string().min(10),
  prescriptionItemId: uuid,
  route: z.enum(ROUTES_OF_ADMINISTRATION),
  popExecutionId: uuid.optional(),
  popExecutionIds: z.array(uuid).optional(),
});

export const returnSchema = z.object({ unitDoseId: uuid, reason: z.string().min(3), toLocationId: uuid.optional() });
export const bulkReturnSchema = z.object({ unitDoseIds: z.array(uuid).min(1), reason: z.string().min(3), toLocationId: uuid.optional() });

export const reportSchema = z.object({ from: isoDate, to: isoDate });
