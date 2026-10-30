import { Body, Controller, Get, Headers, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ROLES } from '@omnisaude/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { Authenticated, clientIp, Ctx, Public, type RequestContext } from '../../core/context';
import { TokenService } from '../../core/tokens';
import { zv } from '../../core/zod';
import { AuthService } from './auth.service';

const loginSchema = z.object({ tenant: z.string().min(2), cpf: z.string().min(11), password: z.string().min(1) });
const mfaSchema = z.object({ code: z.string().min(6).max(8) });
const mfaEnableSchema = z.object({ code: z.string().min(6).max(8), setupToken: z.string().min(20) });
const contextSchema = z.object({ unitId: z.string().uuid(), role: z.enum(ROLES) });
const passwordSchema = z.object({ current: z.string(), next: z.string() });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(zv(loginSchema)) body: z.infer<typeof loginSchema>, @Req() req: Request) {
    return this.auth.login(body, clientIp(req));
  }

  @Public()
  @Post('mfa')
  @HttpCode(200)
  async mfa(@Body(zv(mfaSchema)) body: z.infer<typeof mfaSchema>, @Headers('authorization') authz: string | undefined, @Req() req: Request) {
    return this.auth.verifyMfa(await this.bearer(authz), body.code, clientIp(req));
  }

  /** Aceita o token da etapa "context" ou um token de acesso (troca de unidade/papel). */
  @Public()
  @Post('context')
  @HttpCode(200)
  async context(@Body(zv(contextSchema)) body: z.infer<typeof contextSchema>, @Headers('authorization') authz: string | undefined) {
    return this.auth.selectContext(await this.bearer(authz), body.unitId, body.role);
  }

  @Authenticated()
  @Get('me')
  me(@Ctx() ctx: RequestContext) {
    return this.auth.me(ctx);
  }

  @Authenticated()
  @Post('mfa/setup')
  mfaSetup(@Ctx() ctx: RequestContext) {
    return this.auth.startMfaSetup(ctx);
  }

  @Authenticated()
  @Post('mfa/enable')
  @HttpCode(200)
  mfaEnable(@Ctx() ctx: RequestContext, @Body(zv(mfaEnableSchema)) body: z.infer<typeof mfaEnableSchema>) {
    return this.auth.confirmMfaSetup(ctx, body.code, body.setupToken);
  }

  @Authenticated()
  @Post('password')
  @HttpCode(200)
  password(@Ctx() ctx: RequestContext, @Body(zv(passwordSchema)) body: z.infer<typeof passwordSchema>) {
    return this.auth.changePassword(ctx, body.current, body.next);
  }

  private async bearer(authz: string | undefined) {
    const claims = authz?.startsWith('Bearer ') ? await this.tokens.verify(authz.slice(7)) : null;
    if (!claims) throw new UnauthorizedException('Sessão inválida ou expirada');
    return claims;
  }
}
