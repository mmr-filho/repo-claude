'use client';

import { Send } from 'lucide-react';
import { useState } from 'react';
import { DetailDialog } from '@/components/regulation/detail-dialog';
import { RequestDialog } from '@/components/regulation/request-dialog';
import { PRIORIDADE_TONE, STATUS_TONE, type Solicitacao } from '@/components/regulation/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { fmtDate } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { EncounterDetail } from './types';

/** Encaminhamentos do paciente à regulação (consultas especializadas, exames e procedimentos) a partir do atendimento. */
export function RegulationPanel({ encounter, cid, resumo }: { encounter: EncounterDetail; cid?: string | null; resumo?: string | null }) {
  const session = useSession();
  const lista = useApi<Solicitacao[]>(`/regulacao/solicitacoes?patientId=${encounter.patientId}`, [encounter.patientId]);
  const [novo, setNovo] = useState(false);
  const [detalhe, setDetalhe] = useState<string | null>(null);
  const podeSolicitar = session.can('regulacao.solicitar') && encounter.status !== 'ENCERRADO' && encounter.status !== 'CANCELADO';
  const itens = lista.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">Solicitações desta pessoa à regulação ambulatorial (fila única), com a devolutiva do regulador.</p>
        {podeSolicitar && (
          <Button onClick={() => setNovo(true)} id="reg-nova">
            <Send className="h-4 w-4" /> Nova solicitação
          </Button>
        )}
      </div>
      {lista.error && <Alert tone="error">{lista.error}</Alert>}
      {lista.loading && !lista.data && <Spinner />}
      {lista.data && itens.length === 0 && <Alert tone="info">Nenhuma solicitação à regulação para esta pessoa.</Alert>}
      {itens.length > 0 && (
        <Table>
          <THead>
            <TR>
              <TH>Protocolo</TH>
              <TH>Solicitação</TH>
              <TH>Prioridade</TH>
              <TH>Situação</TH>
              <TH>Quando</TH>
            </TR>
          </THead>
          <TBody>
            {itens.map((s) => (
              <TR key={s.id} className="cursor-pointer" onClick={() => setDetalhe(s.id)}>
                <TD className="font-mono text-xs">{s.protocol}</TD>
                <TD>
                  {s.procedureName}
                  {s.encounterId === encounter.id && <span className="ml-1 text-xs text-slate-500">(este atendimento)</span>}
                  {s.decisionReason && s.status === 'DEVOLVIDA' && <span className="block text-xs text-amber-700">Pendência: {s.decisionReason}</span>}
                  {s.providerUnit && <span className="block text-xs text-slate-500">Executante: {s.providerUnit.name}</span>}
                </TD>
                <TD>
                  <Badge tone={PRIORIDADE_TONE[s.priority]}>{s.priorityLabel}</Badge>
                </TD>
                <TD>
                  <Badge tone={STATUS_TONE[s.status]}>{s.statusLabel}</Badge>
                  {s.atrasada && <span className="block text-xs text-red-700">prazo-meta vencido</span>}
                </TD>
                <TD className="whitespace-nowrap text-xs">
                  {fmtDate(s.createdAt)}
                  {s.diasEmFila !== null && <span className="block text-slate-500">{s.diasEmFila} dia(s) na fila</span>}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <RequestDialog
        aberto={novo}
        onClose={() => setNovo(false)}
        patientId={encounter.patientId}
        encounterId={encounter.id}
        cidInicial={cid}
        resumoInicial={resumo}
        onCriada={(s) => {
          void lista.reload();
          setDetalhe(s.id);
        }}
      />
      <DetailDialog id={detalhe} onClose={() => setDetalhe(null)} onChanged={() => void lista.reload()} />
    </div>
  );
}
