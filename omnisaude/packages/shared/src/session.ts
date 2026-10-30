import type { Role } from './roles';

/** Contexto ativo da sessão: a mesma pessoa troca de unidade e de papel sem novo login. */
export interface SessionContext {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  unitId: string;
  role: Role;
  /** Segundo fator confirmado nesta sessão (exigido para assinar registros clínicos). */
  mfa: boolean;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiErrorBody {
  statusCode: number;
  message: string;
  code?: string;
  details?: unknown;
}
