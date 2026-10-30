'use client';

import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { TRIGGER_LABELS, type Pop, type PopExecution, type PopSummary } from './types';

/**
 * Hard gate: checklist obrigatório do POP (e dupla checagem, quando exigida) antes de um ato de alto risco.
 * Informe o gatilho (ex.: "administracao.alta_vigilancia") ou o id do POP.
 */
export function PopExecutionDialog({
  open,
  onOpenChange,
  trigger,
  popId,
  patientId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: string;
  popId?: string;
  patientId?: string;
  onDone: (execution: PopExecution) => void;
}) {
  const [pop, setPop] = useState<Pop | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [cpf, setCpf] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPop(null);
    setLoadError(null);
    setAnswers({});
    setCpf('');
    setPassword('');
    setError(null);
    (async () => {
      try {
        let id = popId;
        if (!id && trigger) {
          const list = await api.get<PopSummary[]>(`/pops?kind=HARD&trigger=${encodeURIComponent(trigger)}`);
          id = list[0]?.id;
          if (!id) throw new Error(`Nenhum POP cadastrado para ${TRIGGER_LABELS[trigger] ?? trigger}`);
        }
        if (!id) throw new Error('POP não informado');
        setPop(await api.get<Pop>(`/pops/${id}`));
      } catch (err) {
        setLoadError(errorMessage(err));
      }
    })();
  }, [open, trigger, popId]);

  const missing = pop ? pop.checklist.filter((c) => c.required && !answers[c.id]) : [];
  const needsColleague = !!pop?.requiresDoubleCheck;

  async function submit() {
    if (!pop) return;
    setError(null);
    setPending(true);
    try {
      const execution = await api.post<PopExecution>(`/pops/${pop.id}/executions`, {
        answers,
        ...(patientId ? { patientId } : {}),
        ...(needsColleague ? { doubleCheck: { cpf, password } } : {}),
      });
      onDone(execution);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={pop ? `${pop.code} · ${pop.title}` : 'Procedimento obrigatório'}
      description="Confirme cada item antes de prosseguir. A execução fica registrada na trilha de auditoria."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={pending} disabled={!pop || missing.length > 0 || (needsColleague && (!cpf || !password))}>
            <ShieldCheck className="h-4 w-4" /> Registrar checagem
          </Button>
        </>
      }
    >
      {loadError ? (
        <Alert tone="error">{loadError}</Alert>
      ) : !pop ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-700">{pop.content}</p>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-semibold">Checklist</legend>
            {pop.checklist.map((c) => (
              <label key={c.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50">
                <input
                  type="checkbox"
                  className="mt-0.5 h-5 w-5 accent-brand-600"
                  checked={!!answers[c.id]}
                  onChange={(e) => setAnswers((a) => ({ ...a, [c.id]: e.target.checked }))}
                />
                <span className="text-sm">
                  {c.text}
                  {c.required && <span className="ml-1 text-xs font-medium text-red-700">obrigatório</span>}
                </span>
              </label>
            ))}
          </fieldset>
          {needsColleague && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="mb-3 text-sm font-medium text-amber-900">Dupla checagem: um segundo profissional confere e se identifica.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="CPF do segundo profissional" htmlFor="pop-cpf">
                  <Input id="pop-cpf" value={cpf} onChange={(e) => setCpf(e.target.value)} inputMode="numeric" autoComplete="off" />
                </Field>
                <Field label="Senha" htmlFor="pop-pwd">
                  <Input id="pop-pwd" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
                </Field>
              </div>
            </div>
          )}
          {error && <Alert tone="error">{error}</Alert>}
        </div>
      )}
    </Dialog>
  );
}
