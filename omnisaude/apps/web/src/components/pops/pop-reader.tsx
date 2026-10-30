'use client';

import { ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/misc';
import { useApi } from '@/lib/hooks';
import { TRIGGER_LABELS, type Pop } from './types';

/** Conteúdo de um POP. A leitura de um POP consultivo é registrada na trilha de auditoria pela API. */
export function PopReader({ id }: { id: string }) {
  const { data: pop, loading, error } = useApi<Pop>(`/pops/${id}`);
  if (loading) return <Spinner />;
  if (error || !pop) return <p className="text-sm text-red-700">{error ?? 'POP não encontrado'}</p>;
  return (
    <article className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={pop.kind === 'HARD' ? 'red' : 'blue'}>{pop.kind === 'HARD' ? 'Barreira obrigatória' : 'Guia consultivo'}</Badge>
        <Badge>{pop.code}</Badge>
        <Badge>versão {pop.version}</Badge>
        {pop.trigger && <Badge tone="amber">{TRIGGER_LABELS[pop.trigger] ?? pop.trigger}</Badge>}
      </div>
      <p className="whitespace-pre-line text-sm leading-relaxed text-slate-800">{pop.content}</p>
      {pop.checklist.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Checklist</h3>
          <ul className="space-y-1.5">
            {pop.checklist.map((c) => (
              <li key={c.id} className="flex gap-2 text-sm">
                <span aria-hidden>☐</span>
                <span>
                  {c.text}
                  {c.required && <span className="ml-1 text-xs font-medium text-red-700">(obrigatório)</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {pop.requiresDoubleCheck && (
        <p className="flex items-center gap-2 text-sm text-amber-800">
          <ShieldAlert className="h-4 w-4" /> Exige dupla checagem por um segundo profissional.
        </p>
      )}
    </article>
  );
}
