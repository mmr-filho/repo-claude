'use client';

import { BookOpenCheck, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { Spinner } from '@/components/ui/misc';
import { PopReader } from '@/components/pops/pop-reader';
import { TRIGGER_LABELS, type PopSummary } from '@/components/pops/types';
import { useApi } from '@/lib/hooks';
import { cn } from '@/lib/cn';

export default function PopsPage() {
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const { data, loading, error } = useApi<PopSummary[]>(`/pops${kind ? `?kind=${kind}` : ''}`);
  const list = (data ?? []).filter((p) => !q.trim() || `${p.code} ${p.title}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <>
      <PageHeader
        title="Procedimentos operacionais padrão"
        description="Barreiras obrigatórias (checklist e dupla checagem antes de atos de alto risco) e guias consultivos. Consultas aos guias ficam registradas."
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
        <Card>
          <div className="flex gap-2 border-b border-slate-100 p-3">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar" aria-label="Buscar POP" />
            <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo" className="w-40">
              <option value="">Todos</option>
              <option value="HARD">Obrigatórios</option>
              <option value="SOFT">Consultivos</option>
            </Select>
          </div>
          {loading ? (
            <Spinner />
          ) : error ? (
            <p className="p-4 text-sm text-red-700">{error}</p>
          ) : list.length === 0 ? (
            <EmptyState title="Nenhum POP encontrado" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {list.map((p) => (
                <li key={p.id}>
                  <button onClick={() => setSelected(p.id)} className={cn('flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50', selected === p.id && 'bg-brand-50')}>
                    {p.kind === 'HARD' ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" /> : <BookOpenCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />}
                    <span className="flex-1">
                      <span className="block text-sm font-medium">{p.title}</span>
                      <span className="text-xs text-slate-500">
                        {p.code}
                        {p.trigger ? ` · ${TRIGGER_LABELS[p.trigger] ?? p.trigger}` : ''}
                      </span>
                    </span>
                    {p.requiresDoubleCheck && <Badge tone="amber">Dupla checagem</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          {selected ? (
            <>
              <CardHeader title="Leitura do POP" />
              <CardBody>
                <PopReader id={selected} />
              </CardBody>
            </>
          ) : (
            <EmptyState icon={<BookOpenCheck className="h-8 w-8" />} title="Selecione um POP" description="O conteúdo e o checklist aparecem aqui." />
          )}
        </Card>
      </div>
    </>
  );
}
