import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { RegulationService } from './regulation.service';

const prioridade = z.enum(['VERMELHA', 'AMARELA', 'VERDE', 'AZUL']);
const tipo = z.enum(['CONSULTA', 'EXAME', 'PROCEDIMENTO']);
const status = z.enum(['PENDENTE', 'EM_ANALISE', 'DEVOLVIDA', 'AUTORIZADA', 'AGENDADA', 'NEGADA', 'CANCELADA', 'REALIZADA']);
const codigo = z.string().regex(/^[A-Z0-9_]{2,40}$/);
const texto = (max: number) => z.string().trim().max(max);

const solicitarSchema = z.object({
  patientId: z.string().uuid(),
  encounterId: z.string().uuid().nullish(),
  kind: tipo,
  specialty: codigo,
  priority: prioridade,
  priorityJustification: texto(1000).nullish(),
  clinicalSummary: texto(4000).min(10, 'Descreva o quadro clínico (mínimo de 10 caracteres)'),
  criteria: z.array(codigo).max(20).default([]),
  cid: z.string().max(5).nullish(),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
});
const verificarSchema = solicitarSchema.pick({ patientId: true, kind: true, specialty: true, priority: true, priorityJustification: true, criteria: true });
const listarSchema = z.object({
  status: status.optional(),
  unitId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  encounterId: z.string().uuid().optional(),
  specialty: codigo.optional(),
  priority: prioridade.optional(),
  kind: tipo.optional(),
  escopo: z.enum(['unidade', 'central']).optional(),
});
const filaSchema = z.object({ specialty: codigo.optional(), priority: prioridade.optional(), kind: tipo.optional() });
const motivoSchema = z.object({ reason: texto(2000).min(5, 'Informe o motivo') });
const autorizarSchema = z.object({ priority: prioridade.optional(), providerUnitId: z.string().uuid().nullish(), notes: texto(2000).nullish() });
const complementarSchema = z.object({
  notes: texto(2000).min(5, 'Descreva o que foi complementado'),
  priority: prioridade.optional(),
  priorityJustification: texto(1000).nullish(),
  clinicalSummary: texto(4000).optional(),
  criteria: z.array(codigo).max(20).optional(),
  attachmentIds: z.array(z.string().uuid()).max(10).optional(),
});
const mensagemSchema = z.object({ notes: texto(2000).min(2) });

/** Regulação ambulatorial: solicitações a partir do atendimento, fila única, decisão do regulador e devolutiva. */
@Controller('regulacao')
export class RegulationController {
  constructor(private readonly regulation: RegulationService) {}

  @Get('protocolos')
  @RequirePermission('regulacao.ler')
  protocolos() {
    return this.regulation.protocolos();
  }

  @Post('verificar')
  @HttpCode(200)
  @RequirePermission('regulacao.solicitar')
  verificar(@Ctx() ctx: RequestContext, @Body(zv(verificarSchema)) body: z.infer<typeof verificarSchema>) {
    return this.regulation.verificar(ctx, body);
  }

  @Post('solicitacoes')
  @RequirePermission('regulacao.solicitar')
  solicitar(@Ctx() ctx: RequestContext, @Body(zv(solicitarSchema)) body: z.infer<typeof solicitarSchema>) {
    return this.regulation.solicitar(ctx, body);
  }

  @Get('solicitacoes')
  @RequirePermission('regulacao.ler')
  listar(@Ctx() ctx: RequestContext, @Query(zv(listarSchema)) q: z.infer<typeof listarSchema>) {
    return this.regulation.listar(ctx, q);
  }

  @Get('fila')
  @RequirePermission('regulacao.regular')
  fila(@Ctx() ctx: RequestContext, @Query(zv(filaSchema)) q: z.infer<typeof filaSchema>) {
    return this.regulation.fila(ctx, q);
  }

  @Get('painel')
  @RequirePermission('regulacao.ler')
  painel(@Ctx() ctx: RequestContext, @Query('unitId') unitId?: string) {
    return this.regulation.painel(ctx, unitId || undefined);
  }

  @Get('solicitacoes/:id')
  @RequirePermission('regulacao.ler')
  detalhe(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.regulation.detalhe(ctx, id);
  }

  @Post('solicitacoes/:id/analisar')
  @HttpCode(200)
  @RequirePermission('regulacao.regular')
  analisar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.regulation.analisar(ctx, id);
  }

  @Post('solicitacoes/:id/autorizar')
  @HttpCode(200)
  @RequirePermission('regulacao.regular')
  autorizar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(autorizarSchema)) body: z.infer<typeof autorizarSchema>) {
    return this.regulation.autorizar(ctx, id, body);
  }

  @Post('solicitacoes/:id/devolver')
  @HttpCode(200)
  @RequirePermission('regulacao.regular')
  devolver(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.regulation.devolver(ctx, id, body.reason);
  }

  @Post('solicitacoes/:id/negar')
  @HttpCode(200)
  @RequirePermission('regulacao.regular')
  negar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.regulation.negar(ctx, id, body.reason);
  }

  @Post('solicitacoes/:id/complementar')
  @HttpCode(200)
  @RequirePermission('regulacao.solicitar')
  complementar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(complementarSchema)) body: z.infer<typeof complementarSchema>) {
    return this.regulation.complementar(ctx, id, body);
  }

  @Post('solicitacoes/:id/cancelar')
  @HttpCode(200)
  @RequirePermission('regulacao.solicitar', 'regulacao.regular')
  cancelar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.regulation.cancelar(ctx, id, body.reason);
  }

  @Post('solicitacoes/:id/mensagem')
  @HttpCode(200)
  @RequirePermission('regulacao.solicitar', 'regulacao.regular')
  mensagem(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(mensagemSchema)) body: z.infer<typeof mensagemSchema>) {
    return this.regulation.mensagem(ctx, id, body.notes);
  }
}
