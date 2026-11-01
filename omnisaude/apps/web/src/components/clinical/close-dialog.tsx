'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import type { NotificacaoCriada } from '@/components/vigilancia/types';

const OUTCOMES = [
  ['ALTA', 'Alta'],
  ['ENCAMINHAMENTO', 'Encaminhamento'],
  ['INTERNACAO', 'Internação (aciona o NIR)'],
  ['TRANSFERENCIA', 'Transferência'],
  ['OBITO', 'Óbito'],
  ['EVASAO', 'Evasão'],
] as const;

export function CloseEncounterDialog({
  encounterId,
  open,
  onOpenChange,
  defaultCid,
  onClosed,
}: {
  encounterId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultCid?: string;
  onClosed: (notificacoes: NotificacaoCriada[]) => void;
}) {
  const toast = useToast();
  const [outcome, setOutcome] = useState<(typeof OUTCOMES)[number][0]>('ALTA');
  const [cid, setCid] = useState(defaultCid ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Encerrar atendimento"
      description="Registros em rascunho precisam ser assinados ou descartados antes."
      footer={
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.post<{ notificacoes?: NotificacaoCriada[] }>(`/clinical/encounters/${encounterId}/close`, { outcome, ...(cid.trim() ? { mainCid: cid.trim().toUpperCase().replace('.', '') } : {}) });
              toast.success('Atendimento encerrado');
              onOpenChange(false);
              onClosed(r.notificacoes ?? []);
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          Encerrar
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Desfecho" htmlFor="close-outcome">
          <Select id="close-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
            {OUTCOMES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="CID principal" htmlFor="close-cid">
          <Input id="close-cid" value={cid} onChange={(e) => setCid(e.target.value)} placeholder="Ex.: I10" />
        </Field>
      </div>
    </Dialog>
  );
}
