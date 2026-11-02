'use client';

import type { PrecisaoGeo } from '@omnisaude/shared';
import type { QuarteiraoNoRaio } from '@/components/territorio/types';
import { Alert } from '@/components/ui/misc';

export interface QuarteiroesDoCaso {
  ponto: { lat: number; lng: number } | null;
  precisao?: PrecisaoGeo;
  precisaoLabel?: string;
  fonte?: 'cadastro' | 'ficha';
  regra: 'AUTOMATICO' | 'COM_AVISO' | 'CONFIRMAR_EM_CAMPO';
  motivo?: string;
  raioM: number;
  quarteiroes: QuarteiraoNoRaio[];
}

/** Lista dos quarteirões no raio, com a regra da precisão da posição (base da ordem de bloqueio). */
export function ListaBloqueio({ q }: { q: QuarteiroesDoCaso }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      {!q.ponto ? (
        <Alert tone="warn">{q.motivo}</Alert>
      ) : (
        <>
          <p className="text-slate-600">
            Posição da residência: <b>{q.precisaoLabel}</b> ({q.fonte === 'cadastro' ? 'cadastro do imóvel' : 'retrato da ficha'}).
          </p>
          {q.regra === 'COM_AVISO' && <Alert tone="warn">Posição aproximada: confira o imóvel antes de fechar a lista do bloqueio.</Alert>}
          {q.regra === 'CONFIRMAR_EM_CAMPO' && <Alert tone="warn">Posição imprecisa (centro de logradouro ou de bairro): confirme o imóvel em campo antes de usar esta lista.</Alert>}
          {q.quarteiroes.length === 0 ? (
            <p className="text-slate-500">Nenhum quarteirão cadastrado a até {q.raioM} m.</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded border border-slate-200">
              {q.quarteiroes.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                  <span className="whitespace-nowrap font-medium">Quarteirão {b.numero}</span>
                  <span className="text-right text-xs text-slate-500">
                    {b.localidade?.name}
                    {b.bairro ? ` · ${b.bairro}` : ''} · {b.imoveis} imóv. · {b.distanciaM} m
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
