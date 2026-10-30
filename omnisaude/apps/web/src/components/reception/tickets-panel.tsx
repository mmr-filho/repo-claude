'use client';

import { BellRing, Megaphone, Plus, UserX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtTime } from '@/lib/format';
import { useApi, useInterval } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';

export interface Ticket {
  id: string;
  code: string;
  kind: 'NORMAL' | 'PRIORIDADE';
  sector: string;
  status: 'AGUARDANDO' | 'CHAMADA' | 'EM_ATENDIMENTO' | 'FINALIZADA' | 'AUSENTE';
  desk: string | null;
  patientId: string | null;
  calledAt: string | null;
  callCount: number;
  createdAt: string;
}

const STATUS: Record<Ticket['status'], { label: string; tone: 'slate' | 'blue' | 'green' | 'amber' | 'red' }> = {
  AGUARDANDO: { label: 'Aguardando', tone: 'amber' },
  CHAMADA: { label: 'Chamada', tone: 'blue' },
  EM_ATENDIMENTO: { label: 'Em atendimento', tone: 'blue' },
  FINALIZADA: { label: 'Acolhida', tone: 'green' },
  AUSENTE: { label: 'Ausente', tone: 'red' },
};

const DESK_KEY = 'omni.desk';

/** Senhas do dia: emissão, chamada no painel (prioridade primeiro) e ausência. */
export function TicketsPanel({ onSelect, selectedId }: { onSelect?: (t: Ticket) => void; selectedId?: string | null }) {
  const toast = useToast();
  const { data, loading, reload } = useApi<Ticket[]>('/reception/tickets');
  const [desk, setDesk] = useState('Guichê 1');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(DESK_KEY);
      if (saved) setDesk(saved);
    } catch {
      // sem armazenamento local
    }
  }, []);
  useRealtime('fila.atualizada', () => void reload());
  useRealtime('senha.chamada', () => void reload());
  useInterval(() => void reload(), 20_000);

  function rememberDesk(v: string) {
    setDesk(v);
    try {
      localStorage.setItem(DESK_KEY, v);
    } catch {
      // idem
    }
  }

  async function act(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const tickets = data ?? [];
  const waiting = tickets.filter((t) => t.status === 'AGUARDANDO');
  return (
    <Card>
      <CardHeader
        title="Senhas de hoje"
        description={`${waiting.length} aguardando (${waiting.filter((t) => t.kind === 'PRIORIDADE').length} prioritárias)`}
        actions={
          <>
            <Button variant="secondary" size="sm" loading={busy === 'n'} onClick={() => act('n', () => api.post<Ticket>('/reception/tickets', { kind: 'NORMAL' }).then((t) => toast.success(`Senha ${t.code} emitida`)))}>
              <Plus className="h-4 w-4" /> Normal
            </Button>
            <Button variant="secondary" size="sm" loading={busy === 'p'} onClick={() => act('p', () => api.post<Ticket>('/reception/tickets', { kind: 'PRIORIDADE' }).then((t) => toast.success(`Senha ${t.code} emitida`)))}>
              <Plus className="h-4 w-4" /> Prioridade
            </Button>
          </>
        }
      />
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Local de chamada" htmlFor="desk" className="min-w-40 flex-1">
            <Input id="desk" value={desk} onChange={(e) => rememberDesk(e.target.value)} />
          </Field>
          <Button
            size="lg"
            loading={busy === 'next'}
            onClick={() => act('next', () => api.post<{ code: string }>('/reception/tickets/call-next', { desk }).then((r) => toast.success(`Chamando ${r.code}`)))}
          >
            <Megaphone className="h-4 w-4" /> Chamar próxima
          </Button>
        </div>
        {loading && !data ? (
          <Spinner />
        ) : tickets.length === 0 ? (
          <EmptyState title="Nenhuma senha emitida hoje" />
        ) : (
          <ul className="flex max-h-[28rem] flex-col divide-y divide-slate-100 overflow-y-auto">
            {tickets.map((t) => (
              <li key={t.id} className={`flex flex-wrap items-center gap-2 py-2 ${selectedId === t.id ? 'bg-brand-50' : ''}`}>
                <span className="w-16 font-mono text-lg font-semibold">{t.code}</span>
                {t.kind === 'PRIORIDADE' && <Badge tone="violet">Prioridade</Badge>}
                <Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge>
                <span className="text-xs text-slate-500">
                  {fmtTime(t.createdAt)}
                  {t.calledAt ? ` · chamada ${fmtTime(t.calledAt)} (${t.desk})` : ''}
                </span>
                <span className="ml-auto flex gap-1">
                  {(t.status === 'AGUARDANDO' || t.status === 'CHAMADA') && (
                    <>
                      <Button size="sm" variant="ghost" title="Chamar no painel" loading={busy === `c${t.id}`} onClick={() => act(`c${t.id}`, () => api.post(`/reception/tickets/${t.id}/call`, { desk }))}>
                        <BellRing className="h-4 w-4" />
                        <span className="sr-only">Chamar {t.code}</span>
                      </Button>
                      {onSelect && (
                        <Button size="sm" variant="secondary" onClick={() => onSelect(t)}>
                          Acolher
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" title="Marcar ausente" onClick={() => act(`a${t.id}`, () => api.post(`/reception/tickets/${t.id}/absent`))}>
                        <UserX className="h-4 w-4" />
                        <span className="sr-only">Marcar {t.code} como ausente</span>
                      </Button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
