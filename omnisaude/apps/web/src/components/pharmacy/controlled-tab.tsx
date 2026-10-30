'use client';

import { Printer } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

interface Report {
  from: string;
  to: string;
  products: {
    productId: string;
    product: string;
    list: string;
    entries: number;
    exits: number;
    balance: number;
    movements: { at: string; kind: string; lot: string; quantity: number }[];
  }[];
}

const KIND: Record<string, string> = {
  ENTRADA_NFE: 'Entrada (NF-e)',
  TRANSFERENCIA_SAIDA: 'Transferência (saída)',
  TRANSFERENCIA_ENTRADA: 'Transferência (entrada)',
  DISPENSACAO: 'Dispensação',
  ADMINISTRACAO: 'Administração',
  DEVOLUCAO: 'Devolução',
  UNITARIZACAO_SAIDA: 'Unitarização (saída)',
  UNITARIZACAO_ENTRADA: 'Unitarização (entrada)',
  AJUSTE: 'Ajuste',
  PERDA: 'Perda',
};

/** Escrituração de medicamentos sujeitos a controle especial (Portaria SVS/MS 344/98) para a vigilância sanitária. */
export function ControlledTab() {
  const { me } = useSession();
  const [from, setFrom] = useState(todayIso(-30));
  const [to, setTo] = useState(todayIso());
  const [query, setQuery] = useState({ from, to });
  const report = useApi<Report>(`/pharmacy/controlled-report?from=${query.from}&to=${query.to}`, [query]);

  return (
    <div className="space-y-4">
      <Card className="no-print">
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="De">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Até">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button onClick={() => setQuery({ from, to })}>Gerar relatório</Button>
          <Button variant="secondary" onClick={() => window.print()}>
            <Printer className="h-4 w-4" /> Imprimir
          </Button>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Movimentação de medicamentos controlados (Portaria 344/98)"
          description={`${me?.context.unitName ?? ''} · ${fmtDate(query.from)} a ${fmtDate(query.to)}`}
        />
        {report.loading ? (
          <Spinner />
        ) : report.error ? (
          <CardBody>
            <Alert tone="error">{report.error}</Alert>
          </CardBody>
        ) : (report.data?.products ?? []).length === 0 ? (
          <EmptyState title="Sem movimentação de controlados no período" />
        ) : (
          <div className="divide-y divide-slate-100">
            {(report.data?.products ?? []).map((p) => (
              <section key={p.productId} className="break-inside-avoid px-5 py-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">{p.product}</h3>
                  <Badge tone="amber">Lista {p.list}</Badge>
                  <span className="ml-auto text-sm tabular-nums text-slate-600">
                    Entradas {p.entries.toLocaleString('pt-BR')} · Saídas {p.exits.toLocaleString('pt-BR')} · Saldo atual <strong>{p.balance.toLocaleString('pt-BR')}</strong>
                  </span>
                </div>
                <Table>
                  <THead>
                    <tr>
                      <TH>Data</TH>
                      <TH>Movimento</TH>
                      <TH>Lote</TH>
                      <TH className="text-right">Quantidade</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {p.movements.map((m, i) => (
                      <TR key={i}>
                        <TD>{fmtDateTime(m.at)}</TD>
                        <TD>{KIND[m.kind] ?? m.kind}</TD>
                        <TD className="font-mono text-xs">{m.lot}</TD>
                        <TD className={`text-right tabular-nums ${m.quantity < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{m.quantity.toLocaleString('pt-BR')}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </section>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
