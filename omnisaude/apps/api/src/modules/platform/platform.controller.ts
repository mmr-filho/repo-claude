import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { clientIp, Public } from '../../core/context';
import { zv } from '../../core/zod';
import { PlatformService } from './platform.service';

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const tenantSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/),
  name: z.string().min(3),
  kind: z.enum(['PREFEITURA', 'CONSORCIO', 'ESTADO', 'OUTRO']),
  cnpj: z.string().regex(/^\d{14}$/),
  ibgeCode: z.string().regex(/^\d{6,7}$/),
  uf: z.string().length(2),
  timeZone: z.string().optional(),
});
const updateSchema = z.object({
  status: z.enum(['ATIVO', 'SUSPENSO', 'ENCERRADO']).optional(),
  settings: z
    .object({
      aiEnabled: z.boolean().optional(),
      whatsappEnabled: z.boolean().optional(),
      rndsEnabled: z.boolean().optional(),
      icpBrasilEnabled: z.boolean().optional(),
      appointmentReminderHours: z.number().int().min(1).max(168).optional(),
      accrMaxWaitMinutes: z.record(z.enum(['VERMELHO', 'LARANJA', 'AMARELO', 'VERDE', 'AZUL']), z.number().int().min(0)).optional(),
    })
    .optional(),
});

/** Rotas da plataforma usam uma sessão própria (não a dos tenants), verificada em cada chamada. */
@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(zv(loginSchema)) body: z.infer<typeof loginSchema>, @Req() req: Request) {
    return this.platform.login(body.email, body.password, clientIp(req));
  }

  @Public()
  @Get('tenants')
  async list(@Headers('authorization') authz?: string) {
    await this.platform.verify(authz);
    return this.platform.list();
  }

  @Public()
  @Post('tenants')
  async create(@Headers('authorization') authz: string | undefined, @Body(zv(tenantSchema)) body: z.infer<typeof tenantSchema>) {
    const actor = await this.platform.verify(authz);
    return this.platform.create(actor, body);
  }

  @Public()
  @Patch('tenants/:id')
  async update(@Headers('authorization') authz: string | undefined, @Param('id', ParseUUIDPipe) id: string, @Body(zv(updateSchema)) body: z.infer<typeof updateSchema>) {
    const actor = await this.platform.verify(authz);
    return this.platform.update(actor, id, body);
  }
}
