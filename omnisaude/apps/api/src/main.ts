import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { registrarFalhaDePartida, servirFalhaDePartida } from '@omnisaude/database';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './core/config';

export async function createApp() {
  // abortOnError: false faz o erro de inicialização (ex.: configuração inválida) chegar ao catch da partida, que decide
  // entre sair e responder com o diagnóstico; o padrão do Nest encerraria o processo antes.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true, abortOnError: false });
  const config = app.get<AppConfig>(APP_CONFIG);
  app.setGlobalPrefix('api');
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '15mb' });
  app.useBodyParser('text', { type: ['application/xml', 'text/xml', 'text/plain'], limit: '10mb' });
  app.enableCors({ origin: config.CORS_ORIGINS.split(',').map((o) => o.trim()), credentials: false, exposedHeaders: ['Content-Disposition', 'X-Total-Rows'] });
  app.enableShutdownHooks();
  return app;
}

if (require.main === module) {
  createApp()
    .then(async (app) => {
      const config = app.get<AppConfig>(APP_CONFIG);
      await app.listen(config.PORT, '0.0.0.0');
      new Logger('OmniSaúde').log(`API ouvindo em http://0.0.0.0:${config.PORT}/api`);
    })
    .catch((err) => {
      console.error(err);
      // No container da Cloudflare, a API que não sobe (ex.: segredo fora do formato) responde 503 com o motivo,
      // sem segredos, em vez de deixar a tela de login em "está iniciando".
      if (process.env.PARTIDA_DIAGNOSTICO !== 'true') process.exit(1);
      servirFalhaDePartida({ porta: Number(process.env.PORT) || 3001, falha: registrarFalhaDePartida('API', err) });
    });
}
