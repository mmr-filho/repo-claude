'use client';

import { EXAMES_VIGILANCIA, exameVigilancia, RESULTADO_LABEL, RESULTADOS_DA_TECNICA, type ResultadoQualitativo } from '@omnisaude/shared';
import { BookMarked, ClipboardCheck, FlaskConical, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { AvisoNotificacoes } from '@/components/vigilancia/aviso';
import type { NotificacaoCriada } from '@/components/vigilancia/types';
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
  const candidates = [...(encounter.mainCid ? [{ system: 'CID10' as const, code: encounter.mainCid }] : []), ...lastCodes, ...conditionCodes].filter(
    (c, i, a) => a.findIndex((x) => x.code === c.code && x.system === c.system) === i,
  );
  const [code, setCode] = useState<CodeRef | null>(candidates[0] ?? null);
  const [pathway, setPathway] = useState<Pathway | null>(null);
  const [pathwayMsg, setPathwayMsg] = useState<string | null>(null);
  const [name, setName] = useState(prefill?.join(', ') ?? '');
  const [sigtap, setSigtap] = useState('');
  const [busy, setBusy] = useState(false);
  const canRequest = session.can('exame.solicitar');
  const canResult = session.can('prontuario.evoluir');
  const [resultado, setResultado] = useState<{ id: string; nome: string; examKey: string; qualitative: string; collectedAt: string; method: string; text: string } | null>(null);
  const [notificacoes, setNotificacoes] = useState<NotificacaoCriada[]>([]);
  const agoraLocal = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };

  async function registrarResultado() {
    if (!resultado) return;
    setBusy(true);
    try {
      const r = await api.post<{ notificacoes?: NotificacaoCriada[] }>(`/clinical/exams/${resultado.id}/result`, {
        ...(resultado.examKey ? { examKey: resultado.examKey } : {}),
        ...(resultado.qualitative ? { qualitative: resultado.qualitative } : {}),
        ...(resultado.collectedAt ? { collectedAt: new Date(resultado.collectedAt).toISOString() } : {}),
        ...(resultado.method.trim() ? { method: resultado.method.trim() } : {}),
        ...(resultado.text.trim() ? { text: resultado.text.trim() } : {}),
      });
      toast.success('Resultado registrado');
      if (r.notificacoes?.length) setNotificacoes((n) => [...n, ...r.notificacoes!]);
      setResultado(null);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const catSel = exameVigilancia(resultado?.examKey);

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
            <Select className="w-auto" value={code ? `${code.system}:${code.code}` : ''} onChange={(e) => setCode(parseStoredCode(e.target.value))} aria-label="Diagnóstico para o protocolo">
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

      <AvisoNotificacoes itens={notificacoes} onDismiss={() => setNotificacoes([])} />
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
              {canResult && <TH />}
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
                <TD>
                  {x.qualitative ? <Badge tone={x.qualitative === 'DETECTAVEL' || x.qualitative === 'REAGENTE' ? 'red' : 'slate'}>{RESULTADO_LABEL[x.qualitative as ResultadoQualitativo] ?? x.qualitative}</Badge> : null}{' '}
                  {x.resultValue !== null ? `${String(x.resultValue)} ${x.resultUnit ?? ''}` : (x.resultText ?? (x.qualitative ? '' : '—'))}
                </TD>
                <TD>{fmtDate(x.resultAt ?? x.requestedAt)}</TD>
                {canResult && (
                  <TD>
                    {x.status !== 'RESULTADO' && x.status !== 'CANCELADO' && (
                      <Button size="sm" variant="ghost" onClick={() => setResultado({ id: x.id, nome: x.name, examKey: '', qualitative: '', collectedAt: agoraLocal(), method: '', text: '' })}>
                        <ClipboardCheck className="h-4 w-4" /> Resultado
                      </Button>
                    )}
                  </TD>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <Dialog
        open={!!resultado}
        onOpenChange={(o) => !o && setResultado(null)}
        title={`Resultado: ${resultado?.nome ?? ''}`}
        description="Exame de vigilância com resultado positivo confirma ou abre a notificação compulsória; covid-19 e mpox vão também à RNDS (REL), qualquer resultado."
        footer={
          <Button loading={busy} id="exame-resultado-salvar" disabled={!resultado || (!!resultado.examKey && !resultado.qualitative) || (!resultado.examKey && !resultado.text.trim())} onClick={registrarResultado}>
            Registrar
          </Button>
        }
      >
        {resultado && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Exame de vigilância (opcional)" htmlFor="ex-vig" className="sm:col-span-2">
              <Select id="ex-vig" value={resultado.examKey} onChange={(e) => setResultado({ ...resultado, examKey: e.target.value, qualitative: '' })}>
                <option value="">— outro exame (resultado em texto) —</option>
                {EXAMES_VIGILANCIA.map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.nome}
                    {x.rel ? ' · RNDS' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            {catSel && (
              <>
                <Field label="Resultado" htmlFor="ex-resultado">
                  <Select id="ex-resultado" value={resultado.qualitative} onChange={(e) => setResultado({ ...resultado, qualitative: e.target.value })}>
                    <option value="">Escolha…</option>
                    {RESULTADOS_DA_TECNICA[catSel.tecnica].map((r) => (
                      <option key={r} value={r}>
                        {RESULTADO_LABEL[r]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Data e hora da coleta" htmlFor="ex-coleta">
                  <Input id="ex-coleta" type="datetime-local" max={agoraLocal()} value={resultado.collectedAt} onChange={(e) => setResultado({ ...resultado, collectedAt: e.target.value })} />
                </Field>
                <Field label="Método" htmlFor="ex-metodo" hint={catSel.tecnica === 'MOLECULAR' ? 'Ex.: RT-PCR' : 'Ex.: Imunocromatográfico'}>
                  <Input id="ex-metodo" value={resultado.method} onChange={(e) => setResultado({ ...resultado, method: e.target.value })} />
                </Field>
                <p className="text-xs text-slate-500 sm:col-span-2">Amostra: {catSel.amostra}.</p>
              </>
            )}
            <Field label={catSel ? 'Observações do laudo (opcional)' : 'Resultado'} htmlFor="ex-texto" className="sm:col-span-2">
              <Input id="ex-texto" value={resultado.text} onChange={(e) => setResultado({ ...resultado, text: e.target.value })} />
            </Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}
