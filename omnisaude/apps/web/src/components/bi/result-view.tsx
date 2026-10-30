'use client';

import { ChevronDown, ChevronLeft, ChevronRight, Download, Printer } from 'lucide-react';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { fmtDate, fmtDateTime } from '@/lib/format';
import type { BiResult, Chart } from './types';

const PALETTE = ['#1567ed', '#0d9488', '#ea580c', '#7c3aed', '#eab308', '#dc2626', '#16a34a', '#64748b'];
const RISK: Record<string, string> = { VERMELHO: '#dc2626', LARANJA: '#ea580c', AMARELO: '#eab308', VERDE: '#16a34a', AZUL: '#2563eb' };

function cell(value: unknown, type: string) {
  if (value === null || value === undefined) return '—';
  if (type === 'boolean') return value ? 'Sim' : 'Não';
  if (type === 'date') return fmtDate(String(value));
  if (type === 'datetime') return fmtDateTime(String(value));
  if (type === 'number') return Number(value).toLocaleString('pt-BR');
  return String(value);
}

/** Escolhe eixo X (texto/data) e Y (número) quando a sugestão do modelo não indica. */
function resolveChart(result: BiResult, chart?: Chart): Chart | null {
  if (!chart || chart.type === 'table' || result.rows.length === 0) return null;
  const x = chart.x && result.columns.some((c) => c.name === chart.x) ? chart.x : result.columns.find((c) => c.type !== 'number')?.name;
  const y = chart.y && result.columns.some((c) => c.name === chart.y) ? chart.y : result.columns.find((c) => c.type === 'number')?.name;
  return x && y ? { type: chart.type, x, y } : null;
}

export function ResultView({
  result,
  chart,
  title,
  onPage,
  onExport,
  paging,
  exporting,
}: {
  result: BiResult;
  chart?: Chart;
  title: string;
  onPage: (page: number) => void;
  onExport: () => void;
  paging: boolean;
  exporting: boolean;
}) {
  const [showSql, setShowSql] = useState(false);
  const c = resolveChart(result, chart ?? result.chart);
  const xType = c ? result.columns.find((col) => col.name === c.x)?.type : undefined;
  const data = c
    ? result.rows.map((r) => ({ ...r, [c.x!]: xType === 'date' ? fmtDate(String(r[c.x!])) : r[c.x!], [c.y!]: Number(r[c.y!]) }))
    : [];

  return (
    <Card className="bi-print">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .bi-print, .bi-print * { visibility: visible; }
          .bi-print { position: absolute; left: 0; top: 0; width: 100%; border: none; box-shadow: none; }
        }
      `}</style>
      <CardHeader
        title={title}
        description={result.explanation}
        actions={
          <span className="no-print flex gap-2">
            <Button variant="secondary" size="sm" onClick={onExport} loading={exporting}>
              <Download className="h-4 w-4" /> CSV
            </Button>
            <Button variant="secondary" size="sm" onClick={() => window.print()}>
              <Printer className="h-4 w-4" /> PDF
            </Button>
          </span>
        }
      />
      {c && (
        <CardBody className="border-b border-slate-100">
          <div className="h-72" role="img" aria-label={`Gráfico de ${c.y} por ${c.x}`}>
            <ResponsiveContainer width="100%" height="100%">
              {c.type === 'pie' ? (
                <PieChart>
                  <Pie data={data} dataKey={c.y!} nameKey={c.x!} outerRadius={100} label>
                    {data.map((d, i) => (
                      <Cell key={i} fill={RISK[String(d[c.x!])] ?? PALETTE[i % PALETTE.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              ) : c.type === 'line' ? (
                <LineChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey={c.x} tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey={c.y!} stroke={PALETTE[0]} strokeWidth={2} />
                </LineChart>
              ) : (
                <BarChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey={c.x} tick={{ fontSize: 11 }} interval={0} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey={c.y!} fill={PALETTE[0]} />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </CardBody>
      )}
      {result.rows.length === 0 ? (
        <EmptyState title="A consulta não retornou linhas" />
      ) : (
        <Table>
          <THead>
            <tr>
              {result.columns.map((col) => (
                <TH key={col.name} className={col.type === 'number' ? 'text-right' : undefined}>
                  {col.name.replaceAll('_', ' ')}
                </TH>
              ))}
            </tr>
          </THead>
          <TBody>
            {result.rows.map((r, i) => (
              <TR key={i}>
                {result.columns.map((col) => (
                  <TD key={col.name} className={col.type === 'number' ? 'text-right tabular-nums' : undefined}>
                    {cell(r[col.name], col.type)}
                  </TD>
                ))}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <div className="no-print flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-5 py-3 text-sm">
        <span className="text-slate-600">
          Página {result.page + 1} · {result.rows.length} linha(s)
          {result.model ? ` · gerado por ${result.model}` : ''}
        </span>
        <span className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={result.page === 0 || paging} onClick={() => onPage(result.page - 1)} aria-label="Página anterior">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="secondary" disabled={!result.hasMore || paging} onClick={() => onPage(result.page + 1)} aria-label="Próxima página">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </span>
      </div>
      <div className="no-print border-t border-slate-100 px-5 py-3">
        <button className="flex items-center gap-1 text-sm font-medium text-slate-700" onClick={() => setShowSql((s) => !s)} aria-expanded={showSql}>
          <ChevronDown className={`h-4 w-4 transition-transform ${showSql ? 'rotate-180' : ''}`} /> SQL validado (somente leitura, schema bi)
        </button>
        {showSql && <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{result.sql}</pre>}
      </div>
    </Card>
  );
}
