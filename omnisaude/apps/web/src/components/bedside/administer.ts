import { API_URL, ApiError } from '@/lib/api';
import { tokenStore } from '@/lib/storage';
import type { AdministrationResult } from './types';

/**
 * A API responde 422 com o resultado completo dos 5 certos quando bloqueia (não é um erro comum),
 * então lemos o corpo nos dois casos.
 */
export async function administer(body: {
  patientCode: string;
  doseCode: string;
  prescriptionItemId: string;
  route: string;
  popExecutionIds?: string[];
}): Promise<AdministrationResult> {
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(`${API_URL}/pharmacy/administrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Sem conexão com o servidor. A administração NÃO foi registrada.');
  }
  const data = (await res.json().catch(() => ({}))) as Partial<AdministrationResult> & { message?: string; code?: string; details?: unknown };
  if (res.ok || (res.status === 422 && data.status === 'BLOQUEADO')) return data as AdministrationResult;
  throw new ApiError(res.status, data.message ?? `Erro ${res.status}`, data.code, data.details);
}
