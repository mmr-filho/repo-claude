'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Alert, Spinner } from '@/components/ui/misc';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { BarraProgresso } from './aba-ordens';
import { TOM_STATUS, type OrdemDetalhe } from './types';

/**
 * Cartão da ficha da notificação (vigilância): a ordem de bloqueio em que o caso está, com a situação do trabalho de
 * campo. Sem ordem (agravo fora do bloqueio, caso antigo ou bloqueio automático desligado), mostra o cartão do raio.
 */
export function OrdemDoCaso({ notificationId, semOrdem }: { notificationId: string; semOrdem: React.ReactNode }) {
  const r = useApi<{ ordem: OrdemDetalhe | null; caso: { ativo: boolean; motivoDesligamento: string | null; semPosicao: boolean } | null }>(`/endemias/bloqueios/da-notificacao/${notificationId}`, [notificationId]);
  if (r.loading && !r.data) return <Spinner />;
  if (r.error) return <Alert tone="error">{r.error}</Alert>;
  const o = r.data?.ordem;
  if (!o) return <>{semOrdem}</>;
  const ocorrencia = o.quarteiroes.filter((q) => q.ocorrencia).map((q) => q.numero);
  return (
    <Card id="vig-ordem-bloqueio">
      <CardHeader
        title={`Ordem de bloqueio ${o.numero}`}
        description={`Raio de ${o.raioM} m · aberta em ${fmtDateTime(o.abertaEm)} · ${o.casos.ativos} caso(s) na mesma área e período`}
        actions={<Badge tone={TOM_STATUS[o.status]}>{o.statusLabel}</Badge>}
      />
      <CardBody className="space-y-2 text-sm">
        {r.data?.caso && !r.data.caso.ativo && <Alert tone="info">Este caso saiu da ordem: {r.data.caso.motivoDesligamento}.</Alert>}
        {r.data?.caso?.ativo && r.data.caso.semPosicao && <Alert tone="warn">A residência deste caso ainda não tem posição boa para o raio: marque o imóvel no mapa do território (ou peça ao ACS o GPS na visita).</Alert>}
        <div className="flex flex-wrap items-center gap-4">
          <span>
            {o.quarteiroes.length} quarteirão(ões) no raio{ocorrencia.length ? ` · início no ${ocorrencia.join(', ')}` : ''}
          </span>
          <BarraProgresso p={o.progresso} />
          <span className="text-slate-600">Agentes: {o.agentes.map((a) => a.nome).join(', ') || 'ninguém designado'}</span>
        </div>
        <Link href={`/endemias?aba=bloqueios&ordem=${o.id}`} className="text-brand-700 hover:underline">
          Acompanhar a ordem em Endemias
        </Link>
      </CardBody>
    </Card>
  );
}
