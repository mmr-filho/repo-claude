import { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import { create } from 'qrcode/lib/core/qrcode';

/** QR code desenhado em SVG. Usa só o núcleo da biblioteca (não precisa de Buffer nem de canvas). */
export function QrCode({ value, size = 280 }: { value: string; size?: number }) {
  const { path, n } = useMemo(() => {
    const qr = create(value, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.data[y * n + x]) d += `M${x} ${y}h1v1h-1z`;
    return { path: d, n };
  }, [value]);
  const quiet = 3; // margem branca exigida pelos leitores
  return (
    <Svg width={size} height={size} viewBox={`${-quiet} ${-quiet} ${n + quiet * 2} ${n + quiet * 2}`} accessibilityLabel="QR code">
      <Rect x={-quiet} y={-quiet} width={n + quiet * 2} height={n + quiet * 2} fill="#FFFFFF" />
      <Path d={path} fill="#000000" />
    </Svg>
  );
}
