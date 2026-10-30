'use client';

import { HeartHandshake, MessageCircle, Phone } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { CasePanel } from '@/components/social/case-panel';
import { CASE_STATUS, LINE_LABELS, LINES, type LineOfCare, type PanelItem } from '@/components/social/types';
import { api, ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDate, formatCns } from '@/lib/format';
import { useApi } from '@/lib/hooks';

/** Busca ativa humanizada: crônicos e gestantes com retorno em atraso ou faltas recentes. */
export default function SocialPage() {
  const toast = useToast();
  const [line, setLine] = useState<'' | LineOfCare>('');
  const panel = useApi<{ total: number; items: PanelItem[]; thresholds: Record<string, number> }>(`/social/active-search${line ? `?lineOfCare=${line}` : ''}`, [line]);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const items = panel.data?.items ?? [];

  async function openCase(i: PanelItem) {
    if (i.case) {
      setCaseId(i.case.id);
      return;
    }
    const key = `${i.patientId}-${i.lineOfCare}`;
    setOpening(key);
    try {
      const c = await api.post<{ id: string }>('/social/cases', { patientId: i.patientId, lineOfCare: i.lineOfCare });
      setCaseId(c.id);
      void panel.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setCaseId((err.details as { caseId?: string })?.caseId ?? null);
      else toast.error(errorMessage(err));
    } finally {
      setOpening(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Busca ativa"
        description="Pacientes acompanhados em linhas de cuidado sem consulta recente em nenhuma unidade da rede, ou com faltas. Registre o contato e os motivos de vulnerabilidade."
        actions={
          <Select value={line} onChange={(e) => setLine(e.target.value as '' | LineOfCare)} aria-label="Linha de cuidado" className="w-56">
            <option value="">Todas as linhas de cuidado</option>
            {LINES.map((l) => (
              <option key={l} value={l}>
                {LINE_LABELS[l]}
              </option>
            ))}
          </Select>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Pacientes no painel" value={panel.data?.total ?? '—'} />
        <Stat label="Sem caso aberto" value={items.filter((i) => !i.case).length} tone={items.some((i) => !i.case) ? 'warn' : 'default'} />
        <Stat label="Com faltas recentes" value={items.filter((i) => i.missedAppointments > 0).length} />
        <Stat label="Retorno agendado" value={items.filter((i) => i.case?.status === 'AGENDADO').length} tone="good" />
      </div>
      <div className={cn('grid gap-4', caseId && 'xl:grid-cols-[minmax(0,1fr)_32rem]')}>
        <Card>
          <CardHeader title="Pacientes em atraso" description={panel.data ? `Limiares: ${Object.entries(panel.data.thresholds).map(([k, v]) => `${LINE_LABELS[k as LineOfCare] ?? k} ${v} dias`).join(' · ')}` : undefined} />
          {panel.loading ? (
            <Spinner />
          ) : panel.error ? (
            <Alert tone="error" className="m-4">
              {panel.error}
            </Alert>
          ) : items.length === 0 ? (
            <EmptyState icon={<HeartHandshake className="h-8 w-8" />} title="Nenhum paciente em atraso" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {items.map((i) => {
                const key = `${i.patientId}-${i.lineOfCare}`;
                return (
                  <li key={key} className={cn('flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center', i.case?.id === caseId && 'bg-brand-50/50')}>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {i.name}
                        <Badge tone="violet">{LINE_LABELS[i.lineOfCare]}</Badge>
                        {i.case && <Badge tone={CASE_STATUS[i.case.status]?.tone ?? 'slate'}>{CASE_STATUS[i.case.status]?.label ?? i.case.status}</Badge>}
                      </p>
                      <p className="text-sm text-slate-600">
                        {i.age} anos · {i.condition.code} {i.condition.description}
                        {i.district ? ` · ${i.district}` : ''}
                      </p>
                      <p className="mt-0.5 text-sm">
                        {i.lastVisitAt ? (
                          <>
                            Última consulta {fmtDate(i.lastVisitAt)} ·{' '}
                            <span className={cn('font-semibold', (i.daysOverdue ?? 0) > 0 && 'text-red-700')}>{i.daysOverdue ?? 0} dia(s) de atraso</span>
                          </>
                        ) : (
                          <span className="font-semibold text-red-700">Sem consulta registrada</span>
                        )}
                        {i.missedAppointments > 0 && <span className="ml-2 text-amber-700">· {i.missedAppointments} falta(s)</span>}
                      </p>
                      <p className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
                        {i.cns && <span className="font-mono">CNS {formatCns(i.cns)}</span>}
                        {i.phone && (
                          <a href={`tel:${i.phone}`} className="flex items-center gap-1 text-brand-700">
                            <Phone className="h-3 w-3" /> {i.phone}
                          </a>
                        )}
                        {i.whatsappOptIn && (
                          <span className="flex items-center gap-1 text-emerald-700">
                            <MessageCircle className="h-3 w-3" /> WhatsApp
                          </span>
                        )}
                      </p>
                    </div>
                    <Button className="h-11 sm:w-36" variant={i.case ? 'secondary' : 'primary'} onClick={() => openCase(i)} loading={opening === key}>
                      {i.case ? 'Ver caso' : 'Abrir caso'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        {caseId && <CasePanel caseId={caseId} onClose={() => setCaseId(null)} onChanged={() => void panel.reload()} />}
      </div>
    </>
  );
}
