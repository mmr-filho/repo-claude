'use client';

import { SOAP_LABELS, type SoapNote } from '@omnisaude/shared';
import { FileSignature, Mic, MicOff, Save, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { SignWithCertificate } from '@/components/signatures/sign-button';
import { useMyCertificate, useSignedDocuments } from '@/components/signatures/use-signatures';
import { CodesInput } from './codes-input';
import { parseStoredCode, type ClinicalNote, type CodeRef, type EncounterDetail } from './types';
import { useDictation } from './use-dictation';

interface SoapResult {
  soap: SoapNote;
  vitals: Record<string, number>;
  medications: string[];
  cidSuggestions: { code: string; description: string }[];
  source: 'llm' | 'heuristic';
}

const FIELDS: (keyof SoapNote)[] = ['subjective', 'objective', 'assessment', 'plan'];
const VITAL_LABEL: Record<string, string> = { systolic: 'PAS', diastolic: 'PAD', heartRate: 'FC', respiratoryRate: 'FR', temperature: 'Temp.', spo2: 'SpO₂', glucose: 'Glicemia', painScore: 'Dor' };

/** Evolução SOAP com ditado estruturado (fala → S/O/A/P), códigos e assinatura. */
export function SoapEditor({ encounter, onChanged }: { encounter: EncounterDetail; onChanged: () => void }) {
  const session = useSession();
  const toast = useToast();
  const myDraft = encounter.notes.find((n) => n.status === 'RASCUNHO' && n.authorId === session.me?.user.id && (n.kind === 'SOAP' || n.kind === 'EVOLUCAO'));
  const [noteId, setNoteId] = useState<string | null>(myDraft?.id ?? null);
  const [soap, setSoap] = useState<SoapNote>({
    subjective: myDraft?.subjective ?? '',
    objective: myDraft?.objective ?? '',
    assessment: myDraft?.assessment ?? '',
    plan: myDraft?.plan ?? '',
  });
  const [codes, setCodes] = useState<CodeRef[]>(myDraft ? myDraft.codes.map(parseStoredCode) : []);
  const [structured, setStructured] = useState<SoapResult | null>(null);
  const [busy, setBusy] = useState<'save' | 'sign' | 'ai' | null>(null);
  const dictation = useDictation((m) => toast.error(m));
  const closed = encounter.status === 'ENCERRADO' || encounter.status === 'CANCELADO' || encounter.status === 'EVADIU';
  const signed = encounter.notes.filter((n) => n.status === 'ASSINADO' && n.kind !== 'ATESTADO');
  const signedDocs = useSignedDocuments('ClinicalNote', signed.map((n) => n.id));
  const myCertificate = useMyCertificate();

  useEffect(() => {
    if (!noteId && myDraft) setNoteId(myDraft.id);
  }, [myDraft, noteId]);

  async function ensureStarted() {
    if (encounter.status === 'ABERTO' || encounter.status === 'TRIADO') await api.post(`/clinical/encounters/${encounter.id}/start`);
  }

  async function save(): Promise<string | null> {
    const body = {
      subjective: soap.subjective || undefined,
      objective: soap.objective || undefined,
      assessment: soap.assessment || undefined,
      plan: soap.plan || undefined,
      codes,
    };
    if (noteId) {
      await api.patch(`/clinical/notes/${noteId}`, body);
      return noteId;
    }
    await ensureStarted();
    const n = await api.post<ClinicalNote>(`/clinical/encounters/${encounter.id}/notes`, { kind: 'SOAP', ...body });
    setNoteId(n.id);
    return n.id;
  }

  async function onSave() {
    setBusy('save');
    try {
      await save();
      toast.success('Rascunho salvo');
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function onSign() {
    setBusy('sign');
    try {
      const id = await save();
      const n = await api.post<ClinicalNote>(`/clinical/notes/${id}/sign`);
      toast.success(`Registro assinado · hash ${n.auditHash?.slice(0, 12)}…`);
      setNoteId(null);
      setSoap({ subjective: '', objective: '', assessment: '', plan: '' });
      setCodes([]);
      setStructured(null);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function toggleDictation() {
    if (!dictation.active) {
      await dictation.start();
      return;
    }
    const transcript = await dictation.stop();
    if (transcript.trim().length < 3) return;
    setBusy('ai');
    try {
      const r = await api.post<SoapResult>('/clinical/soap-from-transcript', { transcript });
      setStructured(r);
      setSoap((s) => {
        const merged = { ...s };
        for (const f of FIELDS) {
          const add = r.soap[f]?.trim();
          if (add) merged[f] = s[f].trim() ? `${s[f].trim()}\n${add}` : add;
        }
        return merged;
      });
      toast.info(r.source === 'llm' ? 'Ditado estruturado pela IA: revise antes de assinar.' : 'Ditado distribuído nos blocos SOAP: revise antes de assinar.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {!closed && session.can('prontuario.evoluir') && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {dictation.available ? (
              <Button variant={dictation.active ? 'danger' : 'secondary'} onClick={toggleDictation} loading={busy === 'ai'} aria-pressed={dictation.active}>
                {dictation.active ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                {dictation.active ? 'Parar ditado e estruturar' : 'Ditado clínico'}
              </Button>
            ) : (
              <Badge tone="slate">Ditado indisponível neste navegador</Badge>
            )}
            {noteId && <Badge tone="amber">Rascunho</Badge>}
            <span className="text-xs text-slate-500">Diga “subjetivo”, “objetivo”, “avaliação” ou “plano” para trocar de bloco.</span>
          </div>
          {dictation.active && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm" aria-live="polite">
              <p className="flex items-center gap-2 font-medium text-red-800">
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" /> Ouvindo…
              </p>
              <p className="mt-1 text-slate-700">
                {dictation.text} <span className="text-slate-400">{dictation.partial}</span>
              </p>
            </div>
          )}
          {structured && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-violet-50 p-3 text-sm">
              <Sparkles className="h-4 w-4 text-violet-700" />
              {Object.entries(structured.vitals).map(([k, v]) => (
                <Badge key={k} tone="violet">
                  {VITAL_LABEL[k] ?? k}: {v}
                </Badge>
              ))}
              {structured.medications.map((m) => (
                <Badge key={m} tone="blue">
                  {m}
                </Badge>
              ))}
              {structured.cidSuggestions.map((c) => (
                <button key={c.code} type="button" onClick={() => setCodes((s) => (s.some((x) => x.code === c.code) ? s : [...s, { system: 'CID10', code: c.code.replace('.', '') }]))} className="rounded-full bg-white px-2 py-0.5 text-xs ring-1 ring-violet-300">
                  + {c.code} {c.description}
                </button>
              ))}
            </div>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f} className="flex flex-col gap-1.5">
                <Label htmlFor={`soap-${f}`}>
                  {f[0]!.toUpperCase()} · {SOAP_LABELS[f]}
                </Label>
                <Textarea id={`soap-${f}`} value={soap[f]} onChange={(e) => setSoap((s) => ({ ...s, [f]: e.target.value }))} rows={5} />
              </div>
            ))}
          </div>
          <div>
            <Label>Problemas / diagnósticos (CID-10 ou CIAP-2)</Label>
            <div className="mt-1.5">
              <CodesInput value={codes} onChange={setCodes} />
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onSave} loading={busy === 'save'}>
              <Save className="h-4 w-4" /> Salvar rascunho
            </Button>
            <Button onClick={onSign} loading={busy === 'sign'} disabled={!soap.assessment.trim() || codes.length === 0} title={!soap.assessment.trim() || codes.length === 0 ? 'Preencha a avaliação e informe ao menos um código' : undefined}>
              <FileSignature className="h-4 w-4" /> Assinar
            </Button>
          </div>
          {!session.me?.context.mfa && <Alert tone="info">A assinatura registra o hash SHA-256 do conteúdo, horário, IP e o status de 2FA da sessão (sem 2FA nesta sessão).</Alert>}
        </div>
      )}
      {signed.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-slate-700">Registros assinados neste atendimento</h3>
          {signed.map((n) => (
            <article key={n.id} className="rounded-lg border border-slate-200 p-3 text-sm">
              <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <ShieldCheck className="h-4 w-4 text-emerald-600" /> {n.authorName ?? n.role} · {fmtDateTime(n.signedAt)} · {n.codes.map((c) => parseStoredCode(c).code).join(', ')}
                <span className="font-mono" title={n.auditHash ?? ''}>
                  hash {n.auditHash?.slice(0, 16)}…
                </span>
              </p>
              {n.subjective && <p><b>S:</b> {n.subjective}</p>}
              {n.objective && <p><b>O:</b> {n.objective}</p>}
              {n.assessment && <p><b>A:</b> {n.assessment}</p>}
              {n.plan && <p><b>P:</b> {n.plan}</p>}
              <div className="mt-2">
                <SignWithCertificate entityType="ClinicalNote" entityId={n.id} doc={signedDocs.byEntity.get(n.id)} canSign={!!myCertificate.certificate && n.authorId === session.me?.user.id} onSigned={() => void signedDocs.reload()} />
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
