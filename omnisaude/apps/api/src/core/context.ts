import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { TenantClient, TenantInfo } from '@omnisaude/database';
import type { Permission, SessionContext } from '@omnisaude/shared';
import type { Request } from 'express';

/** Tudo o que um serviço precisa saber sobre quem chama: sessão, tenant, banco do tenant e IP. */
export interface RequestContext {
  session: SessionContext;
  tenant: TenantInfo;
  db: TenantClient;
  ip: string;
  /** CBO do profissional no contexto ativo (faturamento e compatibilidade SIGTAP). */
  cbo: string;
}

export type ContextRequest = Request & { ctx?: RequestContext };

export const Ctx = createParamDecorator((_data: unknown, host: ExecutionContext): RequestContext => {
  const req = host.switchToHttp().getRequest<ContextRequest>();
  if (!req.ctx) throw new Error('Contexto de sessão ausente');
  return req.ctx;
});

export const PUBLIC_KEY = 'omni:public';
export const PERMISSION_KEY = 'omni:permission';
export const AUTHENTICATED_KEY = 'omni:authenticated';
export const PROVISIONAL_OK_KEY = 'omni:provisional-ok';

/** Rota sem autenticação (login, webhooks com assinatura própria, saúde). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Exige a permissão no papel ativo da sessão. */
export const RequirePermission = (...permissions: Permission[]) => SetMetadata(PERMISSION_KEY, permissions);
/** Qualquer usuário com contexto ativo (ex.: /auth/me). */
export const Authenticated = () => SetMetadata(AUTHENTICATED_KEY, true);
/** Rotas que continuam acessíveis a quem ainda precisa trocar a senha provisória (conta e senha). */
export const AllowProvisionalPassword = () => SetMetadata(PROVISIONAL_OK_KEY, true);

export function clientIp(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}
