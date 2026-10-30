import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from '@nestjs/common';
import { TenantNotFoundError, TenantUnavailableError } from '@omnisaude/database';
import type { Response } from 'express';

/** Erro de regra de negócio com código estável para o front-end. */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = HttpStatus.UNPROCESSABLE_ENTITY,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new DomainError('NAO_ENCONTRADO', `${what} não encontrado(a)`, HttpStatus.NOT_FOUND);
export const forbidden = (message: string) => new DomainError('PROIBIDO', message, HttpStatus.FORBIDDEN);
export const conflict = (message: string, details?: unknown) => new DomainError('CONFLITO', message, HttpStatus.CONFLICT, details);

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Erros');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (!res || typeof res.status !== 'function') return; // WebSocket: tratado pelo gateway
    const body = this.toBody(exception);
    if (body.statusCode >= 500 && !(exception instanceof DomainError)) this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(body.statusCode).json(body);
  }

  private toBody(e: unknown): { statusCode: number; message: string; code?: string; details?: unknown } {
    if (e instanceof DomainError) return { statusCode: e.status, message: e.message, code: e.code, details: e.details };
    if (e instanceof TenantNotFoundError) return { statusCode: 404, message: e.message, code: 'TENANT_NAO_ENCONTRADO' };
    if (e instanceof TenantUnavailableError) return { statusCode: 403, message: e.message, code: 'TENANT_INDISPONIVEL' };
    if (e instanceof HttpException) {
      const r = e.getResponse();
      const message = typeof r === 'string' ? r : ((r as { message?: string | string[] }).message ?? e.message);
      return { statusCode: e.getStatus(), message: Array.isArray(message) ? message.join('; ') : message };
    }
    const prismaCode = (e as { code?: string })?.code;
    if (prismaCode === 'P2002') return { statusCode: 409, message: 'Registro duplicado', code: 'DUPLICADO' };
    if (prismaCode === 'P2025') return { statusCode: 404, message: 'Registro não encontrado', code: 'NAO_ENCONTRADO' };
    return { statusCode: 500, message: 'Erro interno' };
  }
}
