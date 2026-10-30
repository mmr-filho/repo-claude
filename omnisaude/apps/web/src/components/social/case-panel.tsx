'use client';

import { Phone, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime, formatCns } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { ACTIONS, CASE_STATUS, CHANNELS, LINE_LABELS, VULNERABILITIES, type CaseDetail } from './types';

function MultiCheck<T extends string>({ options, value, onChange, legend }: { options: Record<T, string>; value: T[]; onChange: (v: T[]) => void; legend: string }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-slate-700">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(options) as T[]).map((k) => {
          const on = value.includes(k);
          return (
            <label key={k} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${on ? 'border-brand-500 bg-brand-50' : 'border-slate-200'}`}>
              <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={on} onChange={() => onChange(on ? value.filter((x) => x !== k) : [...value, k])} />
              {options[k]}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Caso de busca ativa: histórico de contatos e registro humanizado (motivos de vulnerabilidade e ações). */
export function CasePanel({ caseId, onClose, onChanged }: { caseId: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const detail = useApi<CaseDetail>(`/social/cases/${caseId}`, [caseId]);
  const [channel, setChannel] = useState<keyof typeof CHANNELS>('TELEFONE');
  const [outcome, setOutcome] = useState('');
  const [vulnerabilities, setVulnerabilities] = useState<(keyof typeof VULNERABILITIES)[]>([]);
  const [actions, setActions] = useState<(keyof typeof ACTIONS)[]>([]);
  const [notes, setNotes] = useState('');
  const [closeReason, setCloseReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const c = detail.data;
  const closed = c?.status === 'ENCERRADO';

  async function save() {
    setPending(true);
    setError(null);
    try {
      await api.post(`/social/cases/${caseId}/contacts`, { channel, outcome, vulnerabilities, actions, notes: notes || undefined });
      toast.success('Contato registrado.');
      setOutcome('');
      setNotes('');
      setVulnerabilities([]);
      setActions([]);
      void detail.reload();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={c ? c.patient.name : 'Caso'}
        description={c ? `${LINE_LABELS[c.lineOfCare]} · aberto em ${fmtDate(c.openedAt)}${c.assignedToName ? ` · ${c.assignedToName}` : ''}` : undefined}
        actions={
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Fechar caso">
            <X className="h-5 w-5" />
          </Button>
        }
      />
      {detail.loading ? (
        <Spinner />
      ) : detail.error || !c ? (
        <CardBody>
          <Alert tone="error">{detail.error ?? 'Caso não encontrado'}</Alert>
        </CardBody>
      ) : (
        <CardBody className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={CASE_STATUS[c.status]?.tone ?? 'slate'}>{CASE_STATUS[c.status]?.label ?? c.status}</Badge>
            <span>{c.patient.age} anos</span>
            {c.patient.cns && <span className="font-mono text-xs">CNS {formatCns(c.patient.cns)}</span>}
            {c.patient.district && <span>· {c.patient.district}</span>}
            {c.patient.phone && (
              <a href={`tel:${c.patient.phone}`} className="flex items-center gap-1 text-brand-700 underline">
                <Phone className="h-3.5 w-3.5" /> {c.patient.phone}
              </a>
            )}
            {c.patient.whatsappOptIn && <Badge tone="green">Aceita WhatsApp</Badge>}
            <span className="text-slate-500">· última consulta {c.lastVisitAt ? fmtDate(c.lastVisitAt) : 'sem registro'}</span>
          </div>

          <section>
            <h3 className="mb-2 text-sm font-semibold">Contatos</h3>
            {c.contacts.length === 0 ? (
              <p className="text-sm text-slate-500">Nenhum contato registrado.</p>
            ) : (
              <ol className="space-y-3 border-l-2 border-slate-200 pl-4">
                {c.contacts.map((k) => (
                  <li key={k.id} className="text-sm">
                    <p className="font-medium">
                      {CHANNELS[k.channel] ?? k.channel} · {k.outcome}
                    </p>
                    <p className="text-xs text-slate-500">
                      {fmtDateTime(k.at)}
                      {k.userName ? ` · ${k.userName}` : ''}
                    </p>
                    {(k.vulnerabilities.length > 0 || k.actions.length > 0) && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {k.vulnerabilities.map((v) => (
                          <Badge key={v} tone="amber">
                            {VULNERABILITIES[v] ?? v}
                          </Badge>
                        ))}
                        {k.actions.map((a) => (
                          <Badge key={a} tone="green">
                            {ACTIONS[a] ?? a}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {k.notes && <p className="mt-1 text-slate-700">{k.notes}</p>}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {closed ? (
            <Alert tone="info">Caso encerrado em {fmtDate(c.closedAt)}: {c.closeReason}</Alert>
          ) : (
            <>
              <section className="space-y-3 rounded-lg border border-slate-200 p-4">
                <h3 className="text-sm font-semibold">Registrar contato</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Canal">
                    <Select value={channel} onChange={(e) => setChannel(e.target.value as keyof typeof CHANNELS)}>
                      {Object.entries(CHANNELS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Resultado do contato">
                    <Input value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Ex.: contato realizado, sem resposta…" />
                  </Field>
                </div>
                <MultiCheck legend="Motivos de vulnerabilidade" options={VULNERABILITIES} value={vulnerabilities} onChange={setVulnerabilities} />
                <MultiCheck legend="Ações tomadas" options={ACTIONS} value={actions} onChange={setActions} />
                <Field label="Observações">
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
                </Field>
                {error && <Alert tone="error">{error}</Alert>}
                <Button onClick={save} loading={pending} disabled={outcome.trim().length < 2}>
                  Registrar contato
                </Button>
              </section>
              <section className="flex flex-wrap items-end gap-2">
                <Field label="Encerrar caso" className="min-w-0 flex-1">
                  <Input value={closeReason} onChange={(e) => setCloseReason(e.target.value)} placeholder="Motivo (ex.: paciente retomou o acompanhamento)" />
                </Field>
                <Button
                  variant="secondary"
                  disabled={closeReason.trim().length < 3}
                  onClick={async () => {
                    try {
                      await api.post(`/social/cases/${caseId}/close`, { reason: closeReason });
                      toast.success('Caso encerrado.');
                      void detail.reload();
                      onChanged();
                    } catch (err) {
                      toast.error(errorMessage(err));
                    }
                  }}
                >
                  Encerrar
                </Button>
              </section>
            </>
          )}
        </CardBody>
      )}
    </Card>
  );
}
