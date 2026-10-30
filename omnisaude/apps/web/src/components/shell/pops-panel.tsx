'use client';

import { BookOpenCheck, ChevronLeft, ShieldAlert, X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/misc';
import { PopReader } from '@/components/pops/pop-reader';
import type { PopSummary } from '@/components/pops/types';
import { useApi } from '@/lib/hooks';

/** Painel lateral retrátil com a biblioteca de POPs, disponível em qualquer tela (soft gates). */
export function PopsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data, loading, error } = useApi<PopSummary[]>(open ? '/pops' : null, [open]);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const list = (data ?? []).filter((p) => !q.trim() || `${p.code} ${p.title}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-slate-900/30" />
        <D.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-white shadow-2xl">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
            {selected ? (
              <button onClick={() => setSelected(null)} className="rounded-md p-1 hover:bg-slate-100" aria-label="Voltar à lista">
                <ChevronLeft className="h-5 w-5" />
              </button>
            ) : (
              <BookOpenCheck className="h-5 w-5 text-brand-600" />
            )}
            <D.Title className="flex-1 text-base font-semibold">Procedimentos operacionais</D.Title>
            <D.Description className="sr-only">Biblioteca de POPs da instituição</D.Description>
            <D.Close className="rounded-md p-1 text-slate-500 hover:bg-slate-100" aria-label="Fechar">
              <X className="h-5 w-5" />
            </D.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {selected ? (
              <PopReader id={selected} />
            ) : loading ? (
              <Spinner />
            ) : error ? (
              <p className="text-sm text-red-700">{error}</p>
            ) : (
              <>
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar POP" aria-label="Buscar POP" className="mb-3" />
                <ul className="divide-y divide-slate-100">
                  {list.map((p) => (
                    <li key={p.id}>
                      <button onClick={() => setSelected(p.id)} className="flex w-full items-start gap-3 py-3 text-left hover:bg-slate-50">
                        {p.kind === 'HARD' ? <ShieldAlert className="mt-0.5 h-4 w-4 text-red-600" /> : <BookOpenCheck className="mt-0.5 h-4 w-4 text-brand-600" />}
                        <span className="flex-1">
                          <span className="block text-sm font-medium">{p.title}</span>
                          <span className="text-xs text-slate-500">{p.code}</span>
                        </span>
                        <Badge tone={p.kind === 'HARD' ? 'red' : 'blue'}>{p.kind === 'HARD' ? 'Obrigatório' : 'Consulta'}</Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
