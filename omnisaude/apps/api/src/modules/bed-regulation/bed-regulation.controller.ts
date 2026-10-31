import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { roleHasPermission } from '@omnisaude/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { BedRegulationService } from './bed-regulation.service';

const texto = (max: number) => z.string().trim().max(max);
const prioridade = z.enum(['VERMELHA', 'AMARELA', 'VERDE', 'AZUL']);
const tipoLeito = z.enum(['CLINICA_MEDICA', 'CIRURGICA', 'UTI_ADULTO', 'UTI_PEDIATRICA', 'PEDIATRIA', 'OBSTETRICIA', 'OBSERVACAO']);
const isolamento = z.enum(['NENHUM', 'CONTATO', 'GOTICULAS', 'AEROSSOIS']);
const transporte = z.enum(['AMBULANCIA_UTI', 'AMBULANCIA_BASICA', 'VEICULO_SANITARIO', 'PROPRIO']);
const vitais = z
  .object({
    pas: z.number().int().min(30).max(300).nullish(),
    pad: z.number().int().min(10).max(200).nullish(),
    fc: z.number().int().min(10).max(300).nullish(),
    fr: z.number().int().min(2).max(90).nullish(),
    sato2: z.number().int().min(30).max(100).nullish(),
    temp: z.number().min(25).max(45).nullish(),
    consciencia: z.enum(['ALERTA', 'CONFUSO', 'VOZ', 'DOR', 'IRRESPONSIVO']).nullish(),
    oxigenio: z.boolean().nullish(),
  })
  .nullish();
const suporte = z.object({ ventilacaoMecanica: z.boolean().optional(), drogaVasoativa: z.boolean().optional(), oxigenio: z.boolean().optional(), dialise: z.boolean().optional() }).nullish();
const solicitacaoSchema = z.object({
  patientId: z.string().uuid(),
  encounterId: z.string().uuid().nullish(),
  bedKind: tipoLeito,
  specialty: texto(80).min(3),
  priority: prioridade.nullish(),
  cid: texto(5).nullish(),
  clinicalSummary: texto(4000).min(20, 'Descreva o quadro clínico (mínimo 20 caracteres)'),
  vitals: vitais,
  support: suporte,
  isolation: isolamento.optional(),
  elective: z.boolean().optional(),
  procedureCode: texto(14).nullish(),
  externalCode: texto(40).nullish(),
});
const codigoExternoSchema = z.object({ externalCode: texto(40).nullish() });
const complementarSchema = solicitacaoSchema.partial().extend({ notes: texto(2000).nullish() });
const autorizarSchema = z.object({
  destinationUnitId: z.string().uuid(),
  destinationKind: tipoLeito,
  bedId: z.string().uuid().nullish(),
  transport: transporte.nullish(),
  priority: prioridade.nullish(),
  notes: texto(2000).min(3),
});
const transferirSchema = z.object({ transport: transporte, transferAt: z.string().datetime({ offset: true }).nullish(), notes: texto(1000).nullish() });
const internarSchema = z.object({ bedId: z.string().uuid().nullish(), mainCid: texto(5).nullish(), isolation: isolamento.nullish() });
const motivoSchema = z.object({ reason: texto(2000).min(3) });
const notasSchema = z.object({ notes: texto(2000).min(3) });
const segundaSchema = z.object({ notes: texto(2000).min(3), priority: prioridade.nullish() });
const listarSchema = z.object({
  status: z.enum(['PENDENTE', 'EM_ANALISE', 'DEVOLVIDA', 'AUTORIZADA', 'EM_TRANSFERENCIA', 'INTERNADA', 'NEGADA', 'CANCELADA']).optional(),
  patientId: z.string().uuid().optional(),
  unitId: z.string().uuid().optional(),
  escopo: z.enum(['unidade', 'central']).optional(),
});
const filaSchema = z.object({ bedKind: tipoLeito.optional(), priority: prioridade.optional() });

/** Central de leitos da rede: solicitação de vaga, fila, regulação, reserva, transferência e internação. */
@Controller('regulacao-leitos')
export class BedRegulationController {
  constructor(private readonly leitos: BedRegulationService) {}

  @Get('mapa')
  @RequirePermission('leitos_rede.ler')
  mapa(@Ctx() ctx: RequestContext) {
    return this.leitos.mapa(ctx);
  }

  @Get('fila')
  @RequirePermission('leitos_rede.regular')
  fila(@Ctx() ctx: RequestContext, @Query(zv(filaSchema)) q: z.infer<typeof filaSchema>) {
    return this.leitos.fila(ctx, q);
  }

  @Get('painel')
  @RequirePermission('leitos_rede.ler')
  painel(@Ctx() ctx: RequestContext) {
    return this.leitos.painel(ctx);
  }

  @Get('solicitacoes')
  @RequirePermission('leitos_rede.ler')
  listar(@Ctx() ctx: RequestContext, @Query(zv(listarSchema)) q: z.infer<typeof listarSchema>) {
    return this.leitos.listar(ctx, { ...q, escopo: roleHasPermission(ctx.session.role, 'leitos_rede.regular') ? (q.escopo ?? 'central') : 'unidade' });
  }

  @Post('solicitacoes')
  @RequirePermission('leitos_rede.solicitar')
  solicitar(@Ctx() ctx: RequestContext, @Body(zv(solicitacaoSchema)) body: z.infer<typeof solicitacaoSchema>) {
    return this.leitos.solicitar(ctx, body);
  }

  @Get('solicitacoes/:id')
  @RequirePermission('leitos_rede.ler')
  detalhe(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.leitos.detalhe(ctx, id);
  }

  @Put('solicitacoes/:id')
  @RequirePermission('leitos_rede.solicitar')
  complementar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(complementarSchema)) body: z.infer<typeof complementarSchema>) {
    return this.leitos.complementar(ctx, id, body);
  }

  @Post('solicitacoes/:id/analisar')
  @HttpCode(200)
  @RequirePermission('leitos_rede.regular')
  analisar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.leitos.analisar(ctx, id);
  }

  @Post('solicitacoes/:id/devolver')
  @HttpCode(200)
  @RequirePermission('leitos_rede.regular')
  devolver(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.leitos.devolver(ctx, id, body.reason);
  }

  @Post('solicitacoes/:id/segunda-avaliacao/pedir')
  @HttpCode(200)
  @RequirePermission('leitos_rede.regular')
  pedirSegunda(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(notasSchema)) body: z.infer<typeof notasSchema>) {
    return this.leitos.pedirSegundaAvaliacao(ctx, id, body.notes);
  }

  @Post('solicitacoes/:id/segunda-avaliacao')
  @HttpCode(200)
  @RequirePermission('leitos_rede.regular')
  segunda(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(segundaSchema)) body: z.infer<typeof segundaSchema>) {
    return this.leitos.segundaAvaliacao(ctx, id, body.notes, body.priority);
  }

  @Post('solicitacoes/:id/autorizar')
  @HttpCode(200)
  @RequirePermission('leitos_rede.regular')
  autorizar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(autorizarSchema)) body: z.infer<typeof autorizarSchema>) {
    return this.leitos.autorizar(ctx, id, body);
  }

  @Post('solicitacoes/:id/negar')
  @HttpCode(200)
  @RequirePermission('leitos_rede.regular')
  negar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.leitos.negar(ctx, id, body.reason);
  }

  @Post('solicitacoes/:id/transferir')
  @HttpCode(200)
  @RequirePermission('leitos_rede.solicitar', 'leitos_rede.regular')
  transferir(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(transferirSchema)) body: z.infer<typeof transferirSchema>) {
    return this.leitos.transferir(ctx, id, body);
  }

  @Post('solicitacoes/:id/internar')
  @HttpCode(200)
  @RequirePermission('leitos.gerir', 'leitos_rede.regular')
  internar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(internarSchema)) body: z.infer<typeof internarSchema>) {
    return this.leitos.internar(ctx, id, body);
  }

  @Post('solicitacoes/:id/cancelar')
  @HttpCode(200)
  @RequirePermission('leitos_rede.solicitar', 'leitos_rede.regular')
  cancelar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.leitos.cancelar(ctx, id, body.reason);
  }

  @Post('solicitacoes/:id/codigo-externo')
  @HttpCode(200)
  @RequirePermission('leitos_rede.regular')
  codigoExterno(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(codigoExternoSchema)) body: z.infer<typeof codigoExternoSchema>) {
    return this.leitos.codigoExterno(ctx, id, body.externalCode ?? null);
  }

  @Post('solicitacoes/:id/mensagem')
  @HttpCode(200)
  @RequirePermission('leitos_rede.solicitar', 'leitos_rede.regular')
  mensagem(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(notasSchema)) body: z.infer<typeof notasSchema>) {
    return this.leitos.mensagem(ctx, id, body.notes);
  }

  @Get('solicitacoes/:id/ficha.pdf')
  @RequirePermission('leitos_rede.ler')
  @Header('Content-Type', 'application/pdf')
  async ficha(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { data, fileName } = await this.leitos.fichaPdf(ctx, id);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(data);
  }
}
