import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { roleHasPermission, UFS } from '@omnisaude/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { TfdService } from './tfd.service';

const texto = (max: number) => z.string().trim().max(max);
const laudoSchema = z.object({
  patientId: z.string().uuid(),
  requestId: z.string().uuid().nullish(),
  cid: z.string().max(5).nullish(),
  diagnosis: texto(300).min(3),
  procedureName: texto(200).min(3),
  procedureCode: texto(14).nullish(),
  clinicalSummary: texto(4000).min(10),
  justification: texto(2000).min(10, 'Explique por que o tratamento não é possível no município'),
  urgency: z.boolean().optional(),
  destinationCity: texto(80).min(2),
  destinationUf: z.enum(UFS),
  destinationIbge: texto(7).nullish(),
  destinationUnit: texto(160).nullish(),
  transport: z.enum(['RODOVIARIO', 'AEREO', 'AMBULANCIA', 'VEICULO_SANITARIO', 'PROPRIO']),
  needsCompanion: z.boolean().optional(),
  companionName: texto(120).nullish(),
  companionCpf: texto(14).nullish(),
  companionRelation: texto(60).nullish(),
  accommodation: z.boolean().optional(),
});
const parecerSchema = z.object({
  deferido: z.boolean(),
  notes: texto(2000).min(3),
  allowanceApproved: z.boolean().optional(),
  transport: z.enum(['RODOVIARIO', 'AEREO', 'AMBULANCIA', 'VEICULO_SANITARIO', 'PROPRIO']).nullish(),
});
const agendarSchema = z.object({ appointmentAt: z.string().datetime({ offset: true }), appointmentPlace: texto(200).min(3), notes: texto(500).nullish() });
const ajudaSchema = z.object({
  itens: z
    .array(
      z.object({
        tipo: z.enum(['PASSAGEM', 'DIARIA', 'ALIMENTACAO', 'HOSPEDAGEM', 'OUTRO']),
        beneficiario: z.enum(['PACIENTE', 'ACOMPANHANTE']),
        quantidade: z.number().min(0).max(1000),
        valorUnitario: z.number().min(0).max(100000),
        descricao: texto(120).nullish(),
      }),
    )
    .max(30),
});
const viagemSchema = z.object({ tripId: z.string().uuid(), pickupAddress: texto(200).nullish(), wheelchair: z.boolean().optional() });
const notasSchema = z.object({ notes: texto(2000).nullish() });
const motivoSchema = z.object({ reason: texto(2000).min(3) });
const mensagemSchema = z.object({ notes: texto(2000).min(2) });
const listarSchema = z.object({
  status: z.enum(['ABERTO', 'ENVIADO', 'DEFERIDO', 'INDEFERIDO', 'AGENDADO', 'CONCLUIDO', 'CANCELADO']).optional(),
  patientId: z.string().uuid().optional(),
  unitId: z.string().uuid().optional(),
  escopo: z.enum(['unidade', 'central']).optional(),
});

/** TFD: laudo, processo, envio, parecer, agendamento, ajuda de custo, viagem e impressão. */
@Controller('tfd')
export class TfdController {
  constructor(private readonly tfd: TfdService) {}

  @Get('processos')
  @RequirePermission('tfd.ler')
  listar(@Ctx() ctx: RequestContext, @Query(zv(listarSchema)) q: z.infer<typeof listarSchema>) {
    return this.tfd.listar(ctx, { ...q, escopo: roleHasPermission(ctx.session.role, 'tfd.gerir') ? (q.escopo ?? 'central') : 'unidade' });
  }

  @Get('painel')
  @RequirePermission('tfd.ler')
  painel(@Ctx() ctx: RequestContext) {
    return this.tfd.painel(ctx);
  }

  @Post('processos')
  @RequirePermission('tfd.gerir')
  abrir(@Ctx() ctx: RequestContext, @Body(zv(laudoSchema)) body: z.infer<typeof laudoSchema>) {
    return this.tfd.abrir(ctx, body);
  }

  @Get('processos/:id')
  @RequirePermission('tfd.ler')
  detalhe(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.tfd.detalhe(ctx, id);
  }

  @Put('processos/:id/laudo')
  @RequirePermission('tfd.gerir')
  laudo(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(laudoSchema)) body: z.infer<typeof laudoSchema>) {
    return this.tfd.atualizarLaudo(ctx, id, body);
  }

  @Post('processos/:id/enviar')
  @HttpCode(200)
  @RequirePermission('tfd.gerir')
  enviar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(notasSchema)) body: z.infer<typeof notasSchema>) {
    return this.tfd.enviar(ctx, id, body.notes);
  }

  @Post('processos/:id/parecer')
  @HttpCode(200)
  @RequirePermission('tfd.gerir')
  parecer(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(parecerSchema)) body: z.infer<typeof parecerSchema>) {
    return this.tfd.parecer(ctx, id, body);
  }

  @Post('processos/:id/agendar')
  @HttpCode(200)
  @RequirePermission('tfd.gerir')
  agendar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(agendarSchema)) body: z.infer<typeof agendarSchema>) {
    return this.tfd.agendar(ctx, id, body);
  }

  @Put('processos/:id/ajuda-custo')
  @RequirePermission('tfd.gerir')
  ajuda(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(ajudaSchema)) body: z.infer<typeof ajudaSchema>) {
    return this.tfd.ajudaCusto(ctx, id, body.itens);
  }

  @Post('processos/:id/ajuda-custo/pagar')
  @HttpCode(200)
  @RequirePermission('tfd.gerir')
  pagar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.tfd.pagarAjuda(ctx, id);
  }

  @Post('processos/:id/viagem')
  @HttpCode(200)
  @RequirePermission('tfd.gerir')
  viagem(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(viagemSchema)) body: z.infer<typeof viagemSchema>) {
    return this.tfd.vincularViagem(ctx, id, body);
  }

  @Post('processos/:id/viagem/cancelar')
  @HttpCode(200)
  @RequirePermission('tfd.gerir')
  cancelarViagem(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.tfd.desvincularViagem(ctx, id);
  }

  @Post('processos/:id/concluir')
  @HttpCode(200)
  @RequirePermission('tfd.gerir')
  concluir(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(notasSchema)) body: z.infer<typeof notasSchema>) {
    return this.tfd.concluir(ctx, id, body.notes);
  }

  @Post('processos/:id/cancelar')
  @HttpCode(200)
  @RequirePermission('tfd.gerir')
  cancelar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.tfd.cancelar(ctx, id, body.reason);
  }

  @Post('processos/:id/mensagem')
  @HttpCode(200)
  @RequirePermission('tfd.gerir')
  mensagem(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(mensagemSchema)) body: z.infer<typeof mensagemSchema>) {
    return this.tfd.mensagem(ctx, id, body.notes);
  }

  @Get('processos/:id/laudo.pdf')
  @RequirePermission('tfd.ler')
  @Header('Content-Type', 'application/pdf')
  async laudoPdf(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { data, fileName } = await this.tfd.laudoPdf(ctx, id);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(data);
  }

  @Get('processos/:id/guia.pdf')
  @RequirePermission('tfd.ler')
  @Header('Content-Type', 'application/pdf')
  async guiaPdf(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { data, fileName } = await this.tfd.guiaPdf(ctx, id);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(data);
  }
}
