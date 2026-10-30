'use client';

import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { formatCns } from '@/lib/format';
import type { PatientSummary } from '@/lib/types';

/** Busca por nome (sem acento), CPF ou CNS, com resultados enquanto digita. */
export function PatientSearch({ onSelect, autoFocus, placeholder }: { onSelect: (p: PatientSummary) => void; autoFocus?: boolean; placeholder?: string }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PatientSummary[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (q.trim().length < 3) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        setResults(await api.get<PatientSummary[]>(`/patients?q=${encodeURIComponent(q)}`, { signal: ctrl.signal }));
        setOpen(true);
      } catch {
        // busca incremental: ignora erros intermediários
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder ?? 'Nome, CPF ou CNS do paciente'}
        className="pl-9"
        autoFocus={autoFocus}
        aria-label="Buscar paciente"
      />
      {open && results.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg" role="listbox">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-slate-50"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(p);
                  setOpen(false);
                  setQ('');
                }}
              >
                <span className="font-medium">{p.name}</span>
                <span className="text-xs text-slate-500">
                  {p.age} anos · {p.sex === 'F' ? 'Feminino' : 'Masculino'}
                  {p.cns ? ` · CNS ${formatCns(p.cns)}` : ''}
                  {p.motherName ? ` · Mãe: ${p.motherName}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
