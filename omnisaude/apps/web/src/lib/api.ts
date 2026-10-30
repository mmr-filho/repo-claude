import { tokenStore } from './storage';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api').replace(/\/$/, '');
/** Prefixo em que a web é publicada (ex.: "/omnisaude"); vazio quando está na raiz do domínio. */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/$/, '');

/**
 * Socket.IO roda no mesmo servidor da API. Com a API sob um prefixo (ex.: /omnisaude/api), o caminho do
 * Socket.IO acompanha (/omnisaude/socket.io) e os namespaces continuam /rt e /libras. API_URL relativa
 * (mesma origem da página) conecta no próprio host.
 */
function socketTarget() {
  const absolute = /^https?:\/\//.test(API_URL);
  const url = new URL(API_URL, 'http://mesma-origem');
  return { origin: absolute ? url.origin : '', path: `${url.pathname.replace(/\/api$/, '')}/socket.io` };
}
export const SOCKET = socketTarget();

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

type Body = Record<string, unknown> | unknown[] | string | Blob | undefined;

export interface RequestOptions {
  token?: string | null;
  headers?: Record<string, string>;
  /** Corpo bruto (XML, zip): enviado sem JSON.stringify. */
  raw?: boolean;
  signal?: AbortSignal;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: Body, opts: RequestOptions = {}): Promise<T> {
  const token = opts.token === undefined ? tokenStore.get() : opts.token;
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    if (opts.raw) payload = body as BodyInit;
    else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method, headers, body: payload, signal: opts.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'Sem conexão com o servidor. Verifique a rede e tente de novo.');
  }
  if (res.status === 401 && token && onUnauthorized) onUnauthorized();
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const b = (data && typeof data === 'object' ? data : {}) as { message?: string; code?: string; details?: unknown };
    throw new ApiError(res.status, b.message ?? (typeof data === 'string' && data ? data : `Erro ${res.status}`), b.code, b.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: Body, opts?: RequestOptions) => request<T>('POST', path, body ?? {}, opts),
  patch: <T>(path: string, body?: Body, opts?: RequestOptions) => request<T>('PATCH', path, body ?? {}, opts),
  put: <T>(path: string, body?: Body, opts?: RequestOptions) => request<T>('PUT', path, body ?? {}, opts),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
  /** Download autenticado (CSV, BPA, etiquetas): devolve o arquivo para salvar. */
  async download(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ blob: Blob; fileName: string | null }> {
    const token = tokenStore.get();
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new ApiError(res.status, (b as { message?: string }).message ?? `Erro ${res.status}`, (b as { code?: string }).code);
    }
    const cd = res.headers.get('content-disposition') ?? '';
    const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)?.[1] ?? null;
    return { blob: await res.blob(), fileName: name ? decodeURIComponent(name) : null };
  },
};

export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Mensagem amigável para exibir ao usuário. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const details = Array.isArray(err.details) ? (err.details as { path?: string; message?: string }[]) : null;
    if (err.code === 'VALIDACAO' && details?.length) return details.map((d) => `${d.path ? `${d.path}: ` : ''}${d.message}`).join('; ');
    return err.message;
  }
  return err instanceof Error ? err.message : 'Erro inesperado';
}
