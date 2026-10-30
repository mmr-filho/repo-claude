'use client';

import { CheckCircle2, Clock, PackageX, RotateCcw, ShieldAlert, Syringe, UserRound, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { administer } from '@/components/bedside/administer';
import { CHECK_LABELS, type AdministrationResult, type Schedule, type ScheduleItem } from '@/components/bedside/types';
import { PopExecutionDialog } from '@/components/pops/pop-execution-dialog';
import { TRIGGER_LABELS } from '@/components/pops/types';
import { ScanInput, type ScanInputHandle } from '@/components/scan/scan-input';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDate, fmtDateTime, fmtTime, formatCns } from '@/lib/format';
import { beep, speak } from '@/lib/native';

interface PatientInfo {
  id: string;
  name: string;
  birthDate: string;
  age: number;
  cns: string | null;
  allergies: { substance: string }[];
}

interface HistoryRow {
  id: string;
  prescriptionItemId: string;
  status: 'ADMINISTRADO' | 'BLOQUEADO' | 'RECUSADO_PACIENTE';
  at: string;
  scheduledFor: string | null;
}

/**
 * Administração beira-leito (celular): pulseira → item aprazado → Datamatrix da dose → 5 certos.
 * A baixa definitiva do estoque do posto acontece só aqui, no ato da administração.
 */
export default function BedsidePage() {
  const toast = useToast();
  const [patientCode, setPatientCode] = useState<string | null>(null);
  const [patient, setPatient] = useState<PatientInfo | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [item, setItem] = useState<ScheduleItem | null>(null);
  const [doseCode, setDoseCode] = useState<string | null>(null);
  const [pops, setPops] = useState<Record<string, string>>({});
  const [popTrigger, setPopTrigger] = useState<string | null>(null);
  const [result, setResult] = useState<AdministrationResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [returning, setReturning] = useState(false);
  const doseScan = useRef<ScanInputHandle>(null);

  async function loadPatient(code: string) {
    const id = /^PAC:([0-9a-f-]{36})$/i.exec(code.trim())?.[1];
    if (!id) {
      beep('BLOQUEIO');
      setLoadError('Pulseira não reconhecida. Leia o código da pulseira do paciente (PAC:…).');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [p, s, h] = await Promise.all([
        api.get<PatientInfo>(`/patients/${id}`),
        api.get<Schedule>(`/pharmacy/administrations/schedule?patientId=${id}`),
        api.get<HistoryRow[]>(`/pharmacy/administrations?patientId=${id}`),
      ]);
      setPatientCode(code.trim());
      setPatient(p);
      setSchedule(s);
      setHistory(h);
      setPops({});
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    if (!patient) return;
    try {
      const [s, h] = await Promise.all([
        api.get<Schedule>(`/pharmacy/administrations/schedule?patientId=${patient.id}`),
        api.get<HistoryRow[]>(`/pharmacy/administrations?patientId=${patient.id}`),
      ]);
      setSchedule(s);
      setHistory(h);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function reset() {
    setPatientCode(null);
    setPatient(null);
    setSchedule(null);
    setHistory([]);
    setItem(null);
    setDoseCode(null);
    setResult(null);
    setPops({});
  }

  const missingPop = item?.requiredPops.find((t) => !pops[t]) ?? null;

  async function submit(code: string) {
    if (!item || !patientCode) return;
    setDoseCode(code);
    if (!item.route) {
      toast.error('Item sem via prescrita: solicite correção da prescrição.');
      return;
    }
    if (missingPop) {
      setPopTrigger(missingPop);
      return;
    }
    setSubmitting(true);
    try {
      const res = await administer({
        patientCode,
        doseCode: code,
        prescriptionItemId: item.prescriptionItemId,
        route: item.route,
        popExecutionIds: item.requiredPops.map((t) => pops[t]!).filter(Boolean),
      });
      setResult(res);
      beep(res.sound);
      const failed = res.checks.filter((c) => !c.ok).map((c) => CHECK_LABELS[c.check]);
      void speak(res.status === 'ADMINISTRADO' ? 'Administração aprovada.' : `Bloqueado. ${failed.join(', ')}.`);
      if (res.status === 'ADMINISTRADO') setPops({});
      void refresh();
    } catch (err) {
      beep('BLOQUEIO');
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Depois de concluir o POP, segue para o envio com o código já lido.
  useEffect(() => {
    if (!popTrigger && doseCode && item && !missingPop && !result && !submitting) void submit(doseCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popTrigger, pops]);

  const itemName = (id: string) => schedule?.items.find((i) => i.prescriptionItemId === id)?.description ?? 'Item';

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Administração beira-leito" description="Leia a pulseira, escolha o item aprazado e leia o Datamatrix da dose. O sistema confere os 5 certos." />

      {!patient ? (
        <Card>
          <CardBody className="space-y-4">
            <div className="flex items-center gap-3">
              <UserRound className="h-6 w-6 text-brand-600" />
              <p className="font-medium">1. Leia a pulseira do paciente</p>
            </div>
            <ScanInput large autoFocus onScan={loadPatient} placeholder="Código da pulseira (PAC:…)" label="Código da pulseira" />
            {loading && <Spinner label="Carregando aprazamento…" />}
            {loadError && <Alert tone="error">{loadError}</Alert>}
          </CardBody>
        </Card>
      ) : (
        <>
          <Card className="mb-4">
            <CardBody className="flex items-start justify-between gap-3">
              <div>
                <p className="text-lg font-semibold">{patient.name}</p>
                <p className="text-sm text-slate-600">
                  Nasc. {fmtDate(patient.birthDate)} · {patient.age} anos {patient.cns ? `· CNS ${formatCns(patient.cns)}` : ''}
                </p>
                {patient.allergies.length > 0 && (
                  <p className="mt-1 text-sm font-semibold text-red-700">Alergias: {patient.allergies.map((a) => a.substance).join(', ')}</p>
                )}
              </div>
              <Button variant="secondary" onClick={reset} className="h-11">
                Trocar paciente
              </Button>
            </CardBody>
          </Card>

          {result ? (
            <ResultPanel
              result={result}
              onNext={() => {
                setResult(null);
                setItem(null);
                setDoseCode(null);
              }}
            />
          ) : item ? (
            <Card className="mb-4">
              <CardHeader title={`2. Leia a dose de ${item.description}`} description={`Via ${item.route ?? 'não informada'}${item.dueAt ? ` · aprazado ${fmtTime(item.dueAt)}` : ''}`} />
              <CardBody className="space-y-4">
                {item.requiredPops.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {item.requiredPops.map((t) => (
                      <Badge key={t} tone={pops[t] ? 'green' : 'red'}>
                        {pops[t] ? <CheckCircle2 className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />} {TRIGGER_LABELS[t] ?? t}: {pops[t] ? 'POP concluído' : 'POP obrigatório'}
                      </Badge>
                    ))}
                  </div>
                )}
                <ScanInput ref={doseScan} large autoFocus onScan={submit} placeholder="Datamatrix da dose unitária" label="Código da dose" disabled={submitting} />
                {submitting && <Spinner label="Conferindo os 5 certos…" />}
                <Button variant="ghost" className="h-11" onClick={() => setItem(null)}>
                  Voltar aos itens
                </Button>
              </CardBody>
            </Card>
          ) : (
            <Card className="mb-4">
              <CardHeader title="Itens aprazados" description={schedule ? `Tolerância de ±${schedule.toleranceMinutes} min no horário` : undefined} />
              {!schedule || schedule.items.length === 0 ? (
                <EmptyState title="Sem prescrição hospitalar ativa" description="Confira se o paciente está internado e com prescrição vigente." />
              ) : (
                <ul className="divide-y divide-slate-100">
                  {schedule.items.map((i) => (
                    <li key={i.prescriptionItemId} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
                      <div className="flex-1">
                        <p className="font-medium">{i.description}</p>
                        <p className="text-sm text-slate-600">
                          {i.dose !== null ? `${i.dose} ${i.doseUnit ?? ''} · ` : ''}via {i.route ?? '—'}
                          {i.frequencyHours ? ` · de ${i.frequencyHours} em ${i.frequencyHours} h` : ''}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {i.dueNow ? (
                            <Badge tone="green">
                              <Clock className="h-3 w-3" /> Agora ({fmtTime(i.dueAt)})
                            </Badge>
                          ) : (
                            <Badge>Próximo: {i.nextTimes[0] ? fmtTime(i.nextTimes[0]) : '—'}</Badge>
                          )}
                          {i.requiredPops.map((t) => (
                            <Badge key={t} tone="red">
                              <ShieldAlert className="h-3 w-3" /> {TRIGGER_LABELS[t] ?? t}
                            </Badge>
                          ))}
                          <Badge tone={i.availableUnitDoses > 0 ? 'blue' : 'amber'}>{i.availableUnitDoses} dose(s) no posto</Badge>
                        </div>
                      </div>
                      <Button className="h-12 sm:w-40" variant={i.dueNow ? 'primary' : 'secondary'} onClick={() => setItem(i)}>
                        <Syringe className="h-4 w-4" /> Administrar
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          <Card>
            <CardHeader
              title="Registros recentes"
              actions={
                <Button variant="secondary" size="sm" className="h-10" onClick={() => setReturning(true)}>
                  <RotateCcw className="h-4 w-4" /> Devolver dose
                </Button>
              }
            />
            {history.length === 0 ? (
              <EmptyState title="Nenhum registro" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {history.slice(0, 15).map((h) => (
                  <li key={h.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    {h.status === 'ADMINISTRADO' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-red-600" />}
                    <span className="flex-1">{itemName(h.prescriptionItemId)}</span>
                    <span className="text-xs text-slate-500">{fmtDateTime(h.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <PopExecutionDialog
        open={!!popTrigger}
        onOpenChange={(o) => !o && setPopTrigger(null)}
        trigger={popTrigger ?? undefined}
        patientId={patient?.id}
        onDone={(execution) => {
          if (popTrigger) setPops((p) => ({ ...p, [popTrigger]: execution.id }));
          toast.success('POP registrado.');
        }}
      />
      {returning && <ReturnDialog onClose={() => setReturning(false)} onDone={() => { setReturning(false); void refresh(); }} />}
    </div>
  );
}

function ResultPanel({ result, onNext }: { result: AdministrationResult; onNext: () => void }) {
  const ok = result.status === 'ADMINISTRADO';
  return (
    <Card className={cn('mb-4 border-2', ok ? 'border-emerald-500' : 'border-red-500')}>
      <div className={cn('flex items-center gap-3 rounded-t-xl px-5 py-6 text-white', ok ? 'bg-emerald-600' : 'bg-red-600')} role="status" aria-live="assertive">
        {ok ? <CheckCircle2 className="h-10 w-10" /> : <XCircle className="h-10 w-10" />}
        <div>
          <p className="text-2xl font-bold">{ok ? 'APROVADO' : 'BLOQUEADO'}</p>
          <p className="text-sm opacity-90">{ok ? 'Administração registrada e dose baixada do estoque do posto.' : 'Não administre. Corrija o item em vermelho.'}</p>
        </div>
      </div>
      <ul className="divide-y divide-slate-100">
        {result.checks.map((c) => (
          <li key={c.check} className="flex items-start gap-3 px-5 py-3">
            {c.ok ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />}
            <div>
              <p className="font-medium">{CHECK_LABELS[c.check]}</p>
              <p className="text-sm text-slate-600">{c.detail}</p>
            </div>
          </li>
        ))}
      </ul>
      <CardBody>
        <Button size="lg" className="w-full" onClick={onNext}>
          Continuar
        </Button>
      </CardBody>
    </Card>
  );
}

/** Logística reversa: dose não administrada (suspensão, alta) volta para a farmácia. */
function ReturnDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [dose, setDose] = useState<{ id: string; serial: string; product: string } | null>(null);
  const [reason, setReason] = useState('Medicação suspensa');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Devolver dose à farmácia"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!dose || reason.trim().length < 3}
            loading={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await api.post('/pharmacy/returns', { unitDoseId: dose!.id, reason });
                toast.success(`Dose ${dose!.serial} devolvida ao estoque.`);
                onDone();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setPending(false);
              }
            }}
          >
            <PackageX className="h-4 w-4" /> Devolver
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ScanInput
          large
          autoFocus
          placeholder="Datamatrix da dose"
          onScan={async (code) => {
            setError(null);
            try {
              const r = await api.get<{ product: { description: string }; unitDose: { id: string; serial: string; status: string } | null }>(`/pharmacy/lookup?code=${encodeURIComponent(code)}`);
              if (!r.unitDose) throw new Error('Etiqueta sem número de série de dose unitária');
              if (r.unitDose.status !== 'DISPONIVEL') throw new Error(`Dose ${r.unitDose.status.toLowerCase()}: não pode ser devolvida`);
              setDose({ id: r.unitDose.id, serial: r.unitDose.serial, product: r.product.description });
            } catch (err) {
              setDose(null);
              setError(errorMessage(err));
            }
          }}
        />
        {dose && (
          <Alert tone="info">
            {dose.product} · série {dose.serial}
          </Alert>
        )}
        <Field label="Motivo">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Dialog>
  );
}
