'use client';

import { AlertTriangle } from 'lucide-react';
import { Barcode } from '@/components/ui/barcode';
import { fmtDate, formatCns } from '@/lib/format';
import type { Wristband } from './types';

/** Pulseira de identificação: dois identificadores (nome + nascimento), CNS, mãe, alergias e QR lido à beira do leito. */
export function WristbandLabel({ data }: { data: Wristband }) {
  return (
    <div className="flex w-[19cm] max-w-full items-center gap-3 rounded-md border-2 border-slate-800 bg-white p-2 text-black">
      <Barcode kind="qrcode" value={data.code} scale={2} label="Código da pulseira" className="shrink-0 [&>svg]:h-20 [&>svg]:w-20" />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-base font-bold uppercase">{data.name}</p>
        <p className="text-sm">
          Nasc.: <b>{fmtDate(data.birthDate)}</b>
          {data.cns ? <> · CNS {formatCns(data.cns)}</> : null}
        </p>
        {data.motherName && <p className="truncate text-xs">Mãe: {data.motherName}</p>}
      </div>
      {data.allergies.length > 0 && (
        <div className="flex max-w-[6cm] items-start gap-1 rounded bg-red-600 px-2 py-1 text-xs font-bold uppercase text-white">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Alergia: {data.allergies.join(', ')}</span>
        </div>
      )}
    </div>
  );
}
