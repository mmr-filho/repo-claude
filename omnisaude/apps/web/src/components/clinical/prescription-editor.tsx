'use client';

import { ALERT_SEVERITY_LABELS, ROUTES_OF_ADMINISTRATION } from '@omnisaude/shared';
import { AlertTriangle, Plus, ShieldAlert, Trash2, Volume2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, severityTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateTime } from '@/lib/format';
import { speak } from '@/lib/native';
import { useSession } from '@/lib/session';
import type { ClinicalAlert, EncounterDetail, ItemDraft, Prescription, PrescriptionAnalysis } from './types';

const ROUTE_LABEL: Record<string, string> = {
  ORAL: 'Oral',
  SUBLINGUAL: 'Sublingual',
  IV: 'Intravenosa',
  IM: 'Intramuscular',
  SC: 'Subcutânea',
  TOPICA: 'Tópica',
  INALATORIA: 'Inalatória',
  RETAL: 'Retal',
  OFTALMICA: 'Oftálmica',
  NASAL: 'Nasal',
};

let seq = 1;
export function emptyItem(partial: Partial<ItemDraft> = {}): ItemDraft {
  return { key: seq++, description: '', activeIngredient: '', dose: '', doseUnit: 'mg', route: 'ORAL', frequencyHours: '', durationDays: '', quantity: '', instructions: '', ...partial };
}

function toPayload(i: ItemDraft) {
  const n = (s: string) => (s.trim() ? Number(s.replace(',', '.')) : undefined);
  return {
    ...(i.productId ? { productId: i.productId } : {}),
    description: i.description.trim(),
    ...(i.activeIngredient.trim() ? { activeIngredient: i.activeIngredient.trim().toLowerCase() } : {}),
    ...(n(i.dose) ? { dose: n(i.dose), doseUnit: i.doseUnit || undefined } : {}),
    ...(i.route ? { route: i.route } : {}),
    ...(n(i.frequencyHours) ? { frequencyHours: Math.round(n(i.frequencyHours)!) } : {}),
    ...(n(i.durationDays) ? { durationDays: Math.round(n(i.durationDays)!) } : {}),
    ...(n(i.quantity) ? { quantity: n(i.quantity) } : {}),
    ...(i.instructions.trim() ? { instructions: i.instructions.trim() } : {}),
  };
}

/** Texto de orientação ao paciente (leitura em voz alta e tradução pelo VLibras). */
export function patientInstructions(items: { description: string; dose?: string | number | null; doseUnit?: string | null; route?: string | null; frequencyHours?: number | null; durationDays?: number | null; instructions?: string | null }[]) {
  return items
    .map((i) => {
      const parts = [`Tome ${i.description}`];
      if (i.dose) parts.push(`na dose de ${String(i.dose)} ${i.doseUnit ?? ''}`.trim());
      if (i.route) parts.push(`pela via ${(ROUTE_LABEL[i.route] ?? i.route).toLowerCase()}`);
      if (i.frequencyHours) parts.push(`de ${i.frequencyHours} em ${i.frequencyHours} horas`);
      if (i.durationDays) parts.push(`por ${i.durationDays} dias`);
      return `${parts.join(', ')}.${i.instructions ? ` ${i.instructions}` : ''}`;
    })
    .join(' ');
}

export function AlertList({ alerts }: { alerts: ClinicalAlert[] }) {
  if (alerts.length === 0) return <Alert tone="success">Sem alertas do copiloto para os itens informados.</Alert>;
  return (
    <ul className="flex flex-col gap-2">
      {alerts.map((a, idx) => (
        <li
          key={`${a.ruleId}-${idx}`}
          className={cn(
            'rounded-lg border px-3 py-2 text-sm',
            a.severity === 'GRAVE' ? 'border-red-300 bg-red-50' : a.severity === 'MODERADO' ? 'border-amber-300 bg-amber-50' : 'border-brand-200 bg-brand-50',
          )}
        >
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {a.severity === 'GRAVE' ? <ShieldAlert className="h-4 w-4 text-red-700" /> : <AlertTriangle className="h-4 w-4 text-amber-700" />}
            <Badge tone={severityTone[a.severity]}>{ALERT_SEVERITY_LABELS[a.severity]}</Badge>
            {a.title}
          </p>
          <p className="mt-1 text-slate-700">{a.detail}</p>
          <p className="mt-1 text-slate-600">
            <b>Conduta sugerida:</b> {a.recommendation}
          </p>
        </li>
      ))}
    </ul>
  );
}

interface Product {
  id: string;
  code: string;
  description: string;
  activeIngredient: string | null;
  unit: string;
}

/** Prescrição eletrônica com copiloto clínico em tempo real (alertas graduados; GRAVE exige justificativa). */
export function PrescriptionEditor({ encounter, items, setItems, onChanged }: { encounter: EncounterDetail; items: ItemDraft[]; setItems: (f: (s: ItemDraft[]) => ItemDraft[]) => void; onChanged: () => void }) {
  const session = useSession();
  const toast = useToast();
  const [analysis, setAnalysis] = useState<PrescriptionAnalysis | null>(null);
  const [checking, setChecking] = useState(false);
  const [justification, setJustification] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Prescription | null>(null);
  const [products, setProducts] = useState<Product[] | null>(null);
  const canProducts = session.can('estoque.ler', 'dispensacao.registrar', 'administracao.registrar');
  const kind = encounter.kind === 'INTERNACAO' ? 'HOSPITALAR' : 'AMBULATORIAL';
  const closed = encounter.status === 'ENCERRADO' || encounter.status === 'CANCELADO' || encounter.status === 'EVADIU';

  const valid = useMemo(() => items.filter((i) => i.description.trim().length >= 2), [items]);
  const payload = useMemo(() => valid.map(toPayload), [valid]);
  const payloadKey = JSON.stringify(payload);

  useEffect(() => {
    if (payload.length === 0) {
      setAnalysis(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setChecking(true);
      try {
        setAnalysis(await api.post<PrescriptionAnalysis>('/clinical/prescriptions/check', { patientId: encounter.patientId, items: payload }, { signal: ctrl.signal }));
      } catch (err) {
        if ((err as Error).name !== 'AbortError') toast.error(errorMessage(err));
      } finally {
        setChecking(false);
      }
    }, 500);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadKey, encounter.patientId]);

  async function searchProducts(q: string) {
    if (!canProducts || q.trim().length < 3) return setProducts(null);
    try {
      setProducts(await api.get<Product[]>(`/pharmacy/products?q=${encodeURIComponent(q)}`));
    } catch {
      setProducts(null);
    }
  }

  const update = (key: number, patch: Partial<ItemDraft>) => setItems((s) => s.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const grave = !!analysis?.requiresJustification;

  async function submit() {
    if (payload.length === 0) return;
    if (grave && !justification.trim()) {
      toast.error('Há alerta crítico: registre a justificativa clínica.');
      return;
    }
    setSaving(true);
    try {
      const r = await api.post<{ prescription: Prescription; alerts: ClinicalAlert[]; adherenceReminders: number }>(`/clinical/encounters/${encounter.id}/prescriptions`, {
        kind,
        items: payload,
        ...(justification.trim() ? { justification: justification.trim() } : {}),
      });
      setLastSaved(r.prescription);
      toast.success(`Prescrição emitida${r.adherenceReminders ? ` · ${r.adherenceReminders} lembrete(s) por WhatsApp agendado(s)` : ''}`);
      setItems(() => [emptyItem()]);
      setJustification('');
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'JUSTIFICATIVA_OBRIGATORIA') {
        const alerts = (err.details as { alerts?: ClinicalAlert[] })?.alerts ?? [];
        setAnalysis({ alerts, requiresJustification: true });
        toast.error(err.message);
      } else toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const readable = patientInstructions(valid.map((i) => ({ ...i, frequencyHours: Number(i.frequencyHours) || null, durationDays: Number(i.durationDays) || null })));
  const activeRx = encounter.prescriptions;

  return (
    <div className="flex flex-col gap-5">
      {!closed && session.can('prescricao.emitir') ? (
        <>
          <div className="flex flex-col gap-4">
            {items.map((i, idx) => (
              <fieldset key={i.key} className="relative grid gap-3 rounded-lg border border-slate-200 p-3 pt-4 sm:grid-cols-2 lg:grid-cols-6">
                <legend className="px-1 text-xs font-medium text-slate-500">Item {idx + 1}</legend>
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-2 top-1"
                  onClick={() => setItems((s) => (s.length > 1 ? s.filter((x) => x.key !== i.key) : [emptyItem()]))}
                  aria-label={`Remover item ${idx + 1}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                <Field label="Medicamento" htmlFor={`rx-desc-${i.key}`} className="sm:col-span-2 lg:col-span-3">
                  <Input
                    id={`rx-desc-${i.key}`}
                    value={i.description}
                    list={canProducts ? `rx-products-${i.key}` : undefined}
                    onChange={(e) => {
                      const v = e.target.value;
                      const p = products?.find((x) => x.description === v);
                      update(i.key, p ? { description: p.description, productId: p.id, activeIngredient: p.activeIngredient ?? i.activeIngredient } : { description: v, productId: undefined });
                      void searchProducts(v);
                    }}
                    placeholder="Ex.: Losartana potássica 50 mg"
                  />
                  {canProducts && (
                    <datalist id={`rx-products-${i.key}`}>
                      {products?.map((p) => (
                        <option key={p.id} value={p.description} />
                      ))}
                    </datalist>
                  )}
                </Field>
                <Field label="Princípio ativo" htmlFor={`rx-ai-${i.key}`} className="lg:col-span-3">
                  <Input id={`rx-ai-${i.key}`} value={i.activeIngredient} onChange={(e) => update(i.key, { activeIngredient: e.target.value })} placeholder="Ex.: losartana" />
                </Field>
                <Field label="Dose" htmlFor={`rx-dose-${i.key}`} className="lg:col-span-2">
                  <div className="flex gap-1">
                    <Input id={`rx-dose-${i.key}`} inputMode="decimal" value={i.dose} onChange={(e) => update(i.key, { dose: e.target.value })} />
                    <Select value={i.doseUnit} onChange={(e) => update(i.key, { doseUnit: e.target.value })} className="w-24" aria-label="Unidade da dose">
                      {['mg', 'g', 'mcg', 'mL', 'UI', 'gotas', 'comprimido', 'cápsula'].map((u) => (
                        <option key={u}>{u}</option>
                      ))}
                    </Select>
                  </div>
                </Field>
                <Field label="Via" htmlFor={`rx-route-${i.key}`}>
                  <Select id={`rx-route-${i.key}`} value={i.route} onChange={(e) => update(i.key, { route: e.target.value })}>
                    {ROUTES_OF_ADMINISTRATION.map((r) => (
                      <option key={r} value={r}>
                        {ROUTE_LABEL[r] ?? r}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="A cada (horas)" htmlFor={`rx-freq-${i.key}`}>
                  <Input id={`rx-freq-${i.key}`} inputMode="numeric" value={i.frequencyHours} onChange={(e) => update(i.key, { frequencyHours: e.target.value })} placeholder="8" />
                </Field>
                <Field label="Por (dias)" htmlFor={`rx-days-${i.key}`}>
                  <Input id={`rx-days-${i.key}`} inputMode="numeric" value={i.durationDays} onChange={(e) => update(i.key, { durationDays: e.target.value })} placeholder="7" />
                </Field>
                <Field label="Quantidade" htmlFor={`rx-qty-${i.key}`}>
                  <Input id={`rx-qty-${i.key}`} inputMode="decimal" value={i.quantity} onChange={(e) => update(i.key, { quantity: e.target.value })} />
                </Field>
                <Field label="Orientações" htmlFor={`rx-instr-${i.key}`} className="sm:col-span-2 lg:col-span-6">
                  <Input id={`rx-instr-${i.key}`} value={i.instructions} onChange={(e) => update(i.key, { instructions: e.target.value })} placeholder="Ex.: tomar após o café da manhã" />
                </Field>
              </fieldset>
            ))}
            <Button variant="secondary" onClick={() => setItems((s) => [...s, emptyItem()])} className="self-start">
              <Plus className="h-4 w-4" /> Adicionar item
            </Button>
          </div>

          <section className="flex flex-col gap-3" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-700">Copiloto clínico</h3>
              {checking && <span className="text-xs text-slate-500">verificando…</span>}
              {analysis?.egfr && (
                <Badge tone={analysis.egfr.value < 30 ? 'red' : analysis.egfr.value < 60 ? 'amber' : 'green'}>
                  TFG {analysis.egfr.value.toFixed(0)} mL/min/1,73m² ({analysis.egfr.source})
                </Badge>
              )}
              {analysis?.potassium !== undefined && <Badge tone="slate">K⁺ {analysis.potassium}</Badge>}
            </div>
            {analysis ? <AlertList alerts={analysis.alerts} /> : <p className="text-sm text-slate-500">Os alertas aparecem enquanto você prescreve: interações, alergias, função renal, gestação e duplicidades.</p>}
            {grave && (
              <Field label="Justificativa clínica (obrigatória para alerta crítico)" htmlFor="rx-just">
                <Textarea id="rx-just" value={justification} onChange={(e) => setJustification(e.target.value)} rows={3} />
              </Field>
            )}
          </section>

          {readable && (
            <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-700">Orientações ao paciente</h3>
                <Button size="sm" variant="ghost" onClick={() => void speak(readable, 0.9)}>
                  <Volume2 className="h-4 w-4" /> Ler em voz alta
                </Button>
              </div>
              <p className="text-base leading-relaxed" lang="pt-BR">
                {readable}
              </p>
              <p className="mt-1 text-xs text-slate-500">Com o VLibras ativado (ícone de mão no topo), selecione este texto para traduzir em Libras.</p>
            </section>
          )}

          <div className="flex justify-end">
            <Button size="lg" onClick={submit} loading={saving} disabled={payload.length === 0 || (grave && !justification.trim())}>
              Emitir prescrição {kind === 'HOSPITALAR' ? 'hospitalar' : 'ambulatorial'}
            </Button>
          </div>
          {lastSaved && <Alert tone="success">Prescrição registrada · hash {lastSaved.auditHash?.slice(0, 16)}…</Alert>}
        </>
      ) : (
        <Alert tone="info">{closed ? 'Atendimento encerrado.' : 'Seu papel não emite prescrição.'}</Alert>
      )}

      {activeRx.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-slate-700">Prescrições deste atendimento</h3>
          {activeRx.map((p) => (
            <article key={p.id} className="rounded-lg border border-slate-200 p-3 text-sm">
              <p className="text-xs text-slate-500">
                {fmtDateTime(p.signedAt)} · {p.kind === 'HOSPITALAR' ? 'hospitalar' : 'ambulatorial'} · {p.status.toLowerCase()}
                {p.alerts.length > 0 ? ` · ${p.alerts.length} alerta(s)` : ''}
              </p>
              <ul className="mt-1 list-inside list-disc">
                {p.items.map((i) => (
                  <li key={i.id} className={i.suspendedAt ? 'line-through opacity-60' : undefined}>
                    {i.description} {i.dose ? `${String(i.dose)} ${i.doseUnit ?? ''}` : ''} {i.route ? `(${ROUTE_LABEL[i.route] ?? i.route})` : ''} {i.frequencyHours ? `a cada ${i.frequencyHours}h` : ''} {i.durationDays ? `por ${i.durationDays} dias` : ''}
                  </li>
                ))}
              </ul>
              {p.justification && <p className="mt-1 text-xs text-slate-600">Justificativa: {p.justification}</p>}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
