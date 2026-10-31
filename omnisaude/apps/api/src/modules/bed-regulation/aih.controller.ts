import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { roleHasPermission, UFS } from '@omnisaude/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { AihService } from './aih.service';

const texto = (max: number) => z.string().trim().max(max);
const laudoSchema = z.object({
  patientId: z.string().uuid(),
  admissionId: z.string().uuid().nullish(),
  bedRequestId: z.string().uuid().nullish(),
  procedureCode: texto(14).min(10),
  procedureName: texto(200).nullish(),
  mainCid: texto(5).min(3),
  secondaryCid: texto(5).nullish(),
  associatedCid: texto(5).nullish(),
  specialtyCode: z.string().regex(/^0[1-8]$/, 'Especialidade do leito (01 a 08)'),
  nature: z.string().regex(/^0[1-6]$/, 'Caráter de internação (01 a 06)'),
  symptoms: texto(4000).min(10, 'Descreva os sinais e sintomas'),
  conditions: texto(4000).min(10, 'Descreva as condições que justificam a internação'),
  diagnostics: texto(4000).min(3),
  notes: texto(2000).nullish(),
});
const autorizarSchema = z.object({
  aihNumber: texto(20).nullish(),
  rangeId: z.string().uuid().nullish(),
  aihType: z.enum(['1', '5']).nullish(),
  validUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  notes: texto(1000).nullish(),
});
const motivoSchema = z.object({ reason: texto(1000).min(3) });
const faixaSchema = z.object({
  name: texto(80).min(3),
  unitId: z.string().uuid().nullish(),
  uf: z.enum(UFS),
  year: z.number().int().min(2000).max(2099),
  aihType: z.enum(['1', '5']).nullish(),
  seqStart: z.number().int().min(1).max(9_999_999),
  seqEnd: z.number().int().min(1).max(9_999_999),
});
const faixaUpdateSchema = z.object({ name: texto(80).nullish(), active: z.boolean().nullish(), seqEnd: z.number().int().min(1).max(9_999_999).nullish() });
const listarSchema = z.object({
  status: z.enum(['PENDENTE', 'AUTORIZADA', 'NEGADA', 'CANCELADA']).optional(),
  patientId: z.string().uuid().optional(),
  unitId: z.string().uuid().optional(),
  admissionId: z.string().uuid().optional(),
  escopo: z.enum(['unidade', 'central']).optional(),
});

/** AIH: laudos, autorização com número, negativa, faixas numéricas e impressão. */
@Controller('aih')
export class AihController {
  constructor(private readonly aih: AihService) {}

  @Get('laudos')
  @RequirePermission('aih.ler')
  listar(@Ctx() ctx: RequestContext, @Query(zv(listarSchema)) q: z.infer<typeof listarSchema>) {
    return this.aih.listar(ctx, { ...q, escopo: roleHasPermission(ctx.session.role, 'aih.autorizar') ? (q.escopo ?? 'central') : 'unidade' });
  }

  @Get('painel')
  @RequirePermission('aih.ler')
  painel(@Ctx() ctx: RequestContext) {
    return this.aih.painel(ctx);
  }

  @Get('sigtap')
  @RequirePermission('aih.solicitar', 'aih.autorizar')
  sigtap(@Ctx() ctx: RequestContext, @Query('q') q = '') {
    return this.aih.buscarSigtap(ctx, q);
  }

  @Post('laudos')
  @RequirePermission('aih.solicitar')
  criar(@Ctx() ctx: RequestContext, @Body(zv(laudoSchema)) body: z.infer<typeof laudoSchema>) {
    return this.aih.criar(ctx, body);
  }

  @Get('laudos/:id')
  @RequirePermission('aih.ler')
  detalhe(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.aih.detalhe(ctx, id);
  }

  @Put('laudos/:id')
  @RequirePermission('aih.solicitar')
  atualizar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(laudoSchema)) body: z.infer<typeof laudoSchema>) {
    return this.aih.atualizar(ctx, id, body);
  }

  @Post('laudos/:id/autorizar')
  @HttpCode(200)
  @RequirePermission('aih.autorizar')
  autorizar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(autorizarSchema)) body: z.infer<typeof autorizarSchema>) {
    return this.aih.autorizar(ctx, id, body);
  }

  @Post('laudos/:id/negar')
  @HttpCode(200)
  @RequirePermission('aih.autorizar')
  negar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.aih.negar(ctx, id, body.reason);
  }

  @Post('laudos/:id/cancelar')
  @HttpCode(200)
  @RequirePermission('aih.solicitar', 'aih.autorizar')
  cancelar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.aih.cancelar(ctx, id, body.reason);
  }

  @Get('laudos/:id/laudo.pdf')
  @RequirePermission('aih.ler')
  @Header('Content-Type', 'application/pdf')
  async pdf(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { data, fileName } = await this.aih.laudoPdf(ctx, id);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(data);
  }

  @Get('faixas')
  @RequirePermission('aih.autorizar')
  faixas(@Ctx() ctx: RequestContext) {
    return this.aih.faixas(ctx);
  }

  @Post('faixas')
  @RequirePermission('aih.autorizar')
  criarFaixa(@Ctx() ctx: RequestContext, @Body(zv(faixaSchema)) body: z.infer<typeof faixaSchema>) {
    return this.aih.criarFaixa(ctx, body);
  }

  @Patch('faixas/:id')
  @RequirePermission('aih.autorizar')
  atualizarFaixa(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(faixaUpdateSchema)) body: z.infer<typeof faixaUpdateSchema>) {
    return this.aih.atualizarFaixa(ctx, id, body);
  }
}
