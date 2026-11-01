'use client';

import { BellRing, X } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { tempoAte, type NotificacaoCriada } from './types';

const EFEITO: Record<NonNullable<NotificacaoCriada['efeito']>, string> = {
  CONFIRMADA: 'Confirmada pelo resultado',
  ENCERRADA: 'Encerrada sem confirmação: a vigilância avalia reabrir',
  DESCARTADA: 'Descartada: a vigilância avalia reabrir',
};

/**
 * Aviso depois de assinar, encerrar ou internar: o sistema abriu o rascunho da notificação compulsória.
 * Não bloqueia o atendimento; a ficha pode ser completada agora ou depois em "Minhas notificações".
 */
export function AvisoNotificacoes({ itens, onDismiss }: { itens: NotificacaoCriada[]; onDismiss: () => void }) {
  if (!itens.length) return null;
  return (
    <div role="status" id="aviso-notificacao" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-2 font-semibold">
          <BellRing className="h-4 w-4" /> Agravo de notificação compulsória:{' '}
          {itens.every((n) => !n.efeito) ? (itens.length === 1 ? 'rascunho aberto' : `${itens.length} rascunhos abertos`) : 'resultado registrado na notificação'}
        </p>
        <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="Fechar aviso">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <ul className="mt-2 flex flex-col gap-2">
        {itens.map((n) => (
          <li key={n.id} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{n.agravo}</span>
            <Badge tone={n.prazo === 'IMEDIATA' ? 'red' : 'amber'}>{n.prazo === 'IMEDIATA' ? `Imediata (${n.esferas.join(', ')})` : 'Semanal'}</Badge>
            {n.venceEm && <span className="text-xs">{tempoAte(n.venceEm)}</span>}
            {n.sigiloso && <Badge tone="violet">Sigilosa</Badge>}
            {n.naoHomologado && <Badge tone="slate">Mapeamento do código não homologado</Badge>}
            {n.efeito && <Badge tone={n.efeito === 'CONFIRMADA' ? 'green' : 'amber'}>{EFEITO[n.efeito]}</Badge>}
            {n.podeAbrir === false ? (
              <span className="text-xs">Notificação {n.numero}: a vigilância foi avisada.</span>
            ) : (
              <Link className="text-xs font-semibold text-brand-700 underline" href={`/vigilancia/notificacao?id=${n.id}`}>
                {n.efeito ? `Abrir a ficha ${n.numero}` : `Completar e confirmar a ficha ${n.numero}`}
              </Link>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs">A notificação é obrigação de quem atende (Portaria de Consolidação GM/MS nº 4/2017, Anexo V). O atendimento segue normalmente.</p>
    </div>
  );
}
