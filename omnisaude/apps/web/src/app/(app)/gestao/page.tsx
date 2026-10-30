'use client';

import { FileText, Printer, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { Markdown } from '@/components/management/markdown';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Metrics {
  encountersClosed: number;
  referrals: number;
  signedNotes: number;
  prescriptions: number;
  triages: number;
  avgDurationMin: number | null;
}

interface Productivity {
  period: { from: string; to: string };
  professionals: (Metrics & { userId: string; name: string | null; category: string; categoryLabel: string })[];
  categories: (Metrics & { category: string; label: string })[];
  units: (Metrics & { unitId: string; unit: string | null; unitType: string | null })[];
}

interface Sla {
  generatedAt: string;
  total: number;
  items: { key: string; label: string; severity: 'ALTA' | 'MEDIA' | 'BAIXA'; count: number; records: Record<string, unknown>[] }[];
}

interface AgendaSummary {
  id: string;
  periodStart: string;
  periodEnd: string;
  scope: string;
  createdAt: string;
}

const SEVERITY = { ALTA: 'red', MEDIA: 'amber', BAIXA: 'blue' } as const;
const COLORS = { encountersClosed: '#1567ed', signedNotes: '#0d9488', prescriptions: '#7c3aed', triages: '#ea580c', referrals: '#64748b' };

export default function ManagementPage() {
  const session = useSession();
  const [tab, setTab] = useState('produtividade');
  const tabs = [
    { value: 'produtividade', label: 'Produtividade', show: session.can('gestao.paineis') },
    { value: 'sla', label: 'SLAs e não conformidades', show: session.can('gestao.paineis') },
    { value: 'pautas', label: 'Pautas de reunião', show: session.can('gestao.pautas') },
  ].filter((t) => t.show);
  return (
    <>
      <div className="no-print">
        <PageHeader title="Gestão" description="Produção em tempo real por profissional, categoria e unidade; não conformidades; e pautas para o colegiado gestor." />
      </div>
      <Tabs value={tab} onValueChange={setTab} tabs={tabs}>
        <TabPanel value="produtividade">
          <ProductivityTab />
        </TabPanel>
        <TabPanel value="sla">
          <SlaTab />
        </TabPanel>
        <TabPanel value="pautas">
          <AgendasTab />
        </TabPanel>
      </Tabs>
    </>
  );
}

function ProductivityTab() {
  const [from, setFrom] = useState(todayIso(-30));
  const [to, setTo] = useState(todayIso());
  const [unitId, setUnitId] = useState('');
  const [query, setQuery] = useState({ from, to, unitId });
  const directory = useApi<{ units: { id: string; name: string }[] }>('/directory');
  const qs = new URLSearchParams({ from: query.from, to: query.to, ...(query.unitId ? { unitId: query.unitId } : {}) });
  const data = useApi<Productivity>(`/management/productivity?${qs}`, [query]);
  const d = data.data;
  const sum = (k: keyof Metrics) => (d?.units ?? []).reduce((s, u) => s + (Number(u[k]) || 0), 0);
  const top = (d?.professionals ?? []).slice(0, 12).map((p) => ({ ...p, short: (p.name ?? '—').split(' ').slice(0, 2).join(' ') }));

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="De">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Até">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Unidade">
            <Select value={unitId} onChange={(e) => setUnitId(e.target.value)} className="w-56">
              <option value="">Toda a rede</option>
              {(directory.data?.units ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button onClick={() => setQuery({ from, to, unitId })}>
            <RefreshCw className="h-4 w-4" /> Atualizar
          </Button>
        </CardBody>
      </Card>
      {data.loading ? (
        <Spinner />
      ) : data.error ? (
        <Alert tone="error">{data.error}</Alert>
      ) : d ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Atendimentos concluídos" value={sum('encountersClosed')} />
            <Stat label="Registros assinados" value={sum('signedNotes')} />
            <Stat label="Prescrições" value={sum('prescriptions')} />
            <Stat label="Classificações de risco" value={sum('triages')} />
            <Stat label="Encaminhamentos" value={sum('referrals')} />
          </div>
          <Card>
            <CardHeader title="Por profissional" description={`${fmtDate(d.period.from)} a ${fmtDate(d.period.to)}`} />
            <CardBody>
              {top.length === 0 ? (
                <EmptyState title="Sem produção no período" />
              ) : (
                <div className="h-80" role="img" aria-label="Gráfico de produção por profissional">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={top} margin={{ left: 0, right: 8, top: 8, bottom: 40 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="short" angle={-30} textAnchor="end" interval={0} height={60} tick={{ fontSize: 11 }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="encountersClosed" name="Atendimentos" fill={COLORS.encountersClosed} />
                      <Bar dataKey="signedNotes" name="Registros" fill={COLORS.signedNotes} />
                      <Bar dataKey="prescriptions" name="Prescrições" fill={COLORS.prescriptions} />
                      <Bar dataKey="triages" name="Triagens" fill={COLORS.triages} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardBody>
            <MetricsTable rows={d.professionals.map((p) => ({ ...p, key: p.userId, name: p.name ?? '—', sub: p.categoryLabel }))} />
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Por categoria profissional" />
              <MetricsTable rows={d.categories.map((c) => ({ ...c, key: c.category, name: c.label }))} />
            </Card>
            <Card>
              <CardHeader title="Por unidade" />
              <MetricsTable rows={d.units.map((u) => ({ ...u, key: u.unitId, name: u.unit ?? '—', sub: u.unitType ?? undefined }))} />
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

function MetricsTable({ rows }: { rows: (Metrics & { key: string; name: string; sub?: string })[] }) {
  if (rows.length === 0) return <EmptyState title="Sem dados" />;
  return (
    <Table>
      <THead>
        <tr>
          <TH>Nome</TH>
          <TH className="text-right">Atend.</TH>
          <TH className="text-right">Tempo médio</TH>
          <TH className="text-right">Registros</TH>
          <TH className="text-right">Prescr.</TH>
          <TH className="text-right">Triagens</TH>
          <TH className="text-right">Encam.</TH>
        </tr>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.key}>
            <TD>
              {r.name}
              {r.sub && <span className="block text-xs text-slate-500">{r.sub}</span>}
            </TD>
            <TD className="text-right tabular-nums">{r.encountersClosed}</TD>
            <TD className="text-right tabular-nums">{r.avgDurationMin === null ? '—' : `${r.avgDurationMin.toLocaleString('pt-BR')} min`}</TD>
            <TD className="text-right tabular-nums">{r.signedNotes}</TD>
            <TD className="text-right tabular-nums">{r.prescriptions}</TD>
            <TD className="text-right tabular-nums">{r.triages}</TD>
            <TD className="text-right tabular-nums">{r.referrals}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function SlaTab() {
  const sla = useApi<Sla>('/management/sla');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader
        title="Não conformidades e SLAs"
        description={sla.data ? `Atualizado em ${fmtDateTime(sla.data.generatedAt)} · ${sla.data.total} ocorrência(s)` : undefined}
        actions={
          <Button variant="secondary" onClick={() => void sla.reload()}>
            <RefreshCw className="h-4 w-4" /> Atualizar
          </Button>
        }
      />
      {sla.loading ? (
        <Spinner />
      ) : sla.error ? (
        <CardBody>
          <Alert tone="error">{sla.error}</Alert>
        </CardBody>
      ) : (
        <ul className="divide-y divide-slate-100">
          {(sla.data?.items ?? []).map((i) => (
            <li key={i.key} className="px-5 py-3">
              <button className="flex w-full items-center gap-3 text-left" onClick={() => setOpen(open === i.key ? null : i.key)} aria-expanded={open === i.key} disabled={i.count === 0}>
                <Badge tone={SEVERITY[i.severity]}>{i.severity}</Badge>
                <span className="flex-1 text-sm font-medium">{i.label}</span>
                <span className={`text-lg font-semibold tabular-nums ${i.count ? 'text-slate-900' : 'text-slate-400'}`}>{i.count}</span>
              </button>
              {open === i.key && i.records.length > 0 && <RecordsTable records={i.records} />}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecordsTable({ records }: { records: Record<string, unknown>[] }) {
  const cols = Object.keys(records[0] ?? {}).filter((k) => !/id$/i.test(k));
  const show = (v: unknown) => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtDateTime(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  return (
    <div className="mt-3 rounded-lg border border-slate-100">
      <Table>
        <THead>
          <tr>
            {cols.map((c) => (
              <TH key={c}>{c}</TH>
            ))}
          </tr>
        </THead>
        <TBody>
          {records.slice(0, 50).map((r, i) => (
            <TR key={i}>
              {cols.map((c) => (
                <TD key={c} className="text-xs">
                  {show(r[c])}
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function AgendasTab() {
  const toast = useToast();
  const [from, setFrom] = useState(todayIso(-30));
  const [to, setTo] = useState(todayIso());
  const [current, setCurrent] = useState<{ id: string; markdown: string; createdAt: string } | null>(null);
  const [pending, setPending] = useState(false);
  const list = useApi<AgendaSummary[]>('/management/agendas');

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <div className="no-print space-y-4">
        <Card>
          <CardHeader title="Gerar pauta" description="Compila gargalos de leitos, filas, faltas, exames, risco, glosas, estoque e SLAs." />
          <CardBody className="space-y-3">
            <Field label="De">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Até">
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Button
              className="w-full"
              loading={pending}
              onClick={async () => {
                setPending(true);
                try {
                  const r = await api.post<{ id: string; markdown: string; createdAt: string }>('/management/agendas', { from, to });
                  setCurrent(r);
                  void list.reload();
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setPending(false);
                }
              }}
            >
              <FileText className="h-4 w-4" /> Gerar pauta
            </Button>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Pautas anteriores" />
          {list.loading ? (
            <Spinner />
          ) : (list.data ?? []).length === 0 ? (
            <EmptyState title="Nenhuma pauta" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {(list.data ?? []).map((a) => (
                <li key={a.id}>
                  <button
                    className="w-full px-4 py-2.5 text-left text-sm hover:bg-slate-50"
                    onClick={async () => {
                      try {
                        setCurrent(await api.get<{ id: string; markdown: string; createdAt: string }>(`/management/agendas/${a.id}`));
                      } catch (err) {
                        toast.error(errorMessage(err));
                      }
                    }}
                  >
                    <span className="block font-medium">
                      {fmtDate(a.periodStart)} a {fmtDate(a.periodEnd)}
                    </span>
                    <span className="text-xs text-slate-500">
                      {a.scope} · gerada {fmtDateTime(a.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card>
        {current ? (
          <>
            <CardHeader
              className="no-print"
              title="Pauta"
              description={`Gerada em ${fmtDateTime(current.createdAt)}`}
              actions={
                <Button variant="secondary" onClick={() => window.print()}>
                  <Printer className="h-4 w-4" /> Imprimir
                </Button>
              }
            />
            <CardBody>
              <Markdown source={current.markdown} />
            </CardBody>
          </>
        ) : (
          <EmptyState icon={<FileText className="h-8 w-8" />} title="Gere ou abra uma pauta" description="O conteúdo é calculado a partir dos dados da rede, sem IA." />
        )}
      </Card>
    </div>
  );
}
