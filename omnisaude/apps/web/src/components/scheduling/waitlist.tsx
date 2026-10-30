'use client';

import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PatientSearch } from '@/components/patients/patient-search';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { PatientSummary } from '@/lib/types';

interface Entry {
  id: string;
  cbo: string;
  patientId: string;
  priority: number;
  reason: string | null;
  status: 'AGUARDANDO' | 'OFERTADO' | 'AGENDADO' | 'DESISTIU';
  createdAt: string;
}

/** Lista de espera da unidade por especialidade (CBO), por prioridade e ordem de entrada. */
export function Waitlist({ defaultCbo }: { defaultCbo?: string }) {
  const session = useSession();
  const toast = useToast();
  const [status, setStatus] = useState('AGUARDANDO');
  const list = useApi<Entry[]>(`/scheduling/waitlist?status=${status}`);
  const [names, setNames] = useState<Record<string, string>>({});
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [cbo, setCbo] = useState(defaultCbo ?? '');
  const [priority, setPriority] = useState('0');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  // A lista de espera traz só o identificador do paciente; os nomes são buscados à parte.
  useEffect(() => {
    const missing = (list.data ?? []).map((e) => e.patientId).filter((id) => !names[id]);
    if (!missing.length) return;
    void Promise.all([...new Set(missing)].map((id) => api.get<PatientSummary>(`/patients/${id}`).then((p) => [id, p.name] as const).catch(() => [id, '—'] as const))).then((pairs) =>
      setNames((n) => ({ ...n, ...Object.fromEntries(pairs) })),
    );
  }, [list.data, names]);

  useEffect(() => {
    if (defaultCbo) setCbo(defaultCbo);
  }, [defaultCbo]);

  return (
    <div className="flex flex-col gap-4">
      {session.can('agenda.marcar') && (
        <div className="grid gap-3 rounded-lg border border-slate-200 p-3 md:grid-cols-[1fr_8rem_6rem_1fr_auto] md:items-end">
          <Field label={patient ? `Paciente: ${patient.name}` : 'Paciente'}>
            <PatientSearch onSelect={setPatient} />
          </Field>
          <Field label="CBO" htmlFor="wl-cbo">
            <Input id="wl-cbo" value={cbo} onChange={(e) => setCbo(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" />
          </Field>
          <Field label="Prioridade" htmlFor="wl-prio">
            <Input id="wl-prio" type="number" min={0} max={10} value={priority} onChange={(e) => setPriority(e.target.value)} />
          </Field>
          <Field label="Motivo" htmlFor="wl-reason">
            <Input id="wl-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Button
            loading={busy}
            disabled={!patient || cbo.length !== 6}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post('/scheduling/waitlist', { patientId: patient!.id, cbo, priority: Number(priority), ...(reason ? { reason } : {}) });
                toast.success('Incluído na lista de espera');
                setPatient(null);
                setReason('');
                void list.reload();
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Plus className="h-4 w-4" /> Incluir
          </Button>
        </div>
      )}
      <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-56" aria-label="Situação">
        <option value="AGUARDANDO">Aguardando</option>
        <option value="OFERTADO">Vaga ofertada</option>
        <option value="AGENDADO">Agendados</option>
        <option value="DESISTIU">Desistências</option>
      </Select>
      {list.loading && !list.data ? (
        <Spinner />
      ) : !list.data?.length ? (
        <EmptyState title="Lista vazia" />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Paciente</TH>
              <TH>CBO</TH>
              <TH>Prioridade</TH>
              <TH>Motivo</TH>
              <TH>Desde</TH>
              <TH>Situação</TH>
            </tr>
          </THead>
          <TBody>
            {list.data.map((e) => (
              <TR key={e.id}>
                <TD>{names[e.patientId] ?? '…'}</TD>
                <TD className="font-mono">{e.cbo}</TD>
                <TD>{e.priority}</TD>
                <TD>{e.reason ?? '—'}</TD>
                <TD>{fmtDate(e.createdAt)}</TD>
                <TD>
                  <Badge tone={e.status === 'OFERTADO' ? 'green' : 'slate'}>{e.status.toLowerCase()}</Badge>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
