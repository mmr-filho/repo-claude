import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { Ctx, Public, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { DocumentsService } from './documents.service';
import { JobsService } from './jobs.service';
import { MessagingService } from './messaging.service';

const ocrSchema = z.object({ image: z.string().max(12_000_000).optional(), mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(), text: z.string().max(20_000).optional() });
const cadsusSchema = z.object({ cpf: z.string().optional(), cns: z.string().optional() });

@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly jobs: JobsService,
  ) {}

  @Get('cadsus')
  @RequirePermission('cadsus.consultar')
  cadsus(@Ctx() ctx: RequestContext, @Query(zv(cadsusSchema)) q: z.infer<typeof cadsusSchema>) {
    return this.documents.cadsusLookup(ctx, q);
  }

  @Post('ocr')
  @HttpCode(200)
  @RequirePermission('paciente.ocr')
  ocr(@Ctx() ctx: RequestContext, @Body(zv(ocrSchema)) body: z.infer<typeof ocrSchema>) {
    return this.documents.readDocument(ctx, body);
  }

  @Get('outbox')
  @RequirePermission('parametros.gerir', 'faturamento.ler')
  outbox(@Ctx() ctx: RequestContext, @Query('status') status?: string) {
    return ctx.db.outboxMessage.findMany({
      where: status ? { status: status as never } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, kind: true, status: true, attempts: true, lastError: true, externalId: true, createdAt: true, sentAt: true, notBefore: true },
    });
  }

  /** Disparo manual dos envios pendentes do tenant (os jobs fazem isso periodicamente). */
  @Post('dispatch')
  @HttpCode(200)
  @RequirePermission('parametros.gerir')
  async dispatch(@Ctx() ctx: RequestContext) {
    const sys = { tenant: ctx.tenant, db: ctx.db };
    return { whatsapp: await this.jobs.run('whatsapp', sys), rnds: await this.jobs.run('rnds', sys) };
  }
}

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly messaging: MessagingService) {}

  @Public()
  @Get('whatsapp/:tenant')
  verify(@Param('tenant') tenant: string, @Query() query: Record<string, unknown>) {
    return this.messaging.verifyChallenge(tenant, query);
  }

  @Public()
  @Post('whatsapp/:tenant')
  @HttpCode(200)
  receive(@Param('tenant') tenant: string, @Req() req: Request & { rawBody?: Buffer }, @Headers('x-hub-signature-256') signature: string | undefined, @Body() body: unknown) {
    return this.messaging.handleWebhook(tenant, req.rawBody, signature, body);
  }
}
