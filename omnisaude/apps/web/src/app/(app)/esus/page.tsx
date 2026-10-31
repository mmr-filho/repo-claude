'use client';

import { Download, FileOutput, RefreshCw, RotateCcw, Send } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, saveBlob } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Status {
  pec: { configured: boolean; url: string | null; usuario: string | null; simulado: boolean };
  ledi: string;
  batches: number;
  records: Record<string, number>;
}
interface Unit {
  id: string;
  name: string;
  cnes: string;
  type: string;
}
interface BatchRow {
  id: string;
  number: number;
  unit: { name: string; cnes: string };
  createdBy: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  createdAt: string;
  sentAt: string | null;
  lastError: string | null;
  counts: Record<string, number>;
}
interface Issue {
  path: string;
  message: string;
}
interface RecordRow {
  id: string;
  kind: number;
  label: string;
  uuid: string;
  sourceType: string;
  status: string;
  issues: Issue[];
  summary: Record<string, unknown>;
  sentAt: string | null;
  ine: string | null;
}
interface BatchDetail extends BatchRow {
  byKind: { kind: number; label: string; counts: Record<string, number> }[];
  records: RecordRow[];
}

const STATUS_LABEL: Record<string, string> = { GERADO: 'gerado', ENVIANDO: 'enviando', ENVIADO: 'enviado', PARCIAL: 'parcial', ERRO: 'erro' };
const STATUS_TONE: Record<string, 'slate' | 'blue' | 'green' | 'amber' | 'red'> = { GERADO: 'slate', ENVIANDO: 'blue', ENVIADO: 'green', PARCIAL: 'amber', ERRO: 'red' };
const RECORD_LABEL: Record<string, string> = { GERADA: 'gerada', INVALIDA: 'inválida', ENVIADA: 'enviada', ACEITA: 'aceita', REJEITADA: 'recusada' };
const RECORD_TONE: Record<string, 'slate' | 'blue' | 'green' | 'amber' | 'red'> = { GERADA: 'slate', INVALIDA: 'red', ENVIADA: 'blue', ACEITA: 'green', REJEITADA: 'amber' };

function summaryText(r: RecordRow): string {
  const s = r.summary;
  const parts = [
    s.profissional,
    s.cidadao,
    s.domicilio,
    s.dia ? `dia ${fmtDate(String(s.dia))}` : null,
    s.atendimentos ? `${s.atendimentos} atendimento(s)` : null,
    s.familias !== undefined ? `${s.familias} família(s)` : null,
    s.atualizacao ? 'atualização' : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 7)}-01`;

export default function EsusPage() {
  const toast = useToast();
  const session = useSession();
  const status = useApi<Status>('/esus/status');
  const units = useApi<Unit[]>('/esus/units');
  const batches = useApi<BatchRow[]>('/esus/batches');
  const [unitId, setUnitId] = useState('');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useApi<BatchDetail>(selected ? `/esus/batches/${selected}` : null, [selected]);
  const [filter, setFilter] = useState('');
  const chosenUnit = unitId || units.data?.find((u) => u.id === session.me?.context.unitId)?.id || units.data?.find((u) => u.type === 'UBS')?.id || '';

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const generate = () =>
    run('gerar', async () => {
      const b = await api.post<BatchDetail>('/esus/batches', { unitId: chosenUnit, from, to });
      toast.success(`Lote ${b.number} gerado: ${b.records.length} ficha(s)${b.counts.INVALIDA ? `, ${b.counts.INVALIDA} inválida(s)` : ''}`);
      setSelected(b.id);
      void batches.reload();
      void status.reload();
    });
  const download = (b: BatchRow) =>
    run(`zip-${b.id}`, async () => {
      const f = await api.download(`/esus/batches/${b.id}/zip`);
      saveBlob(f.blob, f.fileName ?? `esus-lote-${b.number}.zip`);
    });
  const send = (b: BatchRow) =>
    run(`send-${b.id}`, async () => {
      const r = await api.post<{ sent: number; accepted: number; rejected: number; error: string | null; status: string }>(`/esus/batches/${b.id}/send`);
      if (r.error) toast.error(`Envio interrompido: ${r.error}`);
      else toast.success(`${r.accepted} ficha(s) aceita(s) pelo PEC${r.rejected ? `, ${r.rejected} recusada(s)` : ''}`);
      void batches.reload();
      void status.reload();
      if (selected === b.id) void detail.reload();
    });
  const reprocess = (b: BatchRow) =>
    run(`rep-${b.id}`, async () => {
      const r = await api.post<{ regenerated: number; stillInvalid: number }>(`/esus/batches/${b.id}/reprocess`);
      toast.success(`${r.regenerated} ficha(s) regerada(s)${r.stillInvalid ? `, ${r.stillInvalid} continua(m) inválida(s)` : ''}`);
      void batches.reload();
      if (selected === b.id) void detail.reload();
    });

  const s = status.data;
  const records = (detail.data?.records ?? []).filter((r) => !filter || r.status === filter);
  return (
    <>
      <PageHeader
        title="e-SUS APS"
        description="Fichas do e-SUS APS (LEDI 8.7.0, Thrift) geradas dos registros da unidade: cadastro individual e domiciliar, atendimento individual e odontológico, procedimentos e vacinação. Envio pela API do PEC ou arquivo .zip para importação."
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              void status.reload();
              void batches.reload();
            }}
          >
            <RefreshCw className="h-4 w-4" /> Atualizar
          </Button>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Lotes" value={s?.batches ?? '—'} />
        <Stat label="Fichas geradas" value={s?.records.GERADA ?? 0} />
        <Stat label="Aceitas pelo PEC" value={s?.records.ACEITA ?? 0} tone="good" />
        <Stat label="Recusadas" value={s?.records.REJEITADA ?? 0} tone={(s?.records.REJEITADA ?? 0) > 0 ? 'bad' : 'default'} />
        <Stat label="Inválidas" value={s?.records.INVALIDA ?? 0} tone={(s?.records.INVALIDA ?? 0) > 0 ? 'warn' : 'default'} />
      </div>
      <Card className="mb-4">
        <CardHeader
          title="Gerar lote"
          description={
            s?.pec.configured
              ? `PEC: ${s.pec.url}${s.pec.simulado ? ' (simulador local)' : ''} · credencial ${s.pec.usuario}`
              : 'PEC não configurado: informe PEC_URL, PEC_USUARIO e PEC_SENHA (credencial criada no PEC em Integração > Credenciais de integração). Sem o PEC, baixe o .zip e importe manualmente.'
          }
        />
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Unidade" htmlFor="esus-unit">
            <Select id="esus-unit" value={chosenUnit} onChange={(e) => setUnitId(e.target.value)} className="w-64">
              {(units.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} · CNES {u.cnes}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="De" htmlFor="esus-from">
            <Input id="esus-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Até" htmlFor="esus-to">
            <Input id="esus-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          {session.can('esus.gerir') && (
            <Button onClick={generate} loading={busy === 'gerar'} disabled={!chosenUnit}>
              <FileOutput className="h-4 w-4" /> Gerar lote
            </Button>
          )}
        </CardBody>
      </Card>
      <Card className="mb-4">
        <CardHeader title="Lotes" description="Cada lote reúne as fichas da unidade no período. Fichas inválidas não entram no .zip nem no envio; corrija o registro e reprocesse." />
        {batches.loading && !batches.data ? (
          <Spinner />
        ) : batches.error ? (
          <CardBody>
            <Alert tone="error">{batches.error}</Alert>
          </CardBody>
        ) : !(batches.data ?? []).length ? (
          <EmptyState icon={<FileOutput className="h-8 w-8" />} title="Nenhum lote gerado" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Lote</TH>
                <TH>Unidade</TH>
                <TH>Período</TH>
                <TH>Fichas</TH>
                <TH>Situação</TH>
                <TH>Gerado</TH>
                <TH />
              </tr>
            </THead>
            <TBody>
              {(batches.data ?? []).map((b) => (
                <TR key={b.id} className={selected === b.id ? 'bg-brand-50' : undefined}>
                  <TD>
                    <button type="button" className="font-medium text-brand-700 underline" onClick={() => setSelected(b.id)}>
                      #{b.number}
                    </button>
                  </TD>
                  <TD>
                    {b.unit.name}
                    <span className="block text-xs text-slate-500">CNES {b.unit.cnes}</span>
                  </TD>
                  <TD className="whitespace-nowrap">
                    {fmtDate(b.periodStart)} a {fmtDate(b.periodEnd)}
                  </TD>
                  <TD className="text-xs">
                    {Object.entries(b.counts).map(([k, n]) => (
                      <Badge key={k} tone={RECORD_TONE[k] ?? 'slate'} className="mr-1">
                        {n} {RECORD_LABEL[k] ?? k.toLowerCase()}
                      </Badge>
                    ))}
                  </TD>
                  <TD>
                    <Badge tone={STATUS_TONE[b.status] ?? 'slate'}>{STATUS_LABEL[b.status] ?? b.status}</Badge>
                    {b.lastError && <span className="block max-w-xs truncate text-xs text-red-700">{b.lastError}</span>}
                  </TD>
                  <TD className="whitespace-nowrap text-xs">
                    {fmtDateTime(b.createdAt)}
                    <span className="block text-slate-500">{b.createdBy}</span>
                  </TD>
                  <TD className="whitespace-nowrap text-right">
                    <Button size="sm" variant="ghost" onClick={() => download(b)} loading={busy === `zip-${b.id}`} disabled={!((b.counts.GERADA ?? 0) + (b.counts.ACEITA ?? 0) + (b.counts.REJEITADA ?? 0))}>
                      <Download className="h-4 w-4" /> .zip
                    </Button>
                    {session.can('esus.gerir') && (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => send(b)} loading={busy === `send-${b.id}`} disabled={!s?.pec.configured || !((b.counts.GERADA ?? 0) + (b.counts.REJEITADA ?? 0))}>
                          <Send className="h-4 w-4" /> Enviar ao PEC
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => reprocess(b)} loading={busy === `rep-${b.id}`} disabled={!((b.counts.INVALIDA ?? 0) + (b.counts.REJEITADA ?? 0))}>
                          <RotateCcw className="h-4 w-4" /> Reprocessar
                        </Button>
                      </>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {selected && (
        <Card>
          <CardHeader
            title={detail.data ? `Lote #${detail.data.number} · ${detail.data.unit.name}` : 'Lote'}
            description={
              detail.data
                ? detail.data.byKind
                    .map(
                      (k) =>
                        `${k.label}: ${Object.entries(k.counts)
                          .map(([st, n]) => `${n} ${RECORD_LABEL[st] ?? st}`)
                          .join(', ')}`,
                    )
                    .join(' · ')
                : undefined
            }
            actions={
              <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-44">
                <option value="">Todas as fichas</option>
                {Object.entries(RECORD_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            }
          />
          {detail.loading && !detail.data ? (
            <Spinner />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Ficha</TH>
                  <TH>Resumo</TH>
                  <TH>Situação</TH>
                  <TH>Inconsistências / resposta do PEC</TH>
                </tr>
              </THead>
              <TBody>
                {records.map((r) => (
                  <TR key={r.id}>
                    <TD>
                      {r.label}
                      <span className="block font-mono text-[11px] text-slate-500">{r.uuid.slice(8, 16)}…</span>
                    </TD>
                    <TD className="text-xs">{summaryText(r)}</TD>
                    <TD>
                      <Badge tone={RECORD_TONE[r.status] ?? 'slate'}>{RECORD_LABEL[r.status] ?? r.status}</Badge>
                      {r.sentAt && <span className="block text-xs text-slate-500">{fmtDateTime(r.sentAt)}</span>}
                    </TD>
                    <TD className="text-xs">
                      {r.issues.length ? (
                        <ul className="list-inside list-disc">
                          {r.issues.slice(0, 6).map((i, n) => (
                            <li key={n}>
                              <span className="font-mono text-slate-500">{i.path}</span> {i.message}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        '—'
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
