'use client';

import { BedDouble, Biohazard, FileText, RefreshCw } from 'lucide-react';
import { AihDialog } from '@/components/bed-regulation/aih-dialog';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { AdmitDialog, BedStatusDialog, DischargeDialog, TransferDialog } from '@/components/beds/dialogs';
import { ISOLATION_LABELS, STATUS_STYLE, type BedView, type Census } from '@/components/beds/types';
import { cn } from '@/lib/cn';
import { useApi, useInterval } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';

type Action = { kind: 'status' | 'admit' | 'transfer' | 'discharge' | 'aih'; bed: BedView };

/** Censo de leitos em tempo real (NIR): situação por setor, ocupantes, isolamento e taxa de ocupação. */
export default function BedsPage() {
  const session = useSession();
  const me = session.me!;
  const [unitId, setUnitId] = useState(me.context.unitId);
  const directory = useApi<{ units: { id: string; name: string; type: string }[] }>('/directory');
  const census = useApi<Census>(`/beds/census?unitId=${unitId}`, [unitId]);
  const [action, setAction] = useState<Action | null>(null);
  const canManage = session.can('leitos.gerir');
  const canDischarge = session.can('leitos.gerir', 'prontuario.encerrar');
  const canAih = session.can('aih.solicitar');

  useRealtime('censo', () => void census.reload());
  useInterval(() => void census.reload(), 60_000);

  const units = (directory.data?.units ?? []).filter((u) => u.type === 'HOSPITAL' || u.type === 'UPA');
  const done = () => {
    setAction(null);
    void census.reload();
  };
  const t = census.data?.totals;

  return (
    <>
      <PageHeader
        title="Censo de leitos"
        description="Atualização em tempo real. Toque em um leito para mudar a situação, internar, transferir ou dar alta."
        actions={
          <>
            {units.length > 1 && (
              <Select value={unitId} onChange={(e) => setUnitId(e.target.value)} aria-label="Unidade" className="w-64">
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            )}
            <Button variant="secondary" onClick={() => void census.reload()}>
              <RefreshCw className="h-4 w-4" /> Atualizar
            </Button>
          </>
        }
      />
      {census.error && <Alert tone="error">{census.error}</Alert>}
      {census.loading && !census.data ? (
        <Spinner />
      ) : census.data ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
            <Stat
              label="Ocupação"
              value={`${census.data.occupancyRate.toLocaleString('pt-BR')}%`}
              tone={census.data.occupancyRate >= 90 ? 'bad' : census.data.occupancyRate >= 80 ? 'warn' : 'good'}
              hint="Sobre leitos operacionais"
            />
            <Stat label="Ocupados" value={t!.OCUPADO} />
            <Stat label="Vagos" value={t!.VAGO} tone="good" />
            <Stat label="Higienização" value={t!.HIGIENIZACAO} tone={t!.HIGIENIZACAO ? 'warn' : 'default'} />
            <Stat label="Reservados" value={t!.RESERVADO} tone={t!.RESERVADO ? 'warn' : 'default'} hint="Pela central de leitos" />
            <Stat label="Bloqueados" value={t!.BLOQUEADO} />
            <Stat label="Em isolamento" value={t!.isolated} />
          </div>
          <div className="mb-3 flex flex-wrap gap-3 text-xs text-slate-600" aria-label="Legenda">
            {Object.entries(STATUS_STYLE).map(([k, v]) => (
              <span key={k} className="flex items-center gap-1.5">
                <span className={cn('h-2.5 w-2.5 rounded-full', v.dot)} /> {v.label}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <Biohazard className="h-3.5 w-3.5 text-violet-700" /> Isolamento
            </span>
          </div>
          {census.data.wards.length === 0 ? (
            <Card>
              <EmptyState icon={<BedDouble className="h-8 w-8" />} title="Unidade sem setores de internação cadastrados" />
            </Card>
          ) : (
            <div className="space-y-4">
              {census.data.wards.map((w) => {
                const occupied = w.beds.filter((b) => b.status === 'OCUPADO').length;
                return (
                  <Card key={w.id}>
                    <CardHeader title={w.name} description={`${occupied} de ${w.beds.length} leitos ocupados`} />
                    <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                      {w.beds.map((b) => (
                        <BedCard key={b.id} bed={b} canManage={canManage} canDischarge={canDischarge} canAih={canAih} onAction={(kind) => setAction({ kind, bed: b })} />
                      ))}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      ) : null}
      {action?.kind === 'status' && <BedStatusDialog bed={action.bed} onClose={() => setAction(null)} onDone={done} />}
      {action?.kind === 'admit' && <AdmitDialog bed={action.bed} onClose={() => setAction(null)} onDone={done} />}
      {action?.kind === 'transfer' && census.data && <TransferDialog bed={action.bed} census={census.data} onClose={() => setAction(null)} onDone={done} />}
      {action?.kind === 'discharge' && <DischargeDialog bed={action.bed} onClose={() => setAction(null)} onDone={done} />}
      {action?.kind === 'aih' && action.bed.occupant && (
        <AihDialog
          aberto
          onClose={() => setAction(null)}
          onSalvo={done}
          prefill={{ patientId: action.bed.occupant.patientId, patientName: action.bed.occupant.name, admissionId: action.bed.occupant.admissionId, mainCid: action.bed.occupant.mainCid }}
        />
      )}
    </>
  );
}

function BedCard({ bed, canManage, canDischarge, canAih, onAction }: { bed: BedView; canManage: boolean; canDischarge: boolean; canAih: boolean; onAction: (k: Action['kind']) => void }) {
  const style = STATUS_STYLE[bed.status];
  return (
    <div className={cn('flex min-h-32 flex-col rounded-lg border-2 p-2.5', style.card)}>
      <button className="flex items-center justify-between text-left" onClick={() => onAction('status')} disabled={!canManage} title={canManage ? 'Situação e histórico' : undefined}>
        <span className="font-mono text-sm font-bold">{bed.code}</span>
        <span className="flex items-center gap-1">
          {bed.isolation !== 'NENHUM' && (
            <span title={`Isolamento: ${ISOLATION_LABELS[bed.isolation]}`}>
              <Biohazard className="h-4 w-4 text-violet-700" aria-label={`Isolamento por ${ISOLATION_LABELS[bed.isolation]}`} />
            </span>
          )}
          <span className={cn('h-2.5 w-2.5 rounded-full', style.dot)} aria-hidden />
        </span>
      </button>
      <p className="text-xs font-medium text-slate-600">{style.label}</p>
      {bed.occupant ? (
        <div className="mt-1 flex-1 text-xs">
          <p className="truncate font-semibold text-slate-900" title={bed.occupant.name}>
            {bed.occupant.name}
          </p>
          <p className="text-slate-600">
            {bed.occupant.age}a · {bed.occupant.sex} · CID {bed.occupant.mainCid}
          </p>
          <p className="text-slate-600">{bed.occupant.daysAdmitted} dia(s)</p>
          {bed.occupant.regulationCode && (
            <Badge className="mt-0.5" tone={bed.occupant.regulationCode.startsWith('LEI-') ? 'violet' : 'slate'}>
              {bed.occupant.regulationCode.startsWith('LEI-') ? 'Central' : 'SISREG'} {bed.occupant.regulationCode}
            </Badge>
          )}
        </div>
      ) : bed.reservation ? (
        <div className="mt-1 flex-1 text-xs">
          <p className="truncate font-semibold text-violet-900" title={bed.reservation.name}>
            {bed.reservation.name}
          </p>
          <p className="text-slate-600">
            {bed.reservation.age}a · {bed.reservation.sex} · de {bed.reservation.originUnit ?? '—'}
          </p>
          <Badge tone="violet" className="mt-0.5">
            {bed.reservation.protocol}
          </Badge>
        </div>
      ) : (
        <div className="flex-1" />
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        {(bed.status === 'VAGO' || (bed.status === 'RESERVADO' && bed.reservation)) && canManage && (
          <Button size="sm" className="h-8 flex-1 px-2" onClick={() => onAction('admit')}>
            Internar
          </Button>
        )}
        {bed.occupant && canManage && (
          <Button size="sm" variant="secondary" className="h-8 flex-1 px-2" onClick={() => onAction('transfer')}>
            Transferir
          </Button>
        )}
        {bed.occupant && canDischarge && (
          <Button size="sm" variant="secondary" className="h-8 flex-1 px-2" onClick={() => onAction('discharge')}>
            Alta
          </Button>
        )}
        {bed.occupant && canAih && (
          <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => onAction('aih')} title="Laudo de AIH" aria-label={`Laudo de AIH de ${bed.occupant.name}`}>
            <FileText className="h-4 w-4" /> AIH
          </Button>
        )}
      </div>
    </div>
  );
}
