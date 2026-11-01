'use client';

import { API_URL, ApiError } from '@/lib/api';

const KEY = 'omni.cidadao';

export interface CitizenSession {
  token: string;
  cidadao: { id: string; nome: string; primeiroNome: string };
  instituicao: { slug: string; nome: string };
}

/** Sessão do cidadão no app (localStorage: sobrevive ao fechar o app no telefone). */
export const citizenStore = {
  get(): CitizenSession | null {
    try {
      const raw = window.localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as CitizenSession) : null;
    } catch {
      return null;
    }
  },
  set(s: CitizenSession) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      // sem armazenamento: sessão só nesta tela
    }
  },
  clear() {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // idem
    }
  },
};

async function request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (auth) {
    const s = citizenStore.get();
    if (s) headers.Authorization = `Bearer ${s.token}`;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'Sem conexão. Verifique a internet e tente de novo.');
  }
  if (res.status === 401 && auth) {
    citizenStore.clear();
    if (typeof window !== 'undefined') window.location.assign(`${window.location.origin}${(process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/$/, '')}/cidadao`);
  }
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const b = (data && typeof data === 'object' ? data : {}) as { message?: string; code?: string; details?: unknown };
    throw new ApiError(res.status, b.message ?? `Erro ${res.status}`, b.code, b.details);
  }
  return data as T;
}

export const citizenApi = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  public: <T>(path: string, body: unknown) => request<T>('POST', path, body, false),
  async download(path: string, fileName: string) {
    const s = citizenStore.get();
    const res = await fetch(`${API_URL}${path}`, { headers: s ? { Authorization: `Bearer ${s.token}` } : {} });
    if (!res.ok) throw new ApiError(res.status, 'Não foi possível baixar o arquivo');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};
