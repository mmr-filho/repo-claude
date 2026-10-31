'use client';

import { news2, NIVEL_CONSCIENCIA, PRIORIDADE_LEITO, prioridadeLeitoSugerida, TIPO_LEITO, type NivelConsciencia, type PrioridadeRegulacao, type TipoLeito } from '@omnisaude/shared';
import { useEffect, useMemo, useState } from 'react';
import { PatientSearch } from '@/components/patients/patient-search';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import type { PatientSummary } from '@/lib/types';
import { PRIORIDADE_LEITO_TONE, RISCO_NEWS2, type Isolation, type SolicitacaoLeito } from './types';

const ISOLAMENTO: Record<Isolation, string> = { NENHUM: 'Sem isolamento', CONTATO: 'Contato', GOTICULAS: 'Gotículas', AEROSSOIS: 'Aerossóis' };
const vazio = () => ({
  bedKind: 'CLINICA_MEDICA' as TipoLeito,
  specialty: '',
  cid: '',
  clinicalSummary: '',
  pas: '',
  pad: '',
  fc: '',
  fr: '',
  sato2: '',
  temp: '',
  consciencia: '' as NivelConsciencia | '',
  oxigenio: false,
  ventilacaoMecanica: false,
  drogaVasoativa: false,
  dialise: false,
  isolation: 'NENHUM' as Isolation,
  elective: false,
  priority: '' as PrioridadeRegulacao | '',
  procedureCode: '',
  externalCode: '',
});
const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));

export interface PrefillLeito {
  patient?: PatientSummary | null;
  encounterId?: string | null;
  cid?: string | null;
  resumo?: string | null;
}

/** Solicitação de vaga à central de leitos: tipo de leito, quadro clínico, sinais vitais (NEWS2), suporte, isolamento e prioridade. */
export function BedRequestDialog({
  aberto,
  onClose,
  onSalvo,
  prefill,
  existente,
}: {
  aberto: boolean;
  onClose: () => void;
  onSalvo: (s: SolicitacaoLeito) => void;
  prefill?: PrefillLeito;
  existente?: SolicitacaoLeito | null;
}) {
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [f, setF] = useState(vazio());
  const [notes, setNotes] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!aberto) return;
    setErro(null);
    setNotes('');
    if (existente) {
      setPatient(existente.patient);
      const v = existente.vitals ?? {};
      setF({
        bedKind: existente.bedKind,
        specialty: existente.specialty,
        cid: existente.cid ?? '',
        clinicalSummary: existente.clinicalSummary,
        pas: v.pas?.toString() ?? '',
        pad: v.pad?.toString() ?? '',
        fc: v.fc?.toString() ?? '',
        fr: v.fr?.toString() ?? '',
        sato2: v.sato2?.toString() ?? '',
        temp: v.temp?.toString() ?? '',
        consciencia: v.consciencia ?? '',
        oxigenio: !!v.oxigenio,
        ventilacaoMecanica: !!existente.support.ventilacaoMecanica,
        drogaVasoativa: !!existente.support.drogaVasoativa,
        dialise: !!existente.support.dialise,
        isolation: existente.isolation,
        elective: existente.elective,
        priority: '',
        procedureCode: existente.procedureCode ?? '',
        externalCode: existente.externalCode ?? '',
      });
    } else {
      setPatient(prefill?.patient ?? null);
      setF({ ...vazio(), cid: prefill?.cid ?? '', clinicalSummary: prefill?.resumo ?? '' });
    }
  }, [aberto, existente, prefill]);

  const set = <K extends keyof ReturnType<typeof vazio>>(k: K, v: ReturnType<typeof vazio>[K]) => setF((x) => ({ ...x, [k]: v }));
  const vitais = useMemo(() => ({ pas: num(f.pas), pad: num(f.pad), fc: num(f.fc), fr: num(f.fr), sato2: num(f.sato2), temp: num(f.temp), consciencia: f.consciencia || null, oxigenio: f.oxigenio }), [f]);
  const temVitais = Object.values(vitais).some((v) => v !== null && v !== false);
  const n = temVitais ? news2(vitais) : null;
  const suporte = { ventilacaoMecanica: f.ventilacaoMecanica, drogaVasoativa: f.drogaVasoativa, oxigenio: f.oxigenio, dialise: f.dialise };
  const sugerida = prioridadeLeitoSugerida(n, suporte, f.bedKind, f.elective);
  const prioridade = f.priority || sugerida;

  async function salvar() {
    setErro(null);
    if (!patient) return setErro('Escolha a pessoa');
    const body = {
      patientId: patient.id,
      encounterId: existente ? undefined : (prefill?.encounterId ?? null),
      bedKind: f.bedKind,
      specialty: f.specialty.trim(),
      cid: f.cid.trim() || null,
      clinicalSummary: f.clinicalSummary.trim(),
      vitals: temVitais ? vitais : null,
      support: suporte,
      isolation: f.isolation,
      elective: f.elective,
      priority: f.priority || null,
      ...(existente ? { notes: notes.trim() || null } : {}),
    };
    setBusy(true);
    try {
      const s = existente ? await api.put<SolicitacaoLeito>(`/regulacao-leitos/solicitacoes/${existente.id}`, body) : await api.post<SolicitacaoLeito>('/regulacao-leitos/solicitacoes', body);
      onSalvo(s);
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
      title={existente ? `Complementar ${existente.protocol}` : 'Solicitar vaga de leito'}
      description="A central de leitos regula a vaga na rede; a prioridade sugerida vem do NEWS2, do suporte em uso e do tipo de leito."
      size="xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={salvar} loading={busy} id="leito-salvar" disabled={!patient || f.specialty.trim().length < 3 || f.clinicalSummary.trim().length < 20}>
            {existente ? 'Reenviar à central' : 'Enviar à central'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {erro && <Alert tone="error">{erro}</Alert>}
        {existente?.decision?.reason && existente.status === 'DEVOLVIDA' && (
          <Alert tone="warn" title="Pendência apontada pelo regulador">
            {existente.decision.reason}
          </Alert>
        )}
        {!existente && (
          <div>
            <p className="mb-1 text-sm font-medium">Pessoa</p>
            {patient ? (
              <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <span>
                  <b>{patient.name}</b> · {patient.age} anos
                </span>
                {!prefill?.patient && (
                  <Button size="sm" variant="ghost" onClick={() => setPatient(null)}>
                    Trocar
                  </Button>
                )}
              </div>
            ) : (
              <PatientSearch onSelect={setPatient} placeholder="Nome, CPF ou CNS" />
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Tipo de leito" htmlFor="leito-tipo">
            <Select id="leito-tipo" value={f.bedKind} onChange={(e) => set('bedKind', e.target.value as TipoLeito)}>
              {(Object.keys(TIPO_LEITO) as TipoLeito[]).map((k) => (
                <option key={k} value={k}>
                  {TIPO_LEITO[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Especialidade" htmlFor="leito-esp" className="sm:col-span-2">
            <Input id="leito-esp" value={f.specialty} onChange={(e) => set('specialty', e.target.value)} placeholder="Clínica médica, cardiologia, cirurgia geral…" />
          </Field>
          <Field label="CID-10" htmlFor="leito-cid">
            <Input id="leito-cid" value={f.cid} onChange={(e) => set('cid', e.target.value)} placeholder="J18" />
          </Field>
        </div>
        <Field label="Quadro clínico, evolução e exames" htmlFor="leito-resumo">
          <Textarea id="leito-resumo" rows={3} value={f.clinicalSummary} onChange={(e) => set('clinicalSummary', e.target.value)} />
        </Field>
        <div>
          <p className="mb-1 text-sm font-medium">Sinais vitais (NEWS2)</p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
            <Input inputMode="numeric" value={f.pas} onChange={(e) => set('pas', e.target.value)} placeholder="PAS" aria-label="Pressão sistólica" id="leito-pas" />
            <Input inputMode="numeric" value={f.pad} onChange={(e) => set('pad', e.target.value)} placeholder="PAD" aria-label="Pressão diastólica" />
            <Input inputMode="numeric" value={f.fc} onChange={(e) => set('fc', e.target.value)} placeholder="FC" aria-label="Frequência cardíaca" id="leito-fc" />
            <Input inputMode="numeric" value={f.fr} onChange={(e) => set('fr', e.target.value)} placeholder="FR" aria-label="Frequência respiratória" id="leito-fr" />
            <Input inputMode="numeric" value={f.sato2} onChange={(e) => set('sato2', e.target.value)} placeholder="SatO2 %" aria-label="Saturação" id="leito-sato2" />
            <Input inputMode="decimal" value={f.temp} onChange={(e) => set('temp', e.target.value)} placeholder="Temp °C" aria-label="Temperatura" id="leito-temp" />
            <Select value={f.consciencia} onChange={(e) => set('consciencia', e.target.value as NivelConsciencia | '')} aria-label="Nível de consciência" id="leito-consc">
              <option value="">Consciência…</option>
              {(Object.keys(NIVEL_CONSCIENCIA) as NivelConsciencia[]).map((c) => (
                <option key={c} value={c}>
                  {NIVEL_CONSCIENCIA[c]}
                </option>
              ))}
            </Select>
          </div>
          {n && (
            <p className="mt-1 text-sm">
              NEWS2 <b>{n.pontos}</b> <Badge tone={RISCO_NEWS2[n.risco].tone}>{RISCO_NEWS2[n.risco].label}</Badge>
              {n.faltando.length > 0 && <span className="ml-2 text-xs text-slate-500">faltam: {n.faltando.join(', ')}</span>}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.oxigenio} onChange={(e) => set('oxigenio', e.target.checked)} /> Oxigênio suplementar
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.ventilacaoMecanica} onChange={(e) => set('ventilacaoMecanica', e.target.checked)} id="leito-vm" /> Ventilação mecânica
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.drogaVasoativa} onChange={(e) => set('drogaVasoativa', e.target.checked)} /> Droga vasoativa
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.dialise} onChange={(e) => set('dialise', e.target.checked)} /> Diálise
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.elective} onChange={(e) => set('elective', e.target.checked)} /> Internação eletiva
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Isolamento" htmlFor="leito-iso">
            <Select id="leito-iso" value={f.isolation} onChange={(e) => set('isolation', e.target.value as Isolation)}>
              {(Object.keys(ISOLAMENTO) as Isolation[]).map((i) => (
                <option key={i} value={i}>
                  {ISOLAMENTO[i]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Prioridade" htmlFor="leito-prio" hint={`Sugerida: ${PRIORIDADE_LEITO[sugerida].label} (${PRIORIDADE_LEITO[sugerida].prazoHoras} h)`}>
            <Select id="leito-prio" value={f.priority} onChange={(e) => set('priority', e.target.value as PrioridadeRegulacao | '')}>
              <option value="">Usar a sugerida</option>
              {(Object.keys(PRIORIDADE_LEITO) as PrioridadeRegulacao[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORIDADE_LEITO[p].label} · {PRIORIDADE_LEITO[p].prazoHoras} h
                </option>
              ))}
            </Select>
          </Field>
          <div className="self-end text-sm">
            <Badge tone={PRIORIDADE_LEITO_TONE[prioridade]}>{PRIORIDADE_LEITO[prioridade].label}</Badge> <span className="text-slate-600">{PRIORIDADE_LEITO[prioridade].descricao}</span>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Procedimento SIGTAP da internação (RNDS)" htmlFor="leito-sigtap" hint="Exigido pelo MIRA para enviar a solicitação à RNDS; o laudo de AIH também o fornece.">
            <Input id="leito-sigtap" inputMode="numeric" value={f.procedureCode} onChange={(e) => set('procedureCode', e.target.value)} placeholder="0303010xxx" />
          </Field>
          <Field label="Código no SISREG / e-SUS Regulação" htmlFor="leito-externo" hint="Quando a vaga também está registrada no sistema do estado.">
            <Input id="leito-externo" value={f.externalCode} onChange={(e) => set('externalCode', e.target.value)} />
          </Field>
        </div>
        {existente && (
          <Field label="O que foi complementado" htmlFor="leito-notas">
            <Textarea id="leito-notas" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
