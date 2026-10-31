'use client';

import { CARATER_INTERNACAO, ESPECIALIDADE_AIH } from '@omnisaude/shared';
import { useEffect, useState } from 'react';
import { PatientSearch } from '@/components/patients/patient-search';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import type { PatientSummary } from '@/lib/types';
import type { Laudo } from './types';

export interface PrefillAih {
  patientId: string;
  patientName: string;
  admissionId?: string | null;
  bedRequestId?: string | null;
  mainCid?: string | null;
  specialtyCode?: string | null;
}

const vazio = () => ({ procedureCode: '', procedureName: '', mainCid: '', secondaryCid: '', associatedCid: '', specialtyCode: '03', nature: '02', symptoms: '', conditions: '', diagnostics: '', notes: '' });

/** Laudo médico para solicitação/autorização de internação hospitalar (AIH). */
export function AihDialog({ aberto, onClose, onSalvo, prefill, existente }: { aberto: boolean; onClose: () => void; onSalvo: (l: Laudo) => void; prefill?: PrefillAih | null; existente?: Laudo | null }) {
  const [patient, setPatient] = useState<PatientSummary | { id: string; name: string } | null>(null);
  const [f, setF] = useState(vazio());
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sigtap, setSigtap] = useState<{ code: string; name: string }[]>([]);

  useEffect(() => {
    if (!aberto) return;
    setErro(null);
    if (existente) {
      setPatient(existente.patient);
      setF({
        procedureCode: existente.procedureCode,
        procedureName: existente.procedureName,
        mainCid: existente.mainCid,
        secondaryCid: existente.secondaryCid ?? '',
        associatedCid: existente.associatedCid ?? '',
        specialtyCode: existente.specialtyCode,
        nature: existente.nature,
        symptoms: existente.symptoms,
        conditions: existente.conditions,
        diagnostics: existente.diagnostics,
        notes: existente.notes ?? '',
      });
    } else {
      setPatient(prefill ? { id: prefill.patientId, name: prefill.patientName } : null);
      setF({ ...vazio(), mainCid: prefill?.mainCid ?? '', specialtyCode: prefill?.specialtyCode ?? '03' });
    }
  }, [aberto, existente, prefill]);

  useEffect(() => {
    const q = f.procedureName.trim();
    if (q.length < 3 || /^\d+$/.test(q)) return;
    const h = setTimeout(() => {
      api
        .get<{ code: string; name: string }[]>(`/aih/sigtap?q=${encodeURIComponent(q)}`)
        .then((r) => setSigtap(r.slice(0, 8)))
        .catch(() => setSigtap([]));
    }, 300);
    return () => clearTimeout(h);
  }, [f.procedureName]);

  const set = <K extends keyof ReturnType<typeof vazio>>(k: K, v: ReturnType<typeof vazio>[K]) => setF((x) => ({ ...x, [k]: v }));

  async function salvar() {
    setErro(null);
    if (!patient) return setErro('Escolha a pessoa');
    const body = {
      patientId: patient.id,
      admissionId: existente ? undefined : (prefill?.admissionId ?? null),
      bedRequestId: existente ? undefined : (prefill?.bedRequestId ?? null),
      procedureCode: f.procedureCode.replace(/\D/g, ''),
      procedureName: f.procedureName.trim() || null,
      mainCid: f.mainCid.trim(),
      secondaryCid: f.secondaryCid.trim() || null,
      associatedCid: f.associatedCid.trim() || null,
      specialtyCode: f.specialtyCode,
      nature: f.nature,
      symptoms: f.symptoms.trim(),
      conditions: f.conditions.trim(),
      diagnostics: f.diagnostics.trim(),
      notes: f.notes.trim() || null,
    };
    setBusy(true);
    try {
      const l = existente ? await api.put<Laudo>(`/aih/laudos/${existente.id}`, body) : await api.post<Laudo>('/aih/laudos', body);
      onSalvo(l);
      onClose();
    } catch (err) {
      setErro(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={aberto}
      onOpenChange={(o) => !o && onClose()}
      title={existente ? 'Corrigir laudo de AIH' : 'Laudo para AIH'}
      description="Laudo médico para solicitação / autorização de internação hospitalar (SIH/SUS)"
      size="xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            onClick={salvar}
            loading={busy}
            id="aih-salvar"
            disabled={!patient || f.procedureCode.replace(/\D/g, '').length !== 10 || f.mainCid.trim().length < 3 || f.symptoms.trim().length < 10 || f.conditions.trim().length < 10 || f.diagnostics.trim().length < 3}
          >
            {existente ? 'Salvar laudo' : 'Emitir laudo'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {erro && <Alert tone="error">{erro}</Alert>}
        {!existente && (
          <div>
            <p className="mb-1 text-sm font-medium">Pessoa</p>
            {patient ? (
              <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <b>{patient.name}</b>
                {!prefill && (
                  <Button size="sm" variant="ghost" onClick={() => setPatient(null)}>
                    Trocar
                  </Button>
                )}
              </div>
            ) : (
              <PatientSearch onSelect={setPatient} placeholder="Nome, CPF ou CNS" />
            )}
            {prefill?.admissionId && <p className="mt-1 text-xs text-slate-500">Vinculado à internação em curso: o número da AIH autorizada vai para o espelho de faturamento.</p>}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Procedimento SIGTAP (código)" htmlFor="aih-proc-cod">
            <Input id="aih-proc-cod" value={f.procedureCode} onChange={(e) => set('procedureCode', e.target.value)} placeholder="0303140151" inputMode="numeric" />
          </Field>
          <Field label="Procedimento (nome)" htmlFor="aih-proc-nome" className="sm:col-span-3" hint="Digite para buscar na SIGTAP; o nome oficial substitui o digitado quando o código existe.">
            <Input id="aih-proc-nome" value={f.procedureName} onChange={(e) => set('procedureName', e.target.value)} list="aih-sigtap" />
            <datalist id="aih-sigtap">
              {sigtap.map((p) => (
                <option key={p.code} value={p.name}>
                  {p.code}
                </option>
              ))}
            </datalist>
            {sigtap.length > 0 && !f.procedureCode && (
              <div className="mt-1 flex flex-wrap gap-1">
                {sigtap.map((p) => (
                  <Button
                    key={p.code}
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      set('procedureCode', p.code);
                      set('procedureName', p.name);
                      setSigtap([]);
                    }}
                  >
                    {p.code} · {p.name.slice(0, 40)}
                  </Button>
                ))}
              </div>
            )}
          </Field>
          <Field label="CID-10 principal" htmlFor="aih-cid">
            <Input id="aih-cid" value={f.mainCid} onChange={(e) => set('mainCid', e.target.value)} placeholder="J18" />
          </Field>
          <Field label="CID secundário" htmlFor="aih-cid2">
            <Input id="aih-cid2" value={f.secondaryCid} onChange={(e) => set('secondaryCid', e.target.value)} />
          </Field>
          <Field label="CID causas associadas" htmlFor="aih-cid3">
            <Input id="aih-cid3" value={f.associatedCid} onChange={(e) => set('associatedCid', e.target.value)} />
          </Field>
          <Field label="Especialidade do leito" htmlFor="aih-esp">
            <Select id="aih-esp" value={f.specialtyCode} onChange={(e) => set('specialtyCode', e.target.value)}>
              {Object.entries(ESPECIALIDADE_AIH).map(([k, v]) => (
                <option key={k} value={k}>
                  {k} · {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Caráter da internação" htmlFor="aih-carater" className="sm:col-span-2">
            <Select id="aih-carater" value={f.nature} onChange={(e) => set('nature', e.target.value)}>
              {Object.entries(CARATER_INTERNACAO).map(([k, v]) => (
                <option key={k} value={k}>
                  {k} · {v}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Principais sinais e sintomas clínicos" htmlFor="aih-sintomas">
          <Textarea id="aih-sintomas" rows={2} value={f.symptoms} onChange={(e) => set('symptoms', e.target.value)} />
        </Field>
        <Field label="Condições que justificam a internação" htmlFor="aih-cond">
          <Textarea id="aih-cond" rows={2} value={f.conditions} onChange={(e) => set('conditions', e.target.value)} />
        </Field>
        <Field label="Principais resultados de provas diagnósticas" htmlFor="aih-provas">
          <Textarea id="aih-provas" rows={2} value={f.diagnostics} onChange={(e) => set('diagnostics', e.target.value)} />
        </Field>
        <Field label="Observações" htmlFor="aih-obs">
          <Input id="aih-obs" value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
