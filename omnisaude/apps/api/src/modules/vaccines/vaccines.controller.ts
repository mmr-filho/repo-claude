import { Body, Controller, Get, Header, HttpCode, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { VaccinesService } from './vaccines.service';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');
const escopoSchema = z.object({ unitId: z.string().uuid().optional(), teamId: z.string().uuid().optional() });
const aprazamentosSchema = escopoSchema.extend({ from: day.optional(), to: day.optional() });
const aplicarSchema = z.object({
  patientId: z.string().uuid(),
  vaccineCode: z.string().regex(/^\d{1,3}$/),
  lotId: z.string().uuid().optional(),
  lotNumber: z.string().trim().max(40).optional(),
  manufacturerCode: z.string().max(10).optional(),
  manufacturer: z.string().trim().max(120).optional(),
  expiry: day.optional(),
  doseCode: z.string().regex(/^\d{1,2}$/),
  strategyCode: z
    .string()
    .regex(/^\d{1,2}$/)
    .optional(),
  routeCode: z
    .string()
    .regex(/^\d{1,2}$/)
    .optional(),
  siteCode: z
    .string()
    .regex(/^\d{1,2}$/)
    .optional(),
  appliedAt: z.string().datetime({ offset: true }).optional(),
  encounterId: z.string().uuid().optional(),
  nextDueAt: day.optional(),
  transcription: z.boolean().optional(),
  locationId: z.string().uuid().optional(),
});

/** Sala de vacina: cartão, aplicação, estoque, aprazamento, faltosos e certificado. */
@Controller('vacinas')
export class VaccinesController {
  constructor(private readonly vaccines: VaccinesService) {}

  @Get('calendario')
  @RequirePermission('vacinas.ler')
  calendario() {
    return this.vaccines.calendario();
  }

  @Get('cartao')
  @RequirePermission('vacinas.ler')
  cartao(@Ctx() ctx: RequestContext, @Query('patientId', ParseUUIDPipe) patientId: string) {
    return this.vaccines.cartao(ctx, patientId);
  }

  @Post('aplicar')
  @HttpCode(201)
  @RequirePermission('vacinas.aplicar')
  aplicar(@Ctx() ctx: RequestContext, @Body(zv(aplicarSchema)) body: z.infer<typeof aplicarSchema>) {
    return this.vaccines.aplicar(ctx, body);
  }

  @Get('estoque')
  @RequirePermission('vacinas.ler')
  estoque(@Ctx() ctx: RequestContext, @Query('locationId') locationId?: string) {
    return this.vaccines.estoque(ctx, locationId || undefined);
  }

  @Get('faltosos')
  @RequirePermission('vacinas.ler')
  faltosos(@Ctx() ctx: RequestContext, @Query(zv(escopoSchema)) q: z.infer<typeof escopoSchema>) {
    return this.vaccines.faltosos(ctx, q);
  }

  @Get('aprazamentos')
  @RequirePermission('vacinas.ler')
  aprazamentos(@Ctx() ctx: RequestContext, @Query(zv(aprazamentosSchema)) q: z.infer<typeof aprazamentosSchema>) {
    const hoje = new Date().toISOString().slice(0, 10);
    const em30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    return this.vaccines.aprazamentos(ctx, q, q.from ?? hoje, q.to ?? em30);
  }

  @Get('certificado')
  @RequirePermission('vacinas.ler')
  @Header('Content-Type', 'application/pdf')
  async certificado(@Ctx() ctx: RequestContext, @Query('patientId', ParseUUIDPipe) patientId: string, @Res() res: Response) {
    const { data, fileName } = await this.vaccines.certificado(ctx, patientId);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(data);
  }
}
