import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { RISK_COLORS, RISK_FLAGS, type RiskFlag } from '@omnisaude/shared';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { TriageService, type TriageInput } from './triage.service';

const vitals = {
  systolic: z.number().int().min(30).max(300).optional(),
  diastolic: z.number().int().min(10).max(200).optional(),
  heartRate: z.number().int().min(10).max(300).optional(),
  respiratoryRate: z.number().int().min(2).max(80).optional(),
  temperature: z.number().min(25).max(45).optional(),
  spo2: z.number().int().min(30).max(100).optional(),
  glucose: z.number().int().min(10).max(1500).optional(),
  painScore: z.number().int().min(0).max(10).optional(),
};
const flags = z.array(z.enum(Object.keys(RISK_FLAGS) as [RiskFlag, ...RiskFlag[]])).optional();
const suggestSchema = z.object({ ...vitals, flags });
const triageSchema = z.object({
  ...vitals,
  flags,
  complaint: z.string().min(3).max(500),
  weightKg: z.number().min(0.3).max(400).optional(),
  heightCm: z.number().int().min(20).max(250).optional(),
  painMap: z
    .array(z.object({ view: z.enum(['FRENTE', 'COSTAS']), region: z.string().min(2).max(40), x: z.number().min(0).max(1), y: z.number().min(0).max(1), intensity: z.number().int().min(0).max(10) }))
    .max(30)
    .optional(),
  vulnerability: z.string().max(500).optional(),
  riskColor: z.enum(RISK_COLORS).optional(),
  overrideReason: z.string().max(500).optional(),
});

@Controller('triage')
export class TriageController {
  constructor(private readonly triage: TriageService) {}

  @Get('queue')
  @RequirePermission('fila.chamar')
  queue(@Ctx() ctx: RequestContext) {
    return this.triage.queue(ctx);
  }

  @Post('suggest')
  @HttpCode(200)
  @RequirePermission('triagem.registrar')
  suggest(@Body(zv(suggestSchema)) body: z.infer<typeof suggestSchema>) {
    return this.triage.suggest(body);
  }

  @Post('encounters/:id')
  @RequirePermission('triagem.registrar')
  classify(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(triageSchema)) body: TriageInput) {
    return this.triage.classify(ctx, id, body);
  }
}
