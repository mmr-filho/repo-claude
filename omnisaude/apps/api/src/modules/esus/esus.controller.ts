import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { EsusService } from './esus.service';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');
const generateSchema = z.object({ unitId: z.string().uuid(), from: day, to: day });

@Controller('esus')
export class EsusController {
  constructor(private readonly esus: EsusService) {}

  @Get('status')
  @RequirePermission('esus.ler')
  status(@Ctx() ctx: RequestContext) {
    return this.esus.status(ctx);
  }

  @Get('units')
  @RequirePermission('esus.ler')
  units(@Ctx() ctx: RequestContext) {
    return this.esus.units(ctx);
  }

  @Post('batches')
  @RequirePermission('esus.gerir')
  generate(@Ctx() ctx: RequestContext, @Body(zv(generateSchema)) body: z.infer<typeof generateSchema>) {
    return this.esus.generate(ctx, body);
  }

  @Get('batches')
  @RequirePermission('esus.ler')
  list(@Ctx() ctx: RequestContext, @Query('unitId') unitId?: string) {
    return this.esus.list(ctx, unitId || undefined);
  }

  @Get('batches/:id')
  @RequirePermission('esus.ler')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.esus.get(ctx, id);
  }

  /** Lote em .zip (um .esus por ficha), para importar no PEC em Importar arquivos. */
  @Get('batches/:id/zip')
  @RequirePermission('esus.ler')
  async zip(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const file = await this.esus.zip(ctx, id);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('X-Fichas', String(file.fichas));
    res.send(file.data);
  }

  @Post('batches/:id/send')
  @HttpCode(200)
  @RequirePermission('esus.gerir')
  send(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.esus.send(ctx, id);
  }

  @Post('batches/:id/reprocess')
  @HttpCode(200)
  @RequirePermission('esus.gerir')
  reprocess(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.esus.reprocess(ctx, id);
  }
}
