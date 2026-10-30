'use client';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/card';
import { Alert, Spinner } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { fmtTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';

export interface Slot {
  id: string;
  startsAt: string;
  endsAt: string;
  status: 'LIVRE' | 'OCUPADO' | 'BLOQUEADO' | 'PASSADO';
  ruleId: string;
  appointmentId?: string;
}

export interface DaySlots {
  scheduleId: string;
  date: string;
  slotMinutes: number;
  slots: Slot[];
  quotas: { ruleId: string; window: string; firstVisit: { quota: number; used: number }; return: { quota: number; used: number } }[];
}

const STYLE: Record<Slot['status'], string> = {
  LIVRE: 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100',
  OCUPADO: 'border-brand-200 bg-brand-50 text-brand-900',
  BLOQUEADO: 'border-slate-300 bg-slate-200 text-slate-500 line-through',
  PASSADO: 'border-slate-200 bg-slate-50 text-slate-400',
};
const LABEL: Record<Slot['status'], string> = { LIVRE: 'livre', OCUPADO: 'ocupado', BLOQUEADO: 'bloqueado', PASSADO: 'passado' };

/** Grade de horários do dia com o uso das cotas por turno. */
export function SlotPicker({ scheduleId, date, onPick, refreshKey, selectable = ['LIVRE'] }: { scheduleId: string; date: string; onPick?: (s: Slot) => void; refreshKey?: number; selectable?: Slot['status'][] }) {
  const { data, error, loading } = useApi<DaySlots>(`/scheduling/schedules/${scheduleId}/slots?date=${date}`, [refreshKey]);
  if (loading && !data) return <Spinner />;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data || data.slots.length === 0) return <EmptyState title="Sem atendimento nesta data" description="A agenda não tem grade para este dia da semana." />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {data.quotas.map((q) => (
          <span key={q.ruleId} className="text-xs text-slate-600">
            <b>{q.window}</b>: 1ª consulta{' '}
            <Badge tone={q.firstVisit.used >= q.firstVisit.quota ? 'red' : 'green'}>
              {q.firstVisit.used}/{q.firstVisit.quota}
            </Badge>{' '}
            retorno{' '}
            <Badge tone={q.return.used >= q.return.quota ? 'red' : 'green'}>
              {q.return.used}/{q.return.quota}
            </Badge>
          </span>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {data.slots.map((s) => {
          const can = !!onPick && selectable.includes(s.status);
          return (
            <button
              key={s.id}
              type="button"
              disabled={!can}
              onClick={() => can && onPick?.(s)}
              className={cn('flex min-h-11 flex-col items-center justify-center rounded-lg border px-2 py-1 text-sm', STYLE[s.status], !can && 'cursor-default')}
              aria-label={`${fmtTime(s.startsAt)} ${LABEL[s.status]}`}
            >
              <span className="font-mono font-semibold">{fmtTime(s.startsAt)}</span>
              <span className="text-[10px] uppercase">{LABEL[s.status]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
