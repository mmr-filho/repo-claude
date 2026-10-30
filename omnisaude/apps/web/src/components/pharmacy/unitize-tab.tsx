'use client';

import { Printer, Scissors } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Barcode } from '@/components/ui/barcode';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { LocationSelect } from './location-select';
import type { StockResponse } from './types';

export interface DoseLabel {
  unitDoseId: string;
  serial: string;
  gtin: string;
  lot: string;
  expiry: string;
  gs1: string;
  product: string;
  unit: string;
  highAlert: boolean;
}

/** Unitarização (RDC 67/2007): desmembra o lote em doses serializadas com etiqueta Datamatrix GS1. */
export function UnitizeTab() {
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [lotId, setLotId] = useState('');
  const [quantity, setQuantity] = useState('10');
  const [expiry, setExpiry] = useState('');
  const [labels, setLabels] = useState<DoseLabel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const stock = useApi<StockResponse>(from ? `/pharmacy/stock?locationId=${from}` : null, [from]);
  const lots = (stock.data?.items ?? []).filter((i) => i.alert !== 'VENCIDO');
  const lot = lots.find((l) => l.lotId === lotId);

  async function unitize() {
    setPending(true);
    setError(null);
    try {
      const res = await api.post<{ quantity: number; labels: DoseLabel[] }>('/pharmacy/unitize', {
        lotId,
        fromLocationId: from,
        toLocationId: to,
        quantity: Number(quantity),
        ...(expiry ? { expiry } : {}),
      });
      setLabels(res.labels);
      toast.success(`${res.quantity} dose(s) unitária(s) geradas. Imprima as etiquetas.`);
      void stock.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="no-print">
        <CardHeader title="Unitarização de doses" description="A validade recalculada após o fracionamento ou diluição nunca pode passar da validade do lote original." />
        <CardBody className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Estoque de origem">
              <LocationSelect value={from} onChange={(id) => { setFrom(id); setLotId(''); }} />
            </Field>
            <Field label="Destino das doses (mesma unidade)">
              <LocationSelect value={to} onChange={setTo} />
            </Field>
          </div>
          <div className="grid gap-3 md:grid-cols-[1fr_8rem_12rem]">
            <Field label="Produto e lote">
              <Select value={lotId} onChange={(e) => setLotId(e.target.value)}>
                <option value="">Selecione…</option>
                {lots.map((l) => (
                  <option key={l.lotId} value={l.lotId}>
                    {l.product} · lote {l.lot} · val. {fmtDate(l.expiry)} · saldo {l.quantity}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Doses">
              <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="Validade recalculada" hint={lot ? `Máximo: ${fmtDate(lot.expiry)}` : 'Padrão: a do lote'}>
              <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} max={lot?.expiry} />
            </Field>
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={unitize} loading={pending} disabled={!from || !to || !lotId || !(Number(quantity) > 0)}>
              <Scissors className="h-4 w-4" /> Unitarizar
            </Button>
            {labels.length > 0 && (
              <Button variant="secondary" onClick={() => window.print()}>
                <Printer className="h-4 w-4" /> Imprimir {labels.length} etiqueta(s)
              </Button>
            )}
          </div>
        </CardBody>
      </Card>
      {labels.length > 0 && <LabelSheet labels={labels} />}
    </div>
  );
}

/** Folha de etiquetas: na impressão só ela aparece (grade de etiquetas com Datamatrix). */
export function LabelSheet({ labels }: { labels: DoseLabel[] }) {
  return (
    <section aria-label="Etiquetas para impressão" className="print-labels">
      <style>{`
        @media print {
          @page { margin: 8mm; }
          body * { visibility: hidden; }
          .print-labels, .print-labels * { visibility: visible; }
          .print-labels { position: absolute; left: 0; top: 0; width: 100%; }
        }
      `}</style>
      <p className="no-print mb-2 text-sm text-slate-600">Pré-visualização das etiquetas:</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 print:grid-cols-3 print:gap-1">
        {labels.map((l) => (
          <div key={l.serial} className="flex break-inside-avoid gap-2 rounded border border-slate-300 bg-white p-2 print:rounded-none">
            <Barcode kind="gs1datamatrix" value={l.gs1} scale={2} className="shrink-0 [&_svg]:h-20 [&_svg]:w-20" label={`Datamatrix ${l.serial}`} />
            <div className="min-w-0 text-[10px] leading-tight">
              <p className="font-semibold text-[11px]">{l.product}</p>
              <p>Lote {l.lot}</p>
              <p>Val. {fmtDate(l.expiry)}</p>
              <p className="font-mono">Série {l.serial}</p>
              {l.highAlert && <Badge tone="red" className="mt-0.5 px-1 py-0 text-[9px]">ALTA VIGILÂNCIA</Badge>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
