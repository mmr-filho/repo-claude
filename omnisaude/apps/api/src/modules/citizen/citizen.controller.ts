import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CitizenCtx, CitizenRoute, clientIp, Ctx, Public, RequirePermission, type CitizenContext, type RequestContext } from '../../core/context';
import { zv } from '../../core/zod';
import { resumoMeuSusDigital } from '../integrations/meu-sus-digital';
import { CitizenAuthService } from './citizen-auth.service';
import { CitizenService } from './citizen.service';

const acessoSchema = z.object({ tenant: z.string().trim().min(2).max(60), cpf: z.string().trim().min(11).max(14), birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const confirmarSchema = acessoSchema.extend({ codigo: z.string().trim().min(6).max(8) });
const codigoSchema = z.object({ patientId: z.string().uuid() });
const cancelarSchema = z.object({ motivo: z.string().trim().max(300).nullish() });
const preferenciasSchema = z.object({ whatsappOptIn: z.boolean().nullish() });

/** App do cidadão: acesso por código, agenda, exames, vacinas, medicamentos, regulação/TFD, senha e unidades. */
@Controller('cidadao')
export class CitizenController {
  constructor(
    private readonly auth: CitizenAuthService,
    private readonly citizen: CitizenService,
  ) {}

  @Public()
  @Post('acesso/solicitar')
  @HttpCode(200)
  solicitar(@Body(zv(acessoSchema)) body: z.infer<typeof acessoSchema>, @Req() req: Request) {
    return this.auth.solicitar(body, clientIp(req));
  }

  @Public()
  @Post('acesso/confirmar')
  @HttpCode(200)
  confirmar(@Body(zv(confirmarSchema)) body: z.infer<typeof confirmarSchema>, @Req() req: Request) {
    return this.auth.confirmar(body, clientIp(req));
  }

  /** Recepção entrega um código ao cidadão sem WhatsApp. */
  @Post('codigos')
  @RequirePermission('paciente.cadastrar')
  codigoRecepcao(@Ctx() ctx: RequestContext, @Body(zv(codigoSchema)) body: z.infer<typeof codigoSchema>) {
    return this.auth.codigoRecepcao(ctx, body.patientId);
  }

  @Get('eu')
  @CitizenRoute()
  eu(@CitizenCtx() c: CitizenContext) {
    return this.citizen.eu(c);
  }

  @Get('agenda')
  @CitizenRoute()
  agenda(@CitizenCtx() c: CitizenContext) {
    return this.citizen.agenda(c);
  }

  @Post('agenda/:id/confirmar')
  @HttpCode(200)
  @CitizenRoute()
  confirmarAgendamento(@CitizenCtx() c: CitizenContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.citizen.confirmarAgendamento(c, id);
  }

  @Post('agenda/:id/cancelar')
  @HttpCode(200)
  @CitizenRoute()
  cancelarAgendamento(@CitizenCtx() c: CitizenContext, @Param('id', ParseUUIDPipe) id: string, @Body(zv(cancelarSchema)) body: z.infer<typeof cancelarSchema>) {
    return this.citizen.cancelarAgendamento(c, id, body.motivo);
  }

  @Patch('preferencias')
  @CitizenRoute()
  preferencias(@CitizenCtx() c: CitizenContext, @Body(zv(preferenciasSchema)) body: z.infer<typeof preferenciasSchema>) {
    return this.citizen.preferencias(c, body);
  }

  @Get('exames')
  @CitizenRoute()
  exames(@CitizenCtx() c: CitizenContext) {
    return this.citizen.exames(c);
  }

  @Get('vacinas')
  @CitizenRoute()
  vacinas(@CitizenCtx() c: CitizenContext) {
    return this.citizen.vacinas(c);
  }

  @Get('vacinas/certificado.pdf')
  @CitizenRoute()
  @Header('Content-Type', 'application/pdf')
  async certificado(@CitizenCtx() c: CitizenContext, @Res() res: Response) {
    const { data, fileName } = await this.citizen.certificado(c);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(data);
  }

  @Get('medicamentos')
  @CitizenRoute()
  medicamentos(@CitizenCtx() c: CitizenContext) {
    return this.citizen.medicamentos(c);
  }

  @Get('regulacao')
  @CitizenRoute()
  regulacao(@CitizenCtx() c: CitizenContext) {
    return this.citizen.regulacao(c);
  }

  @Get('senha')
  @CitizenRoute()
  senha(@CitizenCtx() c: CitizenContext) {
    return this.citizen.senha(c);
  }

  @Get('unidades')
  @CitizenRoute()
  unidades(@CitizenCtx() c: CitizenContext) {
    return this.citizen.unidades(c);
  }

  /** O que já está (ou falta para estar) no Meu SUS Digital, o app do Ministério da Saúde. */
  @Get('meu-sus-digital')
  @CitizenRoute()
  meuSusDigital(@CitizenCtx() c: CitizenContext) {
    return resumoMeuSusDigital(c.db, c.tenant, c.patientId);
  }
}
