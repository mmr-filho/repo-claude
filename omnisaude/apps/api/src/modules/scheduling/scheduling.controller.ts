import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { SchedulingService } from './scheduling.service';

const time = z.string().regex(/^\d{2}:\d{2}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const scheduleSchema = z.object({
  professionalId: z.string().uuid(),
  name: z.string().min(3),
  cbo: z.string().regex(/^\d{6}$/),
  slotMinutes: z.number().int().min(5).max(120),
  unitId: z.string().uuid().optional(),
  rules: z.array(z.object({ weekday: z.number().int().min(0).max(6), startTime: time, endTime: time, firstVisitQuota: z.number().int().min(0), returnQuota: z.number().int().min(0) })).min(1),
});
const blockSchema = z.object({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), reason: z.string().min(3) });
const bookSchema = z.object({ scheduleId: z.string().uuid(), patientId: z.string().uuid(), startsAt: z.string().datetime({ offset: true }), kind: z.enum(['PRIMEIRA_CONSULTA', 'RETORNO']), notes: z.string().optional() });
const listSchema = z.object({ date: date.optional(), scheduleId: z.string().uuid().optional(), status: z.string().optional(), patientId: z.string().uuid().optional() });
const waitlistSchema = z.object({ patientId: z.string().uuid(), cbo: z.string().regex(/^\d{6}$/), priority: z.number().int().min(0).max(10).optional(), reason: z.string().optional() });

@Controller('scheduling')
export class SchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Get('schedules')
  @RequirePermission('agenda.ler')
  schedules(@Ctx() ctx: RequestContext, @Query('unitId') unitId?: string) {
    return this.scheduling.listSchedules(ctx, unitId);
  }

  @Post('schedules')
  @RequirePermission('agenda.gerir')
  createSchedule(@Ctx() ctx: RequestContext, @Body(zv(scheduleSchema)) body: z.infer<typeof scheduleSchema>) {
    return this.scheduling.createSchedule(ctx, body);
  }

  @Post('schedules/:id/blocks')
  @RequirePermission('agenda.gerir')
  block(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(blockSchema)) body: z.infer<typeof blockSchema>) {
    return this.scheduling.addBlock(ctx, id, body);
  }

  @Get('schedules/:id/slots')
  @RequirePermission('agenda.ler')
  slots(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Query('date') day?: string) {
    return this.scheduling.slots(ctx, id, day ?? this.scheduling.today(ctx));
  }

  @Get('appointments')
  @RequirePermission('agenda.ler')
  list(@Ctx() ctx: RequestContext, @Query(zv(listSchema)) q: z.infer<typeof listSchema>) {
    return this.scheduling.list(ctx, q);
  }

  @Post('appointments')
  @RequirePermission('agenda.marcar')
  book(@Ctx() ctx: RequestContext, @Body(zv(bookSchema)) body: z.infer<typeof bookSchema>) {
    return this.scheduling.book(ctx, body, ctx.session.userId);
  }

  @Post('appointments/:id/confirm')
  @HttpCode(200)
  @RequirePermission('agenda.marcar')
  confirm(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.scheduling.confirm(ctx, id, 'RECEPCAO');
  }

  @Post('appointments/:id/cancel')
  @HttpCode(200)
  @RequirePermission('agenda.marcar')
  cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(z.object({ reason: z.string().min(3) }))) body: { reason: string }) {
    return this.scheduling.cancel(ctx, id, body.reason);
  }

  @Post('appointments/:id/no-show')
  @HttpCode(200)
  @RequirePermission('agenda.marcar')
  noShow(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.scheduling.noShow(ctx, id);
  }

  @Post('appointments/:id/check-in')
  @RequirePermission('agenda.marcar')
  checkIn(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.scheduling.checkIn(ctx, id);
  }

  @Post('appointments/:id/reschedule')
  @RequirePermission('agenda.marcar')
  reschedule(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(z.object({ startsAt: z.string().datetime({ offset: true }) }))) body: { startsAt: string }) {
    return this.scheduling.reschedule(ctx, id, body.startsAt, ctx.session.userId);
  }

  @Get('waitlist')
  @RequirePermission('agenda.ler')
  waitlist(@Ctx() ctx: RequestContext, @Query('status') status?: string) {
    return this.scheduling.waitlist(ctx, status);
  }

  @Post('waitlist')
  @RequirePermission('agenda.marcar')
  addWaitlist(@Ctx() ctx: RequestContext, @Body(zv(waitlistSchema)) body: z.infer<typeof waitlistSchema>) {
    return this.scheduling.addToWaitlist(ctx, body);
  }

  @Get('absenteeism')
  @RequirePermission('agenda.ler')
  absenteeism(@Ctx() ctx: RequestContext, @Query('from') from: string, @Query('to') to: string) {
    return this.scheduling.absenteeism(ctx, from, to);
  }
}
