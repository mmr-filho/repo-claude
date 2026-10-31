import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { IndicatorsService } from './indicators.service';

const competencia = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Competência no formato AAAA-MM');
const painelSchema = z.object({ competencia: competencia.optional(), unitId: z.string().uuid().optional() });
const pendenciasSchema = z.object({
  teamId: z.string().uuid(),
  codigo: z.enum(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'M1', 'M2']),
  competencia: competencia.optional(),
});

/** Indicadores do componente de qualidade do cofinanciamento federal da APS. */
@Controller('indicadores-aps')
export class IndicatorsController {
  constructor(private readonly indicators: IndicatorsService) {}

  @Get()
  @RequirePermission('aps.indicadores')
  painel(@Ctx() ctx: RequestContext, @Query(zv(painelSchema)) q: z.infer<typeof painelSchema>) {
    return this.indicators.painel(ctx, q);
  }

  @Get('fichas')
  @RequirePermission('aps.indicadores')
  fichas() {
    return this.indicators.fichas();
  }

  @Get('pendencias')
  @RequirePermission('aps.indicadores')
  pendencias(@Ctx() ctx: RequestContext, @Query(zv(pendenciasSchema)) q: z.infer<typeof pendenciasSchema>) {
    return this.indicators.pendencias(ctx, q);
  }
}
