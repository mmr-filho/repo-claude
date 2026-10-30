'use client';

import { useEffect, useState } from 'react';

type Kind = 'qrcode' | 'gs1datamatrix' | 'datamatrix' | 'code128';

/**
 * Código de barras em SVG (bwip-js): QR da pulseira, Datamatrix GS1 das doses unitárias, Code 128.
 * Para gs1datamatrix, passe a forma legível "(01)...(17)...(10)...(21)...".
 */
export function Barcode({ kind, value, scale = 3, className, label }: { kind: Kind; value: string; scale?: number; className?: string; label?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    import('bwip-js/browser')
      .then(({ toSVG }) => {
        if (cancelled) return;
        try {
          setSvg(toSVG({ bcid: kind, text: value, scale, includetext: kind === 'code128', textxalign: 'center', parsefnc: kind === 'gs1datamatrix' }));
          setError(null);
        } catch (err) {
          setError((err as Error).message);
        }
      })
      .catch((err: Error) => setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [kind, value, scale]);
  if (error) return <span className="text-xs text-red-600">Código inválido: {error}</span>;
  if (!svg) return <span className="inline-block h-16 w-16 animate-pulse rounded bg-slate-100" />;
  return <span role="img" aria-label={label ?? value} className={className} dangerouslySetInnerHTML={{ __html: svg }} />;
}
