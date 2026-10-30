'use client';

import { BookMarked, FlaskConical, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useSession } from '@/lib/session';
import { parseStoredCode, type CodeRef, type EncounterDetail } from './types';

interface Pathway {
  protocol: { id: string; title: string; source: string; recommendations: string[] };
  exams: { sigtapCode: string; name: string }[];
  matchedCode: string;
  system: 'CID10' | 'CIAP2';
}

const STATUS_TONE = { SOLICITADO: 'slate', COLETADO: 'blue', RESULTADO: 'green', CANCELADO: 'red' } as const;

/** Exames solicitados e linha de cuidado (protocolo do Ministério da Saúde) a partir do diagnóstico. */
export function ExamsPanel({ encounter, onChanged, prefill }: { encounter: EncounterDetail; onChanged: () => void; prefill?: string[] }) {
  const session = useSession();
  const toast = useToast();
  const lastCodes = encounter.notes.flatMap((n) => n.codes).map(parseStoredCode);
  const conditionCodes: CodeRef[] = encounter.patient.conditions.map((c) => ({ system: c.system === 'CIAP2' ? 'CIAP2' : 'CID10', code: c.code }));
  const candidates = [...(encounter.mainCid ? [{ system: 'CID10' as const, code: encounter.mainCid }] : []), ...lastCodes, ...conditionCodes].filter((c, i, a) => a.findIndex((x) => x.code === c.code && x.system === c.system) === i);
  const [code, setCode] = useState<CodeRef | null>(candidates[0] ?? null);
  const [pathway, setPathway] = useState<Pathway | null>(null);
  const [pathwayMsg, setPathwayMsg] = useState<string | null>(null);
  const [name, setName] = useState(prefill?.join(', ') ?? '');
  const [sigtap, setSigtap] = useState('');
  const [busy, setBusy] = useState(false);
  const canRequest = session.can('exame.solicitar');

  useEffect(() => {
    if (prefill?.length) setName(prefill.join(', '));
  }, [prefill]);

  useEffect(() => {
    if (!code) return;
    setPathway(null);
    setPathwayMsg(null);
    api
      .get<Pathway>(`/clinical/protocols?code=${encodeURIComponent(code.code)}&system=${code.system}`)
      .then(setPathway)
      .catch((err) => setPathwayMsg(errorMessage(err)));
  }, [code]);

  async function requestProtocol() {
    if (!code) return;
    setBusy(true);
    try {
      const r = await api.post<unknown[]>(`/clinical/encounters/${encounter.id}/protocol-exams`, { system: code.system, code: code.code });
      toast.success(`${r.length} exame(s) solicitados`);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function requestOne() {
    setBusy(true);
    try {
      await api.post(`/clinical/encounters/${encounter.id}/exams`, { items: [{ sigtapCode: sigtap.replace(/\D/g, ''), name: name.trim() }] });
      toast.success('Exame solicitado');
      setName('');
      setSigtap('');
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-lg border border-slate-200 p-4">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <BookMarked className="h-5 w-5 text-brand-600" />
          <h3 className="font-semibold">Linha de cuidado</h3>
          {candidates.length > 0 ? (
            <Select
              className="w-auto"
              value={code ? `${code.system}:${code.code}` : ''}
              onChange={(e) => setCode(parseStoredCode(e.target.value))}
              aria-label="Diagnóstico para o protocolo"
            >
              {candidates.map((c) => (
                <option key={`${c.system}:${c.code}`} value={`${c.system}:${c.code}`}>
                  {c.system === 'CIAP2' ? 'CIAP-2' : 'CID-10'} {c.code}
                </option>
              ))}
            </Select>
          ) : (
            <span className="text-sm text-slate-500">Informe um CID-10/CIAP-2 na evolução para ver o protocolo.</span>
          )}
        </div>
        {pathwayMsg && <p className="text-sm text-slate-500">{pathwayMsg}</p>}
        {pathway && (
          <div className="flex flex-col gap-3 text-sm">
            <p>
              <b>{pathway.protocol.title}</b> <span className="text-slate-500">— {pathway.protocol.source}</span>
            </p>
            <ul className="list-inside list-disc text-slate-700">
              {pathway.protocol.recommendations.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              {pathway.exams.map((x) => (
                <Badge key={x.sigtapCode} tone="blue">
                  {x.name} · {x.sigtapCode}
                </Badge>
              ))}
            </div>
            {canRequest && encounter.status !== 'ENCERRADO' && (
              <Button onClick={requestProtocol} loading={busy} className="self-start">
                <FlaskConical className="h-4 w-4" /> Solicitar exames do protocolo
              </Button>
            )}
          </div>
        )}
      </section>

      {canRequest && encounter.status !== 'ENCERRADO' && (
        <section className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
          <Field label="Exame" htmlFor="ex-name">
            <Input id="ex-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Hemograma completo" />
          </Field>
          <Field label="Código SIGTAP" htmlFor="ex-sigtap">
            <Input id="ex-sigtap" value={sigtap} onChange={(e) => setSigtap(e.target.value)} placeholder="02.02.02.038-0" />
          </Field>
          <Button variant="secondary" onClick={requestOne} disabled={name.trim().length < 2 || sigtap.replace(/\D/g, '').length !== 10} loading={busy}>
            <Plus className="h-4 w-4" /> Solicitar
          </Button>
        </section>
      )}

      {encounter.examRequests.length === 0 ? (
        <Alert tone="info">Nenhum exame solicitado neste atendimento.</Alert>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Exame</TH>
              <TH>SIGTAP</TH>
              <TH>Situação</TH>
              <TH>Resultado</TH>
              <TH>Data</TH>
            </tr>
          </THead>
          <TBody>
            {encounter.examRequests.map((x) => (
              <TR key={x.id}>
                <TD>{x.name}</TD>
                <TD className="font-mono text-xs">{x.sigtapCode}</TD>
                <TD>
                  <Badge tone={STATUS_TONE[x.status]}>{x.status.toLowerCase()}</Badge>
                </TD>
                <TD>{x.resultValue !== null ? `${String(x.resultValue)} ${x.resultUnit ?? ''}` : (x.resultText ?? '—')}</TD>
                <TD>{fmtDate(x.resultAt ?? x.requestedAt)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
