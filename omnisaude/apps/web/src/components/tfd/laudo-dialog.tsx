'use client';

import { TRANSPORTE_TFD, UFS, type TransporteTfd } from '@omnisaude/shared';
import { useEffect, useState } from 'react';
import { PatientSearch } from '@/components/patients/patient-search';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import type { PatientSummary } from '@/lib/types';
import type { Processo } from './types';

const vazio = () => ({
  cid: '',
  diagnosis: '',
  procedureName: '',
  procedureCode: '',
  clinicalSummary: '',
  justification: '',
  urgency: false,
  destinationCity: '',
  destinationUf: 'TO',
  destinationIbge: '',
  destinationUnit: '',
  transport: 'RODOVIARIO' as TransporteTfd,
  needsCompanion: false,
  companionName: '',
  companionCpf: '',
  companionRelation: '',
  accommodation: false,
});

/** Laudo médico do TFD: diagnóstico, procedimento, justificativa de indisponibilidade, destino, transporte e acompanhante. */
export function LaudoDialog({ aberto, onClose, existente, onSalvo }: { aberto: boolean; onClose: () => void; existente: Processo | null; onSalvo: (p: Processo) => void }) {
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [f, setF] = useState(vazio());
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!aberto) return;
    setErro(null);
    if (existente) {
      setPatient({ ...existente.patient });
      setF({
        cid: existente.cid ?? '',
        diagnosis: existente.diagnosis,
        procedureName: existente.procedureName,
        procedureCode: existente.procedureCode ?? '',
        clinicalSummary: existente.clinicalSummary,
        justification: existente.justification,
        urgency: existente.urgency,
        destinationCity: existente.destination.city,
        destinationUf: existente.destination.uf,
        destinationIbge: existente.destination.ibge ?? '',
        destinationUnit: existente.destination.unit ?? '',
        transport: existente.transport as TransporteTfd,
        needsCompanion: !!existente.companion,
        companionName: existente.companion?.name ?? '',
        companionCpf: existente.companion?.cpf ?? '',
        companionRelation: existente.companion?.relation ?? '',
        accommodation: existente.accommodation,
      });
    } else {
      setPatient(null);
      setF(vazio());
    }
  }, [aberto, existente]);

  const set = <K extends keyof ReturnType<typeof vazio>>(k: K, v: ReturnType<typeof vazio>[K]) => setF((x) => ({ ...x, [k]: v }));

  async function salvar() {
    setErro(null);
    if (!patient) return setErro('Escolha a pessoa');
    const texto = (v: string) => (v.trim() ? v.trim() : null);
    const body = {
      patientId: patient.id,
      cid: texto(f.cid),
      diagnosis: f.diagnosis.trim(),
      procedureName: f.procedureName.trim(),
      procedureCode: texto(f.procedureCode),
      clinicalSummary: f.clinicalSummary.trim(),
      justification: f.justification.trim(),
      urgency: f.urgency,
      destinationCity: f.destinationCity.trim(),
      destinationUf: f.destinationUf,
      destinationIbge: texto(f.destinationIbge),
      destinationUnit: texto(f.destinationUnit),
      transport: f.transport,
      needsCompanion: f.needsCompanion,
      companionName: texto(f.companionName),
      companionCpf: texto(f.companionCpf),
      companionRelation: texto(f.companionRelation),
      accommodation: f.accommodation,
    };
    setBusy(true);
    try {
      const p = existente ? await api.put<Processo>(`/tfd/processos/${existente.id}/laudo`, body) : await api.post<Processo>('/tfd/processos', body);
      onSalvo(p);
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
      title={existente ? `Laudo · ${existente.protocol}` : 'Novo processo de TFD'}
      description="Laudo médico para Tratamento Fora do Domicílio (Portaria SAS/MS 55/1999)"
      size="xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={salvar} loading={busy} id="tfd-salvar">
            {existente ? 'Salvar laudo' : 'Abrir processo'}
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
                <span>
                  <b>{patient.name}</b> · {patient.age} anos
                </span>
                <Button size="sm" variant="ghost" onClick={() => setPatient(null)}>
                  Trocar
                </Button>
              </div>
            ) : (
              <PatientSearch onSelect={setPatient} placeholder="Nome, CPF ou CNS" />
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Diagnóstico" htmlFor="tfd-diag" className="sm:col-span-2">
            <Input id="tfd-diag" value={f.diagnosis} onChange={(e) => set('diagnosis', e.target.value)} />
          </Field>
          <Field label="CID-10" htmlFor="tfd-cid">
            <Input id="tfd-cid" value={f.cid} onChange={(e) => set('cid', e.target.value)} placeholder="C50" />
          </Field>
          <Field label="Procedimento solicitado" htmlFor="tfd-proc" className="sm:col-span-2">
            <Input id="tfd-proc" value={f.procedureName} onChange={(e) => set('procedureName', e.target.value)} placeholder="Consulta, exame, cirurgia…" />
          </Field>
          <Field label="SIGTAP (opcional)" htmlFor="tfd-sigtap">
            <Input id="tfd-sigtap" value={f.procedureCode} onChange={(e) => set('procedureCode', e.target.value)} />
          </Field>
        </div>
        <Field label="Resumo clínico" htmlFor="tfd-resumo">
          <Textarea id="tfd-resumo" rows={3} value={f.clinicalSummary} onChange={(e) => set('clinicalSummary', e.target.value)} />
        </Field>
        <Field label="Justificativa: por que não é possível no município" htmlFor="tfd-just">
          <Textarea id="tfd-just" rows={2} value={f.justification} onChange={(e) => set('justification', e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Cidade de destino" htmlFor="tfd-cidade" className="sm:col-span-2">
            <Input id="tfd-cidade" value={f.destinationCity} onChange={(e) => set('destinationCity', e.target.value)} />
          </Field>
          <Field label="UF" htmlFor="tfd-uf">
            <Select id="tfd-uf" value={f.destinationUf} onChange={(e) => set('destinationUf', e.target.value)}>
              {UFS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="IBGE (opcional)" htmlFor="tfd-ibge">
            <Input id="tfd-ibge" value={f.destinationIbge} onChange={(e) => set('destinationIbge', e.target.value)} />
          </Field>
          <Field label="Unidade de destino" htmlFor="tfd-unidade" className="sm:col-span-2">
            <Input id="tfd-unidade" value={f.destinationUnit} onChange={(e) => set('destinationUnit', e.target.value)} placeholder="Hospital, ambulatório…" />
          </Field>
          <Field label="Transporte" htmlFor="tfd-transp" className="sm:col-span-2">
            <Select id="tfd-transp" value={f.transport} onChange={(e) => set('transport', e.target.value as TransporteTfd)}>
              {(Object.keys(TRANSPORTE_TFD) as TransporteTfd[]).map((t) => (
                <option key={t} value={t}>
                  {TRANSPORTE_TFD[t]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.urgency} onChange={(e) => set('urgency', e.target.checked)} /> Caráter de urgência
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.accommodation} onChange={(e) => set('accommodation', e.target.checked)} /> Necessita pernoite
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.needsCompanion} onChange={(e) => set('needsCompanion', e.target.checked)} id="tfd-acomp" /> Necessita acompanhante
          </label>
        </div>
        {f.needsCompanion && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Nome do acompanhante" htmlFor="tfd-acomp-nome">
              <Input id="tfd-acomp-nome" value={f.companionName} onChange={(e) => set('companionName', e.target.value)} />
            </Field>
            <Field label="CPF" htmlFor="tfd-acomp-cpf">
              <Input id="tfd-acomp-cpf" value={f.companionCpf} onChange={(e) => set('companionCpf', e.target.value)} />
            </Field>
            <Field label="Parentesco / vínculo" htmlFor="tfd-acomp-rel">
              <Input id="tfd-acomp-rel" value={f.companionRelation} onChange={(e) => set('companionRelation', e.target.value)} />
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}
