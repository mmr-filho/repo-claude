import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './core/config';

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  const config = app.get<AppConfig>(APP_CONFIG);
  app.setGlobalPrefix('api');
  app.set('trust proxy', 1);
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
      process.exit(1);
    });
}
