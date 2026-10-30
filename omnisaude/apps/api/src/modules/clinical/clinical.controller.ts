import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ROUTES_OF_ADMINISTRATION } from '@omnisaude/shared';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { ClinicalService } from './clinical.service';

const code = z.object({ system: z.enum(['CID10', 'CIAP2']), code: z.string().regex(/^[A-Za-z]\d{2}(\.?\d{1,2})?$/) });
const noteSchema = z.object({
  kind: z.enum(['SOAP', 'EVOLUCAO', 'ODONTOGRAMA', 'LAUDO_INTERNACAO']),
  subjective: z.string().max(20_000).optional(),
  objective: z.string().max(20_000).optional(),
  assessment: z.string().max(20_000).optional(),
  plan: z.string().max(20_000).optional(),
  codes: z.array(code).max(20).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
const itemSchema = z.object({
  productId: z.string().uuid().optional(),
  description: z.string().min(2).max(300),
  activeIngredient: z.string().max(200).optional(),
  dose: z.number().positive().optional(),
  doseUnit: z.string().max(20).optional(),
  route: z.enum(ROUTES_OF_ADMINISTRATION).optional(),
  frequencyHours: z.number().int().min(1).max(168).optional(),
  durationDays: z.number().int().min(1).max(365).optional(),
  quantity: z.number().positive().optional(),
  instructions: z.string().max(1000).optional(),
});
const prescribeSchema = z.object({ kind: z.enum(['AMBULATORIAL', 'HOSPITALAR']).optional(), items: z.array(itemSchema).min(1).max(30), justification: z.string().max(2000).optional() });
const checkSchema = z.object({ patientId: z.string().uuid(), items: z.array(itemSchema).min(1).max(30) });
const closeSchema = z.object({ outcome: z.enum(['ALTA', 'INTERNACAO', 'ENCAMINHAMENTO', 'TRANSFERENCIA', 'OBITO', 'EVASAO']), mainCid: z.string().max(5).optional() });
const examsSchema = z.object({ items: z.array(z.object({ sigtapCode: z.string().min(10).max(14), name: z.string().min(2), analyte: z.string().max(30).optional() })).min(1).max(30) });
const resultSchema = z.object({ value: z.number().optional(), unit: z.string().max(20).optional(), text: z.string().max(5000).optional() });
const certificateSchema = z.object({ days: z.number().int().min(1).max(365), cid: z.string().max(5).optional(), includeCid: z.boolean(), text: z.string().max(2000).optional() });
const vaccineSchema = z.object({
  patientId: z.string().uuid(),
  vaccineCode: z.string().min(1),
  vaccineName: z.string().min(2),
  lot: z.string().min(1),
  manufacturer: z.string().min(1),
  dose: z.string().min(1),
  route: z.string().min(2),
  site: z.string().optional(),
  appliedAt: z.string().datetime({ offset: true }).optional(),
});

@Controller('clinical')
export class ClinicalController {
  constructor(private readonly clinical: ClinicalService) {}

  @Get('encounters/:id')
  @RequirePermission('prontuario.ler')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.clinical.get(ctx, id);
  }

  @Post('encounters/:id/start')
  @HttpCode(200)
  @RequirePermission('prontuario.evoluir')
  start(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.clinical.start(ctx, id);
  }

  @Post('encounters/:id/notes')
  @RequirePermission('prontuario.evoluir')
  createNote(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(noteSchema)) body: z.infer<typeof noteSchema>) {
    return this.clinical.createNote(ctx, id, body);
  }

  @Patch('notes/:id')
  @RequirePermission('prontuario.evoluir')
  updateNote(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(noteSchema.partial())) body: Partial<z.infer<typeof noteSchema>>) {
    return this.clinical.updateNote(ctx, id, body);
  }

  @Delete('notes/:id')
  @RequirePermission('prontuario.evoluir')
  deleteNote(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.clinical.deleteDraft(ctx, id);
  }

  @Post('notes/:id/sign')
  @HttpCode(200)
  @RequirePermission('prontuario.evoluir')
  sign(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.clinical.signNote(ctx, id);
  }

  @Post('encounters/:id/close')
  @HttpCode(200)
  @RequirePermission('prontuario.encerrar')
  close(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(closeSchema)) body: z.infer<typeof closeSchema>) {
    return this.clinical.close(ctx, id, body);
  }

  @Post('prescriptions/check')
  @HttpCode(200)
  @RequirePermission('prescricao.emitir')
  check(@Ctx() ctx: RequestContext, @Body(zv(checkSchema)) body: z.infer<typeof checkSchema>) {
    return this.clinical.checkPrescription(ctx, body.patientId, body.items);
  }

  @Post('encounters/:id/prescriptions')
  @RequirePermission('prescricao.emitir')
  prescribe(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(prescribeSchema)) body: z.infer<typeof prescribeSchema>) {
    return this.clinical.prescribe(ctx, id, body);
  }

  @Post('prescriptions/:id/items/:itemId/suspend')
  @HttpCode(200)
  @RequirePermission('prescricao.emitir')
  suspend(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body(zv(z.object({ reason: z.string().min(3) }))) body: { reason: string }) {
    return this.clinical.suspendItem(ctx, id, itemId, body.reason);
  }

  @Get('patients/:id/prescriptions')
  @RequirePermission('prontuario.ler')
  prescriptions(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query('active') active?: string) {
    return this.clinical.patientPrescriptions(ctx, id, active === 'true');
  }

  @Post('encounters/:id/exams')
  @RequirePermission('exame.solicitar')
  exams(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(examsSchema)) body: z.infer<typeof examsSchema>) {
    return this.clinical.requestExams(ctx, id, body.items);
  }

  @Post('exams/:id/result')
  @HttpCode(200)
  @RequirePermission('prontuario.evoluir')
  result(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(resultSchema)) body: z.infer<typeof resultSchema>) {
    return this.clinical.recordResult(ctx, id, body);
  }

  @Get('protocols')
  @RequirePermission('prontuario.ler')
  protocol(@Query('code') codeParam: string, @Query('system') system?: 'CID10' | 'CIAP2') {
    return this.clinical.carePathway(codeParam ?? '', system === 'CIAP2' ? 'CIAP2' : 'CID10');
  }

  @Post('encounters/:id/protocol-exams')
  @RequirePermission('exame.solicitar')
  protocolExams(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(code)) body: z.infer<typeof code>) {
    return this.clinical.requestPathwayExams(ctx, id, body.code, body.system);
  }

  @Post('soap-from-transcript')
  @HttpCode(200)
  @RequirePermission('prontuario.evoluir')
  soap(@Ctx() ctx: RequestContext, @Body(zv(z.object({ transcript: z.string().min(3).max(50_000), useAi: z.boolean().optional() }))) body: { transcript: string; useAi?: boolean }) {
    return this.clinical.soapFromTranscript(ctx, body.transcript, body.useAi ?? true);
  }

  @Post('transcribe')
  @HttpCode(200)
  @RequirePermission('prontuario.evoluir')
  transcribe(@Ctx() ctx: RequestContext, @Body(zv(z.object({ audio: z.string().max(25_000_000), mimeType: z.string() }))) body: { audio: string; mimeType: string }) {
    return this.clinical.transcribe(ctx, body.audio, body.mimeType);
  }

  @Post('voice-command')
  @HttpCode(200)
  @RequirePermission('prontuario.ler', 'fila.chamar')
  voice(@Body(zv(z.object({ text: z.string().min(1).max(500) }))) body: { text: string }) {
    return this.clinical.voiceCommand(body.text);
  }

  @Post('encounters/:id/certificate')
  @RequirePermission('prontuario.encerrar')
  certificate(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(certificateSchema)) body: z.infer<typeof certificateSchema>) {
    return this.clinical.certificate(ctx, id, body);
  }

  @Post('vaccinations')
  @RequirePermission('prontuario.evoluir')
  vaccinate(@Ctx() ctx: RequestContext, @Body(zv(vaccineSchema)) body: z.infer<typeof vaccineSchema>) {
    return this.clinical.vaccinate(ctx, body);
  }
}
