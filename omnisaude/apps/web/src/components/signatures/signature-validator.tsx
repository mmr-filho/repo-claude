'use client';

import { FileSearch, ShieldCheck, ShieldX } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime, formatCpf } from '@/lib/format';
import { fileToBase64, KIND_LABELS, type SignedDocument } from './use-signatures';

interface SignatureCheck {
  valid: boolean;
  digestOk: boolean;
  signatureOk: boolean;
  certificateHashOk: boolean | null;
  signingTime: string | null;
  digestAlgorithm: string;
  subject: string;
  commonName: string;
  issuer: string;
  cpf: string | null;
  notBefore: string;
  notAfter: string;
  icpBrasil: boolean;
  chainError: string | null;
  certificates: number;
  coversWholeDocument: boolean;
  error: string | null;
}
interface Validation {
  sha256: string;
  sizeBytes: number;
  valid: boolean;
  signatures: SignatureCheck[];
  issuedHere: {
    id: string;
    kind: SignedDocument['kind'];
    entityType: string;
    signedAt: string;
    signerName: string;
    cpf: string;
  } | null;
}

/** Confere as assinaturas digitais de um PDF (deste sistema ou de fora). */
export function SignatureValidator() {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Validation | null>(null);

  async function validate(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      setResult(
        await api.post<Validation>('/signatures/validate', {
          pdfBase64: await fileToBase64(file),
        }),
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader
        title="Validar documento assinado"
        description="Envie um PDF para conferir as assinaturas digitais (PAdES/CAdES): integridade do conteúdo, certificado do signatário e cadeia ICP-Brasil. Documentos emitidos aqui são reconhecidos pelo hash."
      />
      <CardBody className="flex flex-col gap-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={validate}>
          <Field label="PDF assinado" htmlFor="validate-file" className="min-w-64 flex-1">
            <Input id="validate-file" type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Button type="submit" loading={busy} disabled={!file}>
            <FileSearch className="h-4 w-4" /> Validar
          </Button>
        </form>
        {result && (
          <div className="flex flex-col gap-3">
            {result.signatures.length === 0 ? (
              <Alert tone="warn" title="Sem assinatura digital">
                O PDF não contém assinaturas digitais incorporadas.
              </Alert>
            ) : result.valid ? (
              <div className="flex items-center gap-3 text-emerald-800">
                <ShieldCheck className="h-8 w-8" />
                <div>
                  <p className="font-semibold">
                    Assinatura{result.signatures.length > 1 ? 's' : ''} válida
                    {result.signatures.length > 1 ? 's' : ''}
                  </p>
                  <p className="text-sm">O conteúdo não foi alterado depois de assinado.</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 text-red-800">
                <ShieldX className="h-8 w-8" />
                <div>
                  <p className="font-semibold">Assinatura inválida</p>
                  <p className="text-sm">{result.signatures.find((s) => s.error)?.error ?? 'Alguma assinatura não confere.'}</p>
                </div>
              </div>
            )}
            {result.issuedHere ? (
              <Alert tone="success" title="Documento emitido neste sistema">
                {KIND_LABELS[result.issuedHere.kind]} assinado por {result.issuedHere.signerName} (CPF {formatCpf(result.issuedHere.cpf)}) em {fmtDateTime(result.issuedHere.signedAt)}.
              </Alert>
            ) : (
              result.signatures.length > 0 && <Alert tone="info">Este arquivo não corresponde a nenhum documento emitido aqui (ou foi alterado depois).</Alert>
            )}
            <ul className="flex flex-col gap-2">
              {result.signatures.map((s, i) => (
                <li key={i} className="rounded-lg border border-slate-200 p-3 text-sm">
                  <p className="font-medium">
                    {s.commonName || 'Signatário não identificado'} {s.cpf && <span className="text-slate-500">· CPF {formatCpf(s.cpf)}</span>}
                  </p>
                  {s.issuer && (
                    <p className="text-xs text-slate-600">
                      Emissor: {s.issuer} · válido de {fmtDate(s.notBefore)} a {fmtDate(s.notAfter)}
                    </p>
                  )}
                  <p className="text-xs text-slate-600">
                    {s.signingTime ? `Assinado em ${fmtDateTime(s.signingTime)}` : 'Sem data de assinatura'} {s.digestAlgorithm && `· ${s.digestAlgorithm}`} · {s.certificates} certificado(s) na assinatura
                  </p>
                  <p className="mt-2 flex flex-wrap gap-1">
                    <Badge tone={s.digestOk ? 'green' : 'red'}>{s.digestOk ? 'conteúdo íntegro' : 'conteúdo alterado'}</Badge>
                    <Badge tone={s.signatureOk ? 'green' : 'red'}>{s.signatureOk ? 'assinatura confere' : 'assinatura não confere'}</Badge>
                    {s.certificateHashOk !== null && <Badge tone={s.certificateHashOk ? 'green' : 'red'}>{s.certificateHashOk ? 'certificado declarado' : 'certificado divergente'}</Badge>}
                    <Badge tone={s.icpBrasil ? 'blue' : 'amber'} title={s.chainError ?? ''}>
                      {s.icpBrasil ? 'cadeia ICP-Brasil' : 'cadeia fora da ICP-Brasil'}
                    </Badge>
                    <Badge tone={s.coversWholeDocument ? 'slate' : 'amber'}>{s.coversWholeDocument ? 'cobre o arquivo inteiro' : 'há alterações posteriores'}</Badge>
                  </p>
                  {s.chainError && !s.icpBrasil && <p className="mt-1 text-xs text-amber-800">{s.chainError}</p>}
                  {s.error && <p className="mt-1 text-xs text-red-700">{s.error}</p>}
                </li>
              ))}
            </ul>
            <p className="break-all font-mono text-[11px] text-slate-500">SHA-256 do arquivo: {result.sha256}</p>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
