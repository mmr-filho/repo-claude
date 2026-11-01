'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Alert, Spinner } from '@/components/ui/misc';
import { FichaNotificacao } from '@/components/vigilancia/ficha-notificacao';

function Conteudo() {
  const id = useSearchParams().get('id');
  if (!id) return <Alert tone="error">Notificação não informada.</Alert>;
  return <FichaNotificacao id={id} />;
}

/** Ficha de uma notificação (link do aviso pós-assinatura e do painel): `?id=` para funcionar no app estático. */
export default function NotificacaoPage() {
  return (
    <div className="flex flex-col gap-4">
      <Link href="/vigilancia" className="flex items-center gap-1 text-sm text-brand-700">
        <ArrowLeft className="h-4 w-4" /> Vigilância
      </Link>
      <Suspense fallback={<Spinner />}>
        <Conteudo />
      </Suspense>
    </div>
  );
}
