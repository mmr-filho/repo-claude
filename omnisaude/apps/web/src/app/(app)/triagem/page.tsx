'use client';

import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { QueueList, RiskCounts, type QueueRow, type TriageQueue } from '@/components/triage/queue';
import { TriageForm } from '@/components/triage/triage-form';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, PageHeader } from '@/components/ui/card';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { useApi, useInterval } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';

export default function TriagePage() {
  const session = useSession();
  const toast = useToast();
  const queue = useApi<TriageQueue>('/triage/queue');
  const [current, setCurrent] = useState<QueueRow | null>(null);

  useRealtime('fila.atualizada', () => void queue.reload());
  useRealtime<{ complaint: string }>('alerta.emergencia', (e) => toast.error(`Emergência classificada: ${e.complaint}`));
  useInterval(() => void queue.reload(), 30_000);

  if (current) {
    return (
      <>
        <PageHeader
          title={`Classificação de risco: ${current.patient.name}`}
          description={`${current.patient.age} anos · ${current.patient.sex === 'F' ? 'feminino' : 'masculino'}${current.ticket ? ` · senha ${current.ticket}` : ''}`}
          actions={
            <Button variant="secondary" onClick={() => setCurrent(null)}>
              <ArrowLeft className="h-4 w-4" /> Voltar à fila
            </Button>
          }
        />
        <Card>
          <CardBody>
            <TriageForm
              encounterId={current.encounterId}
              patientName={current.patient.name}
              onDone={() => {
                setCurrent(null);
                void queue.reload();
              }}
            />
          </CardBody>
        </Card>
      </>
    );
  }

  const q = queue.data;
  const canClassify = session.can('triagem.registrar');
  return (
    <>
      <PageHeader
        title="Acolhimento com classificação de risco"
        description={session.me?.context.unitName}
        actions={
          <Button variant="secondary" onClick={() => void queue.reload()} loading={queue.loading}>
            <RefreshCw className="h-4 w-4" /> Atualizar
          </Button>
        }
      />
      {queue.error && <Alert tone="error">{queue.error}</Alert>}
      {!q ? (
        <Spinner />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title={`Aguardando classificação (${q.awaitingTriage.length})`} description="Por ordem de chegada" />
            <CardBody>
              <QueueList rows={q.awaitingTriage} onOpen={canClassify ? setCurrent : undefined} actionLabel="Classificar" empty="Ninguém aguardando classificação" />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={`Aguardando atendimento (${q.awaitingDoctor.length})`} description="Por gravidade e chegada" actions={<RiskCounts counts={q.counts} />} />
            <CardBody>
              <QueueList rows={q.awaitingDoctor} onOpen={canClassify ? setCurrent : undefined} actionLabel="Reclassificar" empty="Fila vazia" />
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}
