'use client';

import { CalendarClock, Check, LogIn, UserX, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtTime, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';
import { SlotPicker } from './slot-picker';

export interface Appointment {
  id: string;
  scheduleId: string;
  patientId: string;
  startsAt: string;
  endsAt: string;
  kind: 'PRIMEIRA_CONSULTA' | 'RETORNO';
  status: 'AGENDADO' | 'CONFIRMADO' | 'CANCELADO' | 'FALTOU' | 'ATENDIDO' | 'REMARCADO';
  confirmationChannel: string | null;
  cancelReason: string | null;
  notes: string | null;
  patient: { id: string; name: string; socialName: string | null; cns: string | null; phone: string | null; birthDate: string };
  schedule: { name: string };
}

export const APPT_STATUS: Record<Appointment['status'], { label: string; tone: 'slate' | 'blue' | 'green' | 'amber' | 'red' | 'violet' }> = {
  AGENDADO: { label: 'Agendado', tone: 'slate' },
  CONFIRMADO: { label: 'Confirmado', tone: 'green' },
  CANCELADO: { label: 'Cancelado', tone: 'red' },
  FALTOU: { label: 'Faltou', tone: 'amber' },
  ATENDIDO: { label: 'Chegou', tone: 'blue' },
  REMARCADO: { label: 'Remarcado', tone: 'violet' },
};

/** Lista de agendamentos com as ações da recepção (confirmar, chegada, falta, cancelar, remarcar). */
export function AppointmentsList({ items, onChanged, showDate }: { items: Appointment[]; onChanged: () => void; showDate?: boolean }) {
  const toast = useToast();
  const session = useSession();
  const router = useRouter();
  const canBook = session.can('agenda.marcar');
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<Appointment | null>(null);
  const [reason, setReason] = useState('');
  const [moving, setMoving] = useState<Appointment | null>(null);
  const [moveDate, setMoveDate] = useState(todayIso(1));

  async function act(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) return <EmptyState title="Nenhum agendamento" />;
  return (
    <>
      <ul className="flex flex-col divide-y divide-slate-100">
        {items.map((a) => {
          const open = a.status === 'AGENDADO' || a.status === 'CONFIRMADO';
          const past = new Date(a.startsAt) < new Date();
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="w-20 text-center">
                <p className="font-mono text-lg font-semibold">{fmtTime(a.startsAt)}</p>
                {showDate && <p className="text-xs text-slate-500">{fmtDate(a.startsAt)}</p>}
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{a.patient.socialName ?? a.patient.name}</p>
                <p className="text-xs text-slate-500">
                  {a.schedule.name} · {a.kind === 'PRIMEIRA_CONSULTA' ? 'Primeira consulta' : 'Retorno'}
                  {a.confirmationChannel ? ` · confirmado via ${a.confirmationChannel.toLowerCase()}` : ''}
                </p>
              </div>
              <Badge tone={APPT_STATUS[a.status].tone}>{APPT_STATUS[a.status].label}</Badge>
              {canBook && open && (
                <div className="flex flex-wrap gap-1">
                  {a.status === 'AGENDADO' && (
                    <Button size="sm" variant="ghost" loading={busy === `c${a.id}`} onClick={() => act(`c${a.id}`, () => api.post(`/scheduling/appointments/${a.id}/confirm`), 'Presença confirmada')}>
                      <Check className="h-4 w-4" /> Confirmar
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === `i${a.id}`}
                    onClick={() =>
                      act(
                        `i${a.id}`,
                        async () => {
                          await api.post(`/scheduling/appointments/${a.id}/check-in`);
                        },
                        'Chegada registrada: paciente na fila de atendimento',
                      )
                    }
                  >
                    <LogIn className="h-4 w-4" /> Chegada
                  </Button>
                  {past && (
                    <Button size="sm" variant="ghost" loading={busy === `f${a.id}`} onClick={() => act(`f${a.id}`, () => api.post(`/scheduling/appointments/${a.id}/no-show`), 'Falta registrada')}>
                      <UserX className="h-4 w-4" /> Faltou
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setMoving(a)}>
                    <CalendarClock className="h-4 w-4" /> Remarcar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setCancelling(a)}>
                    <X className="h-4 w-4" /> Cancelar
                  </Button>
                </div>
              )}
              {!open && session.can('prontuario.ler') && (
                <Button size="sm" variant="link" onClick={() => router.push(`/paciente?id=${a.patientId}`)}>
                  Prontuário
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <Dialog
        open={!!cancelling}
        onOpenChange={(o) => !o && setCancelling(null)}
        title="Cancelar agendamento"
        description="A vaga liberada é oferecida automaticamente ao próximo da lista de espera."
        footer={
          <Button
            variant="danger"
            disabled={reason.trim().length < 3}
            onClick={async () => {
              const a = cancelling!;
              setCancelling(null);
              await act(
                `x${a.id}`,
                async () => {
                  const r = await api.post<{ offeredTo: string | null }>(`/scheduling/appointments/${a.id}/cancel`, { reason });
                  if (r.offeredTo) toast.info('Vaga ofertada ao próximo paciente da lista de espera.');
                },
                'Agendamento cancelado',
              );
              setReason('');
            }}
          >
            Cancelar agendamento
          </Button>
        }
      >
        <Field label="Motivo" htmlFor="cancel-reason">
          <Input id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
      </Dialog>
      <Dialog open={!!moving} onOpenChange={(o) => !o && setMoving(null)} title="Remarcar consulta" size="lg">
        {moving && (
          <div className="flex flex-col gap-3">
            <Field label="Nova data" htmlFor="move-date">
              <Input id="move-date" type="date" value={moveDate} onChange={(e) => setMoveDate(e.target.value)} />
            </Field>
            <SlotPicker
              scheduleId={moving.scheduleId}
              date={moveDate}
              onPick={async (slot) => {
                const a = moving;
                setMoving(null);
                await act(`r${a.id}`, () => api.post(`/scheduling/appointments/${a.id}/reschedule`, { startsAt: slot.startsAt }), 'Consulta remarcada');
              }}
            />
          </div>
        )}
      </Dialog>
    </>
  );
}
