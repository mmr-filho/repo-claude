import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { allergySchema, conditionSchema, patientSchema, type PatientInput } from './patients.schemas';
import { PatientsService } from './patients.service';

@Controller('patients')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  @Get()
  @RequirePermission('paciente.ler')
  search(@Ctx() ctx: RequestContext, @Query('q') q = '') {
    return q.trim().length < 2 ? [] : this.patients.search(ctx, q);
  }

  @Post()
  @RequirePermission('paciente.cadastrar')
  create(@Ctx() ctx: RequestContext, @Body(zv(patientSchema)) body: PatientInput) {
    return this.patients.create(ctx, body);
  }

  @Post('duplicates')
  @RequirePermission('paciente.cadastrar')
  duplicates(@Ctx() ctx: RequestContext, @Body(zv(patientSchema.pick({ name: true, birthDate: true, cpf: true, cns: true, motherName: true }))) body: Pick<PatientInput, 'name' | 'birthDate' | 'cpf' | 'cns' | 'motherName'>) {
    return this.patients.findDuplicates(ctx, body);
  }

  @Get('cep/:cep')
  @RequirePermission('paciente.cadastrar')
  cep(@Param('cep') cep: string) {
    return this.patients.lookupCep(cep);
  }

  @Get('duplicates/candidates')
  @RequirePermission('paciente.unificar')
  candidates(@Ctx() ctx: RequestContext) {
    return this.patients.duplicateCandidates(ctx);
  }

  @Post(':id/merge')
  @RequirePermission('paciente.unificar')
  merge(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(z.object({ duplicateId: z.string().uuid() }))) body: { duplicateId: string }) {
    return this.patients.merge(ctx, id, body.duplicateId);
  }

  @Get(':id')
  @RequirePermission('paciente.ler')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.patients.get(ctx, id);
  }

  @Patch(':id')
  @RequirePermission('paciente.cadastrar')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(patientSchema.partial())) body: Partial<PatientInput>) {
    return this.patients.update(ctx, id, body);
  }

  @Get(':id/timeline')
  @RequirePermission('prontuario.ler')
  timeline(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.patients.timeline(ctx, id);
  }

  @Get(':id/wristband')
  @RequirePermission('pulseira.emitir')
  wristband(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.patients.wristband(ctx, id);
  }

  @Post(':id/allergies')
  @RequirePermission('prontuario.evoluir', 'triagem.registrar')
  allergy(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(allergySchema)) body: z.infer<typeof allergySchema>) {
    return this.patients.addAllergy(ctx, id, body);
  }

  @Post(':id/conditions')
  @RequirePermission('prontuario.evoluir')
  condition(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(conditionSchema)) body: z.infer<typeof conditionSchema>) {
    return this.patients.addCondition(ctx, id, body);
  }
}
