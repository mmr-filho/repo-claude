import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { DomainError } from '../../core/errors';
import { zv } from '../../core/zod';
import { AdministrationService } from './administration.service';
import { DispensationService } from './dispensation.service';
import { InventoryService } from './inventory.service';
import { LogisticsService } from './logistics.service';
import { NfeService } from './nfe.service';
import {
  administrationSchema,
  bulkReturnSchema,
  dispensationSchema,
  mappingSchema,
  nfeImportSchema,
  productSchema,
  receiveSchema,
  reportSchema,
  returnSchema,
  sefazImportSchema,
  transferSchema,
  unitizeSchema,
} from './pharmacy.schemas';

@Controller('pharmacy')
export class PharmacyController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly nfe: NfeService,
    private readonly logistics: LogisticsService,
    private readonly dispensation: DispensationService,
    private readonly administration: AdministrationService,
  ) {}

  // ── Catálogo e estoque ──

  @Get('products')
  @RequirePermission('estoque.ler', 'dispensacao.registrar', 'administracao.registrar')
  products(@Ctx() ctx: RequestContext, @Query('q') q?: string) {
    return this.inventory.products(ctx, q);
  }

  @Post('products')
  @RequirePermission('estoque.movimentar')
  createProduct(@Ctx() ctx: RequestContext, @Body(zv(productSchema)) body: z.infer<typeof productSchema>) {
    return this.inventory.createProduct(ctx, body);
  }

  @Post('mappings')
  @RequirePermission('nfe.importar')
  mapping(@Ctx() ctx: RequestContext, @Body(zv(mappingSchema)) body: z.infer<typeof mappingSchema>) {
    return this.inventory.upsertMapping(ctx, body);
  }

  @Get('locations')
  @RequirePermission('estoque.ler', 'dispensacao.registrar', 'administracao.registrar')
  locations(@Ctx() ctx: RequestContext, @Query('scope') scope?: 'unit' | 'all') {
    return this.inventory.locations(ctx, scope === 'all' ? 'all' : 'unit');
  }

  @Get('stock')
  @RequirePermission('estoque.ler')
  stock(@Ctx() ctx: RequestContext, @Query('locationId') locationId?: string) {
    return this.inventory.stock(ctx, locationId || undefined);
  }

  @Get('lookup')
  @RequirePermission('estoque.ler', 'dispensacao.registrar', 'administracao.registrar')
  lookup(@Ctx() ctx: RequestContext, @Query('code') code = '') {
    return this.inventory.lookup(ctx, code);
  }

  // ── NF-e ──

  /** Aceita o XML puro (Content-Type: application/xml + ?locationId=) ou JSON { xml, locationId }. */
  @Post('nfe/import')
  @RequirePermission('nfe.importar')
  importNfe(@Ctx() ctx: RequestContext, @Req() req: Request, @Query('locationId') locationId?: string) {
    const raw = typeof req.body === 'string' ? { xml: req.body, locationId } : req.body;
    const body = zv(nfeImportSchema).transform(raw);
    return this.nfe.import(ctx, body.xml, body.locationId);
  }

  @Get('nfe')
  @RequirePermission('nfe.importar', 'estoque.ler')
  invoices(@Ctx() ctx: RequestContext) {
    return this.nfe.invoices(ctx);
  }

  @Get('nfe/sefaz')
  @RequirePermission('nfe.importar')
  sefaz(@Ctx() ctx: RequestContext) {
    return this.nfe.pendingFromSefaz(ctx);
  }

  @Post('nfe/sefaz/:accessKey/import')
  @RequirePermission('nfe.importar')
  importSefaz(@Ctx() ctx: RequestContext, @Param('accessKey') accessKey: string, @Body(zv(sefazImportSchema)) body: z.infer<typeof sefazImportSchema>) {
    return this.nfe.importFromSefaz(ctx, accessKey, body.locationId);
  }

  // ── Transferências ──

  @Get('transfers')
  @RequirePermission('estoque.ler')
  transfers(@Ctx() ctx: RequestContext, @Query('status') status?: string) {
    return this.logistics.transfers(ctx, status || undefined);
  }

  @Post('transfers')
  @RequirePermission('estoque.movimentar')
  createTransfer(@Ctx() ctx: RequestContext, @Body(zv(transferSchema)) body: z.infer<typeof transferSchema>) {
    return this.logistics.createTransfer(ctx, body);
  }

  @Post('transfers/:id/dispatch')
  @HttpCode(200)
  @RequirePermission('estoque.movimentar')
  dispatch(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.logistics.dispatch(ctx, id);
  }

  @Post('transfers/:id/receive')
  @HttpCode(200)
  @RequirePermission('estoque.movimentar')
  receive(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(receiveSchema)) body: z.infer<typeof receiveSchema>) {
    return this.logistics.receive(ctx, id, body);
  }

  @Post('transfers/:id/cancel')
  @HttpCode(200)
  @RequirePermission('estoque.movimentar')
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.logistics.cancelTransfer(ctx, id);
  }

  // ── Unitarização e logística reversa ──

  @Post('unitize')
  @RequirePermission('unitarizacao.executar')
  unitize(@Ctx() ctx: RequestContext, @Body(zv(unitizeSchema)) body: z.infer<typeof unitizeSchema>) {
    return this.logistics.unitize(ctx, body);
  }

  @Post('returns')
  @RequirePermission('administracao.registrar', 'estoque.movimentar')
  returnDose(@Ctx() ctx: RequestContext, @Body(zv(returnSchema)) body: z.infer<typeof returnSchema>) {
    return this.logistics.returnDoses(ctx, [body.unitDoseId], body.reason, body.toLocationId);
  }

  @Post('returns/bulk')
  @RequirePermission('administracao.registrar', 'estoque.movimentar')
  returnBulk(@Ctx() ctx: RequestContext, @Body(zv(bulkReturnSchema)) body: z.infer<typeof bulkReturnSchema>) {
    return this.logistics.returnDoses(ctx, body.unitDoseIds, body.reason, body.toLocationId);
  }

  // ── Dispensação ──

  @Post('dispensations')
  @RequirePermission('dispensacao.registrar')
  dispense(@Ctx() ctx: RequestContext, @Body(zv(dispensationSchema)) body: z.infer<typeof dispensationSchema>) {
    return this.dispensation.dispense(ctx, body);
  }

  @Get('dispensations')
  @RequirePermission('dispensacao.registrar', 'estoque.ler')
  dispensations(@Ctx() ctx: RequestContext, @Query('patientId') patientId?: string) {
    return this.dispensation.list(ctx, patientId || undefined);
  }

  @Get('controlled-report')
  @RequirePermission('controlados.relatorio')
  controlled(@Ctx() ctx: RequestContext, @Query(zv(reportSchema)) q: z.infer<typeof reportSchema>) {
    return this.dispensation.controlledReport(ctx, q.from, q.to);
  }

  // ── Administração beira-leito ──

  /** 201 com { status: 'ADMINISTRADO' } ou 422 com { status: 'BLOQUEADO', checks, sound } (o app toca o som). */
  @Post('administrations')
  @RequirePermission('administracao.registrar')
  async administer(@Ctx() ctx: RequestContext, @Body(zv(administrationSchema)) body: z.infer<typeof administrationSchema>, @Res({ passthrough: true }) res: Response) {
    const result = await this.administration.administer(ctx, body);
    res.status(result.ok ? 201 : 422);
    return result.body;
  }

  @Get('administrations/schedule')
  @RequirePermission('administracao.registrar')
  schedule(@Ctx() ctx: RequestContext, @Query('patientId') patientId?: string) {
    if (!patientId || !/^[0-9a-f-]{36}$/i.test(patientId)) throw new DomainError('VALIDACAO', 'Informe patientId');
    return this.administration.schedule(ctx, patientId);
  }

  @Get('administrations')
  @RequirePermission('administracao.registrar', 'prontuario.ler')
  history(@Ctx() ctx: RequestContext, @Query('patientId', ParseUUIDPipe) patientId: string) {
    return this.administration.history(ctx, patientId);
  }
}
