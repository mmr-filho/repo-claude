import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { AssistantService } from './assistant.service';

const listarSchema = z.object({ status: z.enum(['ABERTA', 'AGUARDANDO_ATENDENTE', 'ENCERRADA']).optional(), busca: z.string().trim().max(80).optional() });
const responderSchema = z.object({ texto: z.string().trim().min(1).max(2000) });

/** Tela da equipe: conversas do assistente do WhatsApp, pedidos de atendente e respostas humanas. */
@Controller('assistente')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('painel')
  @RequirePermission('assistente.ler')
  painel(@Ctx() ctx: RequestContext) {
    return this.assistant.painel(ctx);
  }

  @Get('conversas')
  @RequirePermission('assistente.ler')
  conversas(@Ctx() ctx: RequestContext, @Query(zv(listarSchema)) q: z.infer<typeof listarSchema>) {
    return this.assistant.conversas(ctx, q);
  }

  @Get('conversas/:id')
  @RequirePermission('assistente.ler')
  conversa(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistant.conversa(ctx, id);
  }

  @Post('conversas/:id/responder')
  @HttpCode(200)
  @RequirePermission('assistente.responder')
  responder(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(responderSchema)) body: z.infer<typeof responderSchema>) {
    return this.assistant.responder(ctx, id, body.texto);
  }

  @Post('conversas/:id/encerrar')
  @HttpCode(200)
  @RequirePermission('assistente.responder')
  encerrar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistant.encerrar(ctx, id);
  }
}
