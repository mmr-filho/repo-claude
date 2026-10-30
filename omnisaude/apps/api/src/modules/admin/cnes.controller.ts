import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { UNIT_TYPES } from '@omnisaude/shared';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { CnesService } from './cnes.service';

const ibgeSchema = z.object({ ibgeCode: z.string().regex(/^\d{6,7}$/, 'Código IBGE com 6 ou 7 dígitos') });
const csvSchema = z.object({ csv: z.string().min(10).max(10_000_000) });
const applySchema = z.object({
  cnes: z.array(z.string().regex(/^\d{1,7}$/)).max(5000).optional(),
  types: z.record(z.string(), z.enum(UNIT_TYPES)).optional(),
  updateNames: z.boolean().optional(),
  createAccess: z.boolean().optional(),
});
const stagedQuery = z.object({ q: z.string().max(80).optional(), unitId: z.string().uuid().optional() });

/** Importação do CNES (estabelecimentos pela API do DATASUS; profissionais e equipes por planilha). */
@Controller('admin/cnes')
export class CnesController {
  constructor(private readonly cnes: CnesService) {}

  @Post('estabelecimentos/previa')
  @RequirePermission('cadastros.unidades')
  @HttpCode(200)
  previewEstablishments(@Ctx() ctx: RequestContext, @Body(zv(ibgeSchema)) body: z.infer<typeof ibgeSchema>) {
    return this.cnes.previewEstablishments(ctx, body.ibgeCode);
  }

  @Post('profissionais/previa')
  @RequirePermission('cadastros.profissionais')
  @HttpCode(200)
  previewProfessionals(@Ctx() ctx: RequestContext, @Body(zv(csvSchema)) body: z.infer<typeof csvSchema>) {
    return this.cnes.previewProfessionals(ctx, body.csv);
  }

  @Post('equipes/previa')
  @RequirePermission('cadastros.profissionais')
  @HttpCode(200)
  previewTeams(@Ctx() ctx: RequestContext, @Body(zv(csvSchema)) body: z.infer<typeof csvSchema>) {
    return this.cnes.previewTeams(ctx, body.csv);
  }

  /** Aplica uma prévia; a permissão exigida depende do tipo (unidades ou profissionais/equipes). */
  @Post('imports/:id/aplicar')
  @RequirePermission('cadastros.unidades', 'cadastros.profissionais')
  @HttpCode(200)
  async apply(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(applySchema)) body: z.infer<typeof applySchema>) {
    const imp = await ctx.db.cnesImport.findUnique({ where: { id }, select: { kind: true } });
    if (imp?.kind === 'PROFISSIONAIS') return this.cnes.applyProfessionals(ctx, id, { createAccess: body.createAccess ?? false });
    if (imp?.kind === 'EQUIPES') return this.cnes.applyTeams(ctx, id);
    return this.cnes.applyEstablishments(ctx, id, { cnes: body.cnes ?? [], types: body.types, updateNames: body.updateNames });
  }

  @Get('imports')
  @RequirePermission('cadastros.unidades', 'cadastros.profissionais')
  imports(@Ctx() ctx: RequestContext) {
    return this.cnes.listImports(ctx);
  }

  @Get('modelos/:kind')
  @RequirePermission('cadastros.profissionais')
  template(@Param('kind') kind: string) {
    return this.cnes.template(kind === 'equipes' ? 'equipes' : 'profissionais');
  }

  @Get('pre-cadastro')
  @RequirePermission('cadastros.profissionais')
  staged(@Ctx() ctx: RequestContext, @Query(zv(stagedQuery)) q: z.infer<typeof stagedQuery>) {
    return this.cnes.listStaged(ctx, q);
  }

  @Patch('pre-cadastro/:id/ignorar')
  @RequirePermission('cadastros.profissionais')
  ignore(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.cnes.ignoreStaged(ctx, id);
  }
}
