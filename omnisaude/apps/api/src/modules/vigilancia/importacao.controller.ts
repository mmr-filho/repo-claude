import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { DomainError } from '../../core/errors';
import { rawBody } from '../../core/raw-body';
import { zv } from '../../core/zod';
import { ConciliacaoService } from './conciliacao.service';
import { ImportacaoService } from './importacao.service';

/** Teto do arquivo enviado (zip, DBF ou CSV), antes de descompactar. */
const LIMITE_ENVIO_BYTES = 95 * 1024 * 1024;

const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');
const sistema = z.enum(['SINAN_NET', 'SINAN_ONLINE', 'ESUS_SINAN', 'ESUS_NOTIFICA', 'SIVEP_GRIPE', 'SINASC_SIM']);
const envioSchema = z.object({
  nome: z.string().trim().min(1).max(255),
  de: dia.optional(),
  ate: dia.optional(),
  codificacao: z.enum(['CP850', 'CP437', 'CP860', 'CP1252', 'UTF8']).optional(),
});
const filtroSchema = z.object({
  sistema: sistema.optional(),
  grupo: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,40}$/)
    .optional(),
  de: dia.optional(),
  ate: dia.optional(),
  busca: z.string().trim().max(60).optional(),
  pagina: z.coerce.number().int().min(1).max(100_000).optional(),
});
const vincularSchema = z.object({
  recordId: z.string().uuid(),
  notificationId: z.string().uuid(),
  motivo: z.string().trim().max(1000).nullish(),
  preencherNumeroOficial: z.boolean().optional(),
});
const desvincularSchema = z.object({ recordId: z.string().uuid(), motivo: z.string().trim().min(10).max(1000) });
const rejeitarSchema = z.object({ recordId: z.string().uuid(), notificationId: z.string().uuid(), motivo: z.string().trim().min(10).max(1000) });
const apelidoSchema = z.object({ nome: z.string().trim().min(2).max(120), neighborhoodId: z.string().uuid() });

/**
 * Importação das exportações oficiais e conciliação (VIG-1c, §4.1; frente F2). Permissão `vigilancia.importar` em todas
 * (o apelido de bairro exige também `territorio.editar`, conferido no serviço).
 */
@Controller('vigilancia')
export class ImportacaoController {
  constructor(
    private readonly importacoes: ImportacaoService,
    private readonly conciliacao: ConciliacaoService,
  ) {}

  /**
   * Envio do arquivo cru (zip, DBF ou CSV; até 95 MB) com `?nome=&de=&ate=&codificacao=`. Cria a prévia (201) ou, se o
   * mesmo arquivo já foi aplicado, responde 200 com `{ jaImportado }` sem criar nada.
   */
  @Post('importacoes')
  @RequirePermission('vigilancia.importar')
  async enviar(@Ctx() ctx: RequestContext, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Query(zv(envioSchema)) q: z.infer<typeof envioSchema>) {
    const tipo = (req.headers['content-type'] ?? '').toLowerCase();
    if (/json|xml|text\/plain|form/.test(tipo)) throw new DomainError('FORMATO', 'Envie o arquivo cru (application/octet-stream, zip ou csv)', 415);
    const arquivo = await rawBody(req, LIMITE_ENVIO_BYTES);
    const r = await this.importacoes.enviar(ctx, arquivo, q);
    if ('jaImportado' in r) res.status(200);
    return r;
  }

  @Get('importacoes')
  @RequirePermission('vigilancia.importar')
  listar(@Ctx() ctx: RequestContext) {
    return this.importacoes.listar(ctx);
  }

  @Get('importacoes/:id')
  @RequirePermission('vigilancia.importar')
  detalhe(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.importacoes.detalhe(ctx, id);
  }

  @Post('importacoes/:id/aplicar')
  @HttpCode(200)
  @RequirePermission('vigilancia.importar')
  aplicar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.importacoes.aplicar(ctx, id);
  }

  @Post('importacoes/:id/descartar')
  @HttpCode(200)
  @RequirePermission('vigilancia.importar')
  descartar(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.importacoes.descartar(ctx, id);
  }

  // ── Conciliação ──

  @Get('conciliacao/resumo')
  @RequirePermission('vigilancia.importar')
  resumo(@Ctx() ctx: RequestContext) {
    return this.conciliacao.resumo(ctx);
  }

  @Get('conciliacao/so-oficial')
  @RequirePermission('vigilancia.importar')
  soOficial(@Ctx() ctx: RequestContext, @Query(zv(filtroSchema)) q: z.infer<typeof filtroSchema>) {
    return this.conciliacao.soOficial(ctx, q);
  }

  @Get('conciliacao/so-omnisaude')
  @RequirePermission('vigilancia.importar')
  soOmnisaude(@Ctx() ctx: RequestContext, @Query(zv(filtroSchema)) q: z.infer<typeof filtroSchema>) {
    return this.conciliacao.soOmnisaude(ctx, q);
  }

  @Get('conciliacao/divergentes')
  @RequirePermission('vigilancia.importar')
  divergentes(@Ctx() ctx: RequestContext, @Query(zv(filtroSchema)) q: z.infer<typeof filtroSchema>) {
    return this.conciliacao.divergentes(ctx, q);
  }

  @Get('conciliacao/sugestoes')
  @RequirePermission('vigilancia.importar')
  sugestoes(@Ctx() ctx: RequestContext, @Query(zv(filtroSchema)) q: z.infer<typeof filtroSchema>) {
    return this.conciliacao.sugestoes(ctx, q);
  }

  @Get('conciliacao/bairros')
  @RequirePermission('vigilancia.importar')
  bairros(@Ctx() ctx: RequestContext) {
    return this.conciliacao.bairros(ctx);
  }

  @Post('conciliacao/vincular')
  @HttpCode(200)
  @RequirePermission('vigilancia.importar')
  vincular(@Ctx() ctx: RequestContext, @Body(zv(vincularSchema)) body: z.infer<typeof vincularSchema>) {
    return this.conciliacao.vincular(ctx, body);
  }

  @Post('conciliacao/desvincular')
  @HttpCode(200)
  @RequirePermission('vigilancia.importar')
  desvincular(@Ctx() ctx: RequestContext, @Body(zv(desvincularSchema)) body: z.infer<typeof desvincularSchema>) {
    return this.conciliacao.desvincular(ctx, body);
  }

  @Post('conciliacao/rejeitar')
  @HttpCode(200)
  @RequirePermission('vigilancia.importar')
  rejeitar(@Ctx() ctx: RequestContext, @Body(zv(rejeitarSchema)) body: z.infer<typeof rejeitarSchema>) {
    return this.conciliacao.rejeitar(ctx, body);
  }

  @Post('conciliacao/bairros/apelido')
  @HttpCode(200)
  @RequirePermission('vigilancia.importar')
  apelidoBairro(@Ctx() ctx: RequestContext, @Body(zv(apelidoSchema)) body: z.infer<typeof apelidoSchema>) {
    return this.conciliacao.apelidoBairro(ctx, body);
  }
}
