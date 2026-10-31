'use client';

import { Download, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, EmptyState, Stat } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, saveBlob } from '@/lib/api';
import { fmtDate, formatCns } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { fmtSigtap, RULE_LABEL, STATUS_LABEL, type ProductionList, type ProductionStatus } from './types';

interface CritiqueResult {
  total: number;
  validated: number;
  glosas: number;
  byRule: Record<string, number>;
}

export function ProductionTab({ competencia, units }: { competencia: string; units: { id: string; name: string }[] }) {
  const session = useSession();
  const contextUnit = units.find((u) => u.id === session.me?.context.unitId)?.id;
  const toast = useToast();
  const [status, setStatus] = useState<'' | ProductionStatus>('');
  const [unitId, setUnitId] = useState('');
  const query = new URLSearchParams({ competencia, ...(status ? { status } : {}), ...(unitId ? { unitId } : {}) });
  const list = useApi<ProductionList>(`/billing/production?${query}`, [competencia, status, unitId]);
  const [critique, setCritique] = useState<CritiqueResult | null>(null);
  const [running, setRunning] = useState(false);
  const [exportUnit, setExportUnit] = useState('');
  const [instrument, setInstrument] = useState<'BPA_I' | 'BPA_C'>('BPA_I');
  const [exporting, setExporting] = useState(false);

  async function runCritique() {
    setRunning(true);
    try {
      const r = await api.post<CritiqueResult>('/billing/critique', { competencia, ...(unitId ? { unitId } : {}) });
      setCritique(r);
      toast.success(`Crítica concluída: ${r.validated} validado(s), ${r.glosas} com glosa prevista.`);
      void list.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  async function exportBpa() {
    const target = exportUnit || contextUnit || units[0]?.id;
    if (!target) return;
    setExporting(true);
    try {
      const r = await api.post<{ id: string; fileName: string; lines: number; records: number; controlField: string; validation: { ok: boolean; warnings: number } }>('/billing/export/bpa', {
        competencia,
        unitId: target,
        instrument,
      });
      const file = await api.download(`/billing/exports/${r.id}/download`);
      saveBlob(file.blob, file.fileName ?? r.fileName);
      toast.success(`${r.fileName}: ${r.records} registro(s), ${r.lines} linha(s), campo de controle ${r.controlField}; layout conferido${r.validation.warnings ? ` com ${r.validation.warnings} aviso(s)` : ''}.`);
      void list.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  const s = list.data?.summary ?? {};
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Registros" value={s.total ?? '—'} />
        <Stat label="Pendentes" value={s.PENDENTE ?? 0} />
        <Stat label="Validados" value={s.VALIDADO ?? 0} tone="good" />
        <Stat label="Glosa prevista" value={s.GLOSA_PREVISTA ?? 0} tone={(s.GLOSA_PREVISTA ?? 0) > 0 ? 'bad' : 'default'} />
        <Stat label="Exportados" value={s.EXPORTADO ?? 0} />
      </div>
      <Card>
        <CardHeader
          title="Crítica pré-glosa e exportação"
          description="A crítica confere CBO, CID, sexo, idade, quantidade por paciente, instrumento e CNS contra a SIGTAP antes do fechamento. Só registros validados vão para o arquivo BPA."
        />
        <CardBody className="flex flex-wrap items-end gap-3">
          {session.can('faturamento.criticar') && (
            <Button onClick={runCritique} loading={running}>
              <ListChecks className="h-4 w-4" /> Executar crítica pré-glosa
            </Button>
          )}
          {session.can('faturamento.exportar') && (
            <>
              <Field label="Unidade do arquivo">
                <Select value={exportUnit || contextUnit || units[0]?.id || ''} onChange={(e) => setExportUnit(e.target.value)} className="w-56">
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Instrumento">
                <Select value={instrument} onChange={(e) => setInstrument(e.target.value as 'BPA_I' | 'BPA_C')} className="w-48">
                  <option value="BPA_I">BPA-I (individualizado)</option>
                  <option value="BPA_C">BPA-C (consolidado)</option>
                </Select>
              </Field>
              <Button variant="secondary" onClick={exportBpa} loading={exporting}>
                <Download className="h-4 w-4" /> Gerar arquivo BPA
              </Button>
            </>
          )}
        </CardBody>
        {critique && Object.keys(critique.byRule).length > 0 && (
          <CardBody className="border-t border-slate-100 pt-4">
            <p className="mb-2 text-sm font-medium">Inconsistências por regra</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(critique.byRule).map(([rule, n]) => (
                <Badge key={rule} tone="red">
                  {RULE_LABEL[rule] ?? rule}: {n}
                </Badge>
              ))}
            </div>
          </CardBody>
        )}
      </Card>
      <Card>
        <CardHeader
          title="Produção da competência"
          actions={
            <>
              <Select value={unitId} onChange={(e) => setUnitId(e.target.value)} aria-label="Unidade" className="w-52">
                <option value="">Todas as unidades</option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
              <Select value={status} onChange={(e) => setStatus(e.target.value as '' | ProductionStatus)} aria-label="Situação" className="w-44">
                <option value="">Todas as situações</option>
                {(Object.keys(STATUS_LABEL) as ProductionStatus[]).map((k) => (
                  <option key={k} value={k}>
                    {STATUS_LABEL[k].label}
                  </option>
                ))}
              </Select>
            </>
          }
        />
        {list.loading ? (
          <Spinner />
        ) : list.error ? (
          <CardBody>
            <Alert tone="error">{list.error}</Alert>
          </CardBody>
        ) : (list.data?.items ?? []).length === 0 ? (
          <EmptyState title="Sem produção registrada para os filtros" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Data</TH>
                <TH>Procedimento</TH>
                <TH>Paciente</TH>
                <TH>Profissional / CBO</TH>
                <TH>CID</TH>
                <TH className="text-right">Qtd.</TH>
                <TH>Instr.</TH>
                <TH>Situação</TH>
              </tr>
            </THead>
            <TBody>
              {(list.data?.items ?? []).map((i) => (
                <TR key={i.id}>
                  <TD className="whitespace-nowrap">{fmtDate(i.performedAt)}</TD>
                  <TD>
                    <span className="font-mono text-xs">{fmtSigtap(i.procedureCode)}</span>
                    <span className="block text-xs text-slate-600">{i.procedureName ?? '—'}</span>
                    <span className="block text-xs text-slate-400">{i.unit}</span>
                  </TD>
                  <TD className="text-xs">
                    {i.patient?.name ?? '—'}
                    {i.patient?.cns && <span className="block font-mono text-slate-500">{formatCns(i.patient.cns)}</span>}
                  </TD>
                  <TD className="text-xs">
                    {i.professional ?? '—'}
                    <span className="block font-mono text-slate-500">{i.cbo}</span>
                  </TD>
                  <TD className="font-mono text-xs">{i.cid ?? '—'}</TD>
                  <TD className="text-right tabular-nums">{i.quantity}</TD>
                  <TD className="text-xs">{i.instrument.replace('_', '-')}</TD>
                  <TD>
                    <Badge tone={STATUS_LABEL[i.status].tone}>{STATUS_LABEL[i.status].label}</Badge>
                    {i.issues.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-xs text-red-700">
                        {i.issues.map((x, k) => (
                          <li key={k}>{x.message}</li>
                        ))}
                      </ul>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
