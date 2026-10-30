'use client';

import { Pill, Plus, Trash2, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { PatientSearch } from '@/components/patients/patient-search';
import { api, ApiError, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime, formatCns } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { PatientSummary } from '@/lib/types';
import type { Product } from './types';

interface Prescription {
  id: string;
  signedAt: string;
  kind: string;
  status: string;
  items: { id: string; productId: string | null; description: string; quantity: string | number | null; durationDays: number | null; frequencyHours: number | null }[];
}

interface Line {
  productId: string;
  description: string;
  controlledList: string | null;
  quantity: string;
}

interface DispenseResult {
  id: string;
  controlled: boolean;
  items: { product: string; lot: string; expiry: string; quantity: number }[];
}

interface DispensationRow {
  id: string;
  dispensedAt: string;
  controlled: boolean;
  patient: { id: string; name: string; cns: string | null };
  items: { id: string; product?: string; quantity: number }[];
}

/** Dispensação ambulatorial (Farmácia Básica): baixa por lote (FEFO), vinculada ao paciente e à receita. */
export function DispenseTab() {
  const session = useSession();
  const toast = useToast();
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [prescriptionId, setPrescriptionId] = useState('');
  const [external, setExternal] = useState({ number: '', prescriberName: '', prescriberCouncil: '', date: '' });
  const [useExternal, setUseExternal] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [q, setQ] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [result, setResult] = useState<DispenseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const canReadRx = session.can('prontuario.ler');
  const prescriptions = useApi<Prescription[]>(patient && canReadRx ? `/clinical/patients/${patient.id}/prescriptions?active=true` : null, [patient?.id]);
  const recent = useApi<DispensationRow[]>(`/pharmacy/dispensations${patient ? `?patientId=${patient.id}` : ''}`, [patient?.id]);

  useEffect(() => {
    if (!q.trim() || q.trim().length < 3) {
      setProducts([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setProducts(await api.get<Product[]>(`/pharmacy/products?q=${encodeURIComponent(q)}`));
      } catch {
        // busca incremental
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  function addProduct(p: Product, qty = '') {
    setLines((s) => (s.some((l) => l.productId === p.id) ? s : [...s, { productId: p.id, description: p.description, controlledList: p.controlledList, quantity: qty }]));
    setQ('');
    setProducts([]);
  }

  async function fromPrescription(rx: Prescription) {
    setPrescriptionId(rx.id);
    setUseExternal(false);
    let catalog: Product[] = [];
    try {
      catalog = await api.get<Product[]>('/pharmacy/products');
    } catch (err) {
      setError(errorMessage(err));
    }
    const next: Line[] = [];
    rx.items.forEach((i) => {
      const p = catalog.find((x) => x.id === i.productId);
      const days = i.durationDays ?? 30;
      const perDay = i.frequencyHours ? Math.ceil(24 / i.frequencyHours) : 1;
      if (p) next.push({ productId: p.id, description: p.description, controlledList: p.controlledList, quantity: String(i.quantity ? Number(i.quantity) : days * perDay) });
    });
    setLines(next);
  }

  const controlled = lines.some((l) => l.controlledList);

  async function dispense() {
    if (!patient) return;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post<DispenseResult>('/pharmacy/dispensations', {
        patientId: patient.id,
        ...(prescriptionId && !useExternal ? { prescriptionId } : {}),
        ...(useExternal ? { externalPrescription: external } : {}),
        items: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity.replace(',', '.')) })),
      });
      setResult(res);
      setLines([]);
      toast.success('Dispensação registrada.');
      void recent.reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONTROLADO_SEM_RECEITA') setUseExternal(true);
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <Card>
        <CardHeader title="Dispensação ao cidadão" description="Os lotes são escolhidos pelo vencimento mais próximo (FEFO). A dispensação é enviada à RNDS." />
        <CardBody className="space-y-4">
          {patient ? (
            <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 p-3">
              <div className="flex gap-3">
                <UserRound className="mt-0.5 h-5 w-5 text-brand-600" />
                <div>
                  <p className="font-medium">{patient.name}</p>
                  <p className="text-xs text-slate-500">
                    {patient.age} anos {patient.cns ? `· CNS ${formatCns(patient.cns)}` : ''}
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => { setPatient(null); setLines([]); setPrescriptionId(''); setResult(null); }}>
                Trocar
              </Button>
            </div>
          ) : (
            <Field label="Paciente">
              <PatientSearch onSelect={setPatient} autoFocus />
            </Field>
          )}

          {patient && canReadRx && (
            <div>
              <p className="mb-2 text-sm font-medium">Prescrições ativas na rede</p>
              {prescriptions.loading ? (
                <Spinner />
              ) : (prescriptions.data ?? []).length === 0 ? (
                <p className="text-sm text-slate-500">Nenhuma prescrição ativa. Use a receita externa, se houver.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(prescriptions.data ?? []).map((rx) => (
                    <button
                      key={rx.id}
                      onClick={() => fromPrescription(rx)}
                      className={`rounded-lg border px-3 py-2 text-left text-sm hover:bg-slate-50 ${prescriptionId === rx.id && !useExternal ? 'border-brand-500 bg-brand-50' : 'border-slate-200'}`}
                    >
                      <span className="block font-medium">{fmtDate(rx.signedAt)} · {rx.kind.toLowerCase()}</span>
                      <span className="text-xs text-slate-500">{rx.items.map((i) => i.description).join(', ')}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {patient && (
            <>
              <div className="relative">
                <Field label="Adicionar medicamento">
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, princípio ativo ou código" />
                </Field>
                {products.length > 0 && (
                  <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                    {products.map((p) => (
                      <li key={p.id}>
                        <button className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => addProduct(p)}>
                          <span>{p.description}</span>
                          {p.controlledList && <Badge tone="amber">Lista {p.controlledList}</Badge>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {lines.length > 0 && (
                <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {lines.map((l, idx) => (
                    <li key={l.productId} className="flex items-center gap-2 p-2">
                      <Pill className="h-4 w-4 text-slate-400" />
                      <span className="flex-1 text-sm">
                        {l.description}
                        {l.controlledList && (
                          <Badge tone="amber" className="ml-2">
                            Controlado {l.controlledList}
                          </Badge>
                        )}
                      </span>
                      <Input
                        value={l.quantity}
                        onChange={(e) => setLines((s) => s.map((x, i) => (i === idx ? { ...x, quantity: e.target.value } : x)))}
                        inputMode="decimal"
                        className="w-24 text-right"
                        aria-label={`Quantidade de ${l.description}`}
                        placeholder="Qtd."
                      />
                      <Button variant="ghost" size="icon" onClick={() => setLines((s) => s.filter((_, i) => i !== idx))} aria-label="Remover">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={useExternal} onChange={(e) => setUseExternal(e.target.checked)} />
                Receita externa (papel) — obrigatória para controlados sem prescrição na rede
              </label>
              {(useExternal || (controlled && !prescriptionId)) && (
                <div className="grid gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 sm:grid-cols-2">
                  <Field label="Número da receita/notificação">
                    <Input value={external.number} onChange={(e) => setExternal({ ...external, number: e.target.value })} />
                  </Field>
                  <Field label="Data da receita">
                    <Input type="date" value={external.date} onChange={(e) => setExternal({ ...external, date: e.target.value })} />
                  </Field>
                  <Field label="Prescritor">
                    <Input value={external.prescriberName} onChange={(e) => setExternal({ ...external, prescriberName: e.target.value })} />
                  </Field>
                  <Field label="Conselho (ex.: CRM-SP 12345)">
                    <Input value={external.prescriberCouncil} onChange={(e) => setExternal({ ...external, prescriberCouncil: e.target.value })} />
                  </Field>
                </div>
              )}
              {error && <Alert tone="error">{error}</Alert>}
              {result && (
                <Alert tone="success" title="Dispensado">
                  <ul className="list-disc pl-5">
                    {result.items.map((i, k) => (
                      <li key={k}>
                        {i.product}: {i.quantity.toLocaleString('pt-BR')} (lote {i.lot}, val. {fmtDate(i.expiry)})
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs">Registro de dispensação enfileirado para a RNDS.</p>
                </Alert>
              )}
              <Button size="lg" onClick={dispense} loading={pending} disabled={lines.length === 0 || lines.some((l) => !(Number(l.quantity.replace(',', '.')) > 0))}>
                Registrar dispensação
              </Button>
            </>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={patient ? 'Dispensações do paciente' : 'Dispensações recentes'} />
        {recent.loading ? (
          <Spinner />
        ) : (recent.data ?? []).length === 0 ? (
          <EmptyState title="Nenhuma dispensação" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Quando</TH>
                <TH>Itens</TH>
              </tr>
            </THead>
            <TBody>
              {(recent.data ?? []).slice(0, 30).map((d) => (
                <TR key={d.id}>
                  <TD className="whitespace-nowrap text-xs">
                    {fmtDateTime(d.dispensedAt)}
                    {!patient && <span className="block font-medium text-slate-700">{d.patient.name}</span>}
                    {d.controlled && <Badge tone="amber">Controlado</Badge>}
                  </TD>
                  <TD className="text-xs">{d.items.map((i) => `${i.product ?? '—'} (${i.quantity})`).join('; ')}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
