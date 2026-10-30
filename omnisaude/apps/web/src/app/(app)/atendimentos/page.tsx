'use client';

import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { QueueList, RiskCounts, type TriageQueue } from '@/components/triage/queue';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, PageHeader } from '@/components/ui/card';
import { Alert, Spinner } from '@/components/ui/misc';
import { useApi, useInterval } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';

export default function EncountersQueuePage() {
  const session = useSession();
  const router = useRouter();
  const queue = useApi<TriageQueue>('/triage/queue');
  useRealtime('fila.atualizada', () => void queue.reload());
  useInterval(() => void queue.reload(), 30_000);
  const open = (r: { encounterId: string }) => router.push(`/atendimento?id=${r.encounterId}`);
  const q = queue.data;
  return (
    <>
      <PageHeader
        title="Atendimentos"
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
        <div className="grid gap-6 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader title={`Classificados aguardando (${q.awaitingDoctor.length})`} description="Ordem por gravidade; atrasos destacados" actions={<RiskCounts counts={q.counts} />} />
            <CardBody>
              <QueueList rows={q.awaitingDoctor} onOpen={open} actionLabel="Atender" empty="Nenhum paciente aguardando" />
            </CardBody>
          </Card>
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader title={`Em atendimento (${q.inProgress.length})`} />
              <CardBody>
                <QueueList rows={q.inProgress} onOpen={open} actionLabel="Continuar" empty="Nenhum atendimento em curso" />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title={`Agendados/ambulatoriais (${q.scheduled.length})`} />
              <CardBody>
                <QueueList rows={q.scheduled} onOpen={open} actionLabel="Atender" empty="Nenhum paciente agendado presente" />
              </CardBody>
            </Card>
            {q.awaitingTriage.length > 0 && (
              <Alert tone="info">
                {q.awaitingTriage.length} paciente(s) aguardando classificação de risco pela enfermagem.
              </Alert>
            )}
          </div>
        </div>
      )}
    </>
  );
}
