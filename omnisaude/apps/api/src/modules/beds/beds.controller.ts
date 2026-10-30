import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { admissionSchema, bedUpdateSchema, dischargeSchema, transferBedSchema } from './beds.schemas';
import { BedsService } from './beds.service';

@Controller()
export class BedsController {
  constructor(private readonly beds: BedsService) {}

  @Get('beds/census')
  @RequirePermission('leitos.ler')
  census(@Ctx() ctx: RequestContext, @Query('unitId') unitId?: string) {
    return this.beds.census(ctx, unitId || undefined);
  }

  @Patch('beds/:id')
  @RequirePermission('leitos.gerir')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(bedUpdateSchema)) body: z.infer<typeof bedUpdateSchema>) {
    return this.beds.update(ctx, id, body);
  }

  @Get('beds/:id/history')
  @RequirePermission('leitos.ler')
  history(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.beds.history(ctx, id);
  }

  @Get('admissions')
  @RequirePermission('leitos.ler')
  admissions(@Ctx() ctx: RequestContext, @Query('unitId') unitId?: string, @Query('active') active?: string) {
    return this.beds.admissions(ctx, unitId || undefined, active !== 'false');
  }

  @Post('admissions')
  @RequirePermission('leitos.gerir')
  admit(@Ctx() ctx: RequestContext, @Body(zv(admissionSchema)) body: z.infer<typeof admissionSchema>) {
    return this.beds.admit(ctx, body);
  }

  @Post('admissions/:id/transfer')
  @HttpCode(200)
  @RequirePermission('leitos.gerir')
  transfer(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(transferBedSchema)) body: z.infer<typeof transferBedSchema>) {
    return this.beds.transfer(ctx, id, body);
  }

  @Post('admissions/:id/discharge')
  @HttpCode(200)
  @RequirePermission('leitos.gerir', 'prontuario.encerrar')
  discharge(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(dischargeSchema)) body: z.infer<typeof dischargeSchema>) {
    return this.beds.discharge(ctx, id, body);
  }
}
