import { Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleHasPermission, type Permission } from '@omnisaude/shared';
import { AUTHENTICATED_KEY, clientIp, PERMISSION_KEY, PUBLIC_KEY, type ContextRequest } from './context';
import { TenantsService } from './database';
import { forbidden } from './errors';
import { TokenService } from './tokens';

/**
 * Guarda global. Negação por padrão: toda rota precisa declarar @Public, @Authenticated ou @RequirePermission.
 * O tenant vem do token, nunca do cliente, e o banco aberto é sempre o daquele tenant.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly tenants: TenantsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const permissions = this.reflector.getAllAndOverride<Permission[]>(PERMISSION_KEY, targets);
    const authenticated = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, targets);
    if (!permissions && !authenticated) throw forbidden('Rota sem política de acesso declarada');

    const req = context.switchToHttp().getRequest<ContextRequest>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const claims = token ? await this.tokens.verify(token) : null;
    if (!claims || claims.stage !== 'access') throw new UnauthorizedException('Sessão inválida ou expirada');

    const tenant = await this.tenants.resolve(claims.tid);
    const db = await this.tenants.client(tenant.id);
    req.ctx = {
      session: {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        userId: claims.sub,
        unitId: claims.unit!,
        role: claims.role!,
        mfa: claims.mfa,
      },
      tenant,
      db,
      ip: clientIp(req),
      cbo: claims.cbo ?? '',
    };

    if (permissions && !permissions.some((p) => roleHasPermission(claims.role!, p))) {
      throw forbidden(`O papel ${claims.role} não tem permissão para esta ação`);
    }
    return true;
  }
}
