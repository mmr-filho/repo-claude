import type { NextConfig } from 'next';

// OMNI_STATIC_EXPORT=1 gera um site estático em out/ para empacotar no app Android (Capacitor).
// Por isso as telas são componentes de cliente e rotas usam ?id= em vez de segmentos dinâmicos.
const staticExport = process.env.OMNI_STATIC_EXPORT === '1';

const config: NextConfig = {
  ...(staticExport ? { output: 'export' as const, trailingSlash: true } : {}),
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
