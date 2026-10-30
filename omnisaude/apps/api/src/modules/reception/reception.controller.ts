import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, Public, RequirePermission, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { ReceptionService } from './reception.service';

const issueSchema = z.object({ kind: z.enum(['NORMAL', 'PRIORIDADE']), sector: z.string().max(40).optional(), patientId: z.string().uuid().optional() });
const callSchema = z.object({ desk: z.string().min(1).max(40), sector: z.string().max(40).optional() });
const checkInSchema = z.object({ patientId: z.string().uuid(), kind: z.enum(['URGENCIA', 'AMBULATORIAL', 'ODONTOLOGICO']), ticketId: z.string().uuid().optional() });

@Controller('reception')
export class ReceptionController {
  constructor(private readonly reception: ReceptionService) {}

  @Post('tickets')
  @RequirePermission('fila.emitir')
  issue(@Ctx() ctx: RequestContext, @Body(zv(issueSchema)) body: z.infer<typeof issueSchema>) {
    return this.reception.issue(ctx, body);
  }

  @Get('tickets')
  @RequirePermission('fila.chamar')
  list(@Ctx() ctx: RequestContext, @Query('status') status?: string) {
    return this.reception.list(ctx, status);
  }

  @Post('tickets/call-next')
  @HttpCode(200)
  @RequirePermission('fila.chamar')
  callNext(@Ctx() ctx: RequestContext, @Body(zv(callSchema)) body: z.infer<typeof callSchema>) {
    return this.reception.callNext(ctx, body.desk, body.sector);
  }

  @Post('tickets/:id/call')
  @HttpCode(200)
  @RequirePermission('fila.chamar')
  call(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(callSchema)) body: z.infer<typeof callSchema>) {
    return this.reception.call(ctx, id, body.desk);
  }

  @Post('tickets/:id/absent')
  @HttpCode(200)
  @RequirePermission('fila.chamar')
  absent(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.reception.absent(ctx, id);
  }

  @Post('check-in')
  @RequirePermission('fila.emitir')
  checkIn(@Ctx() ctx: RequestContext, @Body(zv(checkInSchema)) body: z.infer<typeof checkInSchema>) {
    return this.reception.checkIn(ctx, body);
  }

  @Post('panel-token')
  @RequirePermission('fila.chamar')
  panelToken(@Ctx() ctx: RequestContext) {
    return this.reception.panelToken(ctx);
  }

  @Public()
  @Get('panel')
  panel(@Query('token') token: string) {
    return this.reception.panelState(token ?? '');
  }
}
