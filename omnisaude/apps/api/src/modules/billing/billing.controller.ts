import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { DomainError } from '../../core/errors';
import { zv } from '../../core/zod';
import { BillingService } from './billing.service';

const competencia = z.string().regex(/^\d{4}(0[1-9]|1[0-2])$/, 'Competência no formato AAAAMM');
const instrument = z.enum(['BPA_I', 'BPA_C', 'APAC', 'AIH']);

const listSchema = z.object({
  competencia,
  status: z.enum(['PENDENTE', 'VALIDADO', 'GLOSA_PREVISTA', 'EXPORTADO']).optional(),
  unitId: z.string().uuid().optional(),
});
const productionSchema = z.object({
  unitId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  professionalId: z.string().uuid().optional(),
  cbo: z.string().regex(/^\w{6}$/).optional(),
  procedureCode: z.string().regex(/^\d{2}\.?\d{2}\.?\d{2}\.?\d{3}-?\d$/, 'Código SIGTAP com 10 dígitos'),
  cid: z.string().max(5).optional(),
  quantity: z.number().int().min(1).max(9999).default(1),
  performedAt: z.string(),
  instrument,
});
const critiqueSchema = z.object({ competencia, unitId: z.string().uuid().optional() });
const exportSchema = z.object({
  competencia,
  unitId: z.string().uuid(),
  instrument: z.enum(['BPA_I', 'BPA_C']),
  destinationName: z.string().max(40).optional(),
  destinationType: z.enum(['M', 'E']).optional(),
});
const syncSchema = z.object({ competencia });

/** Lê o corpo cru (application/zip ou octet-stream), que não passa pelos parsers JSON/texto. */
async function rawBody(req: Request, limit = 60 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new DomainError('ARQUIVO_GRANDE', 'Arquivo maior que o permitido', 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Contingência: upload do pacote da Tabela Unificada (zip cru ou JSON { fileBase64 }). */
  @Post('sigtap/import')
  @RequirePermission('sigtap.sincronizar')
  async importSigtap(@Ctx() ctx: RequestContext, @Req() req: Request) {
    const type = req.headers['content-type'] ?? '';
    let zip: Buffer;
    if (type.includes('application/json')) {
      const body = z.object({ fileBase64: z.string().min(10) }).safeParse(req.body);
      if (!body.success) throw new DomainError('VALIDACAO', 'Envie { fileBase64 } com o zip da SIGTAP', 400);
      zip = Buffer.from(body.data.fileBase64, 'base64');
    } else {
      zip = await rawBody(req);
    }
    if (zip.length < 22) throw new DomainError('VALIDACAO', 'Arquivo zip vazio', 400);
    return this.billing.importSigtap(ctx, zip);
  }

  @Post('sigtap/sync')
  @RequirePermission('sigtap.sincronizar')
  sync(@Ctx() ctx: RequestContext, @Body(zv(syncSchema)) body: z.infer<typeof syncSchema>) {
    return this.billing.sync(ctx, body.competencia);
  }

  @Get('sigtap/syncs')
  @RequirePermission('faturamento.ler')
  syncs(@Ctx() ctx: RequestContext) {
    return this.billing.syncHistory(ctx);
  }

  @Get('sigtap/procedures')
  @RequirePermission('faturamento.ler')
  procedures(@Ctx() ctx: RequestContext, @Query('q') q = '') {
    return q.trim().length < 3 ? [] : this.billing.procedures(ctx, q.trim());
  }

  @Get('production')
  @RequirePermission('faturamento.ler')
  production(@Ctx() ctx: RequestContext, @Query(zv(listSchema)) query: z.infer<typeof listSchema>) {
    return this.billing.listProduction(ctx, query);
  }

  @Post('production')
  @RequirePermission('faturamento.criticar')
  createProduction(@Ctx() ctx: RequestContext, @Body(zv(productionSchema)) body: z.infer<typeof productionSchema>) {
    return this.billing.createProduction(ctx, body);
  }

  @Post('critique')
  @HttpCode(200)
  @RequirePermission('faturamento.criticar')
  critique(@Ctx() ctx: RequestContext, @Body(zv(critiqueSchema)) body: z.infer<typeof critiqueSchema>) {
    return this.billing.critique(ctx, body);
  }

  @Post('export/bpa')
  @RequirePermission('faturamento.exportar')
  exportBpa(@Ctx() ctx: RequestContext, @Body(zv(exportSchema)) body: z.infer<typeof exportSchema>) {
    return this.billing.exportBpa(ctx, body);
  }

  @Get('exports')
  @RequirePermission('faturamento.ler')
  exports(@Ctx() ctx: RequestContext, @Query('competencia') comp?: string) {
    return this.billing.listExports(ctx, comp);
  }

  /** Arquivo magnético em latin1, pronto para o BPA Magnético. */
  @Get('exports/:id/download')
  @RequirePermission('faturamento.exportar')
  async download(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const e = await this.billing.getExport(ctx, id);
    res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
    res.setHeader('Content-Disposition', `attachment; filename="${e.fileName}"`);
    return new StreamableFile(Buffer.from(e.content, 'latin1'));
  }

  @Get('aih-mirror')
  @RequirePermission('faturamento.ler')
  aihMirror(@Ctx() ctx: RequestContext, @Query('competencia', zv(competencia)) comp: string) {
    return this.billing.aihMirror(ctx, comp);
  }
}
