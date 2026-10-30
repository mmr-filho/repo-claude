import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { PopsService } from './pops.service';

const executionSchema = z.object({
  answers: z.record(z.string(), z.boolean()),
  patientId: z.string().uuid().optional(),
  doubleCheck: z.object({ cpf: z.string().min(11), password: z.string().min(1) }).optional(),
});

@Controller('pops')
export class PopsController {
  constructor(private readonly pops: PopsService) {}

  @Get()
  @RequirePermission('pop.consultar')
  list(@Ctx() ctx: RequestContext, @Query('kind') kind?: string, @Query('trigger') trigger?: string) {
    return this.pops.list(ctx, { kind: kind === 'HARD' || kind === 'SOFT' ? kind : undefined, trigger: trigger || undefined });
  }

  @Get('executions')
  @RequirePermission('pop.executar')
  executions(@Ctx() ctx: RequestContext, @Query('patientId') patientId?: string) {
    return this.pops.executions(ctx, patientId || undefined);
  }

  @Get(':id')
  @RequirePermission('pop.consultar')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.pops.get(ctx, id);
  }

  @Post(':id/executions')
  @RequirePermission('pop.executar')
  execute(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(executionSchema)) body: z.infer<typeof executionSchema>) {
    return this.pops.execute(ctx, id, body);
  }
}
