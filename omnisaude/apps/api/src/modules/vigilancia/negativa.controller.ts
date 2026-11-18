import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { NegativaService } from './negativa.service';

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const semana = z.string().regex(/^\d{6}$/);
const atestarSchema = z.object({
  unitId: z.string().uuid(),
  semana,
  emNome: z.object({ motivo: z.string().trim().min(10).max(500) }).nullish(),
});
const anularSchema = z.object({ motivo: z.string().trim().min(10).max(1000) });
const gradeSchema = z.object({ semanas: z.coerce.number().int().min(1).max(53).optional(), ate: semana.optional() });
const abrirSchema = z.object({ unitId: z.string().uuid(), desde: dia });
const encerrarSchema = z.object({ ate: dia, motivo: z.string().trim().min(5).max(500) });
const lotadosSchema = z.object({ busca: z.string().trim().max(60).optional() });
const designarSchema = z.object({ userId: z.string().uuid(), tipo: z.enum(['TITULAR', 'SUBSTITUTO']), desde: dia });

/**
 * Notificação negativa, grade e unidades notificantes (VIG-1c, §4.3; frente F4). Atesto: `notificacao.negativa` (e
 * designação ativa na unidade; em nome da unidade, `vigilancia.consolidacao`). Grade: leitura com `vigilancia.resumo`
 * ou `vigilancia.painel`. Unidades notificantes, responsáveis e anulação: `vigilancia.consolidacao`. As rotas fixas
 * (`negativas/minhas`, `negativas/grade`) vêm antes das rotas com `:id`.
 */
@Controller('vigilancia')
export class NegativaController {
  constructor(private readonly negativas: NegativaService) {}

  @Get('negativas/minhas')
  @RequirePermission('notificacao.negativa')
  minhas(@Ctx() ctx: RequestContext) {
    return this.negativas.minhas(ctx);
  }

  @Get('negativas/grade')
  @RequirePermission('vigilancia.resumo', 'vigilancia.painel')
  grade(@Ctx() ctx: RequestContext, @Query(zv(gradeSchema)) q: z.infer<typeof gradeSchema>) {
    return this.negativas.grade(ctx, q);
  }

  @Post('negativas')
  @RequirePermission('notificacao.negativa')
  atestar(@Ctx() ctx: RequestContext, @Body(zv(atestarSchema)) body: z.infer<typeof atestarSchema>) {
    return this.negativas.atestar(ctx, { unitId: body.unitId, semana: body.semana, emNome: body.emNome ?? undefined });
  }

  @Get('negativas/:id/espelho.pdf')
  @RequirePermission('notificacao.negativa', 'vigilancia.consolidacao')
  @Header('Content-Type', 'application/pdf')
  async espelhoPdf(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { data, fileName } = await this.negativas.espelhoPdf(ctx, id);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(data);
  }

  @Post('negativas/:id/anular')
  @HttpCode(200)
  @RequirePermission('vigilancia.consolidacao')
  anular(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(anularSchema)) body: z.infer<typeof anularSchema>) {
    return this.negativas.anular(ctx, id, body);
  }

  @Get('unidades-notificantes')
  @RequirePermission('vigilancia.consolidacao')
  unidades(@Ctx() ctx: RequestContext) {
    return this.negativas.unidadesNotificantes(ctx);
  }

  @Post('unidades-notificantes')
  @RequirePermission('vigilancia.consolidacao')
  abrirPeriodo(@Ctx() ctx: RequestContext, @Body(zv(abrirSchema)) body: z.infer<typeof abrirSchema>) {
    return this.negativas.abrirPeriodo(ctx, body);
  }

  @Post('unidades-notificantes/:unitId/encerrar')
  @HttpCode(200)
  @RequirePermission('vigilancia.consolidacao')
  encerrarPeriodo(@Ctx() ctx: RequestContext, @Param('unitId', ParseUUIDPipe) unitId: string, @Body(zv(encerrarSchema)) body: z.infer<typeof encerrarSchema>) {
    return this.negativas.encerrarPeriodo(ctx, unitId, body);
  }

  @Get('unidades-notificantes/:unitId/lotados')
  @RequirePermission('vigilancia.consolidacao')
  lotados(@Ctx() ctx: RequestContext, @Param('unitId', ParseUUIDPipe) unitId: string, @Query(zv(lotadosSchema)) q: z.infer<typeof lotadosSchema>) {
    return this.negativas.lotados(ctx, unitId, q.busca);
  }

  @Post('unidades-notificantes/:unitId/responsaveis')
  @RequirePermission('vigilancia.consolidacao')
  designar(@Ctx() ctx: RequestContext, @Param('unitId', ParseUUIDPipe) unitId: string, @Body(zv(designarSchema)) body: z.infer<typeof designarSchema>) {
    return this.negativas.designarResponsavel(ctx, unitId, body);
  }

  @Post('responsaveis/:id/revogar')
  @HttpCode(200)
  @RequirePermission('vigilancia.consolidacao')
  revogar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.negativas.revogarResponsavel(ctx, id);
  }
}
