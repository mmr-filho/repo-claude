import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  ABASTECIMENTO_AGUA,
  codeIn,
  DESTINO_LIXO,
  ESCOLARIDADE,
  ESGOTAMENTO,
  MATERIAL_PAREDES,
  PARENTESCO,
  RACA_COR,
  RENDA_FAMILIAR,
  SITUACAO_MORADIA,
  TIPO_DOMICILIO,
  TIPO_IMOVEL,
  TRATAMENTO_AGUA,
  UFS,
  type OperacaoCampo,
} from '@omnisaude/shared';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { AcsService } from './acs.service';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');
const text = (max: number) => z.string().trim().max(max).nullish();
const escopoSchema = z.object({ unitId: z.string().uuid().optional(), teamId: z.string().uuid().optional(), microArea: z.string().trim().max(10).optional() });
const visitasSchema = escopoSchema.extend({ from: day.optional(), to: day.optional(), patientId: z.string().uuid().optional(), householdId: z.string().uuid().optional(), professionalId: z.string().uuid().optional() });
const produtividadeSchema = escopoSchema.extend({ from: day.optional(), to: day.optional() });

const base = { clientId: z.string().uuid(), registradoEm: z.string().datetime({ offset: true }) };
const enderecoSchema = z
  .object({
    cep: text(9),
    street: text(160),
    number: text(20),
    complement: text(80),
    district: text(80),
    city: text(80),
    uf: z.enum(UFS).nullish(),
    ibgeCode: z
      .string()
      .regex(/^\d{6,7}$/)
      .nullish(),
  })
  .nullish();
const pessoaSchema = z.object({
  ...base,
  tipo: z.literal('PESSOA'),
  patientId: z.string().uuid().nullish(),
  dados: z.object({
    name: z.string().trim().min(3).max(160),
    birthDate: day,
    sex: z.enum(['M', 'F']),
    cpf: text(14),
    cns: text(18),
    motherName: text(160),
    phone: text(20),
    racaCor: z.enum(Object.keys(RACA_COR) as [string, ...string[]]).nullish(),
    education: z.enum(codeIn(ESCOLARIDADE)).nullish(),
    nis: text(11),
    bolsaFamilia: z.boolean().nullish(),
    endereco: enderecoSchema,
    confirmarNaoDuplicado: z.boolean().nullish(),
  }),
  familyId: z.string().uuid().nullish(),
  familiaClientId: z.string().uuid().nullish(),
  kinship: z.enum(codeIn(PARENTESCO)).nullish(),
});
const domicilioSchema = z.object({
  ...base,
  tipo: z.literal('DOMICILIO'),
  householdId: z.string().uuid().nullish(),
  dados: z.object({
    cep: text(9),
    street: text(160),
    number: text(20),
    complement: text(80),
    district: text(80),
    city: text(80),
    uf: z.enum(UFS).nullish(),
    ibgeCode: z
      .string()
      .regex(/^\d{6,7}$/)
      .nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    propertyType: z.enum(codeIn(TIPO_IMOVEL)).nullish(),
    dwellingType: z.enum(codeIn(TIPO_DOMICILIO)).nullish(),
    tenure: z.enum(codeIn(SITUACAO_MORADIA)).nullish(),
    wallMaterial: z.enum(codeIn(MATERIAL_PAREDES)).nullish(),
    waterSupply: z.enum(codeIn(ABASTECIMENTO_AGUA)).nullish(),
    waterTreatment: z.enum(codeIn(TRATAMENTO_AGUA)).nullish(),
    sewage: z.enum(codeIn(ESGOTAMENTO)).nullish(),
    garbage: z.enum(codeIn(DESTINO_LIXO)).nullish(),
    electricity: z.boolean().nullish(),
    rooms: z.number().int().min(0).max(50).nullish(),
    animals: text(120),
    microArea: text(10),
    notes: text(500),
  }),
  familia: z.object({ responsavelId: z.string().uuid().nullish(), responsavelClientId: z.string().uuid().nullish(), incomeBracket: z.enum(codeIn(RENDA_FAMILIAR)).nullish(), recordNumber: text(30) }).nullish(),
});
const visitaSchema = z.object({
  ...base,
  tipo: z.literal('VISITA'),
  householdId: z.string().uuid().nullish(),
  householdClientId: z.string().uuid().nullish(),
  patientId: z.string().uuid().nullish(),
  patientClientId: z.string().uuid().nullish(),
  visita: z.object({
    motivos: z
      .array(z.string().regex(/^\d{1,2}$/))
      .min(1)
      .max(20),
    desfecho: z.enum(['1', '2', '3']),
    turno: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullish(),
    compartilhada: z.boolean().nullish(),
    foraDaArea: z.boolean().nullish(),
    tipoImovel: z.enum(codeIn(TIPO_IMOVEL)).nullish(),
    microArea: text(10),
    pesoKg: z.number().positive().max(500).nullish(),
    alturaCm: z.number().int().positive().max(250).nullish(),
    sistolica: z.number().int().min(40).max(300).nullish(),
    diastolica: z.number().int().min(20).max(200).nullish(),
    temperatura: z.number().min(30).max(45).nullish(),
    glicemia: z.number().int().min(10).max(1000).nullish(),
    tipoGlicemia: z.enum(['1', '2', '3', '4']).nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    observacoes: text(1000),
  }),
});
const syncSchema = z.object({ operacoes: z.array(z.discriminatedUnion('tipo', [pessoaSchema, domicilioSchema, visitaSchema])).max(500) });

/** App do ACS: território, visitas domiciliares, sincronização do trabalho sem internet e produtividade. */
@Controller('acs')
export class AcsController {
  constructor(private readonly acs: AcsService) {}

  @Get('territorio')
  @RequirePermission('acs.territorio')
  territorio(@Ctx() ctx: RequestContext, @Query(zv(escopoSchema)) q: z.infer<typeof escopoSchema>) {
    return this.acs.territorio(ctx, q);
  }

  @Get('visitas')
  @RequirePermission('acs.territorio')
  visitas(@Ctx() ctx: RequestContext, @Query(zv(visitasSchema)) q: z.infer<typeof visitasSchema>) {
    return this.acs.visitas(ctx, q);
  }

  @Post('sync')
  @HttpCode(200)
  @RequirePermission('acs.campo')
  sync(@Ctx() ctx: RequestContext, @Body(zv(syncSchema)) body: z.infer<typeof syncSchema>) {
    return this.acs.sync(ctx, body.operacoes as OperacaoCampo[]);
  }

  @Get('produtividade')
  @RequirePermission('acs.territorio')
  produtividade(@Ctx() ctx: RequestContext, @Query(zv(produtividadeSchema)) q: z.infer<typeof produtividadeSchema>) {
    const hoje = new Date().toISOString().slice(0, 10);
    const ha30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    return this.acs.produtividade(ctx, { ...q, from: q.from ?? ha30, to: q.to ?? hoje });
  }
}
