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

/** Resposta do impasse e da falha de serialização: a transação que perdeu foi desfeita, e repetir resolve. */
export const MSG_OPERACAO_SIMULTANEA = 'Outra operação alterou os mesmos dados ao mesmo tempo. Tente de novo em instantes.';
/** Resposta do texto que o Postgres recusa (o NUL num text ou num jsonb). */
export const MSG_TEXTO_INVALIDO = 'O pedido tem texto com caractere inválido (como o caractere nulo, U+0000). Corrija e envie de novo.';

/** Impasse (deadlock_detected) e falha de serialização (serialization_failure): a transação foi desfeita. */
const SQLSTATE_SIMULTANEA = new Set(['40P01', '40001']);
/** O NUL no texto: 22021 num text ("invalid byte sequence for encoding UTF8: 0x00") e 22P05 num jsonb ("\u0000"). */
const SQLSTATE_TEXTO = new Set(['22021', '22P05']);

type ErroDoBanco = {
  code?: unknown;
  meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; kind?: unknown } } };
  cause?: { originalCode?: unknown; kind?: unknown };
};

/**
 * Códigos do Postgres (SQLSTATE) por trás do erro, em cada forma que ele chega aqui: o Prisma 7 com o adaptador do pg
 * (P2010 na consulta crua, P2034 ou P2039 na do modelo) o guarda em meta.driverAdapterError.cause.originalCode; o
 * Prisma com o motor antigo, em meta.code (P2010); o erro do adaptador solto, em cause.originalCode; o pg puro, em code.
 */
function sqlstates(e: unknown): string[] {
  if (!e || typeof e !== 'object') return [];
  const x = e as ErroDoBanco;
  return [x.meta?.driverAdapterError?.cause?.originalCode, x.meta?.code, x.cause?.originalCode, x.code].filter((c): c is string => typeof c === 'string');
}

/** Impasse ou falha de serialização: P2034 do Prisma, o 'TransactionWriteConflict' do adaptador ou o SQLSTATE. */
function operacaoSimultanea(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const x = e as ErroDoBanco;
  if (x.code === 'P2034' || x.meta?.driverAdapterError?.cause?.kind === 'TransactionWriteConflict' || x.cause?.kind === 'TransactionWriteConflict') return true;
  return sqlstates(e).some((c) => SQLSTATE_SIMULTANEA.has(c));
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Erros');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (!res || typeof res.status !== 'function') return; // WebSocket: tratado pelo gateway
    const body = this.toBody(exception);
    if (body.statusCode >= 500 && !(exception instanceof DomainError)) this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    // O impasse responde 409, mas fica no log: a repetição dele aponta duas operações que travam em ordens opostas.
    else if (body.code === 'OPERACAO_SIMULTANEA' && !(exception instanceof DomainError))
      this.logger.warn(`Operação desfeita pelo banco (${sqlstates(exception)[0] ?? '?'}): ${exception instanceof Error ? exception.stack : String(exception)}`);
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
    const prismaCode = (e as { code?: string } | null)?.code;
    if (prismaCode === 'P2002') return { statusCode: 409, message: 'Registro duplicado', code: 'DUPLICADO' };
    if (prismaCode === 'P2025') return { statusCode: 404, message: 'Registro não encontrado', code: 'NAO_ENCONTRADO' };
    // O banco desfez a transação no impasse ou na falha de serialização (outra operação nos mesmos dados): repetir resolve.
    if (operacaoSimultanea(e)) return { statusCode: 409, message: MSG_OPERACAO_SIMULTANEA, code: 'OPERACAO_SIMULTANEA' };
    // O NUL que passou da validação (o text e o jsonb do Postgres não o aceitam): é o pedido que está errado.
    if (sqlstates(e).some((c) => SQLSTATE_TEXTO.has(c))) return { statusCode: 400, message: MSG_TEXTO_INVALIDO, code: 'VALIDACAO' };
    return { statusCode: 500, message: 'Erro interno' };
  }
}
