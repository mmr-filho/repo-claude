import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { DomainError } from '../../core/errors';
import { zv } from '../../core/zod';
import { ProgramsService } from './programs.service';

const PROGRAMAS = ['PRE_NATAL', 'PUERICULTURA', 'HAS_DM', 'IDOSO', 'MULHER', 'BOLSA_FAMILIA', 'SISVAN', 'TB_HANSENIASE'] as const;
const flag = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();
const escopoSchema = z.object({ unitId: z.string().uuid().optional(), teamId: z.string().uuid().optional() });
const listaSchema = escopoSchema.extend({ faltosos: flag });
const estratificarSchema = z.object({
  patientId: z.string().uuid(),
  kind: z.enum(['GESTANTE', 'PE_DIABETICO', 'MCHAT']),
  answers: z.union([z.array(z.string().max(40)).max(60), z.record(z.string(), z.boolean())]),
  encounterId: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
});

/** Programas da APS (ações programáticas, faltosos e estratificações de risco). */
@Controller('programas')
export class ProgramsController {
  constructor(private readonly programs: ProgramsService) {}

  @Get()
  @RequirePermission('aps.programas')
  programas() {
    return this.programs.programas();
  }

  @Get('equipes')
  @RequirePermission('aps.programas')
  equipes(@Ctx() ctx: RequestContext) {
    return this.programs.equipes(ctx);
  }

  @Get('resumo')
  @RequirePermission('aps.programas')
  resumo(@Ctx() ctx: RequestContext, @Query(zv(escopoSchema)) q: z.infer<typeof escopoSchema>) {
    return this.programs.resumo(ctx, q);
  }

  @Get('estratificacoes')
  @RequirePermission('prontuario.ler')
  estratificacoes(@Ctx() ctx: RequestContext, @Query('patientId', ParseUUIDPipe) patientId: string) {
    return this.programs.estratificacoes(ctx, patientId);
  }

  @Post('estratificacoes')
  @RequirePermission('prontuario.evoluir')
  estratificar(@Ctx() ctx: RequestContext, @Body(zv(estratificarSchema)) body: z.infer<typeof estratificarSchema>) {
    return this.programs.estratificar(ctx, body);
  }

  @Get(':codigo')
  @RequirePermission('aps.programas')
  lista(@Ctx() ctx: RequestContext, @Param('codigo') codigo: string, @Query(zv(listaSchema)) q: z.infer<typeof listaSchema>) {
    const parsed = z.enum(PROGRAMAS).safeParse(codigo);
    if (!parsed.success) throw new DomainError('PROGRAMA_INVALIDO', `Programa desconhecido: ${codigo}`, 404);
    return this.programs.lista(ctx, parsed.data, q, q.faltosos ?? false);
  }
}
