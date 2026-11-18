import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { DiagramaService } from './diagrama.service';
import { PopulacaoService } from './populacao.service';

const nivel = z.enum(['MUNICIPIO', 'LOCALIDADE', 'BAIRRO']);
const fonte = z.enum(['IBGE_DOU', 'RIPSA', 'CENSO_2022', 'MANUAL']);
const grupo = z
  .string()
  .trim()
  .regex(/^[a-z0-9-]{2,40}$/);
const ano = z.coerce.number().int().min(1990).max(2100);

const populacaoConsulta = z.object({ nivel: nivel.optional(), territorio: z.string().uuid().optional() });
const populacaoSchema = z.object({
  linhas: z
    .array(
      z.object({
        ano: z.number().int().min(1990).max(2100),
        nivel,
        territorioId: z.string().uuid().nullish(),
        populacao: z.number().int().min(1).max(2_000_000_000),
        fonte,
        versao: z.string().trim().max(20).optional(),
        nota: z.string().trim().max(500).nullish(),
      }),
    )
    .min(1)
    .max(2000),
});
const diagramaConsulta = z.object({
  grupo,
  nivel: nivel.default('MUNICIPIO'),
  territorio: z.string().uuid().optional(),
  ano,
  eixo: z.enum(['EPIDEMIOLOGICO', 'SAZONAL']).default('EPIDEMIOLOGICO'),
});
const congelarSchema = z.object({ grupo, nivel, territorio: z.string().uuid().nullish(), ano: z.number().int().min(1990).max(2100), nota: z.string().trim().max(1000).nullish() });
const receitaParcial = z
  .object({
    metodo: z.enum(['QUARTIS', 'MEDIA_DP']),
    quartil: z.enum(['EXC', 'INC']),
    k: z.number().positive().max(5),
    anos: z.number().int().min(1).max(20),
    janela: z.enum(['NENHUMA', 'AGRUPADA_5', 'SUAVIZADA_5']),
    borda: z.enum(['TRUNCADA', 'CIRCULAR', 'CONTINUA']),
    unidade: z.enum(['INCIDENCIA', 'CASOS']),
    base: z.enum(['PROVAVEIS', 'NOTIFICADOS', 'CONFIRMADOS']),
    anoEmAnaliseTodosNotificados: z.boolean(),
    incluiAnoEmAnalise: z.boolean(),
  })
  .partial();
const configuracaoSchema = z.object({
  modelo: z.enum(['MS_2025', 'NT_1_2023', 'VIGIEPI_2025', 'DIRETRIZES_2009']).nullable(),
  receita: receitaParcial.optional(),
  anosExcluidos: z.array(z.object({ ano: z.number().int().min(1990).max(2100), motivo: z.string().trim().min(10).max(500) })).max(30),
  fontePopulacao: fonte.nullable(),
  versaoPopulacao: z.string().trim().max(20).nullable(),
});
const anosEpidemicosConsulta = z.object({ grupo, ano });

/**
 * População e diagrama de controle (VIG-1c, §4.2; frente F3). Leitura com `vigilancia.resumo` ou `vigilancia.painel`;
 * gravação com `vigilancia.consolidacao`.
 */
@Controller('vigilancia')
export class DiagramaController {
  constructor(
    private readonly diagramas: DiagramaService,
    private readonly populacao: PopulacaoService,
  ) {}

  @Get('populacao')
  @RequirePermission('vigilancia.resumo', 'vigilancia.painel')
  listarPopulacao(@Ctx() ctx: RequestContext, @Query(zv(populacaoConsulta)) q: z.infer<typeof populacaoConsulta>) {
    return this.populacao.listar(ctx, q);
  }

  @Put('populacao')
  @RequirePermission('vigilancia.consolidacao')
  salvarPopulacao(@Ctx() ctx: RequestContext, @Body(zv(populacaoSchema)) body: z.infer<typeof populacaoSchema>) {
    return this.populacao.salvar(ctx, { linhas: body.linhas.map((l) => ({ ...l, territorioId: l.territorioId ?? null })) });
  }

  @Delete('populacao/:id')
  @RequirePermission('vigilancia.consolidacao')
  removerPopulacao(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.populacao.remover(ctx, id);
  }

  @Get('diagrama')
  @RequirePermission('vigilancia.resumo', 'vigilancia.painel')
  diagrama(@Ctx() ctx: RequestContext, @Query(zv(diagramaConsulta)) q: z.infer<typeof diagramaConsulta>) {
    return this.diagramas.diagrama(ctx, q);
  }

  /** O canal em CSV (';' e vírgula decimal) com as fórmulas do Excel equivalentes, para refazer a conta. */
  @Get('diagrama.csv')
  @RequirePermission('vigilancia.resumo', 'vigilancia.painel')
  async diagramaCsv(@Ctx() ctx: RequestContext, @Query(zv(diagramaConsulta)) q: z.infer<typeof diagramaConsulta>, @Res() res: Response) {
    const r = await this.diagramas.csv(ctx, q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${r.fileName}"`);
    res.send(r.content);
  }

  @Post('diagrama/congelar')
  @RequirePermission('vigilancia.consolidacao')
  congelar(@Ctx() ctx: RequestContext, @Body(zv(congelarSchema)) body: z.infer<typeof congelarSchema>) {
    return this.diagramas.congelar(ctx, { ...body, territorio: body.territorio ?? null });
  }

  @Get('diagrama/configuracao/:grupo')
  @RequirePermission('vigilancia.resumo', 'vigilancia.painel')
  configuracao(@Ctx() ctx: RequestContext, @Param('grupo', zv(grupo)) g: string) {
    return this.diagramas.configuracao(ctx, g);
  }

  @Put('diagrama/configuracao/:grupo')
  @RequirePermission('vigilancia.consolidacao')
  salvarConfiguracao(@Ctx() ctx: RequestContext, @Param('grupo', zv(grupo)) g: string, @Body(zv(configuracaoSchema)) body: z.infer<typeof configuracaoSchema>) {
    return this.diagramas.salvarConfiguracao(ctx, g, body);
  }

  @Get('diagrama/anos-epidemicos')
  @RequirePermission('vigilancia.resumo', 'vigilancia.painel')
  anosEpidemicos(@Ctx() ctx: RequestContext, @Query(zv(anosEpidemicosConsulta)) q: z.infer<typeof anosEpidemicosConsulta>) {
    return this.diagramas.anosEpidemicos(ctx, q);
  }
}
