'use client';

import { CloudDownload, Download, FileArchive } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState } from '@/components/ui/card';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, saveBlob } from '@/lib/api';
import { fmtDate, fmtDateTime, formatCns } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { fmtCompetencia, fmtSigtap } from './types';

interface ExportRow {
  id: string;
  unitId: string;
  competencia: string;
  instrument: string;
  fileName: string;
  lines: number;
  controlField: string;
  createdAt: string;
}

export function ExportsTab({ competencia, unitName }: { competencia: string; unitName: (id: string) => string }) {
  const toast = useToast();
  const session = useSession();
  const list = useApi<ExportRow[]>(`/billing/exports?competencia=${competencia}`, [competencia]);
  return (
    <Card>
      <CardHeader title="Arquivos BPA gerados" description="Arquivos magnéticos em latin1 para importação no BPA Magnético / SIA." />
      {list.loading ? (
        <Spinner />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState icon={<FileArchive className="h-8 w-8" />} title="Nenhum arquivo nesta competência" />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Arquivo</TH>
              <TH>Unidade</TH>
              <TH>Instrumento</TH>
              <TH className="text-right">Linhas</TH>
              <TH>Controle</TH>
              <TH>Gerado em</TH>
              <TH />
            </tr>
          </THead>
          <TBody>
            {(list.data ?? []).map((e) => (
              <TR key={e.id}>
                <TD className="font-mono text-xs">{e.fileName}</TD>
                <TD>{unitName(e.unitId)}</TD>
                <TD>{e.instrument.replace('_', '-')}</TD>
                <TD className="text-right">{e.lines}</TD>
                <TD className="font-mono">{e.controlField}</TD>
                <TD>{fmtDateTime(e.createdAt)}</TD>
                <TD className="text-right">
                  {session.can('faturamento.exportar') && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={async () => {
                        try {
                          const f = await api.download(`/billing/exports/${e.id}/download`);
                          saveBlob(f.blob, f.fileName ?? e.fileName);
                        } catch (err) {
                          toast.error(errorMessage(err));
                        }
                      }}
                    >
                      <Download className="h-4 w-4" /> Baixar
                    </Button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

interface SyncRow {
  id: string;
  competencia: string;
  source: string;
  status: string;
  procedures: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export function SigtapTab({ competencia }: { competencia: string }) {
  const toast = useToast();
  const session = useSession();
  const syncs = useApi<SyncRow[]>('/billing/sigtap/syncs');
  const [pending, setPending] = useState<'upload' | 'sync' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const can = session.can('sigtap.sincronizar');

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Tabela SIGTAP"
          description="A sincronização automática roda no primeiro dia útil de cada competência. Em contingência, envie o pacote zip da Tabela Unificada baixado do DATASUS."
        />
        {can && (
          <CardBody className="flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                setPending('upload');
                setError(null);
                try {
                  const r = await api.post<{ competencia: string; procedures: number; cboLinks: number; cidLinks: number }>('/billing/sigtap/import', f, {
                    raw: true,
                    headers: { 'Content-Type': 'application/zip' },
                  });
                  toast.success(`SIGTAP ${fmtCompetencia(r.competencia)} carregada: ${r.procedures} procedimentos, ${r.cboLinks} vínculos de CBO, ${r.cidLinks} de CID.`);
                  void syncs.reload();
                } catch (err) {
                  setError(errorMessage(err));
                  void syncs.reload();
                } finally {
                  setPending(null);
                }
              }}
            />
            <Button onClick={() => fileRef.current?.click()} loading={pending === 'upload'}>
              <FileArchive className="h-4 w-4" /> Enviar pacote zip
            </Button>
            <Button
              variant="secondary"
              loading={pending === 'sync'}
              onClick={async () => {
                setPending('sync');
                setError(null);
                try {
                  const r = await api.post<{ procedures: number }>('/billing/sigtap/sync', { competencia });
                  toast.success(`Sincronizada: ${r.procedures} procedimentos.`);
                  void syncs.reload();
                } catch (err) {
                  setError(errorMessage(err));
                } finally {
                  setPending(null);
                }
              }}
            >
              <CloudDownload className="h-4 w-4" /> Sincronizar {fmtCompetencia(competencia)} com o DATASUS
            </Button>
          </CardBody>
        )}
        {error && (
          <CardBody className="pt-0">
            <Alert tone="error">{error}</Alert>
          </CardBody>
        )}
      </Card>
      <Card>
        <CardHeader title="Histórico de cargas" />
        {syncs.loading ? (
          <Spinner />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Competência</TH>
                <TH>Origem</TH>
                <TH>Situação</TH>
                <TH className="text-right">Procedimentos</TH>
                <TH>Início</TH>
                <TH>Erro</TH>
              </tr>
            </THead>
            <TBody>
              {(syncs.data ?? []).map((s) => (
                <TR key={s.id}>
                  <TD>{s.competencia === '000000' ? '—' : fmtCompetencia(s.competencia)}</TD>
                  <TD>{s.source}</TD>
                  <TD>
                    <Badge tone={s.status === 'CONCLUIDA' ? 'green' : s.status === 'ERRO' ? 'red' : 'slate'}>{s.status}</Badge>
                  </TD>
                  <TD className="text-right">{s.procedures}</TD>
                  <TD>{fmtDateTime(s.startedAt)}</TD>
                  <TD className="max-w-xs text-xs text-red-700">{s.error ?? ''}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

interface AihMirror {
  note: string;
  items: {
    admissionId: string;
    patient: string;
    cns: string | null;
    unit: string;
    ward: string | null;
    bed: string | null;
    mainCid: string;
    aihNumber: string | null;
    regulationCode: string | null;
    admittedAt: string;
    dischargedAt: string | null;
    days: number;
    status: string;
    procedures: { code: string; name: string | null; quantity: number; status: string }[];
  }[];
}

export function AihTab({ competencia }: { competencia: string }) {
  const mirror = useApi<AihMirror>(`/billing/aih-mirror?competencia=${competencia}`, [competencia]);
  return (
    <Card>
      <CardHeader title="Espelho de AIH" description={mirror.data?.note} />
      {mirror.loading ? (
        <Spinner />
      ) : mirror.error ? (
        <CardBody>
          <Alert tone="error">{mirror.error}</Alert>
        </CardBody>
      ) : (mirror.data?.items ?? []).length === 0 ? (
        <EmptyState title="Sem internações na competência" />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Paciente</TH>
              <TH>Unidade / leito</TH>
              <TH>CID</TH>
              <TH>Internação</TH>
              <TH>Alta</TH>
              <TH className="text-right">Dias</TH>
              <TH>Procedimentos</TH>
            </tr>
          </THead>
          <TBody>
            {(mirror.data?.items ?? []).map((a) => (
              <TR key={a.admissionId}>
                <TD>
                  {a.patient}
                  {a.cns && <span className="block font-mono text-xs text-slate-500">{formatCns(a.cns)}</span>}
                </TD>
                <TD className="text-xs">
                  {a.unit}
                  <span className="block text-slate-500">
                    {a.ward ?? '—'} {a.bed ?? ''}
                  </span>
                </TD>
                <TD className="font-mono">{a.mainCid}</TD>
                <TD>{fmtDate(a.admittedAt)}</TD>
                <TD>{a.dischargedAt ? fmtDate(a.dischargedAt) : <Badge tone="blue">Internado</Badge>}</TD>
                <TD className="text-right">{a.days}</TD>
                <TD className="text-xs">
                  {a.procedures.length === 0 ? '—' : a.procedures.map((p) => `${fmtSigtap(p.code)} ×${p.quantity}`).join('; ')}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
