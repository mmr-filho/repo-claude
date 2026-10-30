import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ABASTECIMENTO_AGUA, codeIn, DESTINO_LIXO, ESGOTAMENTO, MATERIAL_PAREDES, PARENTESCO, RENDA_FAMILIAR, SITUACAO_MORADIA, TIPO_DOMICILIO, TIPO_IMOVEL, TRATAMENTO_AGUA, UFS } from '@omnisaude/shared';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { HouseholdsService } from './households.service';

const text = (max: number) => z.string().trim().max(max).nullish();
const familySchema = z.object({
  responsibleId: z.string().uuid().nullish(),
  recordNumber: text(30),
  incomeBracket: z.enum(codeIn(RENDA_FAMILIAR)).nullish(),
});
const householdSchema = z.object({
  cep: text(9),
  street: text(160),
  number: text(20),
  complement: text(80),
  district: text(80),
  city: text(80),
  uf: z.enum(UFS).nullish(),
  ibgeCode: z.string().regex(/^\d{6,7}$/).nullish(),
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
  unitId: z.string().uuid().nullish(),
  teamId: z.string().uuid().nullish(),
  notes: text(500),
});
const memberSchema = z.object({ patientId: z.string().uuid(), kinship: z.enum(codeIn(PARENTESCO)) });

/** Domicílios e famílias (cadastro domiciliar do e-SUS). */
@Controller()
export class HouseholdsController {
  constructor(private readonly households: HouseholdsService) {}

  @Get('households')
  @RequirePermission('paciente.ler')
  search(@Ctx() ctx: RequestContext, @Query('q') q = '') {
    return this.households.search(ctx, q);
  }

  @Post('households')
  @RequirePermission('paciente.cadastrar')
  create(@Ctx() ctx: RequestContext, @Body(zv(householdSchema.extend({ family: familySchema.nullish() }))) body: z.infer<typeof householdSchema> & { family?: z.infer<typeof familySchema> | null }) {
    return this.households.create(ctx, body);
  }

  @Get('households/:id')
  @RequirePermission('paciente.ler')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.households.get(ctx, id);
  }

  @Patch('households/:id')
  @RequirePermission('paciente.cadastrar')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(householdSchema)) body: z.infer<typeof householdSchema>) {
    return this.households.update(ctx, id, body);
  }

  @Post('households/:id/families')
  @RequirePermission('paciente.cadastrar')
  createFamily(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(familySchema)) body: z.infer<typeof familySchema>) {
    return this.households.createFamily(ctx, id, body);
  }

  @Patch('families/:id')
  @RequirePermission('paciente.cadastrar')
  updateFamily(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(familySchema)) body: z.infer<typeof familySchema>) {
    return this.households.updateFamily(ctx, id, body);
  }

  @Post('families/:id/members')
  @RequirePermission('paciente.cadastrar')
  addMember(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(memberSchema)) body: z.infer<typeof memberSchema>) {
    return this.households.addMember(ctx, id, body.patientId, body.kinship);
  }

  @Delete('families/:id/members/:patientId')
  @RequirePermission('paciente.cadastrar')
  removeMember(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.households.removeMember(ctx, id, patientId);
  }
}
