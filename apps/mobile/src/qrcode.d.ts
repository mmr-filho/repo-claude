declare module 'qrcode/lib/core/qrcode' {
  export function create(text: string, options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }): { modules: { size: number; data: ArrayLike<number> }; version: number };
}
