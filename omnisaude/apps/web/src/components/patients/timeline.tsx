'use client';

import { CalendarDays, FlaskConical, Pill, Stethoscope, Syringe, Truck } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { RiskColor } from '@omnisaude/shared';
import { Badge, RiskBadge } from '@/components/ui/badge';
import { Select } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/card';
import { fmtDateTime } from '@/lib/format';
import type { TimelineEvent } from './types';

const META: Record<TimelineEvent['type'], { label: string; icon: typeof Stethoscope; tone: 'blue' | 'green' | 'violet' | 'amber' | 'slate' }> = {
  ATENDIMENTO: { label: 'Atendimento', icon: Stethoscope, tone: 'blue' },
  PRESCRICAO: { label: 'Prescrição', icon: Pill, tone: 'violet' },
  DISPENSACAO: { label: 'Dispensação', icon: Truck, tone: 'green' },
  EXAME: { label: 'Exame', icon: FlaskConical, tone: 'amber' },
  VACINA: { label: 'Vacina', icon: Syringe, tone: 'green' },
  AGENDAMENTO: { label: 'Agendamento', icon: CalendarDays, tone: 'slate' },
};

interface NoteDetail {
  id: string;
  kind: string;
  author?: string;
  role: string;
  signedAt: string | null;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
}

/** Linha do tempo única do paciente em toda a rede, com filtros por tipo e unidade. */
export function Timeline({ events, compact }: { events: TimelineEvent[]; compact?: boolean }) {
  const [type, setType] = useState('');
  const [unit, setUnit] = useState('');
  const units = useMemo(() => [...new Set(events.map((e) => e.unit).filter(Boolean))] as string[], [events]);
  const filtered = events.filter((e) => (!type || e.type === type) && (!unit || e.unit === unit));

  return (
    <div className="flex flex-col gap-3">
      {!compact && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filtrar por tipo">
            <option value="">Todos os registros</option>
            {Object.entries(META).map(([k, m]) => (
              <option key={k} value={k}>
                {m.label}
              </option>
            ))}
          </Select>
          <Select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Filtrar por unidade">
            <option value="">Todas as unidades</option>
            {units.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
        </div>
      )}
      {filtered.length === 0 ? (
        <EmptyState title="Nenhum registro" />
      ) : (
        <ol className="relative flex flex-col gap-3 border-l border-slate-200 pl-4">
          {filtered.map((e) => (
            <TimelineItem key={`${e.type}-${e.id}`} event={e} compact={compact} />
          ))}
        </ol>
      )}
    </div>
  );
}

function TimelineItem({ event, compact }: { event: TimelineEvent; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const meta = META[event.type];
  const d = (event.detail ?? {}) as Record<string, unknown>;
  const notes = (d.notes as NoteDetail[] | undefined) ?? [];
  const items = (d.items as { description?: string; product?: string; quantity?: unknown; dose?: unknown; doseUnit?: string; route?: string; frequencyHours?: number }[] | undefined) ?? [];
  const hasMore = notes.length > 0 || items.length > 0 || d.result !== undefined;
  return (
    <li className="relative">
      <span className="absolute -left-[1.4rem] top-1 flex h-5 w-5 items-center justify-center rounded-full bg-white ring-1 ring-slate-200">
        <meta.icon className="h-3 w-3 text-slate-500" />
      </span>
      <button type="button" className="w-full text-left" onClick={() => hasMore && setOpen((o) => !o)} aria-expanded={hasMore ? open : undefined}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          {typeof d.riskColor === 'string' && <RiskBadge color={d.riskColor as RiskColor} compact />}
          <span className="text-xs text-slate-500">{fmtDateTime(event.at)}</span>
        </div>
        <p className="mt-1 text-sm font-medium text-slate-800">{event.title}</p>
        {event.unit && <p className="text-xs text-slate-500">{event.unit}</p>}
        {typeof d.mainCid === 'string' && <p className="text-xs text-slate-600">CID principal: {d.mainCid}</p>}
      </button>
      {open && !compact && (
        <div className="mt-2 flex flex-col gap-2 rounded-lg bg-slate-50 p-3 text-sm">
          {notes.map((n) => (
            <div key={n.id} className="border-b border-slate-200 pb-2 last:border-0 last:pb-0">
              <p className="text-xs text-slate-500">
                {n.kind} · {n.author ?? n.role} · {fmtDateTime(n.signedAt)}
              </p>
              {n.subjective && <p><b>S:</b> {n.subjective}</p>}
              {n.objective && <p><b>O:</b> {n.objective}</p>}
              {n.assessment && <p><b>A:</b> {n.assessment}</p>}
              {n.plan && <p><b>P:</b> {n.plan}</p>}
            </div>
          ))}
          {items.map((i, idx) => (
            <p key={idx}>
              • {i.description ?? i.product} {i.dose ? `${String(i.dose)} ${i.doseUnit ?? ''}` : ''} {i.route ?? ''} {i.frequencyHours ? `a cada ${i.frequencyHours}h` : ''}
              {i.quantity !== undefined && i.description === undefined ? ` — ${String(i.quantity)}` : ''}
            </p>
          ))}
          {d.result !== undefined && d.result !== null && (
            <p>
              Resultado: {String(d.result)} {String(d.unit ?? '')}
            </p>
          )}
        </div>
      )}
      {open && compact && notes.length > 0 && (
        <div className="mt-1 text-xs text-slate-600">
          {notes.map((n) => (
            <p key={n.id}>{n.assessment ?? n.subjective}</p>
          ))}
        </div>
      )}
    </li>
  );
}
