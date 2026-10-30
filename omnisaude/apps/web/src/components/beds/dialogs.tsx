'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { PatientSearch } from '@/components/patients/patient-search';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import type { PatientSummary } from '@/lib/types';
import { ISOLATION_LABELS, STATUS_STYLE, type BedView, type Census, type Isolation } from './types';

export function BedStatusDialog({ bed, onClose, onDone }: { bed: BedView; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState(bed.status === 'OCUPADO' ? '' : bed.status);
  const [isolation, setIsolation] = useState<Isolation>(bed.isolation);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const history = useApi<{ id: string; status: string; isolation: string; reason: string | null; at: string }[]>(`/beds/${bed.id}/history`);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Leito ${bed.code}`}
      description={STATUS_STYLE[bed.status].label}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Fechar
          </Button>
          <Button
            loading={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await api.patch(`/beds/${bed.id}`, { ...(status && status !== bed.status ? { status } : {}), ...(isolation !== bed.isolation ? { isolation } : {}), reason: reason || undefined });
                onDone();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setPending(false);
              }
            }}
            disabled={(status === bed.status || !status) && isolation === bed.isolation}
          >
            Salvar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {bed.status === 'OCUPADO' ? (
          <Alert tone="info">Leito ocupado: a situação muda pela transferência ou alta do paciente. O isolamento pode ser ajustado.</Alert>
        ) : (
          <Field label="Situação">
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              {(['VAGO', 'HIGIENIZACAO', 'BLOQUEADO'] as const).map((s) => (
                <option key={s} value={s}>
                  {STATUS_STYLE[s].label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Isolamento">
          <Select value={isolation} onChange={(e) => setIsolation(e.target.value as Isolation)}>
            {(Object.keys(ISOLATION_LABELS) as Isolation[]).map((i) => (
              <option key={i} value={i}>
                {ISOLATION_LABELS[i]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Motivo">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: higienização terminal concluída" />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
        <div>
          <p className="mb-1 text-sm font-medium">Histórico</p>
          {history.loading ? (
            <Spinner />
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
              {(history.data ?? []).map((h) => (
                <li key={h.id} className="flex justify-between gap-2">
                  <span>
                    {STATUS_STYLE[h.status as keyof typeof STATUS_STYLE]?.label ?? h.status}
                    {h.isolation !== 'NENHUM' ? ` · isolamento ${h.isolation.toLowerCase()}` : ''}
                    {h.reason ? ` — ${h.reason}` : ''}
                  </span>
                  <span className="shrink-0 text-xs text-slate-500">{fmtDateTime(h.at)}</span>
                </li>
              ))}
              {(history.data ?? []).length === 0 && <li className="text-slate-500">Sem registros.</li>}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export function AdmitDialog({ bed, onClose, onDone }: { bed: BedView; onClose: () => void; onDone: () => void }) {
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [mainCid, setMainCid] = useState('');
  const [regulationCode, setRegulationCode] = useState('');
  const [isolation, setIsolation] = useState<Isolation>(bed.isolation);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Internar no leito ${bed.code}`}
      description="O paciente pode vir de outra unidade da rede (ex.: UPA): o atendimento de origem é encerrado com desfecho de internação."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={pending}
            disabled={!patient || mainCid.trim().length < 3}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await api.post('/admissions', {
                  patientId: patient!.id,
                  bedId: bed.id,
                  mainCid: mainCid.trim().toUpperCase().replace('.', ''),
                  regulationCode: regulationCode.trim() || undefined,
                  isolation,
                });
                onDone();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setPending(false);
              }
            }}
          >
            Internar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {patient ? (
          <Alert tone="info">
            {patient.name} · {patient.age} anos
            <Button variant="link" size="sm" className="ml-2" onClick={() => setPatient(null)}>
              trocar
            </Button>
          </Alert>
        ) : (
          <Field label="Paciente">
            <PatientSearch onSelect={setPatient} autoFocus />
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="CID-10 principal">
            <Input value={mainCid} onChange={(e) => setMainCid(e.target.value)} placeholder="Ex.: J18" maxLength={5} />
          </Field>
          <Field label="Código de regulação (SISREG)" hint="Opcional, quando a vaga veio regulada.">
            <Input value={regulationCode} onChange={(e) => setRegulationCode(e.target.value)} />
          </Field>
        </div>
        <Field label="Precaução exigida pelo paciente" hint="Leito em isolamento só recebe paciente com a mesma precaução.">
          <Select value={isolation} onChange={(e) => setIsolation(e.target.value as Isolation)}>
            {(Object.keys(ISOLATION_LABELS) as Isolation[]).map((i) => (
              <option key={i} value={i}>
                {ISOLATION_LABELS[i]}
              </option>
            ))}
          </Select>
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Dialog>
  );
}

export function TransferDialog({ bed, census, onClose, onDone }: { bed: BedView; census: Census; onClose: () => void; onDone: () => void }) {
  const free = census.wards.flatMap((w) => w.beds.filter((b) => b.status === 'VAGO').map((b) => ({ ...b, ward: w.name })));
  const [target, setTarget] = useState(free[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Transferir ${bed.occupant?.name ?? ''}`}
      description={`Do leito ${bed.code}. O leito de origem vai para higienização.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={pending}
            disabled={!target}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await api.post(`/admissions/${bed.occupant!.admissionId}/transfer`, { bedId: target, reason: reason || undefined });
                onDone();
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setPending(false);
              }
            }}
          >
            Transferir
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Leito de destino">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            {free.length === 0 && <option value="">Nenhum leito vago</option>}
            {free.map((b) => (
              <option key={b.id} value={b.id}>
                {b.ward} · {b.code}
                {b.isolation !== 'NENHUM' ? ` (isolamento ${ISOLATION_LABELS[b.isolation].toLowerCase()})` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Motivo">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Dialog>
  );
}

interface DischargeResult {
  pendingUnitDoses: { unitDoseId: string; serial: string; product?: string; expiry: string }[];
}

export function DischargeDialog({ bed, onClose, onDone }: { bed: BedView; onClose: () => void; onDone: () => void }) {
  const [outcome, setOutcome] = useState<'ALTA' | 'OBITO' | 'TRANSFERENCIA'>('ALTA');
  const [summary, setSummary] = useState('');
  const [diagnoses, setDiagnoses] = useState(bed.occupant?.mainCid ?? '');
  const [followUp, setFollowUp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DischargeResult | null>(null);
  const [returning, setReturning] = useState(false);

  if (result) {
    return (
      <Dialog open onOpenChange={(o) => !o && onDone()} title="Alta registrada" description="O sumário de alta foi enfileirado para a RNDS e o leito foi para higienização." footer={<Button onClick={onDone}>Concluir</Button>}>
        {result.pendingUnitDoses.length === 0 ? (
          <p className="text-sm text-slate-600">Não há doses unitárias pendentes dos medicamentos desta internação nos postos.</p>
        ) : (
          <div className="space-y-3">
            <Alert tone="warn" title="Doses unitárias no posto para conferência (logística reversa)">
              As doses abaixo são dos medicamentos prescritos nesta internação. Confira e devolva as que não serão usadas por outros pacientes.
            </Alert>
            <Table>
              <THead>
                <tr>
                  <TH>Dose</TH>
                  <TH>Validade</TH>
                </tr>
              </THead>
              <TBody>
                {result.pendingUnitDoses.map((d) => (
                  <TR key={d.unitDoseId}>
                    <TD>
                      {d.product}
                      <span className="block font-mono text-xs text-slate-500">{d.serial}</span>
                    </TD>
                    <TD>{fmtDate(d.expiry)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Button
              variant="secondary"
              loading={returning}
              onClick={async () => {
                setReturning(true);
                try {
                  await api.post('/pharmacy/returns/bulk', { unitDoseIds: result.pendingUnitDoses.map((d) => d.unitDoseId), reason: 'Alta do paciente antes da administração' });
                  setResult({ pendingUnitDoses: [] });
                } catch (err) {
                  setError(errorMessage(err));
                } finally {
                  setReturning(false);
                }
              }}
            >
              Devolver todas à farmácia
            </Button>
            {error && <Alert tone="error">{error}</Alert>}
          </div>
        )}
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`Alta de ${bed.occupant?.name ?? ''}`}
      description={`Leito ${bed.code} · ${bed.occupant?.daysAdmitted ?? 0} dia(s) de internação`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={pending}
            disabled={summary.trim().length < 10}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                const r = await api.post<DischargeResult>(`/admissions/${bed.occupant!.admissionId}/discharge`, {
                  outcome,
                  summary,
                  diagnoses: diagnoses
                    .split(/[,;\s]+/)
                    .map((d) => d.trim().toUpperCase().replace('.', ''))
                    .filter((d) => d.length >= 3),
                  followUp: followUp || undefined,
                });
                setResult(r);
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setPending(false);
              }
            }}
          >
            Registrar alta
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Desfecho">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
            <option value="ALTA">Alta</option>
            <option value="TRANSFERENCIA">Transferência para outro serviço</option>
            <option value="OBITO">Óbito</option>
          </Select>
        </Field>
        <Field label="Resumo clínico (sumário de alta)" hint="Mínimo de 10 caracteres.">
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} />
        </Field>
        <Field label="Diagnósticos (CID-10, separados por vírgula)">
          <Input value={diagnoses} onChange={(e) => setDiagnoses(e.target.value)} />
        </Field>
        <Field label="Seguimento / contrarreferência">
          <Textarea value={followUp} onChange={(e) => setFollowUp(e.target.value)} rows={2} placeholder="Ex.: retorno na UBS de referência em 7 dias" />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Dialog>
  );
}
