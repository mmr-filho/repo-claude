import { codeIn, ESCOLARIDADE, RACA_COR, SITUACAO_TRABALHO, UFS } from '@omnisaude/shared';
import { z } from 'zod';

export const patientSchema = z.object({
  name: z.string().min(3),
  socialName: z.string().nullish(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sex: z.enum(['M', 'F']),
  cpf: z.string().nullish(),
  cns: z.string().nullish(),
  motherName: z.string().nullish(),
  fatherName: z.string().nullish(),
  racaCor: z.enum(Object.keys(RACA_COR) as [keyof typeof RACA_COR]).nullish(),
  phone: z.string().nullish(),
  whatsappOptIn: z.boolean().nullish(),
  email: z.string().email().nullish(),
  /** Documentos e dados sociais (cadastro individual do e-SUS). */
  rg: z.string().trim().max(20).nullish(),
  rgIssuer: z.string().trim().max(20).nullish(),
  rgUf: z.enum(UFS).nullish(),
  nis: z.string().nullish(),
  birthIbgeCode: z
    .string()
    .regex(/^\d{6,7}$/)
    .nullish(),
  education: z.enum(codeIn(ESCOLARIDADE)).nullish(),
  workSituation: z.enum(codeIn(SITUACAO_TRABALHO)).nullish(),
  occupationCbo: z
    .string()
    .regex(/^\d{6}$/)
    .nullish(),
  homeless: z.boolean().nullish(),
  /** Família beneficiária do Bolsa Família (condicionalidades de saúde acompanhadas pela APS). */
  bolsaFamilia: z.boolean().nullish(),
  address: z
    .object({
      cep: z.string().nullish(),
      street: z.string().nullish(),
      number: z.string().nullish(),
      complement: z.string().nullish(),
      district: z.string().nullish(),
      city: z.string().nullish(),
      uf: z.enum(UFS).nullish(),
      ibgeCode: z.string().nullish(),
    })
    .nullish(),
  /** A recepção confirma que não é a mesma pessoa de um cadastro com mesmo nome e nascimento. */
  confirmNotDuplicate: z.boolean().optional(),
  /** Dados conferidos com o CADSUS no momento do cadastro. */
  cadsusValidated: z.boolean().optional(),
});
export type PatientInput = z.infer<typeof patientSchema>;

export const allergySchema = z.object({ substance: z.string().min(2), reaction: z.string().optional(), severity: z.string().optional() });
export const conditionSchema = z.object({
  system: z.enum(['CID10', 'CID11', 'CIAP2']),
  code: z.string().min(2),
  description: z.string().min(2),
  lineOfCare: z.enum(['HIPERTENSAO', 'DIABETES', 'GESTANTE', 'ONCOLOGIA', 'SAUDE_MENTAL', 'TUBERCULOSE', 'HANSENIASE', 'CRIANCA', 'IDOSO', 'MULHER', 'BOLSA_FAMILIA', 'SISVAN']).optional(),
  /** Início da condição (na gestação, a DUM), usado nos indicadores da APS. */
  onsetAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD')
    .optional(),
});
export const conditionUpdateSchema = z.object({
  active: z.boolean().optional(),
  /** Data do desfecho (fim da gestação, resolução); ao inativar sem informar, usa a data de hoje. */
  resolvedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD')
    .nullable()
    .optional(),
});
