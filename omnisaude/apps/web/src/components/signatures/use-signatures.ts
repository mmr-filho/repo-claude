'use client';

import { api, saveBlob } from '@/lib/api';
import { useApi } from '@/lib/hooks';

export interface MyCertificate {
  id: string;
  subject: string;
  cpf: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  icpBrasil: boolean;
  fingerprint: string;
  active: boolean;
  createdAt: string;
  expired: boolean;
  daysLeft: number;
  /** Só na resposta do cadastro: por que a cadeia não foi reconhecida como ICP-Brasil. */
  chainError?: string | null;
}

export interface SignedDocument {
  id: string;
  kind: 'PRONTUARIO' | 'RECEITA' | 'ATESTADO' | 'DOCUMENTO';
  entityType: 'ClinicalNote' | 'Prescription';
  entityId: string;
  patientId: string | null;
  signerId: string;
  signerName: string | null;
  subject: string;
  cpf: string;
  source: string;
  sha256: string;
  sizeBytes: number;
  signedAt: string;
  icpBrasil: boolean | null;
  alreadySigned?: boolean;
}

export const KIND_LABELS: Record<SignedDocument['kind'], string> = {
  PRONTUARIO: 'Registro do prontuário',
  RECEITA: 'Receita',
  ATESTADO: 'Atestado',
  DOCUMENTO: 'Documento',
};

/** Certificado A1 ativo do usuário logado (null quando não cadastrou). */
export function useMyCertificate() {
  const { data, loading, error, reload } = useApi<{
    certificate: MyCertificate | null;
  }>('/signatures/certificates/me');
  return { certificate: data?.certificate ?? null, loading, error, reload };
}

/** Documentos assinados digitalmente para um conjunto de registros (notas ou prescrições). */
export function useSignedDocuments(entityType: SignedDocument['entityType'], ids: string[]) {
  const key = ids.join(',');
  const { data, reload } = useApi<SignedDocument[]>(key ? `/signatures?entityType=${entityType}&entityIds=${key}` : null, [entityType, key]);
  const byEntity = new Map<string, SignedDocument>();
  for (const d of data ?? []) if (!byEntity.has(d.entityId)) byEntity.set(d.entityId, d);
  return { byEntity, reload };
}

export async function downloadSignedPdf(doc: Pick<SignedDocument, 'id' | 'kind'>) {
  const { blob, fileName } = await api.download(`/signatures/${doc.id}/pdf`);
  saveBlob(blob, fileName ?? `${doc.kind.toLowerCase()}-assinado-${doc.id.slice(0, 8)}.pdf`);
}

/** Lê um arquivo do navegador como base64 (sem o prefixo data:). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Falha ao ler o arquivo'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}
