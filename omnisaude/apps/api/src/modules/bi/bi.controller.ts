import { Body, Controller, Get, HttpCode, Post, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { BiService } from './bi.service';

const askSchema = z.object({ question: z.string().trim().min(5).max(2000), page: z.number().int().min(0).default(0) });
const runSchema = z.object({ sql: z.string().min(8).max(20_000), page: z.number().int().min(0).default(0) });
const exportSchema = z.object({ sql: z.string().min(8).max(20_000), format: z.literal('csv').default('csv') });

/** O PDF é gerado no navegador (impressão da página de resultados); aqui só CSV. */
@Controller('bi')
export class BiController {
  constructor(private readonly bi: BiService) {}

  @Get('catalog')
  @RequirePermission('bi.consultar')
  catalog() {
    return this.bi.catalog();
  }

  @Get('history')
  @RequirePermission('bi.consultar')
  history(@Ctx() ctx: RequestContext) {
    return this.bi.history(ctx);
  }

  @Post('ask')
  @HttpCode(200)
  @RequirePermission('bi.consultar')
  ask(@Ctx() ctx: RequestContext, @Body(zv(askSchema)) body: z.infer<typeof askSchema>) {
    return this.bi.ask(ctx, body.question, body.page);
  }

  @Post('run')
  @HttpCode(200)
  @RequirePermission('bi.consultar')
  run(@Ctx() ctx: RequestContext, @Body(zv(runSchema)) body: z.infer<typeof runSchema>) {
    return this.bi.run(ctx, body.sql, body.page);
  }

  @Post('export')
  @HttpCode(200)
  @RequirePermission('bi.consultar')
  async export(@Ctx() ctx: RequestContext, @Body(zv(exportSchema)) body: z.infer<typeof exportSchema>, @Res({ passthrough: true }) res: Response) {
    const file = await this.bi.exportCsv(ctx, body.sql);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('X-Total-Rows', String(file.rows));
    return new StreamableFile(file.content);
  }
}
