import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CitizenCtx, CitizenRoute, Ctx, RequirePermission, type CitizenContext, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { OmbudsmanService } from './ombudsman.service';
import { SatisfactionService } from './satisfaction.service';

const tipo = z.enum(['RECLAMACAO', 'DENUNCIA', 'SUGESTAO', 'ELOGIO', 'SOLICITACAO', 'INFORMACAO']);
const registrarSchema = z.object({
  kind: tipo,
  channel: z.enum(['PRESENCIAL', 'TELEFONE', 'SITE', 'WHATSAPP']),
  subject: z.string().trim().min(2).max(40),
  text: z.string().trim().min(10).max(4000),
  unitId: z.string().uuid().nullish(),
  patientId: z.string().uuid().nullish(),
  anonymous: z.boolean().optional(),
  contactName: z.string().trim().max(120).nullish(),
  contactPhone: z.string().trim().max(20).nullish(),
});
const listarSchema = z.object({
  status: z.enum(['ABERTAS', 'RECEBIDA', 'EM_ANALISE', 'PRORROGADA', 'RESPONDIDA', 'ENCERRADA', 'ARQUIVADA']).optional(),
  kind: tipo.optional(),
  unitId: z.string().uuid().optional(),
  busca: z.string().trim().max(80).optional(),
  prazo: z.enum(['NO_PRAZO', 'VENCE_EM_BREVE', 'VENCIDA']).optional(),
});
const encaminharSchema = z.object({ unitId: z.string().uuid().nullish(), userId: z.string().uuid().nullish(), notes: z.string().trim().max(1000).nullish() });
const textoSchema = z.object({ text: z.string().trim().min(5).max(4000) });
const motivoSchema = z.object({ reason: z.string().trim().min(10).max(1000) });
const encerrarSchema = z.object({ arquivar: z.boolean().optional(), notes: z.string().trim().max(1000).nullish() });
const painelSatisfacaoSchema = z.object({
  unitId: z.string().uuid().optional(),
  de: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  ate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
const cidadaoNovaSchema = z.object({ kind: tipo, subject: z.string().trim().min(2).max(40), text: z.string().trim().min(10).max(4000), unitId: z.string().uuid().nullish(), anonymous: z.boolean().optional() });
const avaliarSchema = z.object({ nota: z.number().int().min(1).max(5), comentario: z.string().trim().max(1000).nullish() });
const responderPesquisaSchema = z.object({ nota: z.number().int().min(1).max(5), recomendaria: z.number().int().min(0).max(10).nullish(), comentario: z.string().trim().max(1000).nullish() });

/** Ouvidoria e pesquisa de satisfação: equipe. */
@Controller('ouvidoria')
export class OmbudsmanController {
  constructor(
    private readonly ombudsman: OmbudsmanService,
    private readonly satisfaction: SatisfactionService,
  ) {}

  @Get('painel')
  @RequirePermission('ouvidoria.ler')
  painel(@Ctx() ctx: RequestContext) {
    return this.ombudsman.painel(ctx);
  }

  @Get('manifestacoes')
  @RequirePermission('ouvidoria.ler')
  listar(@Ctx() ctx: RequestContext, @Query(zv(listarSchema)) q: z.infer<typeof listarSchema>) {
    return this.ombudsman.listar(ctx, q);
  }

  @Post('manifestacoes')
  @RequirePermission('ouvidoria.registrar')
  registrar(@Ctx() ctx: RequestContext, @Body(zv(registrarSchema)) body: z.infer<typeof registrarSchema>) {
    return this.ombudsman.registrarPelaEquipe(ctx, body);
  }

  @Get('manifestacoes/:id')
  @RequirePermission('ouvidoria.ler')
  detalhe(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.ombudsman.detalhe(ctx, id);
  }

  @Post('manifestacoes/:id/encaminhar')
  @HttpCode(200)
  @RequirePermission('ouvidoria.gerir')
  encaminhar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(encaminharSchema)) body: z.infer<typeof encaminharSchema>) {
    return this.ombudsman.encaminhar(ctx, id, body);
  }

  @Post('manifestacoes/:id/prorrogar')
  @HttpCode(200)
  @RequirePermission('ouvidoria.gerir')
  prorrogar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(motivoSchema)) body: z.infer<typeof motivoSchema>) {
    return this.ombudsman.prorrogar(ctx, id, body.reason);
  }

  @Post('manifestacoes/:id/responder')
  @HttpCode(200)
  @RequirePermission('ouvidoria.gerir')
  responder(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(textoSchema)) body: z.infer<typeof textoSchema>) {
    return this.ombudsman.responder(ctx, id, body.text);
  }

  @Post('manifestacoes/:id/encerrar')
  @HttpCode(200)
  @RequirePermission('ouvidoria.gerir')
  encerrar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(encerrarSchema)) body: z.infer<typeof encerrarSchema>) {
    return this.ombudsman.encerrar(ctx, id, body);
  }

  /** Unidades ativas para classificar e encaminhar manifestações (qualquer papel com acesso à ouvidoria). */
  @Get('unidades')
  @RequirePermission('ouvidoria.ler')
  unidades(@Ctx() ctx: RequestContext) {
    return ctx.db.unit.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, type: true } });
  }

  @Get('satisfacao')
  @RequirePermission('ouvidoria.ler')
  satisfacao(@Ctx() ctx: RequestContext, @Query(zv(painelSatisfacaoSchema)) q: z.infer<typeof painelSatisfacaoSchema>) {
    return this.satisfaction.painel(ctx, q);
  }
}

/** Ouvidoria e pesquisa de satisfação: cidadão (token do app). */
@Controller('cidadao')
export class CitizenOmbudsmanController {
  constructor(
    private readonly ombudsman: OmbudsmanService,
    private readonly satisfaction: SatisfactionService,
  ) {}

  @Get('ouvidoria')
  @CitizenRoute()
  minhas(@CitizenCtx() c: CitizenContext) {
    return this.ombudsman.minhas(c);
  }

  @Post('ouvidoria')
  @CitizenRoute()
  nova(@CitizenCtx() c: CitizenContext, @Body(zv(cidadaoNovaSchema)) body: z.infer<typeof cidadaoNovaSchema>) {
    return this.ombudsman.registrarPeloCidadao(c, body);
  }

  @Post('ouvidoria/:id/avaliar')
  @HttpCode(200)
  @CitizenRoute()
  avaliar(@CitizenCtx() c: CitizenContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(avaliarSchema)) body: z.infer<typeof avaliarSchema>) {
    return this.ombudsman.avaliar(c, id, body);
  }

  @Get('avaliacoes')
  @CitizenRoute()
  avaliacoes(@CitizenCtx() c: CitizenContext) {
    return this.satisfaction.pendentesDoCidadao(c);
  }

  @Post('avaliacoes/:id')
  @HttpCode(200)
  @CitizenRoute()
  responderPesquisa(@CitizenCtx() c: CitizenContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(responderPesquisaSchema)) body: z.infer<typeof responderPesquisaSchema>) {
    return this.satisfaction.responderPeloCidadao(c, id, body);
  }
}
