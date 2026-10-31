'use client';

import { FileCheck2, Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PrintPortal, printSoon } from '@/components/patients/print-portal';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { SignDialog } from '@/components/signatures/sign-button';
import { useMyCertificate } from '@/components/signatures/use-signatures';

interface Printable {
  title: string;
  patient: string;
  days: number;
  cid: string | null;
  text: string;
  professional: string;
  council: string | null;
  unit: string;
  issuedAt: string;
  verification: string;
}

/** Atestado: o CID só é impresso com autorização expressa do paciente. */
export function CertificateDialog({ encounterId, open, onOpenChange, defaultDays, defaultCid, onIssued }: { encounterId: string; open: boolean; onOpenChange: (o: boolean) => void; defaultDays?: number; defaultCid?: string; onIssued: () => void }) {
  const toast = useToast();
  const [days, setDays] = useState(String(defaultDays ?? 1));
  const [cid, setCid] = useState(defaultCid ?? '');
  const [includeCid, setIncludeCid] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [printable, setPrintable] = useState<Printable | null>(null);
  const myCertificate = useMyCertificate();
  const [signNoteId, setSignNoteId] = useState<string | null>(null);

  useEffect(() => {
    if (open && defaultDays) setDays(String(defaultDays));
  }, [open, defaultDays]);

  async function issue(mode: 'print' | 'digital' = 'print') {
    setBusy(true);
    try {
      const r = await api.post<{ noteId: string; printable: Printable }>(`/clinical/encounters/${encounterId}/certificate`, {
        days: Number(days),
        includeCid,
        ...(cid.trim() ? { cid: cid.trim().toUpperCase().replace('.', '') } : {}),
        ...(text.trim() ? { text: text.trim() } : {}),
      });
      onOpenChange(false);
      onIssued();
      if (mode === 'digital') {
        toast.success('Atestado emitido; agora assine com o certificado');
        setSignNoteId(r.noteId);
      } else {
        setPrintable(r.printable);
        toast.success('Atestado emitido e assinado');
        printSoon();
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="Emitir atestado"
        footer={
          <>
            {myCertificate.certificate && (
              <Button variant="secondary" onClick={() => issue('digital')} loading={busy} disabled={!(Number(days) >= 1)}>
                <FileCheck2 className="h-4 w-4" /> Emitir e assinar digitalmente
              </Button>
            )}
            <Button onClick={() => issue('print')} loading={busy} disabled={!(Number(days) >= 1)}>
              <Printer className="h-4 w-4" /> Emitir e imprimir
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Dias de afastamento" htmlFor="cert-days">
            <Input id="cert-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
          <Field label="CID-10 (opcional)" htmlFor="cert-cid">
            <Input id="cert-cid" value={cid} onChange={(e) => setCid(e.target.value)} />
          </Field>
          <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="h-5 w-5" checked={includeCid} onChange={(e) => setIncludeCid(e.target.checked)} />
            O paciente autoriza expressamente a inclusão do CID no atestado
          </label>
          <Field label="Texto (opcional)" htmlFor="cert-text" className="sm:col-span-2" hint="Em branco, usa o texto padrão.">
            <Textarea id="cert-text" value={text} onChange={(e) => setText(e.target.value)} rows={3} />
          </Field>
        </div>
      </Dialog>
      {signNoteId && <SignDialog open onOpenChange={(o) => !o && setSignNoteId(null)} entityType="ClinicalNote" entityId={signNoteId} onSigned={() => setSignNoteId(null)} />}
      {printable && (
        <PrintPortal>
          <article className="mx-auto max-w-[17cm] font-serif text-black">
            <p className="text-center text-sm">{printable.unit}</p>
            <h1 className="my-8 text-center text-2xl font-bold tracking-widest">{printable.title}</h1>
            <p className="text-lg leading-relaxed">{printable.text}</p>
            {printable.cid && <p className="mt-4">CID-10: {printable.cid}</p>}
            <p className="mt-10">{fmtDateTime(printable.issuedAt)}</p>
            <div className="mt-16 text-center">
              <p>_______________________________________</p>
              <p>{printable.professional}</p>
              {printable.council && <p className="text-sm">{printable.council}</p>}
            </div>
            <p className="mt-12 break-all text-[10px] text-slate-600">Documento assinado eletronicamente. Verificação: {printable.verification}</p>
          </article>
        </PrintPortal>
      )}
    </>
  );
}
