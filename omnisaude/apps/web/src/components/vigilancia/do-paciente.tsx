'use client';

import { BellPlus, Lock } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { fmtDate } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { NovaNotificacaoDialog } from './nova-notificacao';
import { STATUS, type NotificacaoResumo } from './types';

/** Notificações do paciente (evita notificar de novo): as sigilosas aparecem como "agravo de acesso restrito". */
export function NotificacoesDoPaciente({ paciente }: { paciente: { id: string; name: string } }) {
  const session = useSession();
  const router = useRouter();
  const pode = session.can('notificacao.registrar', 'vigilancia.painel');
  const lista = useApi<NotificacaoResumo[]>(pode ? `/vigilancia/pacientes/${paciente.id}/notificacoes` : null, [paciente.id]);
  const [nova, setNova] = useState(false);
  if (!pode) return null;
  return (
    <Card id="paciente-notificacoes">
      <CardHeader
        title="Notificações compulsórias"
        actions={
          session.can('notificacao.registrar') && (
            <Button size="sm" variant="ghost" onClick={() => setNova(true)} id="paciente-notificar">
              <BellPlus className="h-4 w-4" /> Notificar agravo
            </Button>
          )
        }
      />
      <CardBody className="flex flex-col gap-2 text-sm">
        {lista.data?.length === 0 && <span className="text-slate-500">Nenhuma notificação registrada</span>}
        {lista.data?.map((n) => (
          <div key={n.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              {n.sigiloso && <Lock className="h-3.5 w-3.5 text-violet-600" />}
              {n.paciente === null && n.sigiloso ? (
                <span>{n.agravo}</span>
              ) : (
                <Link className="text-brand-700 underline" href={`/vigilancia/notificacao?id=${n.id}`}>
                  {n.agravo}
                </Link>
              )}
              <span className="text-xs text-slate-500">· {fmtDate(n.criadaEm)}</span>
            </span>
            <Badge tone={STATUS[n.status]!.tone}>{STATUS[n.status]!.label}</Badge>
          </div>
        ))}
      </CardBody>
      <NovaNotificacaoDialog open={nova} onOpenChange={setNova} paciente={paciente} onCreated={(id) => router.push(`/vigilancia/notificacao?id=${id}`)} />
    </Card>
  );
}
