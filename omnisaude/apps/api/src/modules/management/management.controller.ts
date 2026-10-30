import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { ManagementService } from './management.service';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');
const periodSchema = z.object({ from: day.optional(), to: day.optional(), unitId: z.string().uuid().optional() });

@Controller('management')
export class ManagementController {
  constructor(private readonly management: ManagementService) {}

  @Get('productivity')
  @RequirePermission('gestao.paineis')
  productivity(@Ctx() ctx: RequestContext, @Query(zv(periodSchema)) q: z.infer<typeof periodSchema>) {
    return this.management.productivity(ctx, q);
  }

  @Get('sla')
  @RequirePermission('gestao.paineis')
  sla(@Ctx() ctx: RequestContext, @Query(zv(periodSchema)) q: z.infer<typeof periodSchema>) {
    return this.management.sla(ctx, q);
  }

  @Post('agendas')
  @RequirePermission('gestao.pautas')
  generate(@Ctx() ctx: RequestContext, @Body(zv(periodSchema)) body: z.infer<typeof periodSchema>) {
    return this.management.generateAgenda(ctx, body);
  }

  @Get('agendas')
  @RequirePermission('gestao.pautas')
  list(@Ctx() ctx: RequestContext) {
    return this.management.listAgendas(ctx);
  }

  @Get('agendas/:id')
  @RequirePermission('gestao.pautas')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.management.getAgenda(ctx, id);
  }
}
