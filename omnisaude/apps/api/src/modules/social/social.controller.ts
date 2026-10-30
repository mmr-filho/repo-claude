import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { CONTACT_ACTIONS, CONTACT_CHANNELS, LINES_OF_CARE, SocialService, VULNERABILITIES } from './social.service';

const panelSchema = z.object({ lineOfCare: z.enum(LINES_OF_CARE).optional() });
const caseSchema = z.object({ patientId: z.string().uuid(), lineOfCare: z.enum(LINES_OF_CARE) });
const listSchema = z.object({ status: z.enum(['ABERTO', 'EM_CONTATO', 'AGENDADO', 'ENCERRADO']).optional() });
const contactSchema = z.object({
  channel: z.enum(CONTACT_CHANNELS),
  outcome: z.string().min(2).max(500),
  vulnerabilities: z.array(z.enum(VULNERABILITIES)).default([]),
  actions: z.array(z.enum(CONTACT_ACTIONS)).default([]),
  notes: z.string().max(4000).optional(),
});
const closeSchema = z.object({ reason: z.string().min(3).max(500) });

@Controller('social')
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Get('active-search')
  @RequirePermission('busca_ativa.gerir')
  panel(@Ctx() ctx: RequestContext, @Query(zv(panelSchema)) q: z.infer<typeof panelSchema>) {
    return this.social.panel(ctx, q.lineOfCare);
  }

  @Post('cases')
  @RequirePermission('busca_ativa.gerir')
  open(@Ctx() ctx: RequestContext, @Body(zv(caseSchema)) body: z.infer<typeof caseSchema>) {
    return this.social.openCase(ctx, body);
  }

  @Get('cases')
  @RequirePermission('busca_ativa.gerir')
  list(@Ctx() ctx: RequestContext, @Query(zv(listSchema)) q: z.infer<typeof listSchema>) {
    return this.social.listCases(ctx, q.status);
  }

  @Get('cases/:id')
  @RequirePermission('busca_ativa.gerir')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.social.getCase(ctx, id);
  }

  @Post('cases/:id/contacts')
  @RequirePermission('busca_ativa.gerir')
  contact(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(contactSchema)) body: z.infer<typeof contactSchema>) {
    return this.social.addContact(ctx, id, body);
  }

  @Post('cases/:id/close')
  @HttpCode(200)
  @RequirePermission('busca_ativa.gerir')
  close(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(closeSchema)) body: z.infer<typeof closeSchema>) {
    return this.social.closeCase(ctx, id, body.reason);
  }
}
