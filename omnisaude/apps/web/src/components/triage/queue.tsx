'use client';

import { RISK_INFO, type RiskColor } from '@omnisaude/shared';
import { AlarmClock, ChevronRight } from 'lucide-react';
import { RiskBadge } from '@/components/ui/badge';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { fmtMinutes, fmtTime } from '@/lib/format';

export interface QueueRow {
  encounterId: string;
  status: 'ABERTO' | 'TRIADO' | 'EM_ATENDIMENTO';
  kind: string;
  ticket: string | null;
  arrivedAt: string;
  patient: { id: string; name: string; age: number; sex: 'M' | 'F' };
  triage: { color: RiskColor; classifiedAt: string; complaint: string; painScore: number | null } | null;
  waitingMinutes: number;
  maxWaitMinutes: number | null;
  overdue: boolean;
}

export interface TriageQueue {
  awaitingTriage: QueueRow[];
  awaitingDoctor: QueueRow[];
  inProgress: QueueRow[];
  scheduled: QueueRow[];
  counts: Record<RiskColor, number>;
}

const BORDER: Record<RiskColor, string> = {
  VERMELHO: 'border-l-risk-vermelho',
  LARANJA: 'border-l-risk-laranja',
  AMARELO: 'border-l-risk-amarelo',
  VERDE: 'border-l-risk-verde',
  AZUL: 'border-l-risk-azul',
};

/** Linhas da fila: cor + rótulo, tempo de espera contra o tempo-alvo da cor e destaque de atraso. */
export function QueueList({ rows, onOpen, actionLabel = 'Abrir', empty }: { rows: QueueRow[]; onOpen?: (r: QueueRow) => void; actionLabel?: string; empty: string }) {
  if (rows.length === 0) return <EmptyState title={empty} />;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.encounterId}>
          <button
            type="button"
            onClick={() => onOpen?.(r)}
            disabled={!onOpen}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg border border-l-8 border-slate-200 bg-white px-3 py-2 text-left hover:bg-slate-50 disabled:cursor-default',
              r.triage ? BORDER[r.triage.color] : 'border-l-slate-300',
              r.overdue && 'ring-2 ring-red-400',
            )}
            aria-label={`${r.patient.name}${r.triage ? `, ${r.triage.color}` : ''}, aguardando ${fmtMinutes(r.waitingMinutes)}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {r.ticket && <span className="font-mono text-sm font-semibold">{r.ticket}</span>}
                <span className="font-medium">{r.patient.name}</span>
                <span className="text-xs text-slate-500">
                  {r.patient.age} anos · {r.patient.sex}
                </span>
                {r.triage && <RiskBadge color={r.triage.color} compact />}
              </div>
              {r.triage?.complaint && <p className="truncate text-sm text-slate-600">{r.triage.complaint}</p>}
              <p className="text-xs text-slate-500">Chegada {fmtTime(r.arrivedAt)}</p>
            </div>
            <div className="text-right">
              <p className={cn('flex items-center justify-end gap-1 text-sm font-semibold tabular-nums', r.overdue ? 'text-red-700' : 'text-slate-700')}>
                <AlarmClock className="h-4 w-4" /> {fmtMinutes(r.waitingMinutes)}
              </p>
              {r.maxWaitMinutes !== null && <p className="text-xs text-slate-500">meta {r.maxWaitMinutes === 0 ? 'imediato' : fmtMinutes(r.maxWaitMinutes)}</p>}
              {r.overdue && <Badge tone="red">Atrasado</Badge>}
            </div>
            {onOpen && (
              <span className="hidden items-center gap-1 text-sm text-brand-700 sm:flex">
                {actionLabel} <ChevronRight className="h-4 w-4" />
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function RiskCounts({ counts }: { counts: Record<RiskColor, number> }) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Pacientes aguardando por cor">
      {(Object.keys(RISK_INFO) as RiskColor[]).map((c) => (
        <span key={c} className="flex items-center gap-1 text-sm">
          <RiskBadge color={c} compact />
          <b className="tabular-nums">{counts[c] ?? 0}</b>
        </span>
      ))}
    </div>
  );
}
