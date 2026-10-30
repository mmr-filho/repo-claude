import type { NextConfig } from 'next';

// OMNI_STATIC_EXPORT=1 gera um site estático em out/ para empacotar no app Android (Capacitor).
// Por isso as telas são componentes de cliente e rotas usam ?id= em vez de segmentos dinâmicos.
const staticExport = process.env.OMNI_STATIC_EXPORT === '1';

const config: NextConfig = {
  // Permite builds paralelos (ex.: CI e desenvolvimento) sem disputar a mesma pasta.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  ...(staticExport ? { output: 'export' as const, trailingSlash: true } : {}),
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
