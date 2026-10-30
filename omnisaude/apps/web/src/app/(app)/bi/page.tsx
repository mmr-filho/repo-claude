'use client';

import { Database, History, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, PageHeader } from '@/components/ui/card';
import { Textarea } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ResultView } from '@/components/bi/result-view';
import { EXAMPLE_QUESTIONS, PREPARED, type BiResult, type CatalogView, type Chart } from '@/components/bi/types';
import { api, ApiError, errorMessage, saveBlob } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';

interface HistoryRow {
  id: string;
  question: string;
  sql: string | null;
  rows: number | null;
  at: string;
}

interface Current {
  title: string;
  result: BiResult;
  chart?: Chart;
}

/**
 * BI conversacional: a pergunta vira SQL (só SELECT, validado por AST, sobre as views do schema bi)
 * executado na réplica de leitura. Ao modelo vão apenas a pergunta e o catálogo, nunca dados de pacientes.
 */
export default function BiPage() {
  const toast = useToast();
  const [question, setQuestion] = useState('');
  const [current, setCurrent] = useState<Current | null>(null);
  const [asking, setAsking] = useState(false);
  const [paging, setPaging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; errors?: string[] } | null>(null);
  const catalog = useApi<{ views: CatalogView[] }>('/bi/catalog');
  const history = useApi<HistoryRow[]>('/bi/history');

  async function ask(q: string) {
    if (q.trim().length < 5) return;
    setAsking(true);
    setError(null);
    setAiNotice(null);
    try {
      const r = await api.post<BiResult>('/bi/ask', { question: q.trim(), page: 0 });
      setCurrent({ title: q.trim(), result: r });
      void history.reload();
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'IA_DESATIVADA' || err.code === 'IA_INDISPONIVEL')) {
        setAiNotice(
          err.code === 'IA_DESATIVADA'
            ? 'O BI conversacional está desativado para esta instituição. Use as consultas prontas abaixo.'
            : 'O provedor de IA não está configurado neste ambiente. As consultas prontas abaixo continuam disponíveis.',
        );
      } else if (err instanceof ApiError && err.code === 'SQL_RECUSADO') {
        setError({ message: err.message, errors: (err.details as { errors?: string[] })?.errors });
      } else setError({ message: errorMessage(err) });
    } finally {
      setAsking(false);
    }
  }

  async function run(title: string, sql: string, chart?: Chart, page = 0) {
    setPaging(true);
    setError(null);
    try {
      const r = await api.post<BiResult>('/bi/run', { sql, page });
      setCurrent((c) => ({ title, chart: chart ?? c?.chart, result: { ...r, explanation: c?.title === title ? c.result.explanation : undefined, chart: chart ?? c?.result.chart } }));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SQL_RECUSADO') setError({ message: err.message, errors: (err.details as { errors?: string[] })?.errors });
      else setError({ message: errorMessage(err) });
    } finally {
      setPaging(false);
    }
  }

  async function exportCsv() {
    if (!current) return;
    setExporting(true);
    try {
      const f = await api.download('/bi/export', { method: 'POST', body: { sql: current.result.sql, format: 'csv' } });
      saveBlob(f.blob, f.fileName ?? 'consulta.csv');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <div className="no-print">
        <PageHeader title="BI conversacional" description="Pergunte em português. A consulta gerada é só de leitura, validada antes de rodar e executada na réplica analítica." />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          <Card className="no-print">
            <CardBody className="space-y-3">
              <Textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void ask(question);
                }}
                rows={3}
                placeholder="Ex.: Quantos pacientes diabéticos acima de 60 anos não tiveram consulta nos últimos 6 meses?"
                aria-label="Pergunta"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => ask(question)} loading={asking} disabled={question.trim().length < 5}>
                  <Sparkles className="h-4 w-4" /> Perguntar
                </Button>
                <span className="text-xs text-slate-500">Ctrl+Enter para enviar</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {EXAMPLE_QUESTIONS.map((q) => (
                  <button key={q} onClick={() => setQuestion(q)} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-left text-xs text-slate-700 hover:bg-slate-100">
                    {q.length > 90 ? `${q.slice(0, 90)}…` : q}
                  </button>
                ))}
              </div>
              {aiNotice && <Alert tone="warn">{aiNotice}</Alert>}
              {error && (
                <Alert tone="error" title={error.message}>
                  {error.errors && (
                    <ul className="list-disc pl-5">
                      {error.errors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  )}
                </Alert>
              )}
            </CardBody>
          </Card>
          {asking && <Spinner label="Gerando e validando a consulta…" />}
          {current && (
            <ResultView
              result={current.result}
              chart={current.chart}
              title={current.title}
              paging={paging}
              exporting={exporting}
              onExport={exportCsv}
              onPage={(page) => run(current.title, current.result.sql, current.chart, page)}
            />
          )}
          <Card className="no-print">
            <CardHeader title="Consultas prontas" description="Funcionam mesmo sem IA. Passam pelo mesmo validador de segurança." />
            <ul className="divide-y divide-slate-100">
              {PREPARED.map((p) => (
                <li key={p.title} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{p.title}</p>
                    <p className="text-xs text-slate-500">{p.description}</p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => run(p.title, p.sql, p.chart)} loading={paging && current?.title === p.title}>
                    Executar
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="no-print space-y-4">
          <Card>
            <CardHeader title="Histórico" />
            {history.loading ? (
              <Spinner />
            ) : (history.data ?? []).length === 0 ? (
              <p className="px-5 py-4 text-sm text-slate-500">Suas perguntas aparecem aqui.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {(history.data ?? []).map((h) => (
                  <li key={h.id}>
                    <button className="w-full px-4 py-2.5 text-left hover:bg-slate-50" disabled={!h.sql} onClick={() => h.sql && run(h.question, h.sql)}>
                      <span className="flex items-start gap-2 text-sm">
                        <History className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                        {h.question}
                      </span>
                      <span className="ml-5 text-xs text-slate-500">
                        {fmtDateTime(h.at)} · {h.rows ?? 0} linha(s)
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Dados disponíveis" description="Views do schema bi (sem CPF, telefone ou endereço)." />
            {catalog.loading ? (
              <Spinner />
            ) : (
              <ul className="divide-y divide-slate-100">
                {(catalog.data?.views ?? []).map((v) => (
                  <li key={v.name} className="px-4 py-2.5">
                    <details>
                      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                        <Database className="h-3.5 w-3.5 text-brand-600" /> {v.name.replace(/^bi\./, '')}
                      </summary>
                      <p className="mt-1 text-xs text-slate-600">{v.description}</p>
                      <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
                        {v.columns.map((c) => (
                          <li key={c.name}>
                            <span className="font-mono text-slate-700">{c.name}</span> {c.description ? `— ${c.description}` : ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
