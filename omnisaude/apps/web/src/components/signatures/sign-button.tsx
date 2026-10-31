'use client';

import { Download, FileCheck2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { downloadSignedPdf, type SignedDocument } from './use-signatures';

/** Pede a senha do certificado, assina o registro em PDF/PAdES e baixa o arquivo. */
export function SignDialog({
  open,
  onOpenChange,
  entityType,
  entityId,
  onSigned,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  entityType: SignedDocument['entityType'];
  entityId: string;
  onSigned?: (doc: SignedDocument) => void;
}) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function sign() {
    setBusy(true);
    try {
      const doc = await api.post<SignedDocument>('/signatures/sign', {
        entityType,
        entityId,
        password,
      });
      toast.success(doc.alreadySigned ? 'Este registro já estava assinado digitalmente; baixando o PDF' : 'Documento assinado digitalmente');
      setPassword('');
      onOpenChange(false);
      onSigned?.(doc);
      await downloadSignedPdf(doc);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Assinar com certificado digital"
      description="O documento sai em PDF assinado no padrão ICP-Brasil (PAdES). A senha do certificado não é guardada."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={sign} loading={busy} disabled={!password}>
            <FileCheck2 className="h-4 w-4" /> Assinar e baixar PDF
          </Button>
        </>
      }
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) void sign();
        }}
      >
        <Field label="Senha do certificado" htmlFor="sign-password">
          <Input id="sign-password" type="password" autoComplete="off" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

/**
 * Estado da assinatura digital de um registro: quando já existe, mostra o selo e o botão de baixar o PDF;
 * quando o usuário pode assinar (é o autor e tem certificado), oferece o botão de assinar.
 */
export function SignWithCertificate({ entityType, entityId, doc, canSign, onSigned }: { entityType: SignedDocument['entityType']; entityId: string; doc?: SignedDocument; canSign: boolean; onSigned?: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  if (doc) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Badge tone="green" title={`${doc.subject} · SHA-256 ${doc.sha256}`}>
          <ShieldCheck className="mr-1 inline h-3.5 w-3.5" /> Assinado digitalmente{doc.icpBrasil ? ' · ICP-Brasil' : ''} · {fmtDateTime(doc.signedAt)}
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          loading={downloading}
          onClick={async () => {
            setDownloading(true);
            try {
              await downloadSignedPdf(doc);
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setDownloading(false);
            }
          }}
        >
          <Download className="h-4 w-4" /> PDF assinado
        </Button>
      </span>
    );
  }
  if (!canSign) return null;
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <FileCheck2 className="h-4 w-4" /> Assinar com certificado
      </Button>
      <SignDialog open={open} onOpenChange={setOpen} entityType={entityType} entityId={entityId} onSigned={onSigned} />
    </>
  );
}
