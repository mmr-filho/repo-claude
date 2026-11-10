'use client';

import { CATEGORIA_SURTO, ROTULO_STATUS_SURTO, type ListaSurtos, type StatusSurto, type SurtoResumo } from '@omnisaude/shared';
import { BellPlus } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { SITUACAO, tempoAte } from '@/components/vigilancia/types';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { dataBr, TOM_STATUS_SURTO } from './surto-regras';

/** Prazos de comunicação do surto (SMS sempre; SES e MS com ESP), com o tempo que falta quando ainda pendente. */
export function PrazosSurto({ prazos }: { prazos: SurtoResumo['prazos'] }) {
  if (!prazos.length) return <span className="text-xs text-slate-500">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {prazos.map((p) => (
        <Badge key={p.esfera} tone={SITUACAO[p.situacao].tone} title={p.cumpridoEm ? `Cumprido em ${fmtDateTime(p.cumpridoEm)}` : `Vence em ${fmtDateTime(p.venceEm)}`}>
          {p.esfera}: {SITUACAO[p.situacao].label}
          {p.situacao !== 'CUMPRIDO' && p.situacao !== 'SEM_PRAZO' && <span className="font-normal">({tempoAte(p.venceEm)})</span>}
        </Badge>
      ))}
    </span>
  );
}

/** Notificações de surto: a vigilância municipal vê todas; o núcleo, as da unidade em que está lotado. */
export function SurtoLista({ onAbrir, onNovo, versao }: { onAbrir: (id: string) => void; onNovo: () => void; versao: number }) {
  const [status, setStatus] = useState<StatusSurto | ''>('ABERTO');
  const lista = useApi<ListaSurtos>(`/vigilancia/surtos${status ? `?status=${status}` : ''}`, [versao]);
  return (
    <Card>
      <CardHeader
        title="Notificações de surto"
        description="Tipo 3 da ficha do Sinan Net: sem paciente, com a planilha de casos, a investigação e o encerramento."
        actions={
          <>
            <Select aria-label="Situação" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value as StatusSurto | '')}>
              <option value="ABERTO">Abertos</option>
              <option value="ENCERRADO">Encerrados</option>
              <option value="DESCARTADO">Descartados</option>
              <option value="">Todos</option>
            </Select>
            <Button size="sm" onClick={onNovo}>
              <BellPlus className="h-4 w-4" /> Notificar surto
            </Button>
          </>
        }
      />
      {lista.loading && !lista.data && <Spinner />}
      {lista.error && (
        <CardBody>
          <Alert tone="error">{lista.error}</Alert>
        </CardBody>
      )}
      {lista.data && lista.data.length === 0 && <EmptyState title="Nenhum surto nesta situação" />}
      {!!lista.data?.length && (
        <Table>
          <THead>
            <tr>
              <TH>Surto</TH>
              <TH>Agravo</TH>
              <TH>Unidade</TH>
              <TH>Notificado em</TH>
              <TH className="text-right">Casos</TH>
              <TH>Prazo da comunicação</TH>
              <TH>Situação</TH>
            </tr>
          </THead>
          <TBody>
            {lista.data.map((s) => (
              <TR key={s.id} className="cursor-pointer" onClick={() => onAbrir(s.id)}>
                <TD className="whitespace-nowrap">
                  <button type="button" className="font-medium tabular-nums text-brand-700 hover:underline" onClick={() => onAbrir(s.id)}>
                    {s.numero}
                  </button>
                  {s.numeroOficial && <span className="block text-xs text-slate-500">Sinan {s.numeroOficial}</span>}
                </TD>
                <TD>
                  {s.agravo}
                  <span className="block text-xs text-slate-500">{CATEGORIA_SURTO[s.categoria]}</span>
                </TD>
                <TD>
                  {s.unidade.nome}
                  <span className="block text-xs text-slate-500">CNES {s.unidade.cnes}</span>
                </TD>
                <TD className="whitespace-nowrap tabular-nums">{dataBr(s.notificadoEm)}</TD>
                <TD className="text-right tabular-nums">
                  {s.casos}
                  <span className="block text-xs text-slate-500">{s.casosNaPlanilha} na planilha</span>
                </TD>
                <TD>
                  <PrazosSurto prazos={s.prazos} />
                </TD>
                <TD>
                  <span className="flex flex-wrap gap-1">
                    <Badge tone={TOM_STATUS_SURTO[s.status]}>{ROTULO_STATUS_SURTO[s.status]}</Badge>
                    {s.esp && <Badge tone="red">ESP</Badge>}
                    {s.avisos.length > 0 && (
                      <Badge tone="amber" title={s.avisos.join(' ')}>
                        {s.avisos.length} aviso(s)
                      </Badge>
                    )}
                  </span>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
