'use client';

import { STATUS_TFD, type StatusTfd } from '@omnisaude/shared';
import { Plane, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { TfdDetailDialog } from '@/components/tfd/detail-dialog';
import { LaudoDialog } from '@/components/tfd/laudo-dialog';
import { STATUS_TFD_TONE, type Processo, type ProcessoDetalhe } from '@/components/tfd/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';

interface Painel {
  porStatus: Record<StatusTfd, number>;
  abertos: number;
  ajudaCustoAno: number;
}

/** Tratamento Fora do Domicílio: processos com laudo, envio, parecer, agendamento, ajuda de custo e transporte. */
export default function TfdPage() {
  const session = useSession();
  const gere = session.can('tfd.gerir');
  const [status, setStatus] = useState<StatusTfd | ''>('');
  const [novo, setNovo] = useState(false);
  const [editando, setEditando] = useState<Processo | null>(null);
  const [detalhe, setDetalhe] = useState<string | null>(null);
  const painel = useApi<Painel>('/tfd/painel');
  const lista = useApi<Processo[]>(`/tfd/processos${status ? `?status=${status}` : ''}`, [status]);
  const recarregar = () => {
    void lista.reload();
    void painel.reload();
  };
  useRealtime('tfd.atualizado', recarregar);
  const p = painel.data;

  return (
    <>
      <PageHeader
        title="Tratamento Fora do Domicílio (TFD)"
        description="Laudo, processo, parecer da regional, agendamento no destino, ajuda de custo, transporte e impressão."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={recarregar}>
              <RefreshCw className="h-4 w-4" /> Atualizar
            </Button>
            {gere && (
              <Button onClick={() => setNovo(true)} id="tfd-novo">
                <Plus className="h-4 w-4" /> Novo processo
              </Button>
            )}
          </div>
        }
      />
      {p && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Em andamento" value={p.abertos} />
          <Stat label="Aguardando parecer" value={p.porStatus.ENVIADO} tone={p.porStatus.ENVIADO ? 'warn' : 'default'} />
          <Stat label="Deferidos" value={p.porStatus.DEFERIDO + p.porStatus.AGENDADO} tone="good" />
          <Stat label="Indeferidos" value={p.porStatus.INDEFERIDO} />
          <Stat label="Concluídos" value={p.porStatus.CONCLUIDO} />
          <Stat label="Ajuda de custo (12 meses)" value={fmtMoney(p.ajudaCustoAno)} />
        </div>
      )}
      <Card>
        <CardHeader
          title="Processos"
          description={gere ? 'Todos os processos da rede.' : 'Processos abertos pela sua unidade.'}
          actions={
            <Select value={status} onChange={(e) => setStatus(e.target.value as StatusTfd | '')} aria-label="Situação" className="w-56">
              <option value="">Todas as situações</option>
              {(Object.keys(STATUS_TFD) as StatusTfd[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_TFD[s]}
                </option>
              ))}
            </Select>
          }
        />
        <CardBody className="p-0">
          {lista.error && (
            <Alert tone="error" className="m-4">
              {lista.error}
            </Alert>
          )}
          {lista.loading && !lista.data && <Spinner />}
          {lista.data && lista.data.length === 0 && <EmptyState title="Nenhum processo" description="Abra um processo a partir do laudo médico." icon={<Plane className="h-8 w-8" />} />}
          {lista.data && lista.data.length > 0 && (
            <Table>
              <THead>
                <TR>
                  <TH>Processo</TH>
                  <TH>Pessoa</TH>
                  <TH>Procedimento / destino</TH>
                  <TH>Situação</TH>
                  <TH>Atendimento</TH>
                  <TH>Ajuda de custo</TH>
                  <TH>Aberto em</TH>
                </TR>
              </THead>
              <TBody>
                {lista.data.map((x) => (
                  <TR key={x.id} className="cursor-pointer" onClick={() => setDetalhe(x.id)}>
                    <TD className="font-mono text-xs">{x.protocol}</TD>
                    <TD>
                      {x.patient.name}
                      {x.companion && <span className="block text-xs text-slate-500">com acompanhante</span>}
                    </TD>
                    <TD>
                      {x.procedureName}
                      <span className="block text-xs text-slate-500">
                        {x.destination.city}/{x.destination.uf}
                        {x.destination.unit ? ` · ${x.destination.unit}` : ''}
                      </span>
                    </TD>
                    <TD>
                      <Badge tone={STATUS_TFD_TONE[x.status]}>{x.statusLabel}</Badge>
                      {x.urgency && (
                        <Badge tone="red" className="ml-1">
                          urgência
                        </Badge>
                      )}
                    </TD>
                    <TD className="text-xs">{x.appointment ? fmtDateTime(x.appointment.at) : '—'}</TD>
                    <TD className="text-xs">{x.allowance.total > 0 ? `${fmtMoney(x.allowance.total)}${x.allowance.paidAt ? ' · paga' : ''}` : '—'}</TD>
                    <TD className="whitespace-nowrap text-xs">{fmtDate(x.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
      <LaudoDialog
        aberto={novo || !!editando}
        onClose={() => {
          setNovo(false);
          setEditando(null);
        }}
        existente={editando}
        onSalvo={(x) => {
          recarregar();
          setDetalhe(x.id);
        }}
      />
      <TfdDetailDialog
        id={detalhe}
        onClose={() => setDetalhe(null)}
        onChanged={recarregar}
        onEditarLaudo={(x: ProcessoDetalhe) => {
          setDetalhe(null);
          setEditando(x);
        }}
      />
    </>
  );
}
