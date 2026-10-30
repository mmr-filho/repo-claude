'use client';

import { useEffect } from 'react';
import { Select } from '@/components/ui/input';
import { useApi } from '@/lib/hooks';
import type { StockLocation } from './types';

/** Locais de estoque da unidade ativa (scope "unit") ou de toda a rede (scope "all", ex.: destino de transferência). */
export function LocationSelect({
  value,
  onChange,
  scope = 'unit',
  id,
  exclude,
  autoSelect = true,
  label = 'Local de estoque',
}: {
  value: string;
  onChange: (id: string, location?: StockLocation) => void;
  scope?: 'unit' | 'all';
  id?: string;
  exclude?: string;
  autoSelect?: boolean;
  label?: string;
}) {
  const { data } = useApi<StockLocation[]>(`/pharmacy/locations?scope=${scope}`);
  const options = (data ?? []).filter((l) => l.id !== exclude);
  useEffect(() => {
    if (autoSelect && !value && options[0]) onChange(options[0].id, options[0]);
  }, [autoSelect, value, options, onChange]);
  return (
    <Select id={id} value={value} aria-label={label} onChange={(e) => onChange(e.target.value, options.find((o) => o.id === e.target.value))}>
      {!autoSelect && <option value="">Selecione…</option>}
      {options.map((l) => (
        <option key={l.id} value={l.id}>
          {scope === 'all' ? `${l.unit.name} · ${l.name}` : l.name}
        </option>
      ))}
    </Select>
  );
}
