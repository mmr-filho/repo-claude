'use client';

import { NegativaMinhas } from '@/components/consolidacao/negativa-minhas';
import { PageHeader } from '@/components/ui/card';
import { Alert } from '@/components/ui/misc';
import { useSession } from '@/lib/session';

/**
 * Notificação negativa (VIG-1c): o responsável designado da unidade atesta, toda semana, que não identificou caso de
 * doença ou agravo da Lista Nacional (PRC GM/MS nº 4/2017, Anexo V, art. 2º, IX). Permissão `notificacao.negativa`;
 * atestar exige ainda a designação ativa na unidade (titular ou substituto).
 */
export default function NotificacaoNegativaPage() {
  const session = useSession();
  if (!session.can('notificacao.negativa')) return <Alert tone="warn">Seu papel não tem acesso à notificação negativa.</Alert>;
  return (
    <div className="space-y-4">
      <PageHeader title="Notificação negativa" description="Atesto semanal do responsável pela unidade: nenhum caso de doença ou agravo da lista nacional na semana epidemiológica." />
      <NegativaMinhas />
    </div>
  );
}
