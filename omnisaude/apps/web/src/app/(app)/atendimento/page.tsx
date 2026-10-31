'use client';

import { AlertTriangle, ArrowLeft, DoorClosed, FileText, History, PlayCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { CertificateDialog } from '@/components/clinical/certificate-dialog';
import { CloseEncounterDialog } from '@/components/clinical/close-dialog';
import { ExamsPanel } from '@/components/clinical/exams-panel';
import { emptyItem, PrescriptionEditor } from '@/components/clinical/prescription-editor';
import { RegulationPanel } from '@/components/clinical/regulation-panel';
import { SoapEditor } from '@/components/clinical/soap-editor';
import { parseStoredCode, type EncounterDetail, type ItemDraft, type VoiceCommand } from '@/components/clinical/types';
import { VoiceCommandButton } from '@/components/clinical/voice-command';
import { Timeline } from '@/components/patients/timeline';
import type { TimelineEvent } from '@/components/patients/types';
import { Badge, RiskBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Alert, Spinner } from '@/components/ui/misc';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateTime, formatCns } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';

const STATUS_LABEL: Record<EncounterDetail['status'], string> = {
  ABERTO: 'Aguardando',
  TRIADO: 'Classificado',
  EM_ATENDIMENTO: 'Em atendimento',
  ENCERRADO: 'Encerrado',
  CANCELADO: 'Cancelado',
  EVADIU: 'Evasão',
};

function Workspace() {
  const id = useSearchParams().get('id');
  const session = useSession();
  const router = useRouter();
  const toast = useToast();
  const enc = useApi<EncounterDetail>(id ? `/clinical/encounters/${id}` : null);
  const patientId = enc.data?.patientId ?? null;
  const timeline = useApi<{ events: TimelineEvent[] }>(patientId && session.can('prontuario.ler') ? `/patients/${patientId}/timeline` : null);
  const [tab, setTab] = useState('soap');
  const [showTimeline, setShowTimeline] = useState(true);
  const [items, setItems] = useState<ItemDraft[]>(() => [emptyItem()]);
  const [cert, setCert] = useState<{ open: boolean; days?: number }>({ open: false });
  const [closing, setClosing] = useState(false);
  const [examPrefill, setExamPrefill] = useState<string[] | undefined>();
  const [starting, setStarting] = useState(false);

  if (!id) return <Alert tone="error">Atendimento não informado.</Alert>;
  if (enc.error) return <Alert tone="error">{enc.error}</Alert>;
  const e = enc.data;
  if (!e) return <Spinner />;
  const triage = e.triages[0];
  const closed = e.status === 'ENCERRADO' || e.status === 'CANCELADO' || e.status === 'EVADIU';
  const lastCid =
    e.mainCid ??
    e.notes
      .flatMap((n) => n.codes)
      .map(parseStoredCode)
      .find((c) => c.system === 'CID10')?.code;
  const reload = () => {
    void enc.reload();
    void timeline.reload();
  };

  function onCommand(c: VoiceCommand) {
    switch (c.intent) {
      case 'PRESCREVER': {
        const a = c.args;
        const freq = a.intervalHours ?? (a.timesPerDay ? Math.round(24 / a.timesPerDay) : undefined);
        const draft = emptyItem({
          description: `${a.drug}${a.dose ? ` ${a.dose} ${a.unit ?? ''}` : ''}`.trim(),
          activeIngredient: a.drug,
          dose: a.dose ? String(a.dose) : '',
          doseUnit: a.unit ?? 'mg',
          route: a.route ?? 'ORAL',
          frequencyHours: freq ? String(freq) : '',
          durationDays: a.durationDays ? String(a.durationDays) : '',
        });
        setItems((s) => [...s.filter((i) => i.description.trim()), draft]);
        setTab('prescricao');
        toast.info(`Item adicionado à prescrição: ${draft.description}`);
        break;
      }
      case 'EMITIR_ATESTADO':
        setCert({ open: true, days: c.args.days });
        break;
      case 'SOLICITAR_EXAME':
        setExamPrefill(c.args.exams);
        setTab('exames');
        break;
      case 'CHAMAR_PROXIMO':
        router.push('/atendimentos');
        break;
      case 'ENCERRAR_ATENDIMENTO':
        setClosing(true);
        break;
      case 'ABRIR_PRONTUARIO':
        router.push(`/paciente?id=${e!.patientId}`);
        break;
      default:
        toast.info(`Comando “${c.raw}” não se aplica a esta tela.`);
    }
  }

  async function start() {
    setStarting(true);
    try {
      await api.post(`/clinical/encounters/${e!.id}/start`);
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-start gap-4">
          <Link href={session.can('prontuario.evoluir') ? '/atendimentos' : '/pacientes'} aria-label="Voltar">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{e.patient.socialName ?? e.patient.name}</h1>
              {triage && <RiskBadge color={triage.riskColor} />}
              <Badge tone={closed ? 'slate' : 'blue'}>{STATUS_LABEL[e.status]}</Badge>
            </div>
            <p className="text-sm text-slate-600">
              {e.patient.age} anos · {e.patient.sex === 'F' ? 'feminino' : 'masculino'}
              {e.patient.cns ? ` · CNS ${formatCns(e.patient.cns)}` : ''} · {e.unit.name} · chegada {fmtDateTime(e.startedAt)}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {e.patient.allergies.map((a) => (
                <Badge key={a.id} tone="red">
                  <AlertTriangle className="h-3 w-3" /> Alergia: {a.substance}
                </Badge>
              ))}
              {e.patient.conditions.map((c) => (
                <Badge key={c.id} tone="violet">
                  {c.code} · {c.description}
                </Badge>
              ))}
            </div>
            {triage && (
              <p className="mt-2 text-sm text-slate-700">
                <b>Triagem:</b> {triage.complaint}
                {triage.systolic ? ` · PA ${triage.systolic}x${triage.diastolic ?? '?'}` : ''}
                {triage.heartRate ? ` · FC ${triage.heartRate}` : ''}
                {triage.spo2 ? ` · SpO₂ ${triage.spo2}%` : ''}
                {triage.temperature ? ` · T ${String(triage.temperature)}°C` : ''}
                {triage.glucose ? ` · glicemia ${triage.glucose}` : ''}
                {triage.painScore !== null ? ` · dor ${triage.painScore}/10` : ''}
              </p>
            )}
          </div>
          <div className="flex w-full flex-wrap gap-2 md:w-auto">
            {!closed && (e.status === 'ABERTO' || e.status === 'TRIADO') && session.can('prontuario.evoluir') && (
              <Button onClick={start} loading={starting}>
                <PlayCircle className="h-4 w-4" /> Iniciar atendimento
              </Button>
            )}
            {!closed && session.can('prontuario.encerrar') && (
              <>
                <Button variant="secondary" onClick={() => setCert({ open: true })}>
                  <FileText className="h-4 w-4" /> Atestado
                </Button>
                <Button variant="secondary" onClick={() => setClosing(true)}>
                  <DoorClosed className="h-4 w-4" /> Encerrar
                </Button>
              </>
            )}
            <Button variant="ghost" onClick={() => setShowTimeline((s) => !s)} aria-pressed={showTimeline}>
              <History className="h-4 w-4" /> Histórico
            </Button>
          </div>
        </div>
        {!closed && (
          <div className="mt-3 border-t border-slate-100 pt-3">
            <VoiceCommandButton onCommand={onCommand} />
          </div>
        )}
      </Card>

      <div className={cn('grid grid-cols-1 gap-4', showTimeline && 'xl:grid-cols-[22rem_minmax(0,1fr)]')}>
        {showTimeline && (
          <Card className="max-h-[75vh] overflow-y-auto">
            <CardBody>
              <h2 className="mb-3 text-sm font-semibold text-slate-700">Linha do tempo da rede</h2>
              {timeline.loading && !timeline.data ? <Spinner /> : <Timeline events={timeline.data?.events ?? []} compact />}
            </CardBody>
          </Card>
        )}
        <Card>
          <CardBody>
            <Tabs
              value={tab}
              onValueChange={setTab}
              tabs={[
                { value: 'soap', label: 'Evolução (SOAP)' },
                { value: 'prescricao', label: `Prescrição${e.prescriptions.length ? ` (${e.prescriptions.length})` : ''}` },
                { value: 'exames', label: `Exames${e.examRequests.length ? ` (${e.examRequests.length})` : ''}` },
                { value: 'encaminhamentos', label: 'Encaminhamentos' },
              ]}
            >
              <TabPanel value="soap">
                <SoapEditor encounter={e} onChanged={reload} />
              </TabPanel>
              <TabPanel value="prescricao">
                <PrescriptionEditor encounter={e} items={items} setItems={setItems} onChanged={reload} />
              </TabPanel>
              <TabPanel value="exames">
                <ExamsPanel encounter={e} onChanged={reload} prefill={examPrefill} />
              </TabPanel>
              <TabPanel value="encaminhamentos">
                <RegulationPanel encounter={e} cid={lastCid ?? null} resumo={[e.notes.at(-1)?.assessment, e.notes.at(-1)?.plan].filter(Boolean).join('\n') || null} />
              </TabPanel>
            </Tabs>
          </CardBody>
        </Card>
      </div>

      <CertificateDialog encounterId={e.id} open={cert.open} onOpenChange={(o) => setCert((c) => ({ ...c, open: o }))} defaultDays={cert.days} defaultCid={lastCid ?? undefined} onIssued={reload} />
      <CloseEncounterDialog
        encounterId={e.id}
        open={closing}
        onOpenChange={setClosing}
        defaultCid={lastCid ?? undefined}
        onClosed={() => {
          reload();
          router.push('/atendimentos');
        }}
      />
    </div>
  );
}

export default function EncounterPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Workspace />
    </Suspense>
  );
}
