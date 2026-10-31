'use client';

import { KeyRound, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, formatCpf } from '@/lib/format';
import { fileToBase64, useMyCertificate, type MyCertificate } from '@/components/signatures/use-signatures';

/** Certificado digital A1 (e-CPF) do profissional, usado para assinar prontuário, receita e atestado. */
export function CertificateCard() {
  const toast = useToast();
  const { certificate, loading, error, reload } = useMyCertificate();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [chainError, setChainError] = useState<string | null>(null);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      const pfxBase64 = await fileToBase64(file);
      const res = await api.post<{ certificate: MyCertificate }>('/signatures/certificates', { pfxBase64, password });
      setChainError(res.certificate.chainError ?? null);
      toast.success('Certificado cadastrado');
      setFile(null);
      setPassword('');
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('Remover o certificado? Você deixará de assinar digitalmente até cadastrar outro.')) return;
    setBusy(true);
    try {
      await api.delete('/signatures/certificates/me');
      toast.success('Certificado removido');
      setChainError(null);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Certificado digital (A1)"
        description="Seu e-CPF ICP-Brasil para assinar prontuário, receita e atestado em PDF. O arquivo fica cifrado no servidor; a senha não é guardada e é pedida a cada assinatura."
      />
      <CardBody>
        {error && <Alert tone="error">{error}</Alert>}
        {loading && !certificate ? (
          <Spinner className="py-4" />
        ) : certificate ? (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className={`h-5 w-5 ${certificate.expired ? 'text-red-600' : 'text-emerald-600'}`} />
              <span className="font-medium">
                {certificate.subject
                  .split(', ')
                  .find((p) => p.startsWith('CN='))
                  ?.slice(3) ?? certificate.subject}
              </span>
              {certificate.expired ? <Badge tone="red">vencido</Badge> : <Badge tone={certificate.daysLeft <= 30 ? 'amber' : 'green'}>válido por {certificate.daysLeft} dia(s)</Badge>}
              {certificate.icpBrasil ? <Badge tone="blue">cadeia ICP-Brasil</Badge> : <Badge tone="amber">cadeia fora da ICP-Brasil</Badge>}
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
              <div>
                <dt className="font-medium text-slate-500">CPF do titular</dt>
                <dd>{formatCpf(certificate.cpf)}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Validade</dt>
                <dd>
                  {fmtDate(certificate.notBefore)} a {fmtDate(certificate.notAfter)}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="font-medium text-slate-500">Emissor</dt>
                <dd>{certificate.issuer}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="font-medium text-slate-500">Impressão digital (SHA-256)</dt>
                <dd className="break-all font-mono">{certificate.fingerprint}</dd>
              </div>
            </dl>
            {!certificate.icpBrasil && (
              <Alert tone="warn">
                A cadeia deste certificado não chega a uma raiz da ICP-Brasil
                {chainError ? `: ${chainError}` : ''}. Assinaturas feitas com ele não têm a presunção legal da ICP-Brasil (serve para testes).
              </Alert>
            )}
            <Button variant="secondary" onClick={remove} loading={busy} className="self-start">
              <Trash2 className="h-4 w-4" /> Remover certificado
            </Button>
          </div>
        ) : (
          <form className="grid gap-3 sm:max-w-md" onSubmit={upload}>
            <Field label="Arquivo do certificado (.pfx ou .p12)" htmlFor="cert-file" hint="Exportado do navegador ou entregue pela autoridade certificadora. Até 64 KB.">
              <Input id="cert-file" type="file" accept=".pfx,.p12,application/x-pkcs12" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <Field label="Senha do arquivo" htmlFor="cert-password">
              <Input id="cert-password" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Button type="submit" loading={busy} disabled={!file || !password} className="justify-self-start">
              <Upload className="h-4 w-4" /> Cadastrar certificado
            </Button>
            <p className="flex items-start gap-2 text-xs text-slate-500">
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0" /> O CPF do certificado precisa ser o mesmo da sua conta. Certificados A3 (cartão/token) e em nuvem entram numa próxima etapa.
            </p>
          </form>
        )}
      </CardBody>
    </Card>
  );
}
