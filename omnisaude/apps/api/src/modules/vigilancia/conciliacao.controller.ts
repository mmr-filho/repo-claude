import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { ConciliacaoService } from './conciliacao.service';

/** Data de calendário que existe (ida e volta pelo Date.UTC: 2025-13-01 e 2025-02-30 são recusadas com 400). */
const dataExiste = (s: string) => {
  const [a, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(a, m - 1, d));
  return a >= 1900 && t.getUTCFullYear() === a && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const dia = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD')
  .refine(dataExiste, 'Data que não existe no calendário');
const candidatasSchema = z
  .object({
    sistema: z.enum(['SINAN_NET', 'SINAN_ONLINE', 'ESUS_SINAN', 'ESUS_NOTIFICA', 'SIVEP_GRIPE', 'SINASC_SIM']).optional(),
    grupo: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{2,40}$/)
      .optional(),
    de: dia.optional(),
    ate: dia.optional(),
    busca: z.string().trim().max(60).optional(),
    pagina: z.coerce.number().int().min(1).max(100_000).optional(),
  })
  .refine((p) => !p.de || !p.ate || p.de <= p.ate, { message: 'O início do período não pode ser depois do fim', path: ['ate'] });

/**
 * Rotas da conciliação que não dependem da importação (VIG-1c, §4.1). As listas, o resumo e as ações continuam em
 * ImportacaoController, com a mesma permissão `vigilancia.importar`.
 */
@Controller('vigilancia')
export class ConciliacaoController {
  constructor(private readonly conciliacao: ConciliacaoService) {}

  /**
   * Notificações que o diálogo "Vincular…" do registro oficial oferece: NOTIFICADA/ENCERRADA sem vínculo, com os
   * filtros e o sigilo do "só no OmniSaúde", mas sem a cobertura das importações (`?sistema=&grupo=&de=&ate=&busca=&pagina=`;
   * o grupo vale com os grupos do mesmo agravo do Sinan).
   */
  @Get('conciliacao/candidatas')
  @RequirePermission('vigilancia.importar')
  candidatas(@Ctx() ctx: RequestContext, @Query(zv(candidatasSchema)) q: z.infer<typeof candidatasSchema>) {
    return this.conciliacao.candidatas(ctx, q);
  }
}
