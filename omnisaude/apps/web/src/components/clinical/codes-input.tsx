'use client';

import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import type { CodeRef } from './types';

const VALID = /^[A-Za-z]\d{2}(\.?\d{1,2})?$/;

/** Códigos CID-10 / CIAP-2 do registro, como etiquetas. */
export function CodesInput({ value, onChange, disabled }: { value: CodeRef[]; onChange: (v: CodeRef[]) => void; disabled?: boolean }) {
  const [system, setSystem] = useState<CodeRef['system']>('CID10');
  const [code, setCode] = useState('');
  const valid = VALID.test(code.trim());
  function add() {
    const c = code.trim().toUpperCase().replace('.', '');
    if (!VALID.test(c) || value.some((v) => v.system === system && v.code === c)) return;
    onChange([...value, { system, code: c }]);
    setCode('');
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {value.map((c) => (
          <span key={`${c.system}:${c.code}`} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-3 py-1 text-sm font-medium text-brand-800 ring-1 ring-brand-200">
            {c.system === 'CIAP2' ? 'CIAP-2' : 'CID-10'} {c.code}
            {!disabled && (
              <button type="button" onClick={() => onChange(value.filter((x) => x !== c))} aria-label={`Remover ${c.code}`} className="rounded-full p-0.5 hover:bg-brand-100">
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        {value.length === 0 && <span className="text-sm text-slate-500">Nenhum código informado</span>}
      </div>
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          <Select value={system} onChange={(e) => setSystem(e.target.value as CodeRef['system'])} className="w-28" aria-label="Sistema de codificação">
            <option value="CID10">CID-10</option>
            <option value="CIAP2">CIAP-2</option>
          </Select>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder={system === 'CID10' ? 'Ex.: I10, E11.9' : 'Ex.: K86'}
            className="w-36"
            aria-label="Código"
          />
          <Button variant="secondary" onClick={add} disabled={!valid}>
            <Plus className="h-4 w-4" /> Adicionar
          </Button>
        </div>
      )}
    </div>
  );
}
