'use client';

import { Clock, MapPin, Navigation, Phone } from 'lucide-react';
import { CardItem, CitizenShell } from '@/components/citizen/shell';
import { useCitizen } from '@/components/citizen/hooks';
import type { UnidadeRede } from '@/components/citizen/types';
import { Badge } from '@/components/ui/badge';
import { Alert, Spinner } from '@/components/ui/misc';

export default function CitizenUnitsPage() {
  const { data, error, loading } = useCitizen<UnidadeRede[]>('/cidadao/unidades');
  return (
    <CitizenShell title="Unidades de saúde">
      {error && <Alert tone="error">{error}</Alert>}
      {loading && !data && <Spinner />}
      {data?.map((u) => (
        <CardItem key={u.id} className="mb-2">
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium">{u.name}</p>
            <Badge tone="blue">{u.tipoLabel}</Badge>
          </div>
          {u.address && (
            <p className="mt-1 flex items-center gap-1 text-sm text-slate-600">
              <MapPin className="h-4 w-4 shrink-0" /> {u.address}
            </p>
          )}
          {u.openingHours && (
            <p className="mt-1 flex items-center gap-1 text-sm text-slate-600">
              <Clock className="h-4 w-4 shrink-0" /> {u.openingHours}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-3 text-sm">
            {u.phone && (
              <a href={`tel:${u.phone.replace(/\D/g, '')}`} className="flex items-center gap-1 text-brand-700">
                <Phone className="h-4 w-4" /> {u.phone}
              </a>
            )}
            {u.latitude != null && u.longitude != null && (
              <a href={`https://www.google.com/maps/dir/?api=1&destination=${u.latitude},${u.longitude}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-brand-700">
                <Navigation className="h-4 w-4" /> Como chegar
              </a>
            )}
          </div>
        </CardItem>
      ))}
    </CitizenShell>
  );
}
