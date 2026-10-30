'use client';

import { normalizeGtin, parseGs1 } from '@omnisaude/shared';
import { ArrowRight, PackageCheck, Plus, Send, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { ScanInput } from '@/components/scan/scan-input';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { LocationSelect } from './location-select';
import type { StockResponse } from './types';

interface TransferItem {
  id: string;
  lotId: string;
  quantity: number;
  receivedQuantity: number | null;
  product?: string;
  gtin?: string | null;
  lot?: string;
  expiry?: string | null;
}

interface Transfer {
  id: string;
  status: 'SEPARACAO' | 'EXPEDIDA' | 'RECEBIDA' | 'DIVERGENTE' | 'CANCELADA';
  fromLocationId: string;
  toLocationId: string;
  fromLocationName?: string;
  toLocationName?: string;
  direction: 'ENTRADA' | 'SAIDA';
  createdAt: string;
  dispatchedAt: string | null;
  receivedAt: string | null;
  notes: string | null;
  items: TransferItem[];
}

const STATUS: Record<Transfer['status'], { label: string; tone: 'slate' | 'blue' | 'green' | 'amber' | 'red' }> = {
  SEPARACAO: { label: 'Em separação', tone: 'slate' },
  EXPEDIDA: { label: 'Expedida', tone: 'blue' },
  RECEBIDA: { label: 'Recebida', tone: 'green' },
  DIVERGENTE: { label: 'Recebida com divergência', tone: 'amber' },
  CANCELADA: { label: 'Cancelada', tone: 'red' },
};

export function TransfersTab() {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const transfers = useApi<Transfer[]>(`/pharmacy/transfers${status ? `?status=${status}` : ''}`);
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<Transfer | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(t: Transfer, action: 'dispatch' | 'cancel') {
    setBusy(t.id);
    try {
      await api.post(`/pharmacy/transfers/${t.id}/${action}`);
      toast.success(action === 'dispatch' ? 'Expedição registrada: saldo baixado na origem.' : 'Transferência cancelada.');
      void transfers.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Transferências entre estoques"
          description="Dupla conferência: a expedição baixa o saldo na origem e o recebimento, conferido por outro profissional no destino, credita o que foi bipado."
          actions={
            <>
              <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação" className="w-48">
                <option value="">Todas</option>
                {Object.entries(STATUS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </Select>
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> Nova transferência
              </Button>
            </>
          }
        />
        {transfers.loading ? (
          <Spinner />
        ) : transfers.error ? (
          <CardBody>
            <Alert tone="error">{transfers.error}</Alert>
          </CardBody>
        ) : (transfers.data ?? []).length === 0 ? (
          <EmptyState title="Nenhuma transferência" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {(transfers.data ?? []).map((t) => (
              <li key={t.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {t.fromLocationName} <ArrowRight className="h-4 w-4 text-slate-400" /> {t.toLocationName}
                    <Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge>
                    <Badge>{t.direction === 'ENTRADA' ? 'Entrada' : 'Saída'}</Badge>
                  </p>
                  <p className="text-xs text-slate-500">
                    Criada {fmtDateTime(t.createdAt)}
                    {t.dispatchedAt && ` · expedida ${fmtDateTime(t.dispatchedAt)}`}
                    {t.receivedAt && ` · recebida ${fmtDateTime(t.receivedAt)}`}
                  </p>
                  <ul className="mt-2 space-y-0.5 text-sm">
                    {t.items.map((i) => (
                      <li key={i.id}>
                        {i.product} · lote {i.lot} · {i.quantity.toLocaleString('pt-BR')}
                        {i.receivedQuantity !== null && i.receivedQuantity !== i.quantity && (
                          <span className="ml-1 font-medium text-amber-700">(recebido {i.receivedQuantity.toLocaleString('pt-BR')})</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex gap-2">
                  {t.status === 'SEPARACAO' && t.direction === 'SAIDA' && (
                    <>
                      <Button size="sm" onClick={() => act(t, 'dispatch')} loading={busy === t.id}>
                        <Send className="h-4 w-4" /> Expedir
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => act(t, 'cancel')} disabled={busy === t.id}>
                        <X className="h-4 w-4" /> Cancelar
                      </Button>
                    </>
                  )}
                  {t.status === 'EXPEDIDA' && t.direction === 'ENTRADA' && (
                    <Button size="sm" onClick={() => setReceiving(t)}>
                      <PackageCheck className="h-4 w-4" /> Conferir recebimento
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {creating && (
        <CreateTransferDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            toast.success('Transferência criada em separação. Expeça quando o material sair.');
            void transfers.reload();
          }}
        />
      )}
      {receiving && (
        <ReceiveDialog
          transfer={receiving}
          onClose={() => setReceiving(null)}
          onDone={(divergent) => {
            setReceiving(null);
            if (divergent) toast.info('Recebimento registrado com divergência: só o conferido entrou no estoque.');
            else toast.success('Recebimento conferido e creditado no estoque.');
            void transfers.reload();
          }}
        />
      )}
    </div>
  );
}

function CreateTransferDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<{ lotId: string; quantity: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const stock = useApi<StockResponse>(from ? `/pharmacy/stock?locationId=${from}` : null, [from]);
  const available = (stock.data?.items ?? []).filter((i) => i.alert !== 'VENCIDO');
  const byLot = new Map(available.map((i) => [i.lotId, i]));

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="Nova transferência"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={pending}
            disabled={!from || !to || lines.length === 0 || lines.some((l) => !l.lotId || !(Number(l.quantity) > 0))}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await api.post('/pharmacy/transfers', { fromLocationId: from, toLocationId: to, notes: notes || undefined, items: lines.map((l) => ({ lotId: l.lotId, quantity: Number(l.quantity) })) });
                onCreated();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setPending(false);
              }
            }}
          >
            Criar transferência
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Origem (sua unidade)">
            <LocationSelect value={from} onChange={(id) => { setFrom(id); setLines([]); }} />
          </Field>
          <Field label="Destino">
            <LocationSelect value={to} onChange={setTo} scope="all" exclude={from} autoSelect={false} />
          </Field>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Itens</p>
          {lines.map((l, idx) => {
            const item = byLot.get(l.lotId);
            return (
              <div key={idx} className="flex flex-wrap items-center gap-2">
                <Select
                  value={l.lotId}
                  onChange={(e) => setLines((s) => s.map((x, i) => (i === idx ? { ...x, lotId: e.target.value } : x)))}
                  aria-label="Produto e lote"
                  className="min-w-0 flex-1"
                >
                  <option value="">Produto / lote…</option>
                  {available.map((i) => (
                    <option key={i.lotId} value={i.lotId}>
                      {i.product} · lote {i.lot} · val. {fmtDate(i.expiry)} · saldo {i.quantity}
                    </option>
                  ))}
                </Select>
                <Input
                  value={l.quantity}
                  onChange={(e) => setLines((s) => s.map((x, i) => (i === idx ? { ...x, quantity: e.target.value } : x)))}
                  inputMode="decimal"
                  className="w-28"
                  aria-label="Quantidade"
                  placeholder={item ? `máx. ${item.quantity}` : 'Qtd.'}
                />
                <Button variant="ghost" size="icon" onClick={() => setLines((s) => s.filter((_, i) => i !== idx))} aria-label="Remover item">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
          <Button variant="secondary" size="sm" onClick={() => setLines((s) => [...s, { lotId: '', quantity: '' }])} disabled={!from}>
            <Plus className="h-4 w-4" /> Adicionar item
          </Button>
        </div>
        <Field label="Observações">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Dialog>
  );
}

/** Conferência no destino: cada bipagem (Datamatrix com GTIN + lote) soma 1; a quantidade pode ser ajustada. */
function ReceiveDialog({ transfer, onClose, onDone }: { transfer: Transfer; onClose: () => void; onDone: (divergent: boolean) => void }) {
  const [counts, setCounts] = useState<Record<string, string>>(() => Object.fromEntries(transfer.items.map((i) => [i.lotId, ''])));
  const [error, setError] = useState<string | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function onScan(code: string) {
    try {
      const data = parseGs1(code);
      const match = transfer.items.find((i) => i.lot === data.lot && i.gtin && normalizeGtin(i.gtin) === normalizeGtin(data.gtin));
      if (!match) {
        setScanMsg(`Lote ${data.lot ?? '?'} não consta nesta transferência.`);
        return;
      }
      setCounts((c) => ({ ...c, [match.lotId]: String((Number(c[match.lotId]) || 0) + 1) }));
      setScanMsg(`+1 ${match.product} (lote ${match.lot})`);
    } catch (err) {
      setScanMsg(`Código não reconhecido: ${(err as Error).message}`);
    }
  }

  const divergent = transfer.items.some((i) => Number(counts[i.lotId] || 0) !== i.quantity);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="Conferência de recebimento"
      description={`${transfer.fromLocationName} → ${transfer.toLocationName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant={divergent ? 'danger' : 'primary'}
            loading={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await api.post(`/pharmacy/transfers/${transfer.id}/receive`, { items: transfer.items.map((i) => ({ lotId: i.lotId, receivedQuantity: Number(counts[i.lotId] || 0) })) });
                onDone(divergent);
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setPending(false);
              }
            }}
          >
            {divergent ? 'Registrar com divergência' : 'Confirmar recebimento'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ScanInput onScan={onScan} autoFocus placeholder="Bipe o Datamatrix de cada unidade recebida" />
        {scanMsg && <p className="text-sm text-slate-600">{scanMsg}</p>}
        <Table>
          <THead>
            <tr>
              <TH>Produto / lote</TH>
              <TH className="text-right">Expedido</TH>
              <TH className="text-right">Conferido</TH>
            </tr>
          </THead>
          <TBody>
            {transfer.items.map((i) => {
              const got = Number(counts[i.lotId] || 0);
              return (
                <TR key={i.lotId}>
                  <TD>
                    {i.product}
                    <span className="block font-mono text-xs text-slate-500">lote {i.lot}</span>
                  </TD>
                  <TD className="text-right tabular-nums">{i.quantity.toLocaleString('pt-BR')}</TD>
                  <TD className="text-right">
                    <Input
                      value={counts[i.lotId] ?? ''}
                      onChange={(e) => setCounts((c) => ({ ...c, [i.lotId]: e.target.value }))}
                      inputMode="decimal"
                      className={`ml-auto w-28 text-right ${got !== i.quantity ? 'border-amber-400' : 'border-emerald-400'}`}
                      aria-label={`Quantidade conferida de ${i.product}`}
                    />
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
        {divergent && <Alert tone="warn">Há diferença entre o expedido e o conferido. Só a quantidade conferida entra no estoque e a divergência fica registrada.</Alert>}
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Dialog>
  );
}
