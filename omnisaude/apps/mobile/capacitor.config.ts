import type { CapacitorConfig } from '@capacitor/cli';

/**
 * App Android do OmniSaúde: empacota a exportação estática do front-end (apps/web/out).
 * O endereço da API é embutido no build web (NEXT_PUBLIC_API_URL) e precisa ser HTTPS em produção.
 * Para desenvolvimento com recarga automática, defina CAP_SERVER_URL (ex.: http://192.168.0.10:3000).
 */
const devServer = process.env.CAP_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'br.com.omnisaude.app',
  appName: 'OmniSaúde',
  webDir: '../web/out',
  server: {
    androidScheme: 'https',
    ...(devServer ? { url: devServer, cleartext: devServer.startsWith('http://') } : {}),
  },
  android: {
    // Conteúdo misto (HTTP dentro de HTTPS) só é aceito no servidor de desenvolvimento.
    allowMixedContent: !!devServer,
    captureInput: true,
  },
  plugins: {
    TextToSpeech: {},
    SpeechRecognition: {},
  },
};

export default config;
