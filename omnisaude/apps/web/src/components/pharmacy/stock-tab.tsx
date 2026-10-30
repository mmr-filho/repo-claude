'use client';

import { AlertTriangle, PackageSearch } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, EmptyState, Stat } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { ScanInput } from '@/components/scan/scan-input';
import { api, errorMessage } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { LocationSelect } from './location-select';
import type { StockResponse } from './types';

interface Lookup {
  product: { id: string; code: string; description: string; unit: string; highAlert: boolean; antimicrobialRestricted: boolean; controlledList: string | null };
  lot: { id: string; lotNumber: string; expiry: string } | null;
  unitDose: { id: string; serial: string; status: string; expiry: string; locationId: string } | null;
}

export function StockTab() {
  const [locationId, setLocationId] = useState('');
  const [filter, setFilter] = useState('');
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const stock = useApi<StockResponse>(locationId ? `/pharmacy/stock?locationId=${locationId}` : null, [locationId]);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const items = (stock.data?.items ?? []).filter(
    (i) => (!onlyAlerts || i.alert) && (!filter.trim() || `${i.product} ${i.productCode} ${i.lot}`.toLowerCase().includes(filter.trim().toLowerCase())),
  );
  const total = new Set((stock.data?.items ?? []).map((i) => i.productId)).size;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-[minmax(0,18rem)_1fr]">
        <Field label="Local de estoque">
          <LocationSelect value={locationId} onChange={setLocationId} />
        </Field>
        <Field label="Consultar código (Datamatrix, GTIN)" hint="Use o leitor ou a câmera para identificar produto, lote e dose unitária.">
          <ScanInput
            onScan={async (code) => {
              setLookupError(null);
              try {
                setLookup(await api.get<Lookup>(`/pharmacy/lookup?code=${encodeURIComponent(code)}`));
              } catch (err) {
                setLookup(null);
                setLookupError(errorMessage(err));
              }
            }}
          />
        </Field>
      </div>
      {lookupError && <Alert tone="error">{lookupError}</Alert>}
      {lookup && (
        <Alert tone="info" title={lookup.product.description}>
          <span className="flex flex-wrap gap-2">
            <Badge>{lookup.product.code}</Badge>
            {lookup.lot && <Badge>Lote {lookup.lot.lotNumber} · validade {fmtDate(lookup.lot.expiry)}</Badge>}
            {lookup.unitDose && (
              <Badge tone={lookup.unitDose.status === 'DISPONIVEL' ? 'green' : 'amber'}>
                Dose {lookup.unitDose.serial}: {lookup.unitDose.status.toLowerCase()}
              </Badge>
            )}
            {lookup.product.highAlert && <Badge tone="red">Alta vigilância</Badge>}
            {lookup.product.antimicrobialRestricted && <Badge tone="violet">Antimicrobiano restrito</Badge>}
            {lookup.product.controlledList && <Badge tone="amber">Controlado {lookup.product.controlledList}</Badge>}
          </span>
        </Alert>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Produtos com saldo" value={total} />
        <Stat label="Lotes" value={stock.data?.items.length ?? '—'} />
        <Stat label="Vencidos" value={stock.data?.alerts.expired ?? '—'} tone={stock.data?.alerts.expired ? 'bad' : 'default'} />
        <Stat label={`Vencem em ${stock.data?.alerts.windowDays ?? 60} dias`} value={stock.data?.alerts.expiringSoon ?? '—'} tone={stock.data?.alerts.expiringSoon ? 'warn' : 'default'} />
      </div>
      <Card>
        <CardHeader
          title="Saldos por lote"
          actions={
            <>
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar produto ou lote" aria-label="Filtrar" className="w-56" />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={onlyAlerts} onChange={(e) => setOnlyAlerts(e.target.checked)} />
                Só alertas
              </label>
            </>
          }
        />
        {stock.loading ? (
          <Spinner />
        ) : stock.error ? (
          <CardBody>
            <Alert tone="error">{stock.error}</Alert>
          </CardBody>
        ) : items.length === 0 ? (
          <EmptyState icon={<PackageSearch className="h-8 w-8" />} title="Nenhum saldo encontrado" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Produto</TH>
                <TH>Lote</TH>
                <TH>Validade</TH>
                <TH className="text-right">Quantidade</TH>
              </tr>
            </THead>
            <TBody>
              {items.map((i) => (
                <TR key={`${i.locationId}-${i.lotId}`}>
                  <TD>
                    <span className="font-medium">{i.product}</span>
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      <span className="text-xs text-slate-500">{i.productCode}</span>
                      {i.highAlert && <Badge tone="red">Alta vigilância</Badge>}
                      {i.controlledList && <Badge tone="amber">Lista {i.controlledList}</Badge>}
                    </span>
                  </TD>
                  <TD className="font-mono text-xs">{i.lot}</TD>
                  <TD>
                    <span className="whitespace-nowrap">{fmtDate(i.expiry)}</span>
                    {i.alert === 'VENCIDO' && (
                      <Badge tone="red" className="ml-2">
                        <AlertTriangle className="h-3 w-3" /> Vencido
                      </Badge>
                    )}
                    {i.alert === 'VENCE_EM_BREVE' && (
                      <Badge tone="amber" className="ml-2">
                        Vence em breve
                      </Badge>
                    )}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {i.quantity.toLocaleString('pt-BR')} <span className="text-xs text-slate-500">{i.unit}</span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
